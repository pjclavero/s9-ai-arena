/**
 * EQ6 · revisión independiente de #209 · `PATCH /bots/{id} { retired }` y migración 015.
 *
 *  1. Autorización: SÓLO el dueño. Un miembro del equipo del bot (que lo ve) y un
 *     admin (que lo ve todo) no pueden retirarlo (contrato: metadatos = dueño), y
 *     el intento no deja marca.
 *  2. Retirar NO cambia qué juega: la lista de versiones, su estado y su
 *     `battleEligibility` son idénticos antes, durante y después.
 *  3. La migración `015_bot_retired` es reversible con datos: down pierde sólo la
 *     marca y up la vuelve a crear vacía, sin tocar el resto de la fila.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { MIGRATIONS } from "./db/migrations.js";

let h: TestDbHandle;
let app: Express;
const tok: Record<string, string> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  tok.dev = await tokenFor(h.db, DEV_USERS.developer);
  tok.user = await tokenFor(h.db, DEV_USERS.user);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function teamBotVisibleToMember(): Promise<{ botId: string }> {
  const devId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  const userId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  const [t] = await h
    .db("teams")
    .insert({ name: `eq6-team-${Date.now()}`, captain_id: devId })
    .returning("id");
  await h.db("team_members").insert([
    { team_id: t.id, user_id: devId, role: "captain" },
    { team_id: t.id, user_id: userId, role: "member" },
  ]);
  const bot = await request(app)
    .post("/bots")
    .set(auth(tok.dev))
    .send({ name: `eq6-team-bot-${Date.now()}`, visibility: "team", teamId: t.id });
  expect(bot.status).toBe(201);
  return { botId: bot.body.id };
}

describe("EQ6 · #209 · PATCH retired", () => {
  it("un miembro del equipo y un admin VEN el bot pero NO pueden retirarlo; no queda marca", async () => {
    const { botId } = await teamBotVisibleToMember();
    expect((await request(app).get(`/bots/${botId}`).set(auth(tok.user))).status).toBe(200);
    expect((await request(app).get(`/bots/${botId}`).set(auth(tok.admin))).status).toBe(200);
    for (const who of ["user", "admin"]) {
      const r = await request(app).patch(`/bots/${botId}`).set(auth(tok[who])).send({ retired: true });
      expect(r.status, `${who} pudo retirar un bot ajeno`).toBe(403);
    }
    const row = await h.db("bots").where({ id: botId }).first();
    expect(row.retired_at).toBeNull();
    // El dueño sí.
    const ok = await request(app).patch(`/bots/${botId}`).set(auth(tok.dev)).send({ retired: true });
    expect(ok.status).toBe(200);
    expect(ok.body.retiredAt).toEqual(expect.any(String));
  });

  it("retirar no cambia versiones, estado ni battleEligibility (antes, retirado y reactivado)", async () => {
    const bot = await request(app)
      .post("/bots")
      .set(auth(tok.dev))
      .send({ name: `eq6-elig-${Date.now()}`, visibility: "private" });
    const id = bot.body.id;
    const catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
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
    const snap = async () => {
      const r = await request(app).get(`/bots/${id}/versions`).set(auth(tok.dev));
      expect(r.status).toBe(200);
      return r.body.map((v: any) => ({ version: v.version, state: v.state, battleEligibility: v.battleEligibility }));
    };
    const before = await snap();
    expect(before.length).toBe(1);
    await request(app).patch(`/bots/${id}`).set(auth(tok.dev)).send({ retired: true });
    expect(await snap()).toEqual(before);
    const got = await request(app).get(`/bots/${id}`).set(auth(tok.dev));
    expect(got.body.latestPublishedVersion).toBe(1);
    await request(app).patch(`/bots/${id}`).set(auth(tok.dev)).send({ retired: false });
    expect(await snap()).toEqual(before);
  });

  it("migración 015_bot_retired: down conserva la fila (pierde sólo la marca) y up la recrea vacía", async () => {
    const m = MIGRATIONS.find((x) => x.name === "015_bot_retired")!;
    expect(m).toBeTruthy();
    const bot = await request(app)
      .post("/bots")
      .set(auth(tok.dev))
      .send({ name: `eq6-mig-${Date.now()}`, visibility: "public" });
    await request(app).patch(`/bots/${bot.body.id}`).set(auth(tok.dev)).send({ retired: true });
    const pick = (r: any) => ({
      id: r.id,
      name: r.name,
      owner_id: r.owner_id,
      visibility: r.visibility,
      team_id: r.team_id,
    });
    const before = pick(await h.db("bots").where({ id: bot.body.id }).first());
    const nBefore = Number((await h.db("bots").count({ n: "*" }))[0].n);
    await m.down!(h.db);
    const mid = await h.db("bots").where({ id: bot.body.id }).first();
    expect("retired_at" in mid).toBe(false);
    expect(pick(mid)).toEqual(before);
    await m.up(h.db);
    const after = await h.db("bots").where({ id: bot.body.id }).first();
    expect(after.retired_at).toBeNull();
    expect(pick(after)).toEqual(before);
    expect(Number((await h.db("bots").count({ n: "*" }))[0].n)).toBe(nBefore);
  });
});
