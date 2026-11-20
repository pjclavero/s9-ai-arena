/**
 * OLA2-MF · teardown de batalla de punta a punta SIN Docker: motor, ProtocolServer
 * y SandboxHost REALES; los contenedores los fabrica un LEDGER (registro de
 * contenedores vivos/existentes por battleId) sobre FakeBootstrapRunner. Tras
 * cada final —normal, bot crash, timeout, cancelación, error del motor, excepción
 * antes de crear todos los bots, excepción durante el teardown, runner que ignora
 * TERM, dos batallas concurrentes— se comprueba que de ESA batalla no queda nada:
 * ni contenedores (vivos o parados), ni recursos registrados, ni timers.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadRuleset, maxBattleTicks } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../bot-manager/src/sandbox-host.js";
import {
  LABEL_BATTLE_ID,
  type ContainerHandle,
  type ContainerRunner,
  type ManagedContainer,
  type SandboxSpec,
} from "../../bot-manager/src/container-runner.js";
import { FakeBootstrapRunner, type FakeBootstrapBehaviour } from "../../bot-manager/tests/fake-bootstrap-runner.js";
import { containerAgents, type BotLaunchProvider } from "./container-agents.js";
import type { AgentDriverInput } from "./engine-executor.js";
import { BattleAbort, BattleResourceRegistry } from "./battle-resources.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";

const IMAGE = `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`;
const BOTS = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

interface LedgerEntry {
  id: string;
  battleId: string;
  running: boolean;
  exists: boolean;
  autoRemove: boolean;
  ignoreTerm: boolean;
  stops: (number | undefined)[];
}

/** Runner que lleva la cuenta de qué contenedores EXISTEN y cuáles corren, por battleId. */
class LedgerRunner implements ContainerRunner {
  readonly ledger: LedgerEntry[] = [];
  readonly inner: FakeBootstrapRunner;
  constructor(
    per: (i: number) => FakeBootstrapBehaviour,
    private readonly extra: (i: number) => {
      ignoreTerm?: boolean;
      stopThrows?: boolean;
      noRemove?: boolean;
    } = () => ({}),
  ) {
    this.inner = new FakeBootstrapRunner((_s, i) => per(i));
  }
  async launch(spec: SandboxSpec): Promise<ContainerHandle> {
    const i = this.ledger.length;
    const x = this.extra(i);
    const e: LedgerEntry = {
      id: `c${i}`,
      battleId: spec.labels?.[LABEL_BATTLE_ID] ?? "?",
      running: false,
      exists: true,
      autoRemove: !!spec.autoRemove,
      ignoreTerm: !!x.ignoreTerm,
      stops: [],
    };
    this.ledger.push(e);
    let h: ContainerHandle;
    try {
      h = await this.inner.launch(spec);
    } catch (err) {
      e.exists = false; // la Engine no llegó a crearlo
      throw err;
    }
    e.running = true;
    const kill = async () => {
      await h.stop();
      e.running = false;
      if (e.autoRemove) e.exists = false;
    };
    return {
      id: h.id,
      posture: () => h.posture(),
      async state() {
        // La verdad del ledger: un contenedor que ignora TERM sigue vivo aunque su bot saliera.
        const st = await h.state!();
        return st ? { ...st, running: e.running, gone: !e.exists } : null;
      },
      async stop(o) {
        e.stops.push(o?.timeoutSeconds);
        if (x.stopThrows) throw new Error("proxy caído en el stop");
        if (e.ignoreTerm && (o?.timeoutSeconds ?? 5) > 0) return; // ignora TERM
        await kill();
      },
      ...(x.noRemove
        ? {}
        : {
            async remove() {
              e.running = false;
              e.exists = false;
            },
          }),
    };
  }
  async list(labels: Record<string, string>): Promise<ManagedContainer[]> {
    return this.ledger
      .filter((e) => e.exists && e.battleId === labels[LABEL_BATTLE_ID])
      .map((e) => ({
        id: e.id,
        labels: { [LABEL_BATTLE_ID]: e.battleId },
        state: e.running ? "running" : "exited",
        createdAtMs: 0,
      }));
  }
  existing(battleId: string): LedgerEntry[] {
    return this.ledger.filter((e) => e.battleId === battleId && e.exists);
  }
}

let runners: LedgerRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.inner.closeAll();
});
beforeAll(async () => {
  await initPhysics();
});

function provider(opts: { planThrowsAt?: number; hosts?: SandboxHost[] } = {}): BotLaunchProvider {
  return {
    async openBattle() {
      const host = await SandboxHost.start({ advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", port: 0 });
      opts.hosts?.push(host);
      let n = 0;
      return {
        wss: host.wss,
        port: host.port,
        async plan() {
          if (opts.planThrowsAt !== undefined && n++ === opts.planThrowsAt) throw new Error("artefacto ilegible");
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

async function input(battleId: string, ticks = 60, signal?: AbortSignal): Promise<AgentDriverInput> {
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
    seed: "mf",
    ruleset,
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  return { battleId, engine, vehicles: BOTS, ruleset, catalogVersion: CATALOG_VERSION, signal, owner: "w:job:1" };
}

const T = { sandboxStartupMs: 3_000, botExecutionMs: 1_500 };

function setup(
  per: (i: number) => FakeBootstrapBehaviour = () => ({}),
  extra?: (i: number) => { ignoreTerm?: boolean; stopThrows?: boolean; noRemove?: boolean },
  p: BotLaunchProvider = provider(),
  more: { graceMs?: number; guardFactor?: number } = {},
) {
  const runner = new LedgerRunner(per, extra);
  runners.push(runner);
  const resources = new BattleResourceRegistry();
  const agents = containerAgents({
    runner,
    provider: p,
    network: "arena",
    engineHost: "127.0.0.1",
    tickIntervalMs: 5,
    timeouts: T,
    resources,
    termGraceS: 1,
    ...(more.graceMs !== undefined ? { graceMs: more.graceMs } : {}),
    ...(more.guardFactor !== undefined ? { guardFactor: more.guardFactor } : {}),
  });
  return { runner, resources, agents };
}

/** Lo que exige el gate tras el final: 0 contenedores de esa batalla y 0 recursos registrados. */
async function expectNothingLeft(s: ReturnType<typeof setup>, battleId: string) {
  // La orquestación repite el teardown sin scope (idempotente).
  const r = await s.resources.cleanupBattleResources(battleId, "FAILED");
  expect(s.runner.existing(battleId), "contenedores de la batalla").toEqual([]);
  expect(s.resources.pending(battleId), "recursos registrados").toEqual([]);
  expect(r.clean).toBe(true);
}

describe("OLA2-MF · teardown tras cada final", () => {
  it("batalla normal → resultado y nada queda", async () => {
    const s = setup();
    const out = await s.agents.run(await input("mf-normal"));
    expect(out.result.ticks).toBeGreaterThan(0);
    // La propia capa de agentes ya hizo su teardown (sin esperar a la orquestación).
    expect(s.runner.existing("mf-normal")).toEqual([]);
    expect(s.resources.pending("mf-normal")).toEqual([]);
    await expectNothingLeft(s, "mf-normal");
  }, 30_000);

  it("bot crash → SportingFailure(bot_crash) y nada queda", async () => {
    const s = setup((i) => (i === 0 ? { crashAfterReady: true } : {}));
    const err = await s.agents.run(await input("mf-crash")).catch((e) => e);
    expect(err).toBeInstanceOf(SportingFailure);
    expect(err.code).toBe("bot_crash");
    await expectNothingLeft(s, "mf-crash");
  }, 30_000);

  it("timeout del bot → SportingFailure(bot_timeout) y nada queda", async () => {
    const s = setup((i) => (i === 1 ? { hangAfterReady: true } : {}));
    const err = await s.agents.run(await input("mf-bto")).catch((e) => e);
    expect(err).toBeInstanceOf(SportingFailure);
    expect(err.code).toBe("bot_timeout");
    await expectNothingLeft(s, "mf-bto");
  }, 30_000);

  it("timeout GLOBAL de la batalla (estancada, el motor jugó) → battle_timeout y nada queda", async () => {
    // Bots quietos y 3000 ticks × 5 ms = 15 s teóricos; guard de 300 ms (factor 1: la
    // fórmula exacta es ticks × ms × factor + gracia, de ahí la gracia negativa).
    const inp = await input("mf-gto", 3000);
    const s = setup((): FakeBootstrapBehaviour => ({ idle: true }), undefined, provider(), {
      guardFactor: 1,
      graceMs: 300 - maxBattleTicks(inp.ruleset) * 5,
    });
    const err = await s.agents.run(inp).catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(err.code).toBe("battle_timeout"); // NO engine_start_failure: la batalla arrancó y jugó
    expect(String(err.message)).toMatch(/timeout global de la batalla tras 300 ms \(jugó [1-9]\d*\/3000 ticks\)/);
    await expectNothingLeft(s, "mf-gto");
  }, 30_000);

  it("el factor del guard se APLICA: con factor 2 el plazo es ticks × ms × 2 + gracia", async () => {
    // Mismo guard de 300 ms que arriba, pero llegando a él con factor 2: 2 × 15 000 + gracia.
    const inp = await input("mf-gfx", 3000);
    const grace = 300 - 2 * maxBattleTicks(inp.ruleset) * 5;
    const s = setup((): FakeBootstrapBehaviour => ({ idle: true }), undefined, provider(), {
      guardFactor: 2,
      graceMs: grace,
    });
    const err = await s.agents.run(inp).catch((e) => e);
    expect(err.code).toBe("battle_timeout");
    expect(String(err.message)).toMatch(/tras 300 ms/);
    await expectNothingLeft(s, "mf-gfx");
  }, 30_000);

  it("batalla larga DENTRO del margen: acaba por límite de ticks sin que salte el guard", async () => {
    // 600 ticks × 5 ms = 3 s teóricos, con un guard de factor 3 (9 s). Acabar a los ~3 s
    // es lo normal: el motor pierde un poco de ritmo por tick y por eso el guard
    // exacto al teórico (margen cero) era un fallo esperando a ocurrir.
    const inp = await input("mf-long", 600);
    const s = setup((): FakeBootstrapBehaviour => ({ idle: true }), undefined, provider(), {
      guardFactor: 3,
      graceMs: 0,
    });
    const out = await s.agents.run(inp);
    expect(out.result.ticks).toBe(600);
    await expectNothingLeft(s, "mf-long");
  }, 30_000);

  it("cancelación (MANUAL_ABORT a mitad) → aborta y nada queda", async () => {
    // Bots quietos: nadie gana antes del aborto.
    const s = setup(() => ({ idle: true }));
    const ac = new AbortController();
    const run = s.agents.run(await input("mf-cancel", 3000, ac.signal));
    setTimeout(() => ac.abort(new BattleAbort("MANUAL_ABORT", "test")), 600);
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(BattleAbort);
    await expectNothingLeft(s, "mf-cancel");
  }, 30_000);

  it("error del motor (step lanza) → el proceso NO cae, se rechaza y nada queda", async () => {
    const s = setup();
    const inp = await input("mf-engine", 3000);
    let n = 0;
    const realStep = inp.engine.step.bind(inp.engine);
    (inp.engine as unknown as { step: () => void }).step = () => {
      if (++n === 20) throw new Error("motor reventado");
      realStep();
    };
    const err = await s.agents.run(inp).catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/motor reventado/);
    await expectNothingLeft(s, "mf-engine");
  }, 30_000);

  it("excepción ANTES de crear todos los bots (plan del 2.º falla) → el 1.º se para y borra", async () => {
    const s = setup(() => ({}), undefined, provider({ planThrowsAt: 1 }));
    const err = await s.agents.run(await input("mf-preplan")).catch((e) => e);
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(s.runner.ledger).toHaveLength(1);
    await expectNothingLeft(s, "mf-preplan");
  }, 30_000);

  it("excepción DURANTE el teardown (stop de un contenedor lanza) → el resto se limpia igual", async () => {
    const s = setup(
      () => ({}),
      (i) => (i === 0 ? { stopThrows: true } : {}),
    );
    const out = await s.agents.run(await input("mf-tdthrow"));
    expect(out.result.ticks).toBeGreaterThan(0);
    // Se borra igualmente (remove forzado de la fase `containers`).
    await expectNothingLeft(s, "mf-tdthrow");
  }, 30_000);

  it("runner que IGNORA TERM → recibe KILL (t=0) y no queda vivo", async () => {
    const s = setup(
      () => ({}),
      (i) => (i === 1 ? { ignoreTerm: true, noRemove: true } : {}),
    );
    await s.agents.run(await input("mf-ignterm"));
    const e = s.runner.ledger[1];
    expect(e.stops).toEqual([1, 0]);
    expect(e.running).toBe(false);
    await expectNothingLeft(s, "mf-ignterm");
  }, 30_000);

  it("cleanup dos veces → la segunda no repite nada ni falla", async () => {
    const s = setup();
    await s.agents.run(await input("mf-twice"));
    const releases = s.resources.stats.releases;
    const a = await s.resources.cleanupBattleResources("mf-twice", "FINISHED");
    const b = await s.resources.cleanupBattleResources("mf-twice", "FINISHED");
    expect([a.clean, b.clean]).toEqual([true, true]);
    expect(s.resources.stats.releases).toBe(releases);
    expect(s.runner.ledger.every((e) => e.stops.length === 1)).toBe(true);
  }, 30_000);

  it("dos batallas CONCURRENTES: el teardown de una no toca la otra", async () => {
    const runner = new LedgerRunner(() => ({ decisionMs: 10 }));
    runners.push(runner);
    const resources = new BattleResourceRegistry();
    const agents = containerAgents({
      runner,
      provider: provider(),
      network: "arena",
      engineHost: "127.0.0.1",
      tickIntervalMs: 5,
      timeouts: T,
      resources,
      termGraceS: 1,
    });
    const ac = new AbortController();
    const short = agents.run(await input("mf-c1", 40, ac.signal));
    const long = agents.run(await input("mf-c2", 400));
    const r1 = await short;
    expect(r1.result.ticks).toBeGreaterThan(0);
    await resources.cleanupBattleResources("mf-c1", "FINISHED");
    // La larga sigue jugando con sus contenedores vivos y sus recursos intactos.
    expect(runner.existing("mf-c1")).toEqual([]);
    expect(runner.existing("mf-c2").every((e) => e.running && e.stops.length === 0)).toBe(true);
    expect(resources.pending("mf-c2").length).toBeGreaterThan(0);
    const r2 = await long;
    expect(r2.result.ticks).toBeGreaterThan(r1.result.ticks);
    await resources.cleanupBattleResources("mf-c2", "FINISHED");
    expect(runner.existing("mf-c2")).toEqual([]);
    expect(resources.totalPending()).toBe(0);
  }, 60_000);
});
