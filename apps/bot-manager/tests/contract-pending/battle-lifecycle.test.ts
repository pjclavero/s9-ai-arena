/**
 * OLA 2 · ME · CONTRATO · Equipo MF (ciclo de vida de batalla: sin contenedores ni
 * procesos tras el teardown; teardown idempotente).
 *
 * Sin Docker: un `ContainerRunner` en proceso que registra cada `launch`/`stop` y arranca
 * (o no) un bot por WebSocket real, como container-battle.test.ts. Lo que se observa es
 * el EFECTO: handles parados, puerto del motor cerrado, bucle de ticks detenido.
 *
 * Los que ya se cumplen en el BASE_SHA f07ff6f van con `it` (baseline: MF no puede
 * romperlos). Los que fallan en la base van con `contractIt("MF", …)` (= it.fails);
 * MF los activa cambiándolos a `it` en su PR (o los ve en rojo con S9_CONTRACT_ENFORCE=MF).
 * Interfaz usada: `runContainerBattle`/`ContainerRunner`/`ContainerHandle` del BASE_SHA.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { Battle } from "../../../arena-engine/src/sim/battle.js";
import { ProtocolServer } from "../../../arena-engine/src/protocol-server.js";
import { emptyArena, scoutLoadout } from "../../../arena-engine/src/fixtures.js";
import type { ContainerHandle, ContainerRunner, SandboxSpec } from "../../src/container-runner.js";
import { runContainerBattle, type ContainerBattleBot } from "../../src/container-battle.js";
import { contractIt } from "../../../arena-engine/tests/baseline/helpers.js";

const DIGEST =
  "ghcr.io/pjclavero/s9-ai-arena/bot-runtime-python@sha256:a337716702a710a5d3497c81e422ab08e07ddfab5186eb824efce9940306e6aa";
const BOTS: ContainerBattleBot[] = [
  { botId: "bot_a", version: 1, archetype: "scout", imageDigest: DIGEST },
  { botId: "bot_b", version: 1, archetype: "gunner", imageDigest: DIGEST },
];

beforeAll(async () => {
  await initPhysics();
});

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
});

function playBot(spec: SandboxSpec): WebSocket {
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
    let msg: any;
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
          payload: { forTick, move: { throttle: 0.5, steer: 0.1 } },
        }),
      );
    }
  });
  ws.on("error", () => {});
  sockets.push(ws);
  return ws;
}

interface Ledger {
  launched: string[];
  stops: Record<string, number>;
  wsUrl: string | null;
}

/** Runner instrumentado. `mode`: qué hace cada bot lanzado. */
function ledgerRunner(opts: { silentBots?: string[]; throwingStop?: string[] } = {}): {
  runner: ContainerRunner;
  ledger: Ledger;
} {
  const ledger: Ledger = { launched: [], stops: {}, wsUrl: null };
  const runner: ContainerRunner = {
    async launch(spec: SandboxSpec): Promise<ContainerHandle> {
      ledger.launched.push(spec.botId);
      ledger.wsUrl = spec.env.WS_URL;
      const ws = opts.silentBots?.includes(spec.botId) ? null : playBot(spec);
      return {
        id: `mock-${spec.botId}`,
        async stop() {
          ledger.stops[spec.botId] = (ledger.stops[spec.botId] ?? 0) + 1;
          ws?.close();
          if (opts.throwingStop?.includes(spec.botId)) throw new Error(`stop simulado falla: ${spec.botId}`);
        },
        async posture() {
          return {} as never;
        },
      };
    },
  };
  return { runner, ledger };
}

function cfg(runner: ContainerRunner, extra: Record<string, unknown> = {}) {
  return {
    battleId: "me_lifecycle_" + Date.now(),
    seed: "me-lifecycle",
    rulesetId: "dm_practice@1",
    ticks: 90,
    mapName: "empty" as const,
    bots: BOTS,
    runner,
    network: "arena",
    engineHost: "127.0.0.1",
    tickIntervalMs: 3,
    overallTimeoutMs: 8_000,
    ...extra,
  };
}

/** ¿Acepta conexiones el puerto del motor? (efecto observable, no estado interno). */
function portAccepts(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (v: boolean) => {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
      resolve(v);
    };
    ws.once("open", () => done(true));
    ws.once("error", () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

describe("MF · teardown tras una batalla normal", () => {
  it("cada contenedor lanzado se para EXACTAMENTE una vez (sin dobles stop ni olvidos)", async () => {
    const { runner, ledger } = ledgerRunner();
    await runContainerBattle(cfg(runner));
    expect(ledger.launched.sort()).toEqual(["bot_a", "bot_b"]);
    expect(ledger.stops).toEqual({ bot_a: 1, bot_b: 1 });
  }, 30_000);

  it("tras el teardown el puerto WebSocket del motor ya no acepta conexiones", async () => {
    const { runner, ledger } = ledgerRunner();
    await runContainerBattle(cfg(runner));
    expect(ledger.wsUrl).toBeTruthy();
    expect(await portAccepts(ledger.wsUrl!)).toBe(false);
  }, 30_000);
});

describe("MF · teardown cuando la batalla falla", () => {
  it("un bot que nunca hace HELLO: la batalla rechaza y TODOS los contenedores se paran una vez", async () => {
    const { runner, ledger } = ledgerRunner({ silentBots: ["bot_b"] });
    await expect(runContainerBattle(cfg(runner, { overallTimeoutMs: 2_000 }))).rejects.toThrow();
    expect(ledger.stops).toEqual({ bot_a: 1, bot_b: 1 });
    expect(await portAccepts(ledger.wsUrl!)).toBe(false);
  }, 30_000);

  it("si el stop() de un contenedor lanza, el otro se para igualmente y el puerto se cierra", async () => {
    const { runner, ledger } = ledgerRunner({ throwingStop: ["bot_a"] });
    await runContainerBattle(cfg(runner)).catch(() => undefined);
    expect(ledger.stops.bot_b).toBe(1);
    expect(await portAccepts(ledger.wsUrl!)).toBe(false);
  }, 30_000);

  contractIt(
    "MF",
    "el fallo de teardown NO se oculta: si un stop() lanza, runContainerBattle rechaza (el llamador sabe que puede quedar un contenedor vivo)",
    async () => {
      const { runner } = ledgerRunner({ throwingStop: ["bot_a"] });
      await expect(runContainerBattle(cfg(runner))).rejects.toThrow(/stop simulado falla/);
    },
    30_000,
  );
});

describe("MF · idempotencia del teardown", () => {
  async function smallBattle() {
    return Battle.create({
      battleId: "me_idem",
      seed: "me-idem",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 30 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_i1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "bot_i2", team: "blue", spec: scoutLoadout() },
      ],
    });
  }

  it("ProtocolServer.stop() dos veces no lanza y deja el puerto cerrado", async () => {
    const battle = await smallBattle();
    const server = new ProtocolServer({
      battle,
      catalogVersion: "mvp@1",
      expected: [{ botId: "bot_i1", vehicleId: "veh_1", battleToken: "t".repeat(16) }],
      port: 0,
    });
    const url = `ws://127.0.0.1:${server.port}`;
    server.stop();
    expect(() => server.stop()).not.toThrow();
    expect(await portAccepts(url)).toBe(false);
    battle.free();
  });

  contractIt("MF", "Battle.free() dos veces no lanza (teardown idempotente)", async () => {
    const battle = await smallBattle();
    battle.free();
    expect(() => battle.free()).not.toThrow();
  });
});
