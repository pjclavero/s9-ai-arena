/**
 * OLA 2 · MB · Capa de daño: ÚNICA puerta de daño de vehículo del motor.
 *
 * Proyectiles (impacto directo), explosiones (onda), minas y zonas del mapa producen un
 * `DamagePacket` y lo resuelven aquí. Nada más resta `hullHp` ni `armor.hp`.
 *
 * Fórmula (docs/technical/engine-v2-contracts.md §6), por datos del perfil del tipo:
 *   sector     = usesSector ? sectorOfImpact(...) : null
 *   rBase      = armorApplies && sector con hp > 0 ? resist[type] ?? resist.default : 0
 *                (degradation "linear" lo escala por hp/hpMax; "binary" = 100 % hasta 0)
 *   reduction  = clamp(rBase − penetration, 0, ARMOR_REDUCTION_MAX)
 *   effective  = max(minFraction·amount, amount·(1 − reduction))
 *   absorbed   = amount − effective           → armor.hp −= absorbed·armorWearFactor
 *   hull       = effective·hullShare          → hullHp −= hull
 *   módulo     = effective·moduleShare a UN módulo vivo no-blindaje, un `weighted` del RNG
 *                sobre los candidatos ORDENADOS por slot, peso masa·moduleTargetWeights.
 *
 * D-B3: ningún importe depende del RNG. El RNG sólo elige el módulo impactado, y sólo si
 * hay presupuesto de módulo (las zonas, con moduleShare 0, no consumen RNG).
 */
import type { DamagePacket, DamageRecord, DamageTypeProfile, DamageTypeId } from "../../../../packages/module-catalog/contracts/engine-v2.js";
import { ARMOR_REDUCTION_MAX, DAMAGE_TYPE_PROFILES, damageProfileOf } from "../../../../packages/game-rules/damage-contract.js";
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";
import type { Rng } from "../rng.js";
import type { Vec2 } from "./physics.js";
import type { Sector } from "../../../../packages/game-rules/index.js";
import type { Vehicle } from "./vehicle.js";

/** Paquete tal y como lo construye el motor hoy (ids internos como string). */
export type EnginePacket = Omit<DamagePacket, "owner"> & { readonly owner: string | null };
export type EngineDamageRecord = Omit<DamageRecord, "target" | "owner"> & {
  readonly target: string;
  readonly owner: string | null;
};

/**
 * Sector impactado: se calcula con el ángulo del impacto RELATIVO al morro del vehículo.
 * ±45° = frontal, ±135° = trasero, resto laterales.
 */
export function sectorOfImpact(vehicleHeading: number, impactFrom: Vec2, vehiclePos: Vec2): Sector {
  const a = Math.atan2(impactFrom.y - vehiclePos.y, impactFrom.x - vehiclePos.x);
  let rel = a - vehicleHeading;
  while (rel > Math.PI) rel -= 2 * Math.PI;
  while (rel < -Math.PI) rel += 2 * Math.PI;
  const d = Math.abs(rel);
  if (d <= Math.PI / 4) return "front";
  if (d >= (3 * Math.PI) / 4) return "rear";
  return rel > 0 ? "left" : "right";
}

const clamp01 = (x: number, max: number) => (x < 0 ? 0 : x > max ? max : x);

/**
 * Resuelve un paquete contra un vehículo y MUTA su estado interno exacto (casco, blindaje,
 * módulo). Devuelve el registro exacto (INTERNO: nunca sale a terceros tal cual).
 */
export function resolveDamage(
  packet: EnginePacket,
  target: Vehicle,
  targetPose: { position: Vec2; heading: number },
  rng: Rng,
  tick: number,
  profiles: Readonly<Record<DamageTypeId, DamageTypeProfile>> = DAMAGE_TYPE_PROFILES,
): EngineDamageRecord {
  const profile = damageProfileOf(packet.type, profiles);
  const amount = Number.isFinite(packet.amount) && packet.amount > 0 ? packet.amount : 0;
  const penetration = Number.isFinite(packet.penetration) ? packet.penetration : 0;

  const sector = profile.usesSector ? sectorOfImpact(targetPose.heading, packet.from, targetPose.position) : null;
  const armor = sector ? target.armor[sector] : undefined;
  const armorActive = profile.armorApplies && armor !== undefined && armor.hp > 0;

  let rBase = 0;
  if (armorActive) {
    const resist = armor.profile.resist as Record<string, number | undefined>;
    rBase = safeLookup(resist, packet.type) ?? safeLookup(resist, "default") ?? 0;
    if (armor.profile.degradation === "linear" && armor.hpMax > 0) rBase *= armor.hp / armor.hpMax;
  }
  const reduction = clamp01(rBase - penetration, ARMOR_REDUCTION_MAX);
  const effective = Math.max(profile.minFraction * amount, amount * (1 - reduction));
  const absorbed = amount - effective;

  let armorBroken = false;
  if (armorActive && absorbed > 0) {
    armor.hp = Math.max(0, armor.hp - absorbed * profile.armorWearFactor);
    armorBroken = armor.hp <= 0;
  }

  const hull = effective * profile.hullShare;
  const moduleBudget = effective * profile.moduleShare;
  target.hullHp = Math.max(0, target.hullHp - hull);

  let moduleSlot: string | null = null;
  let moduleDamage = 0;
  let moduleDestroyed = false;
  if (moduleBudget > 0) {
    // Orden EXPLÍCITO por slot (comparación por código, sin locale): no depende del orden
    // de inserción del Map ni del orden del loadout.
    const candidates = [...target.modules.values()]
      .filter((m) => m.hp > 0 && m.spec.category !== "armor")
      .sort((a, b) => (a.spec.slot < b.spec.slot ? -1 : a.spec.slot > b.spec.slot ? 1 : 0));
    if (candidates.length > 0) {
      const weights = profile.moduleTargetWeights as Record<string, number | undefined> | undefined;
      const idx = rng.weighted(
        candidates.map((m) => Math.max(1, m.spec.massKg) * ((weights && safeLookup(weights, m.spec.category)) ?? 1)),
      );
      const m = candidates[idx];
      moduleDamage = Math.min(m.hp, moduleBudget);
      m.hp = Math.max(0, m.hp - moduleBudget);
      moduleSlot = m.spec.slot;
      moduleDestroyed = m.hp <= 0;
    }
  }

  const killed = target.hullHp <= 0 && target.alive;
  if (killed) target.alive = false;

  return {
    tick,
    target: target.id,
    owner: packet.owner,
    sourceKind: packet.sourceKind,
    type: packet.type,
    base: amount,
    penetration,
    sector,
    reduction,
    absorbed,
    effective,
    hull,
    moduleSlot,
    moduleDamage,
    moduleDestroyed,
    armorBroken,
    killed,
  };
}
