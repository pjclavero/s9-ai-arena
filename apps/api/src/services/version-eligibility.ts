/**
 * ELIG · Elegibilidad de versiones históricas para competición NUEVA.
 *
 * Dos conceptos distintos, a propósito:
 *  - HISTÓRICO: una versión `published`/`frozen` es inmutable (trigger
 *    `bot_version_immutable`), se conserva, se consulta y sus replays se siguen
 *    reproduciendo con las reglas con las que se jugaron. Nada de este módulo
 *    escribe en la BD ni cambia el estado de una versión.
 *  - ELEGIBLE PARA NUEVAS BATALLAS: se CALCULA (no se guarda) con el loadout
 *    histórico EXACTO de la versión, el catálogo inmutable al que está anclado y el
 *    validador ACTUAL. Si hoy incumple una regla que le impide funcionar, la versión
 *    sigue `published` pero no entra en batallas ni torneos nuevos.
 *
 * Por qué no un estado nuevo ni reutilizar `suspended`/`retired`: esos son estados
 * de la máquina 17.1 (transiciones manuales y auditadas) y cambiarlos reescribiría
 * el estado histórico de publicación (H11). La elegibilidad depende del validador,
 * no de una decisión humana: un cálculo determinista evita flags que se desfasan.
 *
 * Clasificación (H4), extensible por tabla: cada código de violación del validador
 * tiene una clase. TypeScript obliga a clasificar todo código nuevo (Record
 * exhaustivo); en tiempo de ejecución un código desconocido cae en `functional`
 * (falla cerrado: una regla que nadie ha clasificado no se ignora en silencio).
 *  - functional: el vehículo se puede montar, pero no puede ejercer una función
 *    esencial (arma sin munición compatible, módulo en ranura que no lo admite…).
 *    BLOQUEA.
 *  - malformed: el loadout no se puede resolver contra su catálogo (módulo o chasis
 *    inexistente, ranura repetida o desconocida, JSON ilegible). BLOQUEA.
 *  - balance: reglas de equilibrio o de la competición (presupuesto, tope por
 *    módulo, duplicados, categoría prohibida, masa y energía). NO bloquea aquí: se
 *    informa como aviso; si una competición concreta lo exige, lo aplica su
 *    ruleset al crearla, no esta comprobación genérica.
 */
import type { Knex } from "knex";
import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { ROLE_RANK } from "../openapi.js";
import { getCatalog } from "./catalog.js";
import { canManageTournament } from "./tournament-access.js";
import {
  budgetViolations,
  loadoutCostCredits,
  validateLoadout,
  type Violation,
} from "../../../../packages/module-catalog/validator/index.js";
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import { BUDGET_CREDITS_MVP } from "../../../../packages/game-rules/index.js";
import { rulesOf } from "./battle-rules.js";

/** Sube cuando cambie la tabla de clases o el criterio: invalida la caché. */
export const ELIGIBILITY_RULES_VERSION = "elig-1";

export type IssueClass = "functional" | "malformed" | "balance";

/** Categorías del inventario (H15). */
export type EligibilityCategory =
  "VALID" | "INVALID_AMMO" | "MISSING_AMMO" | "ORPHAN_AMMO" | "OTHER_INVALID" | "UNKNOWN";

export const VIOLATION_CLASS: Record<Violation["code"], IssueClass> = {
  incompatible_ammo: "functional",
  slot_type_mismatch: "functional",
  slot_size_exceeded: "functional",
  incompatible_chassis: "functional",
  unknown_slot: "malformed",
  duplicate_slot: "malformed",
  mass_exceeded: "balance",
  energy_deficit: "balance",
  budget_exceeded: "balance",
  module_cost_cap_exceeded: "balance",
  duplicate_limit_exceeded: "balance",
  category_forbidden_by_ruleset: "balance",
};

const BLOCKING: ReadonlySet<IssueClass> = new Set(["functional", "malformed"]);

export interface EligibilityIssue {
  code: string;
  class: IssueClass;
  category: Exclude<EligibilityCategory, "VALID" | "UNKNOWN">;
  message: string;
  slot?: string;
  moduleId?: string;
  ammoId?: string;
}

export interface VersionEligibility {
  /** ¿Puede entrar en una batalla o torneo NUEVO? (El histórico no depende de esto.) */
  eligible: boolean;
  /** Motivo estable cuando no es elegible. */
  reason?: "loadout_no_longer_valid" | "loadout_unverifiable";
  category: EligibilityCategory;
  /** Lo que bloquea (vacío si es elegible). */
  blocking: EligibilityIssue[];
  /** Incumplimientos que NO bloquean (balance): informativos. */
  warnings: EligibilityIssue[];
  /** Explicación para el usuario (sólo si no es elegible). */
  message?: string;
  /** Acción sugerida (sólo si no es elegible). */
  suggestedAction?: string;
  rulesVersion: string;
}

const SUGGESTED = "Usa otra versión elegible o crea una versión nueva con un loadout corregido.";

function issueCategory(v: Violation): EligibilityIssue["category"] {
  if (v.code !== "incompatible_ammo") return "OTHER_INVALID";
  // Estructura de ammoRule (validator/index.ts), no el texto del mensaje.
  const hasAmmo = typeof v.ammoId === "string";
  const hasAccepted = Array.isArray(v.acceptedAmmo);
  if (hasAccepted && !hasAmmo) return "MISSING_AMMO";
  if (hasAmmo && !hasAccepted) return "ORPHAN_AMMO";
  return "INVALID_AMMO";
}

const CATEGORY_PRIORITY: EligibilityIssue["category"][] = [
  "INVALID_AMMO",
  "MISSING_AMMO",
  "ORPHAN_AMMO",
  "OTHER_INVALID",
];

/** Función PURA: violaciones del validador actual → elegibilidad. */
export function classifyViolations(violations: Violation[]): VersionEligibility {
  const blocking: EligibilityIssue[] = [];
  const warnings: EligibilityIssue[] = [];
  for (const v of violations) {
    const cls: IssueClass = Object.prototype.hasOwnProperty.call(VIOLATION_CLASS, v.code)
      ? VIOLATION_CLASS[v.code]
      : "functional";
    const issue: EligibilityIssue = {
      code: v.code,
      class: cls,
      category: issueCategory(v),
      message: v.message,
      ...(v.slot ? { slot: v.slot } : {}),
      ...(v.moduleId ? { moduleId: v.moduleId } : {}),
      ...(v.ammoId ? { ammoId: v.ammoId } : {}),
    };
    (BLOCKING.has(cls) ? blocking : warnings).push(issue);
  }
  if (blocking.length === 0) {
    return { eligible: true, category: "VALID", blocking, warnings, rulesVersion: ELIGIBILITY_RULES_VERSION };
  }
  const category = CATEGORY_PRIORITY.find((c) => blocking.some((b) => b.category === c)) ?? "OTHER_INVALID";
  return {
    eligible: false,
    reason: "loadout_no_longer_valid",
    category,
    blocking,
    warnings,
    message: `Esta versión se conserva para el histórico, pero ya no puede utilizarse en nuevas batallas porque su loadout no cumple la validación actual: ${blocking
      .map((b) => b.message)
      .join(" ")}`,
    suggestedAction: SUGGESTED,
    rulesVersion: ELIGIBILITY_RULES_VERSION,
  };
}

function unverifiable(why: string): VersionEligibility {
  return {
    eligible: false,
    reason: "loadout_unverifiable",
    category: "UNKNOWN",
    blocking: [],
    warnings: [],
    message: `Esta versión se conserva para el histórico, pero no puede utilizarse en nuevas batallas: ${why}`,
    suggestedAction: SUGGESTED,
    rulesVersion: ELIGIBILITY_RULES_VERSION,
  };
}

// ------------------------------------------------------------------ evaluación

export interface LoadoutRow {
  catalog_version: string;
  chassis: string;
  modules: unknown;
}

/**
 * H13 · Caché por contenido: (reglas, catálogo, huella del loadout). Las versiones de
 * catálogo y las revisiones de loadout son inmutables, así que la entrada nunca se
 * queda vieja; el cambio de validador llega con un despliegue (proceso nuevo, caché
 * vacía) y el de criterio con ELIGIBILITY_RULES_VERSION. Acotada para no crecer sin fin.
 */
const CACHE_MAX = 5000;
const cache = new Map<string, VersionEligibility>();

export function clearEligibilityCache(): void {
  cache.clear();
}

function parseModules(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Evalúa un loadout guardado (sin modificarlo) contra su catálogo y el validador actual. */
export function evaluateLoadout(row: LoadoutRow, catalog: ModuleDefinition[]): VersionEligibility {
  const modules = parseModules(row.modules);
  const key = createHash("sha256")
    .update(JSON.stringify([ELIGIBILITY_RULES_VERSION, row.catalog_version, row.chassis, modules ?? null]))
    .digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;
  let out: VersionEligibility;
  if (catalog.length === 0) {
    out = unverifiable(`el catálogo ${row.catalog_version} de su loadout no está disponible.`);
  } else if (
    !Array.isArray(modules) ||
    modules.some((m) => !m || typeof m !== "object" || typeof (m as { moduleId?: unknown }).moduleId !== "string")
  ) {
    out = classifyViolations([
      { code: "unknown_slot", message: "El loadout guardado está malformado (lista de módulos ilegible)." },
    ]);
  } else {
    // Sin categorías prohibidas: eso es del ruleset de cada competición (balance).
    out = classifyViolations(
      validateLoadout(
        {
          loadoutId: "historical",
          revision: 1,
          catalogVersion: row.catalog_version,
          chassis: row.chassis,
          modules: modules as { slot: string; moduleId: string; ammo?: string }[],
        },
        catalog,
        BUDGET_CREDITS_MVP,
        [],
      ),
    );
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

export interface VersionRef {
  botId: string;
  version: number;
}

/**
 * Forma canónica de un uuid (minúsculas, con guiones). PostgreSQL acepta como uuid
 * MAYÚSCULAS, `{llaves}` y sin guiones: si la clave del mapa de resultados usara la
 * forma cruda del cliente, una ref no casaría con su fila. Lo que no parece un uuid se
 * devuelve tal cual (la BD lo rechazará o no lo encontrará).
 */
export function canonicalUuid(id: string): string {
  const hex = id
    .trim()
    .replace(/^\{(.*)\}$/, "$1")
    .replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return id;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const eligibilityKey = (botId: string, version: number) => `${canonicalUuid(String(botId))}@${version}`;

/**
 * Resultado de una ref, FALLANDO CERRADO: si no hay resultado (la ref no casa con
 * ninguna fila, sea cual sea el motivo), la versión es UNKNOWN y no elegible.
 */
export function eligibilityOf(res: Map<string, VersionEligibility>, ref: VersionRef): VersionEligibility {
  return res.get(eligibilityKey(ref.botId, ref.version)) ?? unverifiable("no se encontró la versión ni su loadout.");
}

/**
 * Elegibilidad de varias versiones en una pasada (una consulta por tabla y un
 * `getCatalog` por versión de catálogo). Sólo LEE. Una versión inexistente no
 * aparece en el resultado (el llamador ya responde por ella).
 */
export async function evaluateVersionsEligibility(
  db: Knex,
  refs: VersionRef[],
): Promise<Map<string, VersionEligibility>> {
  const out = new Map<string, VersionEligibility>();
  if (refs.length === 0) return out;
  const rows = (await db("bot_versions as v")
    .leftJoin("bot_loadouts as l", function () {
      this.on("l.bot_id", "=", "v.bot_id").andOn("l.revision", "=", "v.loadout_revision");
    })
    .where((q) => {
      for (const r of refs) q.orWhere({ "v.bot_id": canonicalUuid(r.botId), "v.version": r.version });
    })
    .select("v.bot_id", "v.version", "l.id as loadout_id", "l.catalog_version", "l.chassis", "l.modules")) as Record<
    string,
    unknown
  >[];
  const catalogs = new Map<string, ModuleDefinition[]>();
  for (const r of rows) {
    const k = eligibilityKey(String(r.bot_id), Number(r.version));
    if (!r.loadout_id) {
      out.set(k, unverifiable("su revisión de loadout no existe."));
      continue;
    }
    const cv = String(r.catalog_version);
    if (!catalogs.has(cv)) catalogs.set(cv, await getCatalog(db, cv));
    out.set(
      k,
      evaluateLoadout({ catalog_version: cv, chassis: String(r.chassis), modules: r.modules }, catalogs.get(cv)!),
    );
  }
  return out;
}

/** Forma pública (API) de la elegibilidad: sin la clase interna ni la versión de reglas. */
export function eligibilityToJson(e: VersionEligibility) {
  return {
    eligible: e.eligible,
    ...(e.reason ? { reason: e.reason } : {}),
    category: e.category,
    ...(e.message ? { message: e.message } : {}),
    ...(e.suggestedAction ? { suggestedAction: e.suggestedAction } : {}),
    violations: e.blocking.map((b) => ({
      code: b.code,
      category: b.category,
      message: b.message,
      ...(b.slot ? { slot: b.slot } : {}),
      ...(b.moduleId ? { moduleId: b.moduleId } : {}),
      ...(b.ammoId ? { ammoId: b.ammoId } : {}),
    })),
  };
}

/**
 * Estados en los que una versión es seleccionable para competición NUEVA (batalla o
 * torneo), además de elegible. FROZEN-REUSE (B1): `frozen` significa INMUTABLE (mismo
 * código, hash y loadout para siempre; lo garantiza el trigger `bot_version_immutable`),
 * NO «usada una vez»: una versión congelada al cerrar el torneo A puede inscribirse,
 * tal cual y sin clonarla ni descongelarla, en el torneo B.
 */
export const COMPETITION_STATES: ReadonlySet<string> = new Set(["published", "frozen"]);

/**
 * B8 · ÚNICA regla de ESTADO para competir: la usan POST /battles, rules-check y la
 * inscripción en torneos. Sólo el estado: la elegibilidad del loadout es aparte
 * (`assertVersionsEligible`), y la propiedad/visibilidad la comprueba cada ruta antes.
 */
export function isCompetitionState(state: unknown): boolean {
  return typeof state === "string" && COMPETITION_STATES.has(state);
}

/**
 * B4/B8 · ¿Puede esta versión inscribirse en un torneo NUEVO? Llamar DESPUÉS de las
 * comprobaciones de propiedad y de torneo abierto. Falla con el motivo REAL:
 *  - 409 `bot_not_published` (con `currentState`) si no existe o su estado no es
 *    `published` ni `frozen` (borrador, en validación, suspendida, retirada…);
 *  - 409 `bot_version_not_eligible` si su loadout histórico no pasa hoy el validador.
 * Sólo LEE: no cambia el estado (una `frozen` sigue `frozen`) ni crea versiones.
 * OLA 2 (EQUIPMENT_PRIVATE) · `viewer` decide cuánto detalle del loadout lleva el 409: la
 * ruta de inscripción ya exige ser el dueño, así que pasa `{ userId, staff: false }` y el
 * dueño ve el motivo real; sin `viewer`, sólo el veredicto genérico (falla hacia menos).
 * V1 · B4 · `budgetCredits` (el del torneo; null = sin presupuesto propio): ver
 * `assertWithinTournamentBudget`.
 */
export async function assertTournamentEligible(
  db: Knex,
  version: Record<string, unknown> | undefined | null,
  viewer?: EligibilityViewer,
  budgetCredits?: number | null,
): Promise<void> {
  if (!version || !isCompetitionState(version.state)) {
    throw new ApiError(
      409,
      "bot_not_published",
      version
        ? `Sólo se inscriben versiones publicadas o congeladas (frozen); esta versión está en estado ${String(version.state)}`
        : "Sólo se inscriben versiones publicadas o congeladas (frozen); la versión no existe",
      version ? { currentState: String(version.state) } : undefined,
    );
  }
  const ref = { botId: String(version.bot_id), version: Number(version.version) };
  await assertVersionsEligible(db, [ref], viewer);
  await assertWithinTournamentBudget(db, [ref], budgetCredits, viewer);
}

/** Resultado del cálculo ÚNICO de presupuesto de torneo para una versión (D-OP-18/19). */
export interface BudgetVerdict {
  botId: string;
  version: number;
  loadoutRevision: number;
  costCredits: number;
  budgetCredits: number;
  /** `budget_exceeded` y/o `module_cost_cap_exceeded` (contrato vigente de `validateLoadout`). */
  violations: Violation[];
  /** true si total o tope por pieza se superan. */
  over: boolean;
}

export interface BudgetRef extends VersionRef {
  /** Revisión de loadout FIJADA (la de la inscripción). Sin ella: la de la versión. */
  loadoutRevision?: number;
}

/**
 * V1 · B4 · ÚNICA implementación del presupuesto de un torneo (D-OP-10/18/19): la usan la
 * inscripción (alta, cambio de versión, consent y equipo), el cierre/materialización
 * (`entryCompetitionIssues`) y la ejecución (worker, última garantía). Sólo LEE: idempotente.
 * Cuenta la versión y la revisión de loadout FIJADAS (la de la inscripción cuando se da), con
 * el catálogo de ESA revisión, y aplica `budgetViolations`: total (con la munición embebida,
 * `loadoutCostCredits`) y tope por pieza (`module_cost_cap_exceeded`, MAX_MODULE_COST_FRACTION
 * × presupuesto: el contrato ya existente). Una ref sin loadout resoluble no figura en el
 * resultado (la elegibilidad ya la trata: falla cerrada allí).
 */
export async function evaluateTournamentBudget(
  db: Knex,
  refs: BudgetRef[],
  budgetCredits: number | null | undefined,
): Promise<Map<string, BudgetVerdict>> {
  const out = new Map<string, BudgetVerdict>();
  if (typeof budgetCredits !== "number" || !Number.isFinite(budgetCredits) || refs.length === 0) return out;
  const rows = (await db("bot_versions as v")
    .join("bot_loadouts as l", function () {
      this.on("l.bot_id", "=", "v.bot_id").andOn("l.revision", "=", "v.loadout_revision");
    })
    .where((q) => {
      for (const r of refs) q.orWhere({ "v.bot_id": canonicalUuid(r.botId), "v.version": r.version });
    })
    .select("v.bot_id", "v.version", "l.revision", "l.catalog_version", "l.chassis", "l.modules")) as Record<
    string,
    unknown
  >[];
  const pinned = new Map(
    refs.filter((r) => r.loadoutRevision !== undefined).map((r) => [eligibilityKey(r.botId, r.version), r]),
  );
  // Revisión fijada por la inscripción: manda sobre la actual de la versión.
  const pinnedRows = refs.filter((r) => r.loadoutRevision !== undefined).length
    ? ((await db("bot_loadouts")
        .where((q) => {
          for (const r of pinned.values()) q.orWhere({ bot_id: canonicalUuid(r.botId), revision: r.loadoutRevision });
        })
        .select("bot_id", "revision", "catalog_version", "chassis", "modules")) as Record<string, unknown>[])
    : [];
  const catalogs = new Map<string, ModuleDefinition[]>();
  const verdict = async (botId: string, version: number, revision: number, row: Record<string, unknown>) => {
    const cv = String(row.catalog_version);
    if (!catalogs.has(cv)) catalogs.set(cv, await getCatalog(db, cv));
    const modules = parseModules(row.modules);
    // H8 · una ref sin loadout resoluble (o con `modules` ilegible) no figura en el resultado: la elegibilidad
    // (`evaluateVersionsEligibility`/`loadout_not_eligible`) ya la bloquea fallando cerrado, y en BD es
    // inalcanzable (FK NOT NULL + RESTRICT sobre revisión y catálogo). No se duplica aquí.
    if (!Array.isArray(modules)) return;
    const catalog = catalogs.get(cv)!;
    const loadout = {
      loadoutId: "budget",
      revision,
      catalogVersion: cv,
      chassis: String(row.chassis),
      modules: modules as { slot: string; moduleId: string; ammo?: string }[],
    };
    const violations = budgetViolations(loadout, catalog, budgetCredits);
    out.set(eligibilityKey(botId, version), {
      botId,
      version,
      loadoutRevision: revision,
      costCredits: loadoutCostCredits(loadout, catalog),
      budgetCredits,
      violations,
      over: violations.length > 0,
    });
  };
  for (const r of rows) {
    const key = eligibilityKey(String(r.bot_id), Number(r.version));
    if (pinned.has(key)) continue;
    await verdict(String(r.bot_id), Number(r.version), Number(r.revision), r);
  }
  for (const r of pinned.values()) {
    const row = pinnedRows.find(
      (x) => canonicalUuid(String(x.bot_id)) === canonicalUuid(r.botId) && Number(x.revision) === r.loadoutRevision,
    );
    if (row) await verdict(canonicalUuid(r.botId), r.version, Number(r.loadoutRevision), row);
  }
  return out;
}

/** Mensaje claro para el dueño: coste, presupuesto y qué regla se incumple. */
function budgetMessage(b: BudgetVerdict, label: string): string {
  const total = b.violations.some((v) => v.code === "budget_exceeded");
  const cap = b.violations.find((v) => v.code === "module_cost_cap_exceeded");
  const parts: string[] = [];
  if (total) {
    parts.push(
      `cuesta ${b.costCredits} créditos y el presupuesto de este torneo es de ${b.budgetCredits} (se pasa en ${b.costCredits - b.budgetCredits})`,
    );
  }
  if (cap) parts.push(`${cap.message}`);
  return `${label} ${parts.join("; ")}. La versión sigue siendo válida para batallas sueltas; usa otra versión o crea una con un loadout más barato.`;
}

/**
 * V1 · B4 (D-OP-10/18/19) · `budgetCredits` del torneo es una REGLA REAL en la INSCRIPCIÓN:
 * una versión que supera el presupuesto (total o tope por pieza) no puede inscribirse.
 * `null`/`undefined` = el torneo no fija presupuesto propio y no restringe. El mismo cálculo
 * (`evaluateTournamentBudget`) gobierna el cierre y la ejecución.
 *
 * Política de transición: ni toca versiones publicadas (siguen válidas para batallas sueltas)
 * ni revoca inscripciones existentes ni resultados históricos. Sólo el dueño (o staff) ve las
 * cifras: un tercero recibe el veredicto genérico.
 */
export async function assertWithinTournamentBudget(
  db: Knex,
  refs: BudgetRef[],
  budgetCredits: number | null | undefined,
  viewer?: EligibilityViewer,
): Promise<void> {
  const verdicts = await evaluateTournamentBudget(db, refs, budgetCredits);
  const over = refs
    .map((r) => verdicts.get(eligibilityKey(r.botId, r.version)))
    .filter((x): x is BudgetVerdict => !!x?.over);
  if (over.length === 0) return;
  const detail = !!viewer && (viewer.staff || viewer.userId !== null);
  // H9 · el nombre del bot sólo se resuelve para quien ve el detalle (dueño o staff).
  const names = new Map<string, string>();
  if (detail) {
    const rows = (await db("bots")
      .whereIn(
        "id",
        over.map((b) => canonicalUuid(b.botId)),
      )
      .select("id", "name")) as { id: string; name: string }[];
    for (const r of rows) names.set(canonicalUuid(String(r.id)), String(r.name));
  }
  const labelOf = (b: BudgetVerdict) => {
    const n = names.get(canonicalUuid(b.botId));
    return n ? `${n} (${b.botId}) v${b.version}` : `${b.botId} v${b.version}`;
  };
  const items = over.map((b) =>
    detail
      ? {
          botId: b.botId,
          ...(names.get(canonicalUuid(b.botId)) ? { botName: names.get(canonicalUuid(b.botId)) } : {}),
          version: b.version,
          costCredits: b.costCredits,
          budgetCredits: b.budgetCredits,
          excessCredits: Math.max(0, b.costCredits - b.budgetCredits),
          rules: b.violations.map((v) => v.code),
        }
      : { botId: b.botId, version: b.version },
  );
  const f = over[0];
  throw new ApiError(
    409,
    "bot_version_not_eligible",
    detail ? budgetMessage(f, labelOf(f)) : `${f.botId} v${f.version}: supera el presupuesto del torneo.`,
    { reason: "exceeds_tournament_budget", budgetCredits: f.budgetCredits, overBudget: items },
  );
}

/**
 * H9 · Campo aditivo `battleEligibility` para las filas de versión que devuelve la API.
 * Sólo para versiones publicadas/congeladas (las demás ya no son seleccionables por
 * estado). `opts.detailed` lo fija el llamador (dueño/staff); sin él sólo sale el veredicto.
 */
export async function battleEligibilityOf(
  db: Knex,
  versions: Record<string, unknown>[],
  opts: { detailed: boolean },
): Promise<(v: Record<string, unknown>) => { battleEligibility?: Record<string, unknown> }> {
  const res = await evaluateVersionsEligibility(
    db,
    versions
      .filter((v) => COMPETITION_STATES.has(String(v.state)))
      .map((v) => ({ botId: String(v.bot_id), version: Number(v.version) })),
  );
  return (v) => {
    if (!COMPETITION_STATES.has(String(v.state))) return {};
    const e = eligibilityOf(res, { botId: String(v.bot_id), version: Number(v.version) });
    if (opts.detailed) return { battleEligibility: eligibilityToJson(e) };
    // Quien no puede leer el loadout (p. ej. anónimo: /loadouts exige rol user) sólo ve
    // el veredicto, nunca los módulos implicados.
    return {
      battleEligibility: {
        eligible: e.eligible,
        ...(e.reason ? { reason: e.reason } : {}),
        category: e.category,
        violations: [],
      },
    };
  };
}

/** Quién pregunta, para decidir cuánto detalle del loadout puede ver en un 409. */
export interface EligibilityViewer {
  userId: string | null;
  /** Staff (moderador o superior): ve el detalle de cualquier bot. */
  staff: boolean;
}

/** Mensaje y forma que ve quien NO es dueño ni staff del bot: veredicto, nunca el loadout. */
const GENERIC_NOT_ELIGIBLE = "la versión no es elegible";

/**
 * Autoridad en servidor para competición NUEVA (H7/H8). Llamar DESPUÉS de las
 * comprobaciones de visibilidad y de estado publicado. OJO (OLA 2, EQUIPMENT_PRIVATE):
 * poder VER un bot (p. ej. público) no da derecho a su loadout, que sólo lee su dueño y el
 * staff; por eso el motivo detallado (módulos, ranuras, munición) sólo se devuelve a ellos.
 * Sin `viewer` o para un bot ajeno: 409 `bot_version_not_eligible` con motivo genérico y
 * `violations: []`. Primer elemento no elegible y la lista, como siempre.
 */
export async function assertVersionsEligible(db: Knex, refs: VersionRef[], viewer?: EligibilityViewer): Promise<void> {
  const res = await evaluateVersionsEligibility(db, refs);
  const bad = refs.map((r) => ({ ...r, e: eligibilityOf(res, r) })).filter((x) => !x.e.eligible);
  if (bad.length === 0) return;
  const owners = new Map<string, string | null>();
  if (viewer && !viewer.staff && viewer.userId) {
    const rows = await db("bots")
      .whereIn("id", [...new Set(bad.map((b) => b.botId))])
      .select("id", "owner_id");
    for (const r of rows as { id: string; owner_id: string }[]) owners.set(String(r.id), String(r.owner_id));
  }
  const detailFor = (botId: string) =>
    !!viewer && (viewer.staff || (viewer.userId !== null && owners.get(botId) === viewer.userId));
  const notEligible = bad.map((b) =>
    detailFor(b.botId)
      ? { botId: b.botId, version: b.version, ...eligibilityToJson(b.e!) }
      : {
          botId: b.botId,
          version: b.version,
          eligible: false,
          ...(b.e!.reason ? { reason: b.e!.reason } : {}),
          category: b.e!.category,
          violations: [],
        },
  );
  const first = bad[0];
  throw new ApiError(
    409,
    "bot_version_not_eligible",
    detailFor(first.botId)
      ? `${first.botId} v${first.version}: ${first.e!.message} ${first.e!.suggestedAction}`
      : `${first.botId} v${first.version}: ${GENERIC_NOT_ELIGIBLE}.`,
    { notEligible },
  );
}

// ---------------------------------------------------------------- inventario

/**
 * H5/H15 · Inventario de TODAS las versiones published/frozen. Corre en una
 * transacción `READ ONLY` de PostgreSQL: cualquier escritura dentro fallaría, así que
 * la garantía «no escribe» la da la base de datos, no la disciplina del código.
 */
export async function buildEligibilityInventory(db: Knex, opts: { summaryOnly?: boolean } = {}) {
  const rows = (await db.transaction(async (trx) => {
    await trx.raw("SET TRANSACTION READ ONLY");
    const vs = (await trx("bot_versions as v")
      .join("bots as b", "b.id", "v.bot_id")
      .leftJoin("bot_loadouts as l", function () {
        this.on("l.bot_id", "=", "v.bot_id").andOn("l.revision", "=", "v.loadout_revision");
      })
      .whereIn("v.state", [...COMPETITION_STATES])
      .orderBy([
        { column: "b.name", order: "asc" },
        { column: "v.version", order: "asc" },
      ])
      .select(
        "v.bot_id",
        "v.version",
        "v.state",
        "v.loadout_revision",
        "b.name as bot_name",
        "b.owner_id",
        "l.id as loadout_id",
        "l.catalog_version",
        "l.chassis",
        "l.modules",
      )) as Record<string, unknown>[];
    const catalogs = new Map<string, ModuleDefinition[]>();
    for (const r of vs) {
      const cv = r.catalog_version == null ? null : String(r.catalog_version);
      if (cv && !catalogs.has(cv)) catalogs.set(cv, await getCatalog(trx, cv));
    }
    return vs.map((r) => ({
      r,
      e: !r.loadout_id
        ? unverifiable("su revisión de loadout no existe.")
        : evaluateLoadout(
            { catalog_version: String(r.catalog_version), chassis: String(r.chassis), modules: r.modules },
            catalogs.get(String(r.catalog_version))!,
          ),
    }));
  })) as { r: Record<string, unknown>; e: VersionEligibility }[];

  const invalid = rows.filter((x) => !x.e.eligible);
  const invalidByReason: Record<string, number> = {};
  for (const x of invalid) invalidByReason[x.e.category] = (invalidByReason[x.e.category] ?? 0) + 1;
  const warningsByCode: Record<string, number> = {};
  for (const x of rows) for (const w of x.e.warnings) warningsByCode[w.code] = (warningsByCode[w.code] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    rulesVersion: ELIGIBILITY_RULES_VERSION,
    readOnly: true as const,
    scope: "bot_versions.state IN (published, frozen)",
    summary: {
      totalPublishedVersions: rows.length,
      currentlyValid: rows.length - invalid.length,
      currentlyInvalid: invalid.length,
      invalidByReason,
      usersAffected: new Set(invalid.map((x) => String(x.r.owner_id))).size,
      botsAffected: new Set(invalid.map((x) => String(x.r.bot_id))).size,
      warningsByCode,
    },
    ...(opts.summaryOnly
      ? {}
      : {
          items: rows.map(({ r, e }) => ({
            botId: r.bot_id,
            botName: r.bot_name,
            version: Number(r.version),
            state: r.state,
            ownerId: r.owner_id,
            loadoutRevision: Number(r.loadout_revision),
            currentValidation: e.category,
            eligible: e.eligible,
            ...(e.reason ? { reason: e.reason } : {}),
            violations: e.blocking.map((b) => ({ code: b.code, category: b.category, message: b.message })),
          })),
        }),
  };
}

// ------------------------------------------------------------------- torneos

/**
 * #287 · Tamaño de equipo de un torneo `teams` con reglas NvN (copia inmutable ADR-022), o
 * `null` si el torneo no es por equipos o es `classic` (sin `params`: no fija tamaño).
 */
export function teamSizeOf(t: Record<string, unknown>): number | null {
  if (t.format !== "teams") return null;
  const n = rulesOf(t)?.params?.teamSize;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/** Motivos ESTABLES por los que una inscripción pendiente no compite (sólo para el servidor). */
export type EntryIssue =
  | "version_not_competing" // estado fuera de published|frozen (suspendida, retirada…)
  | "loadout_not_eligible" // su loadout no pasa hoy el validador
  | "over_budget" // supera budgetCredits del torneo (total o tope por pieza), con la revisión FIJADA en la inscripción
  | "not_in_team" // inscrita con un equipo del que el bot ya no forma parte
  | "bot_retired" // bot retirado tras inscribirse con su equipo
  | "no_team" // torneo NvN e inscripción sin equipo efectivo (alta anterior a la 022)
  | "consent_missing" // inscripción de equipo sin la autorización vigente del dueño del bot
  | "team_incomplete"; // su equipo (efectivo) no tiene exactamente N inscripciones

/**
 * #287 (ronda 2, H2/H4) · PREDICADO ÚNICO «compite»: una inscripción PENDIENTE compite si su
 * versión está en estado de competición (`isCompetitionState`), su loadout es elegible
 * (`evaluateVersionsEligibility`) y, en un torneo `teams` con tamaño, el bot sigue en el equipo
 * con el que se inscribió, no está retirado y su dueño mantiene la autorización (H5), o — alta
 * anterior a la 022 (`team_id` NULL) — el bot tiene equipo. Lo usan el cierre (no cierra si
 * alguna no compite), la exclusión por el organizador (sólo puede excluir las que no compiten)
 * y la sustitución de versión por el dueño (sólo sustituye una que no compite): así lo que
 * bloquea el cierre es SIEMPRE desbloqueable. Sólo LEE. Devuelve los motivos por id.
 */
export async function entryCompetitionIssues(
  db: Knex,
  tournament: Record<string, unknown>,
  entries: Record<string, unknown>[],
): Promise<Map<string, EntryIssue[]>> {
  const out = new Map<string, EntryIssue[]>();
  if (entries.length === 0) return out;
  const refs = entries.map((e) => ({ botId: String(e.bot_id), version: Number(e.version) }));
  const versions = (await db("bot_versions").where((q) => {
    for (const r of refs) q.orWhere({ bot_id: r.botId, version: r.version });
  })) as Record<string, unknown>[];
  const stateOf = new Map(versions.map((v) => [eligibilityKey(String(v.bot_id), Number(v.version)), v.state]));
  const elig = await evaluateVersionsEligibility(db, refs);
  // V1 · B4 (D-OP-18 b) · presupuesto del torneo con la versión y la revisión de loadout FIJADAS
  // por la inscripción: el MISMO cálculo que la inscripción y la ejecución.
  const budget = await evaluateTournamentBudget(
    db,
    entries.map((e) => ({
      botId: String(e.bot_id),
      version: Number(e.version),
      loadoutRevision: Number(e.loadout_revision),
    })),
    tournament.budget_credits as number | null | undefined,
  );
  const teamSized = teamSizeOf(tournament) !== null;
  const ids = [...new Set(refs.map((r) => r.botId))];
  const bots = teamSized ? ((await db("bots").whereIn("id", ids)) as Record<string, unknown>[]) : [];
  const botById = new Map(bots.map((b) => [String(b.id), b]));
  const consents = teamSized
    ? ((await db("team_entry_consents").where({ tournament_id: tournament.id }).whereIn("bot_id", ids)) as Record<
        string,
        unknown
      >[])
    : [];
  const consentByBot = new Map(consents.map((c) => [String(c.bot_id), c]));
  // Tamaño de cada equipo EFECTIVO sobre TODAS las inscripciones del torneo (no sólo las
  // evaluadas): si se excluye un miembro, el resto de su equipo deja de competir y también
  // se puede excluir — nada queda bloqueado por un equipo a medias.
  const teamCount = new Map<string, number>();
  if (teamSized) {
    const all = (await db("entries")
      .join("bots", "bots.id", "entries.bot_id")
      .where({ "entries.tournament_id": tournament.id })
      .select(db.raw("COALESCE(entries.team_id, bots.team_id) AS effective_team_id"))) as {
      effective_team_id: string | null;
    }[];
    for (const r of all) {
      if (r.effective_team_id) teamCount.set(r.effective_team_id, (teamCount.get(r.effective_team_id) ?? 0) + 1);
    }
  }
  const n = teamSizeOf(tournament);
  for (const e of entries) {
    const ref = { botId: String(e.bot_id), version: Number(e.version) };
    const issues: EntryIssue[] = [];
    if (!isCompetitionState(stateOf.get(eligibilityKey(ref.botId, ref.version)))) issues.push("version_not_competing");
    if (!eligibilityOf(elig, ref).eligible) issues.push("loadout_not_eligible");
    if (budget.get(eligibilityKey(ref.botId, ref.version))?.over) issues.push("over_budget");
    if (teamSized) {
      const bot = botById.get(ref.botId);
      if (e.team_id) {
        if (!bot || bot.team_id !== e.team_id) issues.push("not_in_team");
        if (bot?.retired_at) issues.push("bot_retired");
        const c = consentByBot.get(ref.botId);
        if (!c || c.team_id !== e.team_id || Number(c.version) !== ref.version || c.owner_id !== bot?.owner_id) {
          issues.push("consent_missing");
        }
      } else if (!bot?.team_id) {
        issues.push("no_team");
      }
      const effective = (e.team_id as string | null) ?? (bot?.team_id as string | null) ?? null;
      if (effective && teamCount.get(effective) !== n) issues.push("team_incomplete");
    }
    out.set(String(e.id), issues);
  }
  return out;
}

const ROSTER_ISSUES: ReadonlySet<EntryIssue> = new Set(["not_in_team", "bot_retired", "no_team", "consent_missing"]);
const UNBLOCK =
  "Para cerrar, el organizador puede excluirlas (POST …/entries/{entryId}/actions/exclude), o sus dueños retirarlas o inscribir otra versión válida.";

/**
 * #287 (ronda 2) · Cierre: si alguna inscripción pendiente NO compite (predicado único de
 * arriba), no se cierra ni se congela nada. Tres códigos, por orden, todos con los ids de
 * inscripción (sin el motivo ni datos del bot: el organizador no ve bots privados ajenos):
 *  - 409 `entries_not_eligible`: versión fuera de published|frozen o loadout no elegible;
 *  - 409 `team_roster_changed`: el bot salió de su equipo, se retiró, no tiene equipo o su
 *    dueño retiró la autorización;
 *  - 409 `rules_team_size` (ADR-022): algún equipo no tiene exactamente N inscripciones.
 * El mensaje dice la verdad: TODAS se pueden excluir por el organizador (mismo predicado).
 */
export async function entryCompetitionGate(
  db: Knex,
  tournament: Record<string, unknown>,
  entries: Record<string, unknown>[],
): Promise<void> {
  const issues = await entryCompetitionIssues(db, tournament, entries);
  const of = (e: Record<string, unknown>) => issues.get(String(e.id)) ?? [];
  const ids = (xs: Record<string, unknown>[]) => xs.map((e) => ({ entryId: e.id }));
  const badVersion = entries.filter((e) =>
    of(e).some((i) => i === "version_not_competing" || i === "loadout_not_eligible" || i === "over_budget"),
  );
  if (badVersion.length > 0) {
    throw new ApiError(
      409,
      "entries_not_eligible",
      `${badVersion.length} inscripción(es) usan una versión que ya no compite (no está publicada ni congelada, su loadout ya no es elegible o supera el presupuesto del torneo); se conserva para el histórico. ${UNBLOCK}`,
      { notEligibleEntries: ids(badVersion) },
    );
  }
  const badRoster = entries.filter((e) => of(e).some((i) => ROSTER_ISSUES.has(i)));
  if (badRoster.length > 0) {
    throw new ApiError(
      409,
      "team_roster_changed",
      `${badRoster.length} inscripción(es) ya no pertenecen a su equipo (el bot salió o cambió de equipo, se retiró, no tiene equipo o su dueño retiró la autorización). ${UNBLOCK}`,
      {
        notEligibleEntries: ids(badRoster),
        changedEntries: badRoster.map((e) => ({ entryId: e.id, teamId: (e.team_id as string | null) ?? null })),
      },
    );
  }
  const incomplete = entries.filter((e) => of(e).includes("team_incomplete"));
  if (incomplete.length > 0) {
    const n = teamSizeOf(tournament);
    throw new ApiError(
      409,
      "rules_team_size",
      `${n} contra ${n}: ${incomplete.length} inscripción(es) son de equipos que no tienen exactamente ${n} bots inscritos. ${UNBLOCK}`,
      { teamSize: n, notEligibleEntries: ids(incomplete) },
    );
  }
}

/**
 * Inscripción (H8). Primero exige que la versión pedida sea elegible (409
 * `bot_version_not_eligible`). Después, si el bot YA tenía una inscripción PENDIENTE
 * (sin congelar) con una versión que hoy no es elegible, la cambia por la pedida y lo
 * audita: es el dueño quien elige la versión válida, nunca se sustituye sola. Devuelve
 * la inscripción actualizada, o `null` si no había nada que sustituir (el llamador
 * sigue con su flujo normal: alta nueva o `already_entered`).
 */
export async function replaceIneligibleEntry(
  db: Knex,
  actorId: string,
  tournament: Record<string, unknown>,
  version: Record<string, unknown>,
  correlationId?: string,
): Promise<Record<string, unknown> | null> {
  const botId = String(version.bot_id);
  const n = Number(version.version);
  // Sólo el dueño inscribe su bot (la ruta lo exige): ve el detalle de su propio loadout.
  await assertVersionsEligible(db, [{ botId, version: n }], { userId: actorId, staff: false });
  const entry = await db("entries").where({ tournament_id: tournament.id, bot_id: botId }).first();
  if (!entry || entry.frozen || Number(entry.version) === n) return null;
  const prev = eligibilityOf(await evaluateVersionsEligibility(db, [{ botId, version: Number(entry.version) }]), {
    botId,
    version: Number(entry.version),
  });
  // #287 (ronda 2, H2) · el MISMO predicado que el cierre: sólo se sustituye una inscripción
  // que no compite (estado, loadout o equipo), nunca una válida.
  const issues = (await entryCompetitionIssues(db, tournament, [entry])).get(String(entry.id)) ?? [];
  if (issues.length === 0) return null;
  // Cambio y rastro de auditoría juntos: o las dos cosas o ninguna.
  const updated = await db.transaction(async (trx) => {
    const [row] = await trx("entries")
      .where({ id: entry.id, frozen: false })
      .update({ version: n, loadout_revision: version.loadout_revision })
      .returning("*");
    if (!row) return null;
    // #287 (H5) · en una inscripción de equipo, el dueño que cambia su versión renueva con
    // ella su autorización (la del equipo es por versión).
    if (entry.team_id) {
      await trx("team_entry_consents")
        .insert({ tournament_id: tournament.id, bot_id: botId, team_id: entry.team_id, version: n, owner_id: actorId })
        .onConflict(["tournament_id", "bot_id"])
        .merge({ team_id: entry.team_id, version: n, owner_id: actorId });
    }
    await trx("audit_log").insert({
      actor_id: actorId,
      action: "tournament.entry.version_replaced",
      target: `tournament:${tournament.id}`,
      detail: JSON.stringify({
        entryId: entry.id,
        botId,
        fromVersion: Number(entry.version),
        toVersion: n,
        reason: prev.reason,
        category: prev.category,
        issues,
      }),
      correlation_id: correlationId ?? null,
    });
    return row;
  });
  if (!updated) return null;
  return {
    id: updated.id,
    tournamentId: tournament.id,
    botId,
    version: n,
    loadoutRevision: updated.loadout_revision,
    frozen: updated.frozen,
    replacedVersion: Number(entry.version),
  };
}

/**
 * Cierre de inscripciones (H8): si alguna inscripción pendiente usa una versión que ya
 * no es elegible, NO se cierra (ni se congela nada, ni se genera calendario): 409
 * `entries_not_eligible`. Sólo se devuelven los ids de inscripción, no el motivo: el
 * organizador no tiene por qué ver el loadout de bots privados ajenos; cada dueño ve
 * el motivo en su bot y reinscribe otra versión válida.
 */
export async function entryEligibilityGate(db: Knex, entries: Record<string, unknown>[]): Promise<void> {
  const res = await evaluateVersionsEligibility(
    db,
    entries.map((e) => ({ botId: String(e.bot_id), version: Number(e.version) })),
  );
  const blocked = entries.filter(
    (e) => !eligibilityOf(res, { botId: String(e.bot_id), version: Number(e.version) }).eligible,
  );
  if (blocked.length === 0) return;
  throw new ApiError(
    409,
    "entries_not_eligible",
    `${blocked.length} inscripción(es) usan una versión que se conserva para el histórico pero ya no es elegible para competición nueva. Sus dueños deben inscribir otra versión válida (la misma inscripción admite la nueva versión), o el organizador puede excluirlas (POST …/entries/{entryId}/actions/exclude), antes de cerrar.`,
    { notEligibleEntries: blocked.map((e) => ({ entryId: e.id })) },
  );
}

/**
 * H8 · Excluir una inscripción PENDIENTE (torneo abierto, sin congelar). Sin esto, un
 * dueño ausente dejaba `closeEntries` en 409 `entries_not_eligible` para siempre.
 *  - El ORGANIZADOR sólo puede excluir inscripciones NO elegibles.
 *  - El DUEÑO del bot puede retirar la suya.
 * Una inscripción pendiente nunca ha jugado (sin batallas, sin calendario, versión sin
 * congelar): se quita de `entries` y su contenido completo queda en audit_log (quién,
 * cuándo, motivo, versión) en la MISMA transacción. Ningún dato histórico se toca.
 */
export async function excludeTournamentEntry(
  db: Knex,
  // #291 · `rank` (no un booleano de rol): la vía de organizador exige además gestionar ESTE torneo.
  actor: { userId: string; rank: number },
  tournamentId: string,
  entryId: string,
  reason: unknown,
  correlationId?: string,
): Promise<Record<string, unknown>> {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 256) {
    throw new ApiError(400, "bad_request", "reason obligatorio (máx. 256)");
  }
  const t = await db("tournaments")
    .where({ id: tournamentId })
    .first()
    .catch(() => null);
  const entry = t
    ? await db("entries")
        .where({ id: entryId, tournament_id: t.id })
        .first()
        .catch(() => null)
    : null;
  if (!t || !entry) throw new ApiError(404, "not_found", "No existe o no es visible para el solicitante");
  const bot = await db("bots").where({ id: entry.bot_id }).first();
  const byOwner = bot?.owner_id === actor.userId;
  // #291 · vía de organizador = rol organizer (suelo de main) Y dueño del torneo o staff.
  const byManager = actor.rank >= ROLE_RANK.organizer && canManageTournament(actor, t);
  if (!byOwner && !byManager) {
    throw new ApiError(
      403,
      "forbidden",
      "Sólo el dueño del bot, o quien organiza el torneo (o el staff), pueden excluir la inscripción",
    );
  }
  if (t.state !== "open" || entry.frozen) {
    throw new ApiError(409, "entries_closed", "Sólo se excluyen inscripciones pendientes de un torneo abierto");
  }
  const ref = { botId: String(entry.bot_id), version: Number(entry.version) };
  const e = eligibilityOf(await evaluateVersionsEligibility(db, [ref]), ref);
  // #287 (ronda 2, H2/H4) · el organizador excluye lo que NO COMPITE con el MISMO predicado
  // que bloquea el cierre (estado, loadout o equipo): nada bloquea el cierre sin salida.
  const issues = (await entryCompetitionIssues(db, t, [entry])).get(String(entry.id)) ?? [];
  if (!byOwner && issues.length === 0) {
    throw new ApiError(409, "entry_eligible", "La inscripción compite: sólo su dueño puede retirarla");
  }
  await db.transaction(async (trx) => {
    // #287 (ronda 3, R2-1) · el TORNEO bloqueado (FOR UPDATE) y su estado revalidado DENTRO,
    // como el alta, la sustitución, las autorizaciones y el cierre: una exclusión concurrente
    // con el cierre espera y ve el torneo cerrado (nunca deja cerrado un equipo a medias ni
    // una versión congelada sin inscripción).
    const locked_t = await trx("tournaments").where({ id: t.id }).forUpdate().first();
    if (!locked_t || locked_t.state !== "open") {
      throw new ApiError(409, "entries_closed", "Sólo se excluyen inscripciones pendientes de un torneo abierto");
    }
    // TOCTOU · se bloquea la fila y se comprueba que sigue siendo LA MISMA inscripción
    // evaluada (versión y revisión): si el dueño la cambió entretanto (p. ej. a una
    // versión elegible), no se borra ni se audita nada.
    // Con la misma versión y revisión (ambas inmutables) la evaluación previa sigue
    // siendo la de la fila bloqueada, y el audit_log describe exactamente lo borrado.
    const locked = await trx("entries").where({ id: entry.id }).forUpdate().first();
    if (
      !locked ||
      locked.frozen ||
      Number(locked.version) !== Number(entry.version) ||
      Number(locked.loadout_revision) !== Number(entry.loadout_revision)
    ) {
      throw new ApiError(409, "entry_changed", "La inscripción cambió mientras se procesaba: vuelve a revisarla");
    }
    // El organizador sólo excluye lo que NO compite: se revalida con el torneo bloqueado.
    if (!byOwner) {
      const lockedIssues = (await entryCompetitionIssues(trx, locked_t, [locked])).get(String(locked.id)) ?? [];
      if (lockedIssues.length === 0) {
        throw new ApiError(409, "entry_eligible", "La inscripción compite: sólo su dueño puede retirarla");
      }
    }
    const n = await trx("entries")
      .where({ id: entry.id, frozen: false, version: entry.version, loadout_revision: entry.loadout_revision })
      .del();
    if (n !== 1)
      throw new ApiError(409, "entry_changed", "La inscripción cambió mientras se procesaba: vuelve a revisarla");
    await trx("audit_log").insert({
      actor_id: actor.userId,
      action: "tournament.entry.excluded",
      target: `tournament:${t.id}`,
      detail: JSON.stringify({
        entryId: entry.id,
        botId: entry.bot_id,
        version: Number(entry.version),
        loadoutRevision: Number(entry.loadout_revision),
        enteredAt: entry.created_at,
        by: byOwner ? "owner" : "organizer",
        reason: reason.trim(),
        eligible: e.eligible,
        category: e.category,
        issues,
      }),
      correlation_id: correlationId ?? null,
    });
  });
  return { entryId: entry.id, tournamentId: t.id, excluded: true, by: byOwner ? "owner" : "organizer" };
}
