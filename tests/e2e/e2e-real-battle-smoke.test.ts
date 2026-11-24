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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { verify } from "../../apps/arena-engine/src/replay.js";
import { readS9rReplay } from "../../apps/replay-service/src/s9r/replay-file.js";
import { verifyFile } from "../../apps/replay-service/src/s9r/verify.js";
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

  it("readHarnessConfig usa la red `arena` por defecto (nombre exacto que exige compliance)", () => {
    const cfg = readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST });
    expect(cfg.arenaNetwork).toBe("arena");
    expect(cfg.arenaNetwork).not.toBe("infrastructure_arena");
    expect(cfg.arenaNetwork).not.toBe("s9-ai-arena_arena");
    expect(cfg.dockerProxyUrl).toContain("docker-proxy");
  });

  it("orquesta la batalla con runner mock, publica el replay S9R/1 a disco y es verificable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "150",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT_DIR: dir,
    });

    const { result, replay, replayPath, viewPath, verified } = await runSmokeHarness(cfg, mockRunner());

    expect(result.ticks).toBeGreaterThan(0);
    expect(result.finalStateHash).toBeTruthy();
    expect(replayPath.startsWith(dir)).toBe(true);
    expect(replayPath.endsWith(".s9r")).toBe(true);
    expect(existsSync(replayPath) && existsSync(viewPath)).toBe(true);
    expect(readFileSync(replayPath).length).toBeGreaterThan(0);
    expect(verified).toBe(true);
    const v = await verify(replay);
    expect(v.recomputedHash).toBe(result.finalStateHash);
  }, 30000);
});

/**
 * V1 REPLAYS PR-4b · sustituye a «R7 · el arnés INGESTA el replay en el replay-service» y «R7-A ·
 * modos de ingesta + listado global»: la ingesta HTTP (JSONL) está RETIRADA. Lo que se conserva:
 * el replay queda como recurso GESTIONADO (S9R/1 publicado con prueba de cierre, el formato que la
 * API sirve y lista desde la BD), es EXACTAMENTE la batalla jugada, un fichero corrupto no pasa
 * por bueno y el modo estricto falla cerrado.
 */
describe("V1 REPLAYS PR-4b · el arnés publica el replay en S9R/1 (ingesta HTTP retirada)", () => {
  it("readHarnessConfig: sin variables de ingesta (REPLAY_SERVICE_URL ya no hace nada); el estricto se mantiene", () => {
    const cfg = readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST, REPLAY_SERVICE_URL: "http://replay-service:8083" });
    expect(cfg).not.toHaveProperty("replayServiceUrl");
    expect(cfg.replayVerifyRequired).toBe(false);
    expect(readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST, REPLAY_INGEST_REQUIRED: "1" }).replayVerifyRequired).toBe(
      true,
    );
  });

  it("el replay publicado es EXACTAMENTE la batalla jugada y un byte alterado no pasa la integridad", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "120",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT_DIR: dir,
      REPLAY_VERIFY_REQUIRED: "1",
    });
    const outcome = await runSmokeHarness(cfg, mockRunner());
    expect(outcome.verified).toBe(true);
    expect(await readS9rReplay(outcome.replayPath)).toEqual(outcome.replay);
    const bytes = readFileSync(outcome.replayPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(outcome.replayPath, bytes);
    expect((await verifyFile(outcome.replayPath)).ok).toBe(false);
  }, 30000);
});
