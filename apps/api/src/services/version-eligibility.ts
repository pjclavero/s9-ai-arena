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

export const eligibilityKey = (botId: string, version: number) => `${botId}@${version}`;

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
      for (const r of refs) q.orWhere({ "v.bot_id": r.botId, "v.version": r.version });
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
 * Autoridad en servidor para competición NUEVA (H7/H8). Llamar DESPUÉS de las
 * comprobaciones de visibilidad y de estado publicado: quien llega aquí ya puede ver
 * el bot (y su loadout), así que el motivo no revela nada que no pudiera leer.
 * 409 `bot_version_not_eligible` con la primera versión no elegible y la lista.
 */
export async function assertVersionsEligible(db: Knex, refs: VersionRef[]): Promise<void> {
  const res = await evaluateVersionsEligibility(db, refs);
  const bad = refs
    .map((r) => ({ ...r, e: res.get(eligibilityKey(r.botId, r.version)) }))
    .filter((x) => x.e && !x.e.eligible);
  if (bad.length === 0) return;
  const first = bad[0];
  throw new ApiError(
    409,
    "bot_version_not_eligible",
    `${first.botId} v${first.version}: ${first.e!.message} ${first.e!.suggestedAction}`,
    {
      notEligible: bad.map((b) => ({ botId: b.botId, version: b.version, ...eligibilityToJson(b.e!) })),
    },
  );
}
