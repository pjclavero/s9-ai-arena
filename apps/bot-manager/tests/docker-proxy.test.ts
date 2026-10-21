/**
 * R1.7 (ERR-SEC-02) + RC2 (DEV-PROXY) · Tests del proxy de la API de Docker.
 *
 * EN PROCESO: servidor HTTP REAL del proxy en un puerto efímero + backend Docker
 * simulado en memoria que responde con la forma de la Engine API (incluidas
 * `Config.Labels`). Corren en la CI normal (`vitest run apps`). La misma batería
 * contra Docker REAL con el proxy real está en docker-proxy-docker.test.ts (opt-in).
 *
 * Bloques RC2 (cada uno capaz de ponerse ROJO; calibrado por mutación, ver informe):
 *   - allowlist de imágenes (P1/P2, N20 de OPS-C);
 *   - propiedad por labels impuestas e inspección previa (P3/P4/P5, N21–N23);
 *   - control del cliente por IP de origen;
 *   - bind/config que falla cerrado (proxyConfigFromEnv y el proceso real);
 *   - allowlist de operaciones y default deny (P6/P7);
 *   - validación de input y postura del sandbox (P8/P9).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type SandboxSpec, complianceViolations } from "../src/container-runner.js";
import {
  DEFAULT_IMAGE_ALLOWLIST_PATH,
  DEFAULT_POLICY,
  DEFAULT_PROXY_INSTANCE,
  LABEL_INSTANCE,
  LABEL_MANAGED,
  type DockerBackend,
  type ProxyDecisionLog,
  type ProxyPolicy,
  ProxyContainerRunner,
  createBodyViolations,
  createDockerProxyServer,
  evaluateProxyRequest,
  imageAllowlistViolation,
  inlineSeccompProfile,
  isClientAllowed,
  loadImageAllowlist,
  ownershipViolation,
  parseAllowedClients,
  parseImageAllowlist,
  postureFromCreateBody,
} from "../src/docker-proxy.js";
import { proxyConfigFromEnv } from "../src/docker-proxy-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const SECCOMP_PATH = join(here, "..", "security", "seccomp-bot.json");

// ── la allowlist REAL del repo, leída independientemente del código bajo prueba ──
const LOCK_TEXT = readFileSync(join(REPO, "runtimes", "DIGESTS.lock"), "utf8");
const LOCK_ROWS = LOCK_TEXT.split("\n")
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)
  .map((l) => l.split(/\s+/));
const RUNTIME_IMAGES = LOCK_ROWS.map((r) => r[2]);
const BASE_IMAGES = LOCK_ROWS.map((r) => r[1]);
const RUNTIME_PY = RUNTIME_IMAGES[0];

const HEX = (c: string) => c.repeat(64).slice(0, 64);
const realHex = "8c5de6118647b57c2cd34f6032677d4bdc96f8076ab91f5cf6e0847475f02fc6"; // ≠ cualquiera del lock
/** Imágenes que NO deben poder crearse nunca (N20 y compañía). */
const FOREIGN_IMAGES: Array<[string, string]> = [
  ["postgres por digest", `postgres@sha256:${realHex}`],
  ["alpine por digest", `alpine@sha256:${realHex}`],
  ["nginx por digest", `nginxinc/nginx-unprivileged@sha256:${realHex}`],
  ["gateway del stack (N20)", `ghcr.io/pjclavero/s9-ai-arena/gateway@sha256:${realHex}`],
  ["runtime con digest ajeno", RUNTIME_PY.replace(/@sha256:.*/, `@sha256:${realHex}`)],
  ["runtime por tag", RUNTIME_PY.replace(/@sha256:.*/, ":latest")],
  ["runtime con docker.io/ delante", `docker.io/${RUNTIME_PY}`],
  ["runtime en mayúsculas", RUNTIME_PY.toUpperCase()],
  ...BASE_IMAGES.map((b): [string, string] => [`imagen BASE de DIGESTS.lock (${b.split("@")[0]})`, b]),
];

const spec: SandboxSpec = {
  imageDigest: RUNTIME_PY,
  botId: "bot-1",
  version: 3,
  battleId: "battle-9",
  network: "arena",
  engineEndpoint: "ws://arena-engine:8081",
  env: { ARENA_WS_URL: "ws://arena-engine:8081" },
  limits: DEFAULT_LIMITS,
  seccompProfilePath: SECCOMP_PATH,
};

const goodBody = () => ProxyContainerRunner.buildCreateBody(spec) as any;
const createReq = (body: unknown, policy?: ProxyPolicy) =>
  evaluateProxyRequest("POST", "/containers/create?name=bot-x", JSON.stringify(body), policy);
const ID_A = HEX("a");

// ── P1/P2 · allowlist de imágenes ────────────────────────────────────────────

describe("RC2 · P1/P2 · allowlist de imágenes = 3.ª columna de DIGESTS.lock", () => {
  it("el lock por defecto es el del repo y aporta EXACTAMENTE las imágenes de runtime", () => {
    expect(DEFAULT_IMAGE_ALLOWLIST_PATH).toBe(join(REPO, "runtimes", "DIGESTS.lock"));
    expect(RUNTIME_IMAGES.length).toBeGreaterThanOrEqual(2);
    expect([...loadImageAllowlist()].sort()).toEqual([...RUNTIME_IMAGES].sort());
    for (const b of BASE_IMAGES) expect(loadImageAllowlist().has(b)).toBe(false);
  });

  it("cada imagen de runtime del lock se admite en el create", () => {
    for (const img of RUNTIME_IMAGES) {
      const d = createReq({ ...goodBody(), Image: img });
      expect(d.ok, img).toBe(true);
    }
  });

  it.each(FOREIGN_IMAGES)("DENIEGA %s", (_label, image) => {
    const d = createReq({ ...goodBody(), Image: image });
    expect(d.ok).toBe(false);
    if (d.ok === false) {
      expect(d.status).toBe(403);
      expect(d.reason).toMatch(/allowlist|digest|placeholder/i);
    }
  });

  it("la allowlist es independiente de la postura: la postura de la imagen ajena es perfecta y aun así se deniega", () => {
    const body = { ...goodBody(), Image: `ghcr.io/pjclavero/s9-ai-arena/gateway@sha256:${realHex}` };
    expect(createBodyViolations(body)).toEqual([]); // postura conforme
    expect(imageAllowlistViolation(body.Image)).toMatch(/fuera de la allowlist/);
  });

  it("los tests pueden pasar su propio lock; un conjunto vacío lo deniega todo", () => {
    const own = new Set([`127.0.0.1:5000/s9-smoke-bot@sha256:${realHex}`]);
    expect(createReq({ ...goodBody(), Image: [...own][0] }, { ...DEFAULT_POLICY, imageAllowlist: own }).ok).toBe(true);
    expect(createReq(goodBody(), { ...DEFAULT_POLICY, imageAllowlist: own }).ok).toBe(false);
    expect(createReq(goodBody(), { ...DEFAULT_POLICY, imageAllowlist: new Set() }).ok).toBe(false);
  });

  it("el parser del lock falla CERRADO ante columnas de menos, 3.ª columna mala, placeholder o lock vacío", () => {
    expect(() => parseImageAllowlist(`python python@sha256:${realHex}\n`)).toThrow(/3 columnas/);
    expect(() => parseImageAllowlist(`python python@sha256:${realHex} arena/rt-py:latest\n`)).toThrow(
      /digest completo/,
    );
    expect(() => parseImageAllowlist(`python python@sha256:${realHex} arena/rt-py@sha256:${"0".repeat(64)}\n`)).toThrow(
      /placeholder/,
    );
    expect(() => parseImageAllowlist("# sólo comentarios\n\n")).toThrow(/ninguna imagen/);
    expect(() => loadImageAllowlist("/no/existe/DIGESTS.lock")).toThrow(/no encontrada/);
    expect([...parseImageAllowlist(LOCK_TEXT)].sort()).toEqual([...RUNTIME_IMAGES].sort());
  });
});

// ── P3/P5 · labels impuestas ─────────────────────────────────────────────────

describe("RC2 · P3/P5 · labels de propiedad IMPUESTAS por el proxy", () => {
  it("el create reenviado lleva s9.managed=true y s9.proxy.instance=<instancia>", () => {
    const d = createReq(goodBody());
    expect(d.ok).toBe(true);
    if (d.ok) {
      const fwd = JSON.parse(d.forwardBody!);
      expect(fwd.Labels).toEqual({ [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: DEFAULT_PROXY_INSTANCE });
    }
    const d2 = createReq(goodBody(), { ...DEFAULT_POLICY, instance: "rc2px-otra" });
    if (d2.ok) expect(JSON.parse(d2.forwardBody!).Labels[LABEL_INSTANCE]).toBe("rc2px-otra");
  });

  it.each([LABEL_MANAGED, LABEL_INSTANCE, "s9.cualquiera", "S9.Managed"])(
    "el cliente NO puede fijar la label %s (403)",
    (key) => {
      const d = createReq({ ...goodBody(), Labels: { [key]: "true" } });
      expect(d.ok).toBe(false);
      if (d.ok === false) expect(d.reason).toMatch(/label reservada/);
    },
  );

  it("las labels ajenas a s9.* se conservan, y las de propiedad SIEMPRE ganan", () => {
    const d = createReq({ ...goodBody(), Labels: { "org.example.team": "arena" } });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(JSON.parse(d.forwardBody!).Labels).toEqual({
        "org.example.team": "arena",
        [LABEL_MANAGED]: "true",
        [LABEL_INSTANCE]: DEFAULT_PROXY_INSTANCE,
      });
    }
    expect(createReq({ ...goodBody(), Labels: ["x"] }).ok).toBe(false);
    expect(createReq({ ...goodBody(), Labels: { a: 1 } }).ok).toBe(false);
  });

  it("ownershipViolation decide SÓLO por labels exactas e Id exacto (nunca por nombre)", () => {
    const owned = {
      Id: ID_A,
      Name: "/bot-x",
      Config: { Labels: { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: "s9-docker-proxy" } },
    };
    expect(ownershipViolation(owned, ID_A)).toBeNull();
    expect(ownershipViolation([owned], ID_A)).toBeNull(); // forma array
    expect(ownershipViolation({ ...owned, Config: {} }, ID_A)).toMatch(/no gestionado/);
    expect(ownershipViolation({ ...owned, Config: { Labels: { [LABEL_MANAGED]: "true" } } }, ID_A)).toMatch(/instance/);
    expect(
      ownershipViolation(
        { ...owned, Config: { Labels: { [LABEL_MANAGED]: "false", [LABEL_INSTANCE]: "s9-docker-proxy" } } },
        ID_A,
      ),
    ).toMatch(/managed/);
    expect(ownershipViolation(owned, ID_A, { ...DEFAULT_POLICY, instance: "otra" })).toMatch(/instance/);
    expect(ownershipViolation(owned, HEX("b"))).toMatch(/no coincide/);
    // Un contenedor que se LLAMA como un bot pero no lleva labels sigue siendo ajeno.
    expect(ownershipViolation({ Id: ID_A, Name: "/bot-bot_a-v1-battle", Config: { Labels: {} } }, ID_A)).toMatch(
      /no gestionado/,
    );
    expect(ownershipViolation(null, ID_A)).toMatch(/ilegible/);
  });

  it("start/stop/json/stats sólo con Id COMPLETO de 64 hex: nombre, prefijo o mayúsculas → 403 sin tocar el backend", () => {
    for (const id of ["infrastructure-postgres-1", "postgres", ID_A.slice(0, 12), ID_A.toUpperCase(), `${ID_A}0`]) {
      for (const [m, p] of [
        ["POST", `/containers/${id}/stop`],
        ["POST", `/containers/${id}/start`],
        ["GET", `/containers/${id}/json`],
        ["GET", `/containers/${id}/stats?stream=false`],
      ]) {
        const d = evaluateProxyRequest(m, p, undefined);
        expect(d.ok, `${m} ${p}`).toBe(false);
        if (d.ok === false) expect(d.reason).toMatch(/Id completo/);
      }
    }
  });
});

// ── P6/P7 · allowlist de operaciones ─────────────────────────────────────────

describe("RC2 · P6/P7 · allowlist explícita de operaciones y default deny", () => {
  it("todo lo que no sea create/start/stop/json/stats(stream=false) → 403", () => {
    const cases: Array<[string, string]> = [
      ["POST", `/containers/${ID_A}/exec`],
      ["POST", `/containers/${ID_A}/attach`],
      ["POST", "/v1.44/containers/" + ID_A + "/attach"],
      ["POST", `/containers/${ID_A}/kill`],
      ["POST", `/containers/${ID_A}/restart`],
      ["POST", `/containers/${ID_A}/pause`],
      ["POST", `/containers/${ID_A}/unpause`],
      ["POST", `/containers/${ID_A}/update`],
      ["POST", `/containers/${ID_A}/rename?name=x`],
      ["POST", `/containers/${ID_A}/wait`],
      ["POST", `/containers/${ID_A}/resize`],
      ["GET", `/containers/${ID_A}/logs?stdout=1`],
      ["GET", `/containers/${ID_A}/top`],
      ["GET", `/containers/${ID_A}/changes`],
      ["GET", `/containers/${ID_A}/export`],
      ["GET", `/containers/${ID_A}/archive?path=/`],
      ["PUT", `/containers/${ID_A}/archive`],
      ["HEAD", `/containers/${ID_A}/archive`],
      ["DELETE", `/containers/${ID_A}`],
      ["POST", "/containers/prune"],
      ["GET", "/containers/json"],
      ["POST", "/build"],
      ["POST", "/images/create?fromImage=alpine"],
      ["POST", "/images/load"],
      ["DELETE", "/images/x"],
      ["POST", "/networks/create"],
      ["POST", "/networks/arena/connect"],
      ["POST", "/volumes/create"],
      ["GET", "/secrets"],
      ["POST", "/swarm/init"],
      ["GET", "/plugins"],
      ["GET", "/events"],
      ["GET", "/_ping"],
      ["GET", "/version"],
      ["GET", "/info"],
      ["POST", "/session"],
      ["POST", `/exec/${ID_A}/start`],
      ["POST", `/containers/${ID_A}/json`], // método incorrecto
      ["GET", `/containers/${ID_A}/start`], // método incorrecto
      ["PUT", "/containers/create"], // método incorrecto
    ];
    for (const [method, path] of cases) {
      const d = evaluateProxyRequest(method, path, undefined);
      expect(d.ok, `${method} ${path}`).toBe(false);
      if (d.ok === false) expect(d.status, `${method} ${path}`).toBe(403);
    }
  });

  it("admite las cinco operaciones permitidas (con prefijo de versión incluido)", () => {
    expect(evaluateProxyRequest("POST", "/v1.44/containers/create?name=bot-x", JSON.stringify(goodBody())).ok).toBe(
      true,
    );
    expect(evaluateProxyRequest("POST", `/containers/${ID_A}/start`, undefined).ok).toBe(true);
    expect(evaluateProxyRequest("POST", `/containers/${ID_A}/stop?t=5`, undefined).ok).toBe(true);
    expect(evaluateProxyRequest("GET", `/containers/${ID_A}/json`, undefined).ok).toBe(true);
    expect(evaluateProxyRequest("GET", `/containers/${ID_A}/stats?stream=false`, undefined).ok).toBe(true);
  });

  it("reconstruye la ruta reenviada (nada se pasa tal cual al socket)", () => {
    const d = evaluateProxyRequest("POST", "/v1.44/containers/create?name=bot-x&extra=1", JSON.stringify(goodBody()));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.forwardPath).toBe("/containers/create?name=bot-x");
    const s = evaluateProxyRequest("POST", `/containers/${ID_A}/stop?t=5&signal=KILL`, undefined);
    if (s.ok) expect(s.forwardPath).toBe(`/containers/${ID_A}/stop?t=5`);
  });

  it("rechaza identificadores raros (path traversal / opciones inyectadas), nombres inválidos y timeouts fuera de rango", () => {
    expect(evaluateProxyRequest("POST", "/containers/../images/start", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("GET", "/containers/%2e%2e/json", undefined).ok).toBe(false);
    expect(evaluateProxyRequest("POST", "/containers/create?name=../../x", JSON.stringify(goodBody())).ok).toBe(false);
    expect(evaluateProxyRequest("POST", `/containers/${ID_A}/stop?t=99999`, undefined).ok).toBe(false);
    expect(evaluateProxyRequest("POST", `/containers/${ID_A}/start`, '{"x":1}').ok).toBe(false);
  });
});

// ── P8/P9 · validación de input y postura ────────────────────────────────────

describe("R6.2 · digest de imagen (sigue rechazando tag/placeholder/hash corto)", () => {
  const withImage = (image: string) =>
    createBodyViolations({ ...goodBody(), Image: image }).filter((v) => /imagen|digest|placeholder/i.test(v));
  it("forma de digest de GHCR y de registry local: la POSTURA no los rechaza (la allowlist decide aparte)", () => {
    expect(withImage(`ghcr.io/pjclavero/s9-ai-arena/s9-smoke-bot@sha256:${realHex}`)).toEqual([]);
    expect(withImage(`127.0.0.1:5000/s9-smoke-bot@sha256:${realHex}`)).toEqual([]);
  });
  it("rechaza tag sin digest, digest placeholder y hash mal formado", () => {
    expect(withImage("127.0.0.1:5000/s9-smoke-bot:0.1.0").length).toBeGreaterThan(0);
    expect(withImage(`127.0.0.1:5000/s9-smoke-bot@sha256:${"0".repeat(64)}`).length).toBeGreaterThan(0);
    expect(withImage("127.0.0.1:5000/s9-smoke-bot@sha256:deadbeef").length).toBeGreaterThan(0);
  });
});

describe("R6.2 · seccomp inline (bug VM108: la API exige JSON, no ruta)", () => {
  const seccompValue = (body: Record<string, unknown>) =>
    ((body.HostConfig as Record<string, unknown>).SecurityOpt as string[])
      .find((o) => o.startsWith("seccomp="))!
      .slice("seccomp=".length);

  it("inlineSeccompProfile devuelve JSON minificado del perfil (no la ruta)", () => {
    const json = inlineSeccompProfile(SECCOMP_PATH);
    expect(JSON.parse(json)).toHaveProperty("defaultAction");
  });
  it("buildCreateBody pone seccomp=<json>, NUNCA seccomp=<ruta>", () => {
    const v = seccompValue(goodBody());
    expect(v.startsWith("{")).toBe(true);
    expect(v).not.toBe("unconfined");
  });
  it("falla ANTES de Docker si el perfil no existe o no es JSON", () => {
    expect(() => ProxyContainerRunner.buildCreateBody({ ...spec, seccompProfilePath: "/no/existe.json" })).toThrow(
      /no encontrado/,
    );
    const dir = mkdtempSync(join(tmpdir(), "rc2px-seccomp-"));
    writeFileSync(join(dir, "bad.json"), "{ esto no es json", "utf8");
    expect(() => inlineSeccompProfile(join(dir, "bad.json"))).toThrow(/no es JSON válido/);
  });
});

describe("RC2 · P8/P9 · postura del sandbox exigida por el proxy", () => {
  const mut = (f: (b: any) => void) => {
    const b = goodBody();
    f(b);
    return createBodyViolations(b).join("; ");
  };

  it("admite el cuerpo que construye el propio runner (postura conforme, una sola fuente de verdad)", () => {
    expect(createBodyViolations(goodBody())).toEqual([]);
    expect(complianceViolations(postureFromCreateBody(goodBody()))).toEqual([]);
  });

  it.each<[string, (b: any) => void, RegExp]>([
    ["privileged", (b) => (b.HostConfig.Privileged = true), /privileg/i],
    [
      "bind de docker.sock",
      (b) => (b.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"]),
      /docker\.sock/,
    ],
    ["Mounts bind", (b) => (b.HostConfig.Mounts = [{ Type: "bind", Source: "/etc", Target: "/x" }]), /no-tmpfs/],
    [
      "Mounts volume",
      (b) => (b.HostConfig.Mounts = [{ Type: "volume", Source: "postgres_data", Target: "/x" }]),
      /no-tmpfs/,
    ],
    ["Volumes", (b) => (b.Volumes = { "/data": {} }), /campo no permitido en el create: Volumes/],
    ["red del host", (b) => (b.HostConfig.NetworkMode = "host"), /red del host/],
    ["red de otro contenedor", (b) => (b.HostConfig.NetworkMode = "container:postgres"), /comparte red/],
    ["red bridge", (b) => (b.HostConfig.NetworkMode = "bridge"), /red distinta/],
    [
      "endpoint extra (bot-control)",
      (b) => (b.NetworkingConfig.EndpointsConfig["s9-bot-control"] = {}),
      /red no permitida/,
    ],
    [
      "endpoint con IP fija",
      (b) => (b.NetworkingConfig.EndpointsConfig.arena = { IPAMConfig: { IPv4Address: "10.0.0.9" } }),
      /debe ser \{\}/,
    ],
    ["PidMode host", (b) => (b.HostConfig.PidMode = "host"), /PidMode/],
    ["IpcMode host", (b) => (b.HostConfig.IpcMode = "host"), /IpcMode/],
    ["UsernsMode host", (b) => (b.HostConfig.UsernsMode = "host"), /UsernsMode/],
    ["UTSMode host", (b) => (b.HostConfig.UTSMode = "host"), /UTSMode/],
    ["User root", (b) => (b.User = "root"), /usuario|root/],
    ["User 0:0", (b) => (b.User = "0:0"), /usuario/],
    ["User ausente", (b) => delete b.User, /usuario|root/],
    ["CapAdd", (b) => (b.HostConfig.CapAdd = ["SYS_ADMIN"]), /CapAdd/],
    ["sin cap-drop ALL", (b) => (b.HostConfig.CapDrop = ["NET_RAW"]), /cap-drop ALL/],
    ["seccomp unconfined", (b) => (b.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]), /seccomp/],
    [
      "sin no-new-privileges",
      (b) => (b.HostConfig.SecurityOpt = b.HostConfig.SecurityOpt.slice(1)),
      /no-new-privileges/,
    ],
    ["rootfs escribible", (b) => (b.HostConfig.ReadonlyRootfs = false), /solo lectura/],
    ["DNS externo", (b) => (b.HostConfig.Dns = ["1.1.1.1"]), /DNS externo/],
    ["Devices", (b) => (b.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]), /HostConfig: Devices/],
    ["PortBindings", (b) => (b.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }), /PortBindings/],
    ["RestartPolicy", (b) => (b.HostConfig.RestartPolicy = { Name: "always" }), /RestartPolicy/],
    ["ExposedPorts", (b) => (b.ExposedPorts = { "80/tcp": {} }), /ExposedPorts/],
    ["sin límite de memoria", (b) => delete b.HostConfig.Memory, /Memory/],
    ["sin límite de CPU", (b) => delete b.HostConfig.NanoCpus, /NanoCpus/],
    ["sin límite de PIDs", (b) => delete b.HostConfig.PidsLimit, /PidsLimit/],
    ["PIDs ilimitados (-1)", (b) => (b.HostConfig.PidsLimit = -1), /PidsLimit/],
    [
      "memoria sobre el techo",
      (b) => ((b.HostConfig.Memory = 8 * 2 ** 30), (b.HostConfig.MemorySwap = 8 * 2 ** 30)),
      /techo/,
    ],
    ["CPU sobre el techo", (b) => (b.HostConfig.NanoCpus = 16e9), /techo/],
    ["swap extra", (b) => (b.HostConfig.MemorySwap = -1), /MemorySwap/],
    ["sin /tmp tmpfs", (b) => delete b.HostConfig.Tmpfs, /tmpfs/],
  ])("rechaza: %s", (_label, f, re) => {
    expect(mut(f)).toMatch(re);
    const b = goodBody();
    f(b);
    expect(createReq(b).ok).toBe(false);
  });

  it("cuerpo que no es objeto / no es JSON → rechazo", () => {
    expect(createBodyViolations([])).toEqual(["el cuerpo del create debe ser un objeto JSON"]);
    const d = evaluateProxyRequest("POST", "/containers/create", "{no json");
    expect(d.ok).toBe(false);
    if (d.ok === false) expect(d.status).toBe(400);
  });

  it("política relajada a otra red ≠ arena sigue vetada por la fuente de verdad (defensa en profundidad)", () => {
    const body = ProxyContainerRunner.buildCreateBody({ ...spec, network: "platform" });
    expect(createBodyViolations(body, { ...DEFAULT_POLICY, allowedNetwork: "platform" }).join("; ")).toMatch(
      /red no permitida: platform/,
    );
  });
});

// ── servidor real + backend Docker simulado ──────────────────────────────────

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  running: boolean;
  body?: any;
}

/** Doble de la Engine: ids de 64 hex, inspect con Id/Name/Config.Labels/State como la API. */
function fakeDockerBackend() {
  const containers = new Map<string, FakeContainer>();
  const requests: Array<{ method: string; path: string; body?: string }> = [];
  let seq = 0;
  const add = (c: Omit<FakeContainer, "id"> & { id?: string }) => {
    const id = c.id ?? (++seq).toString(16).padStart(64, "f");
    containers.set(id, { ...c, id });
    return id;
  };
  const backend: DockerBackend = {
    async dispatch(method, path, body) {
      requests.push({ method, path, body });
      if (method === "POST" && path.startsWith("/containers/create")) {
        const b = JSON.parse(body ?? "{}");
        const name = new URLSearchParams(path.split("?")[1] ?? "").get("name") ?? "anon";
        const id = add({ name, image: b.Image, labels: b.Labels ?? {}, running: false, body: b });
        return { status: 201, body: JSON.stringify({ Id: id, Warnings: [] }) };
      }
      const m = /^\/containers\/([^/?]+)\/(start|stop|json|stats)/.exec(path);
      // Como la Engine: resuelve por Id completo, por NOMBRE o por prefijo.
      const key = m?.[1] ?? "";
      const c =
        containers.get(key) ??
        [...containers.values()].find((x) => x.name === key || (key.length >= 12 && x.id.startsWith(key)));
      if (!c) return { status: 404, body: JSON.stringify({ message: `No such container: ${key}` }) };
      if (m![2] === "start") {
        c.running = true;
        return { status: 204, body: "" };
      }
      if (m![2] === "stop") {
        c.running = false;
        return { status: 204, body: "" };
      }
      if (m![2] === "stats") {
        return { status: 200, body: JSON.stringify({ cpu_stats: { cpu_usage: { total_usage: 5e9 } } }) };
      }
      const hc = c.body?.HostConfig ?? {};
      return {
        status: 200,
        body: JSON.stringify({
          Id: c.id,
          Name: `/${c.name}`,
          Config: { Image: c.image, User: c.body?.User, Labels: c.labels },
          State: { Running: c.running, ExitCode: 0, OOMKilled: false },
          HostConfig: hc,
          Mounts: [],
          NetworkSettings: { Networks: { [hc.NetworkMode ?? "bridge"]: {} } },
        }),
      };
    },
  };
  return { backend, containers, requests, add };
}

async function listen(server: import("node:http").Server, host = "127.0.0.1"): Promise<string> {
  await new Promise<void>((r) => server.listen(0, host, r));
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}
const close = (server: import("node:http").Server) => new Promise<void>((r) => server.close(() => r()));

describe("RC2 · P4 · contenedores ajenos: 403 y la víctima sigue igual (N21–N23 de OPS-C)", () => {
  const fake = fakeDockerBackend();
  const decisions: ProxyDecisionLog[] = [];
  const server = createDockerProxyServer({ backend: fake.backend, onDecision: (d) => decisions.push(d) });
  let url = "";
  const victims: Record<string, string> = {};

  beforeAll(async () => {
    url = await listen(server);
    victims.postgres = fake.add({
      name: "infrastructure-postgres-1",
      image: "postgres@sha256:x",
      labels: {},
      running: true,
    });
    victims.gateway = fake.add({
      name: "infrastructure-gateway-1",
      image: "gateway@sha256:x",
      labels: { "com.docker.compose.service": "gateway" },
      running: true,
    });
    // Creado FUERA del proxy imitando parte de las labels: sigue siendo ajeno.
    victims.mimic = fake.add({ name: "bot-x", image: RUNTIME_PY, labels: { [LABEL_MANAGED]: "true" }, running: true });
    // De OTRA instancia del proxy.
    victims.otherInstance = fake.add({
      name: "bot-y",
      image: RUNTIME_PY,
      labels: { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: "otra-instancia" },
      running: true,
    });
  });
  afterAll(() => close(server));

  for (const victim of ["postgres", "gateway", "mimic", "otherInstance"]) {
    for (const [method, op] of [
      ["POST", "stop"],
      ["POST", "start"],
      ["GET", "json"],
      ["GET", "stats?stream=false"],
    ]) {
      it(`${method} ${op} sobre ${victim} → 403; la víctima sigue running y el backend sólo vio el inspect`, async () => {
        const id = victims[victim];
        const before = fake.requests.length;
        const res = await fetch(`${url}/containers/${id}/${op}`, { method });
        expect(res.status).toBe(403);
        expect((await res.json()).message).toMatch(/no gestionado por este proxy|instance/);
        expect(fake.containers.get(id)!.running).toBe(true);
        const seen = fake.requests.slice(before);
        expect(seen).toEqual([{ method: "GET", path: `/containers/${id}/json`, body: undefined }]);
      });
    }
  }

  it("por NOMBRE (infrastructure-postgres-1) ni siquiera se inspecciona: 403 y 0 llamadas al backend", async () => {
    const before = fake.requests.length;
    const res = await fetch(`${url}/containers/infrastructure-postgres-1/stop`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(fake.requests.length).toBe(before);
    expect(fake.containers.get(victims.postgres)!.running).toBe(true);
  });

  it("cada denegación queda registrada con motivo y la IP de origen", () => {
    const denied = decisions.filter((d) => !d.allowed && /no gestionado|instance/.test(d.reason ?? ""));
    expect(denied.length).toBeGreaterThanOrEqual(16);
    for (const d of denied) expect(d.client).toBe("127.0.0.1");
  });
});

describe("RC2 · el runner sigue funcionando con el proxy endurecido (AutoRemove, stop 404, state())", () => {
  const fake = fakeDockerBackend();
  const rejections: string[] = [];
  const server = createDockerProxyServer({
    backend: fake.backend,
    onDecision: (e) => {
      if (!e.allowed) rejections.push(e.reason ?? "");
    },
  });
  let url = "";
  beforeAll(async () => {
    url = await listen(server);
  });
  afterAll(() => close(server));

  it("launch → create+start; posture() conforme; cpuMs(); state(); stop()", async () => {
    const handle = await new ProxyContainerRunner(url).launch({ ...spec, autoRemove: true });
    const c = fake.containers.get(handle.id)!;
    expect(c.running).toBe(true);
    expect(c.labels).toEqual({ [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: DEFAULT_PROXY_INSTANCE });
    expect(c.body.HostConfig.AutoRemove).toBe(true);
    expect(complianceViolations(await handle.posture())).toEqual([]);
    expect(await handle.cpuMs()).toBe(5000);
    expect(await handle.state()).toMatchObject({ running: true, gone: false });
    await handle.stop();
    expect(c.running).toBe(false);
    for (const r of fake.requests) {
      expect(r.path).toMatch(
        /^\/containers\/(create\?name=|[0-9a-f]{64}\/(start|stop(\?t=\d+)?|json|stats\?stream=false)$)/,
      );
    }
  });

  it("contenedor ya desaparecido (AutoRemove): stop() no lanza (404) y state() = gone", async () => {
    const handle = await new ProxyContainerRunner(url).launch({ ...spec, autoRemove: true });
    fake.containers.delete(handle.id);
    const res = await fetch(`${url}/containers/${handle.id}/stop?t=5`, { method: "POST" });
    expect(res.status).toBe(404);
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(await handle.state()).toMatchObject({ gone: true, running: false });
    expect(await handle.cpuMs()).toBeNull();
  });

  it("una instancia NO puede operar contenedores de otra (aislamiento por s9.proxy.instance)", async () => {
    const other = createDockerProxyServer({
      backend: fake.backend,
      policy: { ...DEFAULT_POLICY, instance: "rc2px-b" },
    });
    const otherUrl = await listen(other);
    try {
      const handle = await new ProxyContainerRunner(url).launch(spec);
      const res = await fetch(`${otherUrl}/containers/${handle.id}/stop`, { method: "POST" });
      expect(res.status).toBe(403);
      expect(fake.containers.get(handle.id)!.running).toBe(true);
      await handle.stop();
    } finally {
      await close(other);
    }
  });

  it("N20 · create con imagen ajena por digest → 403 y NO llega al backend", async () => {
    const before = fake.requests.length;
    const res = await fetch(`${url}/containers/create?name=rc2px-n20`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodBody(), Image: `ghcr.io/pjclavero/s9-ai-arena/gateway@sha256:${realHex}` }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/fuera de la allowlist/);
    expect(fake.requests.length).toBe(before);
  });

  it("una petición hostil (privileged + docker.sock) recibe 403 y NO llega al backend", async () => {
    const hostile = goodBody();
    hostile.HostConfig.Privileged = true;
    hostile.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"];
    const before = fake.requests.length;
    const res = await fetch(`${url}/containers/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hostile),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/privileged/);
    expect(fake.requests.length).toBe(before);
    expect(rejections.some((r) => r.includes("privileged"))).toBe(true);
  });

  it("el digest placeholder se rechaza también en el runner (antes de llegar al proxy)", async () => {
    const bad = { ...spec, imageDigest: "arena/bot-runtime-python@sha256:" + "0".repeat(64) };
    await expect(new ProxyContainerRunner(url).launch(bad)).rejects.toThrow(/placeholder/);
  });

  it("si la allowlist no se puede cargar, el create se DENIEGA (fail closed), no se admite", () => {
    // Política con un lock que no existe → el servidor no llega a crearse con
    // proxyConfigFromEnv; aquí, a nivel de librería, un conjunto vacío = denegar todo.
    expect(imageAllowlistViolation(RUNTIME_PY, { ...DEFAULT_POLICY, imageAllowlist: new Set() })).toMatch(/fuera/);
  });
});

// ── control del cliente ──────────────────────────────────────────────────────

describe("RC2 · control del cliente por IP de origen", () => {
  it("parseAllowedClients: CIDR e IP sueltas; falla cerrado con basura, /0 o lista vacía", () => {
    expect(parseAllowedClients("10.89.250.0/24").list).toEqual(["10.89.250.0/24"]);
    expect(parseAllowedClients("10.89.250.0/24, 127.0.0.1 ::1").list).toHaveLength(3);
    for (const bad of [
      "",
      " , ",
      "0.0.0.0/0",
      "::/0",
      "10.89.250.0/33",
      "10.89.250.0/x",
      "host-gateway",
      "10.89.250/24",
      "1.2.3.4/24/1",
    ]) {
      expect(() => parseAllowedClients(bad), bad).toThrow();
    }
  });

  it("isClientAllowed: dentro/fuera de la subred, IPv4 mapeada en IPv6, origen ausente", () => {
    const { blockList } = parseAllowedClients("10.89.250.0/24");
    expect(isClientAllowed("10.89.250.7", blockList)).toBe(true);
    expect(isClientAllowed("::ffff:10.89.250.7", blockList)).toBe(true);
    expect(isClientAllowed("10.89.251.7", blockList)).toBe(false);
    expect(isClientAllowed("172.17.0.1", blockList)).toBe(false);
    expect(isClientAllowed("127.0.0.1", blockList)).toBe(false);
    expect(isClientAllowed("::ffff:172.20.0.5", blockList)).toBe(false);
    expect(isClientAllowed(undefined, blockList)).toBe(false);
    expect(isClientAllowed("basura", blockList)).toBe(false);
  });

  it("un cliente fuera de la lista recibe 403, se le cierra la conexión y NADA llega al backend", async () => {
    const fake = fakeDockerBackend();
    const decisions: ProxyDecisionLog[] = [];
    const server = createDockerProxyServer({
      backend: fake.backend,
      allowedClients: ["10.89.250.0/24"], // el test conecta desde 127.0.0.1: fuera
      onDecision: (d) => decisions.push(d),
    });
    const url = await listen(server);
    try {
      // Incluso una petición que en sí sería válida (create conforme).
      const res = await fetch(`${url}/containers/create?name=bot-x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(goodBody()),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/cliente no autorizado/);
      expect(fake.requests).toEqual([]);
      expect(
        decisions.some((d) => !d.allowed && d.client === "127.0.0.1" && /cliente no autorizado/.test(d.reason!)),
      ).toBe(true);

      // A nivel TCP: la respuesta llega SIN haber enviado petición y el socket se cierra.
      const port = Number(new URL(url).port);
      const raw = await new Promise<string>((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1");
        let buf = "";
        s.on("data", (c) => (buf += c));
        s.on("close", () => resolve(buf));
        s.on("error", reject);
        setTimeout(() => reject(new Error("el proxy no cerró la conexión")), 3000);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 403/);
      expect(fake.requests).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it("sin allowedClients el defecto es SÓLO loopback (el cliente local pasa)", async () => {
    const fake = fakeDockerBackend();
    const server = createDockerProxyServer({ backend: fake.backend });
    const url = await listen(server);
    try {
      const res = await fetch(`${url}/containers/create?name=bot-x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(goodBody()),
      });
      expect(res.status).toBe(201);
    } finally {
      await close(server);
    }
  });

  it("una lista de clientes inválida impide CREAR el servidor (no llega a escuchar)", () => {
    expect(() =>
      createDockerProxyServer({ backend: fakeDockerBackend().backend, allowedClients: "0.0.0.0/0" }),
    ).toThrow(/demasiado amplio/);
  });
});

// ── bind / configuración ─────────────────────────────────────────────────────

describe("RC2 · bind y configuración: fallan CERRADO", () => {
  const base = { DOCKER_PROXY_BIND: "10.89.250.1", DOCKER_PROXY_ALLOWED_CLIENTS: "10.89.250.0/24" };

  it("configuración de producción del contrato: 10.89.250.1:2375, clientes 10.89.250.0/24, lock del árbol", () => {
    const c = proxyConfigFromEnv(base);
    expect(c.bind).toBe("10.89.250.1");
    expect(c.port).toBe(2375);
    expect(c.allowedClients).toEqual(["10.89.250.0/24"]);
    expect(c.imageAllowlistPath).toBe(DEFAULT_IMAGE_ALLOWLIST_PATH);
    expect([...c.policy.imageAllowlist].sort()).toEqual([...RUNTIME_IMAGES].sort());
    expect(c.policy.instance).toBe(DEFAULT_PROXY_INSTANCE);
    expect(c.warnings).toEqual([]);
  });

  it.each([
    ["ausente", undefined],
    ["vacío", ""],
    ["espacios", "   "],
    ["0.0.0.0", "0.0.0.0"],
    ["::", "::"],
    ["::0", "::0"],
    ["0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:0"],
    ["host-gateway", "host-gateway"],
    ["nombre de host", "docker-proxy.internal"],
    ["localhost (nombre)", "localhost"],
    ["con puerto", "10.89.250.1:2375"],
  ])("DOCKER_PROXY_BIND %s → no arranca", (_l, bind) => {
    expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_BIND: bind })).toThrow(/DOCKER_PROXY_BIND/);
  });

  it("la IP de docker0 está prohibida (la detecta por interfaz, no por número)", () => {
    const ifaces = { docker0: [{ address: "192.0.2.1" }], "s9-botctl0": [{ address: "10.89.250.1" }] };
    expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_BIND: "192.0.2.1" }, ifaces)).toThrow(/docker0/);
    expect(proxyConfigFromEnv(base, ifaces).bind).toBe("10.89.250.1");
  });

  it("el opt-in de tests sólo relaja comodín/docker0, avisa, y sigue exigiendo clientes explícitos", () => {
    const optIn = { DOCKER_PROXY_INSECURE_BIND_FOR_TESTS: "1" };
    expect(() => proxyConfigFromEnv({ ...optIn, DOCKER_PROXY_BIND: "0.0.0.0" })).toThrow(/ALLOWED_CLIENTS/);
    const c = proxyConfigFromEnv({
      ...optIn,
      DOCKER_PROXY_BIND: "0.0.0.0",
      DOCKER_PROXY_ALLOWED_CLIENTS: "10.89.247.0/24",
    });
    expect(c.warnings.join(" ")).toMatch(/SÓLO PARA TESTS/);
    expect(() => proxyConfigFromEnv({ ...optIn, DOCKER_PROXY_BIND: "" })).toThrow(/obligatorio/);
    expect(() =>
      proxyConfigFromEnv({
        DOCKER_PROXY_INSECURE_BIND_FOR_TESTS: "true",
        DOCKER_PROXY_BIND: "0.0.0.0",
        DOCKER_PROXY_ALLOWED_CLIENTS: "10.0.0.0/8",
      }),
    ).toThrow(/prohibido/);
  });

  it("bind no loopback sin DOCKER_PROXY_ALLOWED_CLIENTS → no arranca; loopback sin él → sólo loopback", () => {
    expect(() => proxyConfigFromEnv({ DOCKER_PROXY_BIND: "10.89.250.1" })).toThrow(/ALLOWED_CLIENTS es obligatorio/);
    expect(() => proxyConfigFromEnv({ DOCKER_PROXY_BIND: "172.17.0.1" })).toThrow(/ALLOWED_CLIENTS es obligatorio/);
    expect(proxyConfigFromEnv({ DOCKER_PROXY_BIND: "127.0.0.1" }).allowedClients).toEqual(["127.0.0.0/8", "::1/128"]);
    expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_ALLOWED_CLIENTS: "0.0.0.0/0" })).toThrow(
      /demasiado amplio/,
    );
  });

  it("puerto, instancia y allowlist inválidos → no arranca; lock propio admitido", () => {
    for (const p of ["0", "65536", "abc", "-1", "23 75"]) {
      expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_PORT: p }), p).toThrow(/PORT/);
    }
    expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_INSTANCE: "../x" })).toThrow(/INSTANCE/);
    expect(() => proxyConfigFromEnv({ ...base, DOCKER_PROXY_IMAGE_ALLOWLIST: "/no/existe.lock" })).toThrow(
      /no encontrada/,
    );
    const dir = mkdtempSync(join(tmpdir(), "rc2px-lock-"));
    const lock = join(dir, "DIGESTS.lock");
    writeFileSync(lock, `smoke base@sha256:${realHex} 127.0.0.1:5000/s9-smoke-bot@sha256:${realHex}\n`);
    expect([...proxyConfigFromEnv({ ...base, DOCKER_PROXY_IMAGE_ALLOWLIST: lock }).policy.imageAllowlist]).toEqual([
      `127.0.0.1:5000/s9-smoke-bot@sha256:${realHex}`,
    ]);
  });
});

// ── el PROCESO real (docker-proxy-main.ts), sin Docker ───────────────────────

const TSX = join(REPO, "node_modules", ".bin", "tsx");
const MAIN = join(REPO, "apps", "bot-manager", "src", "docker-proxy-main.ts");

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function runMain(env: Record<string, string>, untilLog?: RegExp, timeoutMs = 20_000) {
  const child = spawn(TSX, [MAIN], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DOCKER_SOCKET: "/nonexistent.sock", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout esperando ${untilLog}: ${out}`)), timeoutMs);
    const check = () => {
      if (untilLog && untilLog.test(out)) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout.on("data", check);
    void exited.then(() => {
      clearTimeout(t);
      if (untilLog && !untilLog.test(out)) reject(new Error(`salió antes de ${untilLog}: ${out}`));
      else resolve();
    });
  });
  return { child, exited, ready, output: () => out };
}

describe("RC2 · el proceso docker-proxy-main.ts aplica la configuración (spawn real)", () => {
  it.each([
    ["sin DOCKER_PROXY_BIND", {}],
    ["bind 0.0.0.0", { DOCKER_PROXY_BIND: "0.0.0.0", DOCKER_PROXY_ALLOWED_CLIENTS: "10.89.250.0/24" }],
    ["bind host-gateway", { DOCKER_PROXY_BIND: "host-gateway" }],
    ["bind no loopback sin clientes", { DOCKER_PROXY_BIND: "10.89.250.1" }],
    ["allowlist inexistente", { DOCKER_PROXY_BIND: "127.0.0.1", DOCKER_PROXY_IMAGE_ALLOWLIST: "/no/existe.lock" }],
  ])(
    "%s → exit 78 sin escuchar",
    async (_l, env) => {
      const p = runMain(env as Record<string, string>);
      const code = await p.exited;
      expect(code).toBe(78);
      expect(p.output()).toMatch(/configuración rechazada/);
      expect(p.output()).not.toMatch(/escuchando/);
    },
    30_000,
  );

  it("bind en loopback con clientes 10.89.250.0/24: arranca, pero a un cliente loopback le da 403 (el main cablea el control)", async () => {
    const port = await freePort();
    const p = runMain(
      {
        DOCKER_PROXY_BIND: "127.0.0.1",
        DOCKER_PROXY_PORT: String(port),
        DOCKER_PROXY_ALLOWED_CLIENTS: "10.89.250.0/24",
      },
      /proxy de Docker escuchando/,
    );
    try {
      await p.ready;
      const res = await fetch(`http://127.0.0.1:${port}/containers/${ID_A}/json`);
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/cliente no autorizado/);
      expect(p.output()).toMatch(/"allowed":false.*cliente no autorizado: 127\.0\.0\.1/);
    } finally {
      p.child.kill("SIGTERM");
      await p.exited;
    }
  }, 30_000);

  it("bind en loopback sin clientes: arranca (golden path de la CI), denegaciones de política y anuncio de la allowlist", async () => {
    const port = await freePort();
    const p = runMain(
      { DOCKER_PROXY_BIND: "127.0.0.1", DOCKER_PROXY_PORT: String(port) },
      /proxy de Docker escuchando/,
    );
    try {
      await p.ready;
      const res = await fetch(`http://127.0.0.1:${port}/containers/create?name=rc2px-x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...goodBody(), Image: `postgres@sha256:${realHex}` }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/fuera de la allowlist/);
      const startLine = p
        .output()
        .split("\n")
        .find((l) => l.includes("escuchando"))!;
      const parsed = JSON.parse(startLine);
      expect(parsed.allowedClients).toEqual(["127.0.0.0/8", "::1/128"]);
      expect([...parsed.imageAllowlist.images].sort()).toEqual([...RUNTIME_IMAGES].sort());
    } finally {
      p.child.kill("SIGTERM");
      await p.exited;
    }
  }, 30_000);
});
