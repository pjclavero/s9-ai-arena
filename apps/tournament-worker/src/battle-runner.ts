/**
 * E9 · T9.1 — handler de `run_battle`: ejecuta UNA batalla programada.
 *
 * Flujo (19.1 + 19.2 + 9.4):
 *  1. Carga batalla + participantes de la BD (E7).
 *  2. Pide autorización al bot-manager REAL de E6: los bots suspendidos quedan
 *     descalificados administrativamente (administrativeDisqualifications).
 *  3. Ejecuta la batalla mediante un BattleExecutor (el real usa el motor de E2:
 *     engine-executor.ts; los tests de la cola inyectan ejecutores guionizados).
 *  4. Persiste resultado, hashes, versiones, replay y stats; encola process_result.
 *
 * Clasificación de fallos (19.2):
 *  - SportingFailure (timeout/crash del bot): la batalla TERMINA con derrota del
 *    bot culpable; el trabajo se completa; NUNCA se reintenta.
 *  - InfrastructureFailure: la batalla vuelve a `scheduled` y la cola reintenta
 *    con límite; agotado, la batalla queda `failed` con failure_kind
 *    'infrastructure' para revisión manual (onRunBattleExhausted).
 *
 * Idempotencia: si la batalla ya está `finished`, el handler no re-ejecuta nada
 * (protege contra re-entregas del mismo trabajo tras un worker muerto).
 */
import type { Knex } from "knex";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { runStatsJob } from "../../replay-service/src/stats.js";
import { administrativeDisqualifications } from "../../bot-manager/src/suspension.js";
import type { SuspensionCheck } from "../../bot-manager/src/launch-guard.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";
import { enqueueJob, type JobRow } from "./queue.js";
import type { HandlerContext, JobHandler } from "./worker.js";

export interface BattleRow {
  id: string;
  tournament_id: string | null;
  match_id: string | null;
  status: string;
  official: boolean;
  mode: string;
  ruleset_id: string | null;
  map_id: string;
  map_version: number;
  seed: string | null;
  result: unknown;
  /** E9/008: 'delayed' (anti-coaching E8.M) o 'visible' (la final, en claro). */
  spectator_mode?: string;
}

export interface ParticipantRow {
  battle_id: string;
  bot_id: string;
  version: number;
  team: string;
  outcome: string | null;
}

/** Resultado que el ejecutor devuelve al runner (subconjunto de BattleResult de E2). */
export interface BattleExecution {
  winner: string | "draw"; // equipo ganador
  ticks: number;
  score: Record<string, number>;
  finalStateHash: string;
  disqualified: string[]; // botIds descalificados por el motor
  versions: Record<string, string>;
  /** Replay JSONL (T2.6). El runner lo archiva vía el almacén de E8 (política 23.1). */
  replayJsonl?: string;
  // H3 (issue #7): aquí existió `statsPerBot` (forma simple {team, teamScore,
  // ticks, disqualified}). Se ELIMINÓ: battle_stats tiene UNA sola forma, la
  // canónica del runStatsJob de E8 (la que leen los agregados de E9). No
  // reintroducir un segundo escritor: battle-stats-canonical.test.ts lo vigila.
}

export interface BattleContext {
  battle: BattleRow;
  participants: ParticipantRow[];
  /** Descalificados administrativamente ANTES de lanzar (suspensiones E6). */
  adminDisqualified: string[];
}

export type BattleExecutor = (ctx: BattleContext) => Promise<BattleExecution>;

export interface BattleRunnerDeps {
  executor: BattleExecutor;
  /** Registro de suspensiones REAL de E6; opcional en tests de cola pura. */
  suspensions?: SuspensionCheck;
  /** Directorio de replays (política 23.1: archivos, no BD). */
  replaysDir?: string;
}

async function loadBattle(db: Knex, battleId: string): Promise<{ battle: BattleRow; participants: ParticipantRow[] }> {
  const battle = (await db("battles").where({ id: battleId }).first()) as BattleRow | undefined;
  if (!battle) throw new Error(`run_battle: batalla ${battleId} inexistente`);
  const participants = (await db("participants").where({ battle_id: battleId })) as ParticipantRow[];
  return { battle, participants };
}

function outcomeFor(p: ParticipantRow, winner: string | "draw", disqualified: Set<string>): string {
  if (disqualified.has(p.bot_id)) return "disqualified";
  if (winner === "draw") return "draw";
  return p.team === winner ? "win" : "loss";
}

export function makeRunBattleHandler(deps: BattleRunnerDeps): JobHandler {
  return async (job: JobRow, ctx: HandlerContext) => {
    const db = ctx.db;
    const battleId = String(job.payload.battleId ?? "");
    const { battle, participants } = await loadBattle(db, battleId);

    // Idempotencia: re-entrega tras worker muerto NO re-ejecuta una batalla
    // terminada; solo rellena las stats ricas de E8 si faltan (H2, issue #6).
    if (battle.status === "finished") {
      await ensureRichStats(db, battleId, deps);
      return;
    }

    // E6 · suspensiones: descalificación administrativa antes de lanzar nada.
    const adminDq = deps.suspensions
      ? administrativeDisqualifications(
          participants.map((p) => ({ entryId: `${battleId}:${p.bot_id}`, botId: p.bot_id, version: p.version })),
          deps.suspensions,
        ).map((d) => d.botId)
      : [];
    const activeTeams = new Set(participants.filter((p) => !adminDq.includes(p.bot_id)).map((p) => p.team));

    await db("battles").where({ id: battleId }).update({ status: "running", started_at: db.fn.now() });

    // Walkover: si tras las DQ administrativas queda un solo bando, no hay batalla que lanzar.
    if (activeTeams.size < 2) {
      const winner = activeTeams.size === 1 ? [...activeTeams][0] : "draw";
      await finishBattle(db, battle, participants, {
        winner,
        ticks: 0,
        score: {},
        finalStateHash: "walkover",
        disqualified: adminDq,
        versions: {},
      }, adminDq, "none");
      return;
    }

    let execution: BattleExecution;
    try {
      execution = await deps.executor({ battle, participants, adminDisqualified: adminDq });
    } catch (err) {
      if (err instanceof SportingFailure) {
        // Derrota deportiva (19.2): el bot culpable pierde; la batalla TERMINA.
        const culpritTeam = participants.find((p) => p.bot_id === err.botId)?.team;
        const rivals = [...new Set(participants.filter((p) => p.team !== culpritTeam).map((p) => p.team))];
        await finishBattle(db, battle, participants, {
          winner: rivals.length === 1 ? rivals[0] : "draw",
          ticks: 0,
          score: {},
          finalStateHash: "sporting_failure",
          disqualified: [...adminDq, err.botId],
          versions: {},
        }, adminDq, err.code);
        throw err; // el worker lo convierte en done + error_class 'sporting'
      }
      // Fallo técnico: la batalla vuelve a scheduled y la cola decide el reintento.
      await db("battles").where({ id: battleId }).update({ status: "scheduled", started_at: null });
      if (err instanceof InfrastructureFailure) throw err;
      throw new InfrastructureFailure("engine_start_failure", err instanceof Error ? err.message : String(err));
    }

    await finishBattle(db, battle, participants, execution, adminDq, "none", deps.replaysDir);
    // H2 (issue #6) · Stats RICAS de E8 (T8.4) al archivar el replay: el mismo
    // runStatsJob que usan el replay-service y los agregados de E9. Va DESPUÉS
    // de persistir el resultado: un fallo aquí no pierde la batalla (el job se
    // reintenta y el camino idempotente de arriba rellena lo que falte).
    await ensureRichStats(db, battleId, deps);
  };
}

/**
 * H2+H3 (issues #6/#7) · Garantiza las stats ricas de E8 para una batalla con
 * replay archivado: ejecuta el runStatsJob REAL de E8 (re-simulación, T8.4),
 * que deja `battle_stats` SIEMPRE en la forma canónica que leen los agregados
 * de E9. runStatsJob es idempotente por battle_id (delete+insert): reprocesar
 * sobrescribe, jamás duplica. Sin replay archivado (walkover, derrota
 * deportiva) no hay stats que calcular.
 */
async function ensureRichStats(db: Knex, battleId: string, deps: BattleRunnerDeps): Promise<void> {
  if (!deps.replaysDir) return;
  const row = await db("battles").where({ id: battleId }).first();
  // Solo replays del almacén de E8 (<id>.replay); refs antiguas u otras rutas no se tocan.
  if (!row?.replay_ref || !String(row.replay_ref).endsWith(`${battleId}.replay`)) return;
  try {
    await runStatsJob(db, deps.replaysDir, battleId);
  } catch (err) {
    // El resultado ya es firme; las stats se reintentan como infraestructura.
    throw new InfrastructureFailure("storage_unavailable", `stats de ${battleId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function finishBattle(
  db: Knex,
  battle: BattleRow,
  participants: ParticipantRow[],
  execution: BattleExecution,
  adminDq: string[],
  failureKind: string,
  replaysDir?: string,
): Promise<void> {
  let replayRef: string | null = null;
  let replayHash: string | null = null;
  if (execution.replayJsonl && replaysDir) {
    // H2 (issue #6) · Ingesta por el almacén REAL de E8 (T8.1): valida,
    // comprime y persiste con índice; battles.replay_ref/replay_hash siguen el
    // convenio del almacén (hash del archivo comprimido, el que comprueban
    // getReplay/verifyReplay de la API). Antes el worker escribía JSONL crudo
    // que el replay-service no podía leer.
    const stored = ingestReplay(replaysDir, fromJsonl(execution.replayJsonl), {
      official: battle.official,
    });
    replayRef = stored.path;
    replayHash = stored.index.sha256;
  }
  const disqualified = new Set([...adminDq, ...execution.disqualified]);

  await db.transaction(async (trx) => {
    await trx("battles")
      .where({ id: battle.id })
      .update({
        status: "finished",
        finished_at: trx.fn.now(),
        failure_kind: failureKind,
        result: JSON.stringify({
          winner: execution.winner,
          ticks: execution.ticks,
          score: execution.score,
          disqualified: [...disqualified],
        }),
        final_state_hash: execution.finalStateHash,
        engine_versions: JSON.stringify(execution.versions),
        replay_ref: replayRef,
        replay_hash: replayHash,
      });
    for (const p of participants) {
      await trx("participants")
        .where({ battle_id: battle.id, bot_id: p.bot_id })
        .update({ outcome: outcomeFor(p, execution.winner, disqualified) });
    }
    // H3 (issue #7): battle_stats NO se escribe aquí. La única forma canónica
    // la escribe el runStatsJob de E8 (ensureRichStats, tras esta transacción).
  });
  // 19.1: el resultado se procesa (avance de rondas, ratings) en su propio trabajo.
  await enqueueJob(db, "process_result", { battleId: battle.id }, { dedupeKey: `process_result:${battle.id}` });
}

/** Al agotar reintentos de infraestructura: batalla marcada para revisión manual. */
export async function markBattleForReview(db: Knex, job: JobRow): Promise<void> {
  if (job.kind !== "run_battle") return;
  const battleId = String(job.payload.battleId ?? "");
  await db("battles")
    .where({ id: battleId })
    .whereNot({ status: "finished" })
    .update({ status: "failed", failure_kind: "infrastructure" });
}
