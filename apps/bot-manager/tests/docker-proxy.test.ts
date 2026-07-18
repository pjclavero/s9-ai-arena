/**
 * R1.7 (ERR-SEC-02) · Tests del proxy de la API de Docker con allowlist.
 *
 * HONESTIDAD DE ENTORNO: aquí NO hay Docker (ia02 sin grupo docker). Estos
 * tests verifican la lógica del proxy EN PROCESO (servidor HTTP real en un
 * puerto efímero + backend simulado en memoria). La verificación viva contra
 * /var/run/docker.sock queda anotada como pendiente de R-DEPLOY.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type SandboxSpec, complianceViolations } from "../src/container-runner.js";
import {
  DEFAULT_POLICY,
  type DockerBackend,
  ProxyContainerRunner,
  createBodyViolations,
  createDockerProxyServer,
  evaluateProxyRequest,
  inlineSeccompProfile,
  postureFromCreateBody,
} from "../src/docker-proxy.js";

const REAL_DIGEST = "arena/bot-runtime-python@sha256:" + "8fb09919".padEnd(64, "a");

// Ruta REAL del perfil seccomp: buildCreateBody ahora lo LEE (JSON inline), así que
// el spec debe apuntar a un fichero existente y válido.
const SECCOMP_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "security", "seccomp-bot.json");

const spec: SandboxSpec = {
  imageDigest: REAL_DIGEST,
  botId: "bot-1",
  version: 3,
  battleId: "battle-9",
  network: "arena",
  engineEndpoint: "ws://arena-engine:8081",
  env: { ARENA_WS_URL: "ws://arena-engine:8081" },
  limits: DEFAULT_LIMITS,
  seccompProfilePath: SECCOMP_PATH,
};

const goodBody = () => ProxyContainerRunner.buildCreateBody(spec);

describe("R6.2 · digest de imagen (soporta registry local; sigue rechazando tag/placeholder)", () => {
  const withImage = (image: string) => {
    const b = goodBody();
    (b as Record<string, unknown>).Image = image;
    return createBodyViolations(b).filter((v) => /imagen|digest|placeholder/i.test(v));
  };
  const HEX = "a1b2c3d4".padEnd(64, "e");

  it("acepta digest de GHCR", () => {
    expect(withImage(`ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot@sha256:${HEX}`)).toEqual([]);
  });
  it("acepta digest de registry local (127.0.0.1:5000 y localhost:5000)", () => {
    expect(withImage(`127.0.0.1:5000/s9-smoke-bot@sha256:${HEX}`)).toEqual([]);
    expect(withImage(`localhost:5000/s9-smoke-bot@sha256:${HEX}`)).toEqual([]);
  });
  it("rechaza un tag sin digest", () => {
    expect(withImage("127.0.0.1:5000/s9-smoke-bot:0.1.0").length).toBeGreaterThan(0);
    expect(withImage("ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot:latest").length).toBeGreaterThan(0);
  });
  it("rechaza un digest placeholder (mismo carácter repetido)", () => {
    expect(withImage(`127.0.0.1:5000/s9-smoke-bot@sha256:${"0".repeat(64)}`).length).toBeGreaterThan(0);
  });
  it("rechaza un hash mal formado (longitud incorrecta)", () => {
    expect(withImage("127.0.0.1:5000/s9-smoke-bot@sha256:deadbeef").length).toBeGreaterThan(0);
  });
});

describe("R6.2 · seccomp inline (bug VM108: la API exige JSON, no ruta)", () => {
  function seccompValue(body: Record<string, unknown>): string {
    const so = ((body.HostConfig as Record<string, unknown>).SecurityOpt as string[]) ?? [];
    return so.find((o) => o.startsWith("seccomp="))!.slice("seccomp=".length);
  }

  it("inlineSeccompProfile devuelve JSON minificado del perfil (no la ruta)", () => {
    const json = inlineSeccompProfile(SECCOMP_PATH);
    expect(json.startsWith("{")).toBe(true);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toHaveProperty("defaultAction");
  });

  it("buildCreateBody pone seccomp=<json>, NUNCA seccomp=<ruta>", () => {
    const v = seccompValue(goodBody());
    expect(v.startsWith("{")).toBe(true); // JSON
    expect(v.startsWith("/")).toBe(false); // no una ruta absoluta
    expect(v).not.toBe("unconfined");
  });

  it("falla ANTES de Docker si el perfil no existe", () => {
    expect(() => inlineSeccompProfile("/no/existe/seccomp.json")).toThrow(/no encontrado/);
    expect(() => ProxyContainerRunner.buildCreateBody({ ...spec, seccompProfilePath: "/no/existe.json" })).toThrow(
      /no encontrado/,
    );
  });

  it("falla si el perfil no es JSON válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "seccomp-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ esto no es json", "utf8");
    expect(() => inlineSeccompProfile(bad)).toThrow(/no es JSON válido/);
  });
});

describe("R1.7 · allowlist del create", () => {
  it("admite el cuerpo que construye el propio runner (postura conforme)", () => {
    const body = goodBody();
    expect(createBodyViolations(body)).toEqual([]);
    // única fuente de verdad: la postura derivada pasa complianceViolations
    expect(complianceViolations(postureFromCreateBody(body))).toEqual([]);
  });

  it("rechaza privileged", () => {
    const body = goodBody() as any;
    body.HostConfig.Privileged = true;
    expect(createBodyViolations(body).join("; ")).toMatch(/privileged|privilegiado/i);
  });

  it("rechaza bind-mounts (Binds y Mounts), incluido docker.sock", () => {
    const withBinds = goodBody() as any;
    withBinds.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    const v1 = createBodyViolations(withBinds).join("; ");
    expect(v1).toMatch(/bind-mounts/);
    expect(v1).toMatch(/docker\.sock/);

    const withMounts = goodBody() as any;
    withMounts.HostConfig.Mounts = [{ Type: "bind", Source: "/etc", Target: "/host-etc" }];
    expect(createBodyViolations(withMounts).join("; ")).toMatch(/no-tmpfs/);
  });

  it("rechaza --network host y redes distintas de la permitida", () => {
    const host = goodBody() as any;
    host.HostConfig.NetworkMode = "host";
    expect(createBodyViolations(host).join("; ")).toMatch(/red del host/);

    const otra = goodBody() as any;
    otra.HostConfig.NetworkMode = "data";
    otra.NetworkingConfig = { EndpointsConfig: { data: {} } };
    expect(createBodyViolations(otra).join("; ")).toMatch(/red/);
  });

  it("rechaza cambios de usuario (root, otro uid o ausente)", () => {
    for (const user of ["root", "0", "1000:1000", undefined]) {
      const body = goodBody() as any;
      body.User = user;
      if (user === undefined) delete body.User;
      expect(createBodyViolations(body).join("; ")).toMatch(/usuario|root/);
    }
  });

  it("rechaza CapAdd, namespaces del host y campos desconocidos (fail closed)", () => {
    const caps = goodBody() as any;
    caps.HostConfig.CapAdd = ["SYS_ADMIN"];
    expect(createBodyViolations(caps).join("; ")).toMatch(/CapAdd/);

    const pid = goodBody() as any;
    pid.HostConfig.PidMode = "host";
    expect(createBodyViolations(pid).join("; ")).toMatch(/PidMode/);

    const desconocido = goodBody() as any;
    desconocido.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }];
    expect(createBodyViolations(desconocido).join("; ")).toMatch(/campo no permitido en HostConfig: Devices/);

    const top = goodBody() as any;
    top.Volumes = { "/data": {} };
    expect(createBodyViolations(top).join("; ")).toMatch(/campo no permitido en el create: Volumes/);
  });

  it("rechaza seccomp unconfined, sin cap-drop ALL o sin read-only", () => {
    const unconfined = goodBody() as any;
    unconfined.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"];
    expect(createBodyViolations(unconfined).join("; ")).toMatch(/seccomp/);

    const rw = goodBody() as any;
    rw.HostConfig.ReadonlyRootfs = false;
    expect(createBodyViolations(rw).join("; ")).toMatch(/solo lectura/);
  });

  it("rechaza imágenes sin digest o con digest placeholder (guard #12)", () => {
    const tag = goodBody() as any;
    tag.Image = "python:3.11";
    expect(createBodyViolations(tag).join("; ")).toMatch(/digest/);

    const placeholder = goodBody() as any;
    placeholder.Image = "arena/bot-runtime-python@sha256:" + "0".repeat(64);
    expect(createBodyViolations(placeholder).join("; ")).toMatch(/placeholder/);
  });
});

describe("R1.7 · allowlist de endpoints", () => {
  it("solo create/start/stop/inspect; todo lo demás 403", () => {
    const cases: Array<[string, string]> = [
      ["POST", "/containers/abc/exec"],
      ["POST", "/build"],
      ["POST", "/images/create?fromImage=alpine"],
      ["DELETE", "/containers/abc"],
      ["GET", "/secrets"],
      ["POST", "/v1.44/containers/abc/attach"],
      ["PUT", "/containers/abc/archive"], // escribir ficheros en el contenedor
      ["POST", "/containers/abc/json"], // método incorrecto
    ];
    for (const [method, path] of cases) {
      const d = evaluateProxyRequest(method, path, undefined);
      expect(d.ok, `${method} ${path}`).toBe(false);
    }
  });

  it("admite las cuatro operaciones permitidas (con prefijo de versión incluido)", () => {
    expect(evaluateProxyRequest("POST", "/v1.44/containers/create?name=bot-x", JSON.stringify(goodBody())).ok).toBe(
      true,
    );
    expect(evaluateProxyRequest("POST", "/containers/abc123/start", undefined).ok).toBe(true);
    expect(evaluateProxyRequest("POST", "/containers/abc123/stop?t=5", undefined).ok).toBe(true);
    expect(evaluateProxyRequest("GET", "/containers/abc123/json", undefined).ok).toBe(true);
  });

  it("reconstruye la ruta reenviada (nada se pasa tal cual al socket)", () => {
    const d = evaluateProxyRequest("POST", "/v1.44/containers/create?name=bot-x&extra=1", JSON.stringify(goodBody()));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.forwardPath).toBe("/containers/create?name=bot-x");
  });

  it("rechaza identificadores raros (path traversal / opciones inyectadas)", () => {
    expect(evaluateProxyRequest("POST", "/containers/../images/start", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("GET", "/containers/%2e%2e/json", undefined).ok).toBe(false);
  });
});

// ── servidor + runner contra un backend Docker simulado ─────────────────────

interface FakeContainer {
  id: string;
  body: any;
  running: boolean;
}

function fakeDockerBackend() {
  const containers = new Map<string, FakeContainer>();
  const requests: Array<{ method: string; path: string }> = [];
  const backend: DockerBackend = {
    async dispatch(method, path, body) {
      requests.push({ method, path });
      if (method === "POST" && path.startsWith("/containers/create")) {
        const id = `cid${containers.size + 1}`;
        containers.set(id, { id, body: JSON.parse(body ?? "{}"), running: false });
        return { status: 201, body: JSON.stringify({ Id: id, Warnings: [] }) };
      }
      const m = /^\/containers\/([^/]+)\/(start|stop|json)/.exec(path);
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
      // inspect: refleja la configuración pedida, como haría Docker
      const hc = c.body.HostConfig ?? {};
      return {
        status: 200,
        body: JSON.stringify([
          {
            Id: c.id,
            State: { Running: c.running },
            Config: { User: c.body.User },
            HostConfig: hc,
            Mounts: [],
            NetworkSettings: { Networks: { [hc.NetworkMode]: {} } },
          },
        ]),
      };
    },
  };
  return { backend, containers, requests };
}

describe("R1.7 · bot-manager lanza a través del proxy (en proceso, sin Docker)", () => {
  const fake = fakeDockerBackend();
  const rejections: string[] = [];
  const server = createDockerProxyServer({
    backend: fake.backend,
    onDecision: (e) => {
      if (!e.allowed) rejections.push(e.reason ?? "");
    },
  });
  let proxyUrl = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("launch → create+start vía proxy; posture() conforme; stop() para", async () => {
    const runner = new ProxyContainerRunner(proxyUrl);
    const handle = await runner.launch(spec);
    expect(fake.containers.get(handle.id)?.running).toBe(true);

    const posture = await handle.posture();
    expect(complianceViolations(posture)).toEqual([]);

    await handle.stop();
    expect(fake.containers.get(handle.id)?.running).toBe(false);
    // el backend solo ha visto rutas canónicas de la allowlist
    for (const r of fake.requests) {
      expect(r.path).toMatch(/^\/containers\/(create\?name=|[A-Za-z0-9_.-]+\/(start|stop|json))/);
    }
  });

  it("una petición hostil directa al proxy (privileged) recibe 403 y NO llega al backend", async () => {
    const hostile = goodBody() as any;
    hostile.HostConfig.Privileged = true;
    hostile.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    const before = fake.requests.length;
    const res = await fetch(`${proxyUrl}/containers/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hostile),
    });
    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.message).toMatch(/privileged/);
    expect(payload.message).toMatch(/docker\.sock|bind-mounts/);
    expect(fake.requests.length).toBe(before);
    expect(rejections.some((r) => r.includes("privileged"))).toBe(true);
  });

  it("un endpoint fuera de la allowlist (exec) recibe 403 y NO llega al backend", async () => {
    const before = fake.requests.length;
    const res = await fetch(`${proxyUrl}/containers/cid1/exec`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    expect(fake.requests.length).toBe(before);
  });

  it("el digest placeholder se rechaza también en el runner (antes de llegar al proxy)", async () => {
    const runner = new ProxyContainerRunner(proxyUrl);
    const bad = { ...spec, imageDigest: "arena/bot-runtime-python@sha256:" + "0".repeat(64) };
    await expect(runner.launch(bad)).rejects.toThrow(/placeholder/);
  });

  it("el proxy propaga la política: otra red permitida ≠ arena sigue vetada por la fuente de verdad", () => {
    // complianceViolations solo admite "arena": si alguien relaja la política
    // del proxy, la postura sigue sin ser conforme. Defensa en profundidad.
    const body = ProxyContainerRunner.buildCreateBody({ ...spec, network: "platform" });
    const violations = createBodyViolations(body, { ...DEFAULT_POLICY, allowedNetwork: "platform" });
    expect(violations.join("; ")).toMatch(/red no permitida: platform/);
  });
});
