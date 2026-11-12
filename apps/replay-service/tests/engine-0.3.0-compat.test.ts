/**
 * ADR-022 · Replays HISTÓRICOS 0.3.0 frente al motor 0.4.0.
 *
 * Los fixtures NO son sintéticos: se grabaron con el motor de producción (`origin/main`
 * a1a6c4e, engine 0.3.0) en un árbol temporal (`git archive origin/main`), con stubs
 * del propio motor:
 *   - dm-1v1  · dm_practice@1 (sin respawn), HunterBot vs HunterBot en arena abierta;
 *   - tdm-4v4 · tdm_mvp@1 (respawn ilimitado), 4 HunterBot por bando, 8-7;
 *   - ctf-1v1 · ctf_mvp@1, FlagRunnerBot vs IdleBot, 2 capturas.
 * El motor 0.4.0 debe re-simularlos IDÉNTICOS tick a tick y la verificación debe decir
 * con qué motor se ha hecho (`verifiedWith`), sin reescribir la versión grabada.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl, toJsonl, verify } from "../../arena-engine/src/replay.js";
import engineDeps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { engineCanVerify } from "../../arena-engine/src/engine-compat.js";
import { ingestReplay, verifyStored } from "../src/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (n: string) =>
  fromJsonl(
    gunzipSync(readFileSync(join(__dirname, "fixtures", `engine-0.3.0-${n}.replay.jsonl.gz`))).toString("utf8"),
  );

/** Resultado grabado por el motor 0.3.0 (impreso al grabar los fixtures). */
const RECORDED: Record<string, { winner: string; score: Record<string, number>; ticks: number; hash: string }> = {
  "dm-1v1": {
    winner: "blue",
    score: { blue: 1, red: 0 },
    ticks: 436,
    hash: "ae1557e827badfb29823419944b5ac1e7c9596a90527c0382277dc9df82f28dd",
  },
  "tdm-4v4": {
    winner: "blue",
    score: { blue: 8, red: 7 },
    ticks: 3296,
    hash: "6e27e0331cba93a0970b502d02260cbce588f5b06998ed4519c26bc5a2a744c5",
  },
  "ctf-1v1": {
    winner: "red",
    score: { blue: 0, red: 2 },
    ticks: 1365,
    hash: "ad3a0e8a1e72e868a19490f31a96381fb7307c3f382fe89791bde20b00411d1f",
  },
};

beforeAll(async () => {
  await initPhysics();
});

describe("ADR-022 · el motor 0.4.0 verifica los replays históricos 0.3.0", () => {
  it("el motor es 0.4.0 y declara que reproduce 0.3.0", () => {
    expect(engineDeps.engine.version).toBe("0.4.0");
    expect((engineDeps.engine as { reproduces?: string[] }).reproduces).toEqual(["0.3.0"]);
  });

  // OLA 2 · MC (decisión de M0: BACKWARD_COMPATIBILITY_REQUIRED=NO): el alcance del proyectil
  // se deriva SIEMPRE de weapon.rangeM y la velocidad; ya no existe la regla heredada de 90
  // ticks. Los replays 0.3.0 con armas (specs grabadas con rangeM 60/55 y TTL fijo 90) dejan de
  // re-simularse idénticos: la verificación DEBE detectarlo (divergencia), no darlo por bueno.
  // El replay sin disparos (ctf-1v1) sigue siendo idéntico.
  const ARMED_NOT_REPRODUCIBLE = new Set(["dm-1v1", "tdm-4v4"]);
  for (const n of Object.keys(RECORDED).filter((k) => ARMED_NOT_REPRODUCIBLE.has(k))) {
    it(`${n}: ya NO se re-simula idéntico (sin regla heredada de 90 ticks): la divergencia se detecta`, async () => {
      const raw = await verify(load(n));
      expect(raw.matches).toBe(false);
      expect(raw.divergedAtTick).not.toBeNull();
    }, 120_000);
  }
  for (const n of Object.keys(RECORDED).filter((k) => !ARMED_NOT_REPRODUCIBLE.has(k))) {
    it(`${n}: re-simulación idéntica tick a tick y verificación válida «con 0.4.0»`, async () => {
      const replay = load(n);
      expect(replay.header.versions.engine).toBe("0.3.0");
      expect(replay.result.winner).toBe(RECORDED[n].winner);
      expect(replay.result.score).toEqual(RECORDED[n].score);
      expect(replay.result.ticks).toBe(RECORDED[n].ticks);
      expect(replay.result.finalStateHash).toBe(RECORDED[n].hash);

      const raw = await verify(replay);
      expect(raw.divergedAtTick).toBeNull();
      expect(raw.matches).toBe(true);
      expect(raw.recomputedHash).toBe(RECORDED[n].hash);
      expect(raw.recomputedResult.winner).toBe(RECORDED[n].winner);
      expect(raw.recomputedResult.score).toEqual(RECORDED[n].score);

      const dir = mkdtempSync(join(tmpdir(), "eq2-030-"));
      ingestReplay(dir, replay, { official: true });
      const r = await verifyStored(dir, replay.header.battleId);
      expect(r.valid).toBe(true);
      expect(r.verification?.matches).toBe(true);
      expect(r.verifiedWith).toBe("0.4.0");
      expect(r.compat).toBe(true);
    }, 120_000);
  }

  it("un replay que dice ser 0.3.0 pero declara reglas de 0.4.0 NO se re-simula (engine_rules_mismatch)", async () => {
    for (const extra of [
      { timeoutTiebreak: ["score"] },
      { overtime: { kind: "next_score_wins", maxTicks: 10 } },
      { respawn: { enabled: true, delayTicks: 150, maxRespawns: 2 } },
    ]) {
      const forged = fromJsonl(toJsonl(load("dm-1v1")));
      forged.header.ruleset = { ...forged.header.ruleset, ...extra };
      const d = engineCanVerify(forged.header);
      expect(d.ok).toBe(false);
      const dir = mkdtempSync(join(tmpdir(), "eq2-030f-"));
      ingestReplay(dir, forged, { official: true });
      const r = await verifyStored(dir, forged.header.battleId);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/^engine_rules_mismatch/);
      expect(r.verification).toBeNull();
    }
  });

  it("versiones no declaradas (0.2.0, 0.1.0, inventadas) siguen siendo engine_version_mismatch", () => {
    for (const v of ["0.2.0", "0.1.0", "9.9.9", undefined]) {
      const d = engineCanVerify({ versions: { engine: v }, ruleset: {} });
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(/^engine_version_mismatch/);
    }
    expect(engineCanVerify({ versions: { engine: "0.4.0" }, ruleset: { timeoutTiebreak: ["score"] } })).toEqual({
      ok: true,
      verifiedWith: "0.4.0",
      compat: false,
    });
  });
});
