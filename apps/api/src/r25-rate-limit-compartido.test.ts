/**
 * R2.5 (ERR-SEC-12/14) · Rate-limit y bloqueo en almacén COMPARTIDO (api_usage).
 *
 * DoD: "El rate-limit sobrevive a un reinicio del proceso (test contra el
 * almacén compartido)." El "reinicio" se materializa creando instancias NUEVAS
 * de la app/limitadores sobre la misma BD: en memoria no queda nada.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { SharedFailedLoginGuard, SharedRateLimiter } from "./middleware/shared-rate-limit.js";

let h: TestDbHandle;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 120_000);

afterAll(async () => {
  await h.stop();
});

describe("R2.5 · SharedRateLimiter (api_usage)", () => {
  it("el límite sobrevive a un 'reinicio del proceso' (instancia nueva, misma BD)", async () => {
    const a = new SharedRateLimiter(h.db, "test.restart", { max: 2, windowMs: 3600_000 });
    expect(await a.hit("user:u1")).toBe(true);
    expect(await a.hit("user:u1")).toBe(true);
    expect(await a.hit("user:u1")).toBe(false);

    // "Reinicio": instancia nueva sin ningún estado en memoria.
    const b = new SharedRateLimiter(h.db, "test.restart", { max: 2, windowMs: 3600_000 });
    expect(await b.hit("user:u1")).toBe(false);
    // Otro usuario no está afectado.
    expect(await b.hit("user:u2")).toBe(true);
  });

  it("las ventanas caducadas se podan (expiración)", async () => {
    await h.db("api_usage").insert({
      actor_key: "user:viejo",
      route: "test.exp",
      window_start: new Date(Date.now() - 7200_000),
      count: 99,
      expires_at: new Date(Date.now() - 3600_000),
    });
    const lim = new SharedRateLimiter(h.db, "test.exp", { max: 5, windowMs: 60_000 });
    expect(await lim.hit("user:nuevo")).toBe(true);
    const old = await h.db("api_usage").where({ actor_key: "user:viejo", route: "test.exp" });
    expect(old.length).toBe(0); // podada por expires_at
  });

  it("cota de claves: un atacante no puede crecer la tabla sin límite", async () => {
    const lim = new SharedRateLimiter(h.db, "test.quota", { max: 5, windowMs: 3600_000, maxKeys: 5 });
    for (let i = 0; i < 20; i++) {
      await lim.hit(`ip:1.2.3.${i}`);
    }
    const [{ c }] = (await h.db("api_usage").where({ route: "test.quota" }).count("* as c")) as { c: string }[];
    expect(Number(c)).toBeLessThanOrEqual(5);
  });
});

describe("R2.5 · rate-limit por usuario en creación de versiones/builds (ERR-SEC-12)", () => {
  it("429 al superar el límite, y el límite sobrevive al reinicio de la app", async () => {
    const mkApp = () =>
      createApp({
        db: h.db,
        botManager: new FakeBotManager(h.db),
        buildLimiters: {
          // Instancias NUEVAS por app: el estado compartido vive solo en la BD.
          createVersion: new SharedRateLimiter(h.db, "bots.createVersion", { max: 2, windowMs: 3600_000 }),
          submit: new SharedRateLimiter(h.db, "bots.submitVersion", { max: 1, windowMs: 3600_000 }),
        },
      });
    const app1 = mkApp();
    const auth = { Authorization: `Bearer ${await tokenFor(h.db, DEV_USERS.developer)}` };
    const bot = await request(app1).post("/bots").set(auth).send({ name: "r25-limite-bot" });
    expect(bot.status).toBe(201);

    const upload = (app: ReturnType<typeof mkApp>) =>
      request(app)
        .post(`/bots/${bot.body.id}/versions`)
        .set(auth)
        .field("runtime", "python")
        .field("loadoutRevision", "1")
        .attach("source", Buffer.from("print('hola')"), "bot.py");

    // Sin loadout la petición fallaría 400 DESPUÉS del limitador; para este test
    // basta con que el limitador cuente ANTES: 2 permitidas, la 3ª es 429.
    expect((await upload(app1)).status).not.toBe(429);
    expect((await upload(app1)).status).not.toBe(429);
    expect((await upload(app1)).status).toBe(429);

    // "Reinicio del proceso": app nueva, limitadores nuevos, misma BD ⇒ sigue 429.
    const app2 = mkApp();
    expect((await upload(app2)).status).toBe(429);

    // submit limitado a 1/h: la segunda va con 429 aunque la app sea nueva.
    // (versión inexistente ⇒ 404 tras el limitador; lo que importa es el 429)
    const submit = (app: ReturnType<typeof mkApp>) =>
      request(app).post(`/bots/${bot.body.id}/versions/9/actions/submit`).set(auth);
    expect((await submit(app1)).status).toBe(404);
    expect((await submit(app2)).status).toBe(429);
  });
});

describe("R2.5 · bloqueo de fuerza bruta de login persistente (ERR-SEC-14)", () => {
  it("el bloqueo sobrevive al reinicio: guard nuevo, misma BD", async () => {
    const g1 = new SharedFailedLoginGuard(h.db, 3, 60_000);
    expect(await g1.isBlocked("ip|a@x.com")).toBe(false);
    expect(await g1.recordFailure("ip|a@x.com")).toBe(false);
    expect(await g1.recordFailure("ip|a@x.com")).toBe(false);
    expect(await g1.recordFailure("ip|a@x.com")).toBe(true); // dispara el bloqueo
    expect(await g1.isBlocked("ip|a@x.com")).toBe(true);

    const g2 = new SharedFailedLoginGuard(h.db, 3, 60_000); // "reinicio"
    expect(await g2.isBlocked("ip|a@x.com")).toBe(true);

    await g2.recordSuccess("ip|a@x.com");
    expect(await g2.isBlocked("ip|a@x.com")).toBe(false);
  });

  it("por HTTP: los fallos con una app cuentan para el bloqueo en la app 'reiniciada'", async () => {
    const mkApp = (guard: SharedFailedLoginGuard) => createApp({ db: h.db, loginGuard: guard });
    const app1 = mkApp(new SharedFailedLoginGuard(h.db, 2, 60_000));
    const creds = { email: "nadie@test.local", password: "no-importa-123" };
    expect((await request(app1).post("/auth/login").send(creds)).status).toBe(401);
    expect((await request(app1).post("/auth/login").send(creds)).status).toBe(401); // dispara bloqueo

    const app2 = mkApp(new SharedFailedLoginGuard(h.db, 2, 60_000)); // "reinicio"
    expect((await request(app2).post("/auth/login").send(creds)).status).toBe(429);
  });
});
