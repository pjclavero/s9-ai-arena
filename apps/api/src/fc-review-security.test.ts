/**
 * REVIEW (cierre funcional, R8) · matriz de seguridad TRANSVERSAL por comportamiento
 * real (API + PostgreSQL embebido), no por lo que declare el OpenAPI.
 *
 * Dos usuarios: «dueño» (developer) y «ajeno» (user). El dueño tiene un bot PRIVADO
 * publicado, un borrador de mapa y un equipo. Se comprueba que el ajeno y el anónimo
 * no pueden leer ni tocar nada de eso por ninguna de las rutas nuevas de A, B y C, y
 * que el dueño sí puede (control positivo: si el dueño también recibiera 404, los
 * rechazos no probarían nada).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createPublishedBot, type TestBot } from "../../tournament-worker/src/testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let owner: string;
let alien: string;
let ownerId: string;
let privBot: TestBot;
let pubBot: TestBot;
let alienBot: TestBot;
let teamId: string;
const MAP_ID = "fcrev-sec-draft";

const as = (tok: string | null) => (r: request.Test) => (tok ? r.set("Authorization", `Bearer ${tok}`) : r);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  owner = await tokenFor(h.db, DEV_USERS.developer);
  alien = await tokenFor(h.db, DEV_USERS.user);
  ownerId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  const alienId = (await h.db("users").where({ email: DEV_USERS.user }).first()).id;
  privBot = await createPublishedBot(h.db, "fcrev-sec-priv", { ownerId });
  await h.db("bots").where({ id: privBot.botId }).update({ visibility: "private" });
  await h
    .db("bot_versions")
    .where({ bot_id: privBot.botId, version: 1 })
    .update({ source: Buffer.from("SECRETO_DEL_DUEÑO = 1\n") })
    .catch(async () => {
      // versión no-draft inmutable (012_bot_versioning): se fija el código como lo
      // haría una fixture de almacén, con los triggers desactivados en SU transacción.
      await h.db.transaction(async (trx) => {
        await trx.raw("SET LOCAL session_replication_role = replica");
        await trx("bot_versions")
          .where({ bot_id: privBot.botId, version: 1 })
          .update({ source: Buffer.from("SECRETO_DEL_DUEÑO = 1\n") });
      });
    });
  alienBot = await createPublishedBot(h.db, "fcrev-sec-alien", { ownerId: alienId });
  // Bot PÚBLICO con código PRIVADO (code_public=false): aquí la única barrera es
  // canReadSource — la visibilidad del bot deja pasar al ajeno.
  pubBot = await createPublishedBot(h.db, "fcrev-sec-pub", { ownerId });
  await h.db.transaction(async (trx) => {
    await trx.raw("SET LOCAL session_replication_role = replica");
    await trx("bot_versions")
      .where({ bot_id: pubBot.botId, version: 1 })
      .update({ source: Buffer.from("CODIGO_PRIVADO_DE_BOT_PUBLICO = 1\n"), code_public: false });
  });

  const map = JSON.parse((await request(app).get("/maps/mvp-arena-01/versions/1/content")).text) as Record<
    string,
    unknown
  >;
  const draft = await as(owner)(request(app).post("/maps/drafts")).send({ ...map, mapId: MAP_ID });
  expect([200, 201], JSON.stringify(draft.body)).toContain(draft.status);
  const team = await as(owner)(request(app).post("/teams")).send({ name: "fcrev-sec-team" });
  expect(team.status).toBe(201);
  teamId = team.body.id;
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe("R8 · código y artefactos de un bot PRIVADO ajeno (A)", () => {
  const paths = () => [
    `/bots/${privBot.botId}`,
    `/bots/${privBot.botId}/versions`,
    `/bots/${privBot.botId}/versions/1`,
    `/bots/${privBot.botId}/versions/1/source`,
    `/bots/${privBot.botId}/versions/1/files`,
    `/bots/${privBot.botId}/versions/1/artifact`,
    `/bots/${privBot.botId}/versions/1/diff?against=1`,
    `/bots/${privBot.botId}/rating-history`,
  ];

  it("control positivo: el DUEÑO lee su código", async () => {
    const r = await as(owner)(request(app).get(`/bots/${privBot.botId}/versions/1/files`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify(r.body)).toContain("SECRETO_DEL_DUE");
  });

  it("el AJENO y el ANÓNIMO reciben 404 en TODAS las lecturas y nunca ven el código", async () => {
    for (const tok of [alien, null]) {
      for (const p of paths()) {
        const r = await as(tok)(request(app).get(p));
        expect([401, 403, 404], `${tok ? "ajeno" : "anónimo"} GET ${p} → ${r.status}`).toContain(r.status);
        expect(r.text).not.toContain("SECRETO_DEL_DUE");
      }
    }
  });

  it("el AJENO no puede clonar, enviar, publicar ni versionar el bot privado", async () => {
    const posts = [
      [`/bots/${privBot.botId}/versions/1/actions/clone`, {}],
      [`/bots/${privBot.botId}/versions/1/actions/submit`, {}],
      [`/bots/${privBot.botId}/versions/1/actions/publish`, {}],
      [`/bots/${privBot.botId}/loadouts`, {}],
    ] as const;
    for (const [p, body] of posts) {
      const r = await as(alien)(request(app).post(p)).send(body);
      expect([403, 404], `POST ${p} → ${r.status}`).toContain(r.status);
    }
  });
});

describe("R8 · bot PÚBLICO con código PRIVADO (canReadSource, A)", () => {
  it("el AJENO ve el bot pero NO su código (source, files, diff)", async () => {
    expect((await as(alien)(request(app).get(`/bots/${pubBot.botId}`))).status).toBe(200);
    for (const p of [
      `/bots/${pubBot.botId}/versions/1/source`,
      `/bots/${pubBot.botId}/versions/1/files`,
      `/bots/${pubBot.botId}/versions/1/diff?against=1`,
    ]) {
      const r = await as(alien)(request(app).get(p));
      expect([403, 404], `GET ${p} → ${r.status}`).toContain(r.status);
      expect(r.text).not.toContain("CODIGO_PRIVADO_DE_BOT_PUBLICO");
    }
  });

  it("control positivo: el dueño sí lo lee", async () => {
    const r = await as(owner)(request(app).get(`/bots/${pubBot.botId}/versions/1/files`));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("CODIGO_PRIVADO_DE_BOT_PUBLICO");
  });
});

describe("R8 · batallas y participantes (B)", () => {
  it("el AJENO no mete el bot privado del dueño en su batalla (404 = inexistente) y no se crea nada", async () => {
    const [before] = await h.db("battles").count({ n: "*" });
    const r = await as(alien)(request(app).post("/battles")).send({
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      mapId: "mvp-arena-02",
      participants: [
        { botId: alienBot.botId, version: 1, team: "red" },
        { botId: privBot.botId, version: 1, team: "blue" },
      ],
    });
    expect(r.status).toBe(404);
    const [after] = await h.db("battles").count({ n: "*" });
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it("el anónimo no crea batallas", async () => {
    const r = await request(app).post("/battles").send({});
    expect(r.status).toBe(401);
  });
});

describe("R8 · mapas y equipos (C)", () => {
  it("control positivo: el dueño ve su borrador", async () => {
    const r = await as(owner)(request(app).get(`/maps/${MAP_ID}/versions/1`));
    expect(r.status).toBe(200);
  });

  it("el borrador ajeno es invisible y no se publica ni se sobrescribe", async () => {
    for (const tok of [alien, null]) {
      expect((await as(tok)(request(app).get(`/maps/${MAP_ID}/versions/1`))).status).toBe(404);
      expect((await as(tok)(request(app).get(`/maps/${MAP_ID}/versions/1/content`))).status).toBe(404);
    }
    const pub = await as(alien)(request(app).post(`/maps/${MAP_ID}/versions/1/actions/publish`)).send({});
    expect([403, 404]).toContain(pub.status);
    const over = await as(alien)(request(app).post("/maps/drafts")).send({ mapId: MAP_ID, widthM: 10 });
    expect([400, 403, 404]).toContain(over.status);
    const row = await h.db("map_versions").where({ map_id: MAP_ID, version: 1 }).first();
    expect(row.state).toBe("draft");
  });

  it("el AJENO no modifica, borra ni puebla el equipo del dueño; el anónimo no ve ids", async () => {
    expect((await as(alien)(request(app).patch(`/teams/${teamId}`)).send({ name: "x" })).status).toBeGreaterThanOrEqual(
      403,
    );
    expect((await as(alien)(request(app).delete(`/teams/${teamId}`))).status).toBeGreaterThanOrEqual(403);
    expect(
      (await as(alien)(request(app).post(`/teams/${teamId}/bots`)).send({ botId: alienBot.botId })).status,
    ).toBeGreaterThanOrEqual(403);
    const team = await h.db("teams").where({ id: teamId }).first();
    expect(team.name).toBe("fcrev-sec-team");
    const anon = await request(app).get("/teams");
    expect(anon.status).toBe(200);
    expect(anon.text).not.toContain(ownerId);
  });
});
