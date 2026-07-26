/**
 * B1/B2 · DoD del entrypoint de servicio de arena-engine (service.ts).
 *
 * Sin Docker en ningún caso: `/healthz` responde 200 siempre, `/run` sin
 * runner responde 503 `runner_unavailable` (nunca ejecuta nada), y `/run` con
 * un runner FAKE inyectado corre una batalla real vía `runContainerBattle`
 * (mismo mecanismo que apps/bot-manager/tests/container-battle.test.ts) y
 * devuelve el resultado+replay.
 *
 * B2 añade: `/run` exige autenticación interna (cabecera `x-arena-engine-auth`,
 * comparada en tiempo constante contra `cfg.internalSecret`) ANTES de mirar si
 * hay runner — sin credencial válida, 401 siempre, incluso con runner cableado.
 * `network`/`engineHost` ya NO se aceptan del cuerpo de la petición: solo de
 * `cfg` (config del servicio).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { WebSocket } from "ws";
import { initPhysics } from "../src/sim/physics.js";
import { createArenaEngineService, serviceConfigFromEnv } from "../src/service.js";
import type { ContainerHandle, ContainerRunner, SandboxSpec } from "../../bot-manager/src/container-runner.js";

const REAL_DIGEST =
  "ghcr.io/pjclavero/s9-ai-arena/bot-runtime-python@sha256:a337716702a710a5d3497c81e422ab08e07ddfab5186eb824efce9940306e6aa";

beforeAll(async () => {
  await initPhysics();
});

const openSockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
});

/** Bot EN PROCESO que imita al contenedor (mismo patrón que container-battle.test.ts). */
function startInProcessBot(spec: SandboxSpec): WebSocket {
  const ws = new WebSocket(spec.env.WS_URL);
  let seq = 0;
  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        proto: "arena/1",
        type: "HELLO",
        seq: seq++,
        payload: {
          botId: spec.env.BOT_ID,
          botVersion: "0.1.0",
          sdk: { name: "custom", version: "0" },
          battleToken: spec.env.BATTLE_TOKEN,
        },
      }),
    );
  });
  ws.on("message", (raw) => {
    let msg: { type?: string; payload?: { tick?: number } };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "OBSERVATION" && typeof msg.payload?.tick === "number") {
      const forTick = msg.payload.tick + 3;
      ws.send(
        JSON.stringify({
          proto: "arena/1",
          type: "COMMAND",
          seq: seq++,
          tick: forTick,
          payload: { forTick, move: { throttle: 0.6, steer: 0.15 } },
        }),
      );
    }
  });
  ws.on("error", () => {
    /* el transporte puede cerrarse al terminar la batalla; sin ruido. */
  });
  openSockets.push(ws);
  return ws;
}

function inProcessRunner(): ContainerRunner {
  return {
    async launch(spec: SandboxSpec): Promise<ContainerHandle> {
      const ws = startInProcessBot(spec);
      return {
        id: `mock-${spec.botId}`,
        async stop() {
          ws.close();
        },
        async posture() {
          return { user: "10001:10001", privileged: false, capDropAll: true } as never;
        },
      };
    },
  };
}

const SMOKE_BOTS = [
  { botId: "bot_a", version: 1, archetype: "scout", imageDigest: REAL_DIGEST },
  { botId: "bot_b", version: 1, archetype: "gunner", imageDigest: REAL_DIGEST },
];

const SECRET = "test-internal-secret-1234567890";
const AUTH_HEADER = "x-arena-engine-auth";

function runRequestBody(battleId: string) {
  return {
    battleId,
    seed: "svc-seed",
    rulesetId: "dm_practice@1",
    ticks: 150,
    mapName: "empty",
    bots: SMOKE_BOTS,
    tickIntervalMs: 3,
    overallTimeoutMs: 20_000,
  };
}

describe("B1 · arena-engine service", () => {
  it("GET /healthz responde 200 con un JSON mínimo", async () => {
    const app = createArenaEngineService();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "arena-engine" });
  });

  it("POST /run sin runner inyectado (pero con credencial válida) responde 503 runner_unavailable (no ejecuta nada)", async () => {
    const app = createArenaEngineService({ internalSecret: SECRET, engineHost: "127.0.0.1" });
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(runRequestBody("svc_no_runner"));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("runner_unavailable");
  });

  it("POST /run con cuerpo inválido responde 400 (incluso con runner cableado y credencial válida)", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send({ battleId: "solo-esto" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("POST /run con solo 1 bot (cuerpo por lo demás válido) responde 400 (una batalla necesita >= 2 bots)", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const body = { ...runRequestBody("svc_un_solo_bot"), bots: [SMOKE_BOTS[0]] };
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("POST /run responde 502 (no 200) cuando el runner falla, sin filtrar el error interno crudo", async () => {
    const boom = new Error("fallo simulado del runner: detalle interno sensible");
    const failingRunner: ContainerRunner = {
      async launch(): Promise<ContainerHandle> {
        throw boom;
      },
    };
    const app = createArenaEngineService({ runner: failingRunner, internalSecret: SECRET, engineHost: "127.0.0.1" });
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(runRequestBody("svc_runner_falla"));

    expect(res.status).toBe(502);
    expect(res.status).not.toBe(200);
    expect(res.body.error).toBe("battle_failed");
    // El mensaje de error se expone (es el propio mensaje del Error, no un stack
    // ni detalles de infraestructura), pero la respuesta NUNCA es 200 con un
    // resultado inventado: el body no debe traer campos de resultado de batalla.
    expect(res.body.result).toBeUndefined();
    expect(res.body.replay).toBeUndefined();
  });

  it("POST /run con un runner FAKE inyectado ejecuta runContainerBattle y devuelve el resultado", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app)
      .post("/run")
      .set(AUTH_HEADER, SECRET)
      .send(runRequestBody("svc_" + Date.now()));

    expect(res.status).toBe(200);
    expect(res.body.result.ticks).toBeGreaterThan(0);
    expect(res.body.result.finalStateHash).toBeTruthy();
    expect(res.body.replay.result.finalStateHash).toBe(res.body.result.finalStateHash);
    expect(Object.keys(res.body.postures).sort()).toEqual(["bot_a", "bot_b"]);
  }, 30_000);
});

describe("B2 · autenticación interna de POST /run", () => {
  it("sin cabecera de credencial → 401, aunque el runner esté cableado y el cuerpo sea válido", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app).post("/run").send(runRequestBody("svc_sin_credencial"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("con credencial incorrecta → 401 (no ejecuta la batalla)", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app)
      .post("/run")
      .set(AUTH_HEADER, "credencial-equivocada")
      .send(runRequestBody("svc_credencial_mala"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("con credencial incorrecta de LA MISMA LONGITUD que el secreto → 401 (guarda contra comparar contra sí mismo)", async () => {
    // Regresión del supervisor: mutar timingSafeEqual(a, b) → timingSafeEqual(a, a) aceptaría
    // CUALQUIER credencial de igual longitud que SECRET. El test de "credencial incorrecta"
    // de arriba usa una cadena de longitud DISTINTA y no lo habría detectado.
    const sameLengthWrong = SECRET.split("").reverse().join(""); // misma longitud, contenido distinto
    expect(sameLengthWrong.length).toBe(SECRET.length);
    expect(sameLengthWrong).not.toBe(SECRET);
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app)
      .post("/run")
      .set(AUTH_HEADER, sameLengthWrong)
      .send(runRequestBody("svc_credencial_mala_misma_longitud"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("sin credencial Y con cuerpo inválido → 401 (la auth se comprueba ANTES que el cuerpo, nunca 400)", async () => {
    // Regresión del supervisor: si el orden se invirtiera (cuerpo antes que credencial), quien
    // no tiene credencial podría distinguir 400 (cuerpo mal formado) de 401/503 (cuerpo bien
    // formado) — una fuga de forma del contrato a un caller no autenticado.
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const res = await request(app).post("/run").send({ esto: "no es un cuerpo válido de /run" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(res.status).not.toBe(400);
  });

  it("sin secreto configurado en el servicio (cfg.internalSecret ausente) → 401 SIEMPRE, incluso con runner cableado", async () => {
    const app = createArenaEngineService({ runner: inProcessRunner(), engineHost: "127.0.0.1" });
    const res = await request(app)
      .post("/run")
      .set(AUTH_HEADER, "cualquier-cosa")
      .send(runRequestBody("svc_sin_secreto_cfg"));
    expect(res.status).toBe(401);
  });

  it("el cuerpo de la petición ya NO puede sobreescribir `network`/`engineHost`: siempre salen de cfg", async () => {
    // Runner que registra la `network`/`engineHost` que le llegó vía SandboxSpec.env (WS_URL).
    let observedWsHost: string | undefined;
    const spyRunner: ContainerRunner = {
      async launch(spec) {
        observedWsHost = new URL(spec.env.WS_URL).hostname;
        const ws = startInProcessBot(spec);
        return {
          id: `mock-${spec.botId}`,
          async stop() {
            ws.close();
          },
          async posture() {
            return { user: "10001:10001", privileged: false, capDropAll: true } as never;
          },
        };
      },
    };
    const app = createArenaEngineService({ runner: spyRunner, internalSecret: SECRET, engineHost: "127.0.0.1" });
    const body = {
      ...runRequestBody("svc_sin_override_red"),
      // Un caller intentando forzar otro host/red desde el cuerpo (B2: ya no es un campo válido de TS,
      // pero verificamos en runtime que aunque llegue en el JSON crudo, se ignora).
      engineHost: "attacker-host.invalid",
      network: "red-atacante",
    };
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(body);
    expect(res.status).toBe(200);
    // El WS_URL que vio el runner usa SIEMPRE cfg.engineHost ("127.0.0.1"), nunca el del body.
    expect(observedWsHost).toBe("127.0.0.1");
  }, 30_000);

  // Mismo patrón que el hallazgo del supervisor en el launcher HTTP de la API
  // (FIXTURE_MAP_EQUIVALENTS), pero del lado de arena-engine: container-battle.ts
  // indexa `MAPS[cfg.mapName ?? "empty"]` sobre un objeto plano. Una clave
  // "envenenada" como "__proto__"/"constructor" en `mapName` podría resolver a
  // algo del prototipo en vez de `undefined`. isRunBattleRequestBody ahora
  // exige que `mapName`, si viene, sea uno de los 3 literales conocidos
  // (VALID_MAP_NAMES, un Set — no indexación de objeto), así que nunca llega a
  // container-battle.ts nada fuera de esa allowlist.
  for (const pollutedKey of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    it(`mapName="${pollutedKey}" → 400 bad_request (nunca llega a runContainerBattle)`, async () => {
      const app = createArenaEngineService({
        runner: inProcessRunner(),
        internalSecret: SECRET,
        engineHost: "127.0.0.1",
      });
      const body = { ...runRequestBody(`svc_mapname_${pollutedKey}`), mapName: pollutedKey };
      const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    });
  }

  it("mapName ausente sigue admitiéndose (opcional; container-battle.ts aplica su propio default 'empty')", async () => {
    const app = createArenaEngineService({
      runner: inProcessRunner(),
      internalSecret: SECRET,
      engineHost: "127.0.0.1",
    });
    const body = runRequestBody("svc_mapname_ausente");
    delete (body as { mapName?: string }).mapName;
    const res = await request(app).post("/run").set(AUTH_HEADER, SECRET).send(body);
    expect(res.status).toBe(200);
  }, 30_000);
});

describe("B2 · serviceConfigFromEnv (gateado por entorno)", () => {
  it("sin DOCKER_PROXY_URL, NO se instancia ningún runner (sigue en 503 aunque se despliegue)", () => {
    const cfg = serviceConfigFromEnv({});
    expect(cfg.runner).toBeUndefined();
  });

  it("con DOCKER_PROXY_URL presente, se instancia el runner (ProxyContainerRunner)", () => {
    const cfg = serviceConfigFromEnv({ DOCKER_PROXY_URL: "http://docker-proxy.internal:2375" });
    expect(cfg.runner).toBeDefined();
  });

  it("DOCKER_PROXY_URL vacío ('') se trata como NO configurado (sin runner)", () => {
    const cfg = serviceConfigFromEnv({ DOCKER_PROXY_URL: "" });
    expect(cfg.runner).toBeUndefined();
  });

  it("DOCKER_PROXY_URL mal formado (no es una URL) se trata como NO configurado, no lanza y no instancia el runner", () => {
    const cfg = serviceConfigFromEnv({ DOCKER_PROXY_URL: "esto-no-es-una-url" });
    expect(cfg.runner).toBeUndefined();
  });

  it("DOCKER_PROXY_URL con un esquema que no es http(s) (p. ej. ftp://) se trata como NO configurado", () => {
    const cfg = serviceConfigFromEnv({ DOCKER_PROXY_URL: "ftp://docker-proxy.internal:2375" });
    expect(cfg.runner).toBeUndefined();
  });

  it("DOCKER_PROXY_URL https:// también es válido (además de http://)", () => {
    const cfg = serviceConfigFromEnv({ DOCKER_PROXY_URL: "https://docker-proxy.internal:2376" });
    expect(cfg.runner).toBeDefined();
  });

  it("internalSecret se resuelve de ARENA_ENGINE_INTERNAL_SECRET (variable en claro, precedencia menor que _FILE)", () => {
    const cfg = serviceConfigFromEnv({ ARENA_ENGINE_INTERNAL_SECRET: "abc123" });
    expect(cfg.internalSecret).toBe("abc123");
  });

  it("sin ningún secreto en el entorno, internalSecret queda undefined (fail closed: /run rechazará todo)", () => {
    const cfg = serviceConfigFromEnv({});
    expect(cfg.internalSecret).toBeUndefined();
  });

  it("network/engineHost por defecto quedan indefinidos (createArenaEngineService aplica sus propios defaults 'arena'/'arena-engine')", () => {
    const cfg = serviceConfigFromEnv({});
    expect(cfg.network).toBeUndefined();
    expect(cfg.engineHost).toBeUndefined();
  });
});
