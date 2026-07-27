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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { DEV_USERS, seedDev } from "../db/seeds/dev.js";
import {
  createHttpBattleRunLauncher,
  httpBattleRunLauncherEnvConfig,
  replayIngestEnvConfig,
  resolveRunTimeoutMs,
  runTimeoutEnvConfig,
} from "./battle-run-http-launcher.js";
import type { BattleRunInput } from "../battle-run.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { record, toJsonl, type Replay } from "../../../arena-engine/src/replay.js";
import { gunnerLoadout, scoutLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../../arena-engine/src/stubs.js";
import { tmpdir } from "node:os";
import { createReplayServer } from "../../../replay-service/src/server.js";
import { listReplays, replayPath } from "../../../replay-service/src/store.js";
import { validateArenaMap } from "../../../arena-engine/src/arena-map.js";
import type { ArenaMap } from "../../../arena-engine/src/sim/modes.js";
import { toEngineMap } from "../../../map-service/src/to-engine-map.js";
import type { InternalMap } from "../../../map-service/src/types.js";
import {
  containerBattleOverallTimeoutMs,
  loadRuleset,
  theoreticalBattleMs,
} from "../../../../packages/game-rules/index.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Documento REAL de mapa del repo (el mismo que publica el seed de contenido). */
function repoMap(file: string): InternalMap {
  return JSON.parse(readFileSync(join(REPO, "maps", file), "utf8"));
}

/**
 * B9 · Publica un mapa del repo en el catálogo de la BD de test. `state` y
 * `content` son parametrizables porque varios tests necesitan justo lo contrario
 * de lo normal (un borrador sin publicar, un contenido manipulado...).
 */
async function publishCatalogMap(
  doc: InternalMap,
  opts: { state?: string; content?: unknown; version?: number } = {},
): Promise<void> {
  const version = opts.version ?? doc.version;
  await h.db("maps").insert({ id: doc.mapId, name: doc.mapId }).onConflict("id").ignore();
  await h
    .db("map_versions")
    .insert({
      map_id: doc.mapId,
      version,
      state: opts.state ?? "published",
      checksum: doc.checksum,
      width_m: doc.widthM,
      height_m: doc.heightM,
      supported_modes: JSON.stringify(doc.meta?.supportedModes ?? []),
      content: JSON.stringify(opts.content ?? doc),
      published_at: h.db.fn.now(),
    })
    .onConflict(["map_id", "version"])
    .ignore();
}

/** Geometría REAL que el motor debería recibir para un mapa del repo (camino
 *  independiente del código bajo prueba: documento del repo → toEngineMap). */
function expectedEngineMap(file: string): ArenaMap {
  return toEngineMap(repoMap(file));
}

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
async function recordRealReplay(
  battleId: string,
  map: ArenaMap = expectedEngineMap("mvp-arena-01.json"),
): Promise<Replay> {
  return record(
    {
      battleId,
      seed: battleId,
      ruleset: (await import("../../../../packages/game-rules/index.js")).loadRuleset("dm_practice@1", {
        timeLimitTicks: 60,
      }),
      // B9 · el mapa por defecto es el mapa REAL del catálogo que piden estos tests
      // (`sampleInput` → mvp-arena-01 v1). Antes se grababa con `emptyArena()`: con
      // la guarda de identidad de mapa de B9, un replay grabado en otro mapa que el
      // pedido se rechaza — que es exactamente lo que debe pasar.
      map,
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
  it("200 de arena-engine → BattleRunResult completed, con la credencial correcta y el mapa REAL del catálogo en el cuerpo", async () => {
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
    expect(receivedBody?.mapName).toBeUndefined();
    expect((receivedBody?.map as ArenaMap).mapId).toBe("mvp-arena-01");
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

describe("B9 · resolución REAL del mapa contra el catálogo (ya no hay allowlist de fixtures)", () => {
  /** Captura el cuerpo que el launcher envía a `/run` y responde 200 sin replay. */
  async function launchCapturingBody(input: BattleRunInput): Promise<Record<string, unknown> | undefined> {
    let received: Record<string, unknown> | undefined;
    const engine = await startFakeEngine((_req, rawBody) => {
      received = JSON.parse(rawBody);
      return { status: 200, body: { result: {}, replay: {}, postures: {} } };
    });
    closeEngine = engine.close;
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    await launcher.launch(input);
    return received;
  }

  it("envía la GEOMETRÍA REAL del mapa publicado (no un nombre de fixture), y esa geometría es válida para el motor", async () => {
    const bot = await seedSignedBot("bot_b9_geometria");
    const body = await launchCapturingBody(sampleInput([bot, bot]));

    // Ya no viaja `mapName`: viaja el mapa entero.
    expect(body?.mapName).toBeUndefined();
    // Comportamiento, no cadenas: el mapa enviado es EXACTAMENTE el que produce el
    // pipeline real del catálogo (documento del repo → toEngineMap), muro a muro.
    expect(body?.map).toEqual(expectedEngineMap("mvp-arena-01.json"));
    // Y lo acepta el MISMO validador que aplicará arena-engine al recibirlo.
    expect(validateArenaMap(body?.map).ok).toBe(true);
    // Geometría REAL, no la fixture "mvp" (que llevaba checksum de ceros y 8 muros).
    const sent = body?.map as ArenaMap;
    expect(sent.checksum).toBe(repoMap("mvp-arena-01.json").checksum);
    expect(sent.walls.length).toBeGreaterThan(0);
  });

  it("un mapa DISTINTO del catálogo (proc-test-0, generado por E4) se juega de verdad: viaja SU geometría, no la de mvp-arena-01", async () => {
    const doc = repoMap(join("procedural", "proc-test-0.json"));
    await publishCatalogMap(doc);
    const bot = await seedSignedBot("bot_b9_otro_mapa");
    const input = { ...sampleInput([bot, bot]), mapId: doc.mapId, mapVersion: doc.version };

    const body = await launchCapturingBody(input);
    const sent = body?.map as ArenaMap;

    expect(sent.mapId).toBe("proc-test-0");
    expect(sent.checksum).toBe(doc.checksum);
    expect(sent).toEqual(toEngineMap(doc));
    // Que sea OTRO mapa de verdad: su geometría no coincide con la de mvp-arena-01.
    const mvp = expectedEngineMap("mvp-arena-01.json");
    expect(sent.walls).not.toEqual(mvp.walls);
    expect(validateArenaMap(sent).ok).toBe(true);
  });

  it("mapa inexistente en el catálogo → failed map_not_published SIN llamar a arena-engine", async () => {
    const bot = await seedSignedBot("bot_b9_inexistente");
    // Puerto sin nada escuchando: si el launcher llamara igualmente a arena-engine,
    // el fallo sería de conexión/timeout, no el código esperado.
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: "no-existe-en-el-catalogo" });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_not_published");
    expect(result.error).toContain("no-existe-en-el-catalogo");
  });

  it("mapa existente pero en borrador (no publicado) → failed map_not_published (no se juega lo que no está publicado)", async () => {
    const doc = { ...repoMap(join("procedural", "proc-test-1.json")) };
    await publishCatalogMap(doc, { state: "draft" });
    const bot = await seedSignedBot("bot_b9_draft");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: doc.mapId, mapVersion: doc.version });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_not_published");
  });

  it("versión pedida que no existe (mvp-arena-01 v2) → failed, NUNCA se juega la v1 en su lugar", async () => {
    const bot = await seedSignedBot("bot_b9_version");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: "mvp-arena-01", mapVersion: 2 });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_not_published");
    expect(result.error).toContain("v2");
  });

  it("la fila dice una versión y el documento otra → failed map_content_mismatch (fila y contenido divergen: no se adivina)", async () => {
    const doc = repoMap(join("procedural", "proc-test-2.json"));
    // Se publica como v7 pero el documento sigue diciendo v1.
    await publishCatalogMap(doc, { version: 7 });
    const bot = await seedSignedBot("bot_b9_mismatch");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: doc.mapId, mapVersion: 7 });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_content_mismatch");
  });

  it("MUTACIÓN: el documento publicado se manipula después (se mueve un muro) → failed map_checksum_mismatch, no se juega un mapa alterado", async () => {
    const doc = repoMap(join("procedural", "proc-test-3.json"));
    const tampered = JSON.parse(JSON.stringify(doc)) as InternalMap;
    // Un solo muro desplazado 3 m: geometría distinta, checksum canónico ya no cuadra.
    (tampered.layers.walls[0] as { position?: { x: number; y: number } }).position = { x: 999, y: 999 };
    await publishCatalogMap(doc, { content: tampered });
    const bot = await seedSignedBot("bot_b9_tampered");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: doc.mapId, mapVersion: doc.version });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_checksum_mismatch");
  });

  it("mapa publicado cuyo contenido no es un mapa válido de E4 → failed map_invalid (no se intenta jugar)", async () => {
    const doc = repoMap(join("procedural", "proc-test-4.json"));
    // Contenido corrupto pero con identidad correcta: sin `layers`, el validador de
    // E4 ni siquiera puede ejecutarse (lanza) — debe traducirse en rechazo, no en
    // una excepción que se escape del launcher.
    const broken = { mapId: doc.mapId, version: doc.version, checksum: doc.checksum, widthM: 120, heightM: 80 };
    await publishCatalogMap(doc, { content: broken });
    const bot = await seedSignedBot("bot_b9_invalido");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: doc.mapId, mapVersion: doc.version });

    expect(result.status).toBe("failed");
    expect(["map_invalid", "map_checksum_mismatch"]).toContain(result.errorCode);
  });

  // Séptima aparición del MISMO patrón en este repo: un identificador externo
  // (mapId) usado para buscar en un diccionario. Aquí la búsqueda va a la BD
  // parametrizada y a `Map`/`safeLookup`, nunca a `obj[clave]`, así que
  // "__proto__" es un identificador más que sencillamente no existe.
  for (const pollutedKey of ["__proto__", "constructor", "toString", "hasOwnProperty", "prototype"]) {
    it(`mapId="${pollutedKey}" → failed (nunca se juega un mapa por defecto ni se llama a arena-engine)`, async () => {
      const bot = await seedSignedBot(`bot_b9_${pollutedKey.replace(/[^a-z]/gi, "")}`);
      const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
      const result = await launcher.launch({ ...sampleInput([bot, bot]), mapId: pollutedKey });

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("map_not_published");
      expect(result.replay ?? null).toBeNull();
    });
  }

  it.each([undefined, null, "1", 1.5, NaN])(
    "mapVersion no-entero (%p) → failed bad_request, se rechaza ANTES de consultar el catálogo",
    async (badVersion) => {
      const bot = await seedSignedBot("bot_b9_version_mala");
      const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
      const input = {
        ...sampleInput([bot, bot]),
        mapId: "mvp-arena-01", // mapId VÁLIDO a propósito: el rechazo debe venir de mapVersion.
        mapVersion: badVersion,
      } as unknown as BattleRunInput;

      const result = await launcher.launch(input);

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("bad_request");
      expect(result.error).toContain("mapVersion");
    },
  );

  it("GUARDA DE IDENTIDAD: arena-engine responde 200 con una batalla jugada en OTRO mapa → failed map_identity_mismatch y el replay NO se ingesta", async () => {
    const otherDoc = repoMap(join("procedural", "proc-test-5.json"));
    await publishCatalogMap(otherDoc);
    const bot = await seedSignedBot("bot_b9_identidad");
    const battleId = "battle_" + randomUUID();
    // Replay REAL y perfectamente verificable... pero jugado en proc-test-5.
    const replay = await recordRealReplay(battleId, toEngineMap(otherDoc));

    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: replay.result, replay, postures: {} },
    }));
    closeEngine = async () => {
      await engine.close();
      await rs.close();
    };
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
    });
    // Se pide mvp-arena-01 v1 (sampleInput), pero la batalla se jugó en otro mapa.
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_identity_mismatch");
    expect(rs.received).toHaveLength(0);
  }, 30_000);

  it("ATAQUE DEL SUPERVISOR (bloqueante B9): batalla REAL en otro mapa FIRMADA con la identidad del pedido → failed y sin ingestar", async () => {
    // Reproduce el ataque exacto con el que el supervisor derribó la primera
    // versión de la guarda: el `checksum` de un ArenaMap se copia del documento
    // origen, NO se deriva de la geometría, así que un motor comprometido (o con
    // un bug de caché) puede jugar otro mapa y firmar la cabecera con el mapId,
    // versión y checksum del mapa pedido. Comparando etiquetas, esto pasaba:
    // `{"status":"completed","replay":{"ingested":true,"verify_matches":true}}`
    // con "muros pedidos vs jugados: 3 vs 6".
    const pedido = expectedEngineMap("mvp-arena-01.json");
    const otro = expectedEngineMap(join("procedural", "proc-test-7.json"));
    const falsificado = { ...otro, mapId: pedido.mapId, version: pedido.version, checksum: pedido.checksum };
    expect(falsificado.walls.length).not.toBe(pedido.walls.length); // son mapas distintos de verdad

    const bot = await seedSignedBot("bot_b9_firma_falsa");
    const battleId = "battle_" + randomUUID();
    // Batalla REAL (motor de verdad) jugada sobre la geometría falsificada: el
    // replay verifica perfectamente — lo único que falla es que no es el mapa pedido.
    const replay = await recordRealReplay(battleId, falsificado as ArenaMap);

    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: replay.result, replay, postures: {} },
    }));
    closeEngine = async () => {
      await engine.close();
      await rs.close();
    };
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_identity_mismatch");
    expect(result.replay).toEqual({ ingested: false, battleId, verify_matches: false });
    expect(rs.received).toHaveLength(0);
  }, 30_000);

  it("mismo mapa pedido con UN MURO movido en la cabecera → failed (la geometría se compara entera, no por etiqueta)", async () => {
    const pedido = expectedEngineMap("mvp-arena-01.json");
    const movido = {
      ...pedido,
      walls: pedido.walls.map((w, i) => (i === 0 ? { ...w, position: { x: w.position.x + 1, y: w.position.y } } : w)),
    };
    const bot = await seedSignedBot("bot_b9_muro_movido");
    const battleId = "battle_" + randomUUID();
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: {}, replay: { header: { formatVersion: 1, battleId, map: movido } }, postures: {} },
    }));
    closeEngine = engine.close;
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_identity_mismatch");
  });

  it("el mapa pedido, jugado de verdad, PASA la guarda (no hay falsos positivos tras una batalla real con daño a destructibles)", async () => {
    const bot = await seedSignedBot("bot_b9_sin_falso_positivo");
    const battleId = "battle_" + randomUUID();
    // Batalla real sobre el mapa REAL pedido: el motor no muta `config.map`, así
    // que la comparación completa debe aceptarla.
    const replay = await recordRealReplay(battleId);
    const rs = await startFakeReplayService(() => ({ status: 201, body: {} }));
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: replay.result, replay, postures: {} },
    }));
    closeEngine = async () => {
      await engine.close();
      await rs.close();
    };
    const launcher = createHttpBattleRunLauncher({
      engineUrl: engine.url,
      sharedSecret: "s",
      db: h.db,
      replayServiceUrl: rs.url,
    });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), battleId });

    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: true, battleId, verify_matches: true });
  }, 30_000);
});

describe("B9 · compatibilidad mapa↔modo (observación del supervisor)", () => {
  it("zone_control sobre un mapa SIN zonas de captura → failed map_mode_incompatible, sin llamar a arena-engine", async () => {
    // mvp-arena-01 solo tiene zonas de DAÑO. La API dejaba crear la batalla y el
    // fallo aparecía dentro del motor (`createMode`), como 502 genérico, después
    // de haber montado toda la partida.
    const bot = await seedSignedBot("bot_b9_zc");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mode: "zone_control" });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_mode_incompatible");
    expect(result.error).toContain("zona(s) de captura");
  });

  it("capture_the_flag sobre mvp-arena-01 (que SÍ tiene banderas y bases) se acepta", async () => {
    const bot = await seedSignedBot("bot_b9_ctf");
    let received: Record<string, unknown> | undefined;
    const engine = await startFakeEngine((_req, raw) => {
      received = JSON.parse(raw);
      return { status: 200, body: { result: {}, replay: {}, postures: {} } };
    });
    closeEngine = engine.close;
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mode: "capture_the_flag" });

    expect(result.status).toBe("completed");
    expect(loadRuleset(received?.rulesetId as string).mode).toBe("capture_the_flag");
  });
});

describe("B9 · el plazo HTTP cubre la batalla que se lanza (bloqueante del supervisor)", () => {
  // El launcher abortaba a 30 s FIJOS. Con el ruleset resuelto de verdad, una
  // práctica de deathmatch dura ticks×34 ms = 306 s (y SIEMPRE agota el límite:
  // scoreToWin=5 sin respawn con 2 vehículos). Es decir: la API abortaba SIEMPRE a
  // los 30 s con los contenedores todavía corriendo y el replay a la basura.
  it("REGRESIÓN: sin timeout explícito (el camino de producción, server.ts no lo fija), el plazo supera la duración real de la batalla", () => {
    const ticks = loadRuleset("dm_practice@1").timeLimitTicks;
    const plazo = resolveRunTimeoutMs({}, ticks);

    // Comportamiento entre módulos: el plazo del cliente HTTP debe cubrir la
    // duración teórica Y el guard global del propio motor (container-battle.ts),
    // que es quien limpia los contenedores. Ambos salen de game-rules/battle-timing.
    expect(plazo).toBeGreaterThan(theoreticalBattleMs(ticks));
    expect(plazo).toBeGreaterThan(containerBattleOverallTimeoutMs(ticks));
  });

  it("el plazo escala con los ticks de la batalla (no es una constante)", () => {
    expect(resolveRunTimeoutMs({}, 20_000)).toBeGreaterThan(resolveRunTimeoutMs({}, 1_000));
    expect(resolveRunTimeoutMs({}, 20_000) - resolveRunTimeoutMs({}, 1_000)).toBe(theoreticalBattleMs(19_000));
  });

  it("un motor LENTO pero dentro del presupuesto de la batalla NO se aborta", async () => {
    const bot = await seedSignedBot("bot_b9_lento_ok");
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: {}, replay: {}, postures: {} }));
      }, 700);
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const { port } = slow.address() as AddressInfo;
    closeEngine = () => new Promise<void>((r) => slow.close(() => r()));

    // ticks=100 → 3,4 s de batalla; margen HTTP de 400 ms ⇒ plazo ≈ 3,8 s > 700 ms.
    const launcher = createHttpBattleRunLauncher({
      engineUrl: `http://127.0.0.1:${port}`,
      sharedSecret: "s",
      db: h.db,
      ticks: 100,
      runTimeoutOverheadMs: 400,
    });
    const result = await launcher.launch(sampleInput([bot, bot]));
    expect(result.status).toBe("completed");
  }, 20_000);

  it("un motor que se pasa del presupuesto SÍ se aborta, y el mensaje dice el plazo REAL usado", async () => {
    const bot = await seedSignedBot("bot_b9_lento_ko");
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 4000);
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const { port } = slow.address() as AddressInfo;
    closeEngine = () => new Promise<void>((r) => slow.close(() => r()));

    // ticks=10 → 340 ms de batalla; margen 300 ms ⇒ plazo 640 ms < 4 s de retraso.
    const launcher = createHttpBattleRunLauncher({
      engineUrl: `http://127.0.0.1:${port}`,
      sharedSecret: "s",
      db: h.db,
      ticks: 10,
      runTimeoutOverheadMs: 300,
    });
    const result = await launcher.launch(sampleInput([bot, bot]));

    expect(result.status).toBe("failed");
    expect(result.error).toContain(String(resolveRunTimeoutMs({ runTimeoutOverheadMs: 300 }, 10)));
  }, 20_000);

  it("ARENA_ENGINE_RUN_TIMEOUT_MS: override absoluto del operador, respetado tal cual", () => {
    expect(runTimeoutEnvConfig({ ARENA_ENGINE_RUN_TIMEOUT_MS: "12345" })).toEqual({ timeoutMs: 12345 });
    expect(runTimeoutEnvConfig({})).toEqual({});
    // Valores absurdos NO se aceptan a medias: se ignoran y se usa el plazo derivado.
    expect(runTimeoutEnvConfig({ ARENA_ENGINE_RUN_TIMEOUT_MS: "0" })).toEqual({});
    expect(runTimeoutEnvConfig({ ARENA_ENGINE_RUN_TIMEOUT_MS: "abc" })).toEqual({});
  });
});

describe("B9 · resolución REAL del ruleset y de los ticks", () => {
  async function bodySentFor(input: BattleRunInput): Promise<Record<string, unknown> | undefined> {
    let received: Record<string, unknown> | undefined;
    const engine = await startFakeEngine((_req, rawBody) => {
      received = JSON.parse(rawBody);
      return { status: 200, body: { result: {}, replay: {}, postures: {} } };
    });
    closeEngine = engine.close;
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    await launcher.launch(input);
    return received;
  }

  it("REGRESIÓN (bug real de B2): el rulesetId enviado existe en el catálogo del motor y juega el modo pedido", async () => {
    const bot = await seedSignedBot("bot_b9_ruleset");
    const input = sampleInput([bot, bot]); // mode: "deathmatch"
    const body = await bodySentFor(input);

    // Comportamiento, no cadena: se CARGA con el cargador real del motor (el mismo
    // que usa runContainerBattle). Antes se enviaba "deathmatch", que hacía LANZAR
    // a loadRuleset dentro de la batalla → 502 genérico en toda batalla real.
    const ruleset = loadRuleset(body?.rulesetId as string);
    expect(ruleset.mode).toBe(input.mode);
    // Y los ticks son los del ruleset resuelto, no un número fijo del launcher.
    expect(body?.ticks).toBe(ruleset.timeLimitTicks);
  });

  it("un ruleset de BD con config.engineRulesetId manda sobre el defecto del modo", async () => {
    const rulesetId = `rs_${randomUUID().slice(0, 8)}`;
    await h.db("rulesets").insert({
      id: rulesetId,
      name: "TDM explícito",
      budget_credits: 1200,
      forbidden_categories: "[]",
      config: JSON.stringify({ engineRulesetId: "tdm_mvp@1" }),
    });
    const bot = await seedSignedBot("bot_b9_ruleset_db");
    const input = { ...sampleInput([bot, bot]), mode: "team_deathmatch", rulesetId };
    const body = await bodySentFor(input);

    expect(body?.rulesetId).toBe("tdm_mvp@1");
    expect(body?.ticks).toBe(loadRuleset("tdm_mvp@1").timeLimitTicks);
  });

  it("un ruleset de BD que apunta a reglas de OTRO modo → failed ruleset_mode_mismatch (no se cambia el modo en silencio)", async () => {
    const rulesetId = `rs_${randomUUID().slice(0, 8)}`;
    await h.db("rulesets").insert({
      id: rulesetId,
      name: "CTF colado en un deathmatch",
      budget_credits: 1200,
      forbidden_categories: "[]",
      config: JSON.stringify({ engineRulesetId: "ctf_mvp@1" }),
    });
    const bot = await seedSignedBot("bot_b9_ruleset_modo");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mode: "deathmatch", rulesetId });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("ruleset_mode_mismatch");
  });

  it("un modo sin ruleset equivalente en el motor → failed ruleset_unresolvable (nunca 'el primero de la lista')", async () => {
    const bot = await seedSignedBot("bot_b9_modo_raro");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mode: "modo_inventado" });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("ruleset_unresolvable");
  });

  it('mode="__proto__" → failed ruleset_unresolvable (el diccionario modo→ruleset es un Map, no un objeto plano)', async () => {
    const bot = await seedSignedBot("bot_b9_modo_proto");
    const launcher = createHttpBattleRunLauncher({ engineUrl: "http://127.0.0.1:1", sharedSecret: "s", db: h.db });
    const result = await launcher.launch({ ...sampleInput([bot, bot]), mode: "__proto__" });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("ruleset_unresolvable");
  });
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
      // B9 · la cabecera lleva el mapa que se pidió jugar (como hace el motor real):
      // sin él, la guarda de identidad de mapa rechaza la batalla (test siguiente).
      body: {
        result: { ticks: 10 },
        replay: { header: { formatVersion: 1, map: expectedEngineMap("mvp-arena-01.json") } },
        postures: {},
      },
    }));
    closeEngine = engine.close;
    const bot = await seedSignedBot("bot_b6_sin_replayservice");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));
    expect(result.status).toBe("completed");
    expect(result.replay).toEqual({ ingested: false, battleId: expect.any(String) });
  });

  it("B9 · 200 con cabecera de replay SIN mapa → failed: no se puede confirmar en qué mapa se jugó, así que no se da por buena", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      body: { result: { ticks: 10 }, replay: { header: { formatVersion: 1 } }, postures: {} },
    }));
    closeEngine = engine.close;
    const bot = await seedSignedBot("bot_b9_header_sin_mapa");
    const launcher = createHttpBattleRunLauncher({ engineUrl: engine.url, sharedSecret: "s", db: h.db });
    const result = await launcher.launch(sampleInput([bot, bot]));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("map_identity_mismatch");
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
