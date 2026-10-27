/**
 * UX-F (DEF-R3) · Matriz de autorización de las vistas de TORNEO que nombran
 * participantes: batallas del torneo, cuadro (matches) y clasificación.
 *
 * Antes `GET /tournaments/{id}/battles` (visitor) daba a cualquier anónimo el
 * botId, la versión, el resultado y el nombre de un bot PRIVADO, y el cuadro y la
 * clasificación lo nombraban igual. Expectativas escritas desde la POLÍTICA
 * (battle-access.ts): la batalla con un bot no público sólo la leen su dueño, su
 * equipo y el staff; fuera de la batalla, un bot privado ajeno se proyecta como
 * «Bot privado» sin id.
 *
 * Actores: anónimo · ajeno (B) · dueño del bot privado (A) · staff (organizer).
 * Se prueba con las capabilities públicas ENCENDIDAS (el caso más abierto).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { clearStandingsCache } from "./services/standings.js";

let h: TestDbHandle;
let app: Express;
let catalogVersion: string;
const tok: Record<string, string | undefined> = {};
const BOT: Record<string, string> = {};
let tournamentId: string;
const SEASON = "uxf-season";
const PRIV_NAME = "AUDIT-UXF-privado";

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@uxf.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newBot(ownerId: string, visibility: string, name: string): Promise<string> {
  const id = randomUUID();
  await h.db("bots").insert({ id, name, owner_id: ownerId, visibility });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.scout@1",
    modules: JSON.stringify([]),
  });
  await h
    .db("bot_versions")
    .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
  return id;
}

async function newBattle(botIds: string[], matchId: string | null): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: "finished",
    official: true,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "uxf-seed",
    tournament_id: tournamentId,
    match_id: matchId,
    replay_ref: `/no/existe/${id}.replay`,
    result: JSON.stringify({ winner: "A", ticks: 900, score: { A: 1, B: 0 }, endReason: "completed" }),
    finished_at: h.db.fn.now(),
    started_at: h.db.fn.now(),
  });
  let i = 0;
  for (const botId of botIds) {
    await h.db("participants").insert({
      battle_id: id,
      bot_id: botId,
      version: 1,
      team: i++ % 2 ? "B" : "A",
      outcome: i === 1 ? "win" : "loss",
    });
  }
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  app = createApp({
    db: h.db,
    anonQuota: { max: 100_000, windowMs: 3600_000 },
    publicReplaysEnabled: true,
    publicSpectateEnabled: true,
  });
  const A = await newUser("uxf-owner-a");
  const B = await newUser("uxf-stranger-b");
  const C = await newUser("uxf-owner-c");
  tok.anon = undefined;
  tok.B = B.token;
  tok.A = A.token;
  tok.staff = await tokenFor(h.db, DEV_USERS.organizer);

  BOT.priv = await newBot(A.id, "private", PRIV_NAME);
  BOT.pub1 = await newBot(C.id, "public", "AUDIT-UXF-publico-1");
  BOT.pub2 = await newBot(C.id, "public", "AUDIT-UXF-publico-2");

  const [t] = await h
    .db("tournaments")
    .insert({
      name: "AUDIT-UXF-torneo",
      format: "round_robin",
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      state: "running",
    })
    .returning("id");
  tournamentId = t.id;
  const [mPriv] = await h
    .db("matches")
    .insert({
      tournament_id: tournamentId,
      round: 1,
      slot: "R1M1",
      state: "finished",
      pairing: JSON.stringify({ slot: "R1M1", round: 1, bracket: "main", home: BOT.priv, away: BOT.pub1 }),
      winner_bot_id: BOT.priv,
    })
    .returning("id");
  const [mPub] = await h
    .db("matches")
    .insert({
      tournament_id: tournamentId,
      round: 1,
      slot: "R1M2",
      state: "finished",
      pairing: JSON.stringify({ slot: "R1M2", round: 1, bracket: "main", home: BOT.pub1, away: BOT.pub2 }),
      winner_bot_id: BOT.pub1,
    })
    .returning("id");
  await newBattle([BOT.priv, BOT.pub1], mPriv.id);
  await newBattle([BOT.pub1, BOT.pub2], mPub.id);

  await h.db("standings").insert([
    { season_id: SEASON, mode: "deathmatch", bot_id: BOT.priv, rank: 1, rating: 1530, wins: 1 },
    { season_id: SEASON, mode: "deathmatch", bot_id: BOT.pub1, rank: 2, rating: 1500, wins: 1, losses: 1 },
  ]);
  clearStandingsCache();
}, 180_000);

afterAll(async () => {
  await h.stop();
});

function get(path: string, who: string) {
  const r = request(app).get(path);
  return tok[who] ? r.set("Authorization", `Bearer ${tok[who]}`) : r;
}

/** ¿La respuesta identifica al bot privado (id o nombre) en algún sitio? */
const leaks = (body: unknown) => {
  const s = JSON.stringify(body);
  return s.includes(BOT.priv) || s.includes(PRIV_NAME);
};

describe("DEF-R3 · batallas del torneo", () => {
  for (const [who, sees] of [
    ["anon", false],
    ["B", false],
    ["A", true],
    ["staff", true],
  ] as const) {
    it(`${who}: ${sees ? "ve" : "NO ve"} la batalla con el bot privado`, async () => {
      const r = await get(`/tournaments/${tournamentId}/battles`, who);
      expect(r.status).toBe(200);
      // Depende de quién pregunta: una caché compartida serviría la vista del dueño al anónimo.
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.body.items.length).toBe(sees ? 2 : 1);
      expect(leaks(r.body)).toBe(sees);
      // La batalla entre públicos se sigue viendo con sus nombres.
      expect(JSON.stringify(r.body)).toContain("AUDIT-UXF-publico-2");
    });
  }
});

describe("DEF-R3 · cuadro del torneo (matches)", () => {
  for (const [who, sees] of [
    ["anon", false],
    ["B", false],
    ["A", true],
    ["staff", true],
  ] as const) {
    it(`${who}: el bot privado ${sees ? "aparece" : "sale como privado, sin id"}`, async () => {
      const r = await get(`/tournaments/${tournamentId}/matches`, who);
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.body.matches).toHaveLength(2); // el cuadro no pierde partidos
      expect(leaks(r.body)).toBe(sees);
      const m = r.body.matches.find((x: any) => x.slot === "R1M1");
      if (sees) {
        expect(m.winnerBotId).toBe(BOT.priv);
        expect(m.pairing.home).toBe(BOT.priv);
      } else {
        expect(m.winnerBotId).toBeNull();
        expect(m.winnerPrivate).toBe(true);
        expect(m.pairing.home).toBeNull();
        expect(m.pairing.homePrivate).toBe(true);
        expect(m.pairing.away).toBe(BOT.pub1);
      }
    });
  }
});

describe("DEF-R3 · clasificación", () => {
  for (const [who, sees] of [
    ["anon", false],
    ["B", false],
    ["A", true],
    ["staff", true],
  ] as const) {
    it(`${who}: el puesto del bot privado ${sees ? "lo nombra" : "se conserva como «Bot privado»"}`, async () => {
      const r = await get(`/standings?seasonId=${SEASON}&mode=deathmatch`, who);
      expect(r.status).toBe(200);
      expect(r.body.map((x: any) => x.rank)).toEqual([1, 2]); // el ranking no cambia
      expect(leaks(r.body)).toBe(sees);
      if (!sees) {
        expect(r.body[0]).toMatchObject({ rank: 1, botId: null, botName: "Bot privado", private: true });
      }
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.body[1].botId).toBe(BOT.pub1);
    });
  }
});
