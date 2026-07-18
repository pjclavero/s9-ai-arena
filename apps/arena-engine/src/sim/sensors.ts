/**
 * Sensores y niebla de guerra (T2.4).
 *
 * REGLA DURA (D8): la OBSERVATION contiene EXCLUSIVAMENTE lo que los sensores
 * instalados y operativos de ese bot han percibido. Los datos no observables no
 * entran en el objeto, ni siquiera marcados como ocultos. No hay canal alternativo:
 * los eventos que se le envían aplican la misma regla.
 *
 * Este archivo es el único lugar del motor que construye observaciones. Si alguien
 * necesita meter un dato nuevo en una observación, tiene que pasar por aquí, y el
 * test de fuga (sensors-fog.test.ts) lo va a mirar con lupa.
 */
import { RADIO_MAX_MESSAGE_BYTES, moduleActs } from "../../../../packages/game-rules/index.js";
import type { Rng } from "../rng.js";
import type { PhysicsWorld, Vec2 } from "./physics.js";
import type { Vehicle } from "./vehicle.js";

export interface RadioMessage {
  from: string;
  team: string;
  data: string; // base64, opaco para el motor
  sentTick: number;
  deliverAtTick: number;
  to?: string;
}

export interface WorldView {
  vehicles: Vehicle[];
  poses: Map<string, { position: Vec2; heading: number; velocity: Vec2; angularVelocity: number }>;
  physics: PhysicsWorld;
  /** Sonidos generados este ciclo: disparos, explosiones, motores. */
  sounds: { position: Vec2; kind: "gunshot" | "engine" | "explosion"; intensity: number }[];
  mines: { id: string; position: Vec2; team: string; detectable: boolean }[];
}

/**
 * Construye la observación de UN bot. Todo lo que se añada aquí debe proceder de
 * un sensor suyo, o de su propio estado interno.
 */
export function buildObservation(
  v: Vehicle,
  tick: number,
  world: WorldView,
  inbox: RadioMessage[],
  score: Record<string, number>,
  objectives: any[],
  rng: Rng,
): any {
  const pose = world.poses.get(v.id)!;

  // ---- Estado propio. El bot SIEMPRE conoce su propio hardware, incluso roto:
  // saber que te has quedado ciego es información legítima y tácticamente esencial.
  const self: any = {
    position: round(pose.position),
    heading: r6(pose.heading),
    velocity: round(pose.velocity),
    angularVelocity: r6(pose.angularVelocity),
    turretHeading: r6(v.turretHeading),
    hullHp: r6(v.hullHp),
    hullHpMax: r6(v.spec.hullHp),
    energy: {
      storedEU: r6(v.energyEU),
      capacityEU: r6(v.energyCapacity()),
      netFlowEUs: r6(v.energyGeneration() - v.passiveDrain()),
    },
    modules: [...v.modules.values()].map((m) => ({
      slot: m.spec.slot,
      state: v.stateOf(m.spec.slot),
      healthFraction: r6(m.hp / m.spec.hp),
      ...(m.cooldownUntilTick > tick ? { cooldownTicks: m.cooldownUntilTick - tick } : {}),
      ...(m.spec.category === "ammo" ? { ammo: m.ammo } : {}),
      ...(m.spec.category === "mine" ? { ammo: m.charges } : {}),
    })),
    carryingFlag: v.carryingFlag,
  };

  const armorEntries = Object.entries(v.armor);
  if (armorEntries.length > 0) {
    self.armor = Object.fromEntries(armorEntries.map(([sec, a]) => [sec, r6(a!.hp / a!.hpMax)]));
  }
  if (!v.alive && v.respawnAtTick > tick) {
    self.respawningInTicks = v.respawnAtTick - tick;
  }

  const obs: any = { tick, self };

  // ---- Sensores. Un bloque por sensor INSTALADO Y OPERATIVO. Sin sensores, no hay
  // clave "sensors" en absoluto: la ausencia es la señal.
  const sensors: any = {};

  for (const s of v.activeModulesOf("sensor")) {
    const slot = s.spec.slot;
    const state = v.stateOf(slot);
    // Un sensor crítico falla intermitentemente: este ciclo puede no dar nada.
    if (!moduleActs(state, rng.next())) continue;
    const perf = v.performanceOf(slot);
    const range = (s.spec.rangeM ?? 0) * perf;

    switch (s.spec.sensorType) {
      case "lidar": {
        const fov = s.spec.fovRad ?? Math.PI / 2;
        const nRays = Math.max(1, Math.round((s.spec.rays ?? 16) * (perf < 1 ? 0.5 : 1)));
        const origin = pose.position;
        const rays: any[] = [];
        for (let i = 0; i < nRays; i++) {
          const t = nRays === 1 ? 0.5 : i / (nRays - 1);
          const a = pose.heading - fov / 2 + fov * t;
          const hit = world.physics.castRay(origin, a, range, v.id);
          rays.push({
            angle: r6(norm(a - pose.heading)),
            distanceM: r6(hit ? hit.distanceM : range),
            hit: hit ? hit.kind : "unknown",
          });
        }
        (sensors.lidar ??= []).push({
          slot,
          originHeading: r6(pose.heading),
          fovRad: r6(fov),
          rays,
        });
        break;
      }

      case "radar": {
        const contacts: any[] = [];
        const err = (s.spec.errorM ?? 2) / Math.max(0.25, perf);
        for (const other of world.vehicles) {
          if (other.id === v.id || !other.alive) continue;
          const op = world.poses.get(other.id)!;
          const d = dist(pose.position, op.position);
          if (d > range) continue;
          // El radar atraviesa... nada: los muros bloquean. Sin línea de visión, no hay contacto.
          if (!world.physics.hasLineOfSight(pose.position, op.position, v.id)) continue;

          // Posición con ERROR (D8): el radar no da coordenadas exactas.
          const ex = (rng.next() * 2 - 1) * err;
          const ey = (rng.next() * 2 - 1) * err;
          contacts.push({
            // El entityId solo se revela si el contacto es nítido (cerca). Lejos, es un eco.
            ...(d < range * 0.5 ? { entityId: other.id } : {}),
            kind: "vehicle",
            // El equipo se revela solo si es aliado (IFF): un enemigo no se identifica gratis.
            ...(other.team === v.team ? { team: other.team } : {}),
            position: round({ x: op.position.x + ex, y: op.position.y + ey }),
            velocity: round(op.velocity),
            errorM: r6(err),
            confidence: r6(Math.max(0, 1 - d / range)),
          });
        }
        (sensors.radar ??= []).push({ slot, contacts });
        break;
      }

      case "proximity": {
        const bearings: any[] = [];
        for (const other of world.vehicles) {
          if (other.id === v.id || !other.alive) continue;
          const op = world.poses.get(other.id)!;
          const d = dist(pose.position, op.position);
          if (d <= range) {
            bearings.push(r6(norm(Math.atan2(op.position.y - pose.position.y, op.position.x - pose.position.x))));
          }
        }
        for (const m of world.mines) {
          if (!m.detectable) continue;
          if (dist(pose.position, m.position) <= range) {
            bearings.push(r6(norm(Math.atan2(m.position.y - pose.position.y, m.position.x - pose.position.x))));
          }
        }
        (sensors.proximity ??= []).push({ slot, triggered: bearings.length > 0, bearings });
        break;
      }

      case "acoustic": {
        // Solo DIRECCIÓN, jamás posición (cap. 11). Un sonido no te dice dónde, te dice hacia dónde.
        const sources = world.sounds
          .filter((snd) => dist(pose.position, snd.position) <= range)
          .map((snd) => ({
            bearing: r6(norm(Math.atan2(snd.position.y - pose.position.y, snd.position.x - pose.position.x))),
            kind: snd.kind,
            intensity: r6(Math.max(0, 1 - dist(pose.position, snd.position) / range)),
          }));
        (sensors.acoustic ??= []).push({ slot, sources });
        break;
      }
    }
  }

  if (Object.keys(sensors).length > 0) obs.sensors = sensors;

  // ---- Radio: solo mensajes que le tocan y que ya deben entregarse.
  const radio = inbox
    .filter((m) => m.deliverAtTick <= tick && (!m.to || m.to === v.id) && m.from !== v.id)
    .map((m) => ({ from: m.from, data: m.data, sentTick: m.sentTick }));
  if (radio.length > 0) obs.radio = radio;

  // ---- Marcador y objetivos: información PÚBLICA por definición del modo.
  // No revela posiciones salvo las que son públicas (bases, zonas).
  if (Object.keys(score).length > 0) obs.score = score;
  if (objectives.length > 0) obs.objectives = objectives;

  return obs;
}

/** Valida un mensaje de radio antes de encolarlo (D8). Devuelve el motivo del rechazo o null. */
export function validateRadio(
  v: Vehicle,
  slot: string,
  dataB64: string,
  sentThisSecond: number,
): "no_radio" | "too_large" | "rate_limited" | null {
  const r = v.modules.get(slot);
  if (!r || r.spec.category !== "radio") return "no_radio";
  const st = v.stateOf(slot);
  if (st === "destroyed" || st === "offline") return "no_radio";

  const bytes = Buffer.from(dataB64, "base64").length;
  const max = Math.min(r.spec.maxMessageBytes ?? RADIO_MAX_MESSAGE_BYTES, RADIO_MAX_MESSAGE_BYTES);
  if (bytes > max) return "too_large";

  const rate = r.spec.maxMessagesPerSecond ?? 2;
  if (sentThisSecond >= rate) return "rate_limited";
  return null;
}

/** ¿Está el receptor dentro del alcance de la radio del emisor? */
export function radioReaches(sender: Vehicle, slot: string, from: Vec2, to: Vec2): boolean {
  const r = sender.modules.get(slot);
  if (!r) return false;
  const range = (r.spec.rangeM ?? 0) * sender.performanceOf(slot);
  return dist(from, to) <= range;
}

// ---------------------------------------------------------------- utilidades
function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function norm(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
/** Cuantización a 6 decimales: la observación es reproducible byte a byte entre plataformas. */
function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function round(v: Vec2): Vec2 {
  return { x: r6(v.x), y: r6(v.y) };
}
