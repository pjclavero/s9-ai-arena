/**
 * V1-C · CARACTERIZACIÓN de CTF y control de zona en torneos (D-OP-2: FUERA de V1, no se
 * implementan). Estos tests NO validan esos modos: fijan lo que la API hace HOY con ellos, para
 * que cualquier cambio (rechazo limpio, o que empiecen a jugarse) ponga un test en rojo y obligue a
 * revisar la decisión de alcance.
 *
 * Etiquetas `V1C_*` para el script de mutantes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers, inProcessAgents } from "./engine-executor.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { createPublishedBot, type TestBot } from "./testing/fixtures.js";

type Row = Record<string, unknown>;
let h: TestDbHandle;
let app: Express;
let worker: TournamentWorker;
let organizer: string;
let developer: string;
let developerId: string;
let seq = 0;
const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  developer = await tokenFor(h.db, DEV_USERS.developer);
  developerId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id as string;
  const wired = await makeDefaultHandlers({
    db: h.db,
    agents: inProcessAgents((botId) => new HunterBot(botId)),
    rulesetOverrides: { timeLimitTicks: 360, scoreToWin: 1 },
    replaysDir: mkdtempSync(join(tmpdir(), "v1c-ctf-")),
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "v1c-ctf-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });
}, 180_000);

afterAll(async () => {
  await h.stop();
});

async function drainAll(): Promise<void> {
  for (let i = 0; i < 40; i++) if ((await worker.drain()) === 0) return;
  throw new Error("la cola no se vació");
}

const createT = (body: Record<string, unknown>) =>
  request(app)
    .post("/tournaments")
    .set(as(organizer))
    .send({ name: `v1c-ctfzone-${++seq}`, roundsPerPairing: 1, ...body });

async function playClassic(mode: string, rulesetId: string) {
  const r = await createT({ format: "round_robin", mode, rulesetId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const bots: TestBot[] = [];
  for (let i = 0; i < 2; i++) bots.push(await createPublishedBot(h.db, `cz-${++seq}`, { ownerId: developerId }));
  for (const b of bots) {
    const e = await request(app)
      .post(`/tournaments/${r.body.id}/entries`)
      .set(as(developer))
      .send({ botId: b.botId, version: 1 });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
  }
  const c = await request(app).post(`/tournaments/${r.body.id}/actions/close-entries`).set(as(organizer)).send({});
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  await drainAll();
  // Los reintentos del trabajo esperan un backoff: se adelanta el reloj de la cola hasta agotarlos.
  let rounds = 0;
  for (; rounds < 15; rounds++) {
    const st = (await h.db("tournaments").where({ id: r.body.id }).first()) as Row;
    if (st.state === "finished" || st.state === "cancelled") break;
    await h
      .db("jobs")
      .where({ status: "queued" })
      .update({ run_after: new Date(Date.now() - 1000) });
    await drainAll();
  }
  const t = { ...((await h.db("tournaments").where({ id: r.body.id }).first()) as Row), retryRounds: rounds };
  const battles = (await h.db("battles").where({ tournament_id: r.body.id })) as Row[];
  const ids = new Set(battles.map((b) => b.id as string));
  const jobs = ((await h.db("jobs").where({ status: "needs_review", kind: "run_battle" })) as Row[]).filter((j) => {
    const pl = typeof j.payload === "string" ? JSON.parse(j.payload) : (j.payload as { battleId?: string });
    return ids.has(String(pl.battleId));
  });
  return { t, battles, jobs };
}

describe("V1-C · CTF y control de zona en torneos (caracterización, fuera de V1)", () => {
  it("V1C_CTF_preset_rejected · el preset CTF se rechaza al crear el torneo (400 rules_invalid)", async () => {
    const r = await createT({
      format: "round_robin",
      mode: "capture_the_flag",
      rulesetId: "capture-the-flag-mvp",
      rules: { preset: "ctf", teamSize: 2 },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/rules_invalid/);
    expect(JSON.stringify(r.body)).toMatch(/CTF todav/);
  });

  it("V1C_CTF_classic_accepted · CTF CLÁSICO (sin `rules`) se acepta al crear el torneo: 201", async () => {
    const r = await createT({ format: "round_robin", mode: "capture_the_flag", rulesetId: "capture-the-flag-mvp" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mode).toBe("capture_the_flag");
  });

  it("V1C_ZONE_classic_accepted · control de zona CLÁSICO se acepta al crear el torneo: 201", async () => {
    const r = await createT({ format: "round_robin", mode: "zone_control", rulesetId: "zone-control-mvp" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mode).toBe("zone_control");
  });

  it("V1C_CTF_classic_fails · un CTF clásico se juega UNA vez y falla: batalla failed por incompatibilidad mapa/modo, torneo cerrado SIN campeón", async () => {
    const { t, battles, jobs } = await playClassic("capture_the_flag", "capture-the-flag-mvp");
    // El mapa por defecto no tiene bandera ni base: el motor se niega a arrancar (3 intentos).
    expect(battles.map((b) => b.status)).toEqual(["failed"]);
    expect(jobs.length).toBe(1);
    expect(String(jobs[0].last_error)).toMatch(/incompatible \(mvp-arena-01 \/ capture_the_flag\)/);
    expect(Number(jobs[0].attempts)).toBe(3);
    expect(t.state).toBe("finished"); // política «failed definitiva»: el torneo termina…
    expect(t.champion_bot_id).toBeNull(); // …sin coronar a nadie
  });

  it("V1C_ZONE_classic_fails · un control de zona clásico se juega UNA vez y falla: el mapa no tiene zona de captura", async () => {
    const { t, battles, jobs } = await playClassic("zone_control", "zone-control-mvp");
    expect(battles.map((b) => b.status)).toEqual(["failed"]);
    expect(jobs.length).toBe(1);
    expect(String(jobs[0].last_error)).toMatch(/0 zona\(s\) de captura/);
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeNull();
  });
});
