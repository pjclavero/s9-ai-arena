/**
 * R1.7 / RC2 · Entrypoint del proxy de la API de Docker. Corre EN EL HOST (fuera
 * del Compose, unidad systemd s9-docker-proxy): es el ÚNICO proceso que toca
 * /var/run/docker.sock. Los consumidores (bot-build-worker, tournament-worker…)
 * lo alcanzan por la red dedicada `bot-control` en http://docker-proxy.internal:2375
 * (alias a la IP de gateway 10.89.250.1; ver docs/operations/docker-proxy.md).
 *
 * Uso: npx tsx apps/bot-manager/src/docker-proxy-main.ts
 *
 * Variables (todas validadas por proxyConfigFromEnv; cualquier error ⇒ no arranca,
 * exit 78 = EX_CONFIG):
 *   DOCKER_PROXY_BIND            OBLIGATORIA. IP literal; prohibidos 0.0.0.0, ::,
 *                                la IP de docker0 y `host-gateway`. Producción: 10.89.250.1.
 *   DOCKER_PROXY_PORT            2375.
 *   DOCKER_PROXY_ALLOWED_CLIENTS CIDR/IP de ORIGEN admitidos (coma). Obligatoria si el
 *                                bind no es loopback. Producción: 10.89.250.0/24.
 *   DOCKER_PROXY_IMAGE_ALLOWLIST ruta a un DIGESTS.lock (3.ª columna). Defecto: el del árbol.
 *   DOCKER_PROXY_INSTANCE        label s9.proxy.instance (defecto s9-docker-proxy).
 *   DOCKER_SOCKET                /var/run/docker.sock.
 *   ARENA_NETWORK                arena.   SANDBOX_USER  10001:10001.
 *   DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1  SÓLO TESTS: admite bind comodín/docker0.
 *
 * Si el bind falla (p. ej. EADDRNOTAVAIL porque el bridge s9-botctl0 aún no
 * existe) sale con 1: la unidad reintenta. Nunca cae a otra dirección.
 */
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { createDockerProxyServer, createSocketBackend } from "./docker-proxy.js";
import { proxyConfigFromEnv } from "./docker-proxy-config.js";

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "docker-proxy", ...fields }));

let cfg: ReturnType<typeof proxyConfigFromEnv>;
try {
  cfg = proxyConfigFromEnv(process.env, networkInterfaces());
} catch (e) {
  log({ level: "error", msg: `configuración rechazada, el proxy NO arranca: ${(e as Error).message}` });
  process.exit(78);
}
for (const w of cfg.warnings) log({ level: "warn", msg: w });

const server = createDockerProxyServer({
  backend: createSocketBackend(cfg.socketPath),
  policy: cfg.policy,
  allowedClients: cfg.allowedClients,
  onDecision: (entry) => log({ ...entry }),
});

server.on("error", (e) => {
  log({ level: "error", msg: `no se pudo escuchar en ${cfg.bind}:${cfg.port}: ${(e as Error).message}` });
  process.exit(1);
});

server.listen(cfg.port, cfg.bind, () => {
  const a = server.address() as AddressInfo;
  log({
    msg:
      `proxy de Docker escuchando en ${a.address}:${a.port} → ${cfg.socketPath} ` +
      `(red=${cfg.policy.allowedNetwork}, user=${cfg.policy.allowedUser})`,
    allowedClients: cfg.allowedClients,
    imageAllowlist: { path: cfg.imageAllowlistPath, images: [...cfg.policy.imageAllowlist] },
    instance: cfg.policy.instance,
  });
});
