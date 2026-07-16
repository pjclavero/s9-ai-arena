/**
 * E9 · T9.4 — DoD de justicia competitiva y auditoría:
 *  - Commit-reveal verificable: el hash publicado ANTES del cierre coincide
 *    con las semillas reveladas (y un reveal falso se rechaza).
 *  - El endpoint público de auditoría contiene todos los artefactos y
 *    versiones, y `verify` (re-simulación del replay) reproduce la batalla.
 *  - Cada emparejamiento juega el mismo número de veces por lado.
 *  - Un cambio de catálogo durante un torneo en curso NO afecta a sus
 *    batallas (usa el catálogo congelado).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { fromJsonl, verify } from "../../arena-engine/src/replay.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { commitSeedBatch, deriveBattleSeed } from "./scheduler.js";
import { createBots, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let organizer: string;
let bots: TestBot[];
let worker: TournamentWorker;

async function drainAll(maxIterations = 30): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if ((await worker.drain()) === 0) return;
  }
  throw new Error("drainAll: la cola no se vació");
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  bots = await createBots(h.db, 4, "jus");

  const wired = await makeDefaultHandlers({
    db: h.db,
    rulesetOverrides: { timeLimitTicks: 360, scoreToWin: 1 },
    replaysDir: mkdtempSync(join(tmpdir(), "e9-justice-")),
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "justice-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });
}, 180_000);

afterAll(async () => {
  await h.stop();
});

async function createTournament(body: Record<string, unknown>): Promise<string> {
  const t = await request(app)
    .post("/tournaments")
    .set("Authorization", `Bearer ${organizer}`)
    .send({ mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID, ...body });
  expect(t.status).toBe(201);
  return t.body.id as string;
}

async function enter(tournamentId: string, list: TestBot[]): Promise<void> {
  for (const b of list) {
    await h.db("entries").insert({
      tournament_id: tournamentId,
      bot_id: b.botId,
      version: b.version,
      loadout_revision: b.loadoutRevision,
      frozen: false,
    });
  }
}

describe("T9.4 · commit-reveal de semillas", () => {
  const SEEDS = ["batch-1", "batch-2", "batch-3", "batch-4"];
  let tournamentId: string;

  it("el organizador publica el hash ANTES del cierre y revela después; todo queda en la BD", async () => {
    tournamentId = await createTournament({
      name: "cr-liga",
      format: "round_robin",
      roundsPerPairing: 2,
      seedCommitment: commitSeedBatch(SEEDS),
    });
    await enter(tournamentId, bots.slice(0, 2));

    // Reveal ausente o falso: rechazado (el compromiso obliga).
    const missing = await request(app)
      .post(`/tournaments/${tournamentId}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(missing.status).toBe(409);
    const wrong = await request(app)
      .post(`/tournaments/${tournamentId}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`)
      .send({ seeds: ["troll-1", "troll-2"] });
    expect(wrong.status).toBe(409);

    // Reveal correcto: verificable (hash(reveal) == compromiso publicado).
    const closed = await request(app)
      .post(`/tournaments/${tournamentId}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`)
      .send({ seeds: SEEDS });
    expect(closed.status).toBe(200);
    expect(closed.body.seedCommitment).toBe(commitSeedBatch(SEEDS));
    expect(closed.body.seedsRevealed).toEqual(SEEDS);
  });

  it("cada batalla usa una semilla DERIVABLE públicamente del lote revelado", async () => {
    await drainAll();
    const battles = await h.db("battles").where({ tournament_id: tournamentId }).orderBy("game_index", "asc");
    expect(battles.length).toBe(2); // RR de 2 bots × 2 juegos por emparejamiento
    for (const b of battles) {
      const proof = typeof b.seed_reveal_proof === "string" ? JSON.parse(b.seed_reveal_proof) : b.seed_reveal_proof;
      // Cualquiera puede recomputar la semilla con datos públicos:
      expect(b.seed).toBe(deriveBattleSeed(SEEDS, proof.slot, proof.gameIndex));
      expect(b.seed_commitment).toBe(commitSeedBatch(SEEDS));
    }
  });

  it("DoD · cada emparejamiento juega el MISMO número de veces por lado", async () => {
    const battles = await h.db("battles").where({ tournament_id: tournamentId });
    const sideCount = new Map<string, { A: number; B: number }>();
    for (const b of battles) {
      const parts = await h.db("participants").where({ battle_id: b.id });
      for (const p of parts) {
        const c = sideCount.get(p.bot_id) ?? { A: 0, B: 0 };
        c[p.team as "A" | "B"]++;
        sideCount.set(p.bot_id, c);
      }
    }
    expect(sideCount.size).toBe(2);
    for (const c of sideCount.values()) {
      expect(c.A).toBe(1); // un juego por lado
      expect(c.B).toBe(1);
    }
  });

  it("DoD · el endpoint de auditoría contiene artefactos y versiones, y verify reproduce la batalla", async () => {
    const battles = await h.db("battles").where({ tournament_id: tournamentId });
    for (const b of battles) {
      const audit = await request(app).get(`/battles/${b.id}/audit`); // público, sin cuenta
      expect(audit.status).toBe(200);
      const a = audit.body;

      // Registro completo (19.2/14.4): semilla + commit-reveal…
      expect(a.seed).toBe(b.seed);
      expect(a.seedCommitment).toBe(commitSeedBatch(["batch-1", "batch-2", "batch-3", "batch-4"]));
      expect(a.seedRevealProof).toBeTruthy();
      // …versiones exactas de motor, física (Rapier), reglas, protocolo y catálogo…
      for (const key of ["engine", "physics", "rules", "protocol", "catalog"]) {
        expect(a.versions[key], `versions.${key}`).toBeTruthy();
      }
      // …mapa con checksum y artefactos de cada bot con hash y firma.
      const mapRow = await h.db("map_versions").where({ map_id: b.map_id, version: b.map_version }).first();
      expect(a.map.checksum).toBe(mapRow.checksum);
      expect(a.artifacts.length).toBe(2);
      for (const art of a.artifacts) {
        expect(art.artifactHash).toMatch(/^hash-/);
        expect(art.signature).toMatch(/^sig-/);
      }
      expect(a.finalStateHash).toBe(b.final_state_hash);

      // Re-simulación: el replay descargado se verifica (replay-service verify
      // = verify() real del motor E2, hashes intermedios incluidos).
      const replayRes = await request(app).get(`/replays/${b.id}`).buffer(true);
      expect(replayRes.status).toBe(200);
      const replay = fromJsonl(Buffer.from(replayRes.body).toString("utf8"));
      const verdict = await verify(replay);
      expect(verdict.matches).toBe(true);
      expect(verdict.recomputedResult.finalStateHash).toBe(a.finalStateHash);
    }
  }, 120_000);
});

describe("T9.4 · catálogo congelado durante el torneo", () => {
  it("un cambio de catálogo en curso NO afecta a las batallas del torneo", async () => {
    const tournamentId = await createTournament({ name: "cat-frozen", format: "round_robin", roundsPerPairing: 1 });
    await enter(tournamentId, bots.slice(2, 4));
    const closed = await request(app)
      .post(`/tournaments/${tournamentId}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(closed.status).toBe(200);

    // Solo el calendario (aún sin batallas ejecutadas)…
    const didSchedule = await worker.runOnce();
    expect(didSchedule).toBe(true);
    const t = await h.db("tournaments").where({ id: tournamentId }).first();
    expect(t.state).toBe("running");
    expect(t.catalog_version).toBe("mvp@1"); // congelado al programar

    // …y AHORA cambia el catálogo global: se importa mvp@2 (más nuevo).
    await h.db("catalog_versions").insert({ catalog_version: "mvp@2", module_count: 0 });
    await h.db.raw(`
      INSERT INTO module_definitions (catalog_version, module_id, module_version, category, definition, content_hash)
      SELECT 'mvp@2', module_id, module_version, category, definition, content_hash || '-v2'
      FROM module_definitions WHERE catalog_version = 'mvp@1'
    `);

    await drainAll();

    const battles = await h.db("battles").where({ tournament_id: tournamentId });
    expect(battles.length).toBeGreaterThan(0);
    for (const b of battles) {
      expect(b.status).toBe("finished");
      const versions = typeof b.engine_versions === "string" ? JSON.parse(b.engine_versions) : b.engine_versions;
      expect(versions.catalog).toBe("mvp@1"); // el congelado, NO mvp@2
    }
    const tAfter = await h.db("tournaments").where({ id: tournamentId }).first();
    expect(tAfter.state).toBe("finished");
    expect(tAfter.catalog_version).toBe("mvp@1");
  });
});
