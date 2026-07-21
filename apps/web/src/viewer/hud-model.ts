/**
 * R3.6 · MEJ-gráficos — VIEWMODEL puro del HUD del visor.
 *
 * El overlay del visor (OverlayState) YA mantiene el estado público que llega por
 * red: marcador, vida y módulos por vehículo, banderas, portadores, zonas, feed y
 * el resultado de fin de partida. R3.6 NO inventa campos de red: DERIVA de ese
 * estado, de forma pura y determinista, el modelo que el HUD dibuja —
 *   marcador superior, reloj + fase, objetivo actual, panel de bots por equipo con
 *   vida y módulos, kill feed, estado de banderas y control de zonas, y el
 *   indicador de fin de partida.
 *
 * Al ser puro (sin Phaser ni DOM) se prueba con vitest en Node contra un snapshot
 * conocido (DoD R3.6: "el HUD refleja marcador, vida y estado de objetivos en
 * vivo"). Tanto el visor interactivo como /broadcast consumen ESTE mismo modelo,
 * de modo que el HUD es idéntico y legible en ambos.
 */
import type { FeedItem, OverlayState, VehicleOverlay } from "./overlay.js";
import { damageVisualFor } from "./damage-visuals.js";
import { vehicleLabel, type ViewerRoster } from "./art-direction.js";
import { tickToMs } from "./replay-player.js";

/** Fase de la partida, derivada del estado (sin campo de red dedicado). */
export type MatchPhase = "inicio" | "en_juego" | "final";

/** Una fila del marcador superior (un equipo). */
export interface HudScoreEntry {
  team: string;
  points: number;
  /** ¿Va en cabeza? (empate ⇒ varios líderes). */
  leading: boolean;
}

/** Reloj + fase del HUD. */
export interface HudClock {
  tick: number;
  timeMs: number;
  /** "m:ss" del eje de partida (mismo eje que el replay/directo). */
  label: string;
  phase: MatchPhase;
}

/** Objetivo ACTUAL: qué se está jugando, resumido para el HUD. */
export interface HudObjective {
  /** Modo inferido de los objetivos públicos presentes. */
  mode: "ctf" | "zones" | "juggernaut" | "deathmatch";
  /** Texto legible del objetivo (p.ej. "Captura la bandera"). */
  text: string;
}

/** Un bot en el panel de equipo, con vida y módulos derivados del snapshot. */
export interface HudBot {
  id: string;
  /** Nombre del bot (nunca el UUID): de la nómina, o forma corta del id. */
  name: string;
  team: string;
  alive: boolean;
  hullHp: number;
  hullHpMax: number;
  /** Fracción de casco 0..1. */
  hpRatio: number;
  /** Porcentaje entero 0..100 para el HUD. */
  hpPercent: number;
  /** ¿Lleva bandera? (team de la bandera que porta, o null). */
  carryingFlag: string | null;
  /** Nº de módulos y cuántos están fuera de combate (destruido/offline). */
  modulesTotal: number;
  modulesDown: number;
  /** Arma inutilizada / blindaje roto / movilidad tocada (para iconos del HUD). */
  turretLocked: boolean;
  armorBroken: boolean;
  mobilityCrippled: boolean;
}

/**
 * R16.3 · panel táctico — resumen por equipo, derivado ÍNTEGRAMENTE de los
 * `HudBot` ya calculados (a su vez derivados de `VehicleOverlay`, sin campos
 * de red nuevos):
 *  - botsAlive/botsTotal: recuento de vivos vs. plantilla del equipo.
 *  - hpPercent: media del `hpRatio` de los bots VIVOS, redondeada a entero
 *    (0 si no queda ninguno vivo).
 *  - modulesOffline: suma de `modulesDown` de todos los bots del equipo.
 * Fuera de alcance (R16.3, no este bloque): daño infligido / precisión no
 * están en OverlayState hoy; un slice futuro que los quiera debe extender el
 * snapshot público (decisión de contrato, no de este bloque).
 */
export interface HudTeamTactical {
  botsAlive: number;
  botsTotal: number;
  /** Media del hpRatio de los bots vivos, en % entero 0..100 (0 si no queda ninguno). */
  hpPercent: number;
  /** Suma de módulos caídos (destruidos/offline) de todo el equipo. */
  modulesOffline: number;
}

/** Panel de un equipo: puntuación y sus bots. */
export interface HudTeamPanel {
  team: string;
  points: number;
  bots: HudBot[];
  /** Nº de bots vivos del equipo. */
  aliveCount: number;
  /** Resumen táctico del equipo (R16.3), derivado de `bots`. */
  tactical: HudTeamTactical;
}

/** Deriva el resumen táctico de un equipo a partir de sus bots ya calculados. */
function buildTactical(bots: HudBot[]): HudTeamTactical {
  const alive = bots.filter((b) => b.alive);
  const hpPercent =
    alive.length > 0 ? Math.round((alive.reduce((sum, b) => sum + b.hpRatio, 0) / alive.length) * 100) : 0;
  const modulesOffline = bots.reduce((sum, b) => sum + b.modulesDown, 0);
  return { botsAlive: alive.length, botsTotal: bots.length, hpPercent, modulesOffline };
}

/** Estado de una bandera para el HUD. */
export interface HudFlag {
  team: string;
  state: string;
  carrierId: string | null;
}

/** Control de una zona para el HUD. */
export interface HudZone {
  id: string;
  team: string;
  state: string;
}

/** Una entrada del kill feed (derivada de vehicle_destroyed del feed público). */
export interface HudKill {
  tick: number;
  text: string;
}

/** Indicador de fin de partida (lo que se anuncia sobre el canvas). */
export interface HudMatchEnd {
  winner: string | null;
  score: Record<string, number>;
  reason: string | null;
  /** Texto grande del anuncio ("Gana rojo" / "Empate"). */
  headline: string;
}

/** Modelo completo del HUD, derivado del overlay público. */
export interface HudModel {
  score: HudScoreEntry[];
  clock: HudClock;
  objective: HudObjective;
  teams: HudTeamPanel[];
  flags: HudFlag[];
  zones: HudZone[];
  killFeed: HudKill[];
  /** null mientras la batalla sigue viva. */
  matchEnd: HudMatchEnd | null;
}

export interface HudModelOptions {
  /** Nómina pública para resolver nombres de bot (opcional). */
  roster?: ViewerRoster | null;
  /** Máximo de entradas del kill feed a mostrar (por defecto 6). */
  killFeedLimit?: number;
}

const DEFAULT_KILL_FEED = 6;

function mmss(timeMs: number): string {
  const totalSec = Math.max(0, Math.floor(timeMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Marcador ORDENADO por puntos desc y luego por nombre de equipo (estable). */
function buildScore(score: Record<string, number>): HudScoreEntry[] {
  const entries = Object.entries(score).map(([team, points]) => ({ team, points: Number(points) || 0 }));
  entries.sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
  const max = entries.reduce((m, e) => Math.max(m, e.points), Number.NEGATIVE_INFINITY);
  return entries.map((e) => ({ ...e, leading: entries.length > 0 && e.points === max && e.points > 0 }));
}

/** Modo/objetivo inferido de los objetivos públicos presentes. */
function buildObjective(objectives: any): HudObjective {
  const list: any[] = Array.isArray(objectives) ? objectives : [];
  const kinds = new Set(list.map((o) => (o && typeof o === "object" ? o.kind : undefined)));
  if (kinds.has("flag")) return { mode: "ctf", text: "Captura la bandera" };
  if (kinds.has("zone")) return { mode: "zones", text: "Controla las zonas" };
  if (kinds.has("juggernaut")) return { mode: "juggernaut", text: "Abate al juggernaut" };
  return { mode: "deathmatch", text: "Elimina al rival" };
}

function buildBot(v: VehicleOverlay, roster: ViewerRoster | null | undefined): HudBot {
  const dmg = damageVisualFor(v);
  const modules = Object.values(v.modules ?? {});
  const modulesDown = modules.filter((s) => s === "destroyed" || s === "offline").length;
  return {
    id: v.id,
    name: vehicleLabel(roster ?? undefined, v.id),
    team: v.team,
    alive: v.alive,
    hullHp: v.hullHp,
    hullHpMax: v.hullHpMax,
    hpRatio: dmg.hullRatio,
    hpPercent: Math.round(dmg.hullRatio * 100),
    carryingFlag: v.carryingFlag ?? null,
    modulesTotal: modules.length,
    modulesDown,
    turretLocked: dmg.turretLocked,
    armorBroken: dmg.armorBroken,
    mobilityCrippled: dmg.mobilityCrippled,
  };
}

/** Panel de bots por equipo. Equipos y bots en orden estable (por nombre/id). */
function buildTeams(overlay: OverlayState, roster: ViewerRoster | null | undefined): HudTeamPanel[] {
  const byTeam = new Map<string, HudBot[]>();
  for (const v of overlay.vehicles.values()) {
    const bot = buildBot(v, roster);
    const arr = byTeam.get(bot.team) ?? [];
    arr.push(bot);
    byTeam.set(bot.team, arr);
  }
  // El marcador puede nombrar equipos sin vehículos vivos aún: incluirlos vacíos.
  for (const team of Object.keys(overlay.score)) if (!byTeam.has(team)) byTeam.set(team, []);
  const teams = [...byTeam.keys()].sort((a, b) => a.localeCompare(b));
  return teams.map((team) => {
    const bots = (byTeam.get(team) ?? []).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      team,
      points: Number(overlay.score[team]) || 0,
      bots,
      aliveCount: bots.filter((b) => b.alive).length,
      tactical: buildTactical(bots),
    };
  });
}

function buildKillFeed(feed: FeedItem[], limit: number): HudKill[] {
  return feed
    .filter((f) => f.kind === "vehicle_destroyed")
    .slice(-limit)
    .map((f) => ({ tick: f.tick, text: f.text }));
}

function buildPhase(overlay: OverlayState): MatchPhase {
  if (overlay.result) return "final";
  if (overlay.lastTick <= 0) return "inicio";
  return "en_juego";
}

/**
 * DERIVA el modelo completo del HUD a partir del overlay público. Puro y
 * determinista: el mismo estado produce el mismo modelo (directo = replay), sin
 * inventar nada que el motor no exponga.
 */
export function buildHudModel(overlay: OverlayState, opts: HudModelOptions = {}): HudModel {
  const roster = opts.roster ?? null;
  const killLimit = opts.killFeedLimit ?? DEFAULT_KILL_FEED;
  const timeMs = tickToMs(overlay.lastTick);

  const flags: HudFlag[] = [...overlay.flags.entries()].map(([team, state]) => ({
    team,
    state,
    carrierId: overlay.carriers.get(team) ?? null,
  }));
  flags.sort((a, b) => a.team.localeCompare(b.team));

  const zones: HudZone[] = (Array.isArray(overlay.objectives) ? overlay.objectives : [])
    .filter((o: any) => o && typeof o === "object" && o.kind === "zone")
    .map((o: any) => ({
      id: String(o.id ?? ""),
      team: String(o.team ?? "neutral"),
      state: String(o.state ?? "neutral"),
    }));

  let matchEnd: HudMatchEnd | null = null;
  if (overlay.result) {
    const r = overlay.result;
    matchEnd = {
      winner: r.winner,
      score: r.score,
      reason: r.reason,
      headline: r.winner ? `Gana ${r.winner}` : "Empate",
    };
  }

  return {
    score: buildScore(overlay.score),
    clock: { tick: overlay.lastTick, timeMs, label: mmss(timeMs), phase: buildPhase(overlay) },
    objective: buildObjective(overlay.objectives),
    teams: buildTeams(overlay, roster),
    flags,
    zones,
    killFeed: buildKillFeed(overlay.feed, killLimit),
    matchEnd,
  };
}
