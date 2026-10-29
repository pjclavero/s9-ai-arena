/**
 * [REVIEW-4v4] · ADR-020: replays REALES grabados con el motor de `e902b0a`
 * (engine 0.2.0, árbol temporal; `fixtures.mvpArena()`, HunterBot vs HunterBot,
 * tdm_mvp@1, 1200 decisiones):
 *   - `ab`: bandos A/B (torneo). Con 0.3.0 la simulación cambia desde el tick 0
 *     (ya no nacen los dos en spawns[0]): la subida de versión es NECESARIA.
 *   - `rb`: red/blue. Con 0.3.0 re-simula idéntico (mismo hash en cada tick).
 * Ambos, por versión, dan `engine_version_mismatch` honesto y nunca «manipulado».
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl, verify } from "../../arena-engine/src/replay.js";
import { ingestReplay, verifyStored } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (n: string) =>
  fromJsonl(
    gunzipSync(readFileSync(join(__dirname, "fixtures", `review-engine-0.2.0-${n}.replay.jsonl.gz`))).toString("utf8"),
  );

beforeAll(async () => {
  await initPhysics();
});

describe("[REVIEW-4v4] replays 0.2.0 frente al motor 0.3.0", () => {
  for (const n of ["ab", "rb"]) {
    it(`${n}: engine_version_mismatch, no «manipulado»`, async () => {
      const replay = load(n);
      expect(replay.header.versions.engine).toBe("0.2.0");
      const dir = mkdtempSync(join(tmpdir(), "rv4v4-ver-"));
      ingestReplay(dir, replay, { official: true });
      const r = await verifyStored(dir, replay.header.battleId);
      expect(r.valid).toBe(false);
      expect(r.reason).toContain("engine_version_mismatch");
      expect(r.verification).toBeNull();
    });
  }

  it("A/B: la re-simulación 0.3.0 diverge en el tick 0 (la subida a 0.3.0 está justificada)", async () => {
    const raw = await verify(load("ab"));
    expect(raw.matches).toBe(false);
    expect(raw.divergedAtTick).toBe(0);
  });

  it("red/blue 1v1 sin respawn sobre punto ocupado: idéntico tick a tick", async () => {
    const raw = await verify(load("rb"));
    expect(raw.matches).toBe(true);
  });
});
