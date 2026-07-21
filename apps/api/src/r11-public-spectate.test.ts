/**
 * R11 · Espectador público (slice mínimo): GET /public/battles/live.
 *
 * Capability S9_PUBLIC_SPECTATE_ENABLED apagada por defecto (inyectada en tests,
 * nunca leída de process.env real aquí). Cubre: apagada→200 {enabled:false,
 * battles:[]}, encendida con batalla en directo→SOLO campos públicos (sin seed,
 * tickets ni participantes), acceso sin cuenta, y reflejo en GET /system/status.
 *
 * N5/R11 · GET /public/battles/{battleId} (estado público de UNA batalla):
 * a diferencia del listado, aquí SÍ hay 404 con la capability apagada (no
 * enabled:false), y 404 también si la batalla no existe o no está `running`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { publicSpectateEnabledFromEnv } from "./public-spectate.js";

let h: TestDbHandle;
let rulesetId: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  rulesetId = (await h.db("rulesets").first()).id;
}, 120_000);

afterAll(async () => {
  await h.stop();
});

/** Batalla `running` con seed sensible, sobre el mapa publicado del seed (mvp-arena-01 v1). */
async function seedRunningBattle() {
  const [row] = await h
    .db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "deathmatch",
      ruleset_id: rulesetId,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "top-secret-seed-should-never-leak",
      seed_commitment: "commit-should-never-leak",
      started_at: h.db.fn.now(),
    })
    .returning("id");
  return row.id as string;
}

describe("R11 · publicSpectateEnabledFromEnv (default OFF)", () => {
  it("es false cuando S9_PUBLIC_SPECTATE_ENABLED no está definida o vale distinto de 1/true", () => {
    expect(publicSpectateEnabledFromEnv({})).toBe(false);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "0" })).toBe(false);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "false" })).toBe(false);
  });

  it("es true SOLO con '1' o 'true' (case-insensitive)", () => {
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "1" })).toBe(true);
    expect(publicSpectateEnabledFromEnv({ S9_PUBLIC_SPECTATE_ENABLED: "TRUE" })).toBe(true);
  });

  it("createApp() sin publicSpectateEnabled explícito usa el entorno real (apagado por defecto en test)", async () => {
    delete process.env.S9_PUBLIC_SPECTATE_ENABLED;
    const app: Express = createApp({ db: h.db }); // sin cfg.publicSpectateEnabled: cae al default del entorno
    const res = await request(app).get("/public/battles/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, battles: [] });
  });
});

describe("R11 · GET /public/battles/live (capability apagada, por defecto)", () => {
  it("responde 200 SIN cuenta con enabled:false y battles:[] aunque haya batallas en directo", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: false });
    await seedRunningBattle();
    const res = await request(app).get("/public/battles/live"); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, battles: [] });
  });

  it("GET /system/status refleja publicSpectateEnabled:false", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: false });
    const admin = await tokenFor(h.db, DEV_USERS.admin);
    const res = await request(app).get("/system/status").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.publicSpectateEnabled).toBe(false);
  });
});

describe("R11 · GET /public/battles/live (capability encendida)", () => {
  it("expone la batalla en directo SOLO con campos públicos, sin cuenta", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const battleId = await seedRunningBattle();

    const res = await request(app).get("/public/battles/live"); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(Array.isArray(res.body.battles)).toBe(true);
    const found = res.body.battles.find((b: { id: string }) => b.id === battleId);
    expect(found).toBeDefined();

    // Solo campos públicos: finishedAt no viaja (undefined) para una batalla en directo.
    expect(Object.keys(found).sort()).toEqual(
      ["createdAt", "id", "mapId", "mapName", "mode", "status", "startedAt"].sort(),
    );
    expect(found.status).toBe("running");
    expect(found.mode).toBe("deathmatch");
    expect(found.mapId).toBe("mvp-arena-01");
    expect(typeof found.mapName).toBe("string");
    expect(typeof found.createdAt).toBe("string");
    expect(typeof found.startedAt).toBe("string");
    expect(found.finishedAt).toBeUndefined();

    // Ausencia explícita de campos privados/sensibles.
    const raw = JSON.stringify(found);
    expect(raw).not.toContain("top-secret-seed-should-never-leak");
    expect(raw).not.toContain("commit-should-never-leak");
    for (const forbidden of [
      "seed",
      "seedCommitment",
      "seedRevealProof",
      "participants",
      "result",
      "ticket",
      "token",
    ]) {
      expect(found[forbidden]).toBeUndefined();
    }
  });

  it("no incluye batallas que no estén en directo (scheduled/finished)", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const [scheduled] = await h
      .db("battles")
      .insert({
        status: "scheduled",
        official: false,
        mode: "deathmatch",
        ruleset_id: rulesetId,
        map_id: "mvp-arena-01",
        map_version: 1,
      })
      .returning("id");
    const [finished] = await h
      .db("battles")
      .insert({
        status: "finished",
        official: false,
        mode: "deathmatch",
        ruleset_id: rulesetId,
        map_id: "mvp-arena-01",
        map_version: 1,
        finished_at: h.db.fn.now(),
      })
      .returning("id");

    const res = await request(app).get("/public/battles/live");
    expect(res.status).toBe(200);
    const ids = res.body.battles.map((b: { id: string }) => b.id);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(finished.id);
  });

  it("GET /system/status refleja publicSpectateEnabled:true", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const admin = await tokenFor(h.db, DEV_USERS.admin);
    const res = await request(app).get("/system/status").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.publicSpectateEnabled).toBe(true);
  });
});

describe("N5/R11 · GET /public/battles/{battleId} (capability apagada, por defecto)", () => {
  it("responde 404 aunque la batalla exista y esté en directo (no revela ni enabled:false)", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: false });
    const battleId = await seedRunningBattle();
    const res = await request(app).get(`/public/battles/${battleId}`); // sin Authorization
    expect(res.status).toBe(404);
  });
});

describe("N5/R11 · GET /public/battles/{battleId} (capability encendida)", () => {
  it("expone la batalla en directo SOLO con campos públicos, sin cuenta", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const battleId = await seedRunningBattle();

    const res = await request(app).get(`/public/battles/${battleId}`); // sin Authorization
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(battleId);
    expect(res.body.status).toBe("running");
    expect(res.body.mode).toBe("deathmatch");
    expect(res.body.mapId).toBe("mvp-arena-01");
    expect(typeof res.body.mapName).toBe("string");
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.startedAt).toBe("string");
    expect(res.body.finishedAt).toBeUndefined();

    expect(Object.keys(res.body).sort()).toEqual(
      ["createdAt", "id", "mapId", "mapName", "mode", "status", "startedAt"].sort(),
    );

    // Ausencia explícita de campos privados/sensibles.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("top-secret-seed-should-never-leak");
    expect(raw).not.toContain("commit-should-never-leak");
    for (const forbidden of [
      "seed",
      "seedCommitment",
      "seedRevealProof",
      "participants",
      "result",
      "ticket",
      "token",
      "createdBy",
      "owner",
    ]) {
      expect(res.body[forbidden]).toBeUndefined();
    }
  });

  it("responde 404 si la batalla existe pero no está en directo (scheduled/finished)", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const [scheduled] = await h
      .db("battles")
      .insert({
        status: "scheduled",
        official: false,
        mode: "deathmatch",
        ruleset_id: rulesetId,
        map_id: "mvp-arena-01",
        map_version: 1,
      })
      .returning("id");
    const [finished] = await h
      .db("battles")
      .insert({
        status: "finished",
        official: false,
        mode: "deathmatch",
        ruleset_id: rulesetId,
        map_id: "mvp-arena-01",
        map_version: 1,
        finished_at: h.db.fn.now(),
      })
      .returning("id");

    const resScheduled = await request(app).get(`/public/battles/${scheduled.id}`);
    expect(resScheduled.status).toBe(404);
    const resFinished = await request(app).get(`/public/battles/${finished.id}`);
    expect(resFinished.status).toBe(404);
  });

  it("responde 404 para un id inexistente", async () => {
    const app: Express = createApp({ db: h.db, publicSpectateEnabled: true });
    const res = await request(app).get("/public/battles/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

/**
 * N5/R13.2-style · REGRESSION LOCK — GET /public/battles/{battleId} SIN cuota
 * anónima sería el mismo vector de scraping/DoS que ya se cerró para el
 * listado (R13.2): un visitante podría barrer ids sin límite ni registro.
 * Misma cuota anónima (T7.5), route propia ("public-battle") para no compartir
 * presupuesto con el listado.
 */
describe("N5/R11 · GET /public/battles/{battleId} respeta la cuota anónima (candado de no-regresión)", () => {
  it("corta con 429 al superar la cuota y registra el consumo en api_usage", async () => {
    await h.db("api_usage").where({ route: "public-battle" }).delete();
    const battleId = await seedRunningBattle();
    const strict = createApp({
      db: h.db,
      publicSpectateEnabled: true,
      anonQuota: { max: 3, windowMs: 3600_000 },
    });
    for (let i = 0; i < 3; i++) {
      const ok = await request(strict).get(`/public/battles/${battleId}`);
      expect(ok.status).toBe(200);
    }
    const blocked = await request(strict).get(`/public/battles/${battleId}`);
    expect(blocked.status).toBe(429);

    const usage = await h.db("api_usage").where({ route: "public-battle" }).first();
    expect(usage).toBeTruthy();
    expect(Number(usage.count)).toBeGreaterThanOrEqual(4);

    // Un usuario autenticado no consume cuota anónima.
    const dev = await tokenFor(h.db, DEV_USERS.developer);
    const authd = await request(strict).get(`/public/battles/${battleId}`).set("Authorization", `Bearer ${dev}`);
    expect(authd.status).toBe(200);
  });
});

/**
 * R13.2 · REGRESSION LOCK — /public/battles/live SIN cuota anónima era un
 * vector de scraping/DoS barato: cualquier visitante podía barrer el listado
 * sin límite ni registro. Igual que el resto de rutas públicas (spectate-ticket,
 * replay, replay-verify), ahora pasa por `anonQuota` (T7.5): 429 al superarla
 * y el consumo queda en `api_usage`. Estilo del candado: public-api.test.ts:247-273.
 */
describe("R13.2 · GET /public/battles/live respeta la cuota anónima (candado de no-regresión)", () => {
  it("corta con 429 al superar la cuota y registra el consumo en api_usage", async () => {
    await h.db("api_usage").where({ route: "public-live" }).delete();
    const strict = createApp({
      db: h.db,
      publicSpectateEnabled: true,
      anonQuota: { max: 3, windowMs: 3600_000 },
    });
    for (let i = 0; i < 3; i++) {
      const ok = await request(strict).get("/public/battles/live");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(strict).get("/public/battles/live");
    expect(blocked.status).toBe(429);

    const usage = await h.db("api_usage").where({ route: "public-live" }).first();
    expect(usage).toBeTruthy();
    expect(Number(usage.count)).toBeGreaterThanOrEqual(4);

    // Un usuario autenticado no consume cuota anónima.
    const dev = await tokenFor(h.db, DEV_USERS.developer);
    const authd = await request(strict).get("/public/battles/live").set("Authorization", `Bearer ${dev}`);
    expect(authd.status).toBe(200);
  });
});
