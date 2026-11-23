/**
 * V1 REPLAYS · PR-3 · Cableado ReplaySink → S9R/1 en el worker y `finishBattle`, con PostgreSQL
 * embebida, el MOTOR REAL en proceso (agentes stub) y escritura REAL a un disco temporal.
 *
 * CONDICIÓN OBLIGATORIA DEL OPERADOR: un fallo de grabación o de publicación es un FALLO TÉCNICO.
 * Para cada clase de fallo (W1 sink a mitad por cola llena, W2 ENOSPC a mitad, W3 publicación):
 *   - la batalla acaba `failed` / `failure_kind=infrastructure`, con motivo en el trabajo;
 *   - NUNCA `finished` (ni completed, ni empate, ni victoria): result, outcome y replay_ref nulos;
 *   - 0 `rating_events`, `ratings` y `standings` intactos;
 *   - el match y el torneo se cierran como fallo técnico (lógica de #329: reintentos agotados →
 *     `onBattleJobExhausted` → match `failed` sin ganador, torneo `finished`);
 *   - ningún `.s9r`/`.s9v` publicado, ningún `.part` residual, ninguna fila en replay_artifacts.
 * W4 camino feliz: los dos ficheros se publican, verifican ok:true con el sha de la BD, la receta
 *    RE-SIMULA el mismo resultado (verify del motor) y la fila de replay_artifacts cuadra.
 * W5 reserva perdida antes del cierre: no se publica nada y los `.part` del intento se borran.
 * W6 (PR-4) la batalla nueva se consulta entera por la API con los lectores S9R/1: detalle, listado,
 *    estadísticas «ready», índice, segmento, verify (matches) y crudo con su sha.
 * Mutantes: apps/replay-service/scripts/replay-pr3-mutants.mjs (cada uno muere por su W<n>).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { verify, type Replay } from "../../arena-engine/src/replay.js";
import { S9rReader } from "../../replay-service/src/s9r/reader.js";
import { verifyFile } from "../../replay-service/src/s9r/verify.js";
import { faultFs, type FaultFs } from "../../replay-service/tests/s9r/fault-fs.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers, makeEngineExecutor, type AgentDriver } from "./engine-executor.js";
import { makeRunBattleHandler, type BattleExecutor } from "./battle-runner.js";
import { handleGenerateSchedule } from "./scheduler.js";
import type { JobRow } from "./queue.js";
import { createPublishedBot } from "./testing/fixtures.js";

type Row = Record<string, any>;

let h: TestDbHandle;
let app: Express;
let organizer: string;
let admin: string;
let n = 0;
const hung: FaultFs[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  admin = await tokenFor(h.db, DEV_USERS.admin);
}, 180_000);
afterAll(async () => {
  for (const f of hung) f.release();
  await h.stop();
});

/** Torneo round robin de 2 bots: 1 match, 1 batalla oficial `scheduled` y su trabajo `run_battle`. */
async function scheduleTournament(): Promise<{ tid: string; battleId: string; botIds: string[] }> {
  const bots = [await createPublishedBot(h.db, `pr3-${++n}-a`), await createPublishedBot(h.db, `pr3-${n}-b`)];
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({
      name: `pr3-${n}`,
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: "mvp-default",
      roundsPerPairing: 1,
    });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const tid = t.body.id as string;
  for (const b of bots) {
    await h.db("entries").insert({
      tournament_id: tid,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
  }
  const close = await request(app)
    .post(`/tournaments/${tid}/actions/close-entries`)
    .set("Authorization", `Bearer ${organizer}`);
  expect(close.status, JSON.stringify(close.body)).toBe(200);
  const gen = await h
    .db("jobs")
    .where({ dedupe_key: `generate_schedule:${tid}` })
    .first();
  await handleGenerateSchedule(gen as JobRow, { db: h.db, workerId: "pr3-sched" });
  const battle = await h.db("battles").where({ tournament_id: tid }).first();
  return { tid, battleId: battle.id as string, botIds: bots.map((b) => b.botId) };
}

/**
 * Driver EN PROCESO que NO drena la cola (como el directo real, que avanza a ritmo de reloj y no
 * espera al disco): con el disco atascado, la cola se llena y el sink lanza a mitad de batalla.
 */
function noDrainDriver(): AgentDriver {
  return {
    kind: "in_process_stub",
    async run({ engine, vehicles }) {
      for (const v of vehicles) engine.attachBot(v.vehicleId, new HunterBot(v.botId));
      while (!engine.isFinished() && engine.tick < 100_000) {
        engine.step();
        if (engine.tick % 25 === 0) await new Promise((r) => setImmediate(r));
      }
      return { result: engine.run(100_000) };
    },
  };
}

interface Rig {
  replaysDir: string;
  worker: TournamentWorker;
}

async function rig(opts: {
  fs?: FaultFs;
  agents?: AgentDriver;
  recorderOverrides?: Parameters<typeof makeEngineExecutor>[0]["recorderOverrides"];
  wrapExecutor?: (inner: BattleExecutor) => BattleExecutor;
}): Promise<Rig> {
  const replaysDir = mkdtempSync(join(tmpdir(), "pr3-wiring-"));
  const base = {
    db: h.db,
    ...(opts.agents ? { agents: opts.agents } : { agentResolver: (botId: string) => new HunterBot(botId) }),
    rulesetOverrides: { timeLimitTicks: 600 },
    replaysDir,
    ...(opts.fs ? { replayFs: opts.fs } : {}),
    ...(opts.recorderOverrides ? { recorderOverrides: opts.recorderOverrides } : {}),
  };
  const wired = await makeDefaultHandlers(base);
  const handlers = { ...wired.handlers };
  if (opts.wrapExecutor) {
    handlers.run_battle = makeRunBattleHandler({
      executor: opts.wrapExecutor(makeEngineExecutor(base)),
      replaysDir,
      ...(opts.fs ? { replayFs: opts.fs } : {}),
    });
  }
  const worker = new TournamentWorker({
    db: h.db,
    workerId: `pr3-w${++n}`,
    handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job), // = onBattleJobExhausted (main.ts)
  });
  return { replaysDir, worker };
}

/** Procesa la cola saltando el backoff de los reintentos (reloj inyectado), hasta vaciarla. */
async function drainAll(w: TournamentWorker): Promise<void> {
  for (let i = 1; i <= 12; i++) {
    if ((await w.drain(100, new Date(Date.now() + i * 300_000))) === 0 && i > 3) return;
  }
}

async function sportingSnapshot(botIds: string[], tid: string) {
  return {
    ratings: await h.db("ratings").whereIn("bot_id", botIds).orderBy("bot_id"),
    standings: await h.db("standings").whereIn("bot_id", botIds).orderBy("bot_id"),
    ratingEvents: await h.db("rating_events").whereIn("bot_id", botIds).count({ n: "*" }),
    tid,
  };
}

function filesIn(dir: string): { finals: string[]; partials: string[] } {
  const finals = readdirSync(dir).filter((f) => f.endsWith(".s9r") || f.endsWith(".s9v"));
  const pdir = join(dir, ".partial");
  return { finals, partials: existsSync(pdir) ? readdirSync(pdir) : [] };
}

/** La condición del operador, idéntica para las tres clases de fallo. */
async function expectTechnicalFailure(
  s: { tid: string; battleId: string; botIds: string[] },
  r: Rig,
  before: Awaited<ReturnType<typeof sportingSnapshot>>,
  reason: RegExp,
) {
  const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
  expect(b.status).toBe("failed");
  expect(b.failure_kind).toBe("infrastructure");
  expect(b.result).toBeNull();
  expect(b.replay_ref).toBeNull();
  expect(b.replay_hash).toBeNull();
  expect(b.final_state_hash).toBeNull();
  expect(b.run_attempts).toBeGreaterThanOrEqual(3); // la política de reintento existente se aplicó
  const parts = await h.db("participants").where({ battle_id: s.battleId });
  expect(parts.map((p: Row) => p.outcome)).toEqual([null, null]);
  const job = (await h
    .db("jobs")
    .where({ dedupe_key: `run_battle:${s.battleId}` })
    .first()) as Row;
  expect(job.status).toBe("needs_review");
  expect(job.error_class).toBe("infrastructure");
  expect(String(job.last_error)).toMatch(/storage_unavailable/);
  expect(String(job.last_error)).toMatch(reason);
  expect(await h.db("rating_events").where({ battle_id: s.battleId })).toHaveLength(0);
  expect(await sportingSnapshot(s.botIds, s.tid)).toEqual(before);
  // #329 · match y torneo se cierran como fallo técnico (sin ganador).
  const m = await h.db("matches").where({ tournament_id: s.tid }).select("state", "winner_bot_id");
  expect(m).toEqual([{ state: "failed", winner_bot_id: null }]);
  expect((await h.db("tournaments").where({ id: s.tid }).first()).state).toBe("finished");
  expect(await h.db("replay_artifacts").where({ battle_id: s.battleId })).toHaveLength(0);
  expect(filesIn(r.replaysDir)).toEqual({ finals: [], partials: [] });
}

describe("V1 REPLAYS PR-3 · fallo de grabación o publicación = fallo técnico (condición del operador)", () => {
  it("W1 sink a mitad (cola llena con el disco atascado): failed/infrastructure, sin Elo ni standings", async () => {
    const fs = faultFs({ hangWriteAfterBytes: 2048, match: ".s9v.part" });
    hung.push(fs);
    const r = await rig({
      fs,
      agents: noDrainDriver(),
      recorderOverrides: { viewFragmentBytes: 4096, viewMaxPendingBytes: 32 * 1024 },
    });
    const s = await scheduleTournament();
    const before = await sportingSnapshot(s.botIds, s.tid);
    await drainAll(r.worker);
    await expectTechnicalFailure(s, r, before, /recording_fault: stream=(snapshots|events).*recording_backpressure/);
  }, 120_000);

  it("W2 ENOSPC a mitad de la batalla: failed/infrastructure, sin Elo ni standings", async () => {
    const fs = faultFs({ failWriteAfterBytes: 1200, match: ".s9v.part", errCode: "ENOSPC" });
    const r = await rig({ fs, recorderOverrides: { viewFragmentBytes: 1024, viewMaxPendingBytes: 256 * 1024 } });
    const s = await scheduleTournament();
    const before = await sportingSnapshot(s.botIds, s.tid);
    await drainAll(r.worker);
    expect(fs.failedWrites).toBeGreaterThan(0);
    await expectTechnicalFailure(s, r, before, /recording_fault: .*storage_full/);
  }, 120_000);

  it("W3 fallo de publicación (link de la receta con EIO): rollback, failed/infrastructure, nada publicado", async () => {
    const fs = faultFs({ failLinkTo: ".s9r", errCode: "EIO" });
    const r = await rig({ fs });
    const s = await scheduleTournament();
    const before = await sportingSnapshot(s.botIds, s.tid);
    await drainAll(r.worker);
    await expectTechnicalFailure(s, r, before, /replay_publish_failed/);
  }, 120_000);
});

describe("V1 REPLAYS PR-3 · publicación real", () => {
  it("W4 batalla completa: receta y vista publicadas, verifican ok:true con el sha de la BD y la receta re-simula el resultado", async () => {
    const r = await rig({});
    const s = await scheduleTournament();
    await drainAll(r.worker);
    const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    expect(b.status).toBe("finished");
    const art = (await h.db("replay_artifacts").where({ battle_id: s.battleId }).first()) as Row;
    expect(art).toBeTruthy();
    expect(art.state).toBe("published");
    expect(art.class).toBe("official");
    expect(art.attempt).toBe(b.run_attempts);
    expect(art.truncated).toBe(false);
    expect(b.replay_ref).toBe(join(r.replaysDir, `${s.battleId}.${b.run_attempts}.s9r`));
    expect(art.recipe_path).toBe(b.replay_ref);
    expect(art.view_path).toBe(join(r.replaysDir, `${s.battleId}.${b.run_attempts}.s9v`));
    expect(b.replay_hash).toBe(art.recipe_sha256);
    expect(filesIn(r.replaysDir).partials).toEqual([]);
    const vr = await verifyFile(art.recipe_path, { expectSha256: art.recipe_sha256, expectBattleId: s.battleId });
    const vv = await verifyFile(art.view_path, { expectSha256: art.view_sha256, expectBattleId: s.battleId });
    expect(vr.ok).toBe(true);
    expect(vv.ok).toBe(true);
    expect(Number(art.recipe_bytes)).toBe(vr.bytes);
    expect(Number(art.view_bytes)).toBe(vv.bytes);
    // El resultado de la receta es el de la BD.
    const reader = await S9rReader.open(art.recipe_path, { expectBattleId: s.battleId });
    const result = (await reader.readResult()) as Row;
    expect(result.finalStateHash).toBe(b.final_state_hash);
    expect(result.winner).toBe(b.result.winner);
    expect(result.ticks).toBe(b.result.ticks);
    expect(result.score).toEqual(b.result.score);
    expect(art.ticks).toBe(b.result.ticks);
    // La receta basta para re-simular la batalla con el motor (verify): mismo hash final y hashes intermedios.
    const replay: Replay = {
      header: reader.header as any,
      commands: [],
      events: [],
      snapshots: [],
      stateHashes: [],
      checkpoints: [],
      result: result as any,
    };
    const last = new Map<string, unknown>();
    for await (const line of reader.records()) {
      const x = JSON.parse(line);
      if (x.k === "c") {
        const command = x["="] === 1 ? last.get(x.v) : x.c;
        last.set(x.v, command);
        replay.commands.push({ tick: x.t, vehicleId: x.v, command });
      } else if (x.k === "h") replay.stateHashes.push({ tick: x.t, hash: x.hash });
      else if (x.k === "k") replay.checkpoints.push({ tick: x.t, hash: x.hash, components: x.components });
    }
    await reader.close();
    expect(replay.commands.length).toBeGreaterThan(0);
    const verdict = await verify(replay);
    expect(verdict.matches, JSON.stringify(verdict)).toBe(true);
  }, 120_000);

  it("W5 reserva perdida antes del cierre: no se publica nada y los .part del intento se borran", async () => {
    const r = await rig({
      wrapExecutor: (inner) => async (ctx) => {
        const out = await inner(ctx);
        expect(out.recording && existsSync(out.recording.recipe.partial)).toBe(true);
        await h.db("battles").where({ id: ctx.battle.id }).update({ claimed_by: "otro-titular" });
        return out;
      },
    });
    const s = await scheduleTournament();
    await r.worker.runOnce(new Date(Date.now() + 1000)); // generate/run: lo que toque primero
    await r.worker.runOnce(new Date(Date.now() + 2000));
    const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    expect(b.status).toBe("running");
    expect(b.claimed_by).toBe("otro-titular");
    expect(b.replay_ref).toBeNull();
    expect(await h.db("replay_artifacts").where({ battle_id: s.battleId })).toHaveLength(0);
    expect(filesIn(r.replaysDir)).toEqual({ finals: [], partials: [] });
  }, 120_000);

  it("W6 (PR-4) una batalla nueva se consulta ENTERA por la API: detalle, listado, estadísticas, índice, segmento, verify y crudo", async () => {
    const r = await rig({});
    const s = await scheduleTournament();
    await drainAll(r.worker);
    const auth = { Authorization: `Bearer ${admin}` };
    const detail = await request(app).get(`/battles/${s.battleId}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("finished");
    const list = await request(app).get(`/replays`).set(auth);
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: Row) => i.battleId === s.battleId);
    expect(item.sizeBytes).toBeGreaterThan(0);
    const stats = await request(app).get(`/battles/${s.battleId}/stats`).set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.status).toBe("ready");
    const idx = await request(app).get(`/replays/${s.battleId}/index`).set(auth);
    expect(idx.status).toBe(200);
    expect(idx.body.snapshotCount).toBeGreaterThan(0);
    const seg = await request(app).get(`/replays/${s.battleId}/segment?fromTick=0&toTick=30`).set(auth);
    expect(seg.status).toBe(200);
    expect(seg.body.snapshots.length).toBeGreaterThan(0);
    const v = await request(app).post(`/replays/${s.battleId}/verify`).set(auth);
    expect(v.status).toBe(200);
    expect(v.body.matches).toBe(true);
    const raw = await request(app).get(`/replays/${s.battleId}`).set(auth).buffer(true);
    expect(raw.status).toBe(200);
    expect(raw.headers["x-replay-sha256"]).toBe((await h.db("battles").where({ id: s.battleId }).first()).replay_hash);
  }, 120_000);
});
