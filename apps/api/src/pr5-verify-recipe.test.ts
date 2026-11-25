/**
 * V1 REPLAYS PR-5 · `verifyRecipe` con una fila hecha a mano. Rama del FICHERO: la batalla NO está marcada
 * `recording_limit` pero su receta es un truncado legítimo (íntegro, con su sha): se dice `truncated`, no `corrupt_file`.
 * Rama de la BATALLA: marcada `recording_limit` se rechaza antes de abrir el fichero (aunque no exista).
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S9rWriter } from "../../replay-service/src/s9r/writer.js";
import { verifyRecipe } from "./replay-s9r.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function truncatedRecipe(): Promise<{ path: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pr5-verify-"));
  dirs.push(dir);
  const path = join(dir, "b.1.s9r");
  const w = await S9rWriter.create(path, {
    kind: "R",
    header: { battleId: "b" },
    maxBytes: 4 * 1024 * 1024,
    fragmentBytes: 512,
  });
  for (let t = 0; t < 40; t++) await w.append(JSON.stringify({ k: "c", t, v: "veh_1", c: { n: t } }), t);
  await w.closeTruncated({ result: { winner: null } });
  return { path, sha: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

describe("PR-5 · verifyRecipe", () => {
  it("VR1 receta truncada íntegra en una batalla NO marcada: reason «truncated», no «corrupt_file»", async () => {
    const { path, sha } = await truncatedRecipe();
    const out = await verifyRecipe({ id: "b", replay_ref: path, replay_hash: sha, result: { endReason: "completed" } });
    expect(out).toMatchObject({ matches: false, valid: false, reason: "truncated" });
    expect(String(out.message)).toMatch(/truncado/);
  });

  it("VR2 batalla marcada recording_limit: se rechaza por la batalla sin tocar el fichero", async () => {
    const out = await verifyRecipe({
      id: "b",
      replay_ref: "/no/existe.s9r",
      replay_hash: "0".repeat(64),
      result: { endReason: "recording_limit" },
    });
    expect(out).toMatchObject({ matches: false, valid: false, reason: "truncated" });
  });
});
