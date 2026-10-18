/**
 * DEV-A · TD-001 — cableado ÚNICO del executor de builds.
 *
 * Lo usan build-worker-main.ts (servicio) y el E2E con Docker: así el test
 * ejercita exactamente el mismo cableado que producción (una mutación aquí lo
 * pone rojo). Configuración por entorno:
 *
 *   DOCKER_PROXY_URL     URL del s9-docker-proxy (única vía a Docker)
 *   BUILD_SANDBOX_HOST   nombre con el que los contenedores de la red arena
 *                        alcanzan a ESTE proceso (en Compose: bot-build-worker)
 *   BUILD_SANDBOX_BIND   interfaz de escucha del anfitrión (def. 0.0.0.0)
 *   ARENA_NETWORK        red de los bots (def. arena)
 *   RUNTIME_DIGESTS_LOCK ruta a runtimes/DIGESTS.lock (def. la del repo)
 *   SANDBOX_STARTUP_TIMEOUT_MS  reloj de plataforma hasta `ready` (def. 30000, TD-034)
 *   BOT_EXECUTION_TIMEOUT_MS    reloj del bot desde `ready` hasta HELLO (def. 5000, TD-034)
 *
 * Si falta DOCKER_PROXY_URL o BUILD_SANDBOX_HOST no se inventa nada: no hay
 * sandbox y el pipeline FALLA CERRADO (rechaza «sandbox no verificado»), que
 * es el comportamiento seguro y visible.
 */
import type { Knex } from "knex";
import { E6PipelineBotManager } from "../../api/src/services/e6-bot-manager.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import type { ServiceKeypair } from "./signing.js";
import { ProxyContainerRunner } from "./docker-proxy.js";
import { ContainerBuildSandbox } from "./build-sandbox.js";
import { loadRuntimeImages } from "./bot-launch.js";
import type { ContainerRunner } from "./container-runner.js";
import { startupTimeoutsFromEnv } from "./startup-clock.js";

export interface BuildExecutorWiring {
  executor: E6PipelineBotManager;
  /** null si el sandbox no está configurado (fail-closed). */
  sandbox: ContainerBuildSandbox | null;
  reason?: string;
}

export function createSandboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { runner?: ContainerRunner } = {},
): { sandbox: ContainerBuildSandbox | null; reason?: string } {
  const proxyUrl = env.DOCKER_PROXY_URL;
  const advertiseHost = env.BUILD_SANDBOX_HOST;
  if (!proxyUrl || !advertiseHost) {
    return { sandbox: null, reason: "DOCKER_PROXY_URL o BUILD_SANDBOX_HOST sin definir: sandbox no configurado" };
  }
  // TD-034 · parser único; un valor inválido hace fallar el arranque del servicio.
  const timeouts = startupTimeoutsFromEnv(env);
  const sandbox = new ContainerBuildSandbox({
    runner: opts.runner ?? new ProxyContainerRunner(proxyUrl),
    network: env.ARENA_NETWORK || "arena",
    advertiseHost,
    bindHost: env.BUILD_SANDBOX_BIND || "0.0.0.0",
    runtimeImages: loadRuntimeImages(env),
    referenceAgent: (id) => new HunterBot(id),
    timeouts,
  });
  return { sandbox };
}

export function createBuildExecutor(
  db: Knex,
  signer: ServiceKeypair,
  env: NodeJS.ProcessEnv = process.env,
): BuildExecutorWiring {
  const { sandbox, reason } = createSandboxFromEnv(env);
  const executor = new E6PipelineBotManager(db, { signer, ...(sandbox ? { sandbox } : {}) });
  return { executor, sandbox, reason };
}
