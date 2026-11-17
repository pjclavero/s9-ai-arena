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
 *
 * G2.4 · MF_STOP_BOUNDED_TEARDOWN: stop normal, lento, que nunca responde y que lanza ⇒ el
 * teardown acaba SIEMPRE en tiempo acotado y no queda ningún contenedor ni recurso.
 * G2.5 · MF_LAUNCH_TIMEOUT_CLEANUP: launch colgado (timeout), cancelación durante el launch,
 * launch parcial, contenedor que llega TARDE (y su limpieza fallida) ⇒ estado final definido:
 * run() rechaza (infraestructura o el motivo del aborto), lo lanzado se para y se borra, el
 * lanzamiento sin respuesta se DESPRENDE (no queda `failed` eterno), el informe no es «limpio»
 * y un contenedor tardío se limpia o queda registrado para el reaper. Ningún huérfano.
 *
 * Ningún `contractIt` queda en este fichero: todos son `it` (ENFORCE=ALL sin pendientes).
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
import { REMOVE_DEADLINE_MS, containerAgents, type BotLaunchProvider } from "../../src/container-agents.js";
import type { AgentDriverInput } from "../../src/engine-executor.js";
import { BattleAbort, BattleResourceRegistry, classifyEnd, type RegistryOptions } from "../../src/battle-resources.js";
import { reapOnce } from "../../src/battle-reaper.js";
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
  /** Índice cuyo stop() tarda `slowStopMs` en resolver (y entonces para). */
  slowStopAt?: number;
  slowStopMs?: number;
  /** Índice cuyo stop() SIEMPRE lanza (remove() sí funciona). */
  throwStopAt?: number;
  /** Índice cuyo launch() devuelve el contenedor TARDE (`lateLaunchMs`), sin bot dentro. */
  lateLaunchAt?: number;
  lateLaunchMs?: number;
  /** Índice cuya lectura de CPU (`cpuMs`) no contesta nunca (proxy colgado al acabar). */
  hangCpuAt?: number;
  /** Índice cuya inspección de postura no contesta nunca. */
  hangPostureAt?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (this.faults.lateLaunchAt === i) {
      // `docker run` que contesta tarde: el contenedor EXISTE desde que el runner responde.
      await sleep(this.faults.lateLaunchMs ?? 0);
      const late: Entry = { battleId: spec.labels?.[LABEL_BATTLE_ID] ?? "?", running: true, exists: true, stops: [] };
      this.ledger.push(late);
      const isBrokenLate = () => this.faults.brokenAt === i && this.broken.value;
      return {
        id: `late-${i}`,
        posture: () => Promise.reject(new Error("no se inspecciona un contenedor tardío")),
        async state() {
          return { running: late.running, gone: !late.exists, exitCode: null, oomKilled: false, startedAtMs: 0 };
        },
        async stop(o) {
          late.stops.push(o?.timeoutSeconds);
          if (isBrokenLate()) throw new Error("stop simulado falla: proxy caído");
          late.running = false;
        },
        async remove() {
          if (isBrokenLate()) throw new Error("remove simulado falla: proxy caído");
          late.running = false;
          late.exists = false;
        },
      };
    }
    const e: Entry = { battleId: spec.labels?.[LABEL_BATTLE_ID] ?? "?", running: false, exists: true, stops: [] };
    this.ledger.push(e);
    const h = await this.inner.launch(spec);
    e.running = true;
    const faults = this.faults;
    const isBroken = () => faults.brokenAt === i && this.broken.value;
    return {
      id: h.id,
      posture: () => (faults.hangPostureAt === i ? new Promise<never>(() => {}) : h.posture()),
      ...(faults.hangCpuAt === i ? { cpuMs: () => new Promise<number | null>(() => {}) } : {}),
      async state() {
        const st = await h.state!();
        return st ? { ...st, running: e.running, gone: !e.exists } : null;
      },
      async stop(o) {
        e.stops.push(o?.timeoutSeconds);
        if (faults.hangStopAt === i) return new Promise<void>(() => {}); // `docker stop` colgado
        if (isBroken()) throw new Error("stop simulado falla: proxy caído");
        if (faults.throwStopAt === i) throw new Error("stop simulado lanza siempre");
        if (faults.slowStopAt === i) await sleep(faults.slowStopMs ?? 0);
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

function setup(
  faults: Faults = {},
  o: { sandboxStartupMs?: number; launchInFlightWaitMs?: number; registry?: RegistryOptions } = {},
) {
  const runner = new FaultyRunner(faults);
  runners.push(runner);
  const resources = new BattleResourceRegistry(o.registry);
  const agents = containerAgents({
    runner,
    provider: provider(),
    network: "arena",
    engineHost: "127.0.0.1",
    tickIntervalMs: 5,
    timeouts: { sandboxStartupMs: o.sandboxStartupMs ?? 1_500, botExecutionMs: 1_500 },
    resources,
    termGraceS: 1,
    ...(o.launchInFlightWaitMs !== undefined ? { launchInFlightWaitMs: o.launchInFlightWaitMs } : {}),
  });
  return { runner, resources, agents };
}

/** Espera (acotada) a que `cond` se cumpla; devuelve si se cumplió. */
async function eventually(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** Ejecuta la batalla midiendo el tiempo; nunca cuelga el test. */
async function timedRun(s: ReturnType<typeof setup>, battleId: string, boundMs: number, signal?: AbortSignal) {
  const t0 = performance.now();
  const inp = await input(battleId);
  const out = await settlesWithin(s.agents.run(signal ? { ...inp, signal } : inp), boundMs);
  return { out, ms: performance.now() - t0 };
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

describe("G2.5 · MF_LAUNCH_TIMEOUT_CLEANUP · launch() colgado o tardío (verificado en el tournament-worker)", () => {
  // Cota REAL: reloj de arranque de plataforma (1,5 s) + espera ACOTADA del lanzamiento en vuelo
  // (`launchInFlightWaitMs`, por defecto 5 s) + parada acotada del ya lanzado. Antes: 30 s fijos
  // y un `container_launch_in_flight:failed` que no se iba nunca.
  const LAUNCH_BOUND_MS = 12_000;
  let hangLaunch: ReturnType<typeof runHangLaunch> | undefined;
  async function runHangLaunch() {
    const s = setup({ hangLaunchAt: 1 });
    const r = await timedRun(s, "g2-hang-launch", LAUNCH_BOUND_MS + 8_000);
    return { s, ...r };
  }
  const scenario = () => (hangLaunch ??= runHangLaunch());

  it("[contrato MF cumplido · G2] timeout + launch parcial: la batalla termina por infraestructura en tiempo acotado, lo ya lanzado se para y se borra", async () => {
    const { s, out, ms } = await scenario();
    expect(out.hung, "run() sigue colgado tras el plazo").toBe(false);
    expect(ms, "run() tardó más que la cota del lanzamiento colgado").toBeLessThan(LAUNCH_BOUND_MS);
    const err = (out as { value: unknown }).value;
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect((err as InfrastructureFailure).code).toBe("container_unavailable");
    expect(classifyEnd({ ok: false, error: err }), "estado final de la batalla").toBe("FAILED");
    // Lanzamiento parcial: el contenedor ya lanzado (el 1.º) se paró y se borró.
    expect(s.runner.ledger[0]!.stops.length, "el contenedor ya lanzado no se paró").toBeGreaterThanOrEqual(1);
    expect(s.runner.existing("g2-hang-launch"), "contenedores que siguen existiendo").toEqual([]);
  }, 60_000);

  it("[contrato MF cumplido · G2] un launch() que nunca resuelve: tras el teardown no queda NADA registrado de la batalla", async () => {
    const { s } = await scenario();
    expect(s.resources.pending("g2-hang-launch"), "recursos registrados tras el final").toEqual([]);
  }, 60_000);

  it("[G2] el lanzamiento sin respuesta se DESPRENDE (no `failed`) y el teardown completo NO lo llama «limpio»", async () => {
    const { s } = await scenario();
    expect(s.resources.stats.detached, "desprendimientos").toBe(1);
    const full = await s.resources.cleanupBattleResources("g2-hang-launch", "FAILED");
    expect(full.detached, "el teardown completo no informa del lanzamiento desprendido").toBe(1);
    expect(full.clean, "un lanzamiento sin respuesta no puede darse por limpio").toBe(false);
    expect(full.remaining).toEqual([]);
    // Un segundo teardown (reaper) ya no tiene nada que esperar: no repite la espera.
    const t0 = performance.now();
    const again = await s.resources.cleanupBattleResources("g2-hang-launch", "FAILED");
    expect(performance.now() - t0, "el reaper vuelve a esperar al lanzamiento").toBeLessThan(500);
    expect(again.steps).toEqual([]);
    expect(again.clean).toBe(true);
  }, 60_000);

  it("[G2] contenedor que contesta tras el reloj de arranque pero DENTRO de la espera del teardown: se para y se borra en el propio teardown (sin desprender)", async () => {
    const s = setup({ lateLaunchAt: 1, lateLaunchMs: 2_200 }, { launchInFlightWaitMs: 3_000 });
    const { out } = await timedRun(s, "g2-late-in-wait", LAUNCH_BOUND_MS);
    expect(out.hung).toBe(false);
    expect((out as { value: unknown }).value).toBeInstanceOf(InfrastructureFailure);
    expect(s.resources.stats.detached, "se desprendió un lanzamiento que sí contestó a tiempo").toBe(0);
    expect(s.runner.ledger.length, "el fixture no creó el tardío").toBe(2);
    expect(
      s.runner.existing("g2-late-in-wait"),
      "el teardown no paró/borró el contenedor llegado en su espera",
    ).toEqual([]);
    expect(s.resources.pending("g2-late-in-wait")).toEqual([]);
  }, 60_000);

  it("[G2] contenedor que llega TARDE (tras el teardown): se para y se borra solo; no queda ni registrado ni existiendo", async () => {
    const s = setup({ lateLaunchAt: 1, lateLaunchMs: 3_500 }, { launchInFlightWaitMs: 300 });
    const { out, ms } = await timedRun(s, "g2-late-launch", LAUNCH_BOUND_MS);
    expect(out.hung).toBe(false);
    expect((out as { value: unknown }).value).toBeInstanceOf(InfrastructureFailure);
    expect(ms, "el teardown esperó al contenedor tardío más que su plazo").toBeLessThan(3_400);
    expect(s.resources.stats.detached).toBe(1);
    // Llega el contenedor: lo recoge `adoptLate`.
    expect(await eventually(() => s.runner.ledger.length === 2, 4_000), "el fixture no creó el tardío").toBe(true);
    expect(
      await eventually(() => s.runner.existing("g2-late-launch").length === 0, 4_000),
      "el contenedor tardío quedó huérfano",
    ).toBe(true);
    expect(s.runner.ledger[1]!.stops.length, "el tardío no recibió la parada").toBeGreaterThanOrEqual(1);
    expect(s.resources.pending("g2-late-launch")).toEqual([]);
  }, 60_000);

  it("[G2] contenedor tardío cuya limpieza FALLA: queda registrado (`container_late`, pendiente de reintento) y el reintento lo borra", async () => {
    const s = setup({ lateLaunchAt: 1, lateLaunchMs: 3_000, brokenAt: 1 }, { launchInFlightWaitMs: 200 });
    const { out } = await timedRun(s, "g2-late-broken", LAUNCH_BOUND_MS);
    expect(out.hung).toBe(false);
    expect(
      await eventually(
        () => s.resources.pending("g2-late-broken").some((p) => p.kind.startsWith("container_late:")),
        5_000,
      ),
      "un contenedor tardío no limpiable no quedó registrado (huérfano invisible)",
    ).toBe(true);
    expect(s.resources.pending("g2-late-broken").map((p) => `${p.kind}:${p.state}`)).toEqual([
      "container_late:veh_2:live",
    ]);
    expect(s.runner.existing("g2-late-broken").length, "control: el tardío sigue existiendo").toBe(1);
    // El reaper reintenta cuando el proxy se recupera.
    s.runner.broken.value = false;
    const retry = await s.resources.cleanupBattleResources("g2-late-broken", "FAILED");
    expect(retry.remaining).toEqual([]);
    expect(s.runner.existing("g2-late-broken")).toEqual([]);
    expect(s.resources.pending("g2-late-broken")).toEqual([]);
  }, 60_000);

  it("[G2] cancelación DURANTE un launch() colgado: run() rechaza con el motivo del aborto sin esperar al reloj de arranque", async () => {
    // Reloj de arranque largo (30 s): si la cancelación no se observa, run() tardaría ≥ 30 s.
    const s = setup({ hangLaunchAt: 1 }, { sandboxStartupMs: 30_000, launchInFlightWaitMs: 300 });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new BattleAbort("CANCELLED", "reserva perdida")), 400);
    const { out, ms } = await timedRun(s, "g2-cancel-launch", 20_000, ac.signal);
    clearTimeout(t);
    expect(out.hung, "la cancelación no interrumpió el lanzamiento").toBe(false);
    expect(ms, "la cancelación esperó al reloj de arranque").toBeLessThan(8_000);
    const err = (out as { value: unknown }).value;
    expect(err).toBeInstanceOf(BattleAbort);
    expect(classifyEnd({ ok: false, error: err, abortReason: ac.signal.reason }), "estado final").toBe("CANCELLED");
    expect(s.runner.ledger[0]!.stops.length, "el contenedor ya lanzado no se paró").toBeGreaterThanOrEqual(1);
    expect(s.runner.existing("g2-cancel-launch")).toEqual([]);
    expect(s.resources.pending("g2-cancel-launch")).toEqual([]);
  }, 60_000);
});

describe("G2.4 · MF_STOP_BOUNDED_TEARDOWN · stop() normal, lento, eterno y que lanza (verificado en el tournament-worker)", () => {
  // termGraceS=1 ⇒ plazo del TERM (1+5) s; KILL acotado a 5 s; estado acotado a 2 s.
  const STOP_BOUND_MS = 16_000;

  async function battleWith(faults: Faults, battleId: string) {
    const s = setup(faults);
    const { out, ms } = await timedRun(s, battleId, STOP_BOUND_MS + 10_000);
    return { s, out, ms };
  }

  it("[G2] stop normal: la batalla acaba, se para y se borra cada contenedor sin KILL y no queda nada", async () => {
    const { s, out, ms } = await battleWith({}, "g2-stop-normal");
    expect(out.hung).toBe(false);
    expect((out as { value: { result?: unknown } }).value.result, "la batalla no dio resultado").toBeDefined();
    expect(ms).toBeLessThan(STOP_BOUND_MS);
    expect(s.runner.ledger.map((e) => e.stops)).toEqual([[1], [1]]);
    expect(s.runner.existing("g2-stop-normal")).toEqual([]);
    expect(s.resources.pending("g2-stop-normal")).toEqual([]);
  }, 60_000);

  it("[G2] stop lento (2 s, dentro del plazo del TERM): se espera, sin KILL, y no queda nada", async () => {
    const { s, out, ms } = await battleWith({ slowStopAt: 0, slowStopMs: 2_000 }, "g2-stop-slow");
    expect(out.hung).toBe(false);
    expect(ms, "el teardown no esperó al stop lento").toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThan(STOP_BOUND_MS);
    expect(s.runner.ledger[0]!.stops, "un stop lento dentro del plazo no debe escalar a KILL").toEqual([1]);
    expect(s.runner.existing("g2-stop-slow")).toEqual([]);
    expect(s.resources.pending("g2-stop-slow")).toEqual([]);
  }, 60_000);

  it("[contrato MF cumplido · G2] un stop() que nunca resuelve no cuelga el teardown: la batalla acaba, el otro contenedor se para y el colgado se borra", async () => {
    const { s, out, ms } = await battleWith({ hangStopAt: 0 }, "g2-hang-stop");
    expect(out.hung, "el teardown quedó esperando un stop() eterno").toBe(false);
    expect(ms, "teardown fuera de su cota").toBeLessThan(STOP_BOUND_MS);
    expect(s.runner.ledger[0]!.stops, "no se intentó TERM y después KILL").toEqual([1, 0]);
    expect(s.runner.ledger[1]!.stops.length, "el otro contenedor no se paró").toBeGreaterThanOrEqual(1);
    expect(s.runner.existing("g2-hang-stop"), "contenedores que siguen existiendo").toEqual([]);
    expect(s.resources.pending("g2-hang-stop"), "recursos registrados tras el final").toEqual([]);
  }, 60_000);

  it("[G2] stop que LANZA siempre: KILL intentado, borrado forzado, en tiempo acotado y sin restos", async () => {
    const { s, out, ms } = await battleWith({ throwStopAt: 0 }, "g2-stop-throws");
    expect(out.hung).toBe(false);
    expect(ms).toBeLessThan(STOP_BOUND_MS);
    expect(s.runner.ledger[0]!.stops, "no se escaló a KILL tras un stop que lanza").toEqual([1, 0]);
    expect(s.runner.existing("g2-stop-throws")).toEqual([]);
    expect(s.resources.pending("g2-stop-throws")).toEqual([]);
  }, 60_000);
});

describe("MF · el fallo de teardown no se oculta (verificado en el tournament-worker)", () => {
  it("[contrato MF cumplido · G2] si parar Y borrar un contenedor fallan, el teardown NO es «limpio»: el informe nombra el fallo y el recurso sigue registrado hasta reintentarse", async () => {
    const s = setup({ brokenAt: 0 });
    // La batalla (el resultado deportivo) no se pierde por un fallo de teardown de un contenedor.
    await s.agents.run(await input("g2-teardown-fail")).catch(() => undefined);
    const first = await s.resources.cleanupBattleResources("g2-teardown-fail", "FINISHED");
    expect(first.clean, "un contenedor que no se pudo parar ni borrar se dio por limpio").toBe(false);
    const failed = first.steps.filter((x) => x.outcome === "failed");
    expect(failed.length, "ningún paso de teardown informó el fallo").toBeGreaterThan(0);
    expect(failed.map((x) => x.error).join(" | ")).toMatch(/simulado falla/);
    expect(s.resources.pending("g2-teardown-fail").length, "el recurso fallido ya no está registrado").toBeGreaterThan(
      0,
    );
    expect(s.runner.existing("g2-teardown-fail").length, "control: el contenedor sigue existiendo").toBe(1);
    // G2 · ronda 2 (P3-5): el borrado forzado tiene SU plazo de producción (15 s), no el genérico (60 s).
    const rm = s.resources.pending("g2-teardown-fail").find((x) => x.kind.startsWith("container_remove:"));
    expect(rm, "el borrado fallido no sigue registrado").toBeDefined();
    expect(rm!.deadlineMs, "el borrado no lleva su plazo propio").toBe(REMOVE_DEADLINE_MS);
    expect(REMOVE_DEADLINE_MS).toBe(15_000);
    // Reintento (lo que hace el reaper cuando el proxy se recupera): ahora sí queda todo.
    s.runner.broken.value = false;
    const retry = await s.resources.cleanupBattleResources("g2-teardown-fail", "FINISHED");
    expect(retry.clean).toBe(true);
    expect(s.runner.existing("g2-teardown-fail")).toEqual([]);
    expect(s.resources.pending("g2-teardown-fail")).toEqual([]);
  }, 60_000);
});

describe("G2 · ronda 2 (P2-1) · ninguna espera sin cota en el camino del teardown (verificado en el tournament-worker)", () => {
  it("[G2·R2] verificador externo colgado (proxy): el teardown COMPLETO acaba en su plazo, NO es limpio y el reaper lo vuelve a verificar cuando el proxy contesta", async () => {
    const s = setup({}, { registry: { verifyDeadlineMs: 500 } });
    let hang = true;
    // Como main.ts: la verificación es `runner.list()` por labels de la batalla.
    s.resources.setVerifier(async (battleId) =>
      hang ? new Promise<string[]>(() => {}) : (await s.runner.list({ [LABEL_BATTLE_ID]: battleId })).map((c) => c.id),
    );
    const { out } = await timedRun(s, "g2-verify-hang", 30_000);
    expect(out.hung).toBe(false);
    expect(s.runner.existing("g2-verify-hang"), "control: la capa de agentes ya lo borró todo").toEqual([]);
    const t0 = performance.now();
    const full = await settlesWithin(s.resources.cleanupBattleResources("g2-verify-hang", "FINISHED"), 5_000);
    const ms = performance.now() - t0;
    expect(full.hung, "el teardown completo quedó esperando al verificador").toBe(false);
    expect(ms, "la verificación no respetó su plazo").toBeLessThan(2_000);
    const report = (full as { value: { clean: boolean; externalLeftovers: string[] } }).value;
    expect(report.clean, "una verificación sin respuesta se dio por limpia").toBe(false);
    expect(report.externalLeftovers.join(" ")).toMatch(/verificación externa sin respuesta en 500 ms/);
    expect(s.resources.isUnverified("g2-verify-hang")).toBe(true);
    // El reaper (sin BD: sólo la parte en proceso) lo reintenta; con el proxy de vuelta, verifica.
    hang = false;
    const db = (() => {
      throw new Error("el reaper no debe consultar la BD sin runner");
    }) as never;
    const reap = await settlesWithin(reapOnce({ db, resources: s.resources }), 5_000);
    expect(reap.hung).toBe(false);
    expect((reap as { value: { inProcessRetried: string[] } }).value.inProcessRetried).toEqual(["g2-verify-hang"]);
    expect(s.resources.isUnverified("g2-verify-hang"), "el reaper no reverificó la batalla").toBe(false);
    expect(s.resources.retryIds()).toEqual([]);
  }, 60_000);

  it("[G2·R2] la última muestra de CPU no contesta (proxy colgado al acabar): la batalla acaba, se llega al teardown y no queda nada", async () => {
    const s = setup({ hangCpuAt: 0 });
    const { out, ms } = await timedRun(s, "g2-cpu-hang", 30_000);
    expect(out.hung, "la batalla quedó esperando la última muestra de CPU (sin teardown)").toBe(false);
    expect((out as { value: { result?: unknown } }).value.result, "la batalla no dio resultado").toBeDefined();
    expect(ms).toBeLessThan(16_000);
    expect(s.runner.existing("g2-cpu-hang")).toEqual([]);
    expect(s.resources.pending("g2-cpu-hang")).toEqual([]);
  }, 60_000);

  it("[G2·R2] una inspección de postura que no contesta: la batalla falla por infraestructura en su plazo y lo lanzado se para y se borra", async () => {
    const s = setup({ hangPostureAt: 0 });
    const { out, ms } = await timedRun(s, "g2-posture-hang", 30_000);
    expect(out.hung, "la batalla quedó esperando la inspección de postura").toBe(false);
    const err = (out as { value: unknown }).value;
    expect(err).toBeInstanceOf(InfrastructureFailure);
    expect(String((err as Error).message)).toMatch(/inspección de postura sin respuesta/);
    expect(classifyEnd({ ok: false, error: err })).toBe("FAILED");
    expect(ms).toBeLessThan(25_000);
    expect(s.runner.existing("g2-posture-hang")).toEqual([]);
    expect(s.resources.pending("g2-posture-hang")).toEqual([]);
  }, 60_000);
});
