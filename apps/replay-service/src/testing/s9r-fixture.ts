/**
 * SÓLO TESTS. Fixtures S9R/1: `writeS9rReplay`/`readS9rReplay` (ver s9r/replay-file.ts) y el
 * inventario `replay_artifacts` que el worker deja al publicar (`registerS9rReplay`).
 */
import type { Knex } from "knex";
import type { S9rFixture } from "../s9r/replay-file.js";

export { writeS9rReplay, readS9rReplay, type S9rFixture } from "../s9r/replay-file.js";

/**
 * Inventario (`replay_artifacts`) del replay de un fixture, como lo deja el worker al publicar:
 * la API sólo sirve la vista si su sha coincide con `view_sha256`. Llamar tras insertar la batalla.
 */
export async function registerS9rReplay(
  db: Knex,
  battleId: string,
  fx: S9rFixture,
  opts: { class?: "official" | "tournament" | "practice" } = {},
): Promise<void> {
  await db("replay_artifacts").insert({
    battle_id: battleId,
    state: "published",
    class: opts.class ?? "practice",
    attempt: fx.attempt,
    owner: "fixture",
    recipe_path: fx.path,
    recipe_sha256: fx.sha256,
    recipe_bytes: fx.recipeBytes,
    view_path: fx.viewPath,
    view_sha256: fx.viewSha256,
    view_bytes: fx.viewBytes,
    chain_hash: fx.chain,
    view_chain_hash: fx.viewChain,
    ticks: fx.ticks,
  });
}
