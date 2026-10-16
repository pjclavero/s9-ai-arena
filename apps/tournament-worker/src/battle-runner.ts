/**
 * E9 · T9.1 — handler de `run_battle`: ejecuta UNA batalla programada.
 *
 * AUTORIDAD ÚNICA DE EJECUCIÓN (cierre funcional, DEV-B · TD-002): este handler
 * es el ÚNICO camino del producto que ejecuta una batalla. La API sólo la agenda
 * (POST /battles → `jobs.run_battle`, dedupe `run_battle:<id>`); `POST
 * /battles/{id}/run` ya no ejecuta nada, sólo se asegura de que el trabajo está
 * en la cola.
 *
 * Flujo:
 *  1. RESERVA ATÓMICA (`claimBattle`): `UPDATE battles … WHERE status='scheduled'`
 *     (o `running` con el lease caducado: worker muerto) `RETURNING *`. Sólo quien
 *     gana el UPDATE ejecuta. Queda escrito QUIÉN (`claimed_by`) y HASTA CUÁNDO
 *     (`lease_expires_at`), y el lease se renueva mientras la batalla corre.
 *  2. Descalificaciones administrativas ANTES de lanzar: versión que ya no está
 *     `published|frozen` (suspendida, retirada…), suspensiones de E6 y firma del
 *     artefacto (si se cablean).
 *  3. Ejecuta la batalla con el `BattleExecutor` (engine-executor.ts: motor real;
 *     los agentes son los CONTENEDORES del código de cada bot en producción).
 *  4. FINALIZACIÓN EXACTAMENTE UNA VEZ (`finishBattle`): en una transacción,
 *     `UPDATE battles SET status='finished' … WHERE status='running' AND
 *     claimed_by=:yo`. Si no es exactamente 1 fila, otro titular ya la cerró (o
 *     le quitó la reserva): se aborta SIN escribir resultado, outcome, replay ni
 *     process_result.
 *
 * Clasificación de fallos (19.2):
 *  - SportingFailure (timeout/crash del bot): la batalla TERMINA con derrota del
 *    bot culpable; el trabajo se completa; NUNCA se reintenta.
 *  - InfrastructureFailure: la batalla vuelve a `scheduled` (sólo si la reserva
 *    sigue siendo nuestra) y la cola reintenta con límite; agotado, la batalla
 *    queda `failed` con failure_kind 'infrastructure' (markBattleForReview).
 *
 * Idempotencia: batalla ya `finished` ⇒ no se re-ejecuta (sólo se completan las
 * estadísticas si faltan). Batalla `running` con lease VIVO de otro titular ⇒
 * este trabajo es un duplicado: `battle_busy` (infraestructura, se reintenta y,
 * si el titular la cierra, el reintento la ve `finished`).
 */
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { runStatsJob } from "../../replay-service/src/stats.js";
import { administrativeDisqualifications } from "../../bot-manager/src/suspension.js";
import type { SuspensionCheck } from "../../bot-manager/src/launch-guard.js";
import type { ArtifactLaunchCheck } from "../../bot-manager/src/launch-verify.js";
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
  claimed_by?: string | null;
}

export interface ParticipantRow {
  battle_id: string;
  bot_id: string;
  version: number;
  team: string;
  outcome: string | null;
}

/**
 * Quién condujo los vehículos. Queda escrito en `battles.result.agents`:
 *  - `container`: el CÓDIGO de cada bot, en su contenedor del sandbox (producción).
 *  - `in_process_stub`: stubs deterministas del motor (SÓLO tests; no seleccionable
 *    en producción, ver testing/stub-agents.ts).
 *  - `scripted`: ejecutores guionizados de los tests de cola (sin motor).
 */
export type AgentsKind = "container" | "in_process_stub" | "scripted";

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
  /**
   * CPU REAL consumida por el contenedor de cada bot (ms, cgroup), por botId.
   * `null` = no medida. Se persiste en `participants.cpu_ms` en la MISMA
   * transacción que el resultado; de ahí la lee runStatsJob.
   */
  cpuMsByBot?: Record<string, number | null>;
  /** Quién condujo los vehículos (ver AgentsKind). Ausente ⇒ `scripted`. */
  agents?: AgentsKind;
  // H3 (issue #7): aquí existió `statsPerBot`. Se ELIMINÓ: battle_stats tiene UNA
  // sola forma, la canónica del runStatsJob de E8. No reintroducir un segundo
  // escritor: battle-stats-canonical.test.ts lo vigila.
}

export interface BattleContext {
  battle: BattleRow;
  participants: ParticipantRow[];
  /** Descalificados administrativamente ANTES de lanzar (suspensiones E6). */
  adminDisqualified: string[];
  /**
   * Se aborta si este worker PIERDE la reserva de la batalla (lease no renovable:
   * otro titular la recuperó). El ejecutor debe parar y limpiar contenedores; su
   * resultado, si llega, se descarta.
   */
  signal?: AbortSignal;
}

export type BattleExecutor = (ctx: BattleContext) => Promise<BattleExecution>;

export interface BattleRunnerDeps {
  executor: BattleExecutor;
  /** Registro de suspensiones REAL de E6; opcional en tests de cola pura. */
  suspensions?: SuspensionCheck;
  /**
   * R2.5 (ERR-SEC-15): verificación de firma del artefacto ANTES de lanzar.
   * Un artefacto ausente, sin firma o manipulado descalifica al bot: se
   * RECHAZA su lanzamiento (fail closed), la batalla no lo ejecuta.
   */
  artifactGuard?: ArtifactLaunchCheck;
  /** Directorio de replays (política 23.1: archivos, no BD). */
  replaysDir?: string;
  /** Duración del lease de la reserva (ms). Se renueva cada leaseMs/3. Def. 45 s. */
  leaseMs?: number;
}

/** Lease por defecto: por DEBAJO del lockTimeout de la cola (60 s) para que, cuando
 *  un trabajo huérfano se re-reclame, la reserva de la batalla ya haya caducado. */
export const DEFAULT_LEASE_MS = 45_000;

/** Estados de bot_versions con los que una versión puede jugar (BOT_PUBLISHED). */
const PLAYABLE_STATES = new Set(["published", "frozen"]);

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

/**
 * RESERVA ATÓMICA de una batalla para ejecutarla. Un solo UPDATE condicionado:
 * `scheduled → running`, o `running` con el lease caducado (titular muerto) →
 * `running` con nuevo titular. Devuelve la fila reservada o `null` si otro la
 * tiene (o ya no es ejecutable). Exportada para poder probar la carrera directa.
 */
export async function claimBattle(
  db: Knex,
  battleId: string,
  owner: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<BattleRow | null> {
  const res = await db.raw(
    `
    UPDATE battles SET
      status = 'running',
      started_at = now(),
      finished_at = NULL,
      claimed_by = :owner,
      lease_expires_at = now() + (:leaseMs * interval '1 millisecond'),
      run_attempts = run_attempts + 1
    WHERE id = :battleId
      AND (
        status = 'scheduled'
        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
      )
    RETURNING *
    `,
    { owner, leaseMs, battleId },
  );
  return (res.rows?.[0] as BattleRow | undefined) ?? null;
}

/** Renueva el lease de la batalla (y el lock del trabajo). Devuelve false si la reserva ya no es nuestra. */
export async function renewBattleLease(
  db: Knex,
  battleId: string,
  owner: string,
  leaseMs: number = DEFAULT_LEASE_MS,
  job?: { id?: string; workerId?: string },
): Promise<boolean> {
  const n = await db("battles")
    .where({ id: battleId, status: "running", claimed_by: owner })
    .update({ lease_expires_at: db.raw("now() + (? * interval '1 millisecond')", [leaseMs]) });
  if (job?.id && job.workerId) {
    // Mantiene vivo el lock del trabajo: sin esto, una batalla real (minutos) se
    // vería "huérfana" a los lockTimeoutMs y otro worker re-reclamaría el trabajo.
    await db("jobs")
      .where({ id: job.id, locked_by: job.workerId, status: "running" })
      .update({ locked_at: db.fn.now(), updated_at: db.fn.now() });
  }
  return n === 1;
}

/** Libera la reserva SOLO si sigue siendo nuestra (vuelve a `scheduled` para reintento). */
async function releaseBattleClaim(db: Knex, battleId: string, owner: string): Promise<void> {
  await db("battles")
    .where({ id: battleId, status: "running", claimed_by: owner })
    .update({ status: "scheduled", started_at: null, claimed_by: null, lease_expires_at: null });
}

/** Error interno: la reserva dejó de ser nuestra antes de finalizar. Nada se escribe. */
export class LostBattleClaim extends Error {
  constructor(battleId: string, owner: string) {
    super(`[battle_busy] la reserva de la batalla ${battleId} ya no es de ${owner}: no se finaliza (otro titular)`);
    this.name = "LostBattleClaim";
  }
}

/**
 * Descalificaciones administrativas ANTES de lanzar: versión no jugable (estado
 * fuera de published|frozen, p. ej. `suspended` o `retired` tras agendar),
 * suspensiones del registro de E6 y firma del artefacto.
 */
async function adminDisqualifications(
  db: Knex,
  battleId: string,
  participants: ParticipantRow[],
  deps: BattleRunnerDeps,
): Promise<string[]> {
  const adminDq: string[] = [];
  for (const p of participants) {
    const v = await db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first();
    if (!v || !PLAYABLE_STATES.has(String(v.state))) adminDq.push(p.bot_id);
  }
  if (deps.suspensions) {
    for (const d of administrativeDisqualifications(
      participants.map((p) => ({ entryId: `${battleId}:${p.bot_id}`, botId: p.bot_id, version: p.version })),
      deps.suspensions,
    )) {
      if (!adminDq.includes(d.botId)) adminDq.push(d.botId);
    }
  }
  // R2.5 (ERR-SEC-15) · verificación de firma ANTES de cada lanzamiento.
  if (deps.artifactGuard) {
    for (const p of participants) {
      if (adminDq.includes(p.bot_id)) continue;
      const check = await deps.artifactGuard.check(p.bot_id, p.version);
      if (!check.ok) adminDq.push(p.bot_id);
    }
  }
  return adminDq;
}

export function makeRunBattleHandler(deps: BattleRunnerDeps): JobHandler {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  return async (job: JobRow, ctx: HandlerContext) => {
    const db = ctx.db;
    const battleId = String(job.payload?.battleId ?? "");
    const owner = `${ctx.workerId}:${job.id ?? randomUUID()}:${job.attempts ?? 0}`;

    const claimed = await claimBattle(db, battleId, owner, leaseMs);
    if (!claimed) {
      const { battle } = await loadBattle(db, battleId);
      // Idempotencia: re-entrega tras worker muerto NO re-ejecuta una batalla
      // terminada; solo rellena las stats ricas de E8 si faltan (H2, issue #6).
      if (battle.status === "finished") {
        await ensureRichStats(db, battleId, deps);
        return;
      }
      if (battle.status === "failed") return; // cerrada para revisión: nada que hacer
      // `running` con lease vivo de OTRO titular: este trabajo es un duplicado.
      throw new InfrastructureFailure(
        "battle_busy",
        `la batalla ${battleId} la está ejecutando ${battle.claimed_by ?? "otro titular"}`,
      );
    }
    const battle = claimed;
    const participants = (await db("participants").where({ battle_id: battleId })) as ParticipantRow[];

    // Lease vivo mientras dura la batalla; si se pierde, se aborta la ejecución.
    const aborter = new AbortController();
    const renewEvery = Math.max(250, Math.floor(leaseMs / 3));
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      renewBattleLease(db, battleId, owner, leaseMs, { id: job.id, workerId: ctx.workerId })
        .then((ok) => {
          if (!ok) aborter.abort(new LostBattleClaim(battleId, owner));
        })
        .catch(() => undefined) // BD momentáneamente caída: se reintenta en el siguiente tick
        .finally(() => {
          renewing = false;
        });
    }, renewEvery);
    timer.unref?.();

    try {
      const adminDq = await adminDisqualifications(db, battleId, participants, deps);
      const activeTeams = new Set(participants.filter((p) => !adminDq.includes(p.bot_id)).map((p) => p.team));

      // Walkover: si tras las DQ administrativas queda un solo bando, no hay batalla que lanzar.
      if (activeTeams.size < 2) {
        const winner = activeTeams.size === 1 ? [...activeTeams][0] : "draw";
        await finishBattle(
          db,
          battle,
          participants,
          {
            winner,
            ticks: 0,
            score: {},
            finalStateHash: "walkover",
            disqualified: adminDq,
            versions: {},
          },
          adminDq,
          "none",
          owner,
          "walkover",
        );
        return;
      }

      let execution: BattleExecution;
      try {
        execution = await deps.executor({ battle, participants, adminDisqualified: adminDq, signal: aborter.signal });
      } catch (err) {
        if (aborter.signal.aborted) {
          // Perdimos la reserva: otro titular la tiene. No se toca nada.
          throw new InfrastructureFailure("battle_busy", String(aborter.signal.reason ?? err));
        }
        if (err instanceof SportingFailure) {
          // Derrota deportiva (19.2): el bot culpable pierde; la batalla TERMINA.
          const culpritTeam = participants.find((p) => p.bot_id === err.botId)?.team;
          const rivals = [...new Set(participants.filter((p) => p.team !== culpritTeam).map((p) => p.team))];
          await finishBattle(
            db,
            battle,
            participants,
            {
              winner: rivals.length === 1 ? rivals[0] : "draw",
              ticks: 0,
              score: {},
              finalStateHash: "sporting_failure",
              disqualified: [...adminDq, err.botId],
              versions: {},
              ...(err.agents ? { agents: err.agents } : {}),
            },
            adminDq,
            err.code,
            owner,
            "sporting_failure",
          );
          throw err; // el worker lo convierte en done + error_class 'sporting'
        }
        // Fallo técnico: la batalla vuelve a scheduled (si sigue siendo nuestra) y la cola decide el reintento.
        await releaseBattleClaim(db, battleId, owner);
        if (err instanceof InfrastructureFailure) throw err;
        throw new InfrastructureFailure("engine_start_failure", err instanceof Error ? err.message : String(err));
      }

      if (aborter.signal.aborted) {
        throw new InfrastructureFailure("battle_busy", String(aborter.signal.reason));
      }
      await finishBattle(db, battle, participants, execution, adminDq, "none", owner, "completed", deps.replaysDir);
    } catch (err) {
      if (err instanceof LostBattleClaim) throw new InfrastructureFailure("battle_busy", err.message);
      throw err;
    } finally {
      clearInterval(timer);
    }
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
    throw new InfrastructureFailure(
      "storage_unavailable",
      `stats de ${battleId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Motivo de cierre que queda en `battles.result.endReason`. */
export type EndReason = "completed" | "walkover" | "sporting_failure";

/**
 * BATTLE_RESULT · forma de `battles.result` (jsonb), versión 1. Documentada en
 * docs/technical/battles.md. Los campos `winner/ticks/score/disqualified` son los
 * históricos (los siguen leyendo la API pública, results.ts y la web); los demás
 * son aditivos.
 */
export interface BattleResultV1 {
  schema: "battle-result/v1";
  /** Equipo ganador o "draw". El ganador POR BOT es `participants.outcome`. */
  winner: string | "draw";
  ticks: number;
  score: Record<string, number>;
  /** botIds descalificados (motor + administrativos + culpable deportivo). */
  disqualified: string[];
  endReason: EndReason;
  /** Quién condujo los vehículos: `container` en producción. */
  agents: AgentsKind;
}

function buildResult(execution: BattleExecution, disqualified: Set<string>, endReason: EndReason): BattleResultV1 {
  return {
    schema: "battle-result/v1",
    winner: execution.winner,
    ticks: execution.ticks,
    score: execution.score,
    disqualified: [...disqualified],
    endReason,
    agents: execution.agents ?? "scripted",
  };
}

async function finishBattle(
  db: Knex,
  battle: BattleRow,
  participants: ParticipantRow[],
  execution: BattleExecution,
  adminDq: string[],
  failureKind: string,
  owner: string,
  endReason: EndReason,
  replaysDir?: string,
): Promise<void> {
  const disqualified = new Set([...adminDq, ...execution.disqualified]);

  await db.transaction(async (trx) => {
    // FINALIZACIÓN EXACTAMENTE UNA VEZ: sólo el titular vigente de la reserva,
    // y sólo desde `running`. El UPDATE bloquea la fila hasta el COMMIT, así que
    // un segundo finalizador concurrente espera y luego no casa el WHERE.
    const closed = await trx("battles")
      .where({ id: battle.id, status: "running", claimed_by: owner })
      .update({
        status: "finished",
        finished_at: trx.fn.now(),
        failure_kind: failureKind,
        result: JSON.stringify(buildResult(execution, disqualified, endReason)),
        final_state_hash: execution.finalStateHash,
        engine_versions: JSON.stringify(execution.versions),
        lease_expires_at: null,
      });
    if (closed !== 1) throw new LostBattleClaim(battle.id, owner);

    // Replay: SOLO quien acaba de cerrar la batalla lo escribe (dentro de la
    // transacción con la fila bloqueada): un finalizador perdedor jamás pisa el
    // archivo `<battleId>.replay` del ganador. Si la ingesta falla, rollback.
    if (execution.replayJsonl && replaysDir) {
      // H2 (issue #6) · Ingesta por el almacén REAL de E8 (T8.1): valida,
      // comprime y persiste con índice; battles.replay_ref/replay_hash siguen el
      // convenio del almacén (hash del archivo comprimido).
      const stored = ingestReplay(replaysDir, fromJsonl(execution.replayJsonl), {
        official: battle.official,
      });
      await trx("battles")
        .where({ id: battle.id })
        .update({ replay_ref: stored.path, replay_hash: stored.index.sha256 });
    }

    for (const p of participants) {
      const cpu = execution.cpuMsByBot ? execution.cpuMsByBot[p.bot_id] : undefined;
      await trx("participants")
        .where({ battle_id: battle.id, bot_id: p.bot_id })
        .update({
          outcome: outcomeFor(p, execution.winner, disqualified),
          // CPU medida por el runner de contenedores; null/ausente no escribe nada
          // (la columna queda NULL = no medida, nunca una estimación).
          ...(typeof cpu === "number" && Number.isFinite(cpu) && cpu >= 0 ? { cpu_ms: cpu } : {}),
        });
    }
    // H3 (issue #7): battle_stats NO se escribe aquí. La única forma canónica
    // la escribe el runStatsJob de E8 (ensureRichStats, tras esta transacción).

    // 19.1: el resultado se procesa (avance de rondas, ratings) en su propio
    // trabajo, encolado en la MISMA transacción que el cierre.
    await enqueueJob(trx, "process_result", { battleId: battle.id }, { dedupeKey: `process_result:${battle.id}` });
  });
}

/**
 * Al agotar reintentos de infraestructura: batalla marcada para revisión manual.
 * NUNCA toca una batalla terminada ni una que otro titular esté ejecutando con
 * el lease vivo (un trabajo duplicado agotado no puede tumbar la batalla buena).
 */
export async function markBattleForReview(db: Knex, job: JobRow): Promise<void> {
  if (job.kind !== "run_battle") return;
  const battleId = String(job.payload.battleId ?? "");
  await db("battles")
    .where({ id: battleId })
    .where((q) =>
      q
        .where({ status: "scheduled" })
        .orWhere((r) =>
          r.where({ status: "running" }).andWhere((s) => s.whereNull("lease_expires_at").orWhere("lease_expires_at", "<", db.fn.now())),
        ),
    )
    .update({ status: "failed", failure_kind: "infrastructure", claimed_by: null, lease_expires_at: null });
}
