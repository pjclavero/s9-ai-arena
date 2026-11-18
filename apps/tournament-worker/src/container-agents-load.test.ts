/**
 * PR C · ronda 2 (P2-3) · `containerAgents` frente al muestreador de CPU, sin Docker:
 * respeta `opts.cpuSampleMs` y PARA el muestreador (stop) ANTES de la muestra final.
 * Harness de container-agents-startup.test.ts (ProtocolServer, SandboxHost y motor
 * reales; contenedor simulado). El muestreador se envuelve para registrar sus llamadas.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => ({ ctorIntervals: [] as (number | undefined)[], events: [] as string[] }));
vi.mock("./cpu-sampler.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("./cpu-sampler.js")>();
  class Spy extends m.ContainerCpuSampler {
    constructor(handles: ConstructorParameters<typeof m.ContainerCpuSampler>[0], ms?: number) {
      super(handles, ms);
      spy.ctorIntervals.push(ms);
    }
    override start() {
      spy.events.push("start");
      return super.start();
    }
    override stop() {
      spy.events.push("stop");
      super.stop();
    }
    override final() {
      spy.events.push("final");
      return super.final();
    }
  }
  return { ...m, ContainerCpuSampler: Spy };
});

import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../bot-manager/src/sandbox-host.js";
import type { ContainerHandle, SandboxSpec } from "../../bot-manager/src/container-runner.js";
import { FakeBootstrapRunner } from "../../bot-manager/tests/fake-bootstrap-runner.js";
import { containerAgents, type BotLaunchProvider } from "./container-agents.js";
import type { AgentDriverInput } from "./engine-executor.js";

const IMAGE = `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`;
const BOTS = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

const runners: FakeBootstrapRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.closeAll();
  spy.ctorIntervals.length = 0;
  spy.events.length = 0;
});
beforeAll(async () => {
  await initPhysics();
});

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
    battleId: `prcload-${Math.random().toString(16).slice(2, 10)}`,
    seed: "prc-load",
    ruleset,
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  return { battleId: engine.config.battleId, engine, vehicles: BOTS, ruleset, catalogVersion: CATALOG_VERSION };
}

/** Runner simulado cuyos handles saben medir CPU (contador creciente). */
function measuringRunner(): FakeBootstrapRunner {
  const r = new FakeBootstrapRunner(() => ({}));
  const launch = r.launch.bind(r);
  r.launch = async (spec: SandboxSpec): Promise<ContainerHandle> => {
    const h = await launch(spec);
    let n = 0;
    return Object.assign(h, { cpuMs: async () => (n += 250) });
  };
  runners.push(r);
  return r;
}

describe("containerAgents · muestreador de CPU", () => {
  it("usa opts.cpuSampleMs (N10: lo ignora) y para el muestreador ANTES de la muestra final (N11: no llama a stop)", async () => {
    const agents = containerAgents({
      runner: measuringRunner(),
      provider: provider(),
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 5,
      timeouts: { sandboxStartupMs: 5_000, botExecutionMs: 2_000 },
      cpuSampleMs: 3_000,
    });
    const out = await agents.run(await input());
    expect(out.result.ticks).toBeGreaterThan(0);
    expect(spy.ctorIntervals).toEqual([3_000]);
    expect(spy.events[0]).toBe("start");
    // El primer `stop` precede a `final`: el temporizador ya no dispara durante/tras la muestra final.
    expect(spy.events.indexOf("stop")).toBeGreaterThan(-1);
    expect(spy.events.indexOf("stop")).toBeLessThan(spy.events.indexOf("final"));
    // La medida se fija: cada bot tiene su última lectura positiva.
    for (const b of BOTS) expect(out.cpuMsByBot?.[b.botId]).toBeGreaterThan(0);
  }, 30_000);

  it("sin cpuSampleMs el muestreador recibe undefined (⇒ defecto 2000 del propio muestreador)", async () => {
    const agents = containerAgents({
      runner: measuringRunner(),
      provider: provider(),
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 5,
      timeouts: { sandboxStartupMs: 5_000, botExecutionMs: 2_000 },
    });
    await agents.run(await input());
    expect(spy.ctorIntervals).toEqual([undefined]);
  }, 30_000);
});
