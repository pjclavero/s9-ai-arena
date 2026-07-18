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

  constructor(teams: string[], participants?: { id: string; team: string }[]) {
    super(teams);
    // La premisa del modo es "cada vehículo es su propio equipo" y hay que FORZARLA
    // en construcción (ERR-ENG-07): con dos vehículos del mismo equipo, onKill filtra
    // por killerTeam !== victim.team y nadie puntúa nunca — una batalla de 5 minutos
    // condenada a tablas desde el tick 0, sin ningún error visible.
    if (participants) {
      const byTeam = new Map<string, string[]>();
      for (const p of participants) {
        if (!byTeam.has(p.team)) byTeam.set(p.team, []);
        byTeam.get(p.team)!.push(p.id);
      }
      const shared = [...byTeam.entries()].filter(([, ids]) => ids.length > 1);
      if (shared.length > 0) {
        const detail = shared.map(([t, ids]) => `${t}: ${ids.join(", ")}`).join(" · ");
        throw new Error(
          `deathmatch exige que cada vehículo sea su propio equipo; equipos compartidos → ${detail}. ` +
            `Usa team_deathmatch para jugar por equipos.`,
        );
      }
    }
  }

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
//
// También sirve de King of the Hill: KotH es exactamente este modo con UNA sola zona
// y puntuación por presencia (ruleset koth_mvp@1). No hay lógica duplicada.
export class ZoneControlMode extends BaseMode {
  readonly id = "zone_control";
  /**
   * Zonas de captura del mapa (id + posición). La posición de una zona de captura es
   * PÚBLICA por definición del modo —igual que una base—: por eso objectives() la revela.
   */
  private readonly zones: { id: string; position: Vec2 }[] = [];
  /** zoneId → equipo que la controla (o null). Propiedad, separada de la puntuación. */
  private control = new Map<string, string | null>();

  constructor(teams: string[], map: ArenaMap) {
    super(teams);
    for (const z of map.zones.filter((z) => z.kind === "capture")) {
      this.zones.push({ id: z.id, position: { ...z.position } });
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

      // PROPIEDAD y PUNTUACIÓN están separadas (ERR-ENG-03). Solo con UN equipo realmente
      // dentro se toma (o mantiene) la propiedad Y se puntúa. Con la zona VACÍA (size 0)
      // o DISPUTADA (size >= 2) NO puntúa nadie: la propiedad no basta, hace falta presencia
      // real. Así, "tocar la zona y marcharse" ya no gana la partida sin oposición.
      if (teamsInside.size === 1) {
        const owner = [...teamsInside][0];
        if (owner !== prev) {
          this.control.set(z.id, owner);
          ctx.emit({ kind: "zone_captured", team: owner, position: z.position });
        }
        this.score[owner] = (this.score[owner] ?? 0) + pts;
      }
    }
  }

  objectives(): any[] {
    // id + posición de CADA zona: un bot con más de una zona necesita ambos para decidir
    // a cuál ir. Nada de esto es privado: la posición de una zona de captura es pública
    // (como una base) y su dueño forma parte del marcador, también público.
    return this.zones.map((z) => {
      const team = this.control.get(z.id) ?? null;
      return {
        kind: "zone",
        id: z.id,
        team: team ?? "neutral",
        state: team ? "held" : "neutral",
        position: { ...z.position },
      };
    });
  }
}

// ------------------------------------------------- last man standing (R3.8)
//
// Eliminación: sin respawn (el registro lo EXIGE), gana la ronda el último equipo con
// vehículos vivos. El marcador de kills existe solo como desempate al agotarse el tiempo;
// scoreToWin NO termina la ronda. El nivel "match" (N rondas, semillas por rng.fork,
// cambio de lado) vive en el MatchRunner (src/match.ts), no aquí: una batalla = una ronda.
export class LastManStandingMode extends BaseMode {
  readonly id = "last_man_standing";

  tick(_ctx: ModeContext): void {}

  onKill(victim: Vehicle, killerTeam: string | null, ctx: ModeContext): void {
    if (killerTeam && killerTeam !== victim.team) {
      this.score[killerTeam] = (this.score[killerTeam] ?? 0) + 1;
      ctx.emit({ kind: "score_changed", team: killerTeam, score: { ...this.score } });
    }
  }

  winner(ctx: ModeContext): string | "draw" | null {
    // Vivos por equipo, en orden estable de equipos (this.teams está ordenado por el caller).
    const alive = new Map<string, number>();
    for (const t of this.teams) alive.set(t, 0);
    for (const v of ctx.vehicles) {
      if (v.alive && !v.disqualified) alive.set(v.team, (alive.get(v.team) ?? 0) + 1);
    }
    const standing = this.teams.filter((t) => (alive.get(t) ?? 0) > 0);
    if (standing.length === 1) return standing[0];
    if (standing.length === 0) return "draw";

    if (ctx.tick >= ctx.ruleset.timeLimitTicks) {
      // Desempate por metadatos del modo: más vivos; a igualdad, más kills; si no, empate.
      const sorted = [...standing].sort((a, b) => {
        const byAlive = (alive.get(b) ?? 0) - (alive.get(a) ?? 0);
        if (byAlive !== 0) return byAlive;
        return (this.score[b] ?? 0) - (this.score[a] ?? 0);
      });
      const [first, second] = sorted;
      if (
        second !== undefined &&
        (alive.get(first) ?? 0) === (alive.get(second) ?? 0) &&
        (this.score[first] ?? 0) === (this.score[second] ?? 0)
      ) {
        return "draw";
      }
      return first;
    }
    return null;
  }
}

// --------------------------------------------------------- domination (R3.8)
//
// Varias zonas PERMANENTES; el ritmo de puntuación es proporcional al nº de zonas en
// propiedad. Reutiliza la semántica de captura de zone_control corregido (ERR-ENG-03):
// tomar una zona exige ser el ÚNICO equipo dentro; vacía o disputada, no cambia de dueño.
// La diferencia deliberada con zone_control es que la PROPIEDAD persiste al marcharse y
// sigue puntuando: es la definición de Domination, no una regresión del fix (la puntuación
// aquí depende de la propiedad, y la propiedad solo se gana con presencia real).
export class DominationMode extends BaseMode {
  readonly id = "domination";
  private readonly zones: { id: string; position: Vec2; radiusM: number }[] = [];
  /** zoneId → equipo propietario (o null). Entra en el hash vía objectives(). */
  private control = new Map<string, string | null>();

  constructor(teams: string[], map: ArenaMap) {
    super(teams);
    for (const z of map.zones.filter((z) => z.kind === "capture")) {
      this.zones.push({ id: z.id, position: { ...z.position }, radiusM: z.radiusM });
      this.control.set(z.id, null);
    }
  }

  tick(ctx: ModeContext): void {
    const pts = ctx.ruleset.domination?.pointsPerTickPerZone ?? 1;

    // 1) Capturas: un único equipo dentro toma la propiedad.
    for (const z of this.zones) {
      const teamsInside = new Set<string>();
      for (const v of ctx.vehicles) {
        if (!v.alive || v.disqualified) continue;
        const p = ctx.poses.get(v.id);
        if (p && distance(p.position, z.position) <= z.radiusM) teamsInside.add(v.team);
      }
      if (teamsInside.size === 1) {
        const owner = [...teamsInside][0];
        if (owner !== this.control.get(z.id)) {
          this.control.set(z.id, owner);
          ctx.emit({ kind: "zone_captured", team: owner, position: z.position });
        }
      }
    }

    // 2) Puntuación por PROPIEDAD: pts × nº de zonas de cada equipo, cada tick.
    for (const t of this.teams) {
      let owned = 0;
      for (const z of this.zones) if (this.control.get(z.id) === t) owned++;
      if (owned > 0) this.score[t] = (this.score[t] ?? 0) + pts * owned;
    }
  }

  objectives(): any[] {
    return this.zones.map((z) => {
      const team = this.control.get(z.id) ?? null;
      return {
        kind: "zone",
        id: z.id,
        team: team ?? "neutral",
        state: team ? "held" : "neutral",
        position: { ...z.position },
      };
    });
  }
}

// --------------------------------------------------------- juggernaut (R3.8)
//
// Un vehículo MARCADO (campo Vehicle.juggernaut, al estilo carryingFlag) al que el resto
// puntúa destruir. Al caer el marcado, la marca rota al primer vehículo vivo (orden
// estable por id) del equipo que lo mató; sin autor (daño ambiental), al primer vivo.
// El marcado también puntúa por sus kills (pointsPerKillAsJuggernaut). Respawn obligatorio
// por metadatos: sin respawn el modo degenera en LMS con un objetivo pintado.
export class JuggernautMode extends BaseMode {
  readonly id = "juggernaut";

  tick(ctx: ModeContext): void {
    // Asignación inicial (y red de seguridad si la marca se pierde): primer vivo por id.
    // Es determinista: el orden de vehículos es estable y la elección no consume RNG.
    if (!ctx.vehicles.some((v) => v.juggernaut && v.alive && !v.disqualified)) {
      this.assign(this.aliveSorted(ctx)[0], ctx);
    }
    this.refreshObjective(ctx);
  }

  private aliveSorted(ctx: ModeContext): Vehicle[] {
    return ctx.vehicles.filter((v) => v.alive && !v.disqualified).sort((a, b) => a.id.localeCompare(b.id));
  }

  private assign(next: Vehicle | undefined, ctx: ModeContext): void {
    for (const v of ctx.vehicles) v.juggernaut = false;
    if (!next) return;
    next.juggernaut = true;
    ctx.emit({ kind: "juggernaut_assigned", targetId: next.id, team: next.team });
  }

  onKill(victim: Vehicle, killerTeam: string | null, ctx: ModeContext): void {
    const rules = ctx.ruleset.juggernaut ?? { pointsPerJuggernautKill: 3, pointsPerKillAsJuggernaut: 1 };

    if (victim.juggernaut) {
      victim.juggernaut = false;
      if (killerTeam && killerTeam !== victim.team) {
        this.score[killerTeam] = (this.score[killerTeam] ?? 0) + rules.pointsPerJuggernautKill;
        ctx.emit({ kind: "juggernaut_down", targetId: victim.id, team: killerTeam, score: { ...this.score } });
      }
      const pool = this.aliveSorted(ctx);
      this.assign(pool.find((v) => v.team === killerTeam) ?? pool[0], ctx);
      this.refreshObjective(ctx);
      return;
    }

    // Kill de un no-marcado: solo puntúa si la hizo el EQUIPO del marcado vivo.
    const jug = ctx.vehicles.find((v) => v.juggernaut && v.alive && !v.disqualified);
    if (jug && killerTeam === jug.team && killerTeam !== victim.team) {
      this.score[killerTeam] = (this.score[killerTeam] ?? 0) + rules.pointsPerKillAsJuggernaut;
      ctx.emit({ kind: "score_changed", team: killerTeam, score: { ...this.score } });
    }
  }

  objectives(): any[] {
    // El marcado es información PÚBLICA (quién es, no dónde está): sin esto el modo no
    // se puede jugar. La posición sigue exigiendo sensores, como una bandera transportada.
    return this.jugObjective ? [this.jugObjective] : [];
  }

  /** Cache del objetivo publicado; lo refrescan tick() y onKill() (tras reasignar). */
  private jugObjective: any = null;

  /** Refresca el objetivo público con el marcado vivo actual. */
  private refreshObjective(ctx: ModeContext): void {
    const jug = ctx.vehicles.find((v) => v.juggernaut && v.alive && !v.disqualified);
    this.jugObjective = jug ? { kind: "juggernaut", id: jug.id, team: jug.team, state: "held" } : null;
  }
}

// ------------------------------------------------- registro de modos (R3.8)
//
// METADATOS por modo: qué necesita del mapa, equipos mín/máx, política de respawn y
// desempate. createMode los aplica SIEMPRE: una combinación mapa/modo incompatible no
// crea la batalla (falla cerrado), en vez de degenerar en una partida imposible de ganar.
export interface ModeMetadata {
  id: string;
  minTeams: number;
  maxTeams: number;
  /** required = el ruleset debe traer respawn activado; forbidden = debe traerlo apagado. */
  respawn: "required" | "forbidden" | "any";
  /** Requisitos del mapa. flagsAndBases = una bandera Y una base por equipo. */
  requires: { flagsAndBases?: boolean; captureZones?: number };
  /** Desempate al agotar el tiempo. */
  tiebreak: "draw" | "most_score" | "most_alive_then_kills";
}

export const MODE_REGISTRY: Record<string, ModeMetadata> = {
  // minTeams: 1 en dm/tdm por compatibilidad: el motor admite batallas de un solo
  // equipo (entrenamiento, slalom golden, tests de radio) desde T2.1 y el registro
  // no puede romperlas. Los modos nuevos sí exigen 2 equipos: sin rival no hay modo.
  deathmatch: {
    id: "deathmatch",
    minTeams: 1,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "any",
    requires: {},
    tiebreak: "most_score",
  },
  team_deathmatch: {
    id: "team_deathmatch",
    minTeams: 1,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "any",
    requires: {},
    tiebreak: "most_score",
  },
  capture_the_flag: {
    id: "capture_the_flag",
    minTeams: 2,
    maxTeams: 2,
    respawn: "any",
    requires: { flagsAndBases: true },
    tiebreak: "most_score",
  },
  zone_control: {
    id: "zone_control",
    minTeams: 2,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "any",
    requires: { captureZones: 1 },
    tiebreak: "most_score",
  },
  last_man_standing: {
    id: "last_man_standing",
    minTeams: 2,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "forbidden",
    requires: {},
    tiebreak: "most_alive_then_kills",
  },
  domination: {
    id: "domination",
    minTeams: 2,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "any",
    requires: { captureZones: 2 },
    tiebreak: "most_score",
  },
  juggernaut: {
    id: "juggernaut",
    minTeams: 2,
    maxTeams: Number.POSITIVE_INFINITY,
    respawn: "required",
    requires: {},
    tiebreak: "most_score",
  },
};

/** Incompatibilidades mapa/modo/ruleset. Lista vacía = combinación válida. */
export function modeMapIncompatibilities(ruleset: Ruleset, teams: string[], map: ArenaMap): string[] {
  const meta = MODE_REGISTRY[ruleset.mode];
  if (!meta) return [`modo desconocido: ${ruleset.mode}`];
  const errs: string[] = [];

  if (teams.length < meta.minTeams) errs.push(`equipos insuficientes: ${teams.length} < ${meta.minTeams}`);
  if (teams.length > meta.maxTeams) errs.push(`demasiados equipos: ${teams.length} > ${meta.maxTeams}`);

  if (meta.respawn === "required" && !ruleset.respawn.enabled) {
    errs.push(`el modo ${meta.id} exige respawn activado en el ruleset`);
  }
  if (meta.respawn === "forbidden" && ruleset.respawn.enabled) {
    errs.push(`el modo ${meta.id} exige respawn DESACTIVADO en el ruleset`);
  }

  if (meta.requires.flagsAndBases) {
    for (const t of teams) {
      if (!map.flags.some((f) => f.team === t)) errs.push(`el mapa ${map.mapId} no tiene bandera para el equipo ${t}`);
      if (!map.bases.some((b) => b.team === t)) errs.push(`el mapa ${map.mapId} no tiene base para el equipo ${t}`);
    }
  }
  const captureZones = map.zones.filter((z) => z.kind === "capture").length;
  if ((meta.requires.captureZones ?? 0) > captureZones) {
    errs.push(
      `el mapa ${map.mapId} tiene ${captureZones} zona(s) de captura y el modo ${meta.id} exige ${meta.requires.captureZones}`,
    );
  }
  return errs;
}

// ---------------------------------------------------------------------------
export function createMode(
  ruleset: Ruleset,
  teams: string[],
  map: ArenaMap,
  /** Lista completa de participantes: permite al modo rechazar configuraciones inválidas. */
  participants?: { id: string; team: string }[],
): GameMode {
  const problems = modeMapIncompatibilities(ruleset, teams, map);
  if (problems.length > 0) {
    throw new Error(`Combinación mapa/modo incompatible (${map.mapId} / ${ruleset.mode}): ${problems.join("; ")}`);
  }
  switch (ruleset.mode) {
    case "deathmatch":
      return new DeathmatchMode(teams, participants);
    case "team_deathmatch":
      return new TeamDeathmatchMode(teams);
    case "capture_the_flag":
      return new CaptureTheFlagMode(teams, map);
    case "zone_control":
      return new ZoneControlMode(teams, map);
    case "last_man_standing":
      return new LastManStandingMode(teams);
    case "domination":
      return new DominationMode(teams, map);
    case "juggernaut":
      return new JuggernautMode(teams);
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
