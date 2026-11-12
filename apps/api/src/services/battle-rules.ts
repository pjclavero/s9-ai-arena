/**
 * R-API (ADR-021) · Reglas de una batalla en el SERVIDOR: valida la petición (preset
 * o personalizado), comprueba los topes de créditos/masa con los loadouts REALES y
 * construye la COPIA INMUTABLE (`battles.rules`) que jugará el worker.
 *
 * Módulo propio a propósito: POST /battles sólo añade una llamada (`buildBattleRules`)
 * y una columna en el insert; los bloques de validación de participantes de la ruta
 * no se tocan (frontera con H-ELIG, elegibilidad de versiones).
 *
 * La UI nunca es la autoridad: aunque enseñe la checklist con POST /battles/rules-check,
 * POST /battles recalcula todo aquí.
 */
import type { Db } from "../db/connection.js";
import { ApiError } from "../errors.js";
import { ROLE_RANK } from "../openapi.js";
import { resolveBattleRuleset } from "./battle-ruleset-resolver.js";
import { getCatalog } from "./catalog.js";
import { loadRuleset, type Ruleset } from "../../../../packages/game-rules/index.js";
import {
  BATTLE_RULES_SCHEMA,
  READABLE_BATTLE_RULES_SCHEMAS,
  TIEBREAK_RULES,
  checkComposition,
  normalizeParams,
  withTournamentSpectatorDelay,
  respawnLabel,
  tiebreakFamilyOf,
  limitsOf,
  resolveRulesRequest,
  statsProfileOf,
  summarizeParams,
  type BattleRulesSnapshot,
  type CompositionEntry,
  type CompositionReport,
  type PublicCompositionReport,
  redactComposition,
  type RulesError,
} from "../../../../packages/game-rules/battle-rules.js";
import { resolveVehicle } from "../../../../packages/module-catalog/resolve/index.js";
import { findModule, type LoadoutInput, type ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import engineDeps from "../../../arena-engine/src/engine-deps.json" with { type: "json" };

export interface BattleRulesInput {
  mode: string;
  /** Fila de `rulesets` de la plataforma (ya validada por checkBattleContent). */
  rulesetId: string;
  /** Cuerpo `rules` de la petición; ausente = reglas clásicas del ruleset de plataforma. */
  rules: unknown;
  participants: { botId: string; version: number; team: string }[];
}

export interface BattleRulesBuild {
  /**
   * null sólo en el camino CLÁSICO cuando el ruleset de plataforma no se puede resolver
   * hoy: se crea la batalla como en 0.3.0 (sin copia) y el worker falla igual que antes.
   */
  snapshot: BattleRulesSnapshot | null;
  /** Vista para el lector (OLA 2 · EQUIPMENT_PRIVATE: sin cifras de bots ajenos). */
  composition: PublicCompositionReport;
}

/** Fallos de reglas, con el detalle que la UI enseña campo a campo. */
export class RulesRejected extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(status, code, message, detail);
  }
}

/** Catálogo con el que se valida Y se juega una batalla de práctica (el del worker). */
async function practiceCatalogVersion(db: Db): Promise<string | null> {
  const latest = await db("catalog_versions").orderBy("imported_at", "desc").first();
  return (latest?.catalog_version as string | undefined) ?? null;
}

const hasLimits = (l: { botCredits: unknown; teamCredits: unknown; botMassKg: unknown; teamMassKg: unknown }) =>
  l.botCredits !== null || l.teamCredits !== null || l.botMassKg !== null || l.teamMassKg !== null;

/**
 * Coste y masa REALES de cada participante: loadout congelado de su versión
 * (`bot_versions.loadout_revision` → `bot_loadouts`) resuelto con el catálogo de la
 * batalla. Coste = chasis + módulos, la MISMA regla que el presupuesto del loadout
 * (`validateLoadoutServerSide`, que no suma la munición embebida). Masa =
 * `resolveVehicle().massKg`: la masa FÍSICA que simula el motor (sí incluye la munición
 * embebida). Nunca valores del cliente.
 */
export async function participantTotals(
  db: Db,
  participants: BattleRulesInput["participants"],
  catalog: ModuleDefinition[],
): Promise<CompositionEntry[]> {
  const out: CompositionEntry[] = [];
  for (const p of participants) {
    const bot = await db("bots").where({ id: p.botId }).first("name");
    const version = await db("bot_versions").where({ bot_id: p.botId, version: p.version }).first();
    const revision = (version?.loadout_revision as number | undefined) ?? 1;
    const row = await db("bot_loadouts").where({ bot_id: p.botId, revision }).first();
    const label = `${(bot?.name as string | undefined) ?? p.botId} v${p.version}`;
    if (!row) {
      throw new ApiError(409, "loadout_unavailable", `${label}: no tiene loadout (revisión ${revision})`);
    }
    const loadout: LoadoutInput = {
      loadoutId: row.id,
      revision: row.revision,
      catalogVersion: row.catalog_version,
      chassis: row.chassis,
      modules: typeof row.modules === "string" ? JSON.parse(row.modules) : row.modules,
    };
    let massKg: number;
    try {
      massKg = resolveVehicle(loadout, catalog).massKg;
    } catch (err) {
      throw new ApiError(
        409,
        "loadout_unavailable",
        `${label}: su loadout no se puede resolver con el catálogo de la batalla (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // Coste: la MISMA suma que el presupuesto del loadout (validator/validateLoadoutServerSide:
    // chasis + módulos por id versionado). Si `resolveVehicle` ha resuelto, todos existen.
    const costCredits = [loadout.chassis, ...loadout.modules.map((m) => m.moduleId)].reduce(
      (s, id) => s + (findModule(catalog, id)?.costCredits ?? 0),
      0,
    );
    out.push({ botId: p.botId, label, team: p.team, costCredits, massKg });
  }
  return out;
}

/** Quién lee: el dueño ve sus bots; el staff (moderador+) ve todos. Sin lector, ninguno. */
export interface CompositionViewer {
  userId?: string;
  staff?: boolean;
}

async function redactForViewer(
  db: Db,
  report: CompositionReport,
  participants: BattleRulesInput["participants"],
  viewer: CompositionViewer | undefined,
): Promise<PublicCompositionReport> {
  const visible = new Set<string>();
  if (viewer?.staff) {
    for (const p of participants) visible.add(p.botId);
  } else if (viewer?.userId) {
    for (const p of participants) {
      const bot = await db("bots").where({ id: p.botId }).first("owner_id");
      if (bot && bot.owner_id === viewer.userId) visible.add(p.botId);
    }
  }
  return redactComposition(report, (id) => visible.has(id));
}

/** Ruleset del motor CLÁSICO: exactamente el que calculaba el worker en ejecución. */
async function classicEngineRuleset(db: Db, mode: string, rulesetId: string): Promise<Ruleset | null> {
  const resolved = await resolveBattleRuleset(db, mode, rulesetId);
  if (!resolved.ok) return null;
  const dbRuleset = await db("rulesets").where({ id: rulesetId }).first();
  const budgetCredits = dbRuleset?.budget_credits as number | undefined;
  return loadRuleset(resolved.ruleset.rulesetId, budgetCredits ? { budgetCredits } : {});
}

function sideSizes(participants: BattleRulesInput["participants"]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of participants) m.set(p.team, (m.get(p.team) ?? 0) + 1);
  return m;
}

/**
 * Valida y construye la copia. Lanza:
 *  400 rules_invalid (detalle `errors[]` por campo) · 409 rules_mode_mismatch ·
 *  400 rules_team_size · 409 loadout_unavailable / catalog_unavailable ·
 *  422 composition_invalid (detalle `composition`, informe por bando y bot).
 * `allowCompositionFailure` (sólo rules-check) devuelve el informe en vez de lanzar 422.
 */
export async function buildBattleRules(
  db: Db,
  input: BattleRulesInput,
  opts: { allowCompositionFailure?: boolean; viewer?: CompositionViewer } = {},
): Promise<BattleRulesBuild> {
  const view = (r: CompositionReport) => redactForViewer(db, r, input.participants, opts.viewer);
  const catalogVersion = await practiceCatalogVersion(db);
  let snapshot: BattleRulesSnapshot | null;
  if (input.rules === undefined || input.rules === null) {
    const engineRuleset = await classicEngineRuleset(db, input.mode, input.rulesetId);
    if (!engineRuleset) return { snapshot: null, composition: await view(checkComposition([], limitsOf(null))) };
    snapshot = {
      schema: BATTLE_RULES_SCHEMA,
      source: "classic",
      presetId: null,
      presetVersion: null,
      name: input.rulesetId,
      mode: input.mode,
      platformRulesetId: input.rulesetId,
      params: null,
      composition: limitsOf(null),
      catalogVersion,
      engineRuleset,
      engineVersion: engineDeps.engine.version,
    };
  } else {
    const r = resolveRulesRequest(input.rules);
    if (!r.ok) throw rulesInvalid(r.errors);
    if (r.mode !== input.mode) {
      throw new RulesRejected(409, "rules_mode_mismatch", `${r.name} se juega en modo ${r.mode}, no ${input.mode}`, {
        expectedMode: r.mode,
      });
    }
    const sizes = sideSizes(input.participants);
    const bad = sizes.size !== 2 || [...sizes.values()].some((n) => n !== r.params.teamSize);
    if (bad) {
      const n = r.params.teamSize;
      throw new RulesRejected(
        400,
        "rules_team_size",
        `${r.name} ${n} contra ${n} exige 2 bandos de exactamente ${n} bot(s); recibidos ${[...sizes.values()].join(" y ") || "0"}`,
        { teamSize: n, sides: Object.fromEntries(sizes) },
      );
    }
    snapshot = {
      schema: BATTLE_RULES_SCHEMA,
      source: r.source,
      presetId: r.preset?.id ?? null,
      presetVersion: r.preset?.version ?? null,
      name: r.name,
      mode: r.mode,
      platformRulesetId: input.rulesetId,
      params: r.params,
      composition: limitsOf(r.params),
      catalogVersion,
      engineRuleset: r.engineRuleset,
      engineVersion: engineDeps.engine.version,
    };
  }

  // Con topes de composición, el cálculo es OBLIGATORIO (sin catálogo o sin loadout
  // no se puede garantizar nada ⇒ 409). Sin topes es informativo: un fallo no bloquea
  // la creación (el worker falla igual que antes si de verdad falta el loadout).
  const strict = hasLimits(snapshot.composition);
  let entries: CompositionEntry[] = [];
  if (catalogVersion === null) {
    if (strict) throw new ApiError(409, "catalog_unavailable", "No hay ningún catálogo de módulos importado");
  } else {
    const catalog = await getCatalog(db, catalogVersion);
    try {
      entries = await participantTotals(db, input.participants, catalog);
    } catch (err) {
      if (strict) throw err;
      entries = [];
    }
  }
  // OLA 2 (EQUIPMENT_PRIVATE): el informe completo no sale de aquí; ni el 422 ni el
  // rules-check llevan masa/coste de bots ajenos (ni mensajes con esas cifras).
  const composition = await view(checkComposition(entries, snapshot.composition));
  if (!composition.ok && !opts.allowCompositionFailure) {
    throw new RulesRejected(
      422,
      "composition_invalid",
      `Composición no válida: ${composition.violations.map((v) => v.message).join("; ")}`,
      { composition },
    );
  }
  return { snapshot, composition };
}

export function rulesInvalid(errors: RulesError[]): RulesRejected {
  return new RulesRejected(400, "rules_invalid", `Reglas no válidas: ${errors.map((e) => e.message).join("; ")}`, {
    errors,
  });
}

/** Lee `battles.rules` (jsonb o string) de una fila; null si no hay copia o no es válida. */
export function rulesOf(row: Record<string, unknown> | undefined | null): BattleRulesSnapshot | null {
  if (!row) return null;
  let r: unknown = row.rules;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const s = r as BattleRulesSnapshot;
  if (!READABLE_BATTLE_RULES_SCHEMAS.includes(s.schema) || !s.engineRuleset || typeof s.engineRuleset !== "object") {
    return null;
  }
  // Copias de schema 1 (rama previa a 0.4.0): se LEEN normalizadas, nunca se reescriben.
  return s.params ? { ...s, params: normalizeParams(s.params) } : s;
}

/** Proyección pública de la copia (lo deportivo: sin nada de bots ni de propietarios). */
export function rulesToJson(s: BattleRulesSnapshot | null) {
  if (!s) return undefined;
  const e = s.engineRuleset;
  return {
    schema: s.schema,
    source: s.source,
    presetId: s.presetId,
    presetVersion: s.presetVersion,
    name: s.name,
    mode: s.mode,
    platformRulesetId: s.platformRulesetId,
    params: s.params,
    composition: s.composition,
    catalogVersion: s.catalogVersion,
    engineVersion: s.engineVersion,
    profile: statsProfileOf(s),
    summary: s.params ? summarizeParams(s.params) : [],
    // ADR-022 · lectura humana del respawn y del desempate (lo que enseña la UI).
    respawnLabel: s.params ? respawnLabel(s.params) : null,
    tiebreak: s.params ? TIEBREAK_RULES[tiebreakFamilyOf(s.params)] : null,
    engine: {
      rulesetId: e.rulesetId,
      timeLimitTicks: e.timeLimitTicks,
      scoreToWin: e.scoreToWin,
      respawn: e.respawn,
      friendlyFire: e.friendlyFire,
      timeoutTiebreak: e.timeoutTiebreak ?? ["score"],
      ...(e.overtime ? { overtime: e.overtime } : {}),
      ...(e.ctf ? { ctf: e.ctf } : {}),
    },
  };
}

// ------------------------------------------------------------------- torneos

export interface TournamentRulesInput {
  mode: string;
  rulesetId: string;
  format: string;
  /** Cuerpo `rules` de POST /tournaments; ausente = reglas clásicas del ruleset de plataforma. */
  rules: unknown;
  budgetCredits: number | null;
  catalogVersion: string | null;
}

/**
 * ADR-022 · COPIA INMUTABLE de las reglas de un TORNEO (`tournaments.rules`), hecha al
 * crearlo. El scheduler la copia tal cual en cada batalla del torneo: cambiar después un
 * preset, la tabla `rulesets` o el código del registro no altera el torneo.
 *
 * Límites de esta fase (documentados en docs/user/rules.md): en torneos no se aceptan
 * todavía topes de composición por bot/equipo (el presupuesto del torneo sigue siendo
 * `budgetCredits`, validado en la inscripción como siempre); el tamaño de bando del preset
 * se comprueba al cerrar inscripciones.
 */
export async function buildTournamentRules(db: Db, input: TournamentRulesInput): Promise<BattleRulesSnapshot | null> {
  const isTeams = input.format === "teams";
  if (input.rules === undefined || input.rules === null) {
    const engineRuleset = await classicEngineRuleset(db, input.mode, input.rulesetId);
    if (!engineRuleset) return null;
    return {
      schema: BATTLE_RULES_SCHEMA,
      source: "classic",
      presetId: null,
      presetVersion: null,
      name: input.rulesetId,
      mode: input.mode,
      platformRulesetId: input.rulesetId,
      params: null,
      composition: limitsOf(null),
      catalogVersion: input.catalogVersion,
      // El presupuesto del torneo manda sobre el del ruleset (como en el worker, T9.4).
      engineRuleset: withTournamentSpectatorDelay(
        input.budgetCredits ? { ...engineRuleset, budgetCredits: input.budgetCredits } : engineRuleset,
      ),
      engineVersion: engineDeps.engine.version,
    };
  }
  const r = resolveRulesRequest(input.rules);
  if (!r.ok) throw rulesInvalid(r.errors);
  if (r.mode !== input.mode) {
    throw new RulesRejected(409, "rules_mode_mismatch", `${r.name} se juega en modo ${r.mode}, no ${input.mode}`, {
      expectedMode: r.mode,
    });
  }
  if (r.params.game === "capture_the_flag") {
    // Hallazgo EQ2 (preexistente, fuera de alcance): el scheduler etiqueta los bandos de
    // torneo «A»/«B» y los mapas CTF tienen bases y banderas «red»/«blue»; el motor rechaza
    // la combinación al arrancar (modeMapIncompatibilities). No se crea un torneo que no
    // podría jugarse: se rechaza con el motivo hasta que se resuelva el reparto de bandos.
    throw rulesInvalid([
      {
        field: "rules.preset",
        code: "incompatible",
        message:
          "CTF todavía no se admite en torneos: los bandos de torneo (A/B) no tienen base y bandera en los mapas CTF (red/blue)",
      },
    ]);
  }
  if (isTeams ? r.params.teamSize < 2 : r.params.teamSize !== 1) {
    throw new RulesRejected(
      400,
      "rules_team_size",
      isTeams
        ? "un torneo por equipos necesita reglas de 2 contra 2 o más"
        : `un torneo ${input.format} enfrenta bots de uno en uno: las reglas deben ser 1 contra 1`,
      { teamSize: r.params.teamSize, format: input.format },
    );
  }
  if (hasLimits(limitsOf(r.params))) {
    throw rulesInvalid([
      {
        field: "rules.params",
        code: "incompatible",
        message:
          "los topes de créditos/masa por bot o por equipo aún no se aplican en torneos: usa budgetCredits del torneo",
      },
    ]);
  }
  // ADR-022 · ningún torneo admite prórroga (CTF en torneos está rechazado arriba): la
  // salvaguarda técnica, sin resultado deportivo, no puede llegar a series ni clasificaciones.
  if (r.engineRuleset.overtime) {
    throw rulesInvalid([{ field: "rules.preset", code: "incompatible", message: "los torneos no admiten prórroga" }]);
  }
  const engineRuleset = withTournamentSpectatorDelay(
    input.budgetCredits ? { ...r.engineRuleset, budgetCredits: input.budgetCredits } : r.engineRuleset,
  );
  return {
    schema: BATTLE_RULES_SCHEMA,
    source: r.source,
    presetId: r.preset?.id ?? null,
    presetVersion: r.preset?.version ?? null,
    name: r.name,
    mode: r.mode,
    platformRulesetId: input.rulesetId,
    params: r.params,
    composition: limitsOf(r.params),
    catalogVersion: input.catalogVersion,
    engineRuleset,
    engineVersion: engineDeps.engine.version,
  };
}

/** Lector de una petición autenticada (dueño por id; staff = moderador o más). */
export function compositionViewer(auth: { userId?: string; rank?: number } | undefined | null): CompositionViewer {
  return { userId: auth?.userId, staff: (auth?.rank ?? 0) >= ROLE_RANK.moderator };
}
