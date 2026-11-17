/**
 * B (release 0.5.0) · Cierre de un job `run_battle` agotado: deja la batalla en `failed`
 * (`markBattleForReview`) Y hace avanzar su match y su torneo (`settleFailedBattle`), para que
 * una batalla fallida de forma definitiva nunca deje el torneo `running` para siempre.
 * Si el avance falla, no se propaga (el worker no debe caer por esto): el rescate periódico
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
  } catch {
    /* lo recoge el rescate periódico */
  }
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
