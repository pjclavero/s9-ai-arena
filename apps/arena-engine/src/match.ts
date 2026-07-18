/**
 * R3.8 · Nivel MATCH: N batallas (rondas) sobre el mismo mapa y ruleset.
 *
 * La batalla individual NO sabe nada de rondas: una Battle sigue siendo una ronda, con
 * su propio Rng, su propio hash y su propio replay. Este runner orquesta POR ENCIMA:
 *
 *   - SEMILLAS DERIVADAS con el mecanismo de fork del Rng (forkSeed = la semilla que
 *     fork() construiría): la semilla del match genera una semilla POR RONDA de forma
 *     determinista. Mismo seed de match ⇒ mismas semillas de ronda ⇒ mismos resultados,
 *     y cada ronda es reproducible por sí sola (la semilla queda en el resultado).
 *   - CAMBIO DE LADO (swapSides): en las rondas pares se intercambian las etiquetas de
 *     equipo de spawns, bases y banderas del mapa. Los vehículos conservan su equipo;
 *     lo que cambia es qué lado del mapa le toca a cada uno. Solo con 2 equipos.
 *   - MARCADOR DEL MATCH: rondas ganadas. Al mejor de N: se corta en cuanto un equipo
 *     alcanza mayoría inalcanzable (best-of). El empate de ronda no suma a nadie.
 *
 * Determinismo: este archivo no usa reloj ni Math.random; toda la aleatoriedad nace
 * del Rng con semilla. Los ids de batalla derivan del matchId, no de timestamps.
 */
import type { Ruleset } from "../../../packages/game-rules/index.js";
import { Rng } from "./rng.js";
import { Battle, type BattleResult, type Participant } from "./sim/battle.js";
import type { ArenaMap } from "./sim/modes.js";

export interface MatchConfig {
  matchId: string;
  seed: string;
  ruleset: Ruleset;
  map: ArenaMap;
  participants: Participant[];
  snapshotEveryNTicks?: number;
  hashEveryNTicks?: number;
  recordReplay?: boolean;
  /** Tope duro por ronda (mismo valor por defecto que Battle.run). */
  maxTicksPerRound?: number;
}

export interface RoundResult {
  round: number; // 1-based
  seed: string; // semilla derivada: la ronda es reproducible por sí sola
  sidesSwapped: boolean;
  result: BattleResult;
}

export interface MatchResult {
  matchId: string;
  seed: string;
  rounds: RoundResult[];
  /** Rondas ganadas por equipo. Los empates de ronda no suman. */
  roundWins: Record<string, number>;
  winner: string | "draw";
}

/**
 * Copia del mapa con las etiquetas de equipo INTERCAMBIADAS en spawns, bases y
 * banderas. Con más (o menos) de 2 equipos el cambio de lado no está definido y se
 * devuelve el mapa tal cual; el runner ya lo evita.
 */
export function swapMapSides(map: ArenaMap, teams: string[]): ArenaMap {
  if (teams.length !== 2) return map;
  const [a, b] = teams;
  const swap = (t: string): string => (t === a ? b : t === b ? a : t);
  return {
    ...map,
    spawns: map.spawns.map((s) => ({ ...s, team: swap(s.team) })),
    bases: map.bases.map((x) => ({ ...x, team: swap(x.team) })),
    flags: map.flags.map((f) => ({ ...f, team: swap(f.team) })),
  };
}

/**
 * Ejecuta el match completo. `attach` conecta los bots de cada ronda ANTES de que
 * arranque (bots frescos por ronda: un match no arrastra estado de bot entre rondas).
 */
export async function runMatch(
  config: MatchConfig,
  attach: (battle: Battle, round: number) => void,
): Promise<MatchResult> {
  const plan = config.ruleset.match ?? { rounds: 1, swapSides: false };
  if (!Number.isInteger(plan.rounds) || plan.rounds < 1) {
    throw new Error(`Plan de match inválido: rounds=${plan.rounds} (entero >= 1)`);
  }

  const teams = [...new Set(config.participants.map((p) => p.team))].sort();
  const master = new Rng(config.seed);
  // TODAS las semillas se derivan de antemano, en orden fijo. Así el corte por mayoría
  // no desplaza la secuencia: la ronda i tiene la misma semilla se jueguen 2 o N rondas.
  const seeds = Array.from({ length: plan.rounds }, (_, i) => master.forkSeed(`round-${i + 1}`));

  const roundWins: Record<string, number> = {};
  for (const t of teams) roundWins[t] = 0;
  const rounds: RoundResult[] = [];
  const majority = Math.floor(plan.rounds / 2) + 1;

  for (let i = 0; i < plan.rounds; i++) {
    // Best-of: si alguien ya tiene mayoría, las rondas restantes no pueden cambiar nada.
    if (teams.some((t) => roundWins[t] >= majority)) break;

    const sidesSwapped = plan.swapSides && teams.length === 2 && i % 2 === 1;
    const battle = await Battle.create({
      battleId: `${config.matchId}_r${i + 1}`,
      seed: seeds[i],
      ruleset: config.ruleset,
      map: sidesSwapped ? swapMapSides(config.map, teams) : config.map,
      participants: config.participants,
      ...(config.snapshotEveryNTicks !== undefined ? { snapshotEveryNTicks: config.snapshotEveryNTicks } : {}),
      ...(config.hashEveryNTicks !== undefined ? { hashEveryNTicks: config.hashEveryNTicks } : {}),
      ...(config.recordReplay !== undefined ? { recordReplay: config.recordReplay } : {}),
    });
    attach(battle, i + 1);
    const result = battle.run(config.maxTicksPerRound ?? 100000);
    battle.free();

    rounds.push({ round: i + 1, seed: seeds[i], sidesSwapped, result });
    if (result.winner !== "draw") {
      roundWins[result.winner] = (roundWins[result.winner] ?? 0) + 1;
    }
  }

  // Ganador del match: más rondas ganadas; empate real ⇒ "draw".
  const sorted = [...teams].sort((a, b) => roundWins[b] - roundWins[a]);
  const winner =
    sorted.length === 0 || (sorted.length > 1 && roundWins[sorted[0]] === roundWins[sorted[1]]) ? "draw" : sorted[0];

  return { matchId: config.matchId, seed: config.seed, rounds, roundWins, winner };
}
