/**
 * DEV-A · TD-001 — pipeline de build con el SANDBOX REAL (Docker, opt-in).
 *
 * Sin mocks del sandbox ni del runner: ProxyContainerRunner → s9-docker-proxy
 * real → Docker de esta máquina, imagen de runtime fijada por digest, bootstrap
 * que descarga el artefacto, protocolo arena/1 real y motor real.
 *
 * Opt-in: S9_RUN_DOCKER_SANDBOX_E2E=1. Sin la variable, el fichero entero queda
 * SKIPPED (no es un verde: lo dice el runner).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BuildPipeline } from "../src/pipeline.js";
import { InMemoryBuildStore } from "../src/store.js";
import { withConfig } from "../src/config.js";
import { generateServiceKeypair } from "../src/signing.js";
import { packArtifact } from "../src/artifact.js";
import { createSandboxFromEnv } from "../src/build-worker-wiring.js";
import { SandboxInfrastructureError, type ContainerBuildSandbox } from "../src/build-sandbox.js";
import { submission } from "./fixtures.js";
import { DOCKER_E2E, startDockerSandboxEnv, leftoverBotContainers, type DockerSandboxEnv } from "./docker-sandbox-env.js";
import { PY_GOOD, PY_BAD_PROTOCOL, PY_HANG, PY_CRASH, PY_SYNTAX_ERROR, JS_GOOD, pyFiles, jsFiles } from "./sandbox-bots.js";
import type { SourceFile } from "../src/types.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";

let env: DockerSandboxEnv;
let sandbox: ContainerBuildSandbox;
const signer = generateServiceKeypair();

function pipeline(sb = sandbox, ticks = 300) {
  return new BuildPipeline({ store: new InMemoryBuildStore(), config: withConfig({ smokeBattleTicks: ticks }), signer, sandbox: sb });
}

const stage = (b: { stages: { name: string; status: string; message?: string }[] }, n: string) =>
  b.stages.find((s) => s.name === n)!;

describe.skipIf(!DOCKER_E2E)("TD-001 · sandbox REAL en el pipeline (Docker)", () => {
  beforeAll(async () => {
    await initPhysics();
    env = await startDockerSandboxEnv();
    const made = createSandboxFromEnv({
      DOCKER_PROXY_URL: env.proxyUrl,
      BUILD_SANDBOX_HOST: env.advertiseHost,
      ARENA_NETWORK: "arena",
    });
    if (!made.sandbox) throw new Error(made.reason);
    sandbox = made.sandbox;
  }, 60_000);

  afterAll(async () => {
    await env?.stop();
  });

  it("bot Python válido: las 10 etapas pasan EJECUTANDO el código en el contenedor → validated", async () => {
    const b = await pipeline(sandbox, 600).run(submission(pyFiles(PY_GOOD), { archetype: "gunner" }));
    expect(b.rejectionReason).toBeUndefined();
    expect(b.status).toBe("passed");
    expect(b.botVersionState).toBe("validated");
    for (const s of b.stages) expect(s.status, `${s.name}: ${s.message}`).toBe("passed");
    expect(b.stages.find((s) => s.name === "protocol_test")!.logs.join("\n")).toMatch(/postura del contenedor conforme/);
    const m = b.stages.find((s) => s.name === "resource_limits")!.metrics!;
    expect(m.validCommands).toBeGreaterThan(50);
    expect(m.startupMs).toBeLessThan(5000);
    // El proxy fue la ÚNICA vía y aceptó create/start del contenedor del bot.
    expect(env.decisions.some((d) => d.allowed && d.path.startsWith("/containers/create"))).toBe(true);
  });

  it("bot Node válido (ES module) → validated", async () => {
    const b = await pipeline().run(submission(jsFiles(JS_GOOD), { runtime: "node", archetype: "scout" }));
    expect(b.rejectionReason).toBeUndefined();
    expect(b.botVersionState).toBe("validated");
  });

  it("NEGATIVO · source inválido (sintaxis): rejected en static_analysis, sin llegar al sandbox", async () => {
    const before = env.decisions.length;
    const b = await pipeline().run(submission(pyFiles(PY_SYNTAX_ERROR)));
    expect(b.botVersionState).toBe("rejected");
    expect(stage(b, "static_analysis").status).toBe("failed");
    expect(env.decisions.slice(before).some((d) => d.path.startsWith("/containers/create"))).toBe(false);
  });

  it("NEGATIVO · timeout de arranque (bucle infinito al importar): rejected en protocol_test por handshake", async () => {
    const b = await pipeline().run(submission(pyFiles(PY_HANG)));
    expect(b.botVersionState).toBe("rejected");
    expect(stage(b, "protocol_test").status).toBe("failed");
    expect(b.rejectionReason).toMatch(/protocol_test: el bot no completó el handshake/);
  });

  it("NEGATIVO · bot que compila pero viola el protocolo: rejected en protocol_test con el error de esquema", async () => {
    const b = await pipeline().run(submission(pyFiles(PY_BAD_PROTOCOL)));
    expect(b.botVersionState).toBe("rejected");
    expect(b.rejectionReason).toMatch(/protocol_test: mensaje\(s\) fuera de protocolo/);
  });

  it("NEGATIVO · bot que revienta en la primera observación: rejected y el motivo trae su traza", async () => {
    const b = await pipeline().run(submission(pyFiles(PY_CRASH)));
    expect(b.botVersionState).toBe("rejected");
    expect(b.rejectionReason).toMatch(/protocol_test: ningún COMMAND válido/);
    expect(b.rejectionReason).toMatch(/fallo deliberado del bot/);
  });

  it("NEGATIVO · artefacto inválido (bytes que no son los firmados): el bootstrap se niega a ejecutarlo", async () => {
    const files: SourceFile[] = pyFiles(PY_GOOD);
    const good = packArtifact(files);
    const tampered = Buffer.concat([good.bytes, Buffer.from("x")]);
    const v = await sandbox.verify(
      submission(files),
      { bytes: tampered, hash: good.hash },
      withConfig({ smokeBattleTicks: 300 }),
    );
    expect(v.protocol.outcome).toBe("failed");
    expect(v.protocol.message).toMatch(/integrity/);
  });

  it("NEGATIVO · fallo del sandbox (proxy inaccesible): SandboxInfrastructureError, NUNCA validated", async () => {
    const broken = createSandboxFromEnv({
      DOCKER_PROXY_URL: "http://127.0.0.1:9",
      BUILD_SANDBOX_HOST: env.advertiseHost,
    }).sandbox!;
    await expect(pipeline(broken).run(submission(pyFiles(PY_GOOD)))).rejects.toBeInstanceOf(SandboxInfrastructureError);
  });

  it("no quedan contenedores de bot tras las sesiones", async () => {
    expect(await leftoverBotContainers()).toEqual([]);
  });
});
