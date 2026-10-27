/**
 * UX-F (DEF-R1) · Un replay grabado con el motor ANTERIOR (0.1.0, sin perímetro)
 * tiene que verificarse como «grabado con otra versión del motor», nunca como
 * «manipulado».
 *
 * El fixture NO es sintético: se grabó con el motor de `origin/main` (35a4fb9,
 * engine 0.1.0) en un árbol temporal — dos ForwardBot que salen de un mapa sin
 * muros (`v_blue` acaba en x≈201 m en un mapa de 120 m). Con el perímetro de
 * ADR-019 esa batalla ya no se puede reproducir: si la versión del motor no se
 * hubiera subido, `verify` re-simularía con las reglas nuevas y declararía el
 * replay manipulado.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import engineDeps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { ingestReplay, verifyStored } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "engine-0.1.0-sin-perimetro.replay.jsonl.gz");

beforeAll(async () => {
  await initPhysics();
});

describe("DEF-R1 · replays del motor anterior tras el perímetro", () => {
  it("el motor actual ya no es el 0.1.0 (la simulación cambió con el perímetro)", () => {
    expect(engineDeps.engine.version).not.toBe("0.1.0");
  });

  it("un replay real del motor 0.1.0 da engine_version_mismatch, no «manipulado»", async () => {
    const replay = fromJsonl(gunzipSync(readFileSync(FIXTURE)).toString("utf8"));
    expect(replay.header.versions.engine).toBe("0.1.0");
    const dir = mkdtempSync(join(tmpdir(), "uxf-r1-"));
    ingestReplay(dir, replay, { official: true });
    const r = await verifyStored(dir, replay.header.battleId);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("engine_version_mismatch");
    expect(r.reason).toContain("replay=0.1.0");
    // Nunca se llega a re-simular: no hay veredicto de manipulación.
    expect(r.verification).toBeNull();
    expect(r.message).toMatch(/grabado con otra versión del motor/);
  });
});
