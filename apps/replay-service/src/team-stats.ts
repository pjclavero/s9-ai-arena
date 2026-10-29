/**
 * 4v4-STATS · Agregado por bando. Módulo PURO (sin motor ni BD): lo usan el
 * job de stats (stats.ts) y la API (`GET /battles/{id}/stats`), que así no
 * arrastra el motor de física para sumar unos contadores. Una sola autoridad
 * para la regla de suma: si la API y el job sumaran distinto, `perTeam` del
 * replay y el de la API divergirían.
 */

/**
 * Por bando. TODO lo que hay aquí es la suma de campos DEPORTIVOS de `perBot`
 * (TD-047: no puede revelar nada que `perBot` no enseñe a quien ve la batalla).
 * En TDM sin fuego amigo `kills === score` (cada baja enemiga es un punto); con
 * fuego amigo el motor da además un punto al rival por cada `teamKills`.
 */
export interface TeamBattleStats {
  team: string;
  score: number;
  /** 4v4-STATS · Bots del bando. */
  bots: number;
  damageDealt: number;
  /** 4v4-STATS */
  damageTaken: number;
  kills: number;
  /** 4v4-STATS · Bajas de compañeros (o propias) con fuego amigo. */
  teamKills: number;
  /** 4v4-STATS · Muertes de bots del bando (con respawn, todas). */
  deaths: number;
  /** 4v4-STATS */
  shotsFired: number;
  /** 4v4-STATS */
  shotsHit: number;
  flagCaptures: number;
  /** Bots vivos y no descalificados al terminar (con respawn: `aliveAtEnd`). */
  survivors: number;
  /** R-RULES · Reapariciones usadas por el bando. */
  respawns: number;
  /** R-RULES · Sólo con respawn limitado: reapariciones que le quedaban al bando. */
  respawnsRemaining?: number;
}

/** Campos de un bot que entran en la suma (todos deportivos). */
export interface TeamSummable {
  damageDealt?: unknown;
  damageTaken?: unknown;
  kills?: unknown;
  teamKills?: unknown;
  deaths?: unknown;
  died?: unknown;
  aliveAtEnd?: unknown;
  disqualified?: unknown;
  shotsFired?: unknown;
  shotsHit?: unknown;
  flagCaptures?: unknown;
  respawns?: unknown;
  respawnsRemaining?: unknown;
}

/** Bando vacío. */
export function emptyTeamStats(team: string, score: number): TeamBattleStats {
  return {
    team,
    score,
    bots: 0,
    damageDealt: 0,
    damageTaken: 0,
    kills: 0,
    teamKills: 0,
    deaths: 0,
    shotsFired: 0,
    shotsHit: 0,
    flagCaptures: 0,
    survivors: 0,
    respawns: 0,
  };
}

/**
 * Suma un bot a su bando. Sólo lee campos DEPORTIVOS y tolera la forma ANTIGUA
 * de `battle_stats` (sin `deaths`/`aliveAtEnd`: una muerte como mucho, sin respawn).
 */
export function addBotToTeam(t: TeamBattleStats, s: TeamSummable): void {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  t.bots += 1;
  t.damageDealt += n(s.damageDealt);
  t.damageTaken += n(s.damageTaken);
  t.kills += n(s.kills);
  t.teamKills += n(s.teamKills);
  t.deaths += typeof s.deaths === "number" ? n(s.deaths) : s.died === true ? 1 : 0;
  t.shotsFired += n(s.shotsFired);
  t.shotsHit += n(s.shotsHit);
  t.flagCaptures += n(s.flagCaptures);
  t.respawns += n(s.respawns);
  if (typeof s.respawnsRemaining === "number") t.respawnsRemaining = (t.respawnsRemaining ?? 0) + n(s.respawnsRemaining);
  const alive = typeof s.aliveAtEnd === "boolean" ? s.aliveAtEnd : s.died !== true && s.disqualified !== true;
  if (alive) t.survivors += 1;
}
