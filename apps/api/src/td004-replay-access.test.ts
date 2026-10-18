/**
 * PRC (TD-004) · Matriz de autorización de replays en la API (la ÚNICA autoridad).
 *
 * Expectativas escritas a partir de la POLÍTICA (docs/technical/replays.md,
 * apps/api/src/replay-access.ts), no del código: para cada actor y cada ruta
 * que entrega un replay —listado, archivo, índice, segmento, verify y
 * /public/replays*— PASS o 404 uniforme. Replays REALES del motor (E2),
 * ingeridos con el almacén del replay-service; PostgreSQL embebido.
 *
 * Actores: anónimo · dueño de un bot participante (A) · ajeno (B) · miembro del
 * equipo de un bot `team` (T) · miembro del equipo de un bot `private` (Tp) ·
 * developer sin relación · organizer/moderator/admin (staff).
 * Batallas: bPriv (bot privado de A + uno público) · bTeam (bot `team` del
 * equipo de T) · bPrivTeam (bot `private` con equipo de Tp) · bPub (sólo bots
 * públicos).
 *
 * Lo que pone esto en ROJO (mutaciones del informe de DEV-SEC): abrir la
 * política (`whereReplayReadable` sin filtro), quitar el predicado público
 * (`wherePublicReplay` sin el NOT EXISTS) o volver a mensajes de 404 distintos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";

let h: TestDbHandle;
let off: Express; // S9_PUBLIC_REPLAYS_ENABLED apagada (defecto)
let on: Express; // encendida explícitamente
let dir: string;
let base: Replay;
let catalogVersion: string;

const tok: Record<string, string> = {};
const B: Record<string, string> = {}; // batallas por nombre

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@td004.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newTeam(captainId: string, memberIds: string[]): Promise<string> {
  const [t] = await h
    .db("teams")
    .insert({ name: `td004-${randomUUID().slice(0, 8)}`, captain_id: captainId })
    .returning("id");
  for (const uid of [captainId, ...memberIds]) {
    await h.db("team_members").insert({ team_id: t.id, user_id: uid, role: uid === captainId ? "captain" : "member" });
  }
  return t.id;
}

async function newBot(ownerId: string, visibility: string, teamId: string | null = null): Promise<string> {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `td004-${id.slice(0, 8)}`, owner_id: ownerId, visibility, team_id: teamId });
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

/** Batalla `finished` con un replay REAL ingerido a su nombre. */
async function newBattle(botIds: string[]): Promise<string> {
  const id = randomUUID();
  const stored = ingestReplay(dir, { ...base, header: { ...base.header, battleId: id } }, { official: false });
  await h.db("battles").insert({
    id,
    status: "finished",
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "td004-secret-seed",
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: base.result.finalStateHash,
    result: JSON.stringify({ score: base.result.score, ticks: base.result.ticks }),
    finished_at: h.db.fn.now(),
  });
  let i = 0;
  for (const botId of botIds) {
    await h.db("participants").insert({ battle_id: id, bot_id: botId, version: 1, team: i++ % 2 ? "B" : "A" });
  }
  return id;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  const quota = { max: 100_000, windowMs: 3600_000 };
  off = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: false });
  on = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: true });
  dir = mkdtempSync(join(tmpdir(), "td004-replays-"));
  base = await record(
    {
      battleId: "td004-base",
      seed: "td004",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 90 }),
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

  const A = await newUser("owner-a");
  const Bu = await newUser("stranger-b");
  const T = await newUser("team-t");
  const Tp = await newUser("team-tp");
  const C = await newUser("owner-c");
  tok.A = A.token;
  tok.B = Bu.token;
  tok.T = T.token;
  tok.Tp = Tp.token;
  tok.C = C.token;
  tok.developer = await tokenFor(h.db, DEV_USERS.developer);
  tok.organizer = await tokenFor(h.db, DEV_USERS.organizer);
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);

  const teamX = await newTeam(C.id, [T.id]);
  const teamY = await newTeam(C.id, [Tp.id]);
  const privA = await newBot(A.id, "private");
  const teamBot = await newBot(C.id, "team", teamX);
  const privTeamBot = await newBot(C.id, "private", teamY);
  const pub1 = await newBot(C.id, "public");
  const pub2 = await newBot(C.id, "public");

  B.priv = await newBattle([privA, pub1]);
  B.team = await newBattle([teamBot, pub1]);
  B.privTeam = await newBattle([privTeamBot, pub2]);
  B.pub = await newBattle([pub1, pub2]);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Actor = "anon" | "A" | "B" | "T" | "Tp" | "C" | "developer" | "organizer" | "moderator" | "admin";
const RESOURCES = ["index", "segment", "file"] as const;

function get(app: Express, actor: Actor, path: string) {
  const r = request(app).get(path);
  return actor === "anon" ? r : r.set("Authorization", `Bearer ${tok[actor]}`);
}
function pathFor(battleId: string, res: (typeof RESOURCES)[number]): string {
  if (res === "index") return `/replays/${battleId}/index`;
  if (res === "segment") return `/replays/${battleId}/segment?fromTick=0&toTick=60`;
  return `/replays/${battleId}`;
}

/** Política esperada (docs/technical/replays.md), independiente del código. */
const EXPECT: Record<"off" | "on", Record<string, Partial<Record<Actor, boolean>>>> = {
  off: {
    priv: { A: true, C: true, organizer: true, moderator: true, admin: true }, // C: dueño de pub1, que participa
    team: { T: true, C: true, organizer: true, moderator: true, admin: true },
    privTeam: { C: true, organizer: true, moderator: true, admin: true },
    pub: { C: true, organizer: true, moderator: true, admin: true },
  },
  on: {
    priv: { A: true, C: true, organizer: true, moderator: true, admin: true }, // C: dueño de pub1, que participa
    team: { T: true, C: true, organizer: true, moderator: true, admin: true },
    privTeam: { C: true, organizer: true, moderator: true, admin: true },
    // Público: cualquiera, anónimos incluidos.
    pub: {
      anon: true,
      A: true,
      B: true,
      T: true,
      Tp: true,
      C: true,
      developer: true,
      organizer: true,
      moderator: true,
      admin: true,
    },
  },
};
const ACTORS: Actor[] = ["anon", "A", "B", "T", "Tp", "C", "developer", "organizer", "moderator", "admin"];

describe("TD-004 · matriz actor × batalla × recurso (índice, segmento, archivo)", () => {
  for (const flag of ["off", "on"] as const) {
    for (const battle of ["priv", "team", "privTeam", "pub"]) {
      for (const actor of ACTORS) {
        const allowed = Boolean(EXPECT[flag][battle][actor]);
        it(`flag ${flag} · ${battle} · ${actor} ⇒ ${allowed ? "PASS" : "404"}`, async () => {
          const app = flag === "on" ? on : off;
          for (const res of RESOURCES) {
            const r = await get(app, actor, pathFor(B[battle], res));
            expect(r.status, `${res} ${battle} ${actor} flag=${flag}`).toBe(allowed ? 200 : 404);
            if (allowed) {
              expect(r.headers["cache-control"]).toBe("private, no-store");
              if (res === "index") expect(r.body.battleId).toBe(B[battle]);
              if (res === "segment") expect(r.body.snapshots.length).toBeGreaterThan(0);
            } else {
              expect(r.body.error).toBe("not_found");
              // Ni rastro del contenido del replay en la denegación.
              expect(JSON.stringify(r.body)).not.toMatch(/keyframes|snapshots|finalStateHash/);
            }
          }
        });
      }
    }
  }
});

describe("TD-004 · sin enumeración por UUID", () => {
  it("«no autorizado», «no existe» e «id inválido» responden EXACTAMENTE igual (código, error y mensaje)", async () => {
    const strip = (b: Record<string, unknown>) => ({ error: b.error, message: b.message });
    for (const res of RESOURCES) {
      const denied = await get(off, "B", pathFor(B.priv, res));
      const missing = await get(off, "B", pathFor(randomUUID(), res));
      const invalid = await get(off, "B", pathFor("no-es-un-uuid", res));
      const anonDenied = await get(off, "anon", pathFor(B.priv, res));
      expect([denied.status, missing.status, invalid.status, anonDenied.status]).toEqual([404, 404, 404, 404]);
      expect(strip(denied.body)).toEqual(strip(missing.body));
      expect(strip(invalid.body)).toEqual(strip(missing.body));
      expect(strip(anonDenied.body)).toEqual(strip(missing.body));
    }
  });
});

describe("TD-004 · verifyReplay sigue la misma política", () => {
  it("anónimo y ajeno ⇒ 404; dueño ⇒ 200 matches=true", async () => {
    expect((await request(off).post(`/replays/${B.priv}/verify`)).status).toBe(404);
    expect((await request(off).post(`/replays/${B.priv}/verify`).set("Authorization", `Bearer ${tok.B}`)).status).toBe(
      404,
    );
    const ok = await request(off).post(`/replays/${B.priv}/verify`).set("Authorization", `Bearer ${tok.A}`);
    expect(ok.status).toBe(200);
    expect(ok.body.matches).toBe(true);
  }, 120_000);
});

describe("TD-004 · listado GET /replays (sustituye al inventario anónimo del replay-service)", () => {
  const ids = (r: request.Response) => new Set((r.body.items as { battleId: string }[]).map((i) => i.battleId));

  it("anónimo ⇒ 401 (nunca el inventario)", async () => {
    expect((await request(off).get("/replays")).status).toBe(401);
    expect((await request(on).get("/replays")).status).toBe(401);
  });

  it("cada usuario ve SÓLO lo que la política le deja leer", async () => {
    const mine = Object.values(B);
    const seen = async (app: Express, actor: Actor) => {
      const r = await get(app, actor, "/replays");
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("private, no-store");
      const s = ids(r);
      return mine.filter((id) => s.has(id));
    };
    expect(await seen(off, "A")).toEqual([B.priv]);
    expect(await seen(off, "B")).toEqual([]);
    expect((await seen(off, "T")).sort()).toEqual([B.team].sort());
    expect(await seen(off, "Tp")).toEqual([]);
    expect((await seen(off, "organizer")).sort()).toEqual([...mine].sort());
    // Con la capability: se añade SÓLO la batalla con todos los bots públicos.
    expect((await seen(on, "B")).sort()).toEqual([B.pub].sort());
    expect((await seen(on, "A")).sort()).toEqual([B.priv, B.pub].sort());
  });
});

describe("TD-004 · /public/replays*: activar la capability NO publica todos los ficheros", () => {
  it("flag on: el listado público incluye bPub y excluye las batallas con bots no públicos", async () => {
    const r = await request(on).get("/public/replays?limit=50");
    expect(r.status).toBe(200);
    const s = new Set((r.body.items as { id: string }[]).map((i) => i.id));
    expect(s.has(B.pub)).toBe(true);
    for (const k of ["priv", "team", "privTeam"]) expect(s.has(B[k]), k).toBe(false);
  });

  it("flag on: detalle y descarga pública de una batalla con bot privado ⇒ 404; de bPub ⇒ 200", async () => {
    expect((await request(on).get(`/public/replays/${B.priv}`)).status).toBe(404);
    expect((await request(on).get(`/public/replays/${B.priv}/download`)).status).toBe(404);
    expect((await request(on).get(`/public/replays/${B.pub}`)).status).toBe(200);
    expect((await request(on).get(`/public/replays/${B.pub}/download`)).status).toBe(200);
  });

  it("flag off: nada público, ni siquiera bPub", async () => {
    expect((await request(off).get(`/public/replays/${B.pub}`)).status).toBe(404);
    expect((await request(off).get(`/public/replays/${B.pub}/download`)).status).toBe(404);
  });
});
