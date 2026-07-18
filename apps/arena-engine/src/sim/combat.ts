/**
 * Combate (T2.3): armas, proyectiles, minas, explosiones y daño.
 *
 * Modelo de daño = D6 del ADR-000, íntegramente:
 *   dañoEfectivo = max(DMG_MIN_FRACTION * base, base * (1 - reducciónBlindajeSector))
 *   reparto: 70 % al chasis, 30 % a un módulo del sector impactado (sorteo con el PRNG).
 * Sin penetración por ángulo, sin materiales, sin calor. El interés táctico está en
 * PERDER CAPACIDADES (quedar ciego, inmóvil o desarmado), no en una tabla de penetración.
 */
import {
  CHASSIS_DAMAGE_SHARE,
  DMG_MIN_FRACTION,
  MODULE_DAMAGE_SHARE,
  SECTORS,
  moduleActs,
  type Sector,
} from "../../../../packages/game-rules/index.js";
import type { Rng } from "../rng.js";
import type { PhysicsWorld, Vec2 } from "./physics.js";
import type { Vehicle } from "./vehicle.js";

export interface Projectile {
  id: string;
  ownerId: string;
  team: string;
  position: Vec2;
  velocity: Vec2;
  damage: number;
  explosionRadiusM: number;
  ttlTicks: number;
}

export interface Mine {
  id: string;
  ownerId: string;
  team: string;
  position: Vec2;
  damage: number;
  triggerRadiusM: number;
  explosionRadiusM: number;
  armedAtTick: number;
  expiresAtTick: number;
  detectable: boolean;
}

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

export interface DamageResult {
  sector: Sector;
  effectiveDamage: number;
  hullDamage: number;
  moduleSlot: string | null;
  moduleDamage: number;
  moduleDestroyed: boolean;
  killed: boolean;
}

/**
 * Aplica daño a un vehículo. Única puerta de entrada de daño en todo el motor:
 * proyectiles, minas, explosiones y zonas pasan por aquí.
 */
export function applyDamage(
  target: Vehicle,
  baseDamage: number,
  from: Vec2,
  targetPos: Vec2,
  targetHeading: number,
  rng: Rng,
): DamageResult {
  const sector = sectorOfImpact(targetHeading, from, targetPos);
  const armor = target.armor[sector];

  // El blindaje reduce, pero NUNCA anula: suelo del 10 % (D6).
  const reduction = armor && armor.hp > 0 ? armor.reduction : 0;
  const effective = Math.max(DMG_MIN_FRACTION * baseDamage, baseDamage * (1 - reduction));

  // El blindaje se desgasta con lo que absorbe.
  if (armor && armor.hp > 0) {
    armor.hp = Math.max(0, armor.hp - (baseDamage - effective));
  }

  const hullDamage = effective * CHASSIS_DAMAGE_SHARE;
  const moduleBudget = effective * MODULE_DAMAGE_SHARE;

  target.hullHp = Math.max(0, target.hullHp - hullDamage);

  // Reparto del 30 % a un módulo del sector: sorteo ponderado por masa (los módulos
  // grandes son más fáciles de acertar). Solo módulos aún no destruidos.
  const candidates = [...target.modules.values()].filter((m) => m.hp > 0 && m.spec.category !== "armor");
  let moduleSlot: string | null = null;
  let moduleDamage = 0;
  let moduleDestroyed = false;

  if (candidates.length > 0 && moduleBudget > 0) {
    const idx = rng.weighted(candidates.map((m) => Math.max(1, m.spec.massKg)));
    const m = candidates[idx];
    moduleDamage = Math.min(m.hp, moduleBudget);
    m.hp = Math.max(0, m.hp - moduleBudget);
    moduleSlot = m.spec.slot;
    moduleDestroyed = m.hp <= 0;
  }

  const killed = target.hullHp <= 0 && target.alive;
  if (killed) target.alive = false;

  return { sector, effectiveDamage: effective, hullDamage, moduleSlot, moduleDamage, moduleDestroyed, killed };
}

/**
 * ¿Puede este arma disparar ahora? Comprueba TODO lo que el bot no controla:
 * estado del módulo, cooldown, munición, energía y arco de torreta. El motor es
 * autoritativo: una orden de disparo es una intención, no un hecho.
 */
export type FireRejection =
  "module_destroyed" | "cooldown" | "no_ammo" | "no_energy" | "out_of_arc" | "critical_failure" | null;

export function canFire(v: Vehicle, slot: string, tick: number, rng: Rng): FireRejection {
  const w = v.modules.get(slot);
  if (!w || w.spec.category !== "weapon") return "module_destroyed";

  const state = v.stateOf(slot);
  if (state === "destroyed" || state === "offline") return "module_destroyed";
  if (!moduleActs(state, rng.next())) return "critical_failure";
  if (tick < w.cooldownUntilTick) return "cooldown";

  // Munición: la aporta el módulo de munición compatible montado.
  const ammo = ammoFor(v, w.spec.acceptsAmmo ?? []);
  if (!ammo || ammo.ammo <= 0) return "no_ammo";

  const cost = w.spec.perActionEU ?? 0;
  if (v.energyEU < cost) return "no_energy";

  // Arco de torreta: el ángulo de torreta ya está limitado por el motor, pero un
  // arco parcial puede dejar objetivos fuera. Se valida contra el morro del chasis.
  // v.heading lo mantiene el bucle desde la física (ERR-ENG-05: antes era un WeakMap
  // global de este módulo que devolvía 0 para vehículos aún no registrados).
  const arc = w.spec.turretArcRad ?? Math.PI * 2;
  if (arc < Math.PI * 2 - 1e-6) {
    let rel = v.turretHeading - v.heading;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    if (Math.abs(rel) > arc / 2) return "out_of_arc";
  }
  return null;
}

export function ammoFor(v: Vehicle, accepts: string[]) {
  for (const a of v.modulesOf("ammo")) {
    const base = a.spec.moduleId.split("@")[0];
    if (accepts.includes(base) && a.ammo > 0) return a;
  }
  // Si no hay compatible con munición, devolvemos el primero compatible aunque esté a 0
  for (const a of v.modulesOf("ammo")) {
    const base = a.spec.moduleId.split("@")[0];
    if (accepts.includes(base)) return a;
  }
  return null;
}

/** Crea el proyectil. Consume munición, energía y arranca el cooldown. */
export function fire(v: Vehicle, slot: string, tick: number, origin: Vec2, rng: Rng, seq: number): Projectile | null {
  const w = v.modules.get(slot)!;
  const ammo = ammoFor(v, w.spec.acceptsAmmo ?? []);
  if (!ammo) return null;

  ammo.ammo -= 1;
  v.spendEnergy(w.spec.perActionEU ?? 0);
  w.cooldownUntilTick = tick + Math.round((w.spec.cooldownTicks ?? 30) / Math.max(0.25, v.performanceOf(slot)));

  // Dispersión: RNG del motor, nunca Math.random.
  const spread = (w.spec.spreadRad ?? 0) * (rng.next() * 2 - 1);
  const angle = v.turretHeading + spread;
  const speed = w.spec.projectileSpeedMs ?? 100;

  const damage = (w.spec.damage ?? 10) * (ammo.spec.damageMultiplier ?? 1) * v.performanceOf(slot);

  return {
    id: `proj_${seq}`,
    ownerId: v.id,
    team: v.team,
    position: { ...origin },
    velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    damage,
    explosionRadiusM: ammo.spec.explosionRadiusM ?? 0,
    ttlTicks: 90,
  };
}

/**
 * Despliegue de mina (cap. 12.3): el SERVIDOR valida y crea la entidad.
 * El bot solo solicita. Motivos de rechazo tipificados.
 */
export type MineRejection =
  "module_destroyed" | "cooldown" | "no_charges" | "no_energy" | "invalid_position" | "limit_exceeded" | null;

export function canDeployMine(
  v: Vehicle,
  slot: string,
  tick: number,
  position: Vec2,
  physics: PhysicsWorld,
  activeMinesOfOwner: number,
  maxMinesPerVehicle: number,
): MineRejection {
  const m = v.modules.get(slot);
  if (!m || m.spec.category !== "mine") return "module_destroyed";
  const st = v.stateOf(slot);
  if (st === "destroyed" || st === "offline") return "module_destroyed";
  if (tick < m.cooldownUntilTick) return "cooldown";
  if (m.charges <= 0) return "no_charges";
  if (v.energyEU < (m.spec.perActionEU ?? 0)) return "no_energy";
  if (activeMinesOfOwner >= maxMinesPerVehicle) return "limit_exceeded";

  // Posición inválida: dentro de un muro o de un destructible.
  // OJO: un raycast NO sirve aquí — un rayo que nace dentro de un collider no lo
  // intersecta y devolvería "posición válida". Hace falta una consulta de punto.
  if (physics.isPointInsideSolid(position)) return "invalid_position";
  return null;
}

export function deployMine(
  v: Vehicle,
  slot: string,
  tick: number,
  position: Vec2,
  armDelayTicks: number,
  seq: number,
): Mine {
  const m = v.modules.get(slot)!;
  m.charges -= 1;
  v.spendEnergy(m.spec.perActionEU ?? 0);
  m.cooldownUntilTick = tick + (m.spec.cooldownTicks ?? 60);

  const delay = Math.max(m.spec.armDelayTicks ?? 0, armDelayTicks);
  return {
    id: `mine_${seq}`,
    ownerId: v.id,
    team: v.team,
    position: { ...position },
    damage: m.spec.damage ?? 60,
    triggerRadiusM: m.spec.triggerRadiusM ?? 2,
    explosionRadiusM: m.spec.explosionRadiusM ?? 4,
    armedAtTick: tick + delay,
    expiresAtTick: tick + (m.spec.lifetimeTicks ?? 5400),
    detectable: true,
  };
}

/** Caída de daño lineal con la distancia dentro del radio de explosión. */
export function explosionFalloff(distance: number, radius: number): number {
  if (radius <= 0) return distance <= 0.5 ? 1 : 0;
  if (distance >= radius) return 0;
  return 1 - distance / radius;
}

export { SECTORS };
