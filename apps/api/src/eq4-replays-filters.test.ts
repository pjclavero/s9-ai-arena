/**
 * EQ4 · Filtros y paginación EN SERVIDOR de `GET /replays` (listReplays).
 *
 * Expectativas escritas desde el contrato (apps/api/openapi.yaml) y la política
 * de acceso (replay-access.ts / battle-access.ts), no desde el código:
 *  - Retrocompatibilidad: sin parámetros nuevos, misma forma y mismo contenido.
 *  - Seguridad: un filtro sólo ESTRECHA lo legible. Ni el id/prefijo de una
 *    batalla ajena, ni el id/nombre/equipo/dueño de un bot privado ajeno (aunque
 *    la batalla sea legible porque eres su rival) devuelven nada.
 *  - Validación: valores fuera de forma ⇒ 400 bad_request (nunca 500).
 *  - Paginación con cursor + `total` opcional, sin duplicados ni huecos.
 * PostgreSQL embebido y replays REALES del motor ingeridos con el almacén.
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
import { escapeLike, parseReplayListFilters } from "./services/replay-list.js";

let h: TestDbHandle;
let app: Express;
let dir: string;
let base: Replay;
let catalogVersion: string;
const RUN = randomUUID().slice(0, 6);

const tok: Record<string, string> = {};
const U: Record<string, string> = {}; // usuarios
const BOT: Record<string, string> = {};
const BOT_NAME: Record<string, string> = {};
const B: Record<string, string> = {}; // batallas
let teamX = "";
let teamXName = "";

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@eq4.example.internal`;
  const [u] = await h
    .db("users")
    .insert({ email, password_hash: "x", display_name: `${label}-${RUN}` })
    .returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newBot(key: string, name: string, ownerId: string, visibility: string, teamId: string | null = null) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name, owner_id: ownerId, visibility, team_id: teamId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.scout@1",
    modules: JSON.stringify([]),
  });
  await h.db("bot_versions").insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
  BOT[key] = id;
  BOT_NAME[key] = name;
}

interface BattleSpec {
  bots: { key: string; outcome?: string }[];
  mode: string;
  createdAt: string;
  winner?: string;
  failureKind?: string;
}

async function newBattle(spec: BattleSpec): Promise<string> {
  const id = randomUUID();
  const stored = ingestReplay(dir, { ...base, header: { ...base.header, battleId: id } }, { official: false });
  await h.db("battles").insert({
    id,
    status: "finished",
    official: false,
    mode: spec.mode,
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "eq4-secret-seed",
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: base.result.finalStateHash,
    failure_kind: spec.failureKind ?? "none",
    result: JSON.stringify({ score: base.result.score, ticks: base.result.ticks, winner: spec.winner ?? "A" }),
    created_at: spec.createdAt,
    finished_at: spec.createdAt,
  });
  let i = 0;
  for (const p of spec.bots) {
    await h.db("participants").insert({
      battle_id: id,
      bot_id: BOT[p.key],
      version: 1,
      team: i++ % 2 ? "B" : "A",
      outcome: p.outcome ?? null,
    });
  }
  return id;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  app = createApp({ db: h.db, anonQuota: { max: 100_000, windowMs: 3600_000 }, publicReplaysEnabled: false });
  dir = mkdtempSync(join(tmpdir(), "eq4-replays-"));
  base = await record(
    {
      battleId: "eq4-base",
      seed: "eq4",
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

  for (const k of ["A", "B", "C", "T"]) {
    const u = await newUser(`eq4${k.toLowerCase()}`);
    U[k] = u.id;
    tok[k] = u.token;
  }
  tok.organizer = await tokenFor(h.db, DEV_USERS.organizer);

  teamXName = `Alfa-${RUN}`;
  const [t] = await h.db("teams").insert({ name: teamXName, captain_id: U.C }).returning("id");
  teamX = t.id;
  for (const uid of [U.C, U.T]) {
    await h.db("team_members").insert({ team_id: teamX, user_id: uid, role: uid === U.C ? "captain" : "member" });
  }

  await newBot("privA", `privadoA-${RUN}`, U.A, "private");
  await newBot("pubA", `Tanque_100%-${RUN}`, U.A, "public");
  await newBot("pubA2", `Tanque-100x-${RUN}`, U.A, "public"); // cebo para el escape de `_` y `%`
  await newBot("pubC", `publicoC-${RUN}`, U.C, "public", teamX);
  await newBot("teamC", `equipoC-${RUN}`, U.C, "team", teamX);
  await newBot("privB", `secretoB-${RUN}`, U.B, "private");

  B.b1 = await newBattle({
    bots: [{ key: "pubA", outcome: "win" }, { key: "pubC", outcome: "loss" }],
    mode: "deathmatch",
    createdAt: "2026-01-10T12:00:00Z",
  });
  B.b2 = await newBattle({
    bots: [{ key: "privA", outcome: "draw" }, { key: "pubC", outcome: "draw" }],
    mode: "capture_the_flag",
    createdAt: "2026-02-10T12:00:00Z",
    winner: "draw",
  });
  // Legible por A (es dueño de pubA) pero con un bot PRIVADO de B: rival.
  B.b3 = await newBattle({
    bots: [{ key: "pubA", outcome: "win" }, { key: "privB", outcome: "disqualified" }],
    mode: "zone_control",
    createdAt: "2026-03-10T12:00:00Z",
    failureKind: "bot_crash",
  });
  // NO legible por A: sólo bots de B (privado) y de C (team, A no es miembro).
  B.b4 = await newBattle({
    bots: [{ key: "privB", outcome: "win" }, { key: "teamC", outcome: "loss" }],
    mode: "team_deathmatch",
    createdAt: "2026-04-10T12:00:00Z",
  });
  B.b5 = await newBattle({
    bots: [{ key: "pubA2", outcome: "loss" }, { key: "pubC", outcome: "win" }],
    mode: "team_deathmatch",
    createdAt: "2026-05-10T12:00:00Z",
  });
  B.b6 = await newBattle({
    bots: [{ key: "pubA", outcome: "loss" }, { key: "teamC", outcome: "win" }],
    mode: "deathmatch",
    createdAt: "2026-06-10T12:00:00Z",
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function list(actor: string | null, query = "") {
  const r = request(app).get(`/replays${query ? `?${query}` : ""}`);
  return actor ? r.set("Authorization", `Bearer ${tok[actor]}`) : r;
}
async function ids(actor: string, query = ""): Promise<string[]> {
  const res = await list(actor, query);
  expect(res.status, `${query} → ${JSON.stringify(res.body)}`).toBe(200);
  return (res.body.items as { battleId: string }[]).map((i) => i.battleId);
}
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

// Legibles por A: b1, b2, b3, b5, b6 (todas con un bot suyo). b4 no.
const READABLE_A = () => [B.b6, B.b5, B.b3, B.b2, B.b1];

describe("EQ4 · retrocompatibilidad sin parámetros", () => {
  it("misma forma de siempre: items + nextCursor opcional, sin `total`, más recientes primero", async () => {
    const res = await list("A");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Object.keys(res.body).sort()).toEqual(["items"]); // nextCursor undefined ⇒ ausente en JSON
    expect(res.body.items.map((i: any) => i.battleId)).toEqual(READABLE_A());
    for (const it of res.body.items) {
      expect(Object.keys(it).sort()).toEqual(["battleId", "createdAt", "official", "sizeBytes", "ticks", "winner"]);
    }
  });

  it("sin sesión sigue siendo 401 (x-min-role: user)", async () => {
    expect((await list(null)).status).toBe(401);
    expect((await list(null, "mode=deathmatch")).status).toBe(401);
  });

  it("parseReplayListFilters({}) no activa ningún filtro", () => {
    expect(parseReplayListFilters({})).toEqual({ includeTotal: false });
  });
});

describe("EQ4 · seguridad: el filtro nunca amplía ni sirve de oráculo", () => {
  it("el id COMPLETO de una batalla ajena no devuelve nada", async () => {
    expect(await ids("A", q({ battleId: B.b4 }))).toEqual([]);
    expect(await ids("B", q({ battleId: B.b4 }))).toEqual([B.b4]); // control: su dueño sí
  });

  it("ningún prefijo de una batalla ajena la devuelve", async () => {
    for (const n of [1, 4, 8, 13, 20, 35]) {
      expect(await ids("A", q({ battleId: B.b4.slice(0, n) }))).not.toContain(B.b4);
    }
    expect(await ids("B", q({ battleId: B.b4.slice(0, 8) }))).toContain(B.b4);
  });

  it("un bot PRIVADO ajeno no casa por id, nombre ni dueño aunque la batalla sea legible (rival)", async () => {
    // Control: A sí lee b3, donde participa privB.
    expect(await ids("A", q({ battleId: B.b3 }))).toEqual([B.b3]);
    expect(await ids("A", q({ bot: BOT.privB }))).toEqual([]);
    expect(await ids("A", q({ bot: "secretoB" }))).toEqual([]);
    expect(await ids("A", q({ user: U.B }))).toEqual([]);
    expect(await ids("A", q({ user: `eq4b-${RUN}` }))).toEqual([]);
    // Control: el dueño y el staff sí.
    expect(await ids("B", q({ bot: BOT.privB }))).toEqual([B.b4, B.b3]);
    expect(await ids("organizer", q({ bot: "secretoB" }))).toEqual([B.b4, B.b3]);
  });

  it("un bot `team` sólo casa para miembros de su equipo", async () => {
    expect(await ids("A", q({ bot: BOT.teamC }))).toEqual([]);
    expect(await ids("A", q({ team: teamX }))).toEqual([B.b5, B.b2, B.b1]); // vía pubC, que es público
    expect(await ids("T", q({ bot: BOT.teamC }))).toEqual([B.b6, B.b4]);
  });

  it("result=win/loss sin filtro de bots mira sólo los bots PROPIOS", async () => {
    // B gana b4 con privB; A gana b1 y b3 con pubA.
    expect(await ids("A", q({ result: "win" }))).toEqual([B.b3, B.b1]);
    expect(await ids("B", q({ result: "win" }))).toEqual([B.b4]);
    // A no puede preguntar por el resultado del bot privado de B (descalificado en b3).
    expect(await ids("A", q({ result: "loss", bot: BOT.privB }))).toEqual([]);
  });
});

describe("EQ4 · filtros", () => {
  it("battleId exacto (mayúsculas toleradas) y por prefijo", async () => {
    expect(await ids("A", q({ battleId: B.b2.toUpperCase() }))).toEqual([B.b2]);
    expect(await ids("A", q({ battleId: B.b2.slice(0, 13) }))).toContain(B.b2);
  });

  it("mode", async () => {
    expect(await ids("A", q({ mode: "deathmatch" }))).toEqual([B.b6, B.b1]);
    expect(await ids("A", q({ mode: "capture_the_flag" }))).toEqual([B.b2]);
    expect(await ids("A", q({ mode: "zone_control" }))).toEqual([B.b3]);
    expect(await ids("A", q({ mode: "team_deathmatch" }))).toEqual([B.b5]);
  });

  it("from/to inclusivos, en fecha o fecha-hora", async () => {
    expect(await ids("A", q({ from: "2026-02-10", to: "2026-03-10" }))).toEqual([B.b3, B.b2]);
    expect(await ids("A", q({ from: "2026-02-10T12:00:00Z", to: "2026-02-10T12:00:00Z" }))).toEqual([B.b2]);
    expect(await ids("A", q({ from: "2026-05-01T00:00:00+02:00" }))).toEqual([B.b6, B.b5]);
    expect(await ids("A", q({ to: "2026-01-31" }))).toEqual([B.b1]);
  });

  it("result draw y aborted", async () => {
    expect(await ids("A", q({ result: "draw" }))).toEqual([B.b2]);
    expect(await ids("A", q({ result: "aborted" }))).toEqual([B.b3]);
  });

  it("bot por id y por nombre; los comodines de LIKE se tratan como literales", async () => {
    expect(await ids("A", q({ bot: BOT.pubA }))).toEqual([B.b6, B.b3, B.b1]);
    expect(await ids("A", q({ bot: "tanque_100%" }))).toEqual([B.b6, B.b3, B.b1]); // sin distinguir mayúsculas
    expect(await ids("A", q({ bot: "Tanque-100x" }))).toEqual([B.b5]);
    expect(await ids("A", q({ bot: "%" }))).toEqual([B.b6, B.b3, B.b1]); // sólo el nombre con % literal
    expect(await ids("A", q({ bot: "100_" }))).toEqual([]); // `_` no es comodín
  });

  it("team y user por id y por nombre", async () => {
    expect(await ids("A", q({ team: teamXName.toLowerCase() }))).toEqual([B.b5, B.b2, B.b1]);
    expect(await ids("A", q({ user: U.C }))).toEqual([B.b5, B.b2, B.b1]);
    expect(await ids("A", q({ user: `eq4a-${RUN}` }))).toEqual(READABLE_A());
  });

  it("win/loss desde el punto de vista del bot filtrado", async () => {
    expect(await ids("A", q({ bot: BOT.pubC, result: "win" }))).toEqual([B.b5]);
    expect(await ids("A", q({ bot: BOT.pubC, result: "loss" }))).toEqual([B.b1]);
    expect(await ids("A", q({ bot: BOT.pubA, result: "loss" }))).toEqual([B.b6]);
  });

  it("los filtros se combinan (AND)", async () => {
    expect(await ids("A", q({ mode: "deathmatch", result: "win" }))).toEqual([B.b1]);
    expect(await ids("A", q({ bot: BOT.pubA, from: "2026-02-01", to: "2026-04-01" }))).toEqual([B.b3]);
  });
});

describe("EQ4 · validación (400, nunca 500)", () => {
  const BAD: Record<string, string>[] = [
    { battleId: "zz" },
    { battleId: "1234%" },
    { battleId: "' OR 1=1 --" },
    { battleId: "-abc" },
    { battleId: "a".repeat(37) },
    { battleId: "" },
    { mode: "battle_royale" },
    { mode: "" },
    { result: "victory" },
    { from: "ayer" },
    { from: "2026-02-31" },
    { from: "2026-13-01" },
    { to: "2026-01-01T25:00:00Z" },
    { from: "2026-01-01T00:00:00" }, // sin zona: ambiguo
    { from: "2026-03-01", to: "2026-02-01" },
    { bot: "" },
    { bot: "   " },
    { bot: "x".repeat(49) },
    { team: "a\u0001b" },
    { user: "y".repeat(49) },
    { includeTotal: "yes" },
    { cursor: Buffer.from("no-es-fecha|tampoco-uuid").toString("base64url") },
  ];
  for (const params of BAD) {
    it(`400 con ${JSON.stringify(params)}`, async () => {
      const res = await list("A", q(params));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    });
  }

  it("400 con un parámetro repetido", async () => {
    const res = await list("A", "mode=deathmatch&mode=zone_control");
    expect(res.status).toBe(400);
  });

  it("escapeLike escapa \\, % y _", () => {
    expect(escapeLike("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
  });
});

describe("EQ4 · paginación", () => {
  it("limit + cursor recorre todo sin duplicados ni huecos; total sólo si se pide y no depende del cursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await list("A", q({ limit: "2", includeTotal: "true", ...(cursor ? { cursor } : {}) }));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.items.map((i: any) => i.battleId));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(READABLE_A());
  });

  it("la paginación respeta los filtros y el total filtrado", async () => {
    const p1 = await list("A", q({ limit: "1", mode: "deathmatch", includeTotal: "true" }));
    expect(p1.body.total).toBe(2);
    expect(p1.body.items.map((i: any) => i.battleId)).toEqual([B.b6]);
    const p2 = await list("A", q({ limit: "1", mode: "deathmatch", cursor: p1.body.nextCursor }));
    expect(p2.body.items.map((i: any) => i.battleId)).toEqual([B.b1]);
    expect(p2.body.nextCursor).toBeUndefined();
    expect(p2.body).not.toHaveProperty("total");
  });

  it("includeTotal=false no añade `total`; limit por encima del máximo se recorta a 100", async () => {
    const res = await list("A", q({ includeTotal: "false", limit: "100000" }));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("total");
    expect(res.body.items.map((i: any) => i.battleId)).toEqual(READABLE_A());
  });

  it("total no cuenta lo que no es legible (staff ve 6, A ve 5, B ve 2)", async () => {
    const t = async (actor: string) => (await list(actor, "includeTotal=true")).body.total;
    expect(await t("organizer")).toBeGreaterThanOrEqual(6);
    expect(await t("A")).toBe(5);
    expect(await t("B")).toBe(2);
  });
});
