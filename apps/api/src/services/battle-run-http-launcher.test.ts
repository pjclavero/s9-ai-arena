/**
 * B2 · DoD del launcher HTTP real de BattleRunLauncher (battle-run-http-launcher.ts).
 *
 * NUNCA lanza Docker: arena-engine se simula con un servidor HTTP en memoria
 * (node:http) que solo entiende la cabecera de autenticación interna, igual
 * que el servicio real (apps/arena-engine/src/service.ts) exige. Cubre:
 * traducción de éxito (200 → completed), traducción de error (503/401/500 →
 * failed sin lanzar), timeout, e inalcanzable (conexión rechazada).
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { DEV_USERS, seedDev } from "../db/seeds/dev.js";
import { createHttpBattleRunLauncher, httpBattleRunLauncherEnvConfig } from "./battle-run-http-launcher.js";
import type { BattleRunInput } from "../battle-run.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
const REAL_HASH = "sha256:" + "cd".repeat(32);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
}, 120000);
afterAll(async () => {
  await h.stop();
});

/** Siembra un bot con loadout scout (chassis.light) y una versión firmada. */
async function seedSignedBot(name: string) {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `${name}-${id.slice(0, 8)}`, owner_id: adminId });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.light@1",
    modules: JSON.stringify([]),
  });
  await h.db("bot_versions").insert({
    bot_id: id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    artifact_hash: REAL_HASH,
  });
  return { botId: id, version: 1 };
}

function sampleInput(botIds: { botId: string; version: number }[]): BattleRunInput {
  return {
    battleId: "battle_" + randomUUID(),
    mode: "deathmatch",
    mapId: "mvp-arena-01",
    mapVersion: 1,
    seed: "seed-1",
    participants: botIds.map((b, i) => ({
      botId: b.botId,
      version: b.version,
      team: i % 2 === 0 ? "red" : "blue",
      artifactHash: REAL_HASH,
    })),
  };
}

/** Servidor HTTP fake que hace de arena-engine: exige `x-arena-engine-auth`. */
function startFakeEngine(handler: (req: http.IncomingMessage, body: string) => { status: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { status, body } = handler(req, Buffer.concat(chunks).toString("utf8"));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let closeEngine: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeEngine?.();
  closeEngine = undefined;
});

describe("B2 · httpBattleRunLauncherEnvConfig", () => {
  it("null si falta ARENA_ENGINE_URL o el secreto (ninguno de los dos por separado basta)", () => {
    expect(httpBattleRunLauncherEnvConfig({})).toBeNull();
    expect(httpBattleRunLauncherEnvConfig({ ARENA_ENGINE_URL: "http://x:1" })).toBeNull();
    expect(httpBattleRunLauncherEnvConfig({ ARENA_ENGINE_SHARED_SECRET: "s" })).toBeNull();
  });

  it("presente cuando ambos están configurados", () => {
    const cfg = httpBattleRunLauncherEnvConfig({
      ARENA_ENGINE_URL: "http://arena-engine:8081",
      ARENA_ENGINE_SHARED_SECRET: "sekret",
    });
    expect(cfg).toEqual({ engineUrl: "http://arena-engine:8081", sharedSecret: "sekret" });
  });
});

describe("B2 · createHttpBattleRunLauncher", () => {
  it("200 de arena-engine → BattleRunResult completed, con la credencial correcta en la cabecera", async () => {
    let receivedAuth: string | undefined;
    const engine = await startFakeEngine((req) => {
      receivedAuth = req.headers["x-arena-engine-auth"] as string | undefined;
      return { status: 200, body: { result: { ticks: 10 }, replay: {}, postures: {} } };
    });
    closeEngine = engine.close;

    const bot = await seedSignedBot("bot_http_ok");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "sekret-123", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(receivedAuth).toBe("sekret-123");
    expect(result.status).toBe("completed");
    expect(result.runner).toBe("arena-engine-http");
    expect(result.replay).toEqual({ ingested: false, battleId: expect.any(String) });
  });

  it("503 runner_unavailable de arena-engine → BattleRunResult failed (nunca 200 inventado)", async () => {
    const engine = await startFakeEngine(() => ({
      status: 503,
      body: { error: "runner_unavailable", message: "sin runner cableado" },
    }));
    closeEngine = engine.close;

    const bot = await seedSignedBot("bot_http_503");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("sin runner cableado");
  });

  it("401 unauthorized de arena-engine (secreto no coincide en el otro extremo) → failed, mensaje sin exponer el secreto", async () => {
    const engine = await startFakeEngine(() => ({
      status: 401,
      body: { error: "unauthorized", message: "credencial interna ausente o inválida (cabecera x-arena-engine-auth)" },
    }));
    closeEngine = engine.close;

    const bot = await seedSignedBot("bot_http_401");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "secreto-que-no-debe-salir",
      db: h.db,
    });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(result.status).toBe("failed");
    expect(result.error).not.toContain("secreto-que-no-debe-salir");
  });

  it("arena-engine inalcanzable (nadie escuchando) → failed con mensaje de conexión, no lanza", async () => {
    const bot = await seedSignedBot("bot_http_unreachable");
    // Puerto que casi seguro no tiene nada escuchando en loopback.
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(result.status).toBe("failed");
    expect(result.runner).toBe("arena-engine-http");
    expect(result.error).toBeTruthy();
  });

  it("timeout: si arena-engine no responde a tiempo, failed con mensaje de timeout (no cuelga indefinidamente)", async () => {
    const engine = await startFakeEngine(() => {
      // No debería llegar aquí: el handler nunca responde antes del timeout,
      // pero para que el servidor no quede colgado en el afterEach, sí
      // devolvemos algo (llega tarde, después del abort del cliente).
      return { status: 200, body: {} };
    });
    // Servidor que retrasa la respuesta más allá del timeout del launcher.
    const slowServer = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 300);
    });
    await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", () => resolve()));
    const { port } = slowServer.address() as AddressInfo;
    closeEngine = async () => {
      await engine.close();
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    };

    const bot = await seedSignedBot("bot_http_timeout");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: `http://127.0.0.1:${port}`,
      sharedSecret: "s",
      db: h.db,
      timeoutMs: 50,
    });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no respondió");
  });
});
