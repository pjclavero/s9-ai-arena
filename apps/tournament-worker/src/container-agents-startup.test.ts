/**
 * PRC · TD-034 — arranque frente a ejecución en el lanzamiento de BATALLA
 * (containerAgents), sin Docker.
 *
 * ProtocolServer, SandboxHost (descarga + `ready`) y motor REALES; el
 * contenedor lo sustituye FakeBootstrapRunner (contrato del bootstrap con
 * retardos reales). Lo que se prueba es la CLASIFICACIÓN del 19.2 con los dos
 * relojes: antes, si un bot conectaba y el otro tardaba (p. ej. Docker lento),
 * el lento perdía con `bot_crash`; ahora eso es infraestructura y se reintenta.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../bot-manager/src/sandbox-host.js";
import type { StartupTimeouts } from "../../bot-manager/src/startup-clock.js";
import { FakeBootstrapRunner, type FakeBootstrapBehaviour } from "../../bot-manager/tests/fake-bootstrap-runner.js";
import { containerAgents, type BotLaunchProvider } from "./container-agents.js";
import type { AgentDriverInput } from "./engine-executor.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";

const IMAGE = `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`;
const BOTS = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

let runners: FakeBootstrapRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.closeAll();
});
beforeAll(async () => {
  await initPhysics();
});

/** Proveedor con el SandboxHost real: ofrece el artefacto y expone sus señales. */
function provider(): BotLaunchProvider {
  return {
    async openBattle() {
      const host = await SandboxHost.start({ advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", port: 0 });
      return {
        wss: host.wss,
        port: host.port,
        async plan() {
          const offer = host.offerArtifact(Buffer.from("arena-artifact/v1\n"), "0".repeat(64));
          return {
            imageDigest: IMAGE,
            env: { ARTIFACT_URL: offer.url, ARTIFACT_TOKEN: offer.token, ARTIFACT_SHA256: offer.sha256 },
            cmd: ["-c", "bootstrap"],
            autoRemove: true,
            startup: offer.signals,
          };
        },
        close: () => host.close(),
      };
    },
  };
}

async function input(): Promise<AgentDriverInput> {
  const catalog = loadCatalog();
  const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 60 });
  const participants: Participant[] = BOTS.map((b, i) => ({
    id: b.vehicleId,
    botId: `bot_p${i}`,
    team: b.team,
    spec: resolveVehicle(ARCHETYPES.gunner, catalog),
  }));
  const engine = await Battle.create({
    battleId: `prcsbx-${Math.random().toString(16).slice(2, 10)}`,
    seed: "td034",
    ruleset,
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  return { battleId: engine.config.battleId, engine, vehicles: BOTS, ruleset, catalogVersion: CATALOG_VERSION };
}

function driver(per: (i: number) => FakeBootstrapBehaviour, timeouts: StartupTimeouts) {
  const runner = new FakeBootstrapRunner((_s, i) => per(i));
  runners.push(runner);
  return {
    runner,
    agents: containerAgents({
      runner,
      provider: provider(),
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 5,
      timeouts,
    }),
  };
}

const T = { sandboxStartupMs: 2_000, botExecutionMs: 1_000 };

describe("TD-034 · batalla: dos relojes por bot", () => {
  it("SAN-5 · un bot con plataforma lenta (≈3 s antes de `ready`) y otro rápido → la batalla se juega", async () => {
    const { agents } = driver(
      (i) => (i === 0 ? { launchDelayMs: 1000, preFetchMs: 1000, preReadyMs: 1000, userInitMs: 300 } : {}),
      { sandboxStartupMs: 10_000, botExecutionMs: 1_000 },
    );
    const out = await agents.run(await input());
    expect(out.result.ticks).toBeGreaterThan(0);
    expect(out.result.disqualified).toEqual([]);
  }, 30_000);

  it("plataforma lenta de UN bot (no llega a `ready`) mientras el otro conecta → INFRAESTRUCTURA, no bot_crash", async () => {
    const { agents } = driver((i) => (i === 1 ? { preReadyMs: 5000 } : {}), T);
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(err.code).toBe("container_unavailable");
    expect(String(err.message)).toMatch(/\[sandbox_start_timeout\]/);
    expect(String(err.message)).toContain(BOTS[1].botId);
  }, 20_000);

  it("Docker no devuelve un contenedor a tiempo → infraestructura", async () => {
    const { agents } = driver((i) => (i === 0 ? { launchDelayMs: 3000 } : {}), T);
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(String(err.message)).toMatch(/Docker no creó.*\[sandbox_start_timeout\]/);
  }, 20_000);

  it("SAN-6 · código de un bot lento tras `ready` → SportingFailure(bot_timeout) de ESE bot", async () => {
    const { agents } = driver((i) => (i === 1 ? { userInitMs: 2500 } : {}), T);
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(SportingFailure);
    expect(err.code).toBe("bot_timeout");
    expect(err.botId).toBe(BOTS[1].botId);
    expect(String(err.message)).toMatch(/\[bot_execution_timeout\]/);
  }, 20_000);

  it("el código de un bot revienta al importar → SportingFailure(bot_crash) de ESE bot", async () => {
    const { agents } = driver((i) => (i === 0 ? { crashAfterReady: true } : {}), T);
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(SportingFailure);
    expect(err.code).toBe("bot_crash");
    expect(err.botId).toBe(BOTS[0].botId);
  }, 20_000);

  it("un bot que FALSEA un informe de plataforma tras `ready` pierde él (bot_crash), no se reintenta la batalla", async () => {
    const { agents } = driver((i) => (i === 1 ? { crashAfterReady: true, crashAfterReadyKind: "fetch" } : {}), T);
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(SportingFailure);
    expect(err.code).toBe("bot_crash");
    expect(err.botId).toBe(BOTS[1].botId);
  }, 20_000);

  it("la plataforma manda: un fallo de plataforma de un bot no castiga al otro aunque éste falle", async () => {
    const { agents } = driver(
      (i) => (i === 0 ? { crashAfterReady: true } : { failBeforeReady: { kind: "fetch", detail: "HTTP 503" } }),
      T,
    );
    const err = await agents.run(await input()).catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(String(err.message)).toMatch(/\[sandbox_start_failed\] .*fetch: HTTP 503/);
  }, 20_000);
});

describe("TD-034 · SAN-4 · el worker de PRODUCCIÓN aplica los plazos configurados", () => {
  it("main.ts pasa startupTimeoutsFromEnv(process.env) al containerAgents real", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("containerAgents({"), src.indexOf("})", src.indexOf("containerAgents({")));
    // Sin comentarios: una línea comentada no cuenta como cableada.
    expect(call.replace(/\/\/.*$/gm, "")).toMatch(/timeouts:\s*startupTimeoutsFromEnv\(process\.env\)/);
  });

  it("el plazo configurado es el que se aplica en el lanzamiento de batalla", async () => {
    const { startupTimeoutsFromEnv } = await import("../../bot-manager/src/startup-clock.js");
    const timeouts = startupTimeoutsFromEnv({ SANDBOX_STARTUP_TIMEOUT_MS: "5000", BOT_EXECUTION_TIMEOUT_MS: "1234" });
    const { agents, runner } = driver((i) => (i === 1 ? { hangAfterReady: true } : {}), timeouts);
    const err = await agents.run(await input()).catch((e) => e);
    const waited = performance.now() - runner.launches[1].marks.ready;
    expect(err).toBeInstanceOf(SportingFailure);
    expect(String(err.message)).toMatch(/en 1234 ms desde que el agente estuvo listo/);
    expect(waited).toBeGreaterThanOrEqual(1200);
    expect(waited).toBeLessThan(2500);
  }, 20_000);
});
