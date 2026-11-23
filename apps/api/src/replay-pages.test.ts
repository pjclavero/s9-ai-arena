/**
 * V1 REPLAYS PR-4 · RP1 · El helper de los tests de navegador (`collectReplaySnapshots`, que usa
 * `replaySnapshots` de review-lib) lee una batalla de MÁS de 1200 ticks por la API real con el
 * tope de segmento y devuelve TODAS sus instantáneas, en orden y SIN duplicados (los segmentos se
 * solapan desde el keyframe anterior). Mutantes: replay-pr4-mutants.mjs (M-RP1-*).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { IdleBot } from "../../arena-engine/src/stubs.js";
import { registerS9rReplay, writeS9rReplay } from "../../replay-service/src/testing/s9r-fixture.js";
import { collectReplaySnapshots, SEGMENT_CHUNK_TICKS } from "../../../tests/browser/specs/replay-pages.js";

let h: TestDbHandle;
let app: Express;
let admin: string;
let dir: string;
let replay: Replay;
let battleId: string;

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 } });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  replay = await record(
    {
      battleId: "rp1",
      seed: "rp1",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 4000 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new IdleBot("bot_red"));
      b.attachBot("v_blue", new IdleBot("bot_blue"));
    },
  );
  dir = mkdtempSync(join(tmpdir(), "rp1-"));
  const fx = await writeS9rReplay(dir, replay, { viewFragmentBytes: 32 * 1024 });
  battleId = randomUUID();
  await h.db("battles").insert({
    id: battleId,
    status: "finished",
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    replay_ref: fx.path,
    replay_hash: fx.sha256,
    result: JSON.stringify({ score: replay.result.score, ticks: replay.result.ticks }),
    finished_at: h.db.fn.now(),
  });
  await registerS9rReplay(h.db, battleId, fx);
}, 180_000);
afterAll(async () => {
  await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("RP1 · paginación del helper de replays de los tests de navegador", () => {
  it("una batalla de más de 1200 ticks: todas las instantáneas, en orden y sin duplicados", async () => {
    expect(replay.result.ticks).toBeGreaterThan(2 * SEGMENT_CHUNK_TICKS);
    const calls: [number, number][] = [];
    const got = await collectReplaySnapshots(async (from, to) => {
      calls.push([from, to]);
      const r = await request(app)
        .get(`/replays/${battleId}/segment?fromTick=${from}&toTick=${to}`)
        .set("Authorization", `Bearer ${admin}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    }, replay.result.ticks);
    expect(calls.length).toBeGreaterThan(2); // de verdad pagina
    const ticks = got.map((s) => s.tick);
    expect(new Set(ticks).size).toBe(ticks.length); // sin duplicados
    expect(ticks).toEqual(replay.snapshots.map((s) => s.tick)); // todas y en orden
  }, 120_000);
});
