/**
 * R1.7 (ERR-SEC-02) · Proxy de la API de Docker con allowlist estricta.
 *
 * El bot-manager YA NO monta /var/run/docker.sock (RCE en el servicio que
 * procesa código de usuario = root en el host). En su lugar habla HTTP con
 * este proxy, que corre FUERA del Compose (en el host, ver docker-proxy-main.ts
 * y docs/despliegue.md) y es el único que toca el socket.
 *
 * Superficie expuesta (todo lo demás → 403):
 *   POST /containers/create        crear (cuerpo validado campo a campo)
 *   POST /containers/{id}/start    arrancar
 *   POST /containers/{id}/stop     parar
 *   GET  /containers/{id}/json     inspeccionar
 *
 * La validación del create NO es una blocklist: es una allowlist de campos
 * (campo desconocido = rechazo, fail closed) y además la postura resultante
 * debe pasar complianceViolations (compliance.mjs, la MISMA función que usa
 * el escáner del Compose y el runner: única fuente de verdad). Se rechazan en
 * particular: privileged, bind-mounts (Binds/Mounts no-tmpfs), red del host,
 * y cualquier usuario distinto del usuario del sandbox.
 *
 * HONESTIDAD DE ENTORNO: en esta máquina no hay Docker (ia02 sin grupo
 * docker). La lógica del proxy se verifica EN PROCESO con un backend simulado
 * (tests/docker-proxy.test.ts); la verificación viva contra el socket real
 * queda anotada como pendiente de R-DEPLOY.
 */

import http from "node:http";
import { complianceViolations } from "./compliance.mjs";
import { assertRealDigest } from "./digest-guard.js";
import type { SecurityPosture } from "./container-runner.js";

// ── política ─────────────────────────────────────────────────────────────────

export interface ProxyPolicy {
  /** Única red a la que puede conectarse un contenedor de bot. */
  allowedNetwork: string;
  /** Único usuario permitido dentro del contenedor (nunca root). */
  allowedUser: string;
  /** Tamaño máximo del cuerpo aceptado (anti-abuso). */
  maxBodyBytes: number;
}

export const DEFAULT_POLICY: ProxyPolicy = {
  allowedNetwork: "arena",
  allowedUser: "10001:10001",
  maxBodyBytes: 1024 * 1024,
};

// ── decisión ─────────────────────────────────────────────────────────────────

export type ProxyAction =
  | { kind: "create"; name?: string }
  | { kind: "start"; id: string }
  | { kind: "stop"; id: string; timeoutSeconds?: number }
  | { kind: "inspect"; id: string };

export type ProxyDecision =
  | { ok: true; action: ProxyAction; forwardPath: string; forwardBody: string | undefined }
  | { ok: false; status: number; reason: string };

const VERSION_PREFIX_RE = /^\/v\d+(?:\.\d+)?(?=\/)/;
const CONTAINER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_DIGEST_RE = /@sha256:[0-9a-f]{64}$/i;

/** Campos de primer nivel admitidos en el cuerpo del create. Lo demás = 403. */
const CREATE_KEYS = new Set([
  "Image",
  "Env",
  "Cmd",
  "Entrypoint",
  "User",
  "Labels",
  "WorkingDir",
  "HostConfig",
  "NetworkingConfig",
  "StopTimeout",
]);

/** Campos admitidos en HostConfig. Privileged/Binds/Mounts/CapAdd/… se
 *  comprueban aparte para dar un motivo específico; NO están aquí. */
const HOSTCONFIG_KEYS = new Set([
  "NetworkMode",
  "CapDrop",
  "SecurityOpt",
  "ReadonlyRootfs",
  "Tmpfs",
  "Memory",
  "MemorySwap",
  "NanoCpus",
  "PidsLimit",
  "Dns",
  "AutoRemove",
]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Traduce el cuerpo de un create a la postura de seguridad normalizada. */
export function postureFromCreateBody(body: Record<string, unknown>): SecurityPosture {
  const hc = isPlainObject(body.HostConfig) ? body.HostConfig : {};
  const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const binds = asArray(hc.Binds).map((b) => String(b).split(":")[0]);
  const mounts = asArray(hc.Mounts)
    .filter((m) => !isPlainObject(m) || m.Type !== "tmpfs")
    .map((m) => (isPlainObject(m) ? String(m.Source ?? m.Type ?? "mount") : String(m)));
  const bindMounts = [...binds, ...mounts];
  const secOpt = asArray(hc.SecurityOpt).map(String);
  const seccomp = secOpt.find((o) => o.startsWith("seccomp="))?.slice("seccomp=".length) ?? null;
  const networks = new Set<string>();
  if (typeof hc.NetworkMode === "string" && hc.NetworkMode) networks.add(hc.NetworkMode);
  const netCfg = isPlainObject(body.NetworkingConfig) ? body.NetworkingConfig : {};
  for (const n of Object.keys(isPlainObject(netCfg.EndpointsConfig) ? netCfg.EndpointsConfig : {})) networks.add(n);
  return {
    user: String(body.User ?? "root"),
    capDropAll: asArray(hc.CapDrop)
      .map((c) => String(c).toUpperCase())
      .includes("ALL"),
    readonlyRootfs: hc.ReadonlyRootfs === true,
    noNewPrivileges: secOpt.includes("no-new-privileges"),
    seccompProfile: seccomp,
    networks: [...networks],
    hasExternalDns: asArray(hc.Dns).some((d) => String(d) !== "0.0.0.0"),
    tmpfsMounts: Object.keys(isPlainObject(hc.Tmpfs) ? hc.Tmpfs : {}),
    mountsDockerSock: bindMounts.some((s) => s.includes("docker.sock")),
    privileged: hc.Privileged === true,
    bindMounts,
    limits: {
      cpus: typeof hc.NanoCpus === "number" ? hc.NanoCpus / 1e9 : undefined,
      memoryBytes: typeof hc.Memory === "number" ? hc.Memory : undefined,
      pids: typeof hc.PidsLimit === "number" ? hc.PidsLimit : undefined,
    },
  };
}

/** Motivos de rechazo de un cuerpo de create (vacío = admitido). */
export function createBodyViolations(body: unknown, policy: ProxyPolicy = DEFAULT_POLICY): string[] {
  if (!isPlainObject(body)) return ["el cuerpo del create debe ser un objeto JSON"];
  const v: string[] = [];
  const hc = isPlainObject(body.HostConfig) ? body.HostConfig : {};

  // Rechazos explícitos (mensaje específico, aunque la allowlist también los cazaría).
  if (hc.Privileged === true) v.push("privileged: true (contenedor privilegiado)");
  if (Array.isArray(hc.Binds) && hc.Binds.length > 0) v.push("bind-mounts (HostConfig.Binds)");
  if (Array.isArray(hc.Mounts) && hc.Mounts.some((m) => !isPlainObject(m) || m.Type !== "tmpfs"))
    v.push("montajes no-tmpfs (HostConfig.Mounts)");
  if (Array.isArray(hc.CapAdd) && hc.CapAdd.length > 0) v.push("añade capabilities (HostConfig.CapAdd)");
  if (hc.NetworkMode === "host") v.push("red del host (--network host)");
  else if (typeof hc.NetworkMode === "string" && hc.NetworkMode.startsWith("container:"))
    v.push(`comparte red de otro contenedor (${hc.NetworkMode})`);
  else if (hc.NetworkMode !== policy.allowedNetwork)
    v.push(`red distinta de la permitida "${policy.allowedNetwork}" (${String(hc.NetworkMode)})`);
  for (const k of ["PidMode", "IpcMode", "UsernsMode", "UTSMode"]) {
    if (k in hc) v.push(`namespace del host no permitido (HostConfig.${k})`);
  }
  const user = String(body.User ?? "");
  if (user !== policy.allowedUser)
    v.push(`usuario distinto del usuario del sandbox "${policy.allowedUser}" (${user || "ausente → root"})`);

  // Allowlist de campos: lo no listado se rechaza (fail closed), con la
  // excepción de los campos ya rechazados arriba con motivo específico.
  const explicit = new Set(["Privileged", "Binds", "Mounts", "CapAdd", "PidMode", "IpcMode", "UsernsMode", "UTSMode"]);
  for (const k of Object.keys(body)) {
    if (!CREATE_KEYS.has(k)) v.push(`campo no permitido en el create: ${k}`);
  }
  for (const k of Object.keys(hc)) {
    if (!HOSTCONFIG_KEYS.has(k) && !explicit.has(k)) v.push(`campo no permitido en HostConfig: ${k}`);
  }

  // Imagen SOLO por digest real (guard del issue #12).
  const image = String(body.Image ?? "");
  if (!IMAGE_DIGEST_RE.test(image)) v.push(`imagen sin digest sha256 fijado (${image || "ausente"})`);
  else {
    try {
      assertRealDigest(image, "imagen pedida al proxy de Docker");
    } catch (e) {
      v.push((e as Error).message);
    }
  }

  // La red declarada en NetworkingConfig también debe ser la permitida.
  const netCfg = isPlainObject(body.NetworkingConfig) ? body.NetworkingConfig : {};
  const endpoints = Object.keys(isPlainObject(netCfg.EndpointsConfig) ? netCfg.EndpointsConfig : {});
  for (const n of endpoints) {
    if (n !== policy.allowedNetwork) v.push(`NetworkingConfig con red no permitida: ${n}`);
  }

  // Única fuente de verdad: la postura resultante debe ser conforme (tabla 18.2).
  v.push(...complianceViolations(postureFromCreateBody(body)));
  return [...new Set(v)];
}

/** Decide sobre una petición HTTP al proxy. Todo lo no allowlisted → 403. */
export function evaluateProxyRequest(
  method: string,
  rawPath: string,
  body: string | undefined,
  policy: ProxyPolicy = DEFAULT_POLICY,
): ProxyDecision {
  const deny = (reason: string, status = 403): ProxyDecision => ({ ok: false, status, reason });

  let url: URL;
  try {
    url = new URL(rawPath.replace(VERSION_PREFIX_RE, ""), "http://proxy.invalid");
  } catch {
    return deny("ruta ilegible", 400);
  }
  const path = url.pathname;
  const m = method.toUpperCase();

  // POST /containers/create[?name=…]
  if (m === "POST" && path === "/containers/create") {
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return deny("cuerpo del create no es JSON válido", 400);
    }
    const violations = createBodyViolations(parsed, policy);
    if (violations.length) return deny(`create rechazado por el proxy: ${violations.join("; ")}`);
    const name = url.searchParams.get("name") ?? undefined;
    if (name !== undefined && !CONTAINER_ID_RE.test(name)) return deny(`nombre de contenedor no válido: ${name}`);
    return {
      ok: true,
      action: { kind: "create", name },
      // Se reconstruye la ruta y se re-serializa el cuerpo YA validado:
      // al backend nunca llega nada que el proxy no haya entendido.
      forwardPath: `/containers/create${name ? `?name=${encodeURIComponent(name)}` : ""}`,
      forwardBody: JSON.stringify(parsed),
    };
  }

  // POST /containers/{id}/(start|stop) · GET /containers/{id}/json
  const idMatch = /^\/containers\/([^/]+)\/(start|stop|json)$/.exec(path);
  if (idMatch) {
    const [, id, op] = idMatch;
    if (!CONTAINER_ID_RE.test(id)) return deny(`identificador de contenedor no válido: ${id}`);
    if (body && body.trim() && body.trim() !== "{}") return deny(`la operación ${op} no admite cuerpo`);
    if (op === "json") {
      if (m !== "GET") return deny(`método ${m} no permitido para inspect`);
      return {
        ok: true,
        action: { kind: "inspect", id },
        forwardPath: `/containers/${id}/json`,
        forwardBody: undefined,
      };
    }
    if (m !== "POST") return deny(`método ${m} no permitido para ${op}`);
    if (op === "stop") {
      const t = url.searchParams.get("t");
      const timeoutSeconds = t === null ? undefined : Number(t);
      if (
        timeoutSeconds !== undefined &&
        !(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 0 && timeoutSeconds <= 300)
      )
        return deny(`timeout de stop no válido: ${t}`);
      return {
        ok: true,
        action: { kind: "stop", id, timeoutSeconds },
        forwardPath: `/containers/${id}/stop${timeoutSeconds !== undefined ? `?t=${timeoutSeconds}` : ""}`,
        forwardBody: undefined,
      };
    }
    return { ok: true, action: { kind: "start", id }, forwardPath: `/containers/${id}/start`, forwardBody: undefined };
  }

  return deny(`endpoint fuera de la allowlist del proxy: ${m} ${path}`);
}

// ── backend + servidor ───────────────────────────────────────────────────────

export interface DockerBackendResponse {
  status: number;
  body: string;
}

/** Quien de verdad habla con Docker. En producción, el socket del host; en
 *  tests, un doble en memoria. */
export interface DockerBackend {
  dispatch(method: string, path: string, body?: string): Promise<DockerBackendResponse>;
}

/** Backend real: habla con /var/run/docker.sock. SOLO se usa en el host
 *  (docker-proxy-main.ts), nunca dentro del contenedor del bot-manager. */
export function createSocketBackend(socketPath = "/var/run/docker.sock"): DockerBackend {
  return {
    dispatch(method, path, body) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { socketPath, path, method, headers: { "content-type": "application/json", host: "docker" } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        req.on("error", reject);
        req.end(body ?? "");
      });
    },
  };
}

export interface ProxyServerOptions {
  backend: DockerBackend;
  policy?: ProxyPolicy;
  /** Auditoría: se llama con cada decisión (permitida o denegada). */
  onDecision?: (entry: { method: string; path: string; allowed: boolean; reason?: string }) => void;
}

/** Servidor HTTP del proxy. Valida, y solo entonces reenvía al backend. */
export function createDockerProxyServer(opts: ProxyServerOptions): http.Server {
  const policy = opts.policy ?? DEFAULT_POLICY;
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > policy.maxBodyBytes) overflow = true;
      else chunks.push(c);
    });
    req.on("end", async () => {
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      if (overflow) {
        opts.onDecision?.({
          method: req.method ?? "?",
          path: req.url ?? "?",
          allowed: false,
          reason: "cuerpo demasiado grande",
        });
        return respond(413, { message: "cuerpo demasiado grande" });
      }
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const decision = evaluateProxyRequest(req.method ?? "GET", req.url ?? "/", body, policy);
      if (decision.ok === false) {
        opts.onDecision?.({ method: req.method ?? "?", path: req.url ?? "?", allowed: false, reason: decision.reason });
        return respond(decision.status, { message: decision.reason });
      }
      opts.onDecision?.({ method: req.method ?? "?", path: req.url ?? "?", allowed: true });
      try {
        const backendRes = await opts.backend.dispatch(req.method ?? "GET", decision.forwardPath, decision.forwardBody);
        respond(backendRes.status, backendRes.body);
      } catch (e) {
        respond(502, { message: `backend de Docker inaccesible: ${(e as Error).message}` });
      }
    });
  });
}

// ── runner del bot-manager a través del proxy ────────────────────────────────

import type { ContainerHandle, ContainerRunner, SandboxSpec } from "./container-runner.js";
import { DockerContainerRunner } from "./container-runner.js";

/**
 * Runner de producción del bot-manager tras R1.7: SIN docker.sock. Habla con
 * el proxy (DOCKER_PROXY_URL) por HTTP; el proxy valida y reenvía al socket.
 * El cuerpo que construye es la traducción exacta de los flags de la tabla
 * 18.2 (DockerContainerRunner.buildRunArgs) a la API de create, y los tests
 * comprueban que el propio proxy lo admite y que su postura es conforme.
 */
export class ProxyContainerRunner implements ContainerRunner {
  constructor(private proxyUrl: string) {}

  /** Cuerpo del create equivalente a los flags de la tabla 18.2. */
  static buildCreateBody(spec: SandboxSpec): Record<string, unknown> {
    assertRealDigest(spec.imageDigest, `imagen de runtime para ${spec.botId} v${spec.version}`);
    const l = spec.limits;
    return {
      Image: spec.imageDigest,
      User: "10001:10001",
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges", `seccomp=${spec.seccompProfilePath}`],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${l.tmpfsBytes}` },
        NetworkMode: spec.network,
        Dns: ["0.0.0.0"],
        NanoCpus: Math.round(l.cpus * 1e9),
        Memory: l.memoryBytes,
        MemorySwap: l.memoryBytes, // sin swap extra
        PidsLimit: l.pids,
      },
      NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
    };
  }

  static containerName(spec: SandboxSpec): string {
    return `bot-${spec.botId}-v${spec.version}-${spec.battleId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100);
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(new URL(path, this.proxyUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  async launch(spec: SandboxSpec): Promise<ContainerHandle> {
    const body = ProxyContainerRunner.buildCreateBody(spec);
    const name = ProxyContainerRunner.containerName(spec);
    const created = await this.call("POST", `/containers/create?name=${encodeURIComponent(name)}`, body);
    if (created.status !== 201 || !created.json?.Id) {
      throw new Error(`el proxy rechazó el create (${created.status}): ${created.json?.message ?? "sin detalle"}`);
    }
    const id: string = created.json.Id;
    const started = await this.call("POST", `/containers/${id}/start`);
    if (started.status !== 204) {
      throw new Error(`el proxy rechazó el start (${started.status}): ${started.json?.message ?? "sin detalle"}`);
    }
    const call = this.call.bind(this);
    return {
      id,
      async stop() {
        const stopped = await call("POST", `/containers/${id}/stop?t=5`);
        if (stopped.status !== 204 && stopped.status !== 304) {
          throw new Error(`el proxy rechazó el stop (${stopped.status}): ${stopped.json?.message ?? "sin detalle"}`);
        }
      },
      async posture() {
        const inspected = await call("GET", `/containers/${id}/json`);
        if (inspected.status !== 200) {
          throw new Error(
            `el proxy rechazó el inspect (${inspected.status}): ${inspected.json?.message ?? "sin detalle"}`,
          );
        }
        return DockerContainerRunner.analyzeInspect(inspected.json);
      },
    };
  }
}
