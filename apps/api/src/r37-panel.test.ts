/**
 * R3.7 (ERR-VIS-02/03/04) · Soporte de API para el panel:
 *  - Sesión persistente: cookie httpOnly `s9_refresh` en login, refresh por
 *    cookie (con rotación) y logout que revoca y borra la cookie.
 *  - Extensiones de lectura: GET /bots/{id}/loadouts (el editor carga la
 *    revisión vigente), GET /tournaments/{id} y GET /tournaments/{id}/battles
 *    (seguir un torneo sin teclear UUIDs).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEV_PASSWORD, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";

let h: TestDbHandle;
let app: Express;
let userToken: string;
let organizerToken: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db });
  userToken = await tokenFor(h.db, DEV_USERS.user);
  organizerToken = await tokenFor(h.db, DEV_USERS.organizer);
}, 120000);

afterAll(async () => {
  await h.stop();
});

function refreshCookie(res: request.Response): string {
  const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = (cookies ?? []).find((x) => x.startsWith("s9_refresh="));
  expect(c, "esperaba Set-Cookie s9_refresh").toBeTruthy();
  return c!.split(";")[0];
}

describe("R3.7 sesión persistente por cookie httpOnly", () => {
  it("login emite cookie httpOnly y el refresh por cookie (sin body) rota la sesión", async () => {
    const login = await request(app)
      .post("/auth/login")
      .send({ email: DEV_USERS.user, password: DEV_PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = ((login.headers["set-cookie"] as unknown as string[]) ?? []).find((c) =>
      c.startsWith("s9_refresh="),
    )!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    const cookie1 = refreshCookie(login);
    // F5 del panel: POST /auth/refresh SOLO con la cookie.
    const r1 = await request(app).post("/auth/refresh").set("Cookie", cookie1).send({});
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const cookie2 = refreshCookie(r1);
    expect(cookie2).not.toBe(cookie1);

    // Rotación: la cookie anterior deja de valer; la nueva sí vale.
    const stale = await request(app).post("/auth/refresh").set("Cookie", cookie1).send({});
    expect(stale.status).toBe(401);
    const r2 = await request(app).post("/auth/refresh").set("Cookie", cookie2).send({});
    expect(r2.status).toBe(200);
  });

  it("refresh sin body y sin cookie → 400 (nunca sesión fantasma)", async () => {
    const res = await request(app).post("/auth/refresh").send({});
    expect(res.status).toBe(400);
  });

  it("logout revoca la sesión de la cookie y la borra", async () => {
    const login = await request(app)
      .post("/auth/login")
      .send({ email: DEV_USERS.user, password: DEV_PASSWORD });
    const cookie = refreshCookie(login);
    const out = await request(app).post("/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(204);
    const cleared = ((out.headers["set-cookie"] as unknown as string[]) ?? []).find((c) =>
      c.startsWith("s9_refresh="),
    )!;
    expect(cleared).toContain("s9_refresh=;");
    // La sesión revocada ya no refresca.
    const res = await request(app).post("/auth/refresh").set("Cookie", cookie).send({});
    expect(res.status).toBe(401);
  });
});

describe("R3.7 GET /bots/{id}/loadouts (revisión vigente para el editor)", () => {
  it("devuelve las revisiones guardadas; anónimo recibe 401", async () => {
    const bot = await request(app)
      .post("/bots")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ name: "r37-loadout-bot" });
    expect(bot.status).toBe(201);

    const draft = { catalogVersion: "mvp@1", chassis: "chassis.medium@1", modules: [] };
    const created = await request(app)
      .post(`/bots/${bot.body.id}/loadouts`)
      .set("Authorization", `Bearer ${userToken}`)
      .send(draft);
    expect(created.status).toBe(201);

    const list = await request(app)
      .get(`/bots/${bot.body.id}/loadouts`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].revision).toBe(1);
    expect(list.body[0].chassis).toBe("chassis.medium@1");

    const anon = await request(app).get(`/bots/${bot.body.id}/loadouts`);
    expect(anon.status).toBe(401);
  });
});

describe("R3.7 detalle de torneo y sus batallas (público)", () => {
  it("GET /tournaments/{id} y /tournaments/{id}/battles con ronda por match", async () => {
    const t = await request(app)
      .post("/tournaments")
      .set("Authorization", `Bearer ${organizerToken}`)
      .send({ name: "r37-copa", format: "single_elimination", mode: "deathmatch", rulesetId: DEFAULT_RULESET_ID });
    expect(t.status).toBe(201);

    const [m1] = await h.db("matches").insert({ tournament_id: t.body.id, round: 2 }).returning("*");
    const mkBattle = (status: string, matchId: string | null) =>
      h
        .db("battles")
        .insert({
          tournament_id: t.body.id,
          match_id: matchId,
          status,
          official: true,
          mode: "deathmatch",
          ruleset_id: DEFAULT_RULESET_ID,
          map_id: "mvp-arena-01",
          map_version: 1,
        })
        .returning("*");
    const [b1] = await mkBattle("scheduled", null);
    const [b2] = await mkBattle("running", m1.id as string);
    const [b3] = await mkBattle("finished", m1.id as string);

    const detail = await request(app).get(`/tournaments/${t.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe("r37-copa");
    expect(detail.body.entryCount).toBe(0);

    const battles = await request(app).get(`/tournaments/${t.body.id}/battles`);
    expect(battles.status).toBe(200);
    const byId = new Map(battles.body.items.map((b: { id: string; round: number; status: string }) => [b.id, b]));
    expect(battles.body.items.length).toBe(3);
    expect((byId.get(b1.id) as { round: number }).round).toBe(1);
    expect((byId.get(b2.id) as { round: number }).round).toBe(2);
    expect((byId.get(b3.id) as { round: number; status: string }).status).toBe("finished");

    const missing = await request(app).get(`/tournaments/${crypto.randomUUID()}/battles`);
    expect(missing.status).toBe(404);
  });
});
