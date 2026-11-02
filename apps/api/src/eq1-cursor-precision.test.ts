/**
 * EQ1 · P2 del cursor de paginación (hallazgo del EQ6 en #216) · otros listados.
 *
 * El cursor guardaba `created_at` truncado a milisegundos y PostgreSQL guarda
 * microsegundos: `(created_at, id) < cursor` descartaba las filas del milisegundo
 * frontera. Aquí, con varias filas en el MISMO milisegundo (con microsegundos
 * distintos y también idénticos) cayendo justo en el borde de página, se exige en
 * GET /battles, GET /replays, GET /public/replays y GET /maps:
 *   - el recorrido completo devuelve cada fila legible EXACTAMENTE una vez;
 *   - NO aparece ninguna batalla que el solicitante no pueda leer (sin fugas);
 *   - un cursor del formato antiguo (ms) o mal formado → 400, nunca datos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";

let h: TestDbHandle;
let app: Express;
let appPublic: Express;
let dir: string;
let base: Replay;
let catalogVersion: string;
const RUN = randomUUID().slice(0, 6);
const U: Record<string, { id: string; token: string }> = {};
const BOT: Record<string, string> = {};
const VISIBLE_A: string[] = []; // batallas que A puede leer (sólo bots públicos de A)
const HIDDEN_A: string[] = []; // batallas sólo con bots privados de B

/**
 * Todas en el MISMO milisegundo …00.123: seis con microsegundos distintos y seis
 * con un microsegundo idéntico. Con el formato antiguo, todo lo que quedase tras
 * el primer borde de página con µs > .123000 desaparecía.
 */
const SAME_MS = [
  "2026-03-01T10:00:00.123001Z",
  "2026-03-01T10:00:00.123200Z",
  "2026-03-01T10:00:00.123400Z",
  "2026-03-01T10:00:00.123600Z",
  "2026-03-01T10:00:00.123800Z",
  "2026-03-01T10:00:00.123999Z",
  ...Array.from({ length: 6 }, () => "2026-03-01T10:00:00.123500Z"),
];

async function newUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@eq1.example.internal`;
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: "x", display_name: `${label}-${RUN}` })
    .returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id as string, token: await tokenFor(h.db, email) };
}

async function newBot(key: string, ownerId: string, visibility: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${key}-${RUN}`, owner_id: ownerId, visibility });
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
  BOT[key] = id;
}

async function newBattle(botKeys: [string, string], createdAt: string): Promise<string> {
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
    seed: "eq1-secret-seed",
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: base.result.finalStateHash,
    result: JSON.stringify({ score: base.result.score, ticks: base.result.ticks, winner: "A" }),
    created_at: createdAt,
    finished_at: createdAt,
  });
  await h.db("participants").insert([
    { battle_id: id, bot_id: BOT[botKeys[0]], version: 1, team: "A" },
    { battle_id: id, bot_id: BOT[botKeys[1]], version: 1, team: "B" },
  ]);
  return id;
}

/** Recorre un listado con `limit` pequeño y devuelve los ids, en orden. */
async function walk(a: Express, path: string, idOf: (x: any) => string, token?: string, limit = 3) {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const req = request(a).get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const r = await (token ? req.set({ Authorization: `Bearer ${token}` }) : req);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    ids.push(...r.body.items.map(idOf));
    cursor = r.body.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  return ids;
}

const oldCursor = (iso: string, id: string) => Buffer.from(`${iso}|${id}`).toString("base64url");

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  app = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 }, publicReplaysEnabled: false });
  appPublic = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 }, publicReplaysEnabled: true });
  dir = mkdtempSync(join(tmpdir(), "eq1-cursor-"));
  base = await record(
    {
      battleId: "eq1-base",
      seed: "eq1",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
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
  U.A = await newUser("eq1a");
  U.B = await newUser("eq1b");
  await newBot("pubA", U.A.id, "public");
  await newBot("pubA2", U.A.id, "public");
  await newBot("privB", U.B.id, "private");
  await newBot("privB2", U.B.id, "private");
  // Intercaladas: visibles y ocultas comparten el mismo milisegundo.
  for (const [i, ts] of SAME_MS.entries()) {
    if (i % 3 === 2) HIDDEN_A.push(await newBattle(["privB", "privB2"], ts));
    else VISIBLE_A.push(await newBattle(["pubA", "pubA2"], ts));
  }
}, 180_000);

afterAll(async () => {
  await h.stop();
});

describe("EQ1 · cursor con empate de milisegundo en el borde de página", () => {
  it("las 12 batallas comparten de verdad el mismo milisegundo (precondición)", async () => {
    const rows: { ms: Date; n: number }[] = await h
      .db("battles")
      .whereIn("id", [...VISIBLE_A, ...HIDDEN_A])
      .select(
        h.db.raw("date_trunc('milliseconds', created_at) AS ms"),
        h.db.raw("count(DISTINCT created_at)::int AS n"),
      )
      .groupBy("ms");
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(7); // 6 µs distintos + 1 repetido
  });

  for (const limit of [1, 2, 3, 5]) {
    it(`GET /battles (limit=${limit}): A ve sus 8 batallas una vez y ninguna ajena`, async () => {
      const ids = await walk(app, "/battles?status=finished", (b) => b.id, U.A.token, limit);
      const mine = ids.filter((x) => VISIBLE_A.includes(x) || HIDDEN_A.includes(x));
      expect(new Set(mine).size, "duplicados").toBe(mine.length);
      expect([...mine].sort()).toEqual([...VISIBLE_A].sort());
      expect(
        ids.filter((x) => HIDDEN_A.includes(x)),
        "fuga de batallas privadas",
      ).toEqual([]);
    });
  }

  it("GET /battles: B ve sus 4 batallas privadas una vez", async () => {
    const ids = await walk(app, "/battles?status=finished", (b) => b.id, U.B.token, 2);
    const mine = ids.filter((x) => VISIBLE_A.includes(x) || HIDDEN_A.includes(x));
    expect(new Set(mine).size).toBe(mine.length);
    expect(mine.filter((x) => HIDDEN_A.includes(x)).sort()).toEqual([...HIDDEN_A].sort());
  });

  for (const limit of [1, 3]) {
    it(`GET /replays (limit=${limit}): A recorre sus 8 replays una vez y ninguno ajeno`, async () => {
      const ids = await walk(app, "/replays", (r) => r.battleId, U.A.token, limit);
      const mine = ids.filter((x) => VISIBLE_A.includes(x) || HIDDEN_A.includes(x));
      expect(new Set(mine).size, "duplicados").toBe(mine.length);
      expect([...mine].sort()).toEqual([...VISIBLE_A].sort());
      expect(
        ids.filter((x) => HIDDEN_A.includes(x)),
        "fuga de replays privados",
      ).toEqual([]);
    });
  }

  it("GET /public/replays (anónimo, limit=2): sólo las 8 públicas, una vez", async () => {
    const ids = await walk(appPublic, "/public/replays", (r) => r.battleId ?? r.id, undefined, 2);
    const mine = ids.filter((x) => VISIBLE_A.includes(x) || HIDDEN_A.includes(x));
    expect(new Set(mine).size).toBe(mine.length);
    expect([...mine].sort()).toEqual([...VISIBLE_A].sort());
    expect(ids.filter((x) => HIDDEN_A.includes(x))).toEqual([]);
  });

  it("GET /maps (limit=1): versiones del mismo mapa con el mismo created_at salen todas, una vez", async () => {
    const seedVersion = await h.db("map_versions").where({ map_id: "mvp-arena-01", version: 1 }).first();
    const mapId = `eq1-map-${RUN}`;
    await h.db("maps").insert({ id: mapId, name: mapId, created_by: U.A.id });
    const ts = "2026-03-02T10:00:00.555555Z";
    await h.db("map_versions").insert(
      [1, 2, 3].map((version) => ({
        map_id: mapId,
        version,
        state: "validated",
        content: JSON.stringify(seedVersion.content),
        supported_modes: JSON.stringify(seedVersion.supported_modes ?? []),
        created_at: ts,
      })),
    );
    const seen = (await walk(app, "/maps", (m) => `${m.mapId}@${m.version}`, U.A.token, 1)).filter((x) =>
      x.startsWith(`${mapId}@`),
    );
    expect(seen).toEqual([`${mapId}@3`, `${mapId}@2`, `${mapId}@1`]);
  });

  it("un cursor del formato ANTIGUO (milisegundos) o mal formado → 400 en todos los listados, nunca datos", async () => {
    const legacy = oldCursor("2026-03-01T10:00:00.123Z", VISIBLE_A[0]!);
    const paths: [Express, string, string | undefined][] = [
      [app, "/battles", U.A.token],
      [app, "/replays", U.A.token],
      [appPublic, "/public/replays", undefined],
      [app, "/bots", U.A.token],
      [app, "/teams", U.A.token],
      [app, "/tournaments", U.A.token],
      [app, "/maps", U.A.token],
    ];
    for (const [a, p, token] of paths) {
      for (const c of [legacy, "no-es-un-cursor", Buffer.from('{"v":2,"t":"x","k":[]}').toString("base64url")]) {
        const req = request(a).get(`${p}?cursor=${encodeURIComponent(c)}`);
        const r = await (token ? req.set({ Authorization: `Bearer ${token}` }) : req);
        expect(r.status, `${p} con cursor ${c.slice(0, 20)}…`).toBe(400);
        expect(r.body.items, `${p} devolvió datos con un cursor inválido`).toBeUndefined();
      }
    }
  });
});
