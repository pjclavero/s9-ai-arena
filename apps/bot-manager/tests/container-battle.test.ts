/**
 * R6.2 · DoD del orquestador de batalla-en-contenedores (container-battle.ts).
 *
 * Estrategia SIN Docker (para CI): un `ContainerRunner` mock cuyo `launch()` arranca
 * un bot EN PROCESO que conecta por WebSocket REAL (paquete `ws`) al ProtocolServer y
 * juega el protocolo arena/1 — exactamente lo que hará el contenedor Python en VM108,
 * pero sin contenedor. Se ejercita la orquestación completa: Battle real, protocolo
 * real, resultado real y replay verificable bit a bit con `verify()`.
 *
 * Además, tests de SEGURIDAD que NO requieren Docker: el `SandboxSpec` se traduce a un
 * `create` que el docker-proxy ADMITE, y cualquier manipulación peligrosa (privileged,
 * red del host) se RECHAZA. Y un test de LIMPIEZA: si un bot no arranca, los
 * contenedores ya lanzados se paran (no quedan colgados).
 *
 * La ejecución con contenedores REALES (ProxyContainerRunner + s9-docker-proxy) es un
 * paso de VM108, gateado aparte.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { verify } from "../../arena-engine/src/replay.js";
import {
  DEFAULT_LIMITS,
  type ContainerHandle,
  type ContainerRunner,
  type SandboxSpec,
} from "../src/container-runner.js";
import { ProxyContainerRunner, createBodyViolations } from "../src/docker-proxy.js";
import { runContainerBattle, type ContainerBattleBot } from "../src/container-battle.js";

// Digest REAL del runtime python fijado en runtimes/DIGESTS.lock (no placeholder).
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

/**
 * Bot EN PROCESO que imita al contenedor: conecta por WS a spec.env.WS_URL, hace HELLO
 * con BATTLE_TOKEN y responde a cada OBSERVATION con un COMMAND válido (move) para el
 * tick correcto (forTick = tick + DECISION_EVERY_N_TICKS = tick + 3).
 */
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

/** Runner mock: cada `launch` arranca un bot en proceso; `stop` cierra su socket. */
function inProcessRunner(): { runner: ContainerRunner; stopped: string[] } {
  const stopped: string[] = [];
  const runner: ContainerRunner = {
    async launch(spec: SandboxSpec): Promise<ContainerHandle> {
      const ws = startInProcessBot(spec);
      return {
        id: `mock-${spec.botId}`,
        async stop() {
          stopped.push(spec.botId);
          ws.close();
        },
        async posture() {
          return { user: "10001:10001", privileged: false, capDropAll: true } as never;
        },
      };
    },
  };
  return { runner, stopped };
}

const SMOKE_BOTS: ContainerBattleBot[] = [
  { botId: "bot_a", version: 1, archetype: "scout", imageDigest: REAL_DIGEST },
  { botId: "bot_b", version: 1, archetype: "gunner", imageDigest: REAL_DIGEST },
];

function specFixture(): SandboxSpec {
  return {
    imageDigest: REAL_DIGEST,
    botId: "bot_a",
    version: 1,
    battleId: "b1",
    network: "arena",
    engineEndpoint: "ws://engine:12345",
    env: { WS_URL: "ws://engine:12345", BATTLE_TOKEN: "token-abc", BOT_ID: "bot_a" },
    limits: DEFAULT_LIMITS,
    seccompProfilePath: "/etc/seccomp/bot.json",
  };
}

describe("R6.2 · orquestador de batalla-en-contenedores", () => {
  it("corre una batalla REAL con bots 'containerizados' (mock) y genera un replay verificable", async () => {
    const { runner, stopped } = inProcessRunner();
    const { result, replay, postures } = await runContainerBattle({
      battleId: "cbtest_" + Date.now(),
      seed: "smoke-seed",
      rulesetId: "dm_practice@1",
      ticks: 150,
      mapName: "empty",
      bots: SMOKE_BOTS,
      runner,
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 3,
      overallTimeoutMs: 20_000,
    });

    // La batalla avanzó ticks reales y terminó por condición válida.
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.finalStateHash).toBeTruthy();
    // Replay real de ESTA ejecución, reproducible bit a bit (mismo mecanismo que E2).
    expect(replay.commands.length).toBeGreaterThan(0);
    expect(replay.result.finalStateHash).toBe(result.finalStateHash);
    const v = await verify(replay);
    expect(v.recomputedHash).toBe(result.finalStateHash);
    // Postura inspeccionada de cada contenedor.
    expect(Object.keys(postures).sort()).toEqual(["bot_a", "bot_b"]);
    // Limpieza: los dos contenedores se pararon.
    expect(stopped.sort()).toEqual(["bot_a", "bot_b"]);
  }, 30_000);

  it("el SandboxSpec se traduce a un create que el docker-proxy ADMITE (postura conforme)", () => {
    const body = ProxyContainerRunner.buildCreateBody(specFixture());
    expect(createBodyViolations(body)).toEqual([]);
  });

  it("el docker-proxy RECHAZA un create manipulado (privileged / red del host)", () => {
    const good = ProxyContainerRunner.buildCreateBody(specFixture());
    const hc = good.HostConfig as Record<string, unknown>;
    const privileged = { ...good, HostConfig: { ...hc, Privileged: true } };
    expect(createBodyViolations(privileged).length).toBeGreaterThan(0);
    const hostNet = { ...good, HostConfig: { ...hc, NetworkMode: "host" } };
    expect(createBodyViolations(hostNet).length).toBeGreaterThan(0);
  });

  it("si un bot no arranca, limpia los contenedores ya lanzados (no deja colgados)", async () => {
    const stopped: string[] = [];
    let launches = 0;
    const runner: ContainerRunner = {
      async launch(spec: SandboxSpec): Promise<ContainerHandle> {
        launches++;
        if (launches === 2) throw new Error("fallo simulado de arranque del contenedor");
        return {
          id: `c-${spec.botId}`,
          async stop() {
            stopped.push(spec.botId);
          },
          async posture() {
            return {} as never;
          },
        };
      },
    };

    await expect(
      runContainerBattle({
        battleId: "cbtest_fail_" + Date.now(),
        seed: "fail-seed",
        rulesetId: "dm_practice@1",
        ticks: 60,
        mapName: "empty",
        bots: SMOKE_BOTS,
        runner,
        network: "arena",
        engineHost: "127.0.0.1",
        tickIntervalMs: 3,
      }),
    ).rejects.toThrow(/fallo simulado/);

    // El primer contenedor (bot_a) se lanzó y DEBE haberse parado en la limpieza.
    expect(stopped).toContain("bot_a");
  }, 20_000);
});
