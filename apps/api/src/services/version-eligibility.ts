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
import { getCatalog } from "./catalog.js";
import { validateLoadout, type Violation } from "../../../../packages/module-catalog/validator/index.js";
import type { ModuleDefinition } from "../../../../packages/module-catalog/types.js";
import { BUDGET_CREDITS_MVP } from "../../../../packages/game-rules/index.js";

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

/** Estados en los que una versión es seleccionable para competición (además de elegible). */
const COMPETITION_STATES = new Set(["published", "frozen"]);

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
  if (prev.eligible) return null;
  // Cambio y rastro de auditoría juntos: o las dos cosas o ninguna.
  const updated = await db.transaction(async (trx) => {
    const [row] = await trx("entries")
      .where({ id: entry.id, frozen: false })
      .update({ version: n, loadout_revision: version.loadout_revision })
      .returning("*");
    if (!row) return null;
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
  actor: { userId: string; isOrganizer: boolean },
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
  if (!byOwner && !actor.isOrganizer) {
    throw new ApiError(403, "forbidden", "Sólo el dueño del bot o un organizador pueden excluir la inscripción");
  }
  if (t.state !== "open" || entry.frozen) {
    throw new ApiError(409, "entries_closed", "Sólo se excluyen inscripciones pendientes de un torneo abierto");
  }
  const ref = { botId: String(entry.bot_id), version: Number(entry.version) };
  const e = eligibilityOf(await evaluateVersionsEligibility(db, [ref]), ref);
  if (!byOwner && e.eligible) {
    throw new ApiError(409, "entry_eligible", "La inscripción es elegible: sólo su dueño puede retirarla");
  }
  await db.transaction(async (trx) => {
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
      }),
      correlation_id: correlationId ?? null,
    });
  });
  return { entryId: entry.id, tournamentId: t.id, excluded: true, by: byOwner ? "owner" : "organizer" };
}
