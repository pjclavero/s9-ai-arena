/**
 * EQ6 · ataques adicionales a los filtros de `GET /replays` (#209). Montaje copiado de eq4-replays-filters.test.ts.
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
  await h
    .db("bot_versions")
    .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
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
    bots: [
      { key: "pubA", outcome: "win" },
      { key: "pubC", outcome: "loss" },
    ],
    mode: "deathmatch",
    createdAt: "2026-01-10T12:00:00Z",
  });
  B.b2 = await newBattle({
    bots: [
      { key: "privA", outcome: "draw" },
      { key: "pubC", outcome: "draw" },
    ],
    mode: "capture_the_flag",
    createdAt: "2026-02-10T12:00:00Z",
    winner: "draw",
  });
  // Legible por A (es dueño de pubA) pero con un bot PRIVADO de B: rival.
  B.b3 = await newBattle({
    bots: [
      { key: "pubA", outcome: "win" },
      { key: "privB", outcome: "disqualified" },
    ],
    mode: "zone_control",
    createdAt: "2026-03-10T12:00:00Z",
    failureKind: "bot_crash",
  });
  // NO legible por A: sólo bots de B (privado) y de C (team, A no es miembro).
  B.b4 = await newBattle({
    bots: [
      { key: "privB", outcome: "win" },
      { key: "teamC", outcome: "loss" },
    ],
    mode: "team_deathmatch",
    createdAt: "2026-04-10T12:00:00Z",
  });
  B.b5 = await newBattle({
    bots: [
      { key: "pubA2", outcome: "loss" },
      { key: "pubC", outcome: "win" },
    ],
    mode: "team_deathmatch",
    createdAt: "2026-05-10T12:00:00Z",
  });
  B.b6 = await newBattle({
    bots: [
      { key: "pubA", outcome: "loss" },
      { key: "teamC", outcome: "win" },
    ],
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

/*
 * EQ6 · revisión independiente de #209 · ataques ADICIONALES a los filtros de
 * GET /replays (el montaje de arriba es copia literal del de eq4-replays-filters).
 * b6 es legible por A (pubA juega) pero su rival teamC es un bot `team` de un
 * equipo del que A NO es miembro: nada de teamC puede filtrarse desde A.
 */
async function total(actor: string, query: string): Promise<number> {
  const res = await list(actor, `${query}&includeTotal=true`);
  expect(res.status, `${query} → ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.total as number;
}

describe("EQ6 · #209 · oráculos sobre bots `team` ajenos en batallas legibles", () => {
  it("team por id y por nombre: b6 (donde sólo teamC es del equipo) no aparece para A", async () => {
    expect(await ids("A", q({ team: teamX }))).not.toContain(B.b6);
    expect(await ids("A", q({ team: teamXName }))).not.toContain(B.b6);
    expect(await ids("A", q({ team: teamXName.slice(0, 3) }))).not.toContain(B.b6);
    // Control: un miembro sí la ve por equipo.
    expect(await ids("T", q({ team: teamX }))).toContain(B.b6);
  });

  it("user (dueño de teamC) por id y por display_name: b6 no aparece para A", async () => {
    expect(await ids("A", q({ user: U.C }))).not.toContain(B.b6);
    expect(await ids("A", q({ user: `eq4c-${RUN}` }))).not.toContain(B.b6);
  });

  it("result=win/loss combinado con team/user no revela el resultado de teamC (ganó b6)", async () => {
    expect(await ids("A", q({ result: "win", team: teamX }))).not.toContain(B.b6);
    expect(await ids("A", q({ result: "win", user: U.C }))).not.toContain(B.b6);
    expect(await ids("A", q({ result: "win", bot: `equipoC-${RUN}` }))).toEqual([]);
    // Control: T (miembro) sí.
    expect(await ids("T", q({ result: "win", bot: BOT.teamC }))).toContain(B.b6);
  });

  it("includeTotal no cuenta lo que el filtro no deja ver (prefijo de b4, bot privado, bot team)", async () => {
    expect(await total("A", q({ battleId: B.b4.slice(0, 1) }))).toBe(
      (await ids("A", q({ battleId: B.b4.slice(0, 1) }))).length,
    );
    expect(await total("A", q({ battleId: B.b4 }))).toBe(0);
    expect(await total("A", q({ bot: BOT.privB }))).toBe(0);
    expect(await total("A", q({ bot: BOT.teamC }))).toBe(0);
    expect(await total("A", q({ team: teamX, result: "win" }))).toBe(
      (await ids("A", q({ team: teamX, result: "win" }))).length,
    );
  });

  it("la respuesta para un nombre de bot oculto es idéntica a la de un nombre inexistente", async () => {
    const hidden = await list("A", q({ bot: `secretoB-${RUN}`, includeTotal: "true" }));
    const none = await list("A", q({ bot: `no-existe-${RUN}`, includeTotal: "true" }));
    expect(hidden.status).toBe(none.status);
    expect(hidden.body).toEqual(none.body);
  });
});
