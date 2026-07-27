/**
 * B11 · GET /bots/{botId}/versions/{version}/builds (extensión).
 *
 * Sin este endpoint el panel solo conocía el build por el id que devolvía el
 * submit: tras un F5 se quedaba SIN forma de saber cómo había terminado el
 * pipeline y pintaba "queued · todas las etapas pending" para siempre. Aquí se
 * comprueba el COMPORTAMIENTO: builds de LA versión pedida (no de otra), estado
 * final tras completar el pipeline, logs solo para quien puede verlos y la
 * misma regla de visibilidad de objeto que el resto de rutas de bots.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager, QueueBotManager, completeBuild, PIPELINE_STAGES } from "./services/bot-manager.js";

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
let dev: string;
let moderator: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  fake = new FakeBotManager(h.db);
  app = createApp({ db: h.db, botManager: fake });
  dev = await tokenFor(h.db, DEV_USERS.developer);
  moderator = await tokenFor(h.db, DEV_USERS.moderator);
}, 120000);

afterAll(async () => {
  await h.stop();
});

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function botWithLoadout(name: string) {
  const bot = await request(app).post("/bots").set(auth(dev)).send({ name });
  expect(bot.status).toBe(201);
  const l = await request(app)
    .post(`/bots/${bot.body.id}/loadouts`)
    .set(auth(dev))
    .send({ ...GOOD_LOADOUT, loadoutId: undefined, revision: undefined });
  expect(l.status).toBe(201);
  return bot.body.id as string;
}

async function newVersion(botId: string): Promise<number> {
  const r = await request(app)
    .post(`/bots/${botId}/versions`)
    .set(auth(dev))
    .field("runtime", "python")
    .field("loadoutRevision", "1")
    .attach("source", Buffer.from("print('hola')"), "bot.py.zip");
  expect(r.status).toBe(201);
  return r.body.version as number;
}

function failing() {
  return {
    status: "failed" as const,
    stages: PIPELINE_STAGES.map((name) => ({
      name,
      status: name === "static_analysis" ? "failed" : "passed",
      ...(name === "static_analysis"
        ? { message: "src/bot.js (el fichero parece TypeScript)", logUrl: "https://logs.internal/sa" }
        : {}),
    })),
    rejectionReason: "static_analysis: el fichero parece TypeScript",
  };
}

describe("B11 · builds por versión", () => {
  it("devuelve el estado FINAL del pipeline de esa versión (no un queued eterno)", async () => {
    const botId = await botWithLoadout("b11-final");
    const v = await newVersion(botId);
    fake.nextResult = failing;
    const submit = await request(app).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(202);

    const list = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(dev));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe("failed");
    expect(list.body[0].version).toBe(v);
    const sa = list.body[0].stages.find((s: { name: string }) => s.name === "static_analysis");
    expect(sa.status).toBe("failed");
    expect(sa.message).toContain("parece TypeScript");
  });

  it("cada versión devuelve SUS builds: v1 fallida y v2 correcta no se mezclan", async () => {
    const botId = await botWithLoadout("b11-dos-versiones");
    const v1 = await newVersion(botId);
    fake.nextResult = failing;
    await request(app).post(`/bots/${botId}/versions/${v1}/actions/submit`).set(auth(dev));

    const v2 = await newVersion(botId);
    fake.nextResult = () => ({
      status: "passed" as const,
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "a".repeat(64),
    });
    await request(app).post(`/bots/${botId}/versions/${v2}/actions/submit`).set(auth(dev));

    const b1 = await request(app).get(`/bots/${botId}/versions/${v1}/builds`).set(auth(dev));
    const b2 = await request(app).get(`/bots/${botId}/versions/${v2}/builds`).set(auth(dev));
    expect(b1.body.map((b: { status: string }) => b.status)).toEqual(["failed"]);
    expect(b2.body.map((b: { status: string }) => b.status)).toEqual(["passed"]);
    expect(b1.body.every((b: { version: number }) => b.version === v1)).toBe(true);
    expect(b2.body.every((b: { version: number }) => b.version === v2)).toBe(true);
  });

  it("los reintentos salen del más reciente al más antiguo", async () => {
    const botId = await botWithLoadout("b11-reintentos");
    const v = await newVersion(botId);
    fake.nextResult = failing;
    await request(app).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));
    // rejected ⇒ se puede reenviar (cap. 17.1); esta vez pasa
    fake.nextResult = () => ({
      status: "passed" as const,
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "b".repeat(64),
    });
    await request(app).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));

    const list = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(dev));
    expect(list.body).toHaveLength(2);
    expect(list.body[0].status).toBe("passed"); // el más reciente primero
    expect(list.body[1].status).toBe("failed");
  });

  it("con el encolador REAL, el 202 dice queued y solo este endpoint revela el final", async () => {
    // Reproduce el escenario de producción: el pipeline lo corre el worker, no
    // la API. El panel se quedaba con la foto del 202 (queued · todo pending).
    const realApp = createApp({ db: h.db, botManager: new QueueBotManager(h.db) });
    const bot = await request(realApp).post("/bots").set(auth(dev)).send({ name: "b11-cola-real" });
    await request(realApp)
      .post(`/bots/${bot.body.id}/loadouts`)
      .set(auth(dev))
      .send({ ...GOOD_LOADOUT, loadoutId: undefined, revision: undefined });
    const created = await request(realApp)
      .post(`/bots/${bot.body.id}/versions`)
      .set(auth(dev))
      .field("runtime", "node")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.from("export function tick() {}"), "bot.js");
    const v = created.body.version as number;

    const submit = await request(realApp).post(`/bots/${bot.body.id}/versions/${v}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("queued"); // la foto congelada del panel
    expect(submit.body.stages.every((s: { status: string }) => s.status === "pending")).toBe(true);

    // El worker termina el trabajo más tarde…
    await completeBuild(h.db, submit.body.id, failing());

    // …y el panel se entera SOLO gracias a esta lectura.
    const list = await request(realApp).get(`/bots/${bot.body.id}/versions/${v}/builds`).set(auth(dev));
    expect(list.body[0].status).toBe("failed");
    expect(list.body[0].stages.some((s: { status: string }) => s.status === "pending")).toBe(false);
    const versions = await request(realApp).get(`/bots/${bot.body.id}/versions`).set(auth(dev));
    expect(versions.body.find((x: { version: number }) => x.version === v).state).toBe("rejected");
  });

  it("reenviar una versión rechazada LIMPIA el motivo del rechazo anterior", async () => {
    // Causa raíz del defecto: `submit` (rejected → validating) dejaba el
    // rejection_reason del intento previo en la fila, y cualquier pantalla que
    // lo pintara contaba un error viejo como si fuera el actual.
    const botId = await botWithLoadout("b11-limpia-motivo");
    const v = await newVersion(botId);
    fake.nextResult = failing;
    await request(app).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));

    const rechazada = await request(app).get(`/bots/${botId}/versions`).set(auth(dev));
    const antes = rechazada.body.find((x: { version: number }) => x.version === v);
    expect(antes.state).toBe("rejected");
    expect(antes.rejectionReason).toContain("parece TypeScript");

    // Reenvío: mientras valida NO puede quedar el motivo anterior colgando.
    fake.nextResult = () => ({
      status: "passed" as const,
      stages: PIPELINE_STAGES.map((name) => ({ name, status: "passed" })),
      artifactHash: "c".repeat(64),
    });
    const conCola = createApp({ db: h.db, botManager: new QueueBotManager(h.db) });
    const submit = await request(conCola).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));
    expect(submit.status).toBe(202);

    const validando = await request(conCola).get(`/bots/${botId}/versions`).set(auth(dev));
    const ahora = validando.body.find((x: { version: number }) => x.version === v);
    expect(ahora.state).toBe("validating");
    expect(ahora.rejectionReason).toBeUndefined();
  });

  it("una versión que existe pero nunca se envió devuelve [] (no inventa un build)", async () => {
    const botId = await botWithLoadout("b11-sin-enviar");
    const v = await newVersion(botId);
    const list = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(dev));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it("versión inexistente ⇒ 404", async () => {
    const botId = await botWithLoadout("b11-404");
    await newVersion(botId);
    const list = await request(app).get(`/bots/${botId}/versions/99/builds`).set(auth(dev));
    expect(list.status).toBe(404);
  });

  it("logUrl (x-private) solo para el dueño y el staff; un tercero ni ve el bot", async () => {
    const botId = await botWithLoadout("b11-logs");
    const v = await newVersion(botId);
    fake.nextResult = failing;
    await request(app).post(`/bots/${botId}/versions/${v}/actions/submit`).set(auth(dev));

    const owner = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(dev));
    expect(owner.body[0].stages.some((s: { logUrl?: string }) => !!s.logUrl)).toBe(true);
    const mod = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(moderator));
    expect(mod.status).toBe(200);
    expect(mod.body[0].stages.some((s: { logUrl?: string }) => !!s.logUrl)).toBe(true);

    // Otro developer: el bot es privado ⇒ 404 por visibilidad de objeto.
    await request(app)
      .post("/auth/register")
      .send({ email: "b11otro@test.local", password: "password-b11-otro-1", displayName: "OtroB11" });
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "b11otro@test.local", password: "password-b11-otro-1" });
    const stranger = await request(app).get(`/bots/${botId}/versions/${v}/builds`).set(auth(login.body.accessToken));
    expect(stranger.status).toBe(404);
  });
});
