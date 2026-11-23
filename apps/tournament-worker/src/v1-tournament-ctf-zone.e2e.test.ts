/**
 * V1-C / B3 · CTF y control de zona en torneos (D-OP-2 / D-OP-9: FUERA de V1).
 *
 * Antes (V1-C) este fichero CARACTERIZABA que la API los aceptaba y que la batalla fallaba al
 * jugar. Con B3 la API los RECHAZA al crear (400 `tournament_mode_not_allowed`) y el scheduler no
 * programa nada para un torneo antiguo con esos modos. Estos tests no validan CTF ni zona como
 * jugables: fijan el rechazo, el trato de los torneos históricos y el fallo técnico del worker.
 *
 * Etiquetas `V1C_*` para el script de mutantes (scripts/v1-b3-tournament-modes-mutants.py).
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

async function seedClosedDmTournament() {
  // Torneo ANTERIOR a la restricción: se crea como Deathmatch (la API ya no deja otra cosa) y se
  // reescribe su modo en la fila, como si lo hubiera creado una versión previa. Se cierra la
  // inscripción, que encola `generate_schedule`.
  const r = await createT({ format: "round_robin", mode: "deathmatch", rulesetId: "deathmatch-mvp" });
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
  return r.body.id as string;
}

async function drainWithRetries(tournamentId: string) {
  await drainAll();
  // Los reintentos esperan un backoff: se adelanta el reloj de la cola hasta agotarlos.
  for (let i = 0; i < 15; i++) {
    const open = await h.db("jobs").whereIn("status", ["queued", "running"]);
    if (open.length === 0) break;
    await h
      .db("jobs")
      .where({ status: "queued" })
      .update({ run_after: new Date(Date.now() - 1000) });
    await drainAll();
  }
  const battles = (await h.db("battles").where({ tournament_id: tournamentId })) as Row[];
  const t = (await h.db("tournaments").where({ id: tournamentId }).first()) as Row;
  const jobs = ((await h.db("jobs").where({ kind: "generate_schedule" })) as Row[]).filter((j) => {
    const pl = typeof j.payload === "string" ? JSON.parse(j.payload) : (j.payload as { tournamentId?: string });
    return pl.tournamentId === tournamentId;
  });
  return { battles, t, jobs };
}

describe("V1-C · B3 · CTF y control de zona FUERA de los torneos", () => {
  it("V1C_CTF_preset_rejected · el preset CTF se rechaza al crear el torneo (400 tournament_mode_not_allowed)", async () => {
    const r = await createT({
      format: "round_robin",
      mode: "capture_the_flag",
      rulesetId: "capture-the-flag-mvp",
      rules: { preset: "ctf", teamSize: 2 },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("tournament_mode_not_allowed");
  });

  it("V1C_CTF_classic_rejected · CTF CLÁSICO (sin `rules`) se rechaza al crear: 400 tournament_mode_not_allowed y ninguna fila", async () => {
    const before = Number((await h.db("tournaments").count("* as n").first())?.n);
    const r = await createT({ format: "round_robin", mode: "capture_the_flag", rulesetId: "capture-the-flag-mvp" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe("tournament_mode_not_allowed");
    expect(r.body.allowedModes).toEqual(["deathmatch", "team_deathmatch"]);
    expect(Number((await h.db("tournaments").count("* as n").first())?.n)).toBe(before);
  });

  it("V1C_ZONE_classic_rejected · control de zona CLÁSICO se rechaza al crear: 400 tournament_mode_not_allowed", async () => {
    const r = await createT({ format: "round_robin", mode: "zone_control", rulesetId: "zone-control-mvp" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe("tournament_mode_not_allowed");
  });

  it("V1C_CTF_historic_not_scheduled · un torneo ANTIGUO con CTF no genera calendario ni batallas: fallo técnico claro del worker, datos intactos y visible", async () => {
    const id = await seedClosedDmTournament();
    await h.db("tournaments").where({ id }).update({ mode: "capture_the_flag" });
    const { battles, t, jobs } = await drainWithRetries(id);
    expect(battles).toEqual([]); // NO se programa ninguna batalla CTF
    expect(jobs.length).toBe(1);
    expect(String(jobs[0].last_error)).toMatch(/tournament_mode_not_allowed/);
    // O2 · acotado: termina en revisión manual y no supera su tope de intentos (sin bucle).
    expect(jobs[0].status).toBe("needs_review");
    expect(Number(jobs[0].attempts)).toBeLessThanOrEqual(Number(jobs[0].max_attempts));
    expect(t.state).toBe("closed"); // no se toca el dato: ni running ni finished
    const g = await request(app).get(`/tournaments/${id}`);
    expect(g.status).toBe(200);
    expect(g.body.mode).toBe("capture_the_flag");
  });

  it("V1C_ZONE_historic_not_scheduled · lo mismo con control de zona", async () => {
    const id = await seedClosedDmTournament();
    await h.db("tournaments").where({ id }).update({ mode: "zone_control" });
    const { battles, t, jobs } = await drainWithRetries(id);
    expect(battles).toEqual([]);
    expect(String(jobs[0].last_error)).toMatch(/tournament_mode_not_allowed/);
    expect(t.state).toBe("closed");
  });

  it("V1C_DM_still_scheduled · control positivo: un torneo Deathmatch normal SÍ genera calendario", async () => {
    const id = await seedClosedDmTournament();
    const { battles, t } = await drainWithRetries(id);
    expect(battles.length).toBeGreaterThan(0);
    expect(["running", "finished"]).toContain(String(t.state));
  });
});
