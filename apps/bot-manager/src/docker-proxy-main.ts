/**
 * R1.7 · Entrypoint del proxy de la API de Docker. Corre EN EL HOST (fuera
 * del Compose): es el único proceso que toca /var/run/docker.sock. El
 * bot-manager lo alcanza vía DOCKER_PROXY_URL (por defecto el alias
 * docker-proxy.internal → host-gateway del Compose).
 *
 * Uso (R-DEPLOY, p. ej. unidad systemd del operador):
 *   npx tsx apps/bot-manager/src/docker-proxy-main.ts
 *
 * Variables: DOCKER_PROXY_BIND (127.0.0.1), DOCKER_PROXY_PORT (2375),
 * DOCKER_SOCKET (/var/run/docker.sock), ARENA_NETWORK (arena),
 * SANDBOX_USER (10001:10001).
 *
 * PENDIENTE R-DEPLOY: verificación viva contra el socket real (aquí no hay
 * Docker; la lógica está probada en proceso en tests/docker-proxy.test.ts).
 */
import { DEFAULT_POLICY, createDockerProxyServer, createSocketBackend } from "./docker-proxy.js";

const bind = process.env.DOCKER_PROXY_BIND ?? "127.0.0.1";
const port = Number(process.env.DOCKER_PROXY_PORT ?? 2375);
const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const policy = {
  ...DEFAULT_POLICY,
  allowedNetwork: process.env.ARENA_NETWORK ?? DEFAULT_POLICY.allowedNetwork,
  allowedUser: process.env.SANDBOX_USER ?? DEFAULT_POLICY.allowedUser,
};

const server = createDockerProxyServer({
  backend: createSocketBackend(socketPath),
  policy,
  onDecision: (entry) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), service: "docker-proxy", ...entry })),
});

server.listen(port, bind, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "docker-proxy",
      msg: `proxy de Docker escuchando en ${bind}:${port} → ${socketPath} (red=${policy.allowedNetwork}, user=${policy.allowedUser})`,
    }),
  );
});
