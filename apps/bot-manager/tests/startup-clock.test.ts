/**
 * PRC · TD-034 — arranque frente a ejecución en el sandbox de BUILD, sin Docker.
 *
 * ContainerBuildSandbox, SandboxHost, ProtocolServer y motor REALES; sólo el
 * contenedor lo sustituye FakeBootstrapRunner, que cumple el contrato del
 * bootstrap (descarga, `ready`, HELLO, COMMANDs) con retardos REALES por fase.
 * La versión con contenedores de verdad está en build-sandbox-timing-docker.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { packArtifact } from "../src/artifact.js";
import { ContainerBuildSandbox, SandboxInfrastructureError, type SandboxVerification } from "../src/build-sandbox.js";
import { createSandboxFromEnv } from "../src/build-worker-wiring.js";
import { withConfig } from "../src/config.js";
import {
  DEFAULT_STARTUP_TIMEOUTS,
  MAX_STARTUP_TIMEOUT_MS,
  startupTimeoutsFromEnv,
  type StartupTimeouts,
} from "../src/startup-clock.js";
import type { RuntimeImages } from "../src/bot-launch.js";
import { FakeBootstrapRunner, type FakeBootstrapBehaviour } from "./fake-bootstrap-runner.js";
import { submission } from "./fixtures.js";
import { pyFiles, PY_GOOD } from "./sandbox-bots.js";

const IMAGES: RuntimeImages = {
  python: `ghcr.io/example/runtime-python@sha256:${"1a".repeat(32)}`,
  node: `ghcr.io/example/runtime-node@sha256:${"2b".repeat(32)}`,
};
const CFG = withConfig({ smokeBattleTicks: 60 });
const files = pyFiles(PY_GOOD);
const art = packArtifact(files);

let runners: FakeBootstrapRunner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.closeAll();
});

beforeAll(async () => {
  await initPhysics();
});

function sandboxWith(b: FakeBootstrapBehaviour, timeouts: StartupTimeouts) {
  const runner = new FakeBootstrapRunner(() => b);
  runners.push(runner);
  const sandbox = new ContainerBuildSandbox({
    runner,
    network: "arena",
    advertiseHost: "127.0.0.1",
    bindHost: "127.0.0.1",
    runtimeImages: IMAGES,
    referenceAgent: (id) => new HunterBot(id),
    tickIntervalMs: 5,
    timeouts,
  });
  return { sandbox, runner };
}

async function verify(sb: ContainerBuildSandbox): Promise<SandboxVerification> {
  return sb.verify(submission(files, { archetype: "gunner" }), art, CFG);
}

describe("TD-034 · SAN-4 · configuración: declarada = efectiva", () => {
  it("defectos 30000/5000 y valores del entorno tal cual", () => {
    expect(startupTimeoutsFromEnv({})).toEqual({ sandboxStartupMs: 30_000, botExecutionMs: 5_000 });
    expect(DEFAULT_STARTUP_TIMEOUTS).toEqual({ sandboxStartupMs: 30_000, botExecutionMs: 5_000 });
    expect(startupTimeoutsFromEnv({ SANDBOX_STARTUP_TIMEOUT_MS: "", BOT_EXECUTION_TIMEOUT_MS: " " })).toEqual(
      DEFAULT_STARTUP_TIMEOUTS,
    );
    expect(startupTimeoutsFromEnv({ SANDBOX_STARTUP_TIMEOUT_MS: "45000", BOT_EXECUTION_TIMEOUT_MS: "2500" })).toEqual({
      sandboxStartupMs: 45_000,
      botExecutionMs: 2_500,
    });
  });

  it("un valor inválido NO se sustituye en silencio por el defecto: falla", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "5s", String(MAX_STARTUP_TIMEOUT_MS + 1)]) {
      expect(() => startupTimeoutsFromEnv({ SANDBOX_STARTUP_TIMEOUT_MS: bad }), bad).toThrow(
        /SANDBOX_STARTUP_TIMEOUT_MS/,
      );
      expect(() => startupTimeoutsFromEnv({ BOT_EXECUTION_TIMEOUT_MS: bad }), bad).toThrow(/BOT_EXECUTION_TIMEOUT_MS/);
    }
  });

  it("el cableado del servicio (createSandboxFromEnv) aplica EL valor configurado", async () => {
    const runner = new FakeBootstrapRunner(() => ({ hangAfterReady: true }));
    runners.push(runner);
    const made = createSandboxFromEnv(
      {
        DOCKER_PROXY_URL: "http://127.0.0.1:9",
        BUILD_SANDBOX_HOST: "127.0.0.1",
        BUILD_SANDBOX_BIND: "127.0.0.1",
        SANDBOX_STARTUP_TIMEOUT_MS: "4321",
        BOT_EXECUTION_TIMEOUT_MS: "1234",
      },
      { runner },
    );
    expect(made.sandbox!.timeouts).toEqual({ sandboxStartupMs: 4321, botExecutionMs: 1234 });
    const v = await made.sandbox!.verify(submission(files, { archetype: "gunner" }), art, CFG);
    const ready = runner.launches[0].marks.ready;
    const waited = performance.now() - ready;
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/en 1234 ms desde que el agente estuvo listo/);
    expect(v.protocol.metrics).toMatchObject({ botExecutionTimeoutMs: 1234, sandboxStartupTimeoutMs: 4321 });
    // EFECTIVO: el rechazo llega a los ~1234 ms de `ready`, no a los 5000 por defecto.
    expect(waited).toBeGreaterThanOrEqual(1200);
    expect(waited).toBeLessThan(2500);
  }, 20_000);
});

describe("TD-034 · SAN-5 · arranque lento de la PLATAFORMA no consume el reloj del bot", () => {
  it("Docker lento + runtime lento (≈3 s antes de `ready`) con bot de 300 ms y BOT_EXECUTION 1000 ms → PASS", async () => {
    const { sandbox, runner } = sandboxWith(
      { launchDelayMs: 1000, preFetchMs: 1000, preReadyMs: 1000, userInitMs: 300 },
      { sandboxStartupMs: 10_000, botExecutionMs: 1_000 },
    );
    const v = await verify(sandbox);
    expect(v.protocol.outcome, v.protocol.message).toBe("passed");
    expect(v.smoke.outcome, v.smoke.message).toBe("passed");
    expect(v.resources.outcome, v.resources.message).toBe("passed");
    const m = v.resources.metrics!;
    // Plataforma: ≥ 3 s (lo fabricado); bot: sólo su tramo, ≈ 300 ms.
    expect(m.startupMs).toBeGreaterThanOrEqual(2900);
    expect(m.launchMs).toBeGreaterThanOrEqual(950);
    expect(m.botReadyToHelloMs).toBeGreaterThanOrEqual(250);
    expect(m.botReadyToHelloMs).toBeLessThan(1000);
    // El tramo que juzgaba el código anterior (lanzamiento/StartedAt → HELLO)
    // supera con creces el plazo del bot: con un solo reloj, este bot válido
    // habría sido rechazado (TD-034).
    expect(m.startupMs + m.botReadyToHelloMs).toBeGreaterThan(1000);
    expect(m.executionMs).toBeGreaterThan(0);
    expect(runner.launches).toHaveLength(1);
  }, 30_000);
});

describe("TD-034 · SAN-6/SAN-10 · el límite del BOT no se debilita", () => {
  it("arranque rápido y código del bot por encima de BOT_EXECUTION_TIMEOUT → rechazo bot_execution_timeout", async () => {
    const { sandbox, runner } = sandboxWith({ userInitMs: 2500 }, { sandboxStartupMs: 10_000, botExecutionMs: 1_000 });
    const v = await verify(sandbox);
    const waited = performance.now() - runner.launches[0].marks.ready;
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/el bot no completó el handshake/);
    expect(v.protocol.message).toMatch(/timeout_reason=bot_execution_timeout/);
    expect(v.smoke.outcome).toBe("failed");
    expect(v.resources.outcome).toBe("failed");
    expect(waited).toBeGreaterThanOrEqual(950);
    expect(waited).toBeLessThan(2400);
  }, 20_000);

  it("bot infinito tras `ready` (nunca HELLO) → rechazo por timeout del bot, no infraestructura", async () => {
    const { sandbox } = sandboxWith({ hangAfterReady: true }, { sandboxStartupMs: 10_000, botExecutionMs: 800 });
    const v = await verify(sandbox);
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/timeout_reason=bot_execution_timeout/);
  }, 20_000);

  it("decisiones lentas tras el HELLO siguen rechazadas por maxDecisionMs (separar relojes no las ampara)", async () => {
    const { sandbox } = sandboxWith(
      { preReadyMs: 1500, decisionMs: 140 },
      { sandboxStartupMs: 10_000, botExecutionMs: 1_000 },
    );
    const v = await verify(sandbox);
    expect(v.resources.outcome).toBe("failed");
    expect(v.resources.message).toMatch(/decisión p95 \d+ ms > 100 ms/);
  }, 30_000);
});

describe("TD-034 · SAN-9 · clasificación: plataforma ⇒ infraestructura, código del bot ⇒ bot", () => {
  const T = { sandboxStartupMs: 1_500, botExecutionMs: 1_000 };

  it("la plataforma no llega a `ready` en SANDBOX_STARTUP_TIMEOUT → SandboxInfrastructureError, nunca rechazo", async () => {
    const { sandbox } = sandboxWith({ preReadyMs: 4000 }, T);
    const err = await verify(sandbox).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(/\[sandbox_start_timeout\]/);
  }, 20_000);

  it("Docker no devuelve el contenedor a tiempo → sandbox_start_timeout (infraestructura) y se para al llegar", async () => {
    const { sandbox, runner } = sandboxWith({ launchDelayMs: 2500 }, T);
    const t0 = performance.now();
    const err = await verify(sandbox).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(
      /el sandbox no pudo lanzar el contenedor: Docker no creó\/arrancó.*\[sandbox_start_timeout\]/,
    );
    expect(performance.now() - t0).toBeLessThan(2400);
    expect(runner.launches).toHaveLength(1);
  }, 20_000);

  it("Docker falla al lanzar (runtime/imagen ausente) → infraestructura", async () => {
    const { sandbox } = sandboxWith({ launchError: "No such image" }, T);
    const err = await verify(sandbox).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(
      /el sandbox no pudo lanzar el contenedor: No such image \[sandbox_start_failed\]/,
    );
  });

  it("el contenedor muere antes de `ready` sin informe → infraestructura", async () => {
    const { sandbox } = sandboxWith({ dieBeforeReady: true }, T);
    const err = await verify(sandbox).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxInfrastructureError);
    expect(String(err.message)).toMatch(/\[sandbox_start_failed\].*antes de que el agente estuviera listo/);
  }, 20_000);

  for (const kind of ["fetch", "integrity", "materialize", "sdk", "config"]) {
    it(`informe «${kind}» del bootstrap (plataforma) → infraestructura`, async () => {
      const { sandbox } = sandboxWith({ failBeforeReady: { kind, detail: `fallo ${kind}` } }, T);
      const err = await verify(sandbox).catch((e) => e);
      expect(err).toBeInstanceOf(SandboxInfrastructureError);
      expect(String(err.message)).toMatch(new RegExp(`\\[sandbox_start_failed\\] ${kind}: fallo ${kind}`));
    }, 20_000);
  }

  it("informe «entry» (el paquete del usuario no tiene entrada) → del bot, aunque sea antes de `ready`", async () => {
    const { sandbox } = sandboxWith({ failBeforeReady: { kind: "entry", detail: "no hay fichero de entrada" } }, T);
    const v = await verify(sandbox);
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/timeout_reason=bot_crash/);
    expect(v.protocol.message).toMatch(/entry: no hay fichero de entrada/);
  }, 20_000);

  it("el código del bot revienta al importar (tras `ready`) → del bot, con su traza", async () => {
    const { sandbox } = sandboxWith({ crashAfterReady: true }, T);
    const v = await verify(sandbox);
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/timeout_reason=bot_crash/);
    expect(v.protocol.message).toMatch(/fallo al importar el bot/);
  }, 20_000);

  it("tras `ready`, un informe de «plataforma» (fetch) lo envía el código del usuario: es del bot, no infraestructura", async () => {
    const { sandbox } = sandboxWith({ crashAfterReady: true, crashAfterReadyKind: "fetch" }, T);
    const v = await verify(sandbox);
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/timeout_reason=bot_crash/);
  }, 20_000);

  it("señal `ready` perdida pero HELLO a tiempo → el bot pasa (el HELLO prueba la readiness)", async () => {
    const { sandbox } = sandboxWith({ skipReady: true }, T);
    const v = await verify(sandbox);
    expect(v.protocol.outcome, v.protocol.message).toBe("passed");
    expect(v.protocol.logs.join("\n")).toMatch(/sin señal ready/);
  }, 20_000);
});

describe("TD-034 · señal `ready` del SandboxHost", () => {
  it("exige el token de la oferta, registra sólo la primera y avisa a los suscriptores", async () => {
    const { SandboxHost } = await import("../src/sandbox-host.js");
    const host = await SandboxHost.start({ advertiseHost: "127.0.0.1", bindHost: "127.0.0.1", port: 0 });
    try {
      const offer = host.offerArtifact(Buffer.from("x"), "0".repeat(64));
      let pokes = 0;
      offer.signals.onChange(() => pokes++);
      const noToken = await fetch(offer.url + "/ready", { method: "POST" });
      expect(noToken.status).toBe(403);
      const wrong = await fetch(offer.url + "/ready", {
        method: "POST",
        headers: { "x-s9-artifact-token": "f".repeat(64) },
      });
      expect(wrong.status).toBe(403);
      expect(offer.signals.readyAt()).toBeNull();
      const headers = { "x-s9-artifact-token": offer.token };
      expect((await fetch(offer.url + "/ready", { method: "POST", headers })).status).toBe(204);
      const first = offer.signals.readyAt();
      expect(first).not.toBeNull();
      expect((await fetch(offer.url + "/ready", { method: "POST", headers })).status).toBe(204);
      expect(offer.signals.readyAt()).toBe(first);
      expect(pokes).toBe(1);
      expect((await fetch(offer.url + "/ready", { headers })).status).toBe(405);
      offer.revoke();
      expect((await fetch(offer.url + "/ready", { method: "POST", headers })).status).toBe(404);
    } finally {
      await host.close();
    }
  });
});
