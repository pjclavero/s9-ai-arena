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
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import express from "express";

import { verify } from "../../apps/arena-engine/src/replay.js";
import { createReplayServer } from "../../apps/replay-service/src/server.js";
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

const httpServers: Server[] = [];
afterEach(async () => {
  await Promise.all(httpServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Levanta un replay-service REAL en un puerto libre; devuelve su URL y el dir de replays. */
async function startReplayService(): Promise<{ url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "s9-replaysvc-"));
  const app = express();
  app.use(createReplayServer({ dir }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  httpServers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, dir };
}

describe("R7 · el arnés INGESTA el replay real en el replay-service", () => {
  it("readHarnessConfig lee REPLAY_SERVICE_URL (opcional)", () => {
    expect(readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST }).replayServiceUrl).toBeUndefined();
    const cfg = readHarnessConfig({ SMOKE_BOT_DIGEST: REAL_DIGEST, REPLAY_SERVICE_URL: "http://replay-service:8083" });
    expect(cfg.replayServiceUrl).toBe("http://replay-service:8083");
  });

  it("con REPLAY_SERVICE_URL, el replay queda almacenado y recuperable (recurso gestionado)", async () => {
    const svc = await startReplayService();
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "150",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT: join(dir, "replay.jsonl"),
      REPLAY_SERVICE_URL: svc.url,
    });

    const outcome = await runSmokeHarness(cfg, mockRunner());

    // Ingesta OK (201) con sha256.
    expect(outcome.ingest?.ok).toBe(true);
    expect(outcome.ingest?.status).toBe(201);
    expect((outcome.ingest?.body as { sha256?: string }).sha256).toBeTruthy();

    // El replay es recuperable por su battleId (existe GET /replays/:battleId).
    const battleId = outcome.replay.header.battleId;
    const got = await fetch(new URL(`/replays/${battleId}`, svc.url));
    expect(got.status).toBe(200);
    expect(Number(got.headers.get("content-length"))).toBeGreaterThan(0);
  }, 30000);

  it("un replay corrupto es rechazado por el servicio (no se declara ingesta OK)", async () => {
    const svc = await startReplayService();
    const res = await fetch(new URL("/replays/whatever", svc.url), {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: "esto no es un replay jsonl válido",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("R7-A · modos de ingesta + listado global", () => {
  it("modo REQUIRED con servicio caído → runSmokeHarness FALLA (resultado operativo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "120",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT: join(dir, "r.jsonl"),
      REPLAY_SERVICE_URL: "http://127.0.0.1:59998", // puerto muerto
      REPLAY_INGEST_REQUIRED: "1",
      REPLAY_INGEST_RETRIES: "1",
      REPLAY_INGEST_TIMEOUT_MS: "800",
    });
    await expect(runSmokeHarness(cfg, mockRunner())).rejects.toThrow(/REQUIRED/);
  }, 30000);

  it("modo best-effort con servicio caído → no falla; marca ingest.ok=false con intentos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "120",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT: join(dir, "r.jsonl"),
      REPLAY_SERVICE_URL: "http://127.0.0.1:59998",
      REPLAY_INGEST_RETRIES: "1",
      REPLAY_INGEST_TIMEOUT_MS: "800",
    });
    const outcome = await runSmokeHarness(cfg, mockRunner());
    expect(outcome.ingest?.ok).toBe(false);
    expect(outcome.ingest?.attempts).toBeGreaterThanOrEqual(1);
    expect(outcome.ingest?.verified).toBe(true);
  }, 30000);

  it("REPLAY_INGEST_ENABLED=0 desactiva la ingesta aunque haya URL", () => {
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      REPLAY_SERVICE_URL: "http://replay-service:8083",
      REPLAY_INGEST_ENABLED: "0",
    });
    expect(cfg.replayServiceUrl).toBeUndefined();
  });

  it("tras ingestar, GET /replays lista la batalla", async () => {
    const svc = await startReplayService();
    const dir = mkdtempSync(join(tmpdir(), "s9-smoke-"));
    const cfg = readHarnessConfig({
      SMOKE_BOT_DIGEST: REAL_DIGEST,
      ENGINE_HOST: "127.0.0.1",
      SMOKE_TICKS: "120",
      SMOKE_TIMEOUT_MS: "20000",
      REPLAY_OUT: join(dir, "r.jsonl"),
      REPLAY_SERVICE_URL: svc.url,
    });
    const outcome = await runSmokeHarness(cfg, mockRunner());
    expect(outcome.ingest?.ok).toBe(true);
    const res = await fetch(new URL("/replays", svc.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { battleId: string }[] };
    expect(body.items.some((i) => i.battleId === outcome.replay.header.battleId)).toBe(true);
  }, 30000);
});
