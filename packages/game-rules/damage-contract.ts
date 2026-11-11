/**
 * OLA 2 · MB · CONTRATO DE DAÑO EXPLÍCITO (D-B3, D-B4, D-B5, D-B6) y valores del
 * contrato público de daño y torreta.
 *
 * Dos mitades, sin mezclar:
 *  - INTERNO (exacto o paramétrico): la tabla de perfiles de tipo de daño que consume
 *    `resolveDamage()` (apps/arena-engine/src/sim/damage.ts). Es la única fuente de los
 *    repartos, suelos y reglas de blindaje. Añadir un tipo de daño = una fila de datos.
 *  - PÚBLICO (cuantizado): las funciones PURAS con las que la proyección (Equipo MA)
 *    convierte el estado interno exacto en lo que ve una audiencia pública. MB define
 *    los valores y las funciones; MA las llama desde `projectFrame`.
 *
 * Reglas fijadas por el propietario (no se reabren aquí):
 *  - D-B3: SIN variación aleatoria de daño. El RNG del combate sólo elige el módulo
 *    impactado; ningún importe (efectivo, casco, absorbido) depende del RNG.
 *  - D-B4: blindaje exacto en lo interno; en lo público, cuantizado
 *    (`armorLevel`, ARMOR_LEVEL_STEPS niveles) y rotura visible (`armorBroken`).
 *  - D-B5: `hullLevel` público con N = 20 (HULL_LEVEL_STEPS).
 *  - D-B6: sin doble daño de HE: un vehículo recibe, como mucho, UN paquete por
 *    detonación (el impactado directo recibe el impacto directo y queda excluido de
 *    la onda; el resto de vehículos en radio recibe la onda con caída).
 *  - D-B2: las propiedades de la torreta (tasa y arco) son de la MONTURA (ranura del
 *    chasis), no del arma.
 *
 * Prohibido despachar por id de contenido (`if (type === "…")`): sólo tablas leídas con
 * `safeLookup`. Un tipo desconocido es un error (fail-closed), nunca un default silencioso.
 */
import type { DamageTypeId, DamageTypeProfile } from "../module-catalog/contracts/engine-v2.js";
import { CHASSIS_DAMAGE_SHARE, DMG_MIN_FRACTION, MODULE_DAMAGE_SHARE } from "./constants.js";
import { emptyDict, safeLookup } from "./safe-lookup.js";

// ===================================================================== INTERNO

/** Tope de la reducción efectiva tras restar la penetración: clamp(r − p, 0, R_MAX). */
export const ARMOR_REDUCTION_MAX = 1;

/** Tipo por defecto de un impacto directo de proyectil sin tipo declarado. */
export const DEFAULT_DIRECT_DAMAGE_TYPE: DamageTypeId = "kinetic";
/** Tipo de la onda de una explosión (proyectil con radio o mina). */
export const DEFAULT_EXPLOSION_DAMAGE_TYPE: DamageTypeId = "explosive";
/** Tipo del daño de las zonas del mapa. */
export const ZONE_DAMAGE_TYPE: DamageTypeId = "environmental";

const armored = (id: DamageTypeId): DamageTypeProfile =>
  Object.freeze({
    id,
    hullShare: CHASSIS_DAMAGE_SHARE,
    moduleShare: MODULE_DAMAGE_SHARE,
    armorApplies: true,
    armorWearFactor: 1,
    minFraction: DMG_MIN_FRACTION,
    usesSector: true,
  });

function buildProfiles(): Readonly<Record<DamageTypeId, DamageTypeProfile>> {
  const t = emptyDict<DamageTypeProfile>();
  // Con estos valores la capa nueva reproduce la fórmula D6 (ver damage-model.test.ts).
  t.kinetic = armored("kinetic");
  t.explosive = armored("explosive");
  // Sin contenido que los use (aplazado): sólo perfil de datos.
  t.thermal = armored("thermal");
  t.electronic = armored("electronic");
  // Zonas del mapa: directo al casco, sin blindaje, sin sector, sin módulo, sin RNG.
  t.environmental = Object.freeze({
    id: "environmental",
    hullShare: 1,
    moduleShare: 0,
    armorApplies: false,
    armorWearFactor: 0,
    minFraction: 0,
    usesSector: false,
  });
  return Object.freeze(t);
}

/** Registro de perfiles por tipo de daño (dato). */
export const DAMAGE_TYPE_PROFILES: Readonly<Record<DamageTypeId, DamageTypeProfile>> = buildProfiles();

export class UnknownDamageTypeError extends Error {}

/** Lectura fail-closed de un perfil (clase `__proto__` cubierta por safeLookup). */
export function damageProfileOf(
  type: DamageTypeId,
  profiles: Readonly<Record<DamageTypeId, DamageTypeProfile>> = DAMAGE_TYPE_PROFILES,
): DamageTypeProfile {
  const p = safeLookup(profiles as Record<string, DamageTypeProfile>, type);
  if (!p) throw new UnknownDamageTypeError(`tipo de daño sin perfil: ${String(type)}`);
  return p;
}

// ===================================================================== PÚBLICO

/** D-B5 · granularidad pública del casco. */
export const HULL_LEVEL_STEPS = 20;

/**
 * Nivel público del casco: ceil(N·hp/hpMax) en [0, N]. Vivo ⇒ ≥ 1; muerto ⇒ 0.
 * Nunca sale el hp absoluto ni hpMax.
 */
export function hullLevel(hullHp: number, hullHpMax: number, steps: number = HULL_LEVEL_STEPS): number {
  if (!(hullHpMax > 0) || !(hullHp > 0)) return 0;
  const f = Math.min(1, hullHp / hullHpMax);
  return Math.min(steps, Math.max(1, Math.ceil(steps * f - 1e-9)));
}

/** D-B4 · granularidad pública de un sector de blindaje. */
export const ARMOR_LEVEL_STEPS = 4;

/** Nivel público del blindaje de un sector: ceil(K·hp/hpMax) en [0, K]; 0 ⇔ roto. */
export function armorLevel(hp: number, hpMax: number, steps: number = ARMOR_LEVEL_STEPS): number {
  if (!(hpMax > 0) || !(hp > 0)) return 0;
  const f = Math.min(1, hp / hpMax);
  return Math.min(steps, Math.max(1, Math.ceil(steps * f - 1e-9)));
}

/** D-B4 · rotura visible: el sector existía y ya no absorbe nada. */
export function armorBroken(hp: number, hpMax: number): boolean {
  return hpMax > 0 && !(hp > 0);
}

/** Clase pública de un impacto (sustituye a `hit_dealt.damage` exacto en arena/2). */
export type PublicImpactClass = "hit" | "critical" | "kill";

/** Clase de impacto a partir de hechos discretos del registro, nunca de importes. */
export function impactClassOf(r: { killed: boolean; armorBroken: boolean; moduleDestroyed: boolean }): PublicImpactClass {
  if (r.killed) return "kill";
  if (r.armorBroken || r.moduleDestroyed) return "critical";
  return "hit";
}

/** Cuanto público del ángulo de torreta (higiene: la tasa es pública por la montura). */
export const TURRET_HEADING_QUANTUM = (2 * Math.PI) / 1024;

/** Normaliza un ángulo a (−π, π]. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Ángulo público de torreta: normalizado a (−π, π] y múltiplo de TURRET_HEADING_QUANTUM. */
export function quantizeTurretHeading(a: number): number {
  const q = Math.round(normalizeAngle(a) / TURRET_HEADING_QUANTUM) * TURRET_HEADING_QUANTUM;
  return normalizeAngle(q);
}
