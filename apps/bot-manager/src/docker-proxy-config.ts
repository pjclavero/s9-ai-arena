/**
 * RC2 (DEV-PROXY) · Configuración del PROCESO del proxy en el host, desde su entorno.
 *
 * Módulo aparte a propósito: lo importa SÓLO docker-proxy-main.ts. docker-proxy.ts lo
 * importan también los consumidores (tournament-worker, arena-engine, bot-build-worker
 * vía ProxyContainerRunner) y las variables DOCKER_PROXY_* son del proceso del host,
 * no de ellos (infrastructure/tests/service-env-contract.test.ts lo comprueba por AST
 * sobre el grafo de imports de cada servicio).
 */
import net from "node:net";
import {
  DEFAULT_IMAGE_ALLOWLIST_PATH,
  DEFAULT_POLICY,
  DEFAULT_PROXY_INSTANCE,
  INSTANCE_RE,
  LOOPBACK_CLIENTS,
  type ProxyPolicy,
  loadImageAllowlist,
  normalizeAddress,
  parseAllowedClients,
} from "./docker-proxy.js";

export interface ProxyRuntimeConfig {
  bind: string;
  port: number;
  socketPath: string;
  policy: ProxyPolicy & { imageAllowlist: ReadonlySet<string>; instance: string };
  allowedClients: string[];
  /** Orígenes siempre rechazados (bind, direcciones locales, DOCKER_PROXY_DENIED_CLIENTS). */
  deniedClients: string[];
  imageAllowlistPath: string;
  warnings: string[];
}

type Interfaces = Record<string, Array<{ address: string }> | undefined>;

/**
 * Traduce el entorno del proceso a configuración, FALLANDO CERRADO (lanza) ante:
 *   - DOCKER_PROXY_BIND ausente/vacío, no IP literal (`host-gateway`, nombres),
 *     comodín (0.0.0.0, ::) o asignada a docker0 — salvo
 *     DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1, que sólo relaja comodín/docker0;
 *   - bind no loopback sin DOCKER_PROXY_ALLOWED_CLIENTS explícito;
 *   - lista de clientes o allowlist de imágenes ilegible/vacía;
 *   - puerto o instancia no válidos.
 * `interfaces` = os.networkInterfaces() (inyectable en tests).
 */
export function proxyConfigFromEnv(env: NodeJS.ProcessEnv, interfaces: Interfaces = {}): ProxyRuntimeConfig {
  const warnings: string[] = [];
  const insecureOptIn = env.DOCKER_PROXY_INSECURE_BIND_FOR_TESTS === "1";
  const bind = (env.DOCKER_PROXY_BIND ?? "").trim();
  if (!bind)
    throw new Error("DOCKER_PROXY_BIND es obligatorio (sin valor por defecto: el proxy no elige dónde escuchar)");
  const family = net.isIP(bind);
  if (!family)
    throw new Error(`DOCKER_PROXY_BIND debe ser una IP literal (recibido: ${bind}; host-gateway/nombres prohibidos)`);
  const fam = family === 4 ? "ipv4" : "ipv6";
  const wildcard = new net.BlockList();
  wildcard.addAddress("0.0.0.0", "ipv4");
  wildcard.addAddress("::", "ipv6");
  const isWildcard = wildcard.check(bind, fam);
  const docker0 = (interfaces.docker0 ?? []).some((a) => normalizeAddress(a.address) === bind);
  if (isWildcard || docker0) {
    const why = isWildcard ? `comodín ${bind} (todas las interfaces)` : `${bind} es la IP de docker0`;
    if (!insecureOptIn) throw new Error(`DOCKER_PROXY_BIND prohibido: ${why}`);
    warnings.push(`DOCKER_PROXY_INSECURE_BIND_FOR_TESTS=1: se admite ${why}. SÓLO PARA TESTS.`);
  }
  const loopback = new net.BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  loopback.addAddress("::1", "ipv6");
  const bindIsLoopback = loopback.check(bind, fam);

  const portRaw = (env.DOCKER_PROXY_PORT ?? "2375").trim();
  const port = Number(portRaw);
  if (!/^\d{1,5}$/.test(portRaw) || port < 1 || port > 65535)
    throw new Error(`DOCKER_PROXY_PORT no válido: ${portRaw}`);

  const clientsRaw = (env.DOCKER_PROXY_ALLOWED_CLIENTS ?? "").trim();
  if (!clientsRaw && !bindIsLoopback)
    throw new Error(
      `DOCKER_PROXY_ALLOWED_CLIENTS es obligatorio si el bind no es loopback (${bind}): ` +
        "sin él, cualquier contenedor con ruta al host alcanzaría el proxy",
    );
  const allowedClients = parseAllowedClients(clientsRaw || LOOPBACK_CLIENTS).list;

  // Exclusión (prevalece sobre la admitida): la IP de bind, toda dirección local del
  // host (un proceso del host que conecta a la IP del bridge sale con ESA IP de
  // origen, dentro de la subred admitida) y DOCKER_PROXY_DENIED_CLIENTS. Con bind
  // loopback, loopback NO se excluye: ahí los clientes legítimos son procesos locales.
  const isLoopback = (a: string) => {
    const f = net.isIP(a);
    return f !== 0 && loopback.check(a, f === 4 ? "ipv4" : "ipv6");
  };
  const local = Object.values(interfaces)
    .flatMap((addrs) => addrs ?? [])
    .map((a) => normalizeAddress(a.address.split("%")[0]))
    .filter((a) => net.isIP(a) !== 0);
  const denied = new Set<string>();
  for (const a of [...(isWildcard ? [] : [bind]), ...local]) {
    if (bindIsLoopback && isLoopback(a)) continue;
    denied.add(a);
  }
  const deniedRaw = (env.DOCKER_PROXY_DENIED_CLIENTS ?? "").trim();
  const deniedClients = [...denied, ...(deniedRaw ? parseAllowedClients(deniedRaw).list : [])];

  const imageAllowlistPath = (env.DOCKER_PROXY_IMAGE_ALLOWLIST ?? "").trim() || DEFAULT_IMAGE_ALLOWLIST_PATH;
  const imageAllowlist = loadImageAllowlist(imageAllowlistPath);

  const instance = (env.DOCKER_PROXY_INSTANCE ?? "").trim() || DEFAULT_PROXY_INSTANCE;
  if (!INSTANCE_RE.test(instance)) throw new Error(`DOCKER_PROXY_INSTANCE no válido: ${instance}`);

  return {
    bind,
    port,
    socketPath: env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    policy: {
      ...DEFAULT_POLICY,
      allowedNetwork: env.ARENA_NETWORK ?? DEFAULT_POLICY.allowedNetwork,
      allowedUser: env.SANDBOX_USER ?? DEFAULT_POLICY.allowedUser,
      imageAllowlist,
      instance,
    },
    allowedClients,
    deniedClients,
    imageAllowlistPath,
    warnings,
  };
}
