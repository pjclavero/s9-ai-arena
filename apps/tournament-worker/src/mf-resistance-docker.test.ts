/**
 * OLA2-MF · RESISTENCIA con Docker REAL (opt-in, banco VM112; NUNCA producción).
 *
 * N batallas seguidas (S9_MF_BATTLES, def. 40; el criterio sólo es válido con N>=40 y `node --expose-gc`) con las piezas REALES del camino de
 * producción: containerAgents → ProxyContainerRunner → s9-docker-proxy (real, en
 * proceso) → Docker → runtime python fijado en runtimes/DIGESTS.lock → bootstrap →
 * artefacto `arena-artifact/v1` servido por el SandboxHost → protocolo → motor.
 *
 * Tras CADA batalla (después del teardown único) se mide y se exige:
 *   FINISHED_BATTLE_CONTAINERS=0  ningún contenedor (vivo o parado) con la label de esa batalla;
 *   ORPHAN_CGROUPS=0              ningún cgroup de los contenedores lanzados;
 *   ORPHAN_PROCESSES/RUNNERS=0    ningún proceso del host dentro de esos cgroups;
 *   ORPHAN_JOBS=0                 nada registrado en el registro de recursos;
 *   handles de Node (timers, sockets, servidores) de vuelta a la línea base;
 * y se registra la memoria idle (RSS del proceso, MemAvailable del sistema). Al
 * final: sin tendencia creciente sostenida (MULTI_BATTLE_MEMORY_GROWTH) y vuelta
 * al idle (RAM_IDLE_RECOVERY). Sin `drop_caches`.
 *
 * Opt-in: S9_RUN_DOCKER_SANDBOX_E2E=1. Informe JSON: S9_MF_REPORT (ruta).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { SandboxHost } from "../../bot-manager/src/sandbox-host.js";
import { ProxyContainerRunner } from "../../bot-manager/src/docker-proxy.js";
import { packArtifact } from "../../bot-manager/src/artifact.js";
import { launchSpecForBot, loadRuntimeImages } from "../../bot-manager/src/bot-launch.js";
import {
  LABEL_BATTLE_ID,
  LABEL_ROLE,
  ROLE_BATTLE_BOT,
  type ContainerHandle,
  type ContainerRunner,
  type SandboxSpec,
} from "../../bot-manager/src/container-runner.js";
import {
  DOCKER_E2E,
  startDockerSandboxEnv,
  type DockerSandboxEnv,
} from "../../bot-manager/tests/docker-sandbox-env.js";
import { PY_BAD_PROTOCOL, PY_CRASH, PY_GOOD, PY_HANG, pyFiles } from "../../bot-manager/tests/sandbox-bots.js";
import { containerAgents, type BotLaunchProvider } from "./container-agents.js";
import { BattleResourceRegistry } from "./battle-resources.js";
import { evaluateGrowth } from "./mf-growth.js";

const N = Number(process.env.S9_MF_BATTLES ?? 40) || 40;
const BOTS = [
  { botId: "11111111-1111-4111-8111-111111111111", version: 1, vehicleId: "veh_1", team: "red" },
  { botId: "22222222-2222-4222-8222-222222222222", version: 1, vehicleId: "veh_2", team: "blue" },
];

let env: DockerSandboxEnv;
let runner: ProxyContainerRunner;
const launchedIds: string[] = [];

/** Runner real que apunta los Ids lanzados (para buscar sus cgroups y procesos). */
const recording = (): ContainerRunner => ({
  async launch(spec: SandboxSpec): Promise<ContainerHandle> {
    const h = await runner.launch(spec);
    launchedIds.push(h.id);
    return h;
  },
});

function provider(code: (i: number) => string): BotLaunchProvider {
  const images = loadRuntimeImages();
  return {
    async openBattle(battleId) {
      const host = await SandboxHost.start({ advertiseHost: env.advertiseHost, bindHost: "0.0.0.0", port: 0 });
      let n = 0;
      return {
        wss: host.wss,
        port: host.port,
        async plan(bot) {
          const art = packArtifact(pyFiles(code(n++)));
          const offer = host.offerArtifact(art.bytes, art.hash);
          const spec = launchSpecForBot({
            runtime: "python",
            imageDigest: images.python,
            botId: bot.botId,
            version: bot.version,
            sessionId: battleId,
            network: "arena",
            wsUrl: bot.wsUrl,
            battleToken: bot.battleToken,
            botHandle: bot.wireBotId,
            offer,
            hookPolicy: "warn",
          });
          return {
            imageDigest: spec.imageDigest,
            env: spec.env,
            cmd: spec.cmd!,
            autoRemove: true,
            startup: offer.signals,
          };
        },
        close: () => host.close(),
      };
    },
  };
}

async function engineFor(battleId: string) {
  const catalog = loadCatalog();
  const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 120 });
  const participants: Participant[] = BOTS.map((b, i) => ({
    id: b.vehicleId,
    botId: `bot_p${i}`,
    team: b.team,
    spec: resolveVehicle(ARCHETYPES.gunner, catalog),
  }));
  const engine = await Battle.create({
    battleId,
    seed: battleId,
    ruleset,
    map: emptyArena(),
    participants,
    recordReplay: true,
  });
  return { battleId, engine, vehicles: BOTS, ruleset, catalogVersion: CATALOG_VERSION, owner: "mf-res:job:1" };
}

function dockerByLabel(battleId: string): string[] {
  return execFileSync("docker", ["ps", "-aq", "--filter", `label=${LABEL_BATTLE_ID}=${battleId}`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/** Directorios de cgroup cuyo nombre contiene el Id de algún contenedor lanzado. */
function orphanCgroups(ids: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (ids.some((id) => e.includes(id))) out.push(p);
      else if (!e.includes(".") || e.endsWith(".slice") || e.endsWith(".scope")) {
        try {
          if (readdirSync(p)) walk(p, depth + 1);
        } catch {
          /* no es directorio */
        }
      }
    }
  };
  if (existsSync("/sys/fs/cgroup")) walk("/sys/fs/cgroup", 0);
  return out;
}

/** Procesos del host dentro del cgroup de algún contenedor lanzado. */
function orphanProcesses(ids: string[]): number {
  let n = 0;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8");
      if (ids.some((id) => cg.includes(id))) n++;
    } catch {
      /* terminó */
    }
  }
  return n;
}

function memAvailableMb(): number {
  const m = /^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Math.round(Number(m[1]) / 1024) : -1;
}

/** Recursos activos de Node por tipo (timers, sockets, servidores). */
function handles(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of process.getActiveResourcesInfo()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

async function waitGone(battleId: string, ms = 20_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  let left = dockerByLabel(battleId);
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    left = dockerByLabel(battleId);
  }
  return left;
}

interface Row {
  i: number;
  battleId: string;
  outcome: string;
  ms: number;
  containersLeft: number;
  cgroupsLeft: number;
  processesLeft: number;
  registryLeft: number;
  rssMb: number;
  heapMb: number;
  availableMb: number;
  handles: Record<string, number>;
  registryDetail?: unknown;
}
const rows: Row[] = [];

describe.skipIf(!DOCKER_E2E)("OLA2-MF · resistencia: N batallas reales seguidas sin fugas", () => {
  let baselineHandles: Record<string, number> = {};
  beforeAll(async () => {
    await initPhysics();
    env = await startDockerSandboxEnv();
    runner = new ProxyContainerRunner(env.proxyUrl);
  }, 60_000);
  afterAll(async () => {
    if (process.env.S9_MF_REPORT) writeFileSync(process.env.S9_MF_REPORT, JSON.stringify({ N, rows }, null, 2));
    await env?.stop();
  });

  async function oneBattle(i: number, code: (n: number) => string): Promise<Row> {
    const battleId = `mfres-${process.pid}-${i}`;
    const resources = new BattleResourceRegistry();
    resources.setVerifier(async (id) =>
      (await runner.list({ [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: id }))
        .filter((c) => c.state !== "removing")
        .map((c) => c.id.slice(0, 12)),
    );
    const agents = containerAgents({
      runner: recording(),
      provider: provider(code),
      network: "arena",
      engineHost: env.advertiseHost,
      tickIntervalMs: 15,
      timeouts: { sandboxStartupMs: 60_000, botExecutionMs: 10_000 },
      resources,
      termGraceS: 2,
    });
    const before = launchedIds.length;
    const t0 = Date.now();
    const input = await engineFor(battleId);
    let outcome = "FINISHED";
    try {
      await agents.run(input);
    } catch (e) {
      outcome = (e as Error).name === "SportingFailure" ? "BOT_CRASH" : `ERROR:${(e as Error).message.slice(0, 400)}`;
    } finally {
      input.engine.free();
    }
    // La orquestación (battle-runner) repite el teardown sin scope: idempotente.
    const report = await resources.cleanupBattleResources(battleId, outcome === "FINISHED" ? "FINISHED" : "BOT_CRASH");
    const ids = launchedIds.slice(before);
    const left = await waitGone(battleId);
    // Con `--expose-gc` el heapUsed se mide tras una recolección completa: separa una fuga de objetos
    // de la deriva de las arenas de malloc (que sólo mueve la RSS).
    (globalThis as { gc?: () => void }).gc?.();
    const row: Row = {
      i,
      battleId,
      outcome,
      ms: Date.now() - t0,
      containersLeft: left.length,
      cgroupsLeft: orphanCgroups(ids).length,
      processesLeft: orphanProcesses(ids),
      registryLeft: resources.totalPending({ includeDraining: true }) + report.remaining.length,
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      availableMb: memAvailableMb(),
      handles: handles(),
      registryDetail: resources.pending(battleId).length ? { pending: resources.pending(battleId), report } : undefined,
    };
    rows.push(row);
    return row;
  }

  it(
    `${N} batallas normales seguidas: 0 contenedores, cgroups, procesos y recursos tras cada una`,
    async () => {
      // Calentamiento (carga de módulos, JIT, primera descarga de capas): no cuenta para la tendencia.
      await oneBattle(-1, () => PY_GOOD);
      baselineHandles = handles();
      for (let i = 0; i < N; i++) {
        const r = await oneBattle(i, () => PY_GOOD);
        expect(r.outcome, `batalla ${i}`).toBe("FINISHED");
        expect(r.containersLeft, `FINISHED_BATTLE_CONTAINERS batalla ${i}`).toBe(0);
        expect(r.cgroupsLeft, `ORPHAN_CGROUPS batalla ${i}`).toBe(0);
        expect(r.processesLeft, `ORPHAN_PROCESSES batalla ${i}`).toBe(0);
        expect(r.registryLeft, `ORPHAN_JOBS batalla ${i} ${JSON.stringify(r.registryDetail)}`).toBe(0);
        for (const k of ["Timeout", "TCPServerWrap", "TCPSocketWrap"])
          expect(r.handles[k] ?? 0, `handles ${k} batalla ${i}`).toBeLessThanOrEqual((baselineHandles[k] ?? 0) + 2);
      }
      // MULTI_BATTLE_MEMORY_GROWTH (ver mf-growth.ts): pendiente de RSS en la segunda mitad (< 1 MB/batalla),
      // COTA ABSOLUTA (RSS final - mediana de la 1ª mitad < 20 MB), pendiente de heapUsed tras gc
      // (< 0.25 MB/batalla; sólo con --expose-gc) y MemAvailable (> -2 MB/batalla).
      const all = rows.filter((r) => r.i >= 0);
      const gc = typeof (globalThis as { gc?: unknown }).gc === "function";
      const verdict = evaluateGrowth(all, { gc });
      console.log(
        JSON.stringify({
          mf_resistance: {
            N,
            gc,
            ...verdict.metrics,
            rssFirst: all[0]?.rssMb,
            rssLast: all[all.length - 1]?.rssMb,
            rssMax: Math.max(...all.map((r) => r.rssMb)),
            heapFirst: all[0]?.heapMb,
            heapLast: all[all.length - 1]?.heapMb,
            violations: verdict.violations,
          },
        }),
      );
      expect(N, "el criterio de memoria sólo es válido con N>=40").toBeGreaterThanOrEqual(
        process.env.S9_MF_ALLOW_SHORT === "1" ? 8 : 40,
      );
      expect(verdict.violations).toEqual([]);
    },
    60 * 60_000,
  );

  it(
    "batallas con bot que falla (excepción, protocolo roto, cuelgue): el teardown también deja 0 de todo",
    async () => {
      // Clasificación OBSERVADA (no es un invento del test): una excepción en el bot la captura el
      // BOOTSTRAP (sandbox-bootstrap/bootstrap.py:240-245: la reporta como `runtime` y sale con código 9,
      // no el SDK); el motor trata al bot desconectado como eliminado y la batalla acaba FINISHED. Igual con
      // un protocolo roto. Un cuelgue sí es fallo deportivo (BOT_CRASH). Ver TD de producto en el informe MF.
      const bots = [PY_CRASH, PY_BAD_PROTOCOL, PY_HANG];
      const expected = ["FINISHED", "FINISHED", "BOT_CRASH"];
      for (let i = 0; i < bots.length; i++) {
        const r = await oneBattle(1000 + i, (n) => (n === 0 ? bots[i] : PY_GOOD));
        console.log(JSON.stringify({ mf_bad_bot: { i, outcome: r.outcome } }));
        expect(r.outcome, `clasificación del bot malo ${i}`).toBe(expected[i]);
        expect(
          [r.containersLeft, r.cgroupsLeft, r.processesLeft, r.registryLeft],
          `bot malo ${i} ${r.outcome}`,
        ).toEqual([0, 0, 0, 0]);
      }
    },
    10 * 60_000,
  );
});
