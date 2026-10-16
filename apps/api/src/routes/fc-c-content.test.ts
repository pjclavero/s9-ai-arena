/**
 * FC-C · Contenido de batalla: mapas, equipos, rulesets — API REAL + PostgreSQL REAL
 * (embebido). Sin mocks de servicios de S9 (el FakeBotManager solo sustituye al
 * pipeline de build de bots, que es de A y no es objeto de esta suite).
 *
 * Garantías (cada una con una mutación que la pone roja, ver informe DEV-C):
 *  - persistencia del mapa: crear → editar → guardar → "cerrar" (otra instancia de
 *    la API sobre la misma BD) → reabrir → editar → guardar → publicar → JUGABLE
 *    (resolveBattleMap, el resolver real del launcher);
 *  - propiedad: nadie salvo el dueño (o admin) añade versiones / edita / publica;
 *  - borradores privados; listado anónimo de equipos sin UUID de usuarios;
 *  - rulesets reales de BD para los 4 modos y compatibilidad modo ↔ ruleset ↔ mapa.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import {
  seedDev,
  seedContent,
  DEV_USERS,
  PLATFORM_RULESETS,
  MVP_ARENA_02_ID,
  MVP_ARENA_02_MODES,
} from "../db/seeds/dev.js";
import { tokenFor } from "../testing/helpers.js";
import { createApp } from "../app.js";
import { FakeBotManager } from "../services/bot-manager.js";
import { resolveBattleMap } from "../services/battle-map-resolver.js";
import { resolveBattleRuleset } from "../services/battle-ruleset-resolver.js";
import { checkBattleContent } from "./catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..", "..");
const MVP = JSON.parse(readFileSync(join(REPO, "maps", "mvp-arena-01.json"), "utf8"));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(join(REPO, "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
);
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let h: TestDbHandle;
let app: Express;
let alice: string; // developer: dueña del mapa y del equipo
let bob: string; // otro usuario con bots (team_captain)
let org: string; // organizer ajeno
let admin: string;
let aliceId: string;
let bobId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const newApp = () => createApp({ db: h.db, botManager: new FakeBotManager(h.db) });

/** Mapa de editor mínimo pero JUGABLE (forma InternalMap): el MVP con otro id. */
function editorMap(mapId: string, name: string) {
  const { checksum: _c, ...rest } = MVP;
  return {
    ...rest,
    mapId,
    version: 1,
    meta: { ...MVP.meta, name, supportedModes: ["deathmatch", "team_deathmatch"] },
  };
}

async function publishedBot(token: string, name: string): Promise<string> {
  const bot = await request(app).post("/bots").set(auth(token)).send({ name, visibility: "public" });
  expect(bot.status).toBe(201);
  const id = bot.body.id;
  expect((await request(app).post(`/bots/${id}/loadouts`).set(auth(token)).send(GOOD_LOADOUT)).status).toBe(201);
  const v = await request(app)
    .post(`/bots/${id}/versions`)
    .set(auth(token))
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from("print('x')"), "bot.py");
  expect(v.status).toBe(201);
  await request(app).post(`/bots/${id}/versions/${v.body.version}/actions/submit`).set(auth(token));
  const p = await request(app).post(`/bots/${id}/versions/${v.body.version}/actions/publish`).set(auth(token)).send({});
  expect(p.status).toBe(200);
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = newApp();
  alice = await tokenFor(h.db, DEV_USERS.developer);
  bob = await tokenFor(h.db, DEV_USERS.team_captain);
  org = await tokenFor(h.db, DEV_USERS.organizer);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  aliceId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  bobId = (await h.db("users").where({ email: DEV_USERS.team_captain }).first()).id;
});
afterAll(async () => {
  await h?.stop();
});

describe("C1/C3 · mapa persistente: crear → editar → guardar → cerrar → reabrir → editar → guardar → usar", () => {
  it("el borrador vive en BD, se reescribe en sitio y, publicado, es jugable por el resolver real", async () => {
    // crear + guardar
    const first = await request(app)
      .post("/maps/drafts")
      .set(auth(alice))
      .send(editorMap("fc-c-mapa", "Mapa de Alice"));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      mapId: "fc-c-mapa",
      version: 1,
      state: "draft",
      mine: true,
      name: "Mapa de Alice",
    });

    // editar + guardar: MISMA versión (borrador mutable), no una v2
    const edited = editorMap("fc-c-mapa", "Mapa de Alice (editado)");
    edited.layers = { ...edited.layers, walls: edited.layers.walls.slice(0, 2) };
    const second = await request(app).post("/maps/drafts").set(auth(alice)).send(edited);
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(1);
    expect(await h.db("map_versions").where({ map_id: "fc-c-mapa" }).count("* as n").first()).toMatchObject({
      n: "1",
    });

    // "cerrar": otra instancia de la API (nada en memoria) → reabrir desde BD
    const reopenedApp = newApp();
    const row = await h.db("map_versions").where({ map_id: "fc-c-mapa", version: 1 }).first();
    expect(row.content.meta.name).toBe("Mapa de Alice (editado)");
    const reopened = await request(reopenedApp).get("/maps/fc-c-mapa/versions/1/content").set(auth(alice));
    expect(reopened.status).toBe(200);
    expect(reopened.body.meta.name).toBe("Mapa de Alice (editado)");
    expect(reopened.body.layers.walls).toHaveLength(2);
    // aparece en "mis mapas"
    const mine = await request(reopenedApp).get("/maps?mine=true").set(auth(alice));
    expect(mine.body.items.map((m: { mapId: string }) => m.mapId)).toContain("fc-c-mapa");

    // editar otra vez sobre lo reabierto + guardar
    const again = { ...reopened.body, meta: { ...reopened.body.meta, name: "Mapa de Alice v final" } };
    const third = await request(reopenedApp).post("/maps/drafts").set(auth(alice)).send(again);
    expect(third.status).toBe(200);
    expect(third.body.checks.some((c: { severity: string }) => c.severity === "error")).toBe(false);

    // publicar (dueña, rol developer < organizer) → usar: el resolver REAL del launcher lo acepta
    const pub = await request(reopenedApp).post("/maps/fc-c-mapa/versions/1/actions/publish").set(auth(alice));
    expect(pub.status).toBe(200);
    expect(pub.body.state).toBe("published");
    const resolved = await resolveBattleMap(h.db, "fc-c-mapa", 1);
    expect(resolved.ok, resolved.message).toBe(true);
    expect(resolved.map!.mapId).toBe("fc-c-mapa");

    // publicada = inmutable: el siguiente guardado crea v2 en draft
    const v2 = await request(reopenedApp).post("/maps/drafts").set(auth(alice)).send(again);
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, state: "draft" });
    const v1Again = await h.db("map_versions").where({ map_id: "fc-c-mapa", version: 1 }).first();
    expect(v1Again.state).toBe("published");
  });
});

describe("C2 · import/export compatibles", () => {
  it("lo que exporta el editor (GET .../content) se importa en «Mapas» con otro id → 201 y jugable", async () => {
    const exported = (await request(app).get("/maps/fc-c-mapa/versions/1/content")).body;
    const imported = await request(app)
      .post("/maps")
      .set(auth(alice))
      .attach("file", Buffer.from(JSON.stringify({ ...exported, mapId: "fc-c-importado" })), "export.json");
    expect(imported.status).toBe(201);
    expect(imported.body.state).toBe("validated");
    await request(app).post("/maps/fc-c-importado/versions/1/actions/publish").set(auth(alice)).expect(200);
    const resolved = await resolveBattleMap(h.db, "fc-c-importado", 1);
    expect(resolved.ok, resolved.message).toBe(true);
  });

  it("el JSON de autoría antiguo del editor ya no da 500: 400 con mensaje accionable", async () => {
    const legacy = readFileSync(join(REPO, "maps", "training-yard.json"));
    const r = await request(app).post("/maps").set(auth(alice)).attach("file", legacy, "training-yard.json");
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/editor/);
  });

  it("un objeto sin layers (lo que antes reventaba validateMap) es 400, no 500", async () => {
    const r = await request(app)
      .post("/maps")
      .set(auth(alice))
      .attach("file", Buffer.from(JSON.stringify({ mapId: "sin-capas", widthM: 10, heightM: 10 })), "x.json");
    expect(r.status).toBe(400);
  });
});

describe("C6 · propiedad y visibilidad de mapas (tests negativos reales)", () => {
  it("un organizer NO puede añadir versiones ni editar el borrador del mapa de otro", async () => {
    const draft = await request(app).post("/maps/drafts").set(auth(org)).send(editorMap("fc-c-mapa", "secuestro"));
    expect(draft.status).toBe(403);
    const imp = await request(app)
      .post("/maps")
      .set(auth(org))
      .attach("file", Buffer.from(JSON.stringify(editorMap("fc-c-mapa", "secuestro"))), "x.json");
    expect(imp.status).toBe(403);
    const gen = await request(app)
      .post("/maps/generate")
      .set(auth(org))
      .send({ params: { widthM: 120, heightM: 80, mode: "deathmatch", mapId: "fc-c-mapa" }, seed: "s1" });
    expect(gen.status).toBe(403);
    // y la BD no cambió: sigue habiendo exactamente v1 (publicada) y v2 (draft) de Alice
    const rows = await h.db("map_versions").where({ map_id: "fc-c-mapa" }).orderBy("version");
    expect(rows.map((r: { version: number; state: string }) => `${r.version}:${r.state}`)).toEqual([
      "1:published",
      "2:draft",
    ]);
    expect(rows[1].content.meta.name).toBe("Mapa de Alice v final");
  });

  it("nadie salvo admin añade versiones al contenido base (mapa sin dueño)", async () => {
    const asDev = await request(app).post("/maps/drafts").set(auth(alice)).send(editorMap(MVP_ARENA_02_ID, "x"));
    expect(asDev.status).toBe(403);
    const asAdmin = await request(app).post("/maps/drafts").set(auth(admin)).send(editorMap(MVP_ARENA_02_ID, "x"));
    expect(asAdmin.status).toBe(201);
  });

  it("el borrador ajeno no existe para otros (404) y no sale en el listado anónimo", async () => {
    expect((await request(app).get("/maps/fc-c-mapa/versions/2")).status).toBe(404);
    expect((await request(app).get("/maps/fc-c-mapa/versions/2/content").set(auth(bob))).status).toBe(404);
    expect((await request(app).get("/maps/fc-c-mapa/versions/2/content").set(auth(alice))).status).toBe(200);
    const anon = await request(app).get("/maps?limit=100");
    expect(anon.body.items.some((m: { state: string }) => m.state === "draft")).toBe(false);
    expect(JSON.stringify(anon.body)).not.toMatch(UUID_ANYWHERE);
  });

  it("un usuario no publica el mapa de otro (403); un organizer sí puede (curación)", async () => {
    await request(app).post("/maps/drafts").set(auth(alice)).send(editorMap("fc-c-curado", "curado")).expect(201);
    expect((await request(app).post("/maps/fc-c-curado/versions/1/actions/publish").set(auth(bob))).status).toBe(404);
    // bob no ve el borrador → 404; si estuviera validado (público), sería 403:
    await request(app)
      .post("/maps")
      .set(auth(alice))
      .attach("file", Buffer.from(JSON.stringify(editorMap("fc-c-validado", "v"))), "v.json")
      .expect(201);
    expect((await request(app).post("/maps/fc-c-validado/versions/1/actions/publish").set(auth(bob))).status).toBe(403);
    expect((await request(app).post("/maps/fc-c-validado/versions/1/actions/publish").set(auth(org))).status).toBe(200);
  });
});

describe("C7 · rulesets reales y compatibilidad modo ↔ ruleset ↔ mapa", () => {
  it("GET /rulesets sirve los ids de la BD para los 4 modos de plataforma", async () => {
    const r = await request(app).get("/rulesets");
    expect(r.status).toBe(200);
    expect(r.body.modes).toEqual(["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"]);
    for (const mode of r.body.modes) {
      const own = r.body.items.filter((i: { mode: string }) => i.mode === mode);
      expect(own.length, `ruleset para ${mode}`).toBeGreaterThanOrEqual(1);
      // cada uno resuelve a un ruleset REAL del motor del mismo modo (resolver de B)
      for (const rs of own) {
        const res = await resolveBattleRuleset(h.db, mode, rs.id);
        expect(res.ok, res.message).toBe(true);
      }
    }
    const filtered = await request(app).get("/rulesets?mode=zone_control");
    expect(
      filtered.body.items.every((i: { mode: string | null }) => i.mode === null || i.mode === "zone_control"),
    ).toBe(true);
    expect((await request(app).get("/rulesets?mode=__proto__")).status).toBe(400);
  });

  it("checkBattleContent rechaza ruleset de otro modo y mapa que no soporta el modo", async () => {
    const ok = await checkBattleContent(h.db, {
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      mapId: "fc-c-mapa",
      mapVersion: 1,
    });
    expect(ok.ok).toBe(true);
    const wrongRs = await checkBattleContent(h.db, {
      mode: "deathmatch",
      rulesetId: "zone-control-mvp",
      mapId: "fc-c-mapa",
    });
    expect(wrongRs).toMatchObject({ ok: false, status: 409, code: "ruleset_mode_mismatch" });
    const wrongMap = await checkBattleContent(h.db, {
      mode: "capture_the_flag",
      rulesetId: "capture-the-flag-mvp",
      mapId: "fc-c-mapa",
      mapVersion: 1,
    });
    expect(wrongMap).toMatchObject({ ok: false, status: 409, code: "map_mode_unsupported" });
    const unknown = await checkBattleContent(h.db, {
      mode: "deathmatch",
      rulesetId: "dm_practice@1",
      mapId: "fc-c-mapa",
    });
    expect(unknown).toMatchObject({ ok: false, code: "ruleset_unknown" });
    const draft = await checkBattleContent(h.db, {
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      mapId: "fc-c-mapa",
      mapVersion: 2,
    });
    expect(draft).toMatchObject({ ok: false, code: "map_not_published" });
  });

  it("los mapas de serie declaran los modos que soportan de verdad (v1 corregida, mvp-arena-02 con deathmatch, jugable)", async () => {
    const v1 = await h.db("map_versions").where({ map_id: "mvp-arena-01", version: 1 }).first();
    expect(v1.supported_modes).toEqual(MVP.meta.supportedModes);
    // mvp-arena-01 sigue teniendo SOLO la v1 (otros carriles usan "v2" como inexistente)
    expect(await h.db("map_versions").where({ map_id: "mvp-arena-01", version: 2 }).first()).toBeUndefined();
    const a2 = await h.db("map_versions").where({ map_id: MVP_ARENA_02_ID, version: 1 }).first();
    expect(a2.state).toBe("published");
    expect(a2.supported_modes).toEqual([...MVP_ARENA_02_MODES]);
    const resolved = await resolveBattleMap(h.db, MVP_ARENA_02_ID, 1);
    expect(resolved.ok, resolved.message).toBe(true);
    for (const mode of MVP_ARENA_02_MODES) {
      const rs = PLATFORM_RULESETS.find((r) => r.mode === mode)!;
      expect(
        (await checkBattleContent(h.db, { mode, rulesetId: rs.id, mapId: MVP_ARENA_02_ID, mapVersion: 1 })).ok,
      ).toBe(true);
    }
    // zone_control NO: la arena no tiene zona de captura
    const zc = await checkBattleContent(h.db, {
      mode: "zone_control",
      rulesetId: "zone-control-mvp",
      mapId: MVP_ARENA_02_ID,
      mapVersion: 1,
    });
    expect(zc.ok).toBe(false);
  });

  it("seedContent (bootstrap) es idempotente y NO crea usuarios", async () => {
    const users = Number((await h.db("users").count("* as n").first())!.n);
    const rulesets = Number((await h.db("rulesets").count("* as n").first())!.n);
    await seedContent(h.db);
    await seedContent(h.db);
    expect(Number((await h.db("users").count("* as n").first())!.n)).toBe(users);
    expect(Number((await h.db("rulesets").count("* as n").first())!.n)).toBe(rulesets);
  });
});

describe("C5/C6 · equipos completos y sin fuga de identificadores", () => {
  let teamId: string;
  let aliceBot: string;
  let bobBot: string;

  it("crear, renombrar, añadir miembro por email, recuperar", async () => {
    const t = await request(app).post("/teams").set(auth(alice)).send({ name: "FC-C Rojos" });
    expect(t.status).toBe(201);
    teamId = t.body.id;
    expect(t.body).toMatchObject({ isCaptain: true, memberCount: 1 });
    const renamed = await request(app).patch(`/teams/${teamId}`).set(auth(alice)).send({ name: "FC-C Rojos 2" });
    expect(renamed.status).toBe(200);
    const added = await request(app)
      .post(`/teams/${teamId}/members`)
      .set(auth(alice))
      .send({ email: DEV_USERS.team_captain });
    expect(added.status).toBe(201);
    expect(added.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual([aliceId, bobId].sort());
    const got = await request(newApp()).get(`/teams/${teamId}`).set(auth(alice));
    expect(got.body).toMatchObject({ name: "FC-C Rojos 2", memberCount: 2 });
  });

  it("añadir y quitar bots: solo el dueño (miembro) añade; bot ajeno 404; no-miembro 403", async () => {
    aliceBot = await publishedBot(alice, "fc-c-alice-bot");
    bobBot = await publishedBot(bob, "fc-c-bob-bot");
    expect((await request(app).post(`/teams/${teamId}/bots`).set(auth(alice)).send({ botId: aliceBot })).status).toBe(
      201,
    );
    // Alice no puede meter el bot de Bob (aunque sea público)
    expect((await request(app).post(`/teams/${teamId}/bots`).set(auth(alice)).send({ botId: bobBot })).status).toBe(
      404,
    );
    expect((await request(app).post(`/teams/${teamId}/bots`).set(auth(bob)).send({ botId: bobBot })).status).toBe(201);
    const t = await request(app).get(`/teams/${teamId}`).set(auth(bob));
    expect(t.body.bots.map((b: { id: string }) => b.id).sort()).toEqual([aliceBot, bobBot].sort());
    // un equipo ajeno: el organizer no es miembro → no puede meter su bot
    const orgBot = await publishedBot(org, "fc-c-org-bot");
    expect((await request(app).post(`/teams/${teamId}/bots`).set(auth(org)).send({ botId: orgBot })).status).toBe(403);
    // Bob (no capitán) no puede quitar el bot de Alice; Alice (capitana) sí puede quitar el de Bob
    expect((await request(app).delete(`/teams/${teamId}/bots/${aliceBot}`).set(auth(bob))).status).toBe(403);
    expect((await request(app).delete(`/teams/${teamId}/bots/${bobBot}`).set(auth(alice))).status).toBe(204);
    expect((await h.db("bots").where({ id: bobBot }).first()).team_id).toBeNull();
  });

  it("equipo ajeno: ni renombrar, ni borrar, ni gestionar miembros (403); el estado no cambia", async () => {
    expect((await request(app).patch(`/teams/${teamId}`).set(auth(org)).send({ name: "robado" })).status).toBe(403);
    expect((await request(app).delete(`/teams/${teamId}`).set(auth(org))).status).toBe(403);
    expect(
      (await request(app).post(`/teams/${teamId}/members`).set(auth(org)).send({ email: DEV_USERS.organizer })).status,
    ).toBe(403);
    expect((await request(app).delete(`/teams/${teamId}/members/${bobId}`).set(auth(org))).status).toBe(403);
    // Bob es miembro pero no capitán
    expect((await request(app).patch(`/teams/${teamId}`).set(auth(bob)).send({ name: "robado" })).status).toBe(403);
    expect((await h.db("teams").where({ id: teamId }).first()).name).toBe("FC-C Rojos 2");
  });

  it("GET /teams anónimo y de un ajeno NO contiene UUID de usuarios", async () => {
    const anon = await request(app).get("/teams?limit=100");
    expect(anon.status).toBe(200);
    for (const t of anon.body.items) {
      const { id: _teamId, ...rest } = t;
      expect(JSON.stringify(rest)).not.toMatch(UUID_ANYWHERE);
    }
    expect(JSON.stringify(anon.body)).not.toContain(aliceId);
    expect(JSON.stringify(anon.body)).not.toContain(bobId);
    const outsider = await request(app)
      .get(`/teams/${teamId}`)
      .set(auth(await tokenFor(h.db, DEV_USERS.user)));
    expect(JSON.stringify(outsider.body)).not.toContain(aliceId);
    expect(outsider.body.members).toBeUndefined();
  });

  it("usar en batalla: bots del equipo + ruleset de /rulesets + mapa propio → 202", async () => {
    const rs = (await request(app).get("/rulesets?mode=deathmatch")).body.items.find(
      (i: { mode: string }) => i.mode === "deathmatch",
    );
    const r = await request(app)
      .post("/battles")
      .set(auth(alice))
      .send({
        mode: "deathmatch",
        rulesetId: rs.id,
        mapId: "fc-c-mapa",
        mapVersion: 1,
        participants: [
          { botId: aliceBot, version: 1, team: "red" },
          { botId: bobBot, version: 1, team: "blue" },
        ],
      });
    expect(r.status).toBe(202);
    const battle = await h.db("battles").where({ id: r.body.id }).first();
    expect(battle).toMatchObject({ ruleset_id: "deathmatch-mvp", map_id: "fc-c-mapa", map_version: 1 });
  });

  it("quitar miembro desasigna sus bots; borrar el equipo conserva los bots sin equipo", async () => {
    await request(app).post(`/teams/${teamId}/bots`).set(auth(bob)).send({ botId: bobBot }).expect(201);
    expect((await request(app).delete(`/teams/${teamId}/members/${bobId}`).set(auth(alice))).status).toBe(204);
    expect((await h.db("bots").where({ id: bobBot }).first()).team_id).toBeNull();
    expect((await request(app).delete(`/teams/${teamId}`).set(auth(alice))).status).toBe(204);
    expect(await h.db("teams").where({ id: teamId }).first()).toBeUndefined();
    const bot = await h.db("bots").where({ id: aliceBot }).first();
    expect(bot).toBeTruthy();
    expect(bot.team_id).toBeNull();
    expect((await request(app).get(`/teams/${teamId}`)).status).toBe(404);
  });
});
