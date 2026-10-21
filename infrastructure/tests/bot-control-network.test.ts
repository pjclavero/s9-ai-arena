/**
 * RC2 · DEV-NET — red de control del s9-docker-proxy (`bot-control`).
 *
 * Por qué existe (RC1 = DEPLOYMENT_BLOCKED, gate F): los consumidores del proxy
 * vivían sólo en redes `internal: true` y el alias apuntaba a `host-gateway`
 * (docker0) ⇒ ENETUNREACH; y nadie probaba qué servicio podía o no alcanzarlo.
 *
 * Qué fija, SIEMPRE sobre el compose RESUELTO (`docker compose config --format
 * json`, con un .env vacío para ver los defectos reales), nunca sobre el texto:
 *   1. la red `bot-control` cumple el CONTRATO de la RC2 (nombre, bridge, subred,
 *      gateway, internal);
 *   2. sus miembros son EXACTAMENTE los servicios que, por código, instancian
 *      `ProxyContainerRunner` (AST del grafo de imports desde su SERVICE_ENTRY),
 *      en todos los perfiles que los renderizan;
 *   3. el alias `docker-proxy.internal` va a la IP fija del gateway de esa red y
 *      ningún servicio usa `host-gateway`;
 *   4. el interruptor de ejecución real se mantiene (URL vacía por defecto en
 *      tournament-worker y arena-engine);
 *   5. el compose no publica ni expone 2375, no usa `network_mode: host` ni
 *      publica puertos nuevos;
 *   6. el conjunto de servicios con RUTA POR DEFECTO al host (alguna red no
 *      interna) queda fijado: esa es la conectividad residual hacia
 *      10.89.250.1 que esta red NO cierra (la cierran el firewall del host y el
 *      control de cliente del proxy). Un servicio nuevo en `public` lo pone ROJO.
 *
 * Techo declarado (lo que esta red NO ve):
 *   - consumo del proxy que no pase por `new ProxyContainerRunner(...)` (p. ej. un
 *     `fetch` crudo a DOCKER_PROXY_URL), alias de importación renombrados o
 *     imports con especificador calculado; dependencias de node_modules;
 *   - la conectividad EFECTIVA (rutas, firewall): eso lo mide la sonda
 *     scripts/ops/network-probe.mjs contra contenedores reales, y la CI de
 *     contenedor → proxy.
 *
 * La ausencia del CLI de Compose NO es un aprobado: el test FALLA, no se omite.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import * as acorn from "acorn";

const AQUI = dirname(fileURLToPath(import.meta.url));
const REPO = join(AQUI, "..", "..");
const COMPOSE = join(REPO, "infrastructure", "docker-compose.yml");

// ── CONTRATO RC2 (COMMON-RC2.md). Cambiarlo es cambiar el contrato entre carriles.
const NET_KEY = "bot-control";
const NET_NAME = "s9-bot-control";
const BRIDGE = "s9-botctl0";
const SUBNET = "10.89.250.0/24";
const GATEWAY_IP = "10.89.250.1";
const PROXY_ALIAS = "docker-proxy.internal";
const PROXY_PORT = 2375;
const DEFAULT_URL = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
/** Perfiles que despliegan servicios de aplicación (+ bots, que no debe entrar). */
const PROFILES = ["production", "development", "external-db", "nucleo", "bots"];
/** Servicios con red no interna, por perfil producción: la conectividad residual. */
const DEFAULT_ROUTE_PRODUCTION = ["backup", "gateway"];

type Svc = {
  networks?: Record<string, unknown>;
  network_mode?: string;
  extra_hosts?: string[] | Record<string, string>;
  environment?: Record<string, string | null>;
  ports?: Array<{ target: number; published?: string }>;
  expose?: Array<string | number>;
};
type Net = {
  name?: string;
  driver?: string;
  internal?: boolean;
  external?: boolean;
  driver_opts?: Record<string, string>;
  ipam?: { config?: Array<{ subnet?: string; gateway?: string }> };
};
type Config = { services: Record<string, Svc>; networks: Record<string, Net> };

// ── Render del compose ─────────────────────────────────────────────────────────
const composeCli = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const EMPTY_ENV = join(mkdtempSync(join(tmpdir(), "rc2net-env-")), "empty.env");
writeFileSync(EMPTY_ENV, "");

/** Compose resuelto con un .env VACÍO y sin DOCKER_PROXY_URL heredado del shell. */
export function render(profile: string, composePath = COMPOSE): Config {
  if (!composeCli) {
    throw new Error("docker compose no disponible: esta comprobación no se puede omitir (skipped ≠ PASS)");
  }
  const env = { ...process.env };
  delete env.DOCKER_PROXY_URL;
  delete env.COMPOSE_PROFILES;
  delete env.COMPOSE_FILE;
  const out = execFileSync(
    "docker",
    ["compose", "-f", composePath, "--env-file", EMPTY_ENV, "--profile", profile, "config", "--format", "json"],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as Config;
}

function extraHosts(s: Svc): Map<string, string> {
  const m = new Map<string, string>();
  const eh = s.extra_hosts;
  if (Array.isArray(eh)) {
    for (const e of eh) {
      // Compose v2 canoniza `host:ip` a `host=ip`; aceptamos ambos.
      const i = e.includes("=") ? e.indexOf("=") : e.indexOf(":");
      m.set(e.slice(0, i), e.slice(i + 1));
    }
  } else if (eh) {
    for (const [k, v] of Object.entries(eh)) m.set(k, String(v));
  }
  return m;
}

const nets = (s: Svc): string[] => Object.keys(s.networks ?? {});

function toRange(cidr: string): [number, number] {
  const [ip, bits] = cidr.split("/");
  const n = ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(bits));
  return [n - (n % size), n - (n % size) + size - 1];
}
export function overlap(a: string, b: string): boolean {
  const [a0, a1] = toRange(a);
  const [b0, b1] = toRange(b);
  return a0 <= b1 && b0 <= a1;
}

export function members(c: Config): string[] {
  return Object.entries(c.services)
    .filter(([, s]) => nets(s).includes(NET_KEY))
    .map(([n]) => n)
    .sort();
}

/** Servicios con alguna red NO interna ⇒ ruta por defecto hacia el host. */
export function defaultRouteServices(c: Config): string[] {
  return Object.entries(c.services)
    .filter(([, s]) => s.network_mode === "host" || nets(s).some((n) => c.networks[n]?.internal !== true))
    .map(([n]) => n)
    .sort();
}

// ── NEEDS_PROXY por código: AST del grafo de imports desde SERVICE_ENTRY ───────
type AnyNode = { type: string; [k: string]: unknown };

function parseFile(file: string): AnyNode {
  let src = readFileSync(file, "utf8");
  if (file.endsWith(".ts")) src = stripTypeScriptTypes(src, { mode: "transform" });
  return acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }) as unknown as AnyNode;
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const cand of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`]) {
    if (existsSync(cand) && /\.(ts|mjs|js)$/.test(cand)) return cand;
  }
  return null;
}

/** Ficheros del grafo alcanzable desde `entry` que contienen `new ProxyContainerRunner(...)`. */
export function proxyRunnerSites(entry: string): string[] {
  const sites = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const visit = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(visit);
      const node = n as AnyNode;
      const src = node.source as AnyNode | undefined;
      if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration" ||
          node.type === "ImportExpression") &&
        src?.type === "Literal" &&
        typeof src.value === "string"
      ) {
        const r = resolveImport(file, src.value);
        if (r) queue.push(r);
      }
      if (node.type === "NewExpression") {
        const callee = node.callee as AnyNode;
        if (callee.type === "Identifier" && callee.name === "ProxyContainerRunner") {
          sites.add(file.slice(REPO.length + 1));
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "type") visit(v);
    };
    visit(parseFile(file));
  }
  return [...sites].sort();
}

/** SERVICE / NEEDS_PROXY para todos los servicios del render (no Node ⇒ false). */
export function needsProxyMatrix(c: Config): Record<string, { entry: string | null; sites: string[] }> {
  const out: Record<string, { entry: string | null; sites: string[] }> = {};
  for (const [name, s] of Object.entries(c.services)) {
    const entry = s.environment?.SERVICE_ENTRY ?? null;
    out[name] = { entry, sites: entry ? proxyRunnerSites(join(REPO, entry)) : [] };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
describe("RC2 · bot-control — contrato de la red (compose resuelto)", () => {
  const prod = render("production");
  const net = prod.networks[NET_KEY];

  it("existe con nombre fijo, bridge, internal y sin ser external", () => {
    expect(net, "falta la red bot-control").toBeDefined();
    expect(net.name).toBe(NET_NAME);
    expect(net.driver).toBe("bridge");
    expect(net.internal).toBe(true);
    expect(net.external ?? false).toBe(false);
  });

  it("bridge del host, subred y gateway fijos (los consume el proxy y el firewall del host)", () => {
    expect(net.driver_opts?.["com.docker.network.bridge.name"]).toBe(BRIDGE);
    expect(BRIDGE.length).toBeLessThanOrEqual(15); // IFNAMSIZ-1
    expect(net.ipam?.config).toEqual([{ subnet: SUBNET, gateway: GATEWAY_IP }]);
  });

  it("la subred no solapa con los pools por defecto de Docker ni con otra red declarada", () => {
    // Pools por defecto de dockerd (default-address-pools) + docker0.
    for (const pool of ["172.17.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]) {
      expect(overlap(SUBNET, pool), pool).toBe(false);
    }
    for (const [k, n] of Object.entries(prod.networks)) {
      if (k === NET_KEY) continue;
      for (const cfg of n.ipam?.config ?? []) if (cfg.subnet) expect(overlap(SUBNET, cfg.subnet), k).toBe(false);
    }
  });

  it("control de la aritmética: un solape conocido SÍ se detecta (si falla, el verde anterior no vale)", () => {
    expect(overlap(SUBNET, "10.89.0.0/16")).toBe(true);
    expect(overlap(SUBNET, "10.89.250.128/25")).toBe(true);
    expect(overlap("172.17.0.0/16", "172.16.0.0/12")).toBe(true);
    expect(overlap(SUBNET, "10.89.251.0/24")).toBe(false);
  });
});

describe("RC2 · bot-control — miembros = consumidores del proxy por código (N1/N2/N3)", () => {
  const prod = render("production");
  const matrix = needsProxyMatrix(prod);
  const consumers = Object.entries(matrix)
    .filter(([, v]) => v.sites.length > 0)
    .map(([k]) => k)
    .sort();

  it("matriz SERVICE / NEEDS_PROXY verificada en código (AST desde SERVICE_ENTRY)", () => {
    // Fijada a propósito: un consumidor nuevo o uno que deja de serlo es un cambio
    // de topología que se revisa, no que se absorbe.
    expect(consumers).toEqual(["arena-engine", "bot-build-worker", "tournament-worker"]);
    // bot-manager (control) NO es consumidor: sólo exige la URL no vacía.
    expect(matrix["bot-manager"].entry).toBe("apps/bot-manager/src/main.ts");
    expect(matrix["bot-manager"].sites).toEqual([]);
  });

  it("control positivo del extractor: ve los tres sitios de instanciación reales", () => {
    expect(matrix["tournament-worker"].sites).toContain("apps/tournament-worker/src/main.ts");
    expect(matrix["bot-build-worker"].sites).toContain("apps/bot-manager/src/build-worker-wiring.ts");
    expect(matrix["arena-engine"].sites).toContain("apps/arena-engine/src/service.ts");
  });

  for (const profile of PROFILES) {
    it(`[${profile}] miembros de bot-control == consumidores renderizados en ese perfil`, () => {
      const c = render(profile);
      const expected = consumers.filter((s) => s in c.services);
      expect(members(c), `perfil ${profile}`).toEqual(expected);
      if (profile === "bots") expect(c.services["bot-runtime-template"]).toBeDefined();
    });
  }

  it("los no consumidores del stack NO están en bot-control (lista explícita)", () => {
    for (const s of [
      "gateway",
      "backup",
      "web",
      "postgres",
      "replay-service",
      "queue",
      "map-service",
      "api",
      "bot-manager",
    ]) {
      expect(prod.services[s], s).toBeDefined();
      expect(nets(prod.services[s]), s).not.toContain(NET_KEY);
    }
    const bots = render("bots");
    expect(nets(bots.services["bot-runtime-template"])).toEqual(["arena"]);
  });

  it("los consumidores no tienen red NO interna (ninguna ruta por defecto)", () => {
    for (const s of consumers) {
      for (const n of nets(prod.services[s])) expect(prod.networks[n].internal, `${s} → ${n}`).toBe(true);
    }
  });

  it("conectividad residual fijada: con ruta por defecto al host sólo gateway y backup (producción)", () => {
    // Estos dos alcanzan cualquier IP del host, 10.89.250.1 incluida, aunque no
    // estén en bot-control. Lo cierran el firewall del host (DEV-SECOPS) y el
    // control de cliente del proxy (DEV-PROXY), no esta red.
    expect(defaultRouteServices(prod)).toEqual(DEFAULT_ROUTE_PRODUCTION);
  });
});

describe("RC2 · alias, URL e interruptor de ejecución", () => {
  const prod = render("production");

  it("ningún servicio de ningún perfil usa host-gateway", () => {
    for (const profile of [...PROFILES, "streaming", "observability"]) {
      const c = render(profile);
      for (const [name, s] of Object.entries(c.services)) {
        for (const [h, ip] of extraHosts(s)) expect(ip, `${profile}/${name} ${h}`).not.toBe("host-gateway");
      }
    }
  });

  it("todo alias docker-proxy.internal apunta al gateway fijo de bot-control", () => {
    let seen = 0;
    for (const [name, s] of Object.entries(prod.services)) {
      const ip = extraHosts(s).get(PROXY_ALIAS);
      if (ip === undefined) continue;
      seen++;
      expect(ip, name).toBe(GATEWAY_IP);
    }
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(prod.networks[NET_KEY].ipam?.config?.[0]?.gateway).toBe(GATEWAY_IP);
  });

  it("todo miembro de bot-control resuelve el alias (si no, la URL no llega)", () => {
    for (const s of members(prod)) expect(extraHosts(prod.services[s]).get(PROXY_ALIAS), s).toBe(GATEWAY_IP);
  });

  it("interruptor: tournament-worker y arena-engine con DOCKER_PROXY_URL vacía por defecto", () => {
    expect(prod.services["tournament-worker"].environment?.DOCKER_PROXY_URL).toBe("");
    expect(prod.services["arena-engine"].environment?.DOCKER_PROXY_URL).toBe("");
  });

  it("bot-build-worker y bot-manager con la URL por defecto del contrato", () => {
    expect(prod.services["bot-build-worker"].environment?.DOCKER_PROXY_URL).toBe(DEFAULT_URL);
    expect(prod.services["bot-manager"].environment?.DOCKER_PROXY_URL).toBe(DEFAULT_URL);
  });

  it("toda URL por defecto no vacía apunta al alias (nunca a una IP del host ni a host-gateway)", () => {
    for (const [name, s] of Object.entries(prod.services)) {
      const url = s.environment?.DOCKER_PROXY_URL;
      if (!url) continue;
      expect(new URL(url).hostname, name).toBe(PROXY_ALIAS);
      expect(Number(new URL(url).port), name).toBe(PROXY_PORT);
    }
  });
});

describe("RC2 · N4 — el compose no expone el proxy ni publica puertos nuevos", () => {
  it("sólo el gateway publica, y sólo 80/443; nadie publica ni expone 2375; nadie usa la red del host", () => {
    for (const profile of [...PROFILES, "streaming", "observability"]) {
      const c = render(profile);
      for (const [name, s] of Object.entries(c.services)) {
        expect(s.network_mode ?? "", `${profile}/${name}`).not.toBe("host");
        const targets = (s.ports ?? []).map((p) => p.target);
        const published = (s.ports ?? []).map((p) => Number(p.published));
        for (const p of [...targets, ...published, ...(s.expose ?? []).map(Number)]) {
          expect(p, `${profile}/${name}`).not.toBe(PROXY_PORT);
        }
        if (name === "gateway") expect(targets.sort()).toEqual([443, 80].sort());
        else expect(s.ports ?? [], `${profile}/${name} no debe publicar`).toEqual([]);
      }
    }
  });
});
