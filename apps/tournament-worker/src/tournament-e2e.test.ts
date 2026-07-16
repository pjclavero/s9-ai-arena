/**
 * E9 · T9.2 — DoD E2E:
 *  - Un torneo eliminatorio de 8 bots corre de principio a fin SIN intervención
 *    humana y publica campeón, clasificación y replays.
 *  - El cierre de inscripciones congela versiones (E7/E6): un push posterior
 *    del participante no afecta al torneo.
 *  - Modo simulacro (E9.M): dry-run sin escribir batallas ni ratings.
 *
 * Piezas REALES de punta a punta: API E7 (crear torneo/cerrar inscripciones,
 * máquina de estados 17.1), cola E9 sobre PostgreSQL embebido, motor E2
 * (Battle + replay), mapas E4 (toEngineMap), catálogo E3 (resolveVehicle) y
 * stubs deterministas del motor como agentes (contenedores de E6: pendiente de
 * entorno, sin Docker).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { createBots, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let organizer: string;
let bots: TestBot[];
let worker: TournamentWorker;
let replaysDir: string;

/** Drena la cascada de trabajos (batallas → resultados → standings → rondas nuevas). */
async function drainAll(maxIterations = 30): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const n = await worker.drain();
    if (n === 0) return;
  }
  throw new Error("drainAll: la cola no se vació (¿bucle de trabajos?)");
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  bots = await createBots(h.db, 8, "e2e");

  replaysDir = mkdtempSync(join(tmpdir(), "e9-replays-"));
  const wired = await makeDefaultHandlers({
    db: h.db,
    // Batallas cortas para el E2E: la justicia del resultado es del motor.
    rulesetOverrides: { timeLimitTicks: 360, scoreToWin: 1 },
    replaysDir,
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "e2e-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });
}, 180_000);

afterAll(async () => {
  await h.stop();
});

describe("T9.2 · torneo eliminatorio de 8 bots de principio a fin", () => {
  let tournamentId: string;

  it("se crea, se inscriben 8 bots y el cierre congela versiones (E7/E6)", async () => {
    const t = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${organizer}`)
      .send({
        name: "copa-e2e",
        format: "single_elimination",
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        budgetCredits: 900, // presupuesto POR TORNEO (ADR-000/D7)
        roundsPerPairing: 1,
      });
    expect(t.status).toBe(201);
    tournamentId = t.body.id;

    for (const b of bots) {
      await h.db("entries").insert({
        tournament_id: tournamentId,
        bot_id: b.botId,
        version: b.version,
        loadout_revision: b.loadoutRevision,
        frozen: false,
      });
    }

    const closed = await request(app)
      .post(`/tournaments/${tournamentId}/actions/close-entries`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe("closed");
    expect(closed.body.seedsRevealed.length).toBeGreaterThan(0);

    // E7/E6: las versiones inscritas quedan CONGELADAS (17.1/17.2).
    for (const b of bots) {
      const v = await h.db("bot_versions").where({ bot_id: b.botId, version: b.version }).first();
      expect(v.state).toBe("frozen");
    }
  });

  it("DoD: un push posterior del participante NO afecta al torneo (congelación 17.2)", async () => {
    const victim = bots[0];
    // El dueño "empuja" después del cierre: nueva revisión de loadout…
    await h.db("bot_loadouts").insert({
      bot_id: victim.botId,
      revision: 2,
      name: "post-cierre",
      catalog_version: "mvp@1",
      chassis: "chassis.light@1",
      modules: JSON.stringify([]),
    });
    // …y nueva versión de código publicable.
    await h.db("bot_versions").insert({
      bot_id: victim.botId,
      version: 2,
      state: "published",
      runtime: "node",
      loadout_revision: 2,
      artifact_hash: "hash-post-cierre",
    });
    // La inscripción sigue apuntando a la combinación congelada.
    const entry = await h.db("entries").where({ tournament_id: tournamentId, bot_id: victim.botId }).first();
    expect(entry.version).toBe(1);
    expect(entry.loadout_revision).toBe(1);
    expect(entry.frozen).toBe(true);
  });

  it("DoD: corre de principio a fin sin intervención humana y publica campeón, clasificación y replays", async () => {
    await drainAll();

    const t = await h.db("tournaments").where({ id: tournamentId }).first();
    expect(t.state).toBe("finished");
    expect(t.champion_bot_id).toBeTruthy(); // campeón publicado

    // 8 participantes → bracket de 8: 7 matches, todos terminados.
    const matches = await h.db("matches").where({ tournament_id: tournamentId });
    expect(matches.length).toBe(7);
    expect(matches.every((m: Record<string, unknown>) => m.state === "finished")).toBe(true);

    // El campeón es el ganador de la final, marcada para modo visible (19.1).
    const final = matches.find((m: Record<string, unknown>) => m.final);
    expect(final).toBeTruthy();
    expect(final!.winner_bot_id).toBe(t.champion_bot_id);
    const finalBattles = await h.db("battles").where({ match_id: final!.id });
    expect(finalBattles.every((b: Record<string, unknown>) => b.spectator_mode === "visible")).toBe(true);

    // Todas las batallas oficiales, terminadas y con replay PUBLICADO (23.1).
    const battles = await h.db("battles").where({ tournament_id: tournamentId });
    expect(battles.length).toBe(7);
    for (const b of battles) {
      expect(b.status).toBe("finished");
      expect(b.official).toBe(true);
      expect(b.replay_ref).toBeTruthy();
      expect(existsSync(b.replay_ref)).toBe(true);
      expect(b.final_state_hash).toBeTruthy();
    }

    // El replay se descarga por la API pública de E7 sin cuenta (visitante).
    const replay = await request(app).get(`/replays/${battles[0].id}`);
    expect(replay.status).toBe(200);
    expect(replay.body.length).toBeGreaterThan(0);

    // Clasificación publicada en los standings REALES de E7 (caché ≤60 s).
    clearStandingsCache();
    const standings = await request(app).get(`/standings?seasonId=${t.season_id}&mode=deathmatch`);
    expect(standings.status).toBe(200);
    expect(standings.body.length).toBe(8);
    expect(standings.body[0].rank).toBe(1);
    expect(standings.body[0].botId).toBe(t.champion_bot_id); // el campeón lidera

    // Y ningún trabajo quedó atascado ni en revisión manual.
    const stuck = await h.db("jobs").whereIn("status", ["queued", "running", "needs_review"]);
    expect(stuck).toEqual([]);
  });

  it("las batallas del torneo usaron las semillas commit-reveal y el presupuesto congelado", async () => {
    const battles = await h.db("battles").where({ tournament_id: tournamentId });
    for (const b of battles) {
      expect(b.seed).toMatch(/^[0-9a-f]{64}$/); // derivada del lote revelado
      expect(b.seed_reveal_proof).toBeTruthy();
      expect(b.ruleset_id).toBe(DEFAULT_RULESET_ID);
    }
    const t = await h.db("tournaments").where({ id: tournamentId }).first();
    expect(t.budget_credits).toBe(900); // ADR-000: presupuesto del torneo, intacto
  });
});

describe("E9.M · modo simulacro (dry-run) del organizador", () => {
  it("valida el torneo sin escribir batallas ni ratings", async () => {
    const t = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${organizer}`)
      .send({ name: "simulacro", format: "round_robin", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
    const dry = await request(app)
      .post(`/tournaments/${t.body.id}/actions/dry-run`)
      .set("Authorization", `Bearer ${organizer}`);
    expect(dry.status).toBe(202);

    const battlesBefore = await h.db("battles").count("* as n").first();
    const eventsBefore = await h.db("rating_events").count("* as n").first();
    await drainAll();

    const job = await h.db("jobs").where({ kind: "tournament_dry_run" }).orderBy("created_at", "desc").first();
    expect(job.status).toBe("done");
    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    expect(payload.report.ok).toBe(true);
    expect(payload.report.usedExampleBots).toBe(true); // sin inscritos: 8 bots de ejemplo
    expect(payload.report.matches).toBeGreaterThan(0);

    // El simulacro NO escribió nada.
    const battlesAfter = await h.db("battles").count("* as n").first();
    const eventsAfter = await h.db("rating_events").count("* as n").first();
    expect(Number(battlesAfter!.n)).toBe(Number(battlesBefore!.n));
    expect(Number(eventsAfter!.n)).toBe(Number(eventsBefore!.n));
  });
});
