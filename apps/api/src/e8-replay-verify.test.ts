/**
 * E8/T8.1 · La operación `verifyReplay` del contrato (pendiente declarada por E7)
 * implementada de verdad: replay REAL del motor de E2, almacenado por el
 * replay-service, referenciado por battles.replay_ref en PostgreSQL real (embebido,
 * ADR-E7-002) y verificado por re-simulación a través de la API pública.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay, type StoredReplay } from "../../replay-service/src/store.js";
import { implementedOperations } from "./registry.js";

let h: TestDbHandle;
let app: Express;
let replay: Replay;
let stored: StoredReplay;
let battleId: string;
let dir: string;

async function insertBattle(db: TestDbHandle["db"], replayRef: string | null, extra: Record<string, unknown> = {}) {
  const [row] = await db("battles")
    .insert({
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "e8-verify",
      replay_ref: replayRef,
      ...extra,
    })
    .returning("*");
  return row.id as string;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 1000, windowMs: 3600_000 } });

  // Batalla REAL de E2, almacenada por el replay-service (política 23.1: archivo + ref).
  replay = await record(
    {
      battleId: "e8_verify_api",
      seed: "e8_verify_api",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 240 }),
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
  dir = mkdtempSync(join(tmpdir(), "e8-api-replays-"));
  stored = ingestReplay(dir, replay, { official: true });
  battleId = await insertBattle(h.db, stored.path, {
    replay_hash: stored.index.sha256,
    final_state_hash: replay.result.finalStateHash,
    engine_versions: JSON.stringify(replay.header.versions),
    result: JSON.stringify({ score: replay.result.score, ticks: replay.result.ticks }),
  });
}, 180000);

afterAll(async () => {
  await h.stop();
});

describe("verifyReplay (operación 53/53 del contrato de E1)", () => {
  it("verifyReplay está registrada como operación implementada del contrato", () => {
    expect(implementedOperations.some((o) => o.operationId === "verifyReplay")).toBe(true);
  });

  it("un visitante anónimo verifica un replay oficial: matches=true con hashes", async () => {
    const r = await request(app).post(`/replays/${battleId}/verify`);
    expect(r.status).toBe(200);
    expect(r.body.matches).toBe(true);
    expect(r.body.valid).toBe(true);
    expect(r.body.officialHash).toBe(replay.result.finalStateHash);
    expect(r.body.recomputedHash).toBe(replay.result.finalStateHash);
  }, 120000);

  it("replay manipulado en disco ⇒ matches=false por checksum, sin re-simular", async () => {
    const tampered = readFileSync(stored.path);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const tPath = join(dir, "tampered.replay");
    writeFileSync(tPath, tampered);
    const id = await insertBattle(h.db, tPath, { replay_hash: stored.index.sha256 });

    const r = await request(app).post(`/replays/${id}/verify`);
    expect(r.status).toBe(200);
    expect(r.body.matches).toBe(false);
    expect(r.body.valid).toBe(false);
    expect(r.body.reason).toBe("checksum_mismatch");
  });

  it("si la BD registra otro final_state_hash que el archivo, no cuela", async () => {
    const id = await insertBattle(h.db, stored.path, {
      replay_hash: stored.index.sha256,
      final_state_hash: "f".repeat(64), // resultado oficial distinto del archivo
    });
    const r = await request(app).post(`/replays/${id}/verify`);
    expect(r.status).toBe(200);
    expect(r.body.matches).toBe(false);
    expect(r.body.reason).toBe("final_state_hash_mismatch_with_db");
  }, 120000);

  it("batalla sin replay ⇒ 404; batalla inexistente ⇒ 404", async () => {
    const sinReplay = await insertBattle(h.db, null);
    expect((await request(app).post(`/replays/${sinReplay}/verify`)).status).toBe(404);
    expect((await request(app).post(`/replays/00000000-0000-4000-8000-000000000000/verify`)).status).toBe(404);
  });
});
