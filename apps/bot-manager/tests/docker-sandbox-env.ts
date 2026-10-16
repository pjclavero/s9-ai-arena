/**
 * DEV-A · entorno REAL para los tests del sandbox con Docker (opt-in).
 *
 * Reproduce en local la topología de producción sin tocarla:
 *   - el s9-docker-proxy REAL (createDockerProxyServer) en 127.0.0.1:<libre>,
 *     reenviando al socket de Docker de ESTA máquina (rootless de ia02);
 *   - la red `arena` (nombre exigido por compliance) en ese Docker;
 *   - el anfitrión del sandbox anunciado en una IP de esta máquina alcanzable
 *     desde los contenedores.
 *
 * Diferencia declarada con producción: en Compose `arena` es `internal: true` y
 * el worker vive dentro de ella; aquí el worker es el proceso de test en el host,
 * así que la red local NO puede ser interna (si no, el contenedor no llegaría al
 * host). El aislamiento que se prueba es el del contenedor (usuario, caps,
 * seccomp, rootfs ro, límites), no el de la red.
 *
 * Variables: S9_RUN_DOCKER_SANDBOX_E2E=1 (obligatoria), DOCKER_HOST/DOCKER_SOCKET
 * (socket; def. el rootless del usuario), S9_SANDBOX_ADVERTISE_HOST (IP/host
 * alcanzable desde los contenedores; def. la primera IPv4 no interna).
 */
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createDockerProxyServer, createSocketBackend, DEFAULT_POLICY } from "../src/docker-proxy.js";

export const DOCKER_E2E = process.env.S9_RUN_DOCKER_SANDBOX_E2E === "1";

export function dockerSocketPath(): string {
  if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
  const h = process.env.DOCKER_HOST;
  if (h?.startsWith("unix://")) return h.slice("unix://".length);
  const uid = process.getuid?.() ?? 0;
  return uid === 0 ? "/var/run/docker.sock" : `/run/user/${uid}/docker.sock`;
}

export function advertiseHost(): string {
  if (process.env.S9_SANDBOX_ADVERTISE_HOST) return process.env.S9_SANDBOX_ADVERTISE_HOST;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|tailscale|lo)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no hay IPv4 no interna: define S9_SANDBOX_ADVERTISE_HOST");
}

export interface DockerSandboxEnv {
  proxyUrl: string;
  advertiseHost: string;
  decisions: { method: string; path: string; allowed: boolean; reason?: string }[];
  stop(): Promise<void>;
}

export async function startDockerSandboxEnv(): Promise<DockerSandboxEnv> {
  const socket = dockerSocketPath();
  let createdNetwork = false;
  try {
    execFileSync("docker", ["network", "inspect", "arena"], { stdio: "ignore" });
  } catch {
    execFileSync("docker", ["network", "create", "arena"], { stdio: "ignore" });
    createdNetwork = true;
  }
  const decisions: DockerSandboxEnv["decisions"] = [];
  const server: http.Server = createDockerProxyServer({
    backend: createSocketBackend(socket),
    policy: DEFAULT_POLICY,
    onDecision: (d) => decisions.push(d),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    advertiseHost: advertiseHost(),
    decisions,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      if (createdNetwork) {
        try {
          execFileSync("docker", ["network", "rm", "arena"], { stdio: "ignore" });
        } catch {
          /* algún contenedor colgado la retiene: no es fatal para el test */
        }
      }
    },
  };
}

/** Contenedores de bot que sigan existiendo (deben ser 0 al terminar). AutoRemove
 *  es asíncrono en la Engine: se da un margen antes de declarar restos. */
export async function leftoverBotContainers(graceMs = 15_000): Promise<string[]> {
  const deadline = Date.now() + graceMs;
  let left = listBotContainers();
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    left = listBotContainers();
  }
  return left;
}

function listBotContainers(): string[] {
  const out = execFileSync("docker", ["ps", "-a", "--filter", "name=^bot-", "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}
