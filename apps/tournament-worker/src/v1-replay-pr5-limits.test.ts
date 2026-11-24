/**
 * V1 REPLAYS · PR-5 · Límites de almacenamiento y fallo seguro, con PostgreSQL embebida, el MOTOR REAL
 * en proceso (agentes stub) y escritura REAL a un disco temporal.
 *
 * L1 CLASE A · el tope de la PROPIA batalla se alcanza a mitad: la batalla termina `finished` SIN resultado
 *    deportivo (`endReason: recording_limit`, winner null, outcome NULL), con el replay TRUNCADO y marcado,
 *    SIN reintento (run_attempts = 1, trabajo `done`), sin Elo ni standings, y la API responde sin 5xx.
 * L2 CLASE B · reserva de espacio libre o cuota del volumen agotadas a mitad: `storage_unavailable`, con
 *    reintento (si hay espacio después, el reintento publica) y, agotados los reintentos, fallo técnico
 *    sin efectos deportivos. Nunca replay truncado ni resultado.
 * L3 COMPUERTA PREVIA · sin hueco mínimo no se arranca ni el motor ni los contenedores (el driver no se
 *    invoca) y no se crea ningún fichero.
 * L4 EN CALIENTE · las tres claves son `system_settings` (rango validado por la API); un cambio vía API lo
 *    ve el worker (mismo lector, sin reiniciar) y cambia el comportamiento del siguiente intento.
 * L5 FAIL-CLOSED · sin lectura válida de `system_settings` valen los defectos del código.
 * L6 CABLEADO · `main.ts` pasa los límites al ejecutor.
 * L7 SIN EFECTOS DEPORTIVOS · `recording_limit` no puntúa (Elo) ni cuenta en V-D-E.
 * Mutantes: apps/replay-service/scripts/replay-pr5-mutants.mjs (cada uno muere por su L<n>/A<n>/B<n>).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { verifyFile } from "../../replay-service/src/s9r/verify.js";
import { S9rReader } from "../../replay-service/src/s9r/reader.js";
import type { StorageProbe } from "../../replay-service/src/s9r/recording-budget.js";
import { SYSTEM_SETTINGS_REGISTRY } from "../../../packages/system-settings/registry.js";
import { SystemSettingsReader } from "../../../packages/system-settings/reader.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers, type AgentDriver } from "./engine-executor.js";
import { makeRunBattleHandler, markBattleForReview, type BattleExecution } from "./battle-runner.js";
import { handleGenerateSchedule } from "./scheduler.js";
import { enqueueJob, type JobRow } from "./queue.js";
import { applyBattleRating } from "./ratings.js";
import { isTechnicalLimit } from "./results.js";
import { createBots, createPublishedBot, insertScheduledBattle } from "./testing/fixtures.js";
import { defaultReplayLimits, replayLimitsFromReader, type ReplayLimitsConfig } from "./replay-limits.js";
import { workerMetrics } from "./worker-metrics.js";

type Row = Record<string, any>;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

let h: TestDbHandle;
let app: Express;
let organizer: string;
let admin: string;
let moderator: string;
let n = 0;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
}, 180_000);
afterAll(async () => {
  await h.stop();
});

/** Torneo round robin de 2 bots: 1 match, 1 batalla oficial `scheduled` y su trabajo `run_battle`. */
async function scheduleTournament(seed?: string): Promise<{ tid: string; battleId: string; botIds: string[] }> {
  const bots = [await createPublishedBot(h.db, `pr5-${++n}-a`), await createPublishedBot(h.db, `pr5-${n}-b`)];
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({
      name: `pr5-${n}`,
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
  await handleGenerateSchedule(gen as JobRow, { db: h.db, workerId: "pr5-sched" });
  const battle = await h.db("battles").where({ tournament_id: tid }).first();
  // Semilla fija: la misma batalla (mismos ticks) con y sin tope, para comparar.
  if (seed) await h.db("battles").where({ id: battle.id }).update({ seed });
  return { tid, battleId: battle.id as string, botIds: bots.map((b) => b.botId) };
}

/**
 * Driver en proceso con HunterBot que cuenta cuántas veces se invoca (para la compuerta previa). Con `paceMs`
 * cede el bucle ese tiempo cada 25 ticks, como el directo real (a ritmo de reloj): los escritores avanzan entre
 * tandas y el fallo de grabación se nota A MITAD de la batalla, no cuando el motor ya ha terminado.
 */
function countingDriver(paceMs = 0): AgentDriver & { runs: number } {
  const d = {
    runs: 0,
    kind: "in_process_stub" as const,
    async run({ engine, vehicles, recordingDrain }: Parameters<AgentDriver["run"]>[0]) {
      d.runs++;
      for (const v of vehicles) engine.attachBot(v.vehicleId, new HunterBot(v.botId));
      while (!engine.isFinished() && engine.tick < 100_000) {
        engine.step();
        if (engine.tick % 25 === 0) {
          await new Promise((r) => (paceMs > 0 ? setTimeout(r, paceMs) : setImmediate(r)));
          if (recordingDrain) await recordingDrain();
        }
      }
      return { result: engine.run(100_000) };
    },
  };
  return d;
}

interface Rig {
  replaysDir: string;
  worker: TournamentWorker;
  driver: ReturnType<typeof countingDriver>;
}

async function rig(opts: {
  paceMs?: number;
  replayLimits?: ReplayLimitsConfig;
  recorderOverrides?: Parameters<typeof makeDefaultHandlers>[0]["recorderOverrides"];
}): Promise<Rig> {
  const replaysDir = mkdtempSync(join(tmpdir(), "pr5-limits-"));
  const driver = countingDriver(opts.paceMs ?? 0);
  const wired = await makeDefaultHandlers({
    db: h.db,
    agents: driver,
    rulesetOverrides: { timeLimitTicks: 600 },
    replaysDir,
    ...(opts.replayLimits ? { replayLimits: opts.replayLimits } : {}),
    ...(opts.recorderOverrides ? { recorderOverrides: opts.recorderOverrides } : {}),
  });
  const worker = new TournamentWorker({
    db: h.db,
    workerId: `pr5-w${++n}`,
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job), // = onBattleJobExhausted (main.ts)
  });
  return { replaysDir, worker, driver };
}

/**
 * Procesa la cola saltando el backoff de los reintentos (reloj inyectado, 15 min por pasada: `storage_unavailable` espera
 * 1, 2, 5 y 10 min), hasta vaciarla.
 */
async function drainAll(w: TournamentWorker): Promise<void> {
  for (let i = 1; i <= 12; i++) {
    if ((await w.drain(100, new Date(Date.now() + i * 900_000))) === 0 && i > 3) return;
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

/** Sonda de volumen falsa y determinista: cuenta las llamadas y niega cuando se le dice. */
function fakeProbe(o: {
  free?: () => number;
  used?: () => number;
}): StorageProbe & { freeCalls: number; usedCalls: number } {
  const p = {
    freeCalls: 0,
    usedCalls: 0,
    async freeBytes() {
      p.freeCalls++;
      return (o.free ?? (() => 100 * GiB))();
    },
    async usedBytes() {
      p.usedCalls++;
      return (o.used ?? (() => 0))();
    },
  };
  return p;
}

/** Condición común de un FALLO TÉCNICO (clase B o compuerta): failed/infrastructure, sin efectos deportivos ni ficheros. */
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
  expect(b.run_attempts).toBe(5); // la política propia de storage_unavailable (5 fallos) SÍ se aplicó
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
  expect(await h.db("replay_artifacts").where({ battle_id: s.battleId })).toHaveLength(0);
  expect(filesIn(r.replaysDir)).toEqual({ finals: [], partials: [] });
}

/** Ajustes de grabador con fragmentos pequeños: la batalla produce muchos fragmentos y el tope se nota a mitad. */
const SMALL_FRAGMENTS = {
  recipeFragmentBytes: 1024,
  viewFragmentBytes: 1024,
  // Cola de 64 KiB = 2 x fragmento de producción (1 MiB receta / 2 MiB vista): la contrapresión acota el retraso del
  // escritor en BYTES, no en tiempo. Con ritmo 0 el corte cae siempre en el mismo tick (sin reloj).
  recipeMaxPendingBytes: 64 * 1024,
  viewMaxPendingBytes: 64 * 1024,
};

/** Cola holgada: el motor termina ANTES de que el escritor note el tope (la carrera de P1-R3). */
const RACE_FRAGMENTS = { ...SMALL_FRAGMENTS, recipeMaxPendingBytes: 512 * 1024, viewMaxPendingBytes: 512 * 1024 };

const FIXED_SEED = "pr5-semilla-fija";
/** Tick del corte de L1 con la calibración de producción (cola 64 KiB, ritmo 0, tope = 1/4 de la batalla). */
const CUT_TICK = 252;

describe("PR-5 · clase A: el tope de la propia batalla", () => {
  it("L1 tope alcanzado a mitad de batalla: finished sin resultado deportivo, replay truncado y marcado, SIN reintento ni Elo", async () => {
    // Control: la misma batalla (semilla fija) sin tope pequeño se juega entera y publica un replay completo.
    const full = await rig({ replayLimits: { limits: defaultReplayLimits }, recorderOverrides: SMALL_FRAGMENTS });
    const sf = await scheduleTournament(FIXED_SEED);
    await drainAll(full.worker);
    const fb = (await h.db("battles").where({ id: sf.battleId }).first()) as Row;
    expect(fb.status).toBe("finished");
    expect(fb.result.endReason).toBe("completed");
    const fullArt = (await h.db("replay_artifacts").where({ battle_id: sf.battleId }).first()) as Row;
    expect(fullArt.truncated).toBe(false);
    const fullBytes = Number(fullArt.recipe_bytes) + Number(fullArt.view_bytes);

    // Con un tope a un cuarto de lo que ocupa la batalla entera y la cola de producción (64 KiB), el motor queda frenado
    // por la contrapresión y el corte cae A MITAD, en el mismo tick siempre, sin reloj (ritmo 0).
    const PER_BATTLE = Math.floor(fullBytes / 4);
    const r = await rig({
      replayLimits: { limits: () => ({ ...defaultReplayLimits(), maxBytesPerBattle: PER_BATTLE }) },
      recorderOverrides: SMALL_FRAGMENTS,
    });
    const s = await scheduleTournament(FIXED_SEED);
    const before = await sportingSnapshot(s.botIds, s.tid);
    const limitBefore = workerMetrics.counter("replay_aborts_battle_limit_total");
    const storageBefore = workerMetrics.counter("replay_aborts_storage_total");
    await drainAll(r.worker);

    const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    const why = String(
      (
        await h
          .db("jobs")
          .where({ dedupe_key: `run_battle:${s.battleId}` })
          .first("last_error")
      )?.last_error,
    );
    // Final técnico, NO fallo: cerrada, con motivo `recording_limit`, sin ganador ni empate.
    expect(b.status, why).toBe("finished");
    expect(b.failure_kind).toBe("none");
    expect(b.result.schema).toBe("battle-result/v1");
    expect(b.result.endReason).toBe("recording_limit");
    expect(b.result.winner).toBeNull();
    expect(b.result.winner).not.toBe("draw");
    expect(b.result.ticks).toBeLessThan(fb.result.ticks); // se cortó a mitad: antes del final natural
    expect(b.result.ticks).toBe(CUT_TICK); // determinista: siempre el mismo tick
    // NO se reintenta (clase A determinista): un solo intento y trabajo terminado.
    expect(b.run_attempts).toBe(1);
    expect(r.driver.runs).toBe(1);
    const job = (await h
      .db("jobs")
      .where({ dedupe_key: `run_battle:${s.battleId}` })
      .first()) as Row;
    expect(job.status).toBe("done");
    // Sin efectos deportivos.
    const parts = await h.db("participants").where({ battle_id: s.battleId });
    expect(parts.map((p: Row) => p.outcome)).toEqual([null, null]);
    expect(await applyBattleRating(h.db, s.battleId)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: s.battleId })).toHaveLength(0);
    expect(await sportingSnapshot(s.botIds, s.tid)).toEqual(before);
    // Replay TRUNCADO y marcado: publicado, íntegro, nunca «válido» sin allowTruncated.
    const art = (await h.db("replay_artifacts").where({ battle_id: s.battleId }).first()) as Row;
    expect(art.state).toBe("published");
    expect(art.truncated).toBe(true);
    expect(art.stats_state).toBe("not_applicable");
    expect(art.ticks).toBe(b.result.ticks);
    expect(b.replay_ref).toBe(art.recipe_path);
    expect(Number(art.recipe_bytes) + Number(art.view_bytes)).toBeLessThan(fullBytes);
    const strict = await verifyFile(art.recipe_path, { expectSha256: art.recipe_sha256 });
    expect(strict.ok).toBe(false);
    expect(strict.reason).toBe("truncated");
    const lenient = await verifyFile(art.recipe_path, { expectSha256: art.recipe_sha256, allowTruncated: true });
    expect(lenient.ok).toBe(true);
    expect(lenient.truncated).toBe(true);
    expect(filesIn(r.replaysDir).partials).toEqual([]);
    expect(filesIn(r.replaysDir).finals).toHaveLength(2);
    // Métricas: el tope alcanzado se cuenta y NO cuenta como aborto por almacenamiento.
    expect(workerMetrics.counter("replay_aborts_battle_limit_total")).toBe(limitBefore + 1);
    expect(workerMetrics.counter("replay_aborts_storage_total")).toBe(storageBefore);

    // La API lo expone sin 5xx y sin inventar un resultado.
    const auth = { Authorization: `Bearer ${admin}` };
    const detail = await request(app).get(`/battles/${s.battleId}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.result.endReason).toBe("recording_limit");
    expect(detail.body.result.winner).toBeNull();
    const list = await request(app).get(`/replays`).set(auth);
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: Row) => i.battleId === s.battleId);
    expect(item).toMatchObject({ winner: "none", endReason: "recording_limit" });
    const stats = await request(app).get(`/battles/${s.battleId}/stats`).set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.status).toBe("unavailable");
    for (const url of [`/replays/${s.battleId}/index`, `/replays/${s.battleId}/segment?fromTick=0&toTick=30`]) {
      const res = await request(app).get(url).set(auth);
      expect(res.status, url).toBeLessThan(500);
    }
    const ver = await request(app).post(`/replays/${s.battleId}/verify`).set(auth);
    expect(ver.status).toBeLessThan(500);
    expect(ver.body.matches).toBe(false);
    // P3-2: un truncado legítimo no es «corrupto»; P2-3: no se anuncia como reproducible; P3-3: la descarga lo marca.
    expect(ver.body.reason).toBe("truncated");
    expect(detail.body.replayAvailable).toBe(false);
    const raw = await request(app).get(`/replays/${s.battleId}`).set(auth).buffer(true);
    expect(raw.status).toBe(200);
    expect(raw.headers["x-replay-truncated"]).toBe("true");
    // control: un replay COMPLETO sí es reproducible y su descarga no lleva la marca
    const fullDetail = await request(app).get(`/battles/${sf.battleId}`).set(auth);
    expect(fullDetail.body.replayAvailable).toBe(true);
    const fullRaw = await request(app).get(`/replays/${sf.battleId}`).set(auth).buffer(true);
    expect(fullRaw.headers["x-replay-truncated"]).toBeUndefined();
  }, 240_000);
});

describe("PR-5 · clase A: la carrera con el motor ya terminado (P1-R3)", () => {
  it("L1b el motor termina ANTES de que el escritor note el tope: toda la batalla es truncada, la receta sin ganador y verify «truncated»", async () => {
    const full = await rig({ replayLimits: { limits: defaultReplayLimits }, recorderOverrides: RACE_FRAGMENTS });
    const sf = await scheduleTournament(FIXED_SEED);
    await drainAll(full.worker);
    const fb = (await h.db("battles").where({ id: sf.battleId }).first()) as Row;
    expect(fb.status).toBe("finished");
    const fullArt = (await h.db("replay_artifacts").where({ battle_id: sf.battleId }).first()) as Row;
    const fullBytes = Number(fullArt.recipe_bytes) + Number(fullArt.view_bytes);

    // Ritmo 0 y cola holgada (512 KiB): el motor termina sus 600 ticks antes de que los escritores procesen el tope.
    const r = await rig({
      replayLimits: { limits: () => ({ ...defaultReplayLimits(), maxBytesPerBattle: Math.floor(fullBytes / 4) }) },
      recorderOverrides: RACE_FRAGMENTS,
    });
    const s = await scheduleTournament(FIXED_SEED);
    await drainAll(r.worker);
    const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    expect(b.status).toBe("finished");
    expect(b.result.endReason).toBe("recording_limit");
    expect(b.result.winner).toBeNull();
    expect(b.result.ticks).toBe(fb.result.ticks); // el motor SÍ terminó entero: es la carrera
    const art = (await h.db("replay_artifacts").where({ battle_id: s.battleId }).first()) as Row;
    expect(art.truncated).toBe(true);
    // AMBOS flujos truncados: nunca una receta completa junto a una vista truncada.
    for (const [path, sha] of [
      [art.recipe_path, art.recipe_sha256],
      [art.view_path, art.view_sha256],
    ]) {
      const strict = await verifyFile(path, { expectSha256: sha });
      expect(strict.ok, path).toBe(false);
      expect(strict.reason, path).toBe("truncated");
    }
    // La receta NO lleva el ganador del motor: coherente con la BD (sin ganador).
    const reader = await S9rReader.open(art.recipe_path, { expectBattleId: s.battleId });
    const result = (await reader.readResult()) as Row;
    await reader.close();
    expect(result.winner).toBeNull();
    expect(result.endReason).toBe("recording_limit");
    // verify rechaza por la batalla: ninguna vía certifica una batalla truncada.
    const auth = { Authorization: `Bearer ${admin}` };
    const ver = await request(app).post(`/replays/${s.battleId}/verify`).set(auth);
    expect(ver.status).toBeLessThan(500);
    expect(ver.body.valid).toBe(false);
    expect(ver.body.matches).toBe(false);
    expect(ver.body.reason).toBe("truncated");
    expect((await request(app).get(`/battles/${s.battleId}`).set(auth)).body.replayAvailable).toBe(false);
    // Por ningún camino: una receta COMPLETA y válida de una batalla marcada `recording_limit` tampoco se certifica
    // (se rechaza por la batalla, antes de re-simular).
    const okBefore = await request(app).post(`/replays/${sf.battleId}/verify`).set(auth);
    expect(okBefore.body.valid).toBe(true);
    await h
      .db("battles")
      .where({ id: sf.battleId })
      .update({ result: JSON.stringify({ ...fb.result, winner: null, endReason: "recording_limit" }) });
    const refused = await request(app).post(`/replays/${sf.battleId}/verify`).set(auth);
    expect(refused.body).toMatchObject({ matches: false, valid: false, reason: "truncated" });
  }, 240_000);
});

describe("PR-5 · clase B: disco o cuota del volumen", () => {
  it("L2a espacio agotado a mitad de intento y recuperado: storage_unavailable, REINTENTO y el reintento publica", async () => {
    let armed = true;
    let denials = 0;
    // Llamada 1 = compuerta previa (hueco). Mientras `armed`, los fragmentos ven el volumen bajo la reserva;
    // al primer rechazo se «libera espacio» (armed=false) y el reintento ya cabe.
    const probe = fakeProbe({
      free: () => {
        if (armed && probe.freeCalls > 1) {
          armed = false;
          denials++;
          return 1 * MiB; // por debajo de la reserva
        }
        return 100 * GiB;
      },
    });
    const r = await rig({
      replayLimits: { limits: defaultReplayLimits, probe },
      recorderOverrides: SMALL_FRAGMENTS,
    });
    const s = await scheduleTournament();
    const storageBefore = workerMetrics.counter("replay_aborts_storage_total");
    await drainAll(r.worker);
    expect(denials).toBe(1);
    expect(workerMetrics.counter("replay_aborts_storage_total")).toBe(storageBefore + 1);
    const b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    // El primer intento falló por el entorno y se REINTENTÓ: el segundo cerró la batalla con su replay completo.
    expect(b.status).toBe("finished");
    expect(b.result.endReason).toBe("completed");
    expect(b.run_attempts).toBe(2);
    expect(r.driver.runs).toBe(2);
    const art = (await h.db("replay_artifacts").where({ battle_id: s.battleId }).first()) as Row;
    expect(art.attempt).toBe(2);
    expect(art.truncated).toBe(false);
    expect(filesIn(r.replaysDir).partials).toEqual([]);
    const job = (await h
      .db("jobs")
      .where({ dedupe_key: `run_battle:${s.battleId}` })
      .first()) as Row;
    expect(job.status).toBe("done");
  }, 240_000);

  it.each([
    ["reserva de espacio libre", /recording_fault: .*free_space_low/, { free: () => 1 * MiB }],
    ["cuota del volumen", /recording_fault: .*quota_exceeded/, { used: () => 20 * GiB - 2048 }],
  ] as const)(
    "L2b %s agotada en cada intento: storage_unavailable con la política de reintentos y, agotada, fallo técnico sin efectos deportivos",
    async (_name, reason, behaviour) => {
      // La compuerta previa pasa (aún no hay parciales del intento); los fragmentos (con sus parciales ya
      // creados) ven el volumen agotado.
      const ctx = { dir: "" };
      const writing = () =>
        ctx.dir !== "" && existsSync(join(ctx.dir, ".partial")) && readdirSync(join(ctx.dir, ".partial")).length > 0;
      const probe = fakeProbe({
        free: () => ((behaviour as any).free && writing() ? (behaviour as any).free() : 100 * GiB),
        used: () => ((behaviour as any).used && writing() ? (behaviour as any).used() : 0),
      });
      const r = await rig({ replayLimits: { limits: defaultReplayLimits, probe }, recorderOverrides: SMALL_FRAGMENTS });
      ctx.dir = r.replaysDir;
      const s = await scheduleTournament();
      const before = await sportingSnapshot(s.botIds, s.tid);
      await drainAll(r.worker);
      await expectTechnicalFailure(s, r, before, reason);
      // El match y el torneo se cierran como fallo técnico (#329), sin ganador.
      const m = await h.db("matches").where({ tournament_id: s.tid }).select("state", "winner_bot_id");
      expect(m).toEqual([{ state: "failed", winner_bot_id: null }]);
    },
    240_000,
  );
});

describe("PR-5 · compuerta previa", () => {
  it("L3 sin hueco mínimo no se arranca la batalla: el driver no se invoca, no se crea ningún fichero y es storage_unavailable", async () => {
    // Libre = justo por debajo de «batalla máxima + reserva».
    const l = defaultReplayLimits();
    const probe = fakeProbe({ free: () => l.maxBytesPerBattle + l.minFreeBytes - 1 });
    const r = await rig({ replayLimits: { limits: defaultReplayLimits, probe } });
    const s = await scheduleTournament();
    const before = await sportingSnapshot(s.botIds, s.tid);
    const rejectedBefore = workerMetrics.counter("replay_preflight_rejected_total");
    await drainAll(r.worker);
    expect(r.driver.runs).toBe(0); // ni motor ni contenedores
    expect(existsSync(join(r.replaysDir, ".partial"))).toBe(false); // ni el directorio de parciales
    await expectTechnicalFailure(s, r, before, /recording_preflight: .*free_space_low/);
    expect(workerMetrics.counter("replay_preflight_rejected_total")).toBeGreaterThanOrEqual(rejectedBefore + 3);
  }, 240_000);

  it("L3b con el hueco justo SÍ arranca (el borde exacto cabe)", async () => {
    const l = defaultReplayLimits();
    const probe = fakeProbe({ free: () => l.maxBytesPerBattle + l.minFreeBytes + 64 * MiB });
    const r = await rig({ replayLimits: { limits: defaultReplayLimits, probe } });
    const s = await scheduleTournament();
    await drainAll(r.worker);
    expect(r.driver.runs).toBe(1);
    expect(((await h.db("battles").where({ id: s.battleId }).first()) as Row).status).toBe("finished");
  }, 240_000);
});

describe("PR-5 · cambio EN CALIENTE (system_settings)", () => {
  const patch = (changes: unknown, t: string = admin) =>
    request(app)
      .patch("/admin/settings")
      .set("Authorization", `Bearer ${t}`)
      .send({ changes } as object);

  it("L4 la API valida rango y clave; un cambio de cuota lo ve el worker sin reiniciar y cambia el siguiente intento", async () => {
    await h.db("system_settings").delete();
    // Validación en servidor: rangos del registro, clave no registrada y permisos.
    for (const bad of [
      { key: "replays.quota.max_bytes", value: 1024, expectedVersion: 0 },
      { key: "replays.quota.min_free_bytes", value: 1, expectedVersion: 0 },
      { key: "replays.limits.max_bytes_per_battle", value: 2 * GiB, expectedVersion: 0 },
      { key: "replays.limits.max_bytes_per_battle", value: "64", expectedVersion: 0 },
      { key: "replays.quota.no_existe", value: 5 * GiB, expectedVersion: 0 },
    ]) {
      expect((await patch([bad])).status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await patch([{ key: "replays.quota.max_bytes", value: 5 * GiB, expectedVersion: 0 }], moderator)).status,
    ).toBe(403);
    expect(await h.db("system_settings").count({ n: "*" }).first()).toMatchObject({ n: "0" });
    // La web los muestra con su consumidor y «en caliente».
    const listed = await request(app).get("/admin/settings").set("Authorization", `Bearer ${admin}`);
    const byKey = Object.fromEntries(listed.body.settings.map((x: Row) => [x.key, x]));
    for (const k of [
      "replays.quota.max_bytes",
      "replays.quota.min_free_bytes",
      "replays.limits.max_bytes_per_battle",
    ]) {
      expect(byKey[k], k).toMatchObject({ consumer: "tournament-worker", apply: "hot", requiresRestart: false });
    }

    // Cuota inicial 1 GiB (el mínimo permitido) frente a un volumen que ya usa 1,5 GiB: ni cabe una batalla.
    // (la reserva baja a 512 MiB en el mismo PATCH: la coherencia entre claves exige reserva < cuota)
    expect(
      (
        await patch([
          { key: "replays.quota.min_free_bytes", value: 512 * MiB, expectedVersion: 0 },
          { key: "replays.quota.max_bytes", value: 1 * GiB, expectedVersion: 0 },
        ])
      ).status,
    ).toBe(200);
    const reader = new SystemSettingsReader(h.db, SYSTEM_SETTINGS_REGISTRY, { env: {}, refreshMs: 60_000 });
    await reader.refresh();
    expect(replayLimitsFromReader(reader)().quotaMaxBytes).toBe(1 * GiB);
    const probe = fakeProbe({ used: () => 1.5 * GiB });
    const r = await rig({ replayLimits: { limits: replayLimitsFromReader(reader), probe } });
    const s = await scheduleTournament();
    await r.worker.drain(100, new Date()); // intento 1: la compuerta previa lo rechaza
    let b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    expect(b.status).toBe("scheduled");
    expect(b.run_attempts).toBe(1);
    expect(r.driver.runs).toBe(0);
    // El admin sube la cuota por la API (en caliente: nadie reinicia nada) y el lector la relee.
    expect((await patch([{ key: "replays.quota.max_bytes", value: 4 * GiB, expectedVersion: 1 }])).status).toBe(200);
    await reader.refresh(); // lo que hace el sondeo (5 s) en producción
    expect(replayLimitsFromReader(reader)().quotaMaxBytes).toBe(4 * GiB);
    await drainAll(r.worker);
    b = (await h.db("battles").where({ id: s.battleId }).first()) as Row;
    expect(b.status).toBe("finished");
    expect(b.run_attempts).toBe(2);
    expect(r.driver.runs).toBe(1);
    reader.stop();
    await h.db("system_settings").delete();
  }, 240_000);

  it("L5 FAIL-CLOSED: sin lectura válida de system_settings valen los defectos del código", async () => {
    const broken = {
      transaction: async () => {
        throw Object.assign(new Error("BD caída"), { code: "ECONNREFUSED" });
      },
    };
    const reader = new SystemSettingsReader(broken as never, SYSTEM_SETTINGS_REGISTRY, { env: {} });
    await reader.refresh();
    expect(reader.isFresh()).toBe(false);
    expect(replayLimitsFromReader(reader)()).toEqual(defaultReplayLimits());
    expect(defaultReplayLimits()).toEqual({
      quotaMaxBytes: 20 * GiB,
      minFreeBytes: 5 * GiB,
      maxBytesPerBattle: 64 * MiB,
    });
  });

  it("L6 main.ts cablea los límites: construye el lector de system_settings y se los pasa al ejecutor", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");
    expect(src).toMatch(/buildReplayLimits\(db, replaysDir\)/);
    expect(src).toMatch(/makeEngineExecutor\(\{[^}]*\breplayLimits,/s);
  });
});

describe("PR-5 · sin efectos deportivos", () => {
  it("L7 recording_limit no puntúa (Elo) ni cuenta en V-D-E, aunque sea OFICIAL; un empate deportivo sí", async () => {
    expect(isTechnicalLimit({ endReason: "recording_limit" })).toBe(true);
    expect(isTechnicalLimit(JSON.stringify({ endReason: "recording_limit" }))).toBe(true);
    expect(isTechnicalLimit({ endReason: "completed" })).toBe(false);
    const bots = await createBots(h.db, 4, "pr5l7");
    const run = async (execution: BattleExecution, a: (typeof bots)[0], b: (typeof bots)[0]) => {
      const id = await insertScheduledBattle(h.db, a, b, { official: true });
      const w = new TournamentWorker({
        db: h.db,
        workerId: `pr5-l7-${id.slice(0, 6)}`,
        handlers: { run_battle: makeRunBattleHandler({ executor: async () => execution }) },
        onExhausted: (job: JobRow) => markBattleForReview(h.db, job),
      });
      await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `pr5l7:${id}` });
      for (let i = 0; i < 5; i++) if ((await w.drain()) === 0) break;
      return id;
    };
    const base = {
      ticks: 300,
      score: { A: 1, B: 0 },
      finalStateHash: "h",
      disqualified: [],
      versions: { engine: "0.4.0" },
    };
    const id = await run({ ...base, winner: null, endReason: "recording_limit" }, bots[0], bots[1]);
    const row = (await h.db("battles").where({ id }).first()) as Row;
    expect(row.status).toBe("finished");
    expect(row.result.endReason).toBe("recording_limit");
    expect(row.result.winner).toBeNull();
    expect((await h.db("participants").where({ battle_id: id })).map((p: Row) => p.outcome)).toEqual([null, null]);
    expect(await applyBattleRating(h.db, id)).toBe(false);
    expect(await h.db("rating_events").where({ battle_id: id })).toHaveLength(0);
    expect(await h.db("ratings").whereIn("bot_id", [bots[0].botId, bots[1].botId])).toHaveLength(0);
    // Control: el mismo cierre con un EMPATE deportivo sí puntúa.
    const id2 = await run({ ...base, winner: "draw" }, bots[2], bots[3]);
    expect(await applyBattleRating(h.db, id2)).toBe(true);
  });
});
