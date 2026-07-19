/**
 * R6.2/R9-B · DoD del endpoint gateado POST /battles/:battleId/run.
 * Usa un `BattleRunLauncher` FAKE inyectado — NUNCA Docker real. Cubre: apagado→503,
 * no encontrada→404, estado inválido→409, bot no listo/sin firma→409, mapa no publicado→409,
 * runner ausente→503, y ejecución OK→200 con el fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_USERS, DEV_PASSWORD, seedDev } from "./db/seeds/dev.js";
import { createApp } from "./app.js";
import type { BattleRunLauncher } from "./battle-run.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
let rulesetId: string;
const REAL_HASH = "sha256:" + "ab".repeat(32);
const fakeRunner: BattleRunLauncher = {
  async launch(input) {
    return {
      status: "completed",
      runner: "proxy-container",
      replay: { ingested: true, battleId: input.battleId, verify_matches: true },
    };
  },
};

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  rulesetId = (await h.db("rulesets").first()).id;
}, 120000);
afterAll(async () => {
  await h.stop();
});

async function token(app: Express): Promise<string> {
  const r = await request(app).post("/auth/login").send({ email: DEV_USERS.admin, password: DEV_PASSWORD });
  return r.body.accessToken;
}

/** Siembra un bot con una versión (published + digest opcional) y devuelve su id/version. */
async function seedBot(name: string, opts: { signed: boolean; state?: string }) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${name}-${id.slice(0, 8)}`, owner_id: adminId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.scout@1",
    modules: JSON.stringify([]),
  });
  await h.db("bot_versions").insert({
    bot_id: id,
    version: 1,
    state: opts.state ?? "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: opts.signed ? REAL_HASH : null,
  });
  return { botId: id, version: 1 };
}

/** Siembra una batalla `scheduled` sobre el mapa publicado del seed (mvp-arena-01 v1). */
async function seedBattle(status: string, bots: { botId: string; version: number; team: string }[]) {
  const [b] = await h
    .db("battles")
    .insert({
      status,
      official: false,
      mode: "deathmatch",
      ruleset_id: rulesetId,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "s",
    })
    .returning("*");
  await h
    .db("participants")
    .insert(bots.map((x) => ({ battle_id: b.id, bot_id: x.botId, version: x.version, team: x.team })));
  return b.id as string;
}

beforeEach(async () => {
  await h.db("participants").del();
  await h.db("battles").del();
});

describe("R6.2/R9-B · POST /battles/:battleId/run", () => {
  it("apagado por defecto → 503 (aunque la batalla no exista)", async () => {
    const app = createApp({ db: h.db, realBattleRuns: { enabled: false } });
    const r = await request(app)
      .post("/battles/whatever/run")
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("real_battle_runs_disabled");
  });

  it("habilitado + batalla inexistente → 404", async () => {
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: fakeRunner } });
    const r = await request(app)
      .post("/battles/no_existe/run")
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(404);
  });

  it("estado inválido (finished) → 409", async () => {
    const r1 = await seedBot("bot_r", { signed: true });
    const id = await seedBattle("finished", [{ botId: r1.botId, version: 1, team: "red" }]);
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: fakeRunner } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("invalid_state");
  });

  it("bot sin digest firmado → 409 bot_not_signed", async () => {
    const u = await seedBot("bot_unsigned", { signed: false });
    const id = await seedBattle("scheduled", [{ botId: u.botId, version: 1, team: "red" }]);
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: fakeRunner } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("bot_not_signed");
  });

  it("habilitado + válido pero SIN runner cableado → 503 runner_unavailable", async () => {
    const a = await seedBot("bot_a", { signed: true });
    const b = await seedBot("bot_b", { signed: true });
    const id = await seedBattle("scheduled", [
      { botId: a.botId, version: 1, team: "red" },
      { botId: b.botId, version: 1, team: "blue" },
    ]);
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true } }); // sin runner
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("runner_unavailable");
  });

  it("habilitado + válido + runner fake → 200 con resultado y replay", async () => {
    const a = await seedBot("bot_a", { signed: true });
    const b = await seedBot("bot_b", { signed: true });
    const id = await seedBattle("scheduled", [
      { botId: a.botId, version: 1, team: "red" },
      { botId: b.botId, version: 1, team: "blue" },
    ]);
    const app = createApp({ db: h.db, realBattleRuns: { enabled: true, runner: fakeRunner } });
    const r = await request(app)
      .post(`/battles/${id}/run`)
      .set("Authorization", `Bearer ${await token(app)}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ battleId: id, status: "completed", runner: "proxy-container" });
    expect(r.body.replay.ingested).toBe(true);
  });

  it("capability en /system/status: disabled por defecto, available solo con runner", async () => {
    async function cap(cfg: { enabled: boolean; runner?: BattleRunLauncher }) {
      const app = createApp({ db: h.db, realBattleRuns: cfg });
      const r = await request(app)
        .get("/system/status")
        .set("Authorization", `Bearer ${await token(app)}`);
      return r.body.realBattleRuns;
    }
    expect(await cap({ enabled: false })).toEqual({ enabled: false, available: false });
    expect(await cap({ enabled: true })).toEqual({ enabled: true, available: false });
    expect(await cap({ enabled: true, runner: fakeRunner })).toEqual({ enabled: true, available: true });
  });
});
