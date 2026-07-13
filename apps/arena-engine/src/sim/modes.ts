/**
 * Modos de juego (T2.5). Motor de reglas conectable: GameMode con hooks en los pasos
 * 5–6 del bucle. Las condiciones de victoria, límites y respawn se leen del RULESET,
 * nunca están cableadas aquí.
 */
import type { Ruleset } from "../../../../packages/game-rules/index.js";
import type { Vec2 } from "./physics.js";
import type { Vehicle } from "./vehicle.js";

export interface ModeContext {
  tick: number;
  ruleset: Ruleset;
  vehicles: Vehicle[];
  poses: Map<string, { position: Vec2; heading: number; velocity: Vec2; angularVelocity: number }>;
  map: ArenaMap;
  emit: (ev: any) => void;
}

export interface ArenaMap {
  mapId: string;
  version: number;
  checksum: string;
  widthM: number;
  heightM: number;
  walls: { id: string; position: Vec2; halfW: number; halfH: number; rotation?: number }[];
  destructibles: { id: string; position: Vec2; halfW: number; halfH: number; hp: number }[];
  spawns: { team: string; position: Vec2; heading: number }[];
  bases: { team: string; position: Vec2; radiusM: number }[];
  flags: { team: string; position: Vec2 }[];
  zones: { id: string; position: Vec2; radiusM: number; kind: "damage" | "capture"; damagePerSecond?: number }[];
}

/** Estados de bandera del capítulo 13.1. La FSM completa, sin atajos. */
export type FlagState = "at_base" | "carried" | "dropped" | "returning" | "captured";

export interface FlagRuntime {
  team: string;
  state: FlagState;
  position: Vec2;
  basePosition: Vec2;
  carrierId: string | null;
  droppedAtTick: number;
}

export interface GameMode {
  readonly id: string;
  /** Puntuación pública por equipo. */
  score: Record<string, number>;
  /** Se ejecuta en el paso 6 del bucle, tras resolver el combate. */
  tick(ctx: ModeContext): void;
  /** Objetivos visibles públicamente (van en la observación de todos). */
  objectives(): any[];
  /** ¿Ha terminado? Devuelve el ganador o "draw". */
  winner(ctx: ModeContext): string | "draw" | null;
  /** Un vehículo ha muerto: el modo decide qué implica. */
  onKill?(victim: Vehicle, killerTeam: string | null, ctx: ModeContext): void;
  /** Punto de reaparición. */
  spawnFor(v: Vehicle, ctx: ModeContext): Vec2;
}

// ---------------------------------------------------------------------------
abstract class BaseMode implements GameMode {
  abstract readonly id: string;
  score: Record<string, number> = {};

  constructor(protected teams: string[]) {
    for (const t of teams) this.score[t] = 0;
  }

  abstract tick(ctx: ModeContext): void;
  objectives(): any[] {
    return [];
  }

  winner(ctx: ModeContext): string | "draw" | null {
    for (const [team, pts] of Object.entries(this.score)) {
      if (pts >= ctx.ruleset.scoreToWin) return team;
    }
    if (ctx.tick >= ctx.ruleset.timeLimitTicks) {
      const sorted = Object.entries(this.score).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return "draw";
      return sorted[0]?.[0] ?? "draw";
    }
    // Si el respawn está desactivado y solo queda un equipo con vivos, ese gana.
    if (!ctx.ruleset.respawn.enabled) {
      const alive = new Set(ctx.vehicles.filter((v) => v.alive && !v.disqualified).map((v) => v.team));
      if (alive.size === 1) return [...alive][0];
      if (alive.size === 0) return "draw";
    }
    return null;
  }

  spawnFor(v: Vehicle, ctx: ModeContext): Vec2 {
    const own = ctx.map.spawns.filter((s) => s.team === v.team);
    const pool = own.length > 0 ? own : ctx.map.spawns;
    // Determinista: el índice depende del id del vehículo, no de aleatoriedad.
    const idx = hashId(v.id) % pool.length;
    return { ...pool[idx].position };
  }
}

// ---------------------------------------------------------------- deathmatch
export class DeathmatchMode extends BaseMode {
  readonly id = "deathmatch";

  tick(_ctx: ModeContext): void {
    // Toda la puntuación ocurre en onKill.
  }

  onKill(victim: Vehicle, killerTeam: string | null, ctx: ModeContext): void {
    // En DM cada vehículo es su propio "equipo".
    if (killerTeam && killerTeam !== victim.team) {
      this.score[killerTeam] = (this.score[killerTeam] ?? 0) + 1;
      ctx.emit({ kind: "score_changed", team: killerTeam, score: { ...this.score } });
    }
  }
}

// ----------------------------------------------------------- team deathmatch
export class TeamDeathmatchMode extends BaseMode {
  readonly id = "team_deathmatch";

  tick(_ctx: ModeContext): void {}

  onKill(victim: Vehicle, killerTeam: string | null, ctx: ModeContext): void {
    if (!killerTeam) return;
    // Fuego amigo: si está activo y matas a un compañero, PUNTÚA EL RIVAL. Si está
    // desactivado, este caso no puede ocurrir (el daño se filtra antes).
    if (killerTeam === victim.team) {
      for (const t of this.teams) {
        if (t !== victim.team) this.score[t] = (this.score[t] ?? 0) + 1;
      }
    } else {
      this.score[killerTeam] = (this.score[killerTeam] ?? 0) + 1;
    }
    ctx.emit({ kind: "score_changed", team: killerTeam, score: { ...this.score } });
  }
}

// -------------------------------------------------------- capture the flag
export class CaptureTheFlagMode extends BaseMode {
  readonly id = "capture_the_flag";
  flags = new Map<string, FlagRuntime>();

  constructor(teams: string[], map: ArenaMap) {
    super(teams);
    for (const f of map.flags) {
      this.flags.set(f.team, {
        team: f.team,
        state: "at_base",
        position: { ...f.position },
        basePosition: { ...f.position },
        carrierId: null,
        droppedAtTick: 0,
      });
    }
  }

  tick(ctx: ModeContext): void {
    const rules = ctx.ruleset.ctf!;

    for (const flag of this.flags.values()) {
      // --- carried: la bandera sigue al portador
      if (flag.state === "carried") {
        const carrier = ctx.vehicles.find((v) => v.id === flag.carrierId);
        const pose = carrier ? ctx.poses.get(carrier.id) : null;

        // El portador murió o fue descalificado ⇒ la bandera CAE donde estaba.
        if (!carrier || !carrier.alive || carrier.disqualified) {
          flag.state = "dropped";
          flag.carrierId = null;
          flag.droppedAtTick = ctx.tick;
          ctx.emit({ kind: "flag_dropped", team: flag.team, position: flag.position });
          continue;
        }
        if (pose) flag.position = { ...pose.position };

        // ¿Ha llegado a su base con la bandera enemiga? → intento de captura.
        const homeBase = ctx.map.bases.find((b) => b.team === carrier.team);
        if (homeBase && distance(flag.position, homeBase.position) <= homeBase.radiusM) {
          const ownFlag = this.flags.get(carrier.team);
          // Regla configurable: ¿hace falta la bandera propia en base para capturar?
          if (rules.requireOwnFlagAtBase && ownFlag && ownFlag.state !== "at_base") {
            continue; // no puede capturar todavía; la bandera se queda con él
          }
          flag.state = "captured";
          flag.carrierId = null;
          carrier.carryingFlag = null;
          this.score[carrier.team] = (this.score[carrier.team] ?? 0) + 1;
          ctx.emit({
            kind: "flag_captured",
            team: carrier.team,
            score: { ...this.score },
          });
          // Tras capturar, la bandera vuelve a su base y queda de nuevo en juego.
          flag.state = "at_base";
          flag.position = { ...flag.basePosition };
        }
        continue;
      }

      // --- dropped: cuenta atrás de retorno automático
      if (flag.state === "dropped") {
        if (ctx.tick - flag.droppedAtTick >= rules.flagReturnTicks) {
          flag.state = "returning";
          ctx.emit({ kind: "flag_returned", team: flag.team });
          continue;
        }
      }

      // --- returning: vuelve a base (instantáneo en el MVP) y pasa a at_base
      if (flag.state === "returning") {
        flag.position = { ...flag.basePosition };
        flag.state = "at_base";
        continue;
      }

      // --- at_base / dropped: alguien puede recogerla o devolverla al tocarla
      for (const v of ctx.vehicles) {
        if (!v.alive || v.disqualified || v.carryingFlag) continue;
        const pose = ctx.poses.get(v.id);
        if (!pose) continue;
        if (distance(pose.position, flag.position) > 2.0) continue;

        if (v.team === flag.team) {
          // Toco MI bandera: si está caída, la devuelvo a base. Si está en base, nada.
          if (flag.state === "dropped") {
            flag.state = "at_base";
            flag.position = { ...flag.basePosition };
            ctx.emit({ kind: "flag_returned", team: flag.team });
          }
        } else {
          // Toco la bandera ENEMIGA: me la llevo.
          flag.state = "carried";
          flag.carrierId = v.id;
          v.carryingFlag = flag.team;
          ctx.emit({ kind: "flag_taken", team: flag.team, sourceId: v.id });
          break;
        }
      }
    }
  }

  onKill(victim: Vehicle, _killerTeam: string | null, ctx: ModeContext): void {
    // El drop lo gestiona tick() al detectar que el portador ha muerto; así hay
    // un único camino de código para "la bandera cae" y no dos que puedan divergir.
    void victim;
    void ctx;
  }

  objectives(): any[] {
    return [...this.flags.values()].map((f) => ({
      kind: "flag",
      team: f.team,
      state: f.state,
      // La posición de la bandera solo es pública si está EN BASE (todos saben dónde
      // está una base). Si la lleva alguien o está caída en campo abierto, hay que verla.
      ...(f.state === "at_base" ? { position: f.position } : {}),
    }));
  }
}

// ------------------------------------------------------------- zone control
export class ZoneControlMode extends BaseMode {
  readonly id = "zone_control";
  /** zoneId → equipo que la controla (o null). */
  private control = new Map<string, string | null>();

  constructor(teams: string[], map: ArenaMap) {
    super(teams);
    for (const z of map.zones.filter((z) => z.kind === "capture")) {
      this.control.set(z.id, null);
    }
  }

  tick(ctx: ModeContext): void {
    const pts = ctx.ruleset.zone?.pointsPerTickHeld ?? 1;

    for (const z of ctx.map.zones) {
      if (z.kind !== "capture") continue;

      const inside = ctx.vehicles.filter((v) => {
        if (!v.alive || v.disqualified) return false;
        const p = ctx.poses.get(v.id);
        return p ? distance(p.position, z.position) <= z.radiusM : false;
      });

      const teamsInside = new Set(inside.map((v) => v.team));
      const prev = this.control.get(z.id) ?? null;

      // Una zona disputada (dos equipos dentro) no puntúa a nadie y no cambia de dueño.
      if (teamsInside.size === 1) {
        const owner = [...teamsInside][0];
        if (owner !== prev) {
          this.control.set(z.id, owner);
          ctx.emit({ kind: "zone_captured", team: owner, position: z.position });
        }
      }

      // Puntuación continua: quien la controla suma cada tick, aunque salga
      // (la zona sigue siendo suya hasta que otro la tome).
      const owner = this.control.get(z.id);
      if (owner && teamsInside.size <= 1) {
        this.score[owner] = (this.score[owner] ?? 0) + pts;
      }
    }
  }

  objectives(): any[] {
    return [...this.control.entries()].map(([id, team]) => ({
      kind: "zone",
      team: team ?? "neutral",
      state: team ? "held" : "neutral",
    }));
  }
}

// ---------------------------------------------------------------------------
export function createMode(ruleset: Ruleset, teams: string[], map: ArenaMap): GameMode {
  switch (ruleset.mode) {
    case "deathmatch":
      return new DeathmatchMode(teams);
    case "team_deathmatch":
      return new TeamDeathmatchMode(teams);
    case "capture_the_flag":
      return new CaptureTheFlagMode(teams, map);
    case "zone_control":
      return new ZoneControlMode(teams, map);
    default:
      throw new Error(`Modo desconocido: ${(ruleset as any).mode}`);
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
