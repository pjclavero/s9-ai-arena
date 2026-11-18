/**
 * Combate (T2.3): armas, proyectiles, minas, explosiones y daño.
 *
 * Modelo de daño = D6 del ADR-000, ahora como contrato explícito por datos
 * (packages/game-rules/damage-contract.ts) y resuelto en UNA puerta (./damage.ts):
 *   dañoEfectivo = max(minFraction * base, base * (1 - reducción))
 *   reparto: hullShare al chasis, moduleShare a UN módulo vivo no-blindaje del vehículo
 *   (sorteo ponderado por masa con el PRNG; no se restringe al sector).
 * Sin variación aleatoria del importe (D-B3). El interés táctico está en PERDER
 * CAPACIDADES (quedar ciego, inmóvil o desarmado), no en una tabla de penetración.
 */
import { SECTORS, moduleActs, type Sector } from "../../../../packages/game-rules/index.js";
import { projectileLifetimeTicks } from "../../../../packages/module-catalog/resolve/projectile.js";
import type { Rng } from "../rng.js";
import type { PhysicsWorld, Vec2 } from "./physics.js";
import type { ModuleSpec, Vehicle } from "./vehicle.js";
import { resolveDamage } from "./damage.js";
import { DEFAULT_DIRECT_DAMAGE_TYPE } from "../../../../packages/game-rules/damage-contract.js";

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

// La puerta única de daño de vehículo es `resolveDamage()` (./damage.ts, OLA 2 · MB).
export { sectorOfImpact } from "./damage.js";

/** Forma histórica del resultado de `applyDamage` (la usan tests de caracterización). */
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
 * Envoltura de COMPATIBILIDAD: un impacto cinético directo por la puerta única. No es un
 * segundo camino de daño (delega en resolveDamage); existe para que la caracterización
 * histórica (tabla D6) siga ejecutándose con la misma firma.
 */
export function applyDamage(
  target: Vehicle,
  baseDamage: number,
  from: Vec2,
  targetPos: Vec2,
  targetHeading: number,
  rng: Rng,
): DamageResult {
  const r = resolveDamage(
    {
      amount: baseDamage,
      type: DEFAULT_DIRECT_DAMAGE_TYPE,
      penetration: 0,
      from,
      owner: null,
      ownerTeam: null,
      sourceKind: "projectile",
      seq: 0,
    },
    target,
    { position: targetPos, heading: targetHeading },
    rng,
    0,
  );
  return {
    sector: r.sector as Sector,
    effectiveDamage: r.effective,
    hullDamage: r.hull,
    moduleSlot: r.moduleSlot,
    moduleDamage: r.moduleDamage,
    moduleDestroyed: r.moduleDestroyed,
    killed: r.killed,
  };
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

  // Arco de torreta (D-B2): es de la MONTURA de la ranura, no del arma. El giro ya lo
  // limita Vehicle.stepTurret() al arco más restrictivo; esto es la red de seguridad por
  // arma (una montura más estrecha que la torreta no dispara fuera de la suya).
  // v.heading lo mantiene el bucle desde la física (ERR-ENG-05: antes era un WeakMap
  // global de este módulo que devolvía 0 para vehículos aún no registrados).
  const arc = v.mountArcOf(slot);
  if (arc < Math.PI * 2 - 1e-6) {
    let rel = v.turretHeading - v.heading;
    while (rel > Math.PI) rel -= 2 * Math.PI;
    while (rel < -Math.PI) rel += 2 * Math.PI;
    // Tolerancia de redondeo: la torreta limitada queda EXACTAMENTE en el borde del arco.
    if (Math.abs(rel) > arc / 2 + 1e-9) return "out_of_arc";
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

/** Vida del proyectil de un spec de arma: derivada de rangeM y velocidad; incoherente = lanza. */
export function projectileLifetimeOf(spec: ModuleSpec): number {
  if (spec.rangeM === undefined || spec.projectileSpeedMs === undefined) {
    throw new Error(`${spec.moduleId}: arma sin rangeM o projectileSpeedMs (no se puede derivar el alcance)`);
  }
  const ttl = projectileLifetimeTicks(spec.rangeM, spec.projectileSpeedMs);
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new Error(`${spec.moduleId}: vida de proyectil inválida (${ttl})`);
  }
  if (spec.projectileLifetimeTicks !== undefined && spec.projectileLifetimeTicks !== ttl) {
    throw new Error(
      `${spec.moduleId}: projectileLifetimeTicks=${spec.projectileLifetimeTicks} incoherente con rangeM/velocidad (${ttl})`,
    );
  }
  return ttl;
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

  // P-2 · UNA sola regla de alcance: la vida del proyectil se deriva SIEMPRE de rangeM y de la
  // velocidad del propio spec (la misma función que usa resolveVehicle). No hay regla heredada
  // de 90 ticks. Un spec sin rangeM/velocidad, o cuyo projectileLifetimeTicks (derivado)
  // discrepa, es incoherente: falla, no se impone en silencio.
  const ttlTicks = projectileLifetimeOf(w.spec);

  return {
    id: `proj_${seq}`,
    ownerId: v.id,
    team: v.team,
    position: { ...origin },
    velocity: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    damage,
    explosionRadiusM: ammo.spec.explosionRadiusM ?? 0,
    ttlTicks,
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
