/**
 * R11 · Acceso público a replay y batalla finalizada (sin cuenta):
 * GET /public/replays, GET /public/replays/{battleId},
 * GET /public/replays/{battleId}/download.
 *
 * Capability S9_PUBLIC_REPLAYS_ENABLED apagada por defecto (inyectada en tests,
 * nunca leída de process.env real aquí). Cubre: apagada→sin exposición,
 * encendida→SOLO campos públicos, batalla NO finalizada→no se expone (para eso
 * está el espectador en directo, con su propio flag), batalla inexistente→404,
 * no filtración de campos privados, y paginación/límites del listado.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { publicReplaysEnabledFromEnv } from "./public-replays.js";

let h: TestDbHandle;
let rulesetId: string;
let replayDir: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  rulesetId = (await h.db("rulesets").first()).id;
  replayDir = mkdtempSync(join(tmpdir(), "r11-replays-"));
}, 120_000);

afterAll(async () => {
  await h.stop();
  rmSync(replayDir, { recursive: true, force: true });
});

function writeReplayFile(contents: string): string {
  const path = join(replayDir, `${Math.random().toString(36).slice(2)}.replay`);
  writeFileSync(path, contents);
  return path;
}

/** Batalla `finished` con seed sensible y replay publicado. */
async function seedFinishedBattleWithReplay(overrides: Record<string, unknown> = {}) {
  const replayPath = writeReplayFile("REPLAY-BYTES-not-secret");
  const [row] = await h
    .db("battles")
    .insert({
      status: "finished",
      official: false,
      mode: "deathmatch",
      ruleset_id: rulesetId,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "top-secret-seed-should-never-leak",
      seed_commitment: "commit-should-never-leak",
      seed_reveal_proof: "reveal-proof-should-never-leak",
      result: JSON.stringify({ score: { "team-a": 3, "team-b": 1 }, ticks: 1234 }),
      replay_ref: replayPath,
      replay_hash: "irrelevant-for-this-test",
      started_at: h.db.fn.now(),
      finished_at: h.db.fn.now(),
      ...overrides,
    })
    .returning("id");
  return { battleId: row.id as string, replayPath };
}

describe("R11 · publicReplaysEnabledFromEnv (default OFF)", () => {
  it("es false cuando S9_PUBLIC_REPLAYS_ENABLED no está definida o vale distinto de 1/true", () => {
    expect(publicReplaysEnabledFromEnv({})).toBe(false);
    expect(publicReplaysEnabledFromEnv({ S9_PUBLIC_REPLAYS_ENABLED: "0" })).toBe(false);
    expect(publicReplaysEnabledFromEnv({ S9_PUBLIC_REPLAYS_ENABLED: "false" })).toBe(false);
  });

  it("es true SOLO con '1' o 'true' (case-insensitive)", () => {
    expect(publicReplaysEnabledFromEnv({ S9_PUBLIC_REPLAYS_ENABLED: "1" })).toBe(true);
    expect(publicReplaysEnabledFromEnv({ S9_PUBLIC_REPLAYS_ENABLED: "TRUE" })).toBe(true);
  });
});

describe("R11 · capability apagada (comportamiento por defecto)", () => {
  it("GET /public/replays responde 200 enabled:false, items:[] aunque haya replays publicados", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: false });
    await seedFinishedBattleWithReplay();
    const res = await request(app).get("/public/replays");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, items: [] });
  });

  it("GET /public/replays/{battleId} responde 404 aunque la batalla exista, esté finalizada y tenga replay", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: false });
    const { battleId } = await seedFinishedBattleWithReplay();
    const res = await request(app).get(`/public/replays/${battleId}`);
    expect(res.status).toBe(404);
  });

  it("GET /public/replays/{battleId}/download responde 404 con la capability apagada", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: false });
    const { battleId } = await seedFinishedBattleWithReplay();
    const res = await request(app).get(`/public/replays/${battleId}/download`);
    expect(res.status).toBe(404);
  });

  it("GET /system/status refleja publicReplaysEnabled:false", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: false });
    const admin = await tokenFor(h.db, DEV_USERS.admin);
    const res = await request(app).get("/system/status").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.publicReplaysEnabled).toBe(false);
  });
});

describe("R11 · capability encendida", () => {
  it("GET /public/replays/{battleId} expone SOLO campos públicos, sin cuenta", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const { battleId } = await seedFinishedBattleWithReplay();

    const res = await request(app).get(`/public/replays/${battleId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(battleId);
    expect(res.body.status).toBe("finished");
    expect(res.body.mode).toBe("deathmatch");
    expect(res.body.mapId).toBe("mvp-arena-01");
    expect(typeof res.body.mapName).toBe("string");
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.startedAt).toBe("string");
    expect(typeof res.body.finishedAt).toBe("string");
    expect(res.body.replayAvailable).toBe(true);
    expect(res.body.result).toEqual({ score: { "team-a": 3, "team-b": 1 }, ticks: 1234 });

    expect(Object.keys(res.body).sort()).toEqual(
      [
        "createdAt",
        "finishedAt",
        "id",
        "mapId",
        "mapName",
        "mode",
        "participants",
        "replayAvailable",
        "result",
        "startedAt",
        "status",
      ].sort(),
    );

    // Ausencia explícita de campos privados/sensibles.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("top-secret-seed-should-never-leak");
    expect(raw).not.toContain("commit-should-never-leak");
    expect(raw).not.toContain("reveal-proof-should-never-leak");
    for (const forbidden of [
      "seed",
      "seedCommitment",
      "seedRevealProof",
      "ticket",
      "token",
      "createdBy",
      "owner",
      "replayRef",
      "replayHash",
    ]) {
      expect(res.body[forbidden]).toBeUndefined();
    }
  });

  it("GET /public/replays/{battleId}/download sirve los bytes del replay", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const { battleId } = await seedFinishedBattleWithReplay();
    const res = await request(app).get(`/public/replays/${battleId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(res.body.toString()).toContain("REPLAY-BYTES-not-secret");
  });

  it("GET /public/replays lista la batalla finalizada, con paginación por cursor", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const { battleId } = await seedFinishedBattleWithReplay();
    const res = await request(app).get("/public/replays?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((b: { id: string }) => b.id === battleId)).toBe(true);
  });

  it("GET /system/status refleja publicReplaysEnabled:true", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const admin = await tokenFor(h.db, DEV_USERS.admin);
    const res = await request(app).get("/system/status").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.publicReplaysEnabled).toBe(true);
  });
});

describe("R11 · una batalla EN CURSO no se expone por esta vía", () => {
  it("scheduled/running/failed no aparecen en el listado ni son accesibles por id", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
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
    const [running] = await h
      .db("battles")
      .insert({
        status: "running",
        official: false,
        mode: "deathmatch",
        ruleset_id: rulesetId,
        map_id: "mvp-arena-01",
        map_version: 1,
        started_at: h.db.fn.now(),
      })
      .returning("id");

    const list = await request(app).get("/public/replays");
    const ids = list.body.items.map((b: { id: string }) => b.id);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(running.id);

    const resScheduled = await request(app).get(`/public/replays/${scheduled.id}`);
    expect(resScheduled.status).toBe(404);
    const resRunning = await request(app).get(`/public/replays/${running.id}`);
    expect(resRunning.status).toBe(404);
    const dlRunning = await request(app).get(`/public/replays/${running.id}/download`);
    expect(dlRunning.status).toBe(404);
  });

  it("una batalla finished SIN replay_ref tampoco es accesible por esta vía", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const [finishedNoReplay] = await h
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
    const res = await request(app).get(`/public/replays/${finishedNoReplay.id}`);
    expect(res.status).toBe(404);
  });
});

describe("R11 · batalla inexistente", () => {
  it("GET /public/replays/{battleId} responde 404 para un id inexistente", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const res = await request(app).get("/public/replays/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("GET /public/replays/{battleId}/download responde 404 para un id inexistente", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const res = await request(app).get("/public/replays/00000000-0000-0000-0000-000000000000/download");
    expect(res.status).toBe(404);
  });
});

/**
 * REGRESSION LOCK — mismo patrón que R13.2 para /public/battles/live y
 * N5/R11 para /public/battles/{battleId}: sin cuota anónima, un visitante
 * podría barrer ids o descargar replays sin límite ni registro.
 */
describe("R11 · cuota anónima (candado de no-regresión)", () => {
  it("GET /public/replays corta con 429 al superar la cuota", async () => {
    await h.db("api_usage").where({ route: "public-replays-list" }).delete();
    const strict = createApp({ db: h.db, publicReplaysEnabled: true, anonQuota: { max: 3, windowMs: 3600_000 } });
    for (let i = 0; i < 3; i++) {
      const ok = await request(strict).get("/public/replays");
      expect(ok.status).toBe(200);
    }
    const blocked = await request(strict).get("/public/replays");
    expect(blocked.status).toBe(429);
    const usage = await h.db("api_usage").where({ route: "public-replays-list" }).first();
    expect(Number(usage.count)).toBeGreaterThanOrEqual(4);
  });

  it("GET /public/replays/{battleId} corta con 429 al superar la cuota", async () => {
    await h.db("api_usage").where({ route: "public-replay" }).delete();
    const { battleId } = await seedFinishedBattleWithReplay();
    const strict = createApp({ db: h.db, publicReplaysEnabled: true, anonQuota: { max: 3, windowMs: 3600_000 } });
    for (let i = 0; i < 3; i++) {
      const ok = await request(strict).get(`/public/replays/${battleId}`);
      expect(ok.status).toBe(200);
    }
    const blocked = await request(strict).get(`/public/replays/${battleId}`);
    expect(blocked.status).toBe(429);

    // Un usuario autenticado no consume cuota anónima.
    const dev = await tokenFor(h.db, DEV_USERS.developer);
    const authd = await request(strict).get(`/public/replays/${battleId}`).set("Authorization", `Bearer ${dev}`);
    expect(authd.status).toBe(200);
  });

  it("GET /public/replays/{battleId}/download corta con 429 al superar la cuota (route propia)", async () => {
    await h.db("api_usage").where({ route: "public-replay-download" }).delete();
    const { battleId } = await seedFinishedBattleWithReplay();
    const strict = createApp({ db: h.db, publicReplaysEnabled: true, anonQuota: { max: 2, windowMs: 3600_000 } });
    for (let i = 0; i < 2; i++) {
      const ok = await request(strict).get(`/public/replays/${battleId}/download`);
      expect(ok.status).toBe(200);
    }
    const blocked = await request(strict).get(`/public/replays/${battleId}/download`);
    expect(blocked.status).toBe(429);
  });
});

describe("R11 · límites del listado", () => {
  it("respeta ?limit dentro del tope público (50), y clampa valores mayores", async () => {
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    for (let i = 0; i < 3; i++) await seedFinishedBattleWithReplay();
    const res = await request(app).get("/public/replays?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(typeof res.body.nextCursor).toBe("string");

    const page2 = await request(app).get(`/public/replays?limit=1&cursor=${res.body.nextCursor}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBe(1);
    expect(page2.body.items[0].id).not.toBe(res.body.items[0].id);
  });
});

/**
 * Huecos demostrados por el supervisor independiente de #109 con análisis de
 * mutaciones. En ambos casos el código ÍNTEGRO se comporta bien; lo que faltaba
 * era el candado, y en un bloque cuyo objetivo declarado es la no-filtración
 * dejar ciega la mitad de las rutas no es aceptable.
 */
describe("R11 · huecos cerrados tras la supervisión de #109", () => {
  it("el LISTADO también respeta la allowlist: ni un campo privado en items[]", async () => {
    // MUT-E del supervisor: filtrar `replayRef` SOLO en la rama del listado
    // (una ruta absoluta del sistema de ficheros) pasaba los 18 tests, porque la
    // aserción de allowlist existía únicamente para la ruta por id.
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const { battleId } = await seedFinishedBattleWithReplay();

    // limit=50, no 10: cuando corre este test ya hay ~12 batallas finished
    // sembradas por bloques anteriores del fichero, así que el margen era de ~2
    // filas y dependía de la resolución de `created_at` (obs. 1 del supervisor).
    const res = await request(app).get("/public/replays?limit=50");
    expect(res.status).toBe(200);
    const item = res.body.items.find((b: { id: string }) => b.id === battleId);
    expect(item, "la batalla sembrada debe aparecer en el listado").toBeTruthy();

    // Exactamente el MISMO contrato de campos que la ruta por id: el listado
    // reutiliza `publicReplayBattleToJson`, así que la allowlist es una sola y
    // vale para las dos rutas. (Yo supuse que el listado no servía `result`; el
    // código dice lo contrario, y es mejor así.)
    expect(Object.keys(item).sort()).toEqual(
      [
        "createdAt",
        "finishedAt",
        "id",
        "mapId",
        "mapName",
        "mode",
        "participants",
        "replayAvailable",
        "result",
        "startedAt",
        "status",
      ].sort(),
    );

    // Y ni rastro de lo privado en el JSON COMPLETO de la respuesta, no solo en
    // el elemento: una fuga en el sobre (cursor, metadatos) contaría igual.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("top-secret-seed-should-never-leak");
    expect(raw).not.toContain("commit-should-never-leak");
    expect(raw).not.toContain("reveal-proof-should-never-leak");
    expect(raw).not.toContain("replayRef");
    expect(raw).not.toContain("replay_ref");
    for (const forbidden of ["seed", "seedCommitment", "seedRevealProof", "replayRef", "replayHash", "owner"]) {
      expect(item[forbidden], `campo privado en el listado: ${forbidden}`).toBeUndefined();
    }
  });

  it("una batalla `running` o `failed` CON replay_ref sigue sin exponerse", async () => {
    // MUT-C del supervisor: quitar `status='finished'` del helper por id daba
    // 200 para `running` y `failed`. El test previo no lo cazaba porque sembraba
    // esos estados SIN `replay_ref`: bastaba `whereNotNull(replay_ref)` para
    // pasarlo, así que el filtro de ESTADO no tenía cobertura real. Y `failed`
    // no se sembraba en ningún sitio.
    const app: Express = createApp({ db: h.db, publicReplaysEnabled: true });
    const { battleId: running } = await seedFinishedBattleWithReplay({
      status: "running",
      finished_at: null,
      result: null,
    });
    const { battleId: failed } = await seedFinishedBattleWithReplay({ status: "failed", result: null });

    const list = await request(app).get("/public/replays?limit=50");
    const ids = list.body.items.map((b: { id: string }) => b.id);
    expect(ids, "una batalla en curso no se publica aunque ya tenga replay").not.toContain(running);
    expect(ids, "una batalla fallida no se publica aunque tenga replay").not.toContain(failed);

    for (const id of [running, failed]) {
      expect((await request(app).get(`/public/replays/${id}`)).status).toBe(404);
      expect((await request(app).get(`/public/replays/${id}/download`)).status).toBe(404);
    }
  });
});
