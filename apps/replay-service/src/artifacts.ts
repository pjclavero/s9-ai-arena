/**
 * V1 REPLAYS · PR-3 · Publicación de un replay S9R/1 grabado y su fila en `replay_artifacts`.
 *
 * Se llama DENTRO de la transacción de cierre de la batalla (`finishBattle`) y DESPUÉS de que el
 * `UPDATE battles … WHERE claimed_by = :yo` haya casado. Orden:
 *   1. fila `replay_artifacts` (state `published`) y `battles.replay_ref`/`replay_hash` (invisibles
 *      hasta el COMMIT);
 *   2. `publishPair` con las PRUEBAS de cierre reales del escritor (`proof` = summary de la receta,
 *      `viewProof` = summary de la vista): vista primero, receta al final, todo o nada, sin
 *      sobrescribir. NUNCA `unsafeSkipProof`.
 * Un fallo en cualquiera de los dos pasos lanza `ReplayPublishError` (el llamador hace rollback y
 * lo clasifica como fallo técnico). Si el COMMIT fallara DESPUÉS de enlazar, quedan ficheros finales
 * sin fila (`<battleId>.<attempt>.s9r`): no chocan con el reintento (otro intento, otro nombre) y
 * el janitor de PR-6 los detecta. Los parciales del intento los descarta quien los grabó.
 */
import type { Knex } from "knex";
import { S9rError } from "./s9r/errors.js";
import { publishPair } from "./s9r/publish.js";
import type { ClosedRecording } from "./s9r/recorder.js";
import type { S9rFs } from "./s9r/io.js";

/** ¿`battles.replay_ref` apunta a una receta S9R/1? (los lectores de PR-4 sólo aceptarán éstas). */
export function isS9rReplayRef(ref: unknown): boolean {
  return typeof ref === "string" && ref.endsWith(".s9r");
}

export type ReplayClass = "official" | "tournament" | "practice";

export function replayClassOf(battle: { official?: boolean | null; tournament_id?: string | null }): ReplayClass {
  if (battle.official) return "official";
  return battle.tournament_id ? "tournament" : "practice";
}

/** La publicación (o su fila) falló: nada queda publicado para el intento. */
export class ReplayPublishError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "ReplayPublishError";
    this.code = code;
  }
}

export interface PublishRecordingOptions {
  fs?: S9rFs;
  /**
   * PR-5 · publicar un replay TRUNCADO (clase A: la batalla superó su tope de bytes). Sólo lo pide
   * `finishBattle` cuando la batalla termina con `endReason: recording_limit`: un truncado nunca se
   * publica bajo un resultado normal.
   */
  allowTruncated?: boolean;
}

export async function publishRecording(
  trx: Knex | Knex.Transaction,
  battle: { id: string; official?: boolean | null; tournament_id?: string | null },
  rec: ClosedRecording,
  opts: PublishRecordingOptions = {},
): Promise<{ replayRef: string; replayHash: string }> {
  if (rec.battleId !== battle.id) {
    throw new ReplayPublishError("battle_mismatch", `la grabación es de ${rec.battleId}, no de ${battle.id}`);
  }
  const r = rec.recipe.summary;
  const v = rec.view.summary;
  const truncated = r.truncated || v.truncated;
  if (truncated && !opts.allowTruncated) {
    throw new ReplayPublishError(
      "truncated_not_allowed",
      "replay truncado bajo un resultado que no es recording_limit",
    );
  }
  try {
    await trx("replay_artifacts").insert({
      battle_id: battle.id,
      state: "published",
      class: replayClassOf(battle),
      attempt: rec.attempt,
      owner: rec.owner,
      recipe_path: rec.recipe.final,
      recipe_sha256: r.sha256,
      recipe_bytes: r.bytes,
      view_path: rec.view.final,
      view_sha256: v.sha256,
      view_bytes: v.bytes,
      chain_hash: r.chain,
      view_chain_hash: v.chain,
      ticks: rec.ticks,
      truncated,
      // Un replay truncado no se puede re-simular (receta incompleta): no hay estadísticas que calcular.
      ...(truncated ? { stats_state: "not_applicable" } : {}),
    });
    await trx("battles").where({ id: battle.id }).update({ replay_ref: rec.recipe.final, replay_hash: r.sha256 });
  } catch (e) {
    throw new ReplayPublishError("artifact_row_failed", `fila replay_artifacts: ${(e as Error).message}`, {
      cause: e,
    });
  }
  try {
    await publishPair(
      {
        recipe: { partial: rec.recipe.partial, final: rec.recipe.final },
        view: { partial: rec.view.partial, final: rec.view.final },
      },
      { proof: r, viewProof: v, ...(opts.fs ? { fs: opts.fs } : {}), ...(truncated ? { allowTruncated: true } : {}) },
    );
  } catch (e) {
    const code = e instanceof S9rError ? e.code : "publish_failed";
    throw new ReplayPublishError(code, `publicación del replay: ${(e as Error).message}`, { cause: e });
  }
  return { replayRef: rec.recipe.final, replayHash: r.sha256 };
}
