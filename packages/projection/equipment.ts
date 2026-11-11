/**
 * OLA 2 · MA · EQUIPMENT_PRIVATE (D-B1 = R2) fuera del stream: estadísticas post-batalla
 * (getBattleStats) y WELCOME del bot.
 *
 *  - Estadísticas: lista blanca `stats.<campo>` de la política. Para quien no es dueño
 *    (ni staff) desaparecen el desglose por ranura (`perModule`: moduleId por ranura), las
 *    minas y la radio, que revelan el loadout. Lo deportivo observable se queda.
 *  - WELCOME: es la vista `bot_team`/`self` del propio vehículo. Sólo campos de catálogo con
 *    efecto real (ACTIVE) o de validación; nunca el `ModuleSpec` entero ni campos FUTURE
 *    (contrato §12). Los aliados no reciben el loadout de nadie.
 */
import { effectOf } from "../module-catalog/effect-status.js";
import type { ModuleCategory } from "../module-catalog/types.js";
import type { AudienceClass, DisclosurePolicy } from "./contracts.js";
import { DEFAULT_DISCLOSURE_POLICY, emits } from "./policy.js";

/** Proyecta las estadísticas de UN bot para una audiencia (`owner`/`staff` o pública). */
export function projectBotStats(
  stats: Readonly<Record<string, unknown>>,
  audience: AudienceClass,
  policy: DisclosurePolicy = DEFAULT_DISCLOSURE_POLICY,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats ?? {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (emits(policy, `stats.${k}`, audience)) out[k] = v;
  }
  return out;
}

/** Clave del `ModuleSpec` → propiedad canónica del catálogo (`effect-status.ts`). */
const SPEC_KEY_TO_PROP: Readonly<Record<string, string>> = {
  perActionEU: "power.perActionEU",
  passiveEUs: "power.passiveEUs",
};

/** Claves de identidad del módulo (no van en `specs`). */
const IDENTITY = new Set(["slot", "moduleId", "category"]);

export interface WelcomeModule {
  slot: string;
  moduleId: string;
  category: string;
  specs: Record<string, unknown>;
}

/**
 * Ficha de un módulo PROPIO para el WELCOME: sólo propiedades del catálogo con efecto
 * ACTIVE o de validación (PARTIAL con `validation`). Lo demás (FUTURE, valores derivados
 * que el catálogo no declara) no sale.
 */
export function projectWelcomeModule(spec: Readonly<Record<string, unknown>>): WelcomeModule {
  const category = String(spec.category ?? "") as ModuleCategory;
  const specs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (IDENTITY.has(k) || v === undefined) continue;
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const prop = SPEC_KEY_TO_PROP[k] ?? k;
    const eff = effectOf(category, prop);
    if (!eff) continue;
    if (eff.status === "ACTIVE" || (eff.status === "PARTIAL" && eff.validation)) specs[k] = v;
  }
  return { slot: String(spec.slot ?? ""), moduleId: String(spec.moduleId ?? ""), category, specs };
}
