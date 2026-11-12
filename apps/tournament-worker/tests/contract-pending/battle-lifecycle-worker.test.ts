/**
 * OLA 2 · G2 · Contratos de MF verificados DONDE ESTÁ LA GARANTÍA: el tournament-worker.
 *
 * Origen: ME los escribió contra `runContainerBattle` (bot-manager, camino `/run`, gateado).
 * MF resolvió el ciclo de vida un nivel más arriba: `containerAgents` + `BattleResourceRegistry`
 * (teardown único por fases, TERM→KILL, borrado forzado, lanzamientos en vuelo, reaper).
 * Aquí se miden los MISMOS efectos con la MISMA severidad sobre esa capa, con motor,
 * ProtocolServer y SandboxHost REALES y contenedores falsos (ledger), sin Docker:
 *
 *  1. un `launch()` que nunca resuelve no cuelga la batalla (rechaza con infraestructura),
 *     lo ya lanzado se para y no queda nada;
 *  2. un `stop()` que nunca resuelve no cuelga el teardown: acaba, el contenedor se borra;
 *  3. el fallo de teardown NO se oculta: si ni parar ni borrar funcionan, el informe NO es
 *     «limpio», nombra el fallo y el recurso sigue registrado hasta que alguien lo reintenta.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../../bot-manager/src/sandbox-host.js";
import {
  LABEL_BATTLE_ID,
  type ContainerHandle,
  type ContainerRunner,
  type ManagedContainer,
  type SandboxSpec,
} from "../../../bot-manager/src/container-runner.js";
import { FakeBootstrapRunner } from "../../../bot-manager/tests/fake-bootstrap-runner.js";
import { contractIt } from "../../../../packages/test-contracts/contract-it.js";
import { containerAgents, type BotLaunchProvider } from "../../src/container-agents.js";
import type { AgentDriverInput } from "../../src/engine-executor.js";
import { BattleResourceRegistry } from "../../src/battle-resources.js";
import { InfrastructureFailure } from "../../src/errors.js";

const IMAGE = `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`;
const BOTS = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

interface Entry {
  battleId: string;
  running: boolean;
  exists: boolean;
  stops: (number | undefined)[];
}

interface Faults {
  /** Índice (orden de lanzamiento) cuyo launch() no resuelve nunca. */
  hangLaunchAt?: number;
  /** Índice cuyo stop() no resuelve nunca (ni con t=0). */
  hangStopAt?: number;
  /** Índice cuyo stop() y remove() lanzan MIENTRAS `broken.value` sea true. */
  brokenAt?: number;
}

/** Runner con ledger: qué contenedores existen/corren por battleId y cuántas veces se paró cada uno. */
class FaultyRunner implements ContainerRunner {
  readonly ledger: Entry[] = [];
  readonly inner = new FakeBootstrapRunner(() => ({ decisionMs: 10 }));
  readonly broken = { value: true };
  private n = 0;
  constructor(private readonly faults: Faults = {}) {}

  async launch(spec: SandboxSpec): Promise<ContainerHandle> {
    const i = this.n++;
    if (this.faults.hangLaunchAt === i) return new Promise<ContainerHandle>(() => {});
    const e: Entry = { battleId: spec.labels?.[LABEL_BATTLE_ID] ?? "?", running: false, exists: true, stops: [] };
    this.ledger.push(e);
    const h = await this.inner.launch(spec);
    e.running = true;
    const faults = this.faults;
    const isBroken = () => faults.brokenAt === i && this.broken.value;
    return {
      id: h.id,
      posture: () => h.posture(),
      async state() {
        const st = await h.state!();
        return st ? { ...st, running: e.running, gone: !e.exists } : null;
      },
      async stop(o) {
        e.stops.push(o?.timeoutSeconds);
        if (faults.hangStopAt === i) return new Promise<void>(() => {}); // `docker stop` colgado
        if (isBroken()) throw new Error("stop simulado falla: proxy caído");
        await h.stop();
        e.running = false;
      },
      async remove() {
        if (isBroken()) throw new Error("remove simulado falla: proxy caído");
        e.running = false;
        e.exists = false;
      },
    };
  }
  async list(labels: Record<string, string>): Promise<ManagedContainer[]> {
    return this.ledger
      .filter((e) => e.exists && e.battleId === labels[LABEL_BATTLE_ID])
      .map((e) => ({
        id: "x",
        labels: { [LABEL_BATTLE_ID]: e.battleId },
        state: e.running ? "running" : "exited",
        createdAtMs: 0,
      }));
  }
  existing(battleId: string): Entry[] {
    return this.ledger.filter((e) => e.battleId === battleId && e.exists);
  }
}

const runners: FaultyRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.inner.closeAll();
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
            autoRemove: false,
            startup: offer.signals,
          };
        },
        close: () => host.close(),
      };
    },
  };
}

async function input(battleId: string, ticks = 60): Promise<AgentDriverInput> {
  const catalog = loadCatalog();
  const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: ticks });
  const participants: Participant[] = BOTS.map((b, i) => ({
    id: b.vehicleId,
    botId: `bot_p${i}`,
    team: b.team,
    spec: resolveVehicle(ARCHETYPES.gunner, catalog),
  }));
  const engine = await Battle.create({
    battleId,
    seed: "g2-mf",
    ruleset,
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  return { battleId, engine, vehicles: BOTS, ruleset, catalogVersion: CATALOG_VERSION, owner: "w:job:1" };
}

function setup(faults: Faults = {}) {
  const runner = new FaultyRunner(faults);
  runners.push(runner);
  const resources = new BattleResourceRegistry();
  const agents = containerAgents({
    runner,
    provider: provider(),
    network: "arena",
    engineHost: "127.0.0.1",
    tickIntervalMs: 5,
    timeouts: { sandboxStartupMs: 1_500, botExecutionMs: 1_500 },
    resources,
    termGraceS: 1,
  });
  return { runner, resources, agents };
}

/** Resuelve con el resultado, o con «hung» si la promesa no termina en `ms` (nunca cuelga el test). */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<{ hung: true } | { hung: false; value: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<{ hung: true }>((r) => (timer = setTimeout(() => r({ hung: true }), ms)));
  const done = p.then(
    (value) => ({ hung: false as const, value }),
    (value) => ({ hung: false as const, value }),
  );
  try {
    return await Promise.race([done, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe("MF · reaper y límites de espera (verificados en el tournament-worker)", () => {
  // Cota: arranque de plataforma (1,5 s) + espera ACOTADA del lanzamiento en vuelo del teardown (30 s
  // fijos en container-agents). No es `overallTimeoutMs` de bot-manager: es el límite real de MF.
  const BOUND_MS = 45_000;

  contractIt(
    "MF",
    "un launch() que nunca resuelve: la batalla termina (infraestructura), lo ya lanzado se para y no queda nada registrado",
    async () => {
      const s = setup({ hangLaunchAt: 1 });
      const out = await settlesWithin(s.agents.run(await input("g2-hang-launch")), BOUND_MS);
      expect(out.hung, "run() sigue colgado tras el plazo").toBe(false);
      const err = (out as { value: unknown }).value as InfrastructureFailure;
      expect(err).toBeInstanceOf(InfrastructureFailure);
      // El contenedor ya lanzado (el 1.º) se paró y se borró.
      expect(s.runner.ledger[0]!.stops.length, "el contenedor ya lanzado no se paró").toBeGreaterThanOrEqual(1);
      expect(s.runner.existing("g2-hang-launch")).toEqual([]);
      expect(s.resources.pending("g2-hang-launch"), "recursos que siguen registrados").toEqual([]);
    },
    BOUND_MS + 15_000,
  );

  contractIt(
    "MF",
    "un stop() que nunca resuelve no cuelga el teardown: la batalla acaba, el otro contenedor se para y el colgado se borra",
    async () => {
      const s = setup({ hangStopAt: 0 });
      const out = await settlesWithin(s.agents.run(await input("g2-hang-stop")), BOUND_MS);
      expect(out.hung, "el teardown quedó esperando un stop() eterno").toBe(false);
      expect(s.runner.ledger[1]!.stops.length, "el otro contenedor no se paró").toBeGreaterThanOrEqual(1);
      expect(s.runner.existing("g2-hang-stop"), "contenedores que siguen existiendo").toEqual([]);
      expect(s.resources.pending("g2-hang-stop")).toEqual([]);
    },
    BOUND_MS + 15_000,
  );
});

describe("MF · el fallo de teardown no se oculta (verificado en el tournament-worker)", () => {
  contractIt(
    "MF",
    "si parar Y borrar un contenedor fallan, el teardown NO es «limpio»: el informe nombra el fallo y el recurso sigue registrado hasta reintentarse",
    async () => {
      const s = setup({ brokenAt: 0 });
      // La batalla (el resultado deportivo) no se pierde por un fallo de teardown de un contenedor.
      await s.agents.run(await input("g2-teardown-fail")).catch(() => undefined);
      const first = await s.resources.cleanupBattleResources("g2-teardown-fail", "FINISHED");
      expect(first.clean, "un contenedor que no se pudo parar ni borrar se dio por limpio").toBe(false);
      const failed = first.steps.filter((x) => x.outcome === "failed");
      expect(failed.length, "ningún paso de teardown informó el fallo").toBeGreaterThan(0);
      expect(failed.map((x) => x.error).join(" | ")).toMatch(/simulado falla/);
      expect(
        s.resources.pending("g2-teardown-fail").length,
        "el recurso fallido ya no está registrado",
      ).toBeGreaterThan(0);
      expect(s.runner.existing("g2-teardown-fail").length, "control: el contenedor sigue existiendo").toBe(1);
      // Reintento (lo que hace el reaper cuando el proxy se recupera): ahora sí queda todo.
      s.runner.broken.value = false;
      const retry = await s.resources.cleanupBattleResources("g2-teardown-fail", "FINISHED");
      expect(retry.clean).toBe(true);
      expect(s.runner.existing("g2-teardown-fail")).toEqual([]);
      expect(s.resources.pending("g2-teardown-fail")).toEqual([]);
    },
    60_000,
  );
});
