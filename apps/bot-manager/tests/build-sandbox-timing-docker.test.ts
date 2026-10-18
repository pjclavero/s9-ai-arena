/**
 * PRC · TD-034 — arranque frente a ejecución con CONTENEDORES REALES (opt-in).
 *
 * Mismo entorno que build-sandbox-docker.test.ts: s9-docker-proxy real →
 * Docker de esta máquina, imagen de runtime fijada por digest, bootstrap real,
 * protocolo arena/1 y motor reales. Opt-in: S9_RUN_DOCKER_SANDBOX_E2E=1 (sin
 * ella el fichero queda SKIPPED, que no es verde).
 *
 * Recursos: los contenedores se llaman `bot-prcsbx…` (botId con prefijo
 * prcsbx) y la prueba de saturación limita duración y concurrencia
 * (S9_TD034_STRESS_ROUNDS, S9_TD034_STRESS_PARALLEL, S9_TD034_STRESS_HOGS,
 * S9_TD034_STRESS_HOG_MS ≤ 120000).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildPipeline } from "../src/pipeline.js";
import { InMemoryBuildStore } from "../src/store.js";
import { withConfig } from "../src/config.js";
import { generateServiceKeypair } from "../src/signing.js";
import { createSandboxFromEnv } from "../src/build-worker-wiring.js";
import { ContainerBuildSandbox, SandboxInfrastructureError } from "../src/build-sandbox.js";
import { ProxyContainerRunner } from "../src/docker-proxy.js";
import { bootstrapCmd, loadRuntimeImages } from "../src/bot-launch.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { submission } from "./fixtures.js";
import { DOCKER_E2E, startDockerSandboxEnv, type DockerSandboxEnv } from "./docker-sandbox-env.js";
import { PY_GOOD, PY_HANG, JS_GOOD, pyFiles, jsFiles } from "./sandbox-bots.js";

const BOOTSTRAP_PY = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sandbox-bootstrap", "bootstrap.py"),
  "utf8",
);

/** Código de usuario válido que trabaja ~ms al importarse (CPU real del contenedor). */
const pyBusyImport = (ms: number) =>
  `import time\n_t0 = time.time()\nwhile (time.time() - _t0) * 1000 < ${ms}:\n    pass\n\n` + PY_GOOD;

/** «Runtime de prueba»: el MISMO bootstrap, precedido de `ms` de plataforma lenta antes de `ready`. */
const slowRuntime = (ms: number) => (runtime: "python" | "node") => {
  if (runtime !== "python") return bootstrapCmd(runtime);
  return ["-c", `import time as _s9t\n_s9t.sleep(${ms / 1000})\n` + BOOTSTRAP_PY];
};

let env: DockerSandboxEnv;
const signer = generateServiceKeypair();
let seq = 0;
const botId = () => `prcsbx_td034_${process.pid}_${seq++}`;

function pipeline(sandbox: ContainerBuildSandbox, ticks = 300) {
  return new BuildPipeline({
    store: new InMemoryBuildStore(),
    config: withConfig({ smokeBattleTicks: ticks }),
    signer,
    sandbox,
  });
}

function sandboxFromEnv(extra: Record<string, string> = {}): ContainerBuildSandbox {
  const made = createSandboxFromEnv({
    DOCKER_PROXY_URL: env.proxyUrl,
    BUILD_SANDBOX_HOST: env.advertiseHost,
    ARENA_NETWORK: "arena",
    ...extra,
  });
  if (!made.sandbox) throw new Error(made.reason);
  return made.sandbox;
}

function customSandbox(o: Partial<ConstructorParameters<typeof ContainerBuildSandbox>[0]>): ContainerBuildSandbox {
  return new ContainerBuildSandbox({
    runner: new ProxyContainerRunner(env.proxyUrl),
    network: "arena",
    advertiseHost: env.advertiseHost,
    bindHost: "0.0.0.0",
    runtimeImages: loadRuntimeImages(),
    referenceAgent: (id) => new HunterBot(id),
    ...o,
  });
}

const stage = (
  b: { stages: { name: string; status: string; message?: string; metrics?: Record<string, number> }[] },
  n: string,
) => b.stages.find((s) => s.name === n)!;

function leftoverPrcsbx(): string[] {
  return execFileSync("docker", ["ps", "-a", "--filter", "name=^bot-prcsbx", "--format", "{{.Names}}"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

describe.skipIf(!DOCKER_E2E)("TD-034 · arranque frente a ejecución con contenedores reales", () => {
  beforeAll(async () => {
    await initPhysics();
    env = await startDockerSandboxEnv();
  }, 60_000);

  afterAll(async () => {
    await env?.stop();
  });

  it("SAN-5 · plataforma lenta REAL (7 s antes de `ready`) + bot de ~500 ms → validated con los defectos", async () => {
    const sb = customSandbox({ bootstrapCmd: slowRuntime(7000) });
    expect(sb.timeouts).toEqual({ sandboxStartupMs: 30_000, botExecutionMs: 5_000 });
    const b = await pipeline(sb).run(submission(pyFiles(pyBusyImport(500)), { botId: botId(), archetype: "gunner" }));
    const m = stage(b, "resource_limits").metrics!;
    console.log("[TD-034][SAN-5]", JSON.stringify(m));
    expect(b.rejectionReason).toBeUndefined();
    expect(b.botVersionState).toBe("validated");
    expect(m.startupMs).toBeGreaterThanOrEqual(7000);
    expect(m.botReadyToHelloMs).toBeGreaterThanOrEqual(450);
    expect(m.botReadyToHelloMs).toBeLessThan(5000);
    // Lo que juzgaba el código anterior (StartedAt → HELLO) supera 5000 ms:
    // con el reloj único, este bot VÁLIDO habría quedado rejected (TD-034).
    expect(m.startedAtToHelloMs).toBeGreaterThan(5000);
  }, 120_000);

  it("SAN-6 · arranque rápido y código del bot por encima de BOT_EXECUTION_TIMEOUT (1500 ms) → rejected", async () => {
    const sb = sandboxFromEnv({ BOT_EXECUTION_TIMEOUT_MS: "1500" });
    expect(sb.timeouts.botExecutionMs).toBe(1500);
    const b = await pipeline(sb).run(submission(pyFiles(pyBusyImport(4000)), { botId: botId() }));
    const p = stage(b, "protocol_test");
    console.log("[TD-034][SAN-6]", p.message, JSON.stringify(p.metrics));
    expect(b.botVersionState).toBe("rejected");
    expect(p.status).toBe("failed");
    expect(p.message).toMatch(/timeout_reason=bot_execution_timeout/);
    expect(p.message).toMatch(/en 1500 ms desde que el agente estuvo listo/);
    expect(p.metrics!.startupMs).toBeLessThan(30_000);
  }, 120_000);

  it("SAN-10 · bot infinito al importar → rejected por el reloj del bot (no infraestructura)", async () => {
    const b = await pipeline(sandboxFromEnv()).run(submission(pyFiles(PY_HANG), { botId: botId() }));
    expect(b.botVersionState).toBe("rejected");
    expect(stage(b, "protocol_test").message).toMatch(/timeout_reason=bot_execution_timeout/);
  }, 120_000);

  it("SAN-9 · la plataforma no llega a `ready` en SANDBOX_STARTUP_TIMEOUT (3000 ms) → infraestructura, nunca rejected", async () => {
    const sb = customSandbox({
      bootstrapCmd: slowRuntime(10_000),
      timeouts: { sandboxStartupMs: 3000, botExecutionMs: 5000 },
    });
    const err = await pipeline(sb)
      .run(submission(pyFiles(PY_GOOD), { botId: botId() }))
      .catch((e) => e);
    console.log("[TD-034][SAN-9 timeout]", String(err?.message));
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(/\[sandbox_start_timeout\]/);
  }, 120_000);

  it("SAN-9 · runtime ausente (digest que la Engine no tiene) → infraestructura", async () => {
    const images = loadRuntimeImages();
    const missing = images.python.replace(/@sha256:[0-9a-f]{64}$/, `@sha256:${"ab".repeat(32)}`);
    const sb = customSandbox({ runtimeImages: { ...images, python: missing } });
    const err = await pipeline(sb)
      .run(submission(pyFiles(PY_GOOD), { botId: botId() }))
      .catch((e) => e);
    console.log("[TD-034][SAN-9 runtime]", String(err?.message));
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(/\[sandbox_start_failed\]/);
  }, 120_000);

  it("SAN-7 · saturación controlada: builds en paralelo con CPU del host ocupada → ningún bot válido rechazado", async () => {
    const rounds = Number(process.env.S9_TD034_STRESS_ROUNDS ?? 2);
    const parallel = Number(process.env.S9_TD034_STRESS_PARALLEL ?? 6);
    const hogsN = Number(process.env.S9_TD034_STRESS_HOGS ?? 3);
    const hogMs = Math.min(120_000, Number(process.env.S9_TD034_STRESS_HOG_MS ?? 90_000));
    // Carga de CPU en el host: procesos busy-loop con techo duro (se matan al acabar).
    const hogs: ChildProcess[] = [];
    for (let i = 0; i < hogsN; i++) {
      hogs.push(
        spawn(process.execPath, ["-e", `const t=Date.now();while(Date.now()-t<${hogMs}){}`], { stdio: "ignore" }),
      );
    }
    const rows: Record<string, unknown>[] = [];
    try {
      for (let r = 0; r < rounds; r++) {
        const sb = sandboxFromEnv();
        const builds = await Promise.all(
          Array.from({ length: parallel }, (_x, i) =>
            pipeline(sb, 150).run(
              i % 2 === 0
                ? submission(pyFiles(pyBusyImport(200)), { botId: botId(), archetype: "gunner" })
                : submission(jsFiles(JS_GOOD), { botId: botId(), runtime: "node", archetype: "scout" }),
            ),
          ),
        );
        for (const b of builds) {
          const m = stage(b, "resource_limits").metrics ?? stage(b, "protocol_test").metrics ?? {};
          rows.push({
            round: r,
            state: b.botVersionState,
            reason: b.rejectionReason,
            launchMs: Math.round(m.launchMs ?? -1),
            startupMs: Math.round(m.startupMs ?? -1),
            botReadyToHelloMs: Math.round(m.botReadyToHelloMs ?? -1),
            startedAtToHelloMs: Math.round(m.startedAtToHelloMs ?? -1),
          });
        }
      }
    } finally {
      for (const h of hogs) h.kill("SIGKILL");
    }
    console.log("[TD-034][SAN-7]", JSON.stringify(rows));
    const oldRuleWouldReject = rows.filter((x) => (x.startedAtToHelloMs as number) > 5000).length;
    console.log(
      `[TD-034][SAN-7] builds=${rows.length} regla antigua (StartedAt→HELLO > 5000) habría rechazado=${oldRuleWouldReject}`,
    );
    expect(
      rows.filter((x) => x.state !== "validated"),
      JSON.stringify(rows),
    ).toEqual([]);
  }, 600_000);

  it("no quedan contenedores bot-prcsbx tras las sesiones", async () => {
    const deadline = Date.now() + 20_000;
    let left = leftoverPrcsbx();
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      left = leftoverPrcsbx();
    }
    expect(left).toEqual([]);
  }, 30_000);
});
