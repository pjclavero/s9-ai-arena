/**
 * R11 · Espectador público (slice mínimo): GET /public/battles/live.
 *
 * Capability S9_PUBLIC_SPECTATE_ENABLED apagada por defecto (inyectada en tests,
 * nunca leída de process.env real aquí). Cubre: apagada→200 {enabled:false,
 * battles:[]}, encendida con batalla en directo→SOLO campos públicos (sin seed,
 * tickets ni participantes), acceso sin cuenta, y reflejo en GET /system/status.
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
