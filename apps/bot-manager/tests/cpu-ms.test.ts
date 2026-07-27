/**
 * B10 (issue #9) · Medición REAL de CPU por contenedor de bot.
 *
 * El issue estaba bloqueado por "no hay ejecución de bots en contenedor". Ya la
 * hay, así que aquí se prueba la pieza que faltaba: leer del cgroup del
 * contenedor, a través del docker-proxy, cuánta CPU consumió cada bot.
 *
 * Tres niveles, todos de COMPORTAMIENTO (no de cadenas):
 *  1. `cpuMsFromDockerStats`: qué se acepta como medida y qué se rechaza. El
 *     caso importante es el contenedor YA PARADO: Docker responde 200 con los
 *     contadores a cero y eso NO es "0 ms de CPU", es "no medido" → null.
 *  2. Allowlist del proxy: `stats` entra SOLO como GET con `?stream=false`
 *     exacto; el resto de la superficie de Docker sigue en 403.
 *  3. El runner real (`ProxyContainerRunner`) contra un backend Docker simulado
 *     detrás del servidor HTTP REAL del proxy: la medida cruza el proxy de
 *     verdad, y cuando el backend no puede darla el handle devuelve null.
 *
 * HONESTIDAD DE ENTORNO: aquí no hay demonio Docker (ia02 no está en el grupo
 * docker), así que el backend es un doble en memoria que responde con la MISMA
 * forma de payload que documenta la Engine API. La lectura contra
 * /var/run/docker.sock real queda pendiente de VM108.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, cpuMsFromDockerStats, type SandboxSpec } from "../src/container-runner.js";
import {
  ProxyContainerRunner,
  createDockerProxyServer,
  evaluateProxyRequest,
  type DockerBackend,
} from "../src/docker-proxy.js";

const REAL_DIGEST = "arena/bot-runtime-python@sha256:" + "8fb09919".padEnd(64, "a");
const SECCOMP_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "security", "seccomp-bot.json");

const spec = (botId: string): SandboxSpec => ({
  imageDigest: REAL_DIGEST,
  botId,
  version: 1,
  battleId: "battle-cpu",
  network: "arena",
  engineEndpoint: "ws://arena-engine:8081",
  env: { WS_URL: "ws://arena-engine:8081", BOT_ID: botId },
  limits: DEFAULT_LIMITS,
  seccompProfilePath: SECCOMP_PATH,
});

/**
 * Payload REAL de `GET /containers/{id}/stats?stream=false` (recortado a los
 * campos que existen de verdad en la respuesta de la Engine API; los nombres y
 * las unidades son los suyos: `total_usage` en NANOSEGUNDOS).
 */
function statsPayload(totalUsageNs: number) {
  return {
    read: "2026-07-27T10:00:00.123456789Z",
    preread: "0001-01-01T00:00:00Z",
    pids_stats: { current: 3, limit: 64 },
    cpu_stats: {
      cpu_usage: {
        total_usage: totalUsageNs,
        usage_in_kernelmode: Math.floor(totalUsageNs / 4),
        usage_in_usermode: Math.floor((totalUsageNs * 3) / 4),
      },
      system_cpu_usage: 1_234_567_890_000,
      online_cpus: 4,
      throttling_data: { periods: 0, throttled_periods: 0, throttled_time: 0 },
    },
    precpu_stats: { cpu_usage: { total_usage: 0 }, throttling_data: {} },
    memory_stats: { usage: 12_345_678, limit: 268_435_456 },
  };
}

/** Lo que devuelve la Engine para un contenedor que YA NO CORRE: todo a cero. */
const STOPPED_CONTAINER_STATS = {
  read: "0001-01-01T00:00:00Z",
  preread: "0001-01-01T00:00:00Z",
  pids_stats: {},
  cpu_stats: { cpu_usage: { total_usage: 0 }, throttling_data: {} },
  precpu_stats: { cpu_usage: { total_usage: 0 }, throttling_data: {} },
  memory_stats: {},
};

describe("B10 · cpuMsFromDockerStats: qué es una medida y qué es un hueco", () => {
  it("convierte nanosegundos de cgroup a milisegundos (valor exacto, no redondeado)", () => {
    // 2_500_000_000 ns = 2,5 s de CPU = 2500 ms.
    expect(cpuMsFromDockerStats(statsPayload(2_500_000_000))).toBe(2500);
    // Fracción de ms: se conserva (no se trunca a entero).
    expect(cpuMsFromDockerStats(statsPayload(1_234_567))).toBeCloseTo(1.234567, 6);
  });

  it("un contenedor ya parado (contadores a cero) da null, NUNCA 0 ms", () => {
    // Este es el corazón del issue: 0 sería un número plausible y falso.
    expect(cpuMsFromDockerStats(STOPPED_CONTAINER_STATS)).toBeNull();
  });

  it("rechaza cualquier cosa que no sea un total_usage numérico y positivo", () => {
    expect(cpuMsFromDockerStats(null)).toBeNull();
    expect(cpuMsFromDockerStats("no json")).toBeNull();
    expect(cpuMsFromDockerStats({})).toBeNull();
    expect(cpuMsFromDockerStats({ cpu_stats: {} })).toBeNull();
    expect(cpuMsFromDockerStats({ cpu_stats: { cpu_usage: {} } })).toBeNull();
    // Un string numérico NO es una medida (driver raro / respuesta manipulada).
    expect(cpuMsFromDockerStats({ cpu_stats: { cpu_usage: { total_usage: "2500000000" } } })).toBeNull();
    expect(cpuMsFromDockerStats({ cpu_stats: { cpu_usage: { total_usage: -1 } } })).toBeNull();
    expect(cpuMsFromDockerStats({ cpu_stats: { cpu_usage: { total_usage: Number.NaN } } })).toBeNull();
    expect(cpuMsFromDockerStats({ cpu_stats: { cpu_usage: { total_usage: Number.POSITIVE_INFINITY } } })).toBeNull();
    // Un error de la Engine llega como objeto con `message`: tampoco es medida.
    expect(cpuMsFromDockerStats({ message: "No such container: abc" })).toBeNull();
  });
});

describe("B10 · allowlist del proxy: `stats` entra acotado, el resto sigue fuera", () => {
  it("admite GET /containers/{id}/stats?stream=false y reconstruye la ruta reenviada", () => {
    const d = evaluateProxyRequest("GET", "/v1.44/containers/cid1/stats?stream=false", undefined);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.action).toEqual({ kind: "stats", id: "cid1" });
      // Al backend nunca se le pasa la query tal cual: se canoniza.
      expect(d.forwardPath).toBe("/containers/cid1/stats?stream=false");
      expect(d.forwardBody).toBeUndefined();
    }
  });

  it("RECHAZA el modo streaming y cualquier query que no sea exactamente stream=false", () => {
    // stream=true dejaría la petición abierta indefinidamente: el proxy acumula
    // la respuesta del backend antes de contestar y se quedaría colgado.
    for (const path of [
      "/containers/cid1/stats?stream=true",
      "/containers/cid1/stats", // sin query = streaming por defecto en Docker
      "/containers/cid1/stats?stream=false&extra=1",
      "/containers/cid1/stats?stream=false&stream=true",
      "/containers/cid1/stats?one-shot=true",
      "/containers/cid1/stats?stream=0",
    ]) {
      const d = evaluateProxyRequest("GET", path, undefined);
      expect(d.ok, path).toBe(false);
    }
  });

  it("stats es SOLO lectura: otros métodos, cuerpos e ids raros se rechazan", () => {
    expect(evaluateProxyRequest("POST", "/containers/cid1/stats?stream=false", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("DELETE", "/containers/cid1/stats?stream=false", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("GET", "/containers/cid1/stats?stream=false", '{"x":1}').ok).toBe(false);
    expect(evaluateProxyRequest("GET", "/containers/%2e%2e/stats?stream=false", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("GET", "/containers/../stats?stream=false", undefined).ok).toBe(false);
  });

  it("la ampliación NO abre nada más: exec, attach, logs, archive, images y /version siguen en 403", () => {
    const stillDenied: Array<[string, string]> = [
      ["POST", "/containers/cid1/exec"],
      ["POST", "/containers/cid1/attach"],
      ["GET", "/containers/cid1/logs?stdout=1"],
      ["GET", "/containers/cid1/top"],
      ["PUT", "/containers/cid1/archive"],
      ["GET", "/containers/json"], // listar TODOS los contenedores
      ["GET", "/version"],
      ["GET", "/info"],
      ["POST", "/images/create?fromImage=alpine"],
      ["DELETE", "/containers/cid1"],
    ];
    for (const [method, path] of stillDenied) {
      expect(evaluateProxyRequest(method, path, undefined).ok, `${method} ${path}`).toBe(false);
    }
  });
});

// ── el runner real cruzando el proxy real contra un Docker simulado ──────────

interface FakeContainer {
  id: string;
  running: boolean;
  /** ns de CPU que "consumió" este contenedor mientras corría. */
  totalUsageNs: number;
}

function fakeDockerBackend() {
  const containers = new Map<string, FakeContainer>();
  const requests: Array<{ method: string; path: string }> = [];
  let nextUsageNs = 0;
  const backend: DockerBackend = {
    async dispatch(method, path) {
      requests.push({ method, path });
      if (method === "POST" && path.startsWith("/containers/create")) {
        const id = `cid${containers.size + 1}`;
        containers.set(id, { id, running: false, totalUsageNs: nextUsageNs });
        return { status: 201, body: JSON.stringify({ Id: id, Warnings: [] }) };
      }
      const m = /^\/containers\/([^/]+)\/(start|stop|json|stats)/.exec(path);
      const c = m ? containers.get(m[1]) : undefined;
      if (!c) return { status: 404, body: JSON.stringify({ message: "no such container" }) };
      if (m![2] === "start") {
        c.running = true;
        return { status: 204, body: "" };
      }
      if (m![2] === "stop") {
        c.running = false;
        return { status: 204, body: "" };
      }
      if (m![2] === "stats") {
        // Como Docker: contenedor parado ⇒ estructura a cero.
        return {
          status: 200,
          body: JSON.stringify(c.running ? statsPayload(c.totalUsageNs) : STOPPED_CONTAINER_STATS),
        };
      }
      return { status: 200, body: JSON.stringify([{ Id: c.id, State: { Running: c.running } }]) };
    },
  };
  return { backend, containers, requests, setNextUsageNs: (ns: number) => (nextUsageNs = ns) };
}

describe("B10 · ProxyContainerRunner mide CPU a través del proxy (sin Docker, backend simulado)", () => {
  const fake = fakeDockerBackend();
  const denials: string[] = [];
  const server = createDockerProxyServer({
    backend: fake.backend,
    onDecision: (e) => {
      if (!e.allowed) denials.push(e.reason ?? "");
    },
  });
  let proxyUrl = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("devuelve los ms REALES del contenedor mientras corre, y null cuando ya está parado", async () => {
    fake.setNextUsageNs(7_500_000_000); // 7,5 s de CPU
    const runner = new ProxyContainerRunner(proxyUrl);
    const handle = await runner.launch(spec("bot_a"));

    expect(await handle.cpuMs()).toBe(7500);

    // Tras parar el contenedor la Engine ya no tiene contadores: el handle NO
    // debe inventarse el último valor visto ni devolver 0.
    await handle.stop();
    expect(await handle.cpuMs()).toBeNull();
  });

  it("si el contenedor ya no existe, el handle devuelve null (no la última medida vista)", async () => {
    fake.setNextUsageNs(3_000_000_000);
    const runner = new ProxyContainerRunner(proxyUrl);
    const handle = await runner.launch(spec("bot_b"));
    expect(await handle.cpuMs()).toBe(3000);

    // El contenedor desaparece (limpieza externa, reinicio del demonio…): el
    // backend responde 404 y el handle NO puede devolver el 3000 de antes.
    fake.containers.delete(handle.id);
    expect(await handle.cpuMs()).toBeNull();
  });

  it("si el proxy deja de responder, cpuMs() devuelve null en vez de lanzar excepción", async () => {
    // Segundo proxy REAL, con el mismo backend, que se apaga a media vida: el
    // handle sigue vivo pero ya no puede medir. Un `throw` aquí abortaría la
    // recogida de métricas de la batalla entera.
    const other = createDockerProxyServer({ backend: fake.backend });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    fake.setNextUsageNs(1_000_000_000);
    const handle = await new ProxyContainerRunner(otherUrl).launch(spec("bot_c"));
    expect(await handle.cpuMs()).toBe(1000);

    await new Promise<void>((r) => other.close(() => r()));
    expect(await handle.cpuMs()).toBeNull();
  });

  it("una petición hostil de streaming al proxy recibe 403 y NUNCA llega al backend", async () => {
    const before = fake.requests.length;
    const res = await fetch(`${proxyUrl}/containers/cid1/stats?stream=true`);
    expect(res.status).toBe(403);
    expect(fake.requests.length).toBe(before);
    expect(denials.some((d) => d.includes("stream=false"))).toBe(true);
  });

  it("el backend solo ve rutas canónicas de la allowlist (incluida la de stats)", () => {
    for (const r of fake.requests) {
      expect(r.path).toMatch(/^\/containers\/(create\?name=|[A-Za-z0-9_.-]+\/(start|stop|json|stats\?stream=false))/);
    }
  });
});
