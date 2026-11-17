/**
 * ADR-024 · motor 0.5.0: una sola subida de versión para toda la OLA 2.
 *
 * G1 (HE contra muro, también con la boca enterrada) y G3 (la cabecera exige la política
 * de rearme) cambian la simulación o lo que `verify()` acepta. Un replay v2 grabado con las
 * builds de hardening anteriores (motor 0.4.0) NO se puede re-simular con este motor:
 *   - sin la subida, el caso HE-muro divergiría en silencio (`matches=false`, que se lee
 *     como «manipulado») y el caso con respawn sin política daría `rules_incomplete`;
 *   - con la subida, los dos dan `engine_version_mismatch` («otra versión», nunca
 *     «manipulado») ANTES de re-simular.
 *
 * Las batallas son REALES (record() del motor). La única manipulación es la etiqueta de
 * versión de la cabecera, que es exactamente lo que distingue un replay 0.4.0 de uno 0.5.0
 * (el hash de estado no incluye la versión del motor).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl, record, toJsonl, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import engineDeps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { ingestReplay, verifyStored } from "../src/store.js";

beforeAll(async () => {
  await initPhysics();
});

async function recordBattle(rulesetId: string, seed: string): Promise<Replay> {
  return record(
    {
      battleId: `bat_${seed}`,
      seed,
      ruleset: loadRuleset(rulesetId, { timeLimitTicks: 240 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
}

const tmp = () => mkdtempSync(join(tmpdir(), "adr024-"));

describe("ADR-024 · motor 0.5.0 (OLA 2)", () => {
  it("el motor declara 0.5.0 y lo graba en la cabecera", async () => {
    expect(engineDeps.engine.version).toBe("0.5.0");
    const replay = await recordBattle("dm_practice@1", "adr024_cur");
    expect(replay.header.versions.engine).toBe("0.5.0");
    const dir = tmp();
    ingestReplay(dir, replay, { official: true });
    const r = await verifyStored(dir, replay.header.battleId);
    expect(r.valid).toBe(true);
    expect(r.verification!.matches).toBe(true);
  });

  it("un replay v2 de 0.4.0 da engine_version_mismatch y nunca llega a re-simular", async () => {
    const replay = fromJsonl(toJsonl(await recordBattle("dm_practice@1", "adr024_v040")));
    replay.header.versions = { ...replay.header.versions, engine: "0.4.0" };
    const dir = tmp();
    ingestReplay(dir, replay, { official: true });
    const r = await verifyStored(dir, replay.header.battleId);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("engine_version_mismatch: replay=0.4.0, motor=0.5.0");
    expect(r.verification).toBeNull();
    expect(r.message).toMatch(/0\.4\.0; la actual es 0\.5\.0/);
    expect(r.message).toMatch(/NO significa que esté manipulado/);
  });

  it("un replay v2 de 0.4.0 con respawn y sin política de rearme: la versión manda antes que rules_incomplete", async () => {
    const replay = fromJsonl(toJsonl(await recordBattle("tdm_mvp@1", "adr024_rearm")));
    expect(replay.header.ruleset.respawn.enabled).toBe(true);
    // Así eran las cabeceras v2 anteriores a G3: sin `rearmPolicy`.
    delete (replay.header.ruleset.respawn as { rearmPolicy?: string }).rearmPolicy;
    replay.header.versions = { ...replay.header.versions, engine: "0.4.0" };
    const dir = tmp();
    ingestReplay(dir, replay, { official: true });
    const r = await verifyStored(dir, replay.header.battleId);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/^engine_version_mismatch: replay=0\.4\.0, motor=0\.5\.0/);
    expect(r.verification).toBeNull();
  });
});
