/**
 * B1 · DoD del entrypoint de servicio de arena-engine (service.ts).
 *
 * Sin Docker en ningún caso: `/healthz` responde 200 siempre, `/run` sin
 * runner responde 503 `runner_unavailable` (nunca ejecuta nada), y `/run` con
 * un runner FAKE inyectado corre una batalla real vía `runContainerBattle`
 * (mismo mecanismo que apps/bot-manager/tests/container-battle.test.ts) y
 * devuelve el resultado+replay.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { WebSocket } from "ws";
import { initPhysics } from "../src/sim/physics.js";
import { createArenaEngineService } from "../src/service.js";
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
    engineHost: "127.0.0.1",
  };
}

describe("B1 · arena-engine service", () => {
  it("GET /healthz responde 200 con un JSON mínimo", async () => {
    const app = createArenaEngineService();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "arena-engine" });
  });

  it("POST /run sin runner inyectado responde 503 runner_unavailable (no ejecuta nada)", async () => {
    const app = createArenaEngineService();
    const res = await request(app).post("/run").send(runRequestBody("svc_no_runner"));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("runner_unavailable");
  });

  it("POST /run con cuerpo inválido responde 400 (incluso con runner cableado)", async () => {
    const app = createArenaEngineService({ runner: inProcessRunner() });
    const res = await request(app).post("/run").send({ battleId: "solo-esto" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
  });

  it("POST /run con solo 1 bot (cuerpo por lo demás válido) responde 400 (una batalla necesita >= 2 bots)", async () => {
    const app = createArenaEngineService({ runner: inProcessRunner() });
    const body = { ...runRequestBody("svc_un_solo_bot"), bots: [SMOKE_BOTS[0]] };
    const res = await request(app).post("/run").send(body);
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
    const app = createArenaEngineService({ runner: failingRunner });
    const res = await request(app)
      .post("/run")
      .send(runRequestBody("svc_runner_falla"));

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
    const app = createArenaEngineService({ runner: inProcessRunner() });
    const res = await request(app)
      .post("/run")
      .send(runRequestBody("svc_" + Date.now()));

    expect(res.status).toBe(200);
    expect(res.body.result.ticks).toBeGreaterThan(0);
    expect(res.body.result.finalStateHash).toBeTruthy();
    expect(res.body.replay.result.finalStateHash).toBe(res.body.result.finalStateHash);
    expect(Object.keys(res.body.postures).sort()).toEqual(["bot_a", "bot_b"]);
  }, 30_000);
});
