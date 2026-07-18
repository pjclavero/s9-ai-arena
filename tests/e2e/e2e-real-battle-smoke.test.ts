/**
 * DoD del arnés `scripts/e2e-real-battle-smoke.ts` SIN Docker real.
 *
 * Ejercita el mismo camino que usará VM108 (parseo de config + `runSmokeHarness` +
 * escritura del replay a disco) pero con un `ContainerRunner` MOCK que arranca el bot
 * EN PROCESO por WebSocket real. Confirma que el arnés produce resultado + replay
 * verificable y que la config falla cerrado sin `SMOKE_BOT_DIGEST`.
 *
 * La ejecución con contenedores reales (ProxyContainerRunner + s9-docker-proxy) es
 * opt-in (`S9_RUN_REAL_DOCKER_E2E=1`) y NO corre aquí.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { verify } from "../../apps/arena-engine/src/replay.js";
import type { ContainerHandle, ContainerRunner, SandboxSpec } from "../../apps/bot-manager/src/container-runner.js";
import { readHarnessConfig, runSmokeHarness } from "../../scripts/e2e-real-battle-smoke.js";

const REAL_DIGEST =
  "ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot@sha256:a337716702a710a5d3497c81e422ab08e07ddfab5186eb824efce9940306e6aa";

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

/** Bot en proceso que imita al contenedor (mismo protocolo que el Python real). */
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
    /* el transporte se cierra al terminar; sin ruido. */
  });
  openSockets.push(ws);
  return ws;
}

function mockRunner(): ContainerRunner {
  return {
    async launch(spec: SandboxSpec): Promise<ContainerHandle> {
      const ws = startInProcessBot(spec);
      return {
        id: `mock-${spec.botId}`,
        async stop() {
          ws.close();
        },
        async posture() {
          return { user: "10001:10001", privileged: false } as never;
        },
      };
    },
  };
}

describe("R6.2 · arnés e2e-real-battle-smoke (mock/dry-run)", () => {
  it("readHarnessConfig falla cerrado sin SMOKE_BOT_DIGEST", () => {
    expect(() => readHarnessConfig({})).toThrow(/SMOKE_BOT_DIGEST/);
  });

  it("readHarnessConfig usa infrastructure_arena por defecto (no s9-ai-arena_arena)", () => {
    const cfg = readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST });
    expect(cfg.arenaNetwork).toBe("infrastructure_arena");
    expect(cfg.arenaNetwork).not.toBe("s9-ai-arena_arena");
    expect(cfg.dockerProxyUrl).toContain("docker-proxy");
  });

  it("orquesta la batalla con runner mock, escribe replay a disco y es verificable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const replayOut = join(dir, "replay.jsonl");
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "150",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT: replayOut,
    });

    const { result, replay, replayPath } = await runSmokeHarness(cfg, mockRunner());

    expect(result.ticks).toBeGreaterThan(0);
    expect(result.finalStateHash).toBeTruthy();
    expect(replayPath).toBe(replayOut);
    expect(existsSync(replayOut)).toBe(true);
    expect(readFileSync(replayOut, "utf8").length).toBeGreaterThan(0);
    const v = await verify(replay);
    expect(v.recomputedHash).toBe(result.finalStateHash);
  }, 30000);
});
