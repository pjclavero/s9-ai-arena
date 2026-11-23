/**
 * B (release 0.5.0) · Cierre de un job `run_battle` agotado: deja la batalla en `failed`
 * (`markBattleForReview`) Y hace avanzar su match y su torneo (`settleFailedBattle`), para que
 * una batalla fallida de forma definitiva nunca deje el torneo `running` para siempre.
 * Si el avance falla, se registra (log estructurado) y no se propaga (el worker no debe caer por esto): el rescate periódico
 * (`rescueStuckTournaments`) lo recoge después.
 */
import type { Knex } from "knex";
import { markBattleForReview } from "./battle-runner.js";
import type { JobRow } from "./queue.js";
import { rescueStuckTournaments, settleFailedBattle } from "./results.js";
import type { HandlerContext } from "./worker.js";

export async function onBattleJobExhausted(job: JobRow, ctx: HandlerContext): Promise<void> {
  await markBattleForReview(ctx.db, job);
  if (job.kind !== "run_battle") return;
  try {
    await settleFailedBattle(ctx.db as Knex, String(job.payload.battleId ?? ""));
  } catch (err) {
    // No se propaga (lo recoge el rescate periódico), pero queda registrado.
    console.error(
      JSON.stringify({
        level: "error",
        service: "tournament-worker",
        msg: "settle_failed_battle_error",
        battleId: String(job.payload.battleId ?? ""),
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Cierre del torneo para una batalla que el BARRIDO de huérfanos acaba de dejar `failed` (mismo
 * efecto que `onBattleJobExhausted` para el camino del claim). Lo cablea `main.ts` y lo prueba el
 * test de avance de torneo con torneo y match reales.
 */
export function settleOrphanFailed(db: Knex): (battleId: string) => Promise<void> {
  return (battleId) => settleFailedBattle(db, battleId);
}

/** Arranca el rescate: una vez ahora y cada `everyMs`. Devuelve la función que lo para. */
export function startTournamentRescue(
  db: Knex,
  onReport: (touched: string[], err?: unknown) => void,
  everyMs = 300_000,
): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    rescueStuckTournaments(db).then(
      (t) => onReport(t),
      (e) => onReport([], e),
    );
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
