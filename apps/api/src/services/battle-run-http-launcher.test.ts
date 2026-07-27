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
import {
  createHttpBattleRunLauncher,
  httpBattleRunLauncherEnvConfig,
  replayIngestEnvConfig,
} from "./battle-run-http-launcher.js";
import type { BattleRunInput } from "../battle-run.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { record, toJsonl, type Replay } from "../../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../../arena-engine/src/stubs.js";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayServer } from "../../../replay-service/src/server.js";
import { listReplays, replayPath } from "../../../replay-service/src/store.js";

let h: TestDbHandle;
let adminId: string;
let catalogVersion: string;
const REAL_HASH = "sha256:" + "cd".repeat(32);

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  adminId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  // B6 · las pruebas de ingesta del replay usan batallas REALES (`record()`, motor
  // de E2): initPhysics() es requisito de Battle.create para el runtime WASM.
  await initPhysics();
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

/**
 * B6 · Batalla REAL corta grabada con el motor (misma técnica que
 * apps/replay-service/tests/replay-service.test.ts): un replay sintético no
 * encontraría bugs de verify()/serialización — este SÍ es el objeto real que
 * arena-engine devolvería en `ContainerBattleOutcome.replay`.
 */
async function recordRealReplay(battleId: string): Promise<Replay> {
  return record(
    {
      battleId,
      seed: battleId,
      ruleset: (await import("../../../../packages/game-rules/index.js")).loadRuleset("dm_practice@1", {
        timeLimitTicks: 60,
      }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
}

/** B6 · Servidor HTTP fake que hace de replay-service: solo entiende POST /replays/:id. */
function startFakeReplayService(handler: (battleId: string, ndjson: string) => { status: number; body: unknown }) {
  const received: { battleId: string; ndjson: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/replays\/([^/?]+)/.exec(req.url ?? "");
      const battleId = m ? decodeURIComponent(m[1]) : "";
      const ndjson = Buffer.concat(chunks).toString("utf8");
      received.push({ battleId, ndjson });
      const { status, body } = handler(battleId, ndjson);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

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
  it("200 de arena-engine → BattleRunResult completed, con la credencial correcta y mapName='mvp' (equivalente real de mvp-arena-01 v1)", async () => {
    let receivedAuth: string | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const engine = await startFakeEngine((req, rawBody) => {
      receivedAuth = req.headers["x-arena-engine-auth"] as string | undefined;
      receivedBody = JSON.parse(rawBody);
      return { status: 200, body: { result: { ticks: 10 }, replay: {}, postures: {} } };
    });
    closeEngine = engine.close;

    const bot = await seedSignedBot("bot_http_ok");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "sekret-123", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(receivedAuth).toBe("sekret-123");
    expect(receivedBody?.mapName).toBe("mvp");
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

describe("B2 · fidelidad del mapa (revisión del supervisor: falla cerrado, no sustituye en silencio)", () => {
  it("mapId sin fixture equivalente → failed SIN llamar a arena-engine (nadie escuchando en ese puerto y aun así no se cuelga ni lanza)", async () => {
    const bot = await seedSignedBot("bot_map_desconocido");
    // Puerto sin nada escuchando: si el launcher intentara llamar a arena-engine
    // pese al mapa no soportado, este test fallaría por timeout/conexión, no por
    // el mensaje esperado — confirmando así que el rechazo ocurre ANTES de la llamada HTTP.
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const input = { ...sampleInput([bot, bot]), mapId: "un-mapa-que-no-existe-en-fixtures", mapVersion: 1 };

    const result = await launcher.launch(input);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("mapa no soportado");
    expect(result.error).toContain("un-mapa-que-no-existe-en-fixtures");
  });

  it("mapId conocido pero mapVersion distinta (mvp-arena-01 v2, aún no existe fixture) → failed, no se sustituye por v1 en silencio", async () => {
    const bot = await seedSignedBot("bot_map_version_distinta");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const input = { ...sampleInput([bot, bot]), mapId: "mvp-arena-01", mapVersion: 2 };

    const result = await launcher.launch(input);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("mapa no soportado");
    expect(result.error).toContain("mvp-arena-01 v2");
  });

  it("mvp-arena-01 v1 (el único con fixture equivalente) SÍ se ejecuta con normalidad", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: {}, replay: {}, postures: {} },
    }));
    closeEngine = engine.close;

    const bot = await seedSignedBot("bot_map_soportado");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const input = { ...sampleInput([bot, bot]), mapId: "mvp-arena-01", mapVersion: 1 };

    const result = await launcher.launch(input);

    expect(result.status).toBe("completed");
  });
});

describe("B2 · fidelidad del mapa: hallazgo del supervisor (indexación de objeto plano / prototype pollution)", () => {
  // mapId = "__proto__"/"constructor"/"toString" con mapVersion ausente: en un objeto
  // plano indexado directamente (`FIXTURE_MAP_EQUIVALENTS[input.mapId]`), esto resolvía a
  // algo truthy heredado de Object.prototype, y `fixture.mapVersion === undefined` no se
  // distinguía de `input.mapVersion === undefined` (`undefined !== undefined` es `false`):
  // la guarda no rechazaba, y aguas abajo se jugaba el fixture por defecto EN SILENCIO.
  // FIXTURE_MAP_EQUIVALENTS ahora es un Map (sin prototipo indexable por string) y además
  // se exige que mapVersion sea un entero ANTES de mirar el mapa: dos capas independientes.
  for (const pollutedKey of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`mapId="${pollutedKey}" con mapVersion ausente (undefined) → failed, NUNCA se juega un fixture por defecto`, async () => {
      const bot = await seedSignedBot(`bot_map_${pollutedKey.replace(/[^a-z]/gi, "")}`);
      // Puerto sin nada escuchando: si el hueco reapareciera y el launcher llamase a
      // arena-engine, este test fallaría por timeout/conexión, no por el mensaje esperado.
      const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
      const input = {
        ...sampleInput([bot, bot]),
        mapId: pollutedKey,
        mapVersion: undefined,
      } as unknown as BattleRunInput;

      const result = await launcher.launch(input);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("mapa no soportado");
    });
  }

  it.each([undefined, null, "1", 1.5, NaN])(
    "mapVersion no-entero (%p) → failed, se rechaza ANTES de mirar el mapa",
    async (badVersion) => {
      const bot = await seedSignedBot("bot_map_version_mala");
      const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
      const input = {
        ...sampleInput([bot, bot]),
        mapId: "mvp-arena-01", // mapId VÁLIDO a propósito: el rechazo debe venir de mapVersion, no del mapId.
        mapVersion: badVersion,
      } as unknown as BattleRunInput;

      const result = await launcher.launch(input);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("mapVersion");
    },
  );
});

describe("B6 · replayIngestEnvConfig", () => {
  it("sin REPLAY_SERVICE_URL: ingesta desactivada, best-effort por defecto", () => {
    expect(replayIngestEnvConfig({})).toEqual({ replayIngestRequired: false, replayIngestTimeoutMs: 10000 });
  });

  it("con REPLAY_SERVICE_URL y REPLAY_INGEST_REQUIRED=1: ingesta activa y estricta", () => {
    expect(
      replayIngestEnvConfig({
        REPLAY_SERVICE_URL: "http://replay-service:8083",
        REPLAY_INGEST_REQUIRED: "1",
        REPLAY_INGEST_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      replayServiceUrl: "http://replay-service:8083",
      replayIngestRequired: true,
      replayIngestTimeoutMs: 5000,
    });
  });
});

/** B8 · credencial interna que el launcher debe enviar al replay-service. */
const B8_INGEST_SECRET = "secreto-de-ingesta-b8";

describe("B6 · createHttpBattleRunLauncher: ingesta del replay real en el replay-service", () => {
  let closeReplayService: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeReplayService?.();
    closeReplayService = undefined;
  });

  it("sin replayServiceUrl configurado: comportamiento IDÉNTICO a B2 (ingested:false, sin verify_matches)", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: { ticks: 10 }, replay: { header: { formatVersion: 1 } }, postures: {} },
    }));
    closeEngine = engine.close;
    const bot = await seedSignedBot("bot_b6_sin_replayservice");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));
    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: false, battleId: expect.any(String) });
  });

  it("replay REAL que verifica → se ingesta en el replay-service (POST con el JSONL correcto) y se refleja ingested:true, verify_matches:true", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: realReplay.result, replay: realReplay, postures: {} },
    }));
    closeEngine = engine.close;

    const rs = await startFakeReplayService((receivedBattleId) => {
      expect(receivedBattleId).toBe(battleId);
      return {
        status: 201,
        body: { battleId: receivedBattleId, sha256: "deadbeef", path: "/data/replays/x", official: false },
      };
    });
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_verifica_ok");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: true, battleId, verify_matches: true });
    expect(rs.received).toHaveLength(1);
    expect(rs.received[0].ndjson).toBe(toJsonl(realReplay));
  });

  it("ATAQUE DEL SUPERVISOR 1 — IDENTIDAD: un replay REAL, legítimo y perfectamente verificable, pero grabado para OTRA batalla, se rechaza SIN verificar ni ingestar", async () => {
    const requestedBattleId = "battle_" + randomUUID();
    // arena-engine (por un bug de caché, o comprometido) devuelve un replay real de
    // una batalla DISTINTA a la que se pidió lanzar — mismo escenario que demostró
    // el supervisor en vivo.
    const otherBattleReplay = await recordRealReplay("bat_sup_other_battle_entirely");
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: otherBattleReplay.result, replay: otherBattleReplay, postures: {} },
    }));
    closeEngine = engine.close;

    let replayServiceCalled = false;
    const rs = await startFakeReplayService(() => {
      replayServiceCalled = true;
      return { status: 201, body: {} };
    });
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_ataque_identidad");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId: requestedBattleId });

    expect(result.status).toBe("completed");
    // NUNCA se presenta como ingerido bajo el id solicitado, aunque el replay en sí
    // sea legítimo y verificable — es de OTRA batalla.
    expect(result.replay).toEqual({ ingested: false, battleId: requestedBattleId, verify_matches: false });
    expect(replayServiceCalled).toBe(false);
  });

  it("modo estricto + replay de otra batalla → status failed (nunca se cuela bajo un id que no es el suyo)", async () => {
    const requestedBattleId = "battle_" + randomUUID();
    const otherBattleReplay = await recordRealReplay("bat_sup_other_battle_strict");
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: otherBattleReplay.result, replay: otherBattleReplay, postures: {} },
    }));
    closeEngine = engine.close;
    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_ataque_identidad_strict");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
      replayIngestRequired: true,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId: requestedBattleId });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("REPLAY_INGEST_REQUIRED");
    expect(rs.received).toHaveLength(0);
  });

  it("ATAQUE DEL SUPERVISOR 2 — EVENTOS/SNAPSHOTS FALSIFICADOS: comandos y hashes intactos (verify() clásico diría matches:true), pero events/snapshots inventados NUNCA llegan al replay-service — se sustituyen por los recomputados", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    expect(realReplay.events.length + realReplay.snapshots.length).toBeGreaterThan(0);

    // Exactamente el ataque que demostró el supervisor: inyecta un evento falso y
    // sobrescribe TODOS los snapshots con posiciones inventadas, dejando `commands`
    // y `stateHashes`/`result.finalStateHash` intactos — así el `verify()` clásico
    // (que solo mira hashes) seguiría diciendo `matches: true`.
    const fakeEvent = { kind: "sup_fake_kill", tick: 1, vehicleId: "veh_ataque_falso" };
    const tamperedSnapshots = realReplay.snapshots.map((s: any) => ({
      ...s,
      vehicles: s.vehicles.map((v: any) => ({
        ...v,
        position: v.position ? { x: -999999, y: -999999 } : null,
      })),
    }));
    const tampered: Replay = {
      ...realReplay,
      events: [...realReplay.events, fakeEvent],
      snapshots: tamperedSnapshots,
    };
    // Comandos y hashes SIN TOCAR: el ataque solo falsifica lo que el visor pinta.
    expect(tampered.commands).toEqual(realReplay.commands);
    expect(tampered.stateHashes).toEqual(realReplay.stateHashes);
    expect(tampered.result.finalStateHash).toBe(realReplay.result.finalStateHash);

    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: tampered.result, replay: tampered, postures: {} },
    }));
    closeEngine = engine.close;

    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_ataque_eventos");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    // La batalla EN SÍ es real y verifica (comandos+hashes intactos) → se ingesta.
    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: true, battleId, verify_matches: true });
    expect(rs.received).toHaveLength(1);
    // Pero lo que se envía al replay-service es la versión HONESTA (recomputada),
    // NO la falsificada: nada del ataque llega a lo que el visor va a pintar.
    expect(rs.received[0].ndjson).not.toContain("sup_fake_kill");
    expect(rs.received[0].ndjson).not.toContain("-999999");
    expect(rs.received[0].ndjson).toBe(toJsonl(realReplay));
  });

  it("MUTACIÓN DE INTEGRIDAD: un replay que NO verifica (finalStateHash manipulado) NUNCA se presenta como ingerido ni se envía al replay-service", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    // Manipulación: el hash final oficial no coincide con lo que la re-simulación
    // de verify() recomputa a partir de los mismos comandos — exactamente el
    // escenario de un replay falsificado o corrupto.
    const tampered: Replay = {
      ...realReplay,
      result: { ...realReplay.result, finalStateHash: "sha256:tamperedtamperedtamperedtamperedtampered" },
    };
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: tampered.result, replay: tampered, postures: {} },
    }));
    closeEngine = engine.close;

    let replayServiceCalled = false;
    const rs = await startFakeReplayService(() => {
      replayServiceCalled = true;
      return { status: 201, body: {} };
    });
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_tampered");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    // Best-effort por defecto: la batalla en sí no se pierde...
    expect(result.status).toBe("completed");
    // ...pero el replay JAMÁS se presenta como válido ni ingerido.
    expect(result.replay).toEqual({ ingested: false, battleId, verify_matches: false });
    expect(replayServiceCalled).toBe(false);
  });

  it("modo estricto (replayIngestRequired) + replay que no verifica → status failed, NUNCA completed con una mentira", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const tampered: Replay = {
      ...realReplay,
      result: { ...realReplay.result, finalStateHash: "sha256:otrotamperedotrotamperedotrotampered" },
    };
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: tampered.result, replay: tampered, postures: {} },
    }));
    closeEngine = engine.close;
    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_tampered_strict");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
      replayIngestRequired: true,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("REPLAY_INGEST_REQUIRED");
    expect(rs.received).toHaveLength(0);
  });

  it("replay-service caído/rechaza (500) con replay que SÍ verifica → best-effort: completed con ingested:false, verify_matches:true", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: realReplay.result, replay: realReplay, postures: {} },
    }));
    closeEngine = engine.close;
    const rs = await startFakeReplayService(() => ({ status: 500, body: { error: "internal" } }));
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_rs_down");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: false, battleId, verify_matches: true });
  });

  it("replay-service caído + modo estricto → status failed", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: realReplay.result, replay: realReplay, postures: {} },
    }));
    closeEngine = engine.close;
    const rs = await startFakeReplayService(() => ({ status: 503, body: { error: "unavailable" } }));
    closeReplayService = rs.close;

    const bot = await seedSignedBot("bot_b6_rs_down_strict");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      // B8 · la ingesta pasa a ser autenticada: sin credencial el launcher ni lo intenta.
      replayIngestSecret: B8_INGEST_SECRET,
      replayIngestRequired: true,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("REPLAY_INGEST_REQUIRED");
  });
});

/**
 * B8 · El productor de ingesta contra el replay-service REAL, no un fake.
 *
 * Los tests de B6 usan `startFakeReplayService`, que acepta cualquier cosa: con
 * él, "el launcher manda la credencial" solo se podría comprobar mirando la
 * cabecera recibida — es decir, comparando cadenas. Aquí se monta el servidor de
 * verdad (`createReplayServer`, con su guarda de autenticación) sobre un puerto
 * efímero y se comprueba el EFECTO: si el replay acaba o no en el directorio.
 * Si el launcher dejara de mandar la credencial, o la mandara mal, el fichero no
 * aparece y el test cae — sin depender de ninguna cadena literal.
 */
describe("B8 · el launcher se autentica de verdad contra el replay-service REAL", () => {
  let closeReal: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeReal?.();
    closeReal = undefined;
  });

  /** Levanta el replay-service REAL (no un fake) en un puerto efímero. */
  async function startRealReplayService(internalSecret?: string) {
    const dir = mkdtempSync(join(tmpdir(), "b8-launcher-rs-"));
    const app = createReplayServer(internalSecret === undefined ? { dir } : { dir, internalSecret });
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    return {
      dir,
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  async function launchAgainst(rsUrl: string, ingestSecret: string | undefined, battleId: string, replay: Replay) {
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: replay.result, replay, postures: {} },
    }));
    closeEngine = engine.close;
    const bot = await seedSignedBot(`bot_b8_${randomUUID().slice(0, 8)}`);
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rsUrl,
      ...(ingestSecret === undefined ? {} : { replayIngestSecret: ingestSecret }),
    });
    return launcher.launch({ ...sampleInput([bot, bot]), battleId });
  }

  it("con la credencial correcta: el replay REAL queda escrito en el disco del servicio", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const rs = await startRealReplayService(B8_INGEST_SECRET);
    closeReal = rs.close;

    const result = await launchAgainst(rs.url, B8_INGEST_SECRET, battleId, realReplay);

    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: true, battleId, verify_matches: true });
    // EFECTO observable, no cadena: el fichero existe y el servicio lo lista.
    expect(existsSync(replayPath(rs.dir, battleId))).toBe(true);
    expect(listReplays(rs.dir, { limit: 10, order: "desc" }).map((r) => r.battleId)).toContain(battleId);
  });

  it("SIN credencial configurada: no se ingesta nada y el disco del servicio queda VACÍO", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const rs = await startRealReplayService(B8_INGEST_SECRET);
    closeReal = rs.close;

    const result = await launchAgainst(rs.url, undefined, battleId, realReplay);

    // La batalla NO se pierde (best-effort), pero jamás se afirma `ingested: true`.
    expect(result.status).toBe("completed");
    expect(result.replay?.ingested).toBe(false);
    expect(existsSync(replayPath(rs.dir, battleId))).toBe(false);
    expect(listReplays(rs.dir, { limit: 10, order: "desc" })).toHaveLength(0);
  });

  it("con credencial INCORRECTA: el servicio real responde 401 y no queda nada escrito", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const rs = await startRealReplayService(B8_INGEST_SECRET);
    closeReal = rs.close;

    const result = await launchAgainst(rs.url, B8_INGEST_SECRET + "-mal", battleId, realReplay);

    expect(result.status).toBe("completed");
    expect(result.replay?.ingested).toBe(false);
    expect(existsSync(replayPath(rs.dir, battleId))).toBe(false);
  });

  it("modo estricto + credencial incorrecta: la batalla se reporta FALLIDA, no como éxito silencioso", async () => {
    const battleId = "battle_" + randomUUID();
    const realReplay = await recordRealReplay(battleId);
    const rs = await startRealReplayService(B8_INGEST_SECRET);
    closeReal = rs.close;
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: realReplay.result, replay: realReplay, postures: {} },
    }));
    closeEngine = engine.close;
    const bot = await seedSignedBot("bot_b8_estricto");
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
      replayIngestSecret: "credencial-que-no-es",
      replayIngestRequired: true,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });
    expect(result.status).toBe("failed");
    expect(existsSync(replayPath(rs.dir, battleId))).toBe(false);
  });

  it("replayIngestEnvConfig resuelve la credencial del entorno (fichero con precedencia)", () => {
    const dir = mkdtempSync(join(tmpdir(), "b8-env-"));
    const file = join(dir, "s.txt");
    writeFileSync(file, "  del-fichero\n", "utf8");
    expect(
      replayIngestEnvConfig({
        REPLAY_SERVICE_URL: "http://x:1",
        REPLAY_INGEST_SECRET: "de-la-var",
      } as NodeJS.ProcessEnv).replayIngestSecret,
    ).toBe("de-la-var");
    expect(
      replayIngestEnvConfig({
        REPLAY_SERVICE_URL: "http://x:1",
        REPLAY_INGEST_SECRET_FILE: file,
        REPLAY_INGEST_SECRET: "de-la-var",
      } as NodeJS.ProcessEnv).replayIngestSecret,
    ).toBe("del-fichero");
    expect(replayIngestEnvConfig({} as NodeJS.ProcessEnv).replayIngestSecret).toBeUndefined();
  });
});
