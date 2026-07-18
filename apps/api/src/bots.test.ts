/**
 * T7.3 · DoD: máquina de estados exhaustiva (ilegal ⇒ 409, legal ⇒ auditada),
 * inmutabilidad de versiones publicadas/congeladas (también para admin),
 * revisiones de loadout que no alteran inscripciones congeladas y violaciones
 * exactas del validador E3.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager, PIPELINE_STAGES } from "./services/bot-manager.js";
import { TRANSITIONS, assertTransition, type BotState } from "./services/bots.js";
import { ApiError } from "./errors.js";
import { BOT_STATES } from "./db/migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_LOADOUT = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
    "utf8",
  ),
);

let h: TestDbHandle;
let app: Express;
let fake: FakeBotManager;
let dev: string; // token developer (dueño)
let other: string; // token de otro usuario
let admin: string;
let moderator: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  fake = new FakeBotManager(h.db);
  app = createApp({ db: h.db, botManager: fake });
  dev = await tokenFor(h.db, DEV_USERS.developer);
  other = await tokenFor(h.db, DEV_USERS.user);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function newBotWithLoadout(name: string, visibility = "private") {
  const bot = await request(app).post("/bots").set(auth(dev)).send({ name, visibility });
  expect(bot.status).toBe(201);
  const loadout = await request(app)
    .post(`/bots/${bot.body.id}/loadouts`)
    .set(auth(dev))
    .send({ ...GOOD_LOADOUT, loadoutId: undefined, revision: undefined });
  expect(loadout.status).toBe(201);
  return bot.body;
}

async function newVersion(botId: string): Promise<number> {
  const r = await request(app)
    .post(`/bots/${botId}/versions`)
    .set(auth(dev))
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from("print('hola')"), "bot.py.zip");
  expect(r.status).toBe(201);
  expect(r.body.state).toBe("draft");
  return r.body.version;
}

describe("T7.3 máquina de estados (cap. 17.1)", () => {
  it("unit: toda combinación estado×acción ilegal lanza 409 con transiciones permitidas", () => {
    let legal = 0;
    let illegal = 0;
    for (const state of BOT_STATES) {
      for (const action of Object.keys(TRANSITIONS)) {
        if (TRANSITIONS[action].from.includes(state as BotState)) {
          expect(assertTransition(action, state as BotState)).toBe(TRANSITIONS[action].to);
          legal++;
        } else {
          try {
            assertTransition(action, state as BotState);
            expect.unreachable(`${action} desde ${state} debería ser ilegal`);
          } catch (e) {
            expect(e).toBeInstanceOf(ApiError);
            expect((e as ApiError).status).toBe(409);
            expect((e as ApiError).extra.currentState).toBe(state);
            expect(Array.isArray((e as ApiError).extra.allowedTransitions)).toBe(true);
            illegal++;
          }
        }
      }
    }
    expect(legal + illegal).toBe(BOT_STATES.length * Object.keys(TRANSITIONS).length);
    expect(legal).toBeGreaterThan(0);
  });

  it("flujo E2E: draft → validating → validated → published → retired, todo auditado", async () => {
    const bot = await newBotWithLoadout("sm-bot");
    const version = await newVersion(bot.id);

    const submit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("passed"); // FakeBotManager valida al instante
    expect(submit.body.stages.map((s: { name: string }) => s.name)).toEqual([...PIPELINE_STAGES]);

    const validated = await h.db("bot_versions").where({ bot_id: bot.id, version }).first();
    expect(validated.state).toBe("validated");
    expect(validated.artifact_hash).toBe("f".repeat(64));

    const publish = await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/publish`)
      .set(auth(dev))
      .send({ codePublic: false });
    expect(publish.status).toBe(200);
    expect(publish.body.state).toBe("published");

    const retire = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/retire`).set(auth(dev));
    expect(retire.status).toBe(200);
    expect(retire.body.state).toBe("retired");

    // Toda transición legal queda auditada
    for (const action of ["submit", "validated", "publish", "retire"]) {
      const row = await h
        .db("audit_log")
        .where({ target: `bot:${bot.id}@${version}` })
        .whereLike("action", `%${action}%`)
        .first();
      expect(row, `auditoría de ${action}`).toBeTruthy();
    }
  });

  it("transiciones ilegales por API devuelven 409 con currentState y allowedTransitions", async () => {
    const bot = await newBotWithLoadout("sm-bot-illegal");
    const version = await newVersion(bot.id);

    // publish desde draft ⇒ 409
    const r = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/publish`).set(auth(dev)).send({});
    expect(r.status).toBe(409);
    expect(r.body.currentState).toBe("draft");
    expect(r.body.allowedTransitions).toContain("submit");

    // retire desde draft ⇒ 409
    const r2 = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/retire`).set(auth(dev));
    expect(r2.status).toBe(409);
  });

  it("un build fallido deja la versión en rejected y permite reenviar", async () => {
    const bot = await newBotWithLoadout("sm-bot-reject");
    const version = await newVersion(bot.id);
    fake.nextResult = () => ({
      status: "failed",
      stages: [{ name: "static_analysis", status: "failed", message: "import prohibido" }],
      rejectionReason: "static_analysis: import prohibido",
    });
    const submit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(202);
    const v = await h.db("bot_versions").where({ bot_id: bot.id, version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toContain("static_analysis");

    fake.nextResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "a".repeat(64),
    });
    const resubmit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    expect(resubmit.status).toBe(202);
    const v2 = await h.db("bot_versions").where({ bot_id: bot.id, version }).first();
    expect(v2.state).toBe("validated");
  });

  it("suspensión por moderador con motivo, desde casi cualquier estado", async () => {
    const bot = await newBotWithLoadout("sm-bot-suspend", "public");
    const version = await newVersion(bot.id);
    const noReason = await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/suspend`)
      .set(auth(moderator))
      .send({});
    expect(noReason.status).toBe(400);
    const r = await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/suspend`)
      .set(auth(moderator))
      .send({ reason: "hallazgo de seguridad" });
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("suspended");
    // suspended es terminal salvo intervención manual: submit ⇒ 409
    const submit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(409);
  });
});

describe("T7.3 inmutabilidad de published/frozen (DoD: ni el admin)", () => {
  it("una versión publicada no admite submit/publish, ni siquiera como admin", async () => {
    const bot = await newBotWithLoadout("immutable-bot", "public");
    const version = await newVersion(bot.id);
    fake.nextResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "b".repeat(64),
    });
    await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/publish`)
      .set(auth(dev))
      .send({ codePublic: true });

    // El dueño choca con la máquina de estados (409, cap. 17.1)
    const submit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    expect(submit.status, "submit sobre published").toBe(409);
    // re-publish (p. ej. para revertir codePublic, irreversible por D9) ⇒ 409
    const republish = await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/publish`)
      .set(auth(dev))
      .send({ codePublic: false });
    expect(republish.status, "publish sobre published").toBe(409);

    // El admin ni siquiera pasa la autorización de OBJETO (contrato E1: un rol
    // suficiente no da acceso a recursos ajenos): debe crear su propia versión.
    for (const action of ["submit", "publish", "retire"] as const) {
      const r = await request(app)
        .post(`/bots/${bot.id}/versions/${version}/actions/${action}`)
        .set(auth(admin))
        .send({});
      expect(r.status, `${action} como admin sobre bot ajeno`).toBe(403);
    }
    const v = await h.db("bot_versions").where({ bot_id: bot.id, version }).first();
    expect(v.code_public).toBe(true); // sigue intacto

    // Una versión congelada tampoco se puede tocar (ni por su dueño)
    await h.db("bot_versions").where({ bot_id: bot.id, version }).update({ state: "frozen" });
    const retire = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/retire`).set(auth(dev));
    expect(retire.status).toBe(409);
    expect(retire.body.currentState).toBe("frozen");
  });

  it("subir código nuevo crea una versión NUEVA, nunca modifica la publicada", async () => {
    const bot = await newBotWithLoadout("newver-bot");
    const v1 = await newVersion(bot.id);
    const v2 = await newVersion(bot.id);
    expect(v2).toBe(v1 + 1);
    const versions = await request(app).get(`/bots/${bot.id}/versions`).set(auth(dev));
    expect(versions.body.length).toBe(2);
  });
});

describe("T7.3 loadouts (cap. 17.2)", () => {
  it("un cambio de loadout crea revisión nueva y NO altera inscripciones congeladas", async () => {
    const bot = await newBotWithLoadout("frozen-entry-bot", "public");
    const version = await newVersion(bot.id);
    // publica y congela vía inscripción
    fake.nextResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "c".repeat(64),
    });
    await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    await request(app).post(`/bots/${bot.id}/versions/${version}/actions/publish`).set(auth(dev)).send({});
    const [t] = await h
      .db("tournaments")
      .insert({ name: "copa-17-2", format: "round_robin", mode: "deathmatch", ruleset_id: DEFAULT_RULESET_ID })
      .returning("*");
    await h.db("entries").insert({
      tournament_id: t.id,
      bot_id: bot.id,
      version,
      loadout_revision: 1,
      frozen: true,
    });

    // Nueva revisión de loadout
    const r2 = await request(app)
      .post(`/bots/${bot.id}/loadouts`)
      .set(auth(dev))
      .send({ ...GOOD_LOADOUT, name: "revisión 2" });
    expect(r2.status).toBe(201);
    expect(r2.body.revision).toBe(2);

    // La inscripción congelada sigue apuntando a la revisión 1, intacta
    const entry = await h.db("entries").where({ tournament_id: t.id, bot_id: bot.id }).first();
    expect(entry.loadout_revision).toBe(1);
    const rev1 = await h.db("bot_loadouts").where({ bot_id: bot.id, revision: 1 }).first();
    expect(rev1.name).not.toBe("revisión 2");
  });

  it("un loadout inválido devuelve las violaciones EXACTAS del validador E3", async () => {
    const bot = await newBotWithLoadout("invalid-loadout-bot");
    // presupuesto reventado: cañones en todas las ranuras compatibles + chasis pesado
    const r = await request(app)
      .post(`/bots/${bot.id}/loadouts`)
      .set(auth(dev))
      .send({
        catalogVersion: "mvp@1",
        chassis: "chassis.medium@1",
        modules: [
          { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.standard@1" },
          { slot: "no-existe", moduleId: "weapon.mg@1" },
          { slot: "drive", moduleId: "weapon.mg@1" },
        ],
      });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("loadout_invalid");
    const codes = r.body.violations.map((v: { code: string }) => v.code);
    expect(codes).toContain("unknown_slot"); // ranura inexistente
    expect(codes).toContain("slot_type_mismatch"); // arma en ranura de movimiento
    expect(codes).toContain("incompatible_ammo"); // el cañón no acepta standard
    // y la revisión NO se crea
    const loadouts = await h.db("bot_loadouts").where({ bot_id: bot.id });
    expect(loadouts.length).toBe(1);
  });

  it("T7.4 bypass: una petición manual sobre presupuesto es re-verificada por el servidor (422)", async () => {
    // El editor web bloquea esto en cliente; aquí lo enviamos a mano igualmente.
    const bot = await newBotWithLoadout("bypass-bot");
    const r = await request(app)
      .post(`/bots/${bot.id}/loadouts`)
      .set(auth(dev))
      .send({
        catalogVersion: "mvp@1",
        chassis: "chassis.heavy@1",
        modules: [
          { slot: "drive", moduleId: "movement.tracks@1" },
          { slot: "power", moduleId: "power.generator@1" },
          { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
          { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
          { slot: "armor_front", moduleId: "armor.composite_front@1" },
          { slot: "armor_left", moduleId: "armor.composite_left@1" },
          { slot: "armor_right", moduleId: "armor.composite_right@1" },
          { slot: "armor_rear", moduleId: "armor.composite_rear@1" },
        ],
      });
    expect(r.status).toBe(422);
    expect(r.body.violations.map((v: { code: string }) => v.code)).toContain("budget_exceeded");
  });

  it("las referencias del loadout impiden borrar módulos del catálogo (integridad T7.1)", async () => {
    await expect(
      h
        .db("module_definitions")
        .where({ catalog_version: "mvp@1", module_id: "weapon.cannon", module_version: 1 })
        .delete(),
    ).rejects.toThrow(/foreign key|viola/i);
  });
});

describe("T7.3 autorización de objeto (código y logs privados)", () => {
  it("solo el dueño (o staff) descarga código privado; codePublic lo abre tras publicar", async () => {
    const bot = await newBotWithLoadout("source-bot", "public");
    const version = await newVersion(bot.id);

    const owner = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(dev));
    expect(owner.status).toBe(200);
    const stranger = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(other));
    expect(stranger.status).toBe(403);
    const mod = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(moderator));
    expect(mod.status).toBe(200);

    fake.nextResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "d".repeat(64),
    });
    await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    await request(app)
      .post(`/bots/${bot.id}/versions/${version}/actions/publish`)
      .set(auth(dev))
      .send({ codePublic: true });
    const nowPublic = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(other));
    expect(nowPublic.status).toBe(200);
  });

  it("R2.6 (ERR-SEC-09): la descarga emite Content-Disposition RFC 6266/5987 sin comillas/CRLF y con defecto derivado del id de versión", async () => {
    const bot = await newBotWithLoadout("header-bot", "public");
    const version = await newVersion(bot.id);

    // Nombre hostil persistido (fila anterior al saneado de entrada): la cabecera
    // se sanea igualmente al emitir — sin inyección ni spoofing.
    await h.db("bot_versions")
      .where({ bot_id: bot.id, version })
      .update({ source_filename: 'evil".zip\r\nX-Spoof: 1' });
    const evil = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(dev));
    expect(evil.status).toBe(200);
    const header = evil.headers["content-disposition"];
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''[A-Za-z0-9%._-]*$/);
    expect(evil.headers["x-spoof"]).toBeUndefined();

    // Sin nombre almacenado: defecto derivado del id de versión, no del cliente.
    await h.db("bot_versions").where({ bot_id: bot.id, version }).update({ source_filename: null });
    const fallback = await request(app).get(`/bots/${bot.id}/versions/${version}/source`).set(auth(dev));
    expect(fallback.status).toBe(200);
    expect(fallback.headers["content-disposition"]).toContain(`filename="bot-${bot.id}-v${version}-source.bin"`);
  });

  it("un bot privado ajeno es 404 (ni existe) y sus builds/logs invisibles", async () => {
    const bot = await newBotWithLoadout("private-bot", "private");
    const version = await newVersion(bot.id);
    fake.nextResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed", logUrl: "https://logs.internal/x" })),
      artifactHash: "e".repeat(64),
    });
    const submit = await request(app).post(`/bots/${bot.id}/versions/${version}/actions/submit`).set(auth(dev));
    const buildId = submit.body.id;

    const strangerBot = await request(app).get(`/bots/${bot.id}`).set(auth(other));
    expect(strangerBot.status).toBe(404);
    // Con rol user (< developer) el RBAC corta antes: 403 por rol
    const strangerBuildByRole = await request(app).get(`/builds/${buildId}`).set(auth(other));
    expect(strangerBuildByRole.status).toBe(403);
    // Otro DEVELOPER (rol suficiente) tampoco ve el build ajeno: 404 por objeto
    await request(app)
      .post("/auth/register")
      .send({ email: "otrodev@test.local", password: "password-otrodev-1", displayName: "OtroDev" });
    const otherDevLogin = await request(app)
      .post("/auth/login")
      .send({ email: "otrodev@test.local", password: "password-otrodev-1" });
    const strangerBuild = await request(app).get(`/builds/${buildId}`).set(auth(otherDevLogin.body.accessToken));
    expect(strangerBuild.status).toBe(404);

    // El dueño ve logUrl; un moderador también; la respuesta al dueño la incluye
    const ownerBuild = await request(app).get(`/builds/${buildId}`).set(auth(dev));
    expect(ownerBuild.status).toBe(200);
    expect(ownerBuild.body.stages[0].logUrl).toBeTruthy();
  });

  it("el código subido supera 10 MB ⇒ 413 (E6.M)", async () => {
    const bot = await newBotWithLoadout("big-bot");
    const r = await request(app)
      .post(`/bots/${bot.id}/versions`)
      .set(auth(dev))
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.alloc(10 * 1024 * 1024 + 1), "big.zip");
    expect(r.status).toBe(413);
  });
});
