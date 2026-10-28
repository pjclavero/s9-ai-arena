/**
 * 4v4-STATS · `GET /battles/{id}/stats` de un team_deathmatch 4v4 REAL del
 * motor (8 participantes, respawn), procesado por el job de stats de verdad
 * (ingesta del replay + runStatsJob contra PostgreSQL) y leído por la API.
 *
 * Fija:
 *  - `perTeam` existe junto a `perBot`, sus bajas son el marcador del motor y
 *    es la suma de lo deportivo de `perBot`.
 *  - TD-047: `perTeam` es el MISMO para cualquier lector (dueño, rival, staff) y
 *    no lleva ningún campo de diagnóstico; los descartes de radio sólo los ve el
 *    dueño (en `diagnostics`), la actividad de radio (`perBot.radio`) es pública.
 *  - La política de lectura no cambia: un ajeno sigue recibiendo 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import type { Replay } from "../../arena-engine/src/replay.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { runStatsJob } from "../../replay-service/src/stats.js";
import { BLUE, RED, play4v4 } from "../../replay-service/tests/fixtures/team4v4.js";

let h: TestDbHandle;
let app: Express;
let replay: Replay;
let battleId: string;
let catalogVersion: string;
const tok: Record<string, string> = {};
const botOf: Record<string, string> = {}; // vehículo → uuid del bot

/** Campos que son DIAGNÓSTICO del dueño (TD-047/R12): nunca en perTeam, nunca a un rival. */
const DIAGNOSTIC_KEYS = ["cpuMs", "decisions", "rejectionsByReason", "radioDroppedByReason", "decisionTimeouts"];

async function newUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@team4v4.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id as string, token: await tokenFor(h.db, email) };
}

async function newBot(ownerId: string, visibility: string, name: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name, owner_id: ownerId, visibility });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.medium@1",
    modules: JSON.stringify([]),
  });
  await h
    .db("bot_versions")
    .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
  return id;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  app = createApp({
    db: h.db,
    anonQuota: { max: 100_000, windowMs: 3600_000 },
    publicReplaysEnabled: false,
    publicSpectateEnabled: false,
  });
  // Rojo: bots de A (r1, el que habla por radio, es PRIVADO). Azul: bots públicos de C.
  const A = await newUser("t4-owner-a");
  const C = await newUser("t4-owner-c");
  const S = await newUser("t4-stranger");
  tok.A = A.token;
  tok.C = C.token;
  tok.S = S.token;
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);
  for (const id of RED) botOf[id] = await newBot(A.id, id === "r1" ? "private" : "public", `T4-${id}`);
  for (const id of BLUE) botOf[id] = await newBot(C.id, "public", `T4-${id}`);

  ({ replay } = await play4v4("api-4v4-tdm", (v) => botOf[v]));
  const dir = mkdtempSync(join(tmpdir(), "t4-replays-"));
  ingestReplay(dir, replay, { official: false });

  battleId = randomUUID();
  await h.db("battles").insert({
    id: battleId,
    status: "finished",
    official: false,
    mode: "team_deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "api-4v4-tdm",
    replay_ref: "api-4v4-tdm",
    result: JSON.stringify({
      schema: "battle-result/v1",
      winner: replay.result.winner,
      ticks: replay.result.ticks,
      score: replay.result.score,
      disqualified: [],
      endReason: "completed",
      agents: "scripted",
    }),
    started_at: h.db.fn.now(),
    finished_at: h.db.fn.now(),
  });
  const outcome = (team: string) =>
    replay.result.winner === "draw" ? "draw" : replay.result.winner === team ? "win" : "loss";
  for (const p of replay.header.participants) {
    await h.db("participants").insert({
      battle_id: battleId,
      bot_id: p.botId,
      version: 1,
      team: p.team,
      outcome: outcome(p.team),
    });
  }
  await runStatsJob(h.db, dir, battleId, "api-4v4-tdm");
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

const get = (actor: string) =>
  request(app).get(`/battles/${battleId}/stats`).set("Authorization", `Bearer ${tok[actor]}`);

describe("4v4-STATS · /battles/{id}/stats con perTeam (TDM 4v4 real)", () => {
  it("perTeam junto a perBot: 8 bots, 2 bandos, bajas = marcador del motor", async () => {
    const r = await get("C");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(Object.keys(r.body.perBot)).toHaveLength(8);
    expect(Object.keys(r.body.perTeam).sort()).toEqual(["blue", "red"]);
    for (const team of ["red", "blue"]) {
      const t = r.body.perTeam[team];
      expect(t.bots).toBe(4);
      expect(t.kills, team).toBe(replay.result.score[team]);
      expect(t.score).toBe(replay.result.score[team]);
    }
    expect(r.body.perTeam.red.kills).toBe(r.body.perTeam.blue.deaths);
    expect(r.body.perTeam.blue.kills).toBe(r.body.perTeam.red.deaths);
    expect(r.body.perTeam.red.kills + r.body.perTeam.blue.kills).toBeGreaterThan(1);
  });

  it("perTeam = suma de lo que perBot enseña a ESE lector (bajas, muertes, daño, disparos, aciertos)", async () => {
    for (const actor of ["A", "C", "admin"]) {
      const r = await get(actor);
      for (const team of ["red", "blue"]) {
        const bots = Object.values(r.body.perBot as Record<string, any>).filter((b) => b.team === team);
        const sum = (k: string) => bots.reduce((a, b) => a + b[k], 0);
        const t = r.body.perTeam[team];
        for (const k of ["kills", "deaths", "shotsFired", "shotsHit"]) expect(t[k], `${actor} ${team} ${k}`).toBe(sum(k));
        for (const k of ["damageDealt", "damageTaken"]) expect(t[k]).toBeCloseTo(sum(k), 6);
        expect(t.survivors).toBe(bots.filter((b) => b.aliveAtEnd).length);
      }
    }
  });

  it("TD-047: perTeam es idéntico para dueño, rival y staff, y no lleva diagnóstico", async () => {
    const [a, c, admin] = await Promise.all([get("A"), get("C"), get("admin")]);
    expect(a.body.perTeam).toEqual(c.body.perTeam);
    expect(admin.body.perTeam).toEqual(c.body.perTeam);
    for (const t of Object.values(c.body.perTeam as Record<string, any>)) {
      for (const k of DIAGNOSTIC_KEYS) expect(t).not.toHaveProperty(k);
    }
  });

  it("radio: la actividad es pública en perBot; los descartes, sólo diagnóstico del dueño", async () => {
    const r1 = botOf.r1;
    const rival = await get("C");
    // El rival ve cuánto habló r1 y cuánto oyó cada uno (actividad de juego)...
    expect(rival.body.perBot[r1].radio.sent).toBeGreaterThan(0);
    for (const b of BLUE) expect(rival.body.perBot[botOf[b]].radio.receivedFromEnemies).toBeGreaterThan(0);
    // ...pero no cuánto le falla el código: ni descartes ni rechazos ni diagnóstico.
    for (const k of DIAGNOSTIC_KEYS) expect(rival.body.perBot[r1]).not.toHaveProperty(k);
    expect(rival.body.perBot[r1].perModule.radio_a).not.toHaveProperty("rejections");
    expect(rival.body.diagnostics).not.toHaveProperty(r1);

    const owner = await get("A");
    expect(owner.body.perBot[r1]).not.toHaveProperty("radioDroppedByReason");
    const drops = owner.body.diagnostics[r1].radioDroppedByReason;
    expect(drops.rate_limited).toBeGreaterThan(0);
    expect(drops.too_large).toBeGreaterThan(0);
    expect(owner.body.perBot[r1].perModule.radio_a.rejections).toBe(drops.rate_limited + drops.too_large);
    // El dueño ve el diagnóstico de SUS bots, no el de los de C.
    expect(owner.body.diagnostics).not.toHaveProperty(botOf.b1);
  });

  it("la política de lectura no cambia: un ajeno recibe el 404 uniforme (batalla con bot privado)", async () => {
    const r = await get("S");
    expect(r.status).toBe(404);
    expect(r.body).not.toHaveProperty("perTeam");
  });
});
