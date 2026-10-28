/**
 * 4v4 (fases 2 y 8) · POST /battles valida la COMPOSICIÓN antes de encolar:
 * máximo 8 participantes, 2 bandos de 1..4 en modos de equipo, deathmatch sin
 * bandos compartidos (409 «usa team_deathmatch», no un engine_start_failure que el
 * worker reintenta), sin bots repetidos y sólo versiones published/frozen.
 *
 * Cada rechazo se comprueba por su EFECTO: no se crea batalla ni trabajo. Cada
 * aceptación, por la batalla y el trabajo creados.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";
import { assertTeamComposition } from "./routes/battles.js";
import { ApiError } from "./errors.js";

let h: TestDbHandle;
let app: Express;
let tok: string;
let bots: TestBot[] = [];
let draftOnly: TestBot;
let twoVersions: TestBot;
let frozenBot: TestBot;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  const user = await h.db("users").where({ email: DEV_USERS.user }).first();
  tok = await tokenFor(h.db, DEV_USERS.user);
  for (let i = 0; i < 9; i++) bots.push(await createPublishedBot(h.db, `comp4v4-${i + 1}`, { ownerId: user.id }));

  // Bot sin ninguna versión publicada: v1 en draft.
  draftOnly = await createPublishedBot(h.db, "comp4v4-draft", { ownerId: user.id });
  await h.db("bot_versions").where({ bot_id: draftOnly.botId, version: 1 }).update({ state: "draft" });

  // Bot con v1 publicada (antigua) y v2 publicada (actual).
  twoVersions = await createPublishedBot(h.db, "comp4v4-two", { ownerId: user.id });
  await h.db("bot_versions").insert({
    bot_id: twoVersions.botId,
    version: 2,
    state: "published",
    runtime: "node",
    loadout_revision: 1,
    artifact_hash: "hash-comp4v4-two-v2",
  });

  // Bot congelado (frozen): también es jugable.
  frozenBot = await createPublishedBot(h.db, "comp4v4-frozen", { ownerId: user.id });
  await h.db("bot_versions").where({ bot_id: frozenBot.botId, version: 1 }).update({ state: "frozen" });
}, 120_000);

afterAll(async () => {
  await h.stop();
});

type P = { botId: string; version: number; team: string };

function tdm(participants: P[], over: Record<string, unknown> = {}) {
  return { mode: "team_deathmatch", rulesetId: "team-deathmatch-mvp", mapId: "mvp-arena-01", participants, ...over };
}
function dm(participants: P[]) {
  return { mode: "deathmatch", rulesetId: "deathmatch-mvp", mapId: "mvp-arena-02", participants };
}
/** n participantes: los `nRed` primeros en red, el resto en blue. */
function roster(n: number, nRed: number): P[] {
  return bots.slice(0, n).map((b, i) => ({ botId: b.botId, version: 1, team: i < nRed ? "red" : "blue" }));
}

async function counts() {
  const [bt] = await h.db("battles").count({ n: "*" });
  const [jb] = await h.db("jobs").where({ kind: "run_battle" }).count({ n: "*" });
  return { battles: Number(bt.n), jobs: Number(jb.n) };
}

async function post(body: unknown) {
  return request(app).post("/battles").set("Authorization", `Bearer ${tok}`).send(body);
}

async function expectRejected(body: unknown, status: number, code?: string) {
  const before = await counts();
  const r = await post(body);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body.error).toBe(code);
  expect(await counts()).toEqual(before);
  return r;
}

async function expectAccepted(body: unknown) {
  const before = await counts();
  const r = await post(body);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  expect(await counts()).toEqual({ battles: before.battles + 1, jobs: before.jobs + 1 });
  return r;
}

describe("POST /battles · composición 4v4", () => {
  it("4v4 TDM válido ⇒ 202, 8 participantes con su bando", async () => {
    const r = await expectAccepted(tdm(roster(8, 4)));
    const rows = await h.db("participants").where({ battle_id: r.body.id });
    expect(rows).toHaveLength(8);
    expect(rows.filter((p: any) => p.team === "red")).toHaveLength(4);
    expect(rows.filter((p: any) => p.team === "blue")).toHaveLength(4);
  });

  it("4v4 con etiquetas A/B ⇒ 202 (el motor reparte A/B entre los grupos del mapa)", async () => {
    await expectAccepted(tdm(roster(8, 4).map((p) => ({ ...p, team: p.team === "red" ? "A" : "B" }))));
  });

  it("3v1 TDM (asimétrico pero ≤ 4 por bando) ⇒ 202", async () => {
    await expectAccepted(tdm(roster(4, 3)));
  });

  it("9 participantes ⇒ 400 (no se sube el límite de 8)", async () => {
    await expectRejected(tdm(roster(9, 4)), 400);
  });

  it("5 en un bando (5v3) ⇒ 400 team_too_large", async () => {
    const r = await expectRejected(tdm(roster(8, 5)), 400, "team_too_large");
    expect(r.body.message).toMatch(/máximo 4 por bando/);
  });

  it("TDM con un solo bando ⇒ 400 team_composition_invalid", async () => {
    await expectRejected(tdm(roster(4, 4)), 400, "team_composition_invalid");
  });

  it("TDM con tres bandos ⇒ 400 team_composition_invalid", async () => {
    const ps = roster(3, 1);
    ps[2].team = "green";
    await expectRejected(tdm(ps), 400, "team_composition_invalid");
  });

  it("CTF 4v4 válido ⇒ 202; CTF 5v3 ⇒ 400", async () => {
    const ctf = { mode: "capture_the_flag", rulesetId: "capture-the-flag-mvp" };
    await expectAccepted(tdm(roster(8, 4), ctf));
    await expectRejected(tdm(roster(8, 5), ctf), 400, "team_too_large");
  });

  it("deathmatch con bandos compartidos ⇒ 409 deathmatch_shared_team «usa team_deathmatch»", async () => {
    const r = await expectRejected(dm(roster(4, 2)), 409, "deathmatch_shared_team");
    expect(r.body.message).toContain("usa team_deathmatch");
  });

  it("bot repetido ⇒ 400", async () => {
    const ps = roster(2, 1);
    ps[1] = { ...ps[0], team: "blue" };
    await expectRejected(tdm(ps), 400);
  });

  it("bot sin versión publicada ⇒ 409 bot_not_published", async () => {
    const ps = roster(2, 1);
    ps[1] = { botId: draftOnly.botId, version: 1, team: "blue" };
    await expectRejected(tdm(ps), 409, "bot_not_published");
  });

  it("versión publicada ANTIGUA (v1 con v2 publicada) ⇒ 202", async () => {
    const ps = roster(2, 1);
    ps[1] = { botId: twoVersions.botId, version: 1, team: "blue" };
    await expectAccepted(tdm(ps));
  });

  it("versión frozen ⇒ 202", async () => {
    const ps = roster(2, 1);
    ps[1] = { botId: frozenBot.botId, version: 1, team: "blue" };
    await expectAccepted(tdm(ps));
  });

  it("1v1 de siempre (deathmatch red/blue y TDM red/blue) ⇒ 202", async () => {
    await expectAccepted(dm(roster(2, 1)));
    await expectAccepted(tdm(roster(2, 1)));
  });
});

describe("assertTeamComposition (regla pura, todos los modos)", () => {
  const ps = (teams: string[]) => teams.map((team) => ({ team }));
  const code = (mode: string, teams: string[]) => {
    try {
      assertTeamComposition(mode, ps(teams));
      return "ok";
    } catch (e) {
      return e instanceof ApiError ? `${e.status}:${e.code}` : String(e);
    }
  };

  it.each(["team_deathmatch", "capture_the_flag", "zone_control"])("%s: 4v4 ok, 5v3/1 bando/3 bandos no", (mode) => {
    expect(code(mode, ["a", "a", "a", "a", "b", "b", "b", "b"])).toBe("ok");
    expect(code(mode, ["a", "b"])).toBe("ok");
    expect(code(mode, ["a", "a", "a", "a", "a", "b", "b", "b"])).toBe("400:team_too_large");
    expect(code(mode, ["a", "a"])).toBe("400:team_composition_invalid");
    expect(code(mode, ["a", "b", "c"])).toBe("400:team_composition_invalid");
  });

  it("deathmatch: bandos únicos ok; compartidos 409", () => {
    expect(code("deathmatch", ["red", "blue", "g", "y"])).toBe("ok");
    expect(code("deathmatch", ["red"])).toBe("ok");
    expect(code("deathmatch", ["red", "red"])).toBe("409:deathmatch_shared_team");
  });
});
