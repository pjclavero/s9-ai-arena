/**
 * R1.7 (ERR-SEC-02) · Proxy de la API de Docker con allowlist estricta.
 *
 * El bot-manager YA NO monta /var/run/docker.sock (RCE en el servicio que
 * procesa código de usuario = root en el host). En su lugar habla HTTP con
 * este proxy, que corre FUERA del Compose (en el host, ver docker-proxy-main.ts
 * y docs/operations/docker-proxy.md) y es el único que toca el socket.
 *
 * Superficie expuesta (todo lo demás → 403):
 *   POST /containers/create        crear (cuerpo validado campo a campo)
 *   POST /containers/{id}/start    arrancar
 *   POST /containers/{id}/stop     parar
 *   GET  /containers/{id}/json     inspeccionar
 *   GET  /containers/{id}/stats?stream=false   métricas puntuales (B10, issue #9)
 *
 * B10 · POR QUÉ SE AMPLÍA LA ALLOWLIST CON `stats` (y por qué no se amplía más):
 *   - Es el ÚNICO sitio donde la Engine expone la CPU consumida por el cgroup del
 *     contenedor. El `inspect` ya permitido NO la trae (solo configuración y
 *     estado), así que sin este endpoint `cpuMs` seguiría siendo null para
 *     siempre — o, peor, un número estimado desde tiempo de pared, que es
 *     exactamente lo que este issue prohíbe.
 *   - Es de SOLO LECTURA y no añade ninguna autoridad nueva: solo se puede pedir
 *     sobre un id de contenedor que el llamador ya podía inspeccionar y parar.
 *     No crea, no ejecuta (`exec`), no adjunta (`attach`), no escribe ficheros
 *     (`archive`), no toca imágenes ni redes: todo eso sigue en 403.
 *   - `stream=false` es OBLIGATORIO (no un detalle de estilo): con `stream=true`
 *     la Engine mantiene la conexión abierta emitiendo muestras para siempre, y
 *     el proxy —que acumula la respuesta del backend antes de contestar— se
 *     quedaría colgado con la petición viva. Sería un vector de agotamiento de
 *     recursos abierto por el propio proxy. Se rechaza cualquier query que no
 *     sea exactamente `stream=false`.
 *   - Superficie de información: la respuesta trae, además de los contadores del
 *     contenedor, `system_cpu_usage`/`online_cpus` del host. Es estrictamente
 *     menos de lo que ya revela el `inspect` permitido (rutas, configuración
 *     completa), y el cliente del proxy es un servicio de la plataforma
 *     (arena-engine), nunca un bot: los bots viven en la red `arena` y no tienen
 *     ruta al proxy.
 *
 * La validación del create NO es una blocklist: es una allowlist de campos
 * (campo desconocido = rechazo, fail closed) y además la postura resultante
 * debe pasar complianceViolations (compliance.mjs, la MISMA función que usa
 * el escáner del Compose y el runner: única fuente de verdad). Se rechazan en
 * particular: privileged, bind-mounts (Binds/Mounts no-tmpfs), red del host,
 * y cualquier usuario distinto del usuario del sandbox.
 *
 * RC2 (DEV-PROXY) · ÁMBITO DEL PROXY. Hasta RC1 la allowlist era sólo de
 * ENDPOINTS y de POSTURA: quien alcanzara el proxy podía crear un contenedor con
 * CUALQUIER imagen fijada por digest y parar/arrancar/inspeccionar CUALQUIER
 * contenedor del host (controles N20–N23 de OPS-C: create con la imagen del
 * gateway = 201; stop de un contenedor ajeno = 204). Ahora hay cuatro controles
 * más, independientes entre sí, y todos fallan cerrado:
 *   1. CLIENTE: sólo se atiende a conexiones cuya IP de ORIGEN (la del socket,
 *      nunca una cabecera) está en `allowedClients` (DOCKER_PROXY_ALLOWED_CLIENTS).
 *      El resto recibe 403 y se cierra la conexión sin leer la petición.
 *      Defecto: SÓLO loopback. Razón: una IP propiedad del host es alcanzable
 *      desde cualquier contenedor con ruta por defecto (gateway, backup), así
 *      que el bind por sí solo no limita quién llega.
 *   2. IMAGEN: el create sólo admite una imagen que sea EXACTAMENTE una de la 3.ª
 *      columna de runtimes/DIGESTS.lock (imagen de runtime `repo@sha256:…`). La
 *      base (2.ª columna), un tag, un digest ajeno o cualquier otra imagen → 403.
 *   3. PROPIEDAD: el proxy IMPONE en el create las labels `s9.managed=true` y
 *      `s9.proxy.instance=<instancia>`; el cliente no puede fijar ninguna label
 *      `s9.*`. start/stop/json/stats exigen un Id COMPLETO (64 hex, nunca un
 *      nombre ni un prefijo), el proxy inspecciona ANTES el contenedor y sólo
 *      reenvía si lleva esas labels. Un contenedor ajeno (postgres, gateway, uno
 *      creado fuera del proxy) → 403 y no se le toca. Uno inexistente → 404 (el
 *      cliente lo trata como «ya parado», ver ProxyContainerRunner.stop).
 *   4. BIND (docker-proxy-main.ts / proxyConfigFromEnv): obligatorio, IP literal,
 *      nunca 0.0.0.0/::, nunca la IP de docker0 ni `host-gateway`.
 *
 * HONESTIDAD DE ENTORNO: la lógica se prueba EN PROCESO con un backend simulado
 * (tests/docker-proxy.test.ts, corre en la CI normal) y CONTRA DOCKER REAL con el
 * proxy real (tests/docker-proxy-docker.test.ts, opt-in con
 * S9_RUN_DOCKER_SANDBOX_E2E=1; ver su cabecera para lo que reproduce y lo que no).
 */

import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { complianceViolations } from "./compliance.mjs";
import { assertRealDigest, isPlaceholderDigest } from "./digest-guard.js";
import type { SecurityPosture } from "./container-runner.js";

/**
 * Lee el perfil seccomp del PATH y devuelve su JSON MINIFICADO para inyectarlo
 * inline en `HostConfig.SecurityOpt` (`seccomp=<json>`).
 *
 * La Docker Engine API **no** acepta una ruta de fichero en SecurityOpt: solo el
 * contenido JSON del perfil (el CLI `docker run --security-opt seccomp=<file>` es
 * quien lee el fichero). Pasar la ruta hace que el daemon intente parsearla como
 * JSON y falle ("Decoding seccomp profile failed: invalid character '/'"), que es
 * justo lo que rompió el arranque del runner en VM108. Falla ANTES de llamar a
 * Docker si el fichero no existe o no es JSON válido; nunca desactiva seccomp.
 */
export function inlineSeccompProfile(path: string): string {
  if (!existsSync(path)) throw new Error(`perfil seccomp no encontrado: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`perfil seccomp no es JSON válido (${path}): ${(e as Error).message}`);
  }
  return JSON.stringify(parsed);
}

// ── política ─────────────────────────────────────────────────────────────────

export interface ProxyPolicy {
  /** Única red a la que puede conectarse un contenedor de bot. */
  allowedNetwork: string;
  /** Único usuario permitido dentro del contenedor (nunca root). */
  allowedUser: string;
  /** Tamaño máximo del cuerpo aceptado (anti-abuso). */
  maxBodyBytes: number;
  /**
   * RC2 · imágenes admitidas en el create (coincidencia EXACTA). Sin definir ⇒ la
   * 3.ª columna del DIGESTS.lock del repo (DEFAULT_IMAGE_ALLOWLIST_PATH), cargada
   * en el primer uso; si no se puede cargar, TODO create se deniega (fail closed).
   * Un conjunto vacío deniega todo create.
   */
  imageAllowlist?: ReadonlySet<string>;
  /** RC2 · valor de la label `s9.proxy.instance` (defecto DEFAULT_PROXY_INSTANCE). */
  instance?: string;
  /** RC2 · techos de recursos (defecto DEFAULT_LIMIT_CEILINGS). Ausente/≤0 ⇒ rechazo. */
  limitCeilings?: LimitCeilings;
}

export interface LimitCeilings {
  maxMemoryBytes: number;
  maxNanoCpus: number;
  maxPids: number;
}

/**
 * RC2 · P8/P9. Antes el proxy admitía un create SIN límites (Memory/NanoCpus/
 * PidsLimit ausentes = ilimitado: agotamiento del host). Ahora son obligatorios,
 * positivos y con techo; sin swap extra (MemorySwap = Memory). Los techos son 4×
 * DEFAULT_LIMITS (0,5 CPU · 256 MiB · 64 PIDs), lo único que usan hoy los flujos
 * reales (build-sandbox, bot-launch, container-agents).
 */
export const DEFAULT_LIMIT_CEILINGS: LimitCeilings = {
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxNanoCpus: 2_000_000_000,
  maxPids: 256,
};

export const DEFAULT_POLICY: ProxyPolicy = {
  allowedNetwork: "arena",
  allowedUser: "10001:10001",
  maxBodyBytes: 1024 * 1024,
};

// ── RC2 · allowlist de imágenes (runtimes/DIGESTS.lock, 3.ª columna) ─────────

/** DIGESTS.lock del árbol desde el que corre el proxy (en VM108: /opt/s9-ai-arena). */
export const DEFAULT_IMAGE_ALLOWLIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "runtimes",
  "DIGESTS.lock",
);

/** Referencia de imagen completa por digest: `repo[/…]@sha256:<64 hex minúsculas>`. */
const FULL_IMAGE_REF_RE = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;

/**
 * Parsea un DIGESTS.lock (`<runtime> <base@digest> <imagen-runtime@digest>`) y
 * devuelve SÓLO la 3.ª columna. Falla CERRADO (lanza) si una línea útil no tiene
 * 3 columnas, si la 3.ª no es una referencia completa por digest o es placeholder,
 * o si no queda ninguna imagen. La 2.ª columna (imagen BASE) nunca entra: es la
 * imagen de la que se construye el runtime, no una con la que se lance un bot.
 */
export function parseImageAllowlist(text: string, source = "DIGESTS.lock"): Set<string> {
  const out = new Set<string>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const cols = line.split(/\s+/);
    if (cols.length !== 3) throw new Error(`${source}:${i + 1}: se esperaban 3 columnas, hay ${cols.length}`);
    const image = cols[2];
    if (!FULL_IMAGE_REF_RE.test(image))
      throw new Error(`${source}:${i + 1}: la 3.ª columna no es una imagen fijada por digest completo (${image})`);
    if (isPlaceholderDigest(image)) throw new Error(`${source}:${i + 1}: digest placeholder (${image})`);
    out.add(image);
  });
  if (out.size === 0) throw new Error(`${source}: ninguna imagen de runtime; el proxy no admitiría ningún create`);
  return out;
}

export function loadImageAllowlist(path: string = DEFAULT_IMAGE_ALLOWLIST_PATH): Set<string> {
  if (!existsSync(path)) throw new Error(`allowlist de imágenes no encontrada: ${path}`);
  return parseImageAllowlist(readFileSync(path, "utf8"), path);
}

let defaultAllowlistCache: { set?: ReadonlySet<string>; error?: string } | undefined;
/** Allowlist por defecto, cargada una sola vez y SÓLO cuando se usa (los clientes
 *  —tournament-worker, arena-engine— importan este módulo y no llevan el lock). */
function resolveImageAllowlist(policy: ProxyPolicy): { set?: ReadonlySet<string>; error?: string } {
  if (policy.imageAllowlist) return { set: policy.imageAllowlist };
  if (!defaultAllowlistCache) {
    try {
      defaultAllowlistCache = { set: loadImageAllowlist() };
    } catch (e) {
      defaultAllowlistCache = { error: (e as Error).message };
    }
  }
  return defaultAllowlistCache;
}

/** Motivo de rechazo de la imagen frente a la allowlist (null = admitida). */
export function imageAllowlistViolation(image: unknown, policy: ProxyPolicy = DEFAULT_POLICY): string | null {
  const { set, error } = resolveImageAllowlist(policy);
  if (!set) return `allowlist de imágenes no disponible (${error}): create denegado`;
  if (typeof image !== "string" || !set.has(image))
    return `imagen fuera de la allowlist de runtimes (DIGESTS.lock, 3.ª columna): ${String(image) || "ausente"}`;
  return null;
}

// ── RC2 · propiedad por labels impuestas ─────────────────────────────────────

export const DEFAULT_PROXY_INSTANCE = "s9-docker-proxy";
export const LABEL_MANAGED = "s9.managed";
export const LABEL_INSTANCE = "s9.proxy.instance";
export const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** Id de contenedor COMPLETO (lo que devuelve el create). Nunca nombre ni prefijo. */
const FULL_CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

/** Labels que el proxy impone en todo create que reenvía. */
export function ownerLabels(policy: ProxyPolicy = DEFAULT_POLICY): Record<string, string> {
  return { [LABEL_MANAGED]: "true", [LABEL_INSTANCE]: policy.instance ?? DEFAULT_PROXY_INSTANCE };
}

/**
 * Motivo por el que el contenedor inspeccionado NO es de este proxy (null = sí lo
 * es). Se decide SÓLO por las labels de `Config.Labels` del inspect de la Engine
 * y por la igualdad exacta del Id; nunca por el nombre.
 */
export function ownershipViolation(
  inspectJson: unknown,
  requestedId: string,
  policy: ProxyPolicy = DEFAULT_POLICY,
): string | null {
  const c = (Array.isArray(inspectJson) ? inspectJson[0] : inspectJson) as Record<string, unknown> | null;
  if (!isPlainObject(c)) return "inspect previo ilegible: no se puede comprobar la propiedad";
  if (c.Id !== requestedId) return `el Id inspeccionado no coincide con el pedido (${String(c.Id)})`;
  const cfg = isPlainObject(c.Config) ? c.Config : {};
  const labels = isPlainObject(cfg.Labels) ? cfg.Labels : {};
  const want = ownerLabels(policy);
  for (const [k, v] of Object.entries(want)) {
    if (labels[k] !== v)
      return `contenedor no gestionado por este proxy (label ${k}=${labels[k] === undefined ? "ausente" : JSON.stringify(labels[k])}, se exige ${JSON.stringify(v)})`;
  }
  return null;
}

// ── decisión ─────────────────────────────────────────────────────────────────

export type ProxyAction =
  | { kind: "create"; name?: string }
  | { kind: "start"; id: string }
  | { kind: "stop"; id: string; timeoutSeconds?: number }
  | { kind: "inspect"; id: string }
  | { kind: "stats"; id: string };

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

  // RC2 · labels del cliente: objeto string→string y NINGUNA en el espacio `s9.*`
  // (las de propiedad las impone el proxy; un cliente que pudiera fijarlas podría
  // fabricar un contenedor «gestionado» o suplantar otra instancia).
  if ("Labels" in body && body.Labels !== undefined && body.Labels !== null) {
    if (!isPlainObject(body.Labels)) v.push("Labels debe ser un objeto");
    else
      for (const [k, val] of Object.entries(body.Labels)) {
        if (/^s9\./i.test(k)) v.push(`label reservada al proxy: ${k} (el cliente no puede fijar labels s9.*)`);
        if (typeof val !== "string") v.push(`label ${k} con valor no string`);
      }
  }

  // La red declarada en NetworkingConfig también debe ser la permitida.
  const netCfg = isPlainObject(body.NetworkingConfig) ? body.NetworkingConfig : {};
  const endpoints = Object.keys(isPlainObject(netCfg.EndpointsConfig) ? netCfg.EndpointsConfig : {});
  for (const n of endpoints) {
    if (n !== policy.allowedNetwork) v.push(`NetworkingConfig con red no permitida: ${n}`);
    // RC2 · sin IPAM/alias/links: el endpoint del bot es siempre `{}`.
    const ep = (netCfg.EndpointsConfig as Record<string, unknown>)[n];
    if (!isPlainObject(ep) || Object.keys(ep).length > 0)
      v.push(`NetworkingConfig.EndpointsConfig.${n} debe ser {} (sin IPAM, alias ni links)`);
  }

  // RC2 · P8/P9 · límites obligatorios, positivos y con techo; sin swap extra.
  const ceil = policy.limitCeilings ?? DEFAULT_LIMIT_CEILINGS;
  const limit = (key: string, max: number) => {
    const val = hc[key];
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0)
      v.push(`límite obligatorio ausente o no válido: HostConfig.${key}`);
    else if (val > max) v.push(`HostConfig.${key}=${val} supera el techo del proxy (${max})`);
  };
  limit("Memory", ceil.maxMemoryBytes);
  limit("NanoCpus", ceil.maxNanoCpus);
  limit("PidsLimit", ceil.maxPids);
  if (hc.MemorySwap !== hc.Memory) v.push("HostConfig.MemorySwap debe ser igual a Memory (sin swap extra)");

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
    // RC2 · allowlist de imágenes: independiente de la postura (una imagen ajena
    // con postura impecable sigue fuera).
    if (isPlainObject(parsed)) {
      const imageV = imageAllowlistViolation(parsed.Image, policy);
      if (imageV) violations.push(imageV);
    }
    if (violations.length) return deny(`create rechazado por el proxy: ${violations.join("; ")}`);
    const name = url.searchParams.get("name") ?? undefined;
    if (name !== undefined && !CONTAINER_ID_RE.test(name)) return deny(`nombre de contenedor no válido: ${name}`);
    const validated = parsed as Record<string, unknown>;
    const clientLabels = isPlainObject(validated.Labels) ? (validated.Labels as Record<string, string>) : {};
    return {
      ok: true,
      action: { kind: "create", name },
      // Se reconstruye la ruta y se re-serializa el cuerpo YA validado:
      // al backend nunca llega nada que el proxy no haya entendido. Las labels
      // de propiedad se IMPONEN aquí (van después: ganan siempre).
      forwardPath: `/containers/create${name ? `?name=${encodeURIComponent(name)}` : ""}`,
      forwardBody: JSON.stringify({ ...validated, Labels: { ...clientLabels, ...ownerLabels(policy) } }),
    };
  }

  // POST /containers/{id}/(start|stop) · GET /containers/{id}/(json|stats)
  const idMatch = /^\/containers\/([^/]+)\/(start|stop|json|stats)$/.exec(path);
  if (idMatch) {
    const [, id, op] = idMatch;
    // RC2 · sólo Id COMPLETO: un nombre o un prefijo los resuelve la Engine y
    // podría designar otro contenedor que el inspeccionado (propiedad por nombre).
    if (!FULL_CONTAINER_ID_RE.test(id))
      return deny(`identificador de contenedor no válido (se exige el Id completo de 64 hex): ${id}`);
    if (body && body.trim() && body.trim() !== "{}") return deny(`la operación ${op} no admite cuerpo`);
    if (op === "stats") {
      // B10 · solo lectura puntual: GET y `stream=false` EXPLÍCITO, nada más
      // (ver la nota de cabecera: `stream=true` cuelga el proxy indefinidamente).
      if (m !== "GET") return deny(`método ${m} no permitido para stats`);
      const params = [...url.searchParams.entries()];
      const onlyStreamFalse = params.length === 1 && params[0][0] === "stream" && params[0][1] === "false";
      if (!onlyStreamFalse) {
        return deny(
          `stats solo se permite con exactamente ?stream=false (recibido: ${url.search || "sin query"}): ` +
            `el modo streaming dejaría la petición abierta indefinidamente`,
        );
      }
      return {
        ok: true,
        action: { kind: "stats", id },
        forwardPath: `/containers/${id}/stats?stream=false`,
        forwardBody: undefined,
      };
    }
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

// ── RC2 · control del cliente por IP de origen ───────────────────────────────

/** Clientes por defecto si no se declara ninguno: SÓLO loopback. */
export const LOOPBACK_CLIENTS: readonly string[] = ["127.0.0.0/8", "::1/128"];

/** `::ffff:a.b.c.d` (socket dual-stack) → `a.b.c.d`. */
export function normalizeAddress(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1] : addr;
}

/**
 * Parsea una lista de clientes admitidos (CIDR o IP sueltas, separadas por comas
 * o espacios). Lanza (fail closed) ante una entrada ilegible, ante `/0` (todo
 * Internet) o si la lista queda vacía.
 */
export function parseAllowedClients(spec: string | readonly string[]): { list: string[]; blockList: net.BlockList } {
  const items = (typeof spec === "string" ? spec.split(/[\s,]+/) : [...spec]).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error("lista de clientes admitidos vacía");
  const blockList = new net.BlockList();
  for (const item of items) {
    const [addr, prefixRaw, extra] = item.split("/");
    const family = net.isIP(addr);
    if (!family || extra !== undefined) throw new Error(`cliente admitido no válido (se espera IP o CIDR): ${item}`);
    const max = family === 4 ? 32 : 128;
    if (prefixRaw !== undefined && !/^\d{1,3}$/.test(prefixRaw)) throw new Error(`prefijo CIDR no válido: ${item}`);
    const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
    if (prefix > max) throw new Error(`prefijo CIDR no válido: ${item}`);
    if (prefix === 0) throw new Error(`cliente admitido demasiado amplio (/0 = cualquier origen): ${item}`);
    blockList.addSubnet(addr, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return { list: items, blockList };
}

/** ¿La IP de origen del socket está admitida? (undefined/ilegible ⇒ no). */
export function isClientAllowed(remoteAddress: string | undefined, allowed: net.BlockList): boolean {
  if (!remoteAddress) return false;
  const addr = normalizeAddress(remoteAddress);
  const family = net.isIP(addr);
  if (!family) return false;
  return allowed.check(addr, family === 4 ? "ipv4" : "ipv6");
}

export interface ProxyDecisionLog {
  method: string;
  path: string;
  allowed: boolean;
  reason?: string;
  /** IP de origen del socket (RC2: auditoría del control de cliente). */
  client?: string;
}

export interface ProxyServerOptions {
  backend: DockerBackend;
  policy?: ProxyPolicy;
  /**
   * RC2 · IPs/CIDR de origen admitidos (DOCKER_PROXY_ALLOWED_CLIENTS). Sin definir
   * ⇒ LOOPBACK_CLIENTS. Cualquier otro origen: 403 y cierre, sin leer la petición.
   */
  allowedClients?: string | readonly string[];
  /**
   * RC2 · orígenes SIEMPRE rechazados, aunque caigan dentro de `allowedClients`
   * (prevalecen). docker-proxy-config.ts pone aquí la IP de bind y las direcciones
   * locales del host: un proceso del host que conecta a 10.89.250.1 sale CON ORIGEN
   * 10.89.250.1, que está dentro de 10.89.250.0/24; sin esta exclusión sólo lo
   * pararía el firewall, y la capa del proxy debe ser independiente de él.
   */
  deniedClients?: string | readonly string[];
  /** Auditoría: se llama con cada decisión (permitida o denegada). */
  onDecision?: (entry: ProxyDecisionLog) => void;
}

/** Lista de exclusión (IP o CIDR); vacía ⇒ ninguna. Mismas reglas de parseo que la admitida. */
function parseDeniedClients(spec: string | readonly string[] | undefined): net.BlockList {
  const items = spec === undefined ? [] : typeof spec === "string" ? spec.split(/[\s,]+/).filter(Boolean) : [...spec];
  return items.length ? parseAllowedClients(items).blockList : new net.BlockList();
}

const CLIENT_DENIED_BODY = JSON.stringify({ message: "cliente no autorizado por el proxy de Docker" });

/** Servidor HTTP del proxy. Valida, y solo entonces reenvía al backend. */
export function createDockerProxyServer(opts: ProxyServerOptions): http.Server {
  const policy = opts.policy ?? DEFAULT_POLICY;
  // Se parsea AL CREAR el servidor: una lista inválida no llega a escuchar.
  const allowedList = parseAllowedClients(opts.allowedClients ?? LOOPBACK_CLIENTS).blockList;
  const deniedList = parseDeniedClients(opts.deniedClients);
  const clients = {
    // Admitido = dentro de la lista admitida Y fuera de la de exclusión.
    admits: (addr: string | undefined) => isClientAllowed(addr, allowedList) && !isClientAllowed(addr, deniedList),
  };
  if (policy.instance !== undefined && !INSTANCE_RE.test(policy.instance))
    throw new Error(`instancia del proxy no válida: ${policy.instance}`);

  const server = http.createServer((req, res) => {
    const client = normalizeAddress(req.socket.remoteAddress ?? "");
    const log = (e: Omit<ProxyDecisionLog, "client">) => opts.onDecision?.({ ...e, client });
    const respond = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    // Defensa en profundidad: el filtro de `connection` ya cerró a los no
    // admitidos; si alguno llegara aquí, no se lee ni un byte de su cuerpo.
    if (!clients.admits(req.socket.remoteAddress)) {
      log({
        method: req.method ?? "?",
        path: req.url ?? "?",
        allowed: false,
        reason: `cliente no autorizado: ${client}`,
      });
      // Ya contestado y cerrado en `connection`: no se escribe nada más.
      if (req.socket.writableEnded || req.socket.destroyed) return;
      res.writeHead(403, { "content-type": "application/json", connection: "close" });
      res.end(CLIENT_DENIED_BODY, () => req.socket.destroy());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > policy.maxBodyBytes) overflow = true;
      else chunks.push(c);
    });
    req.on("end", async () => {
      const method = req.method ?? "?";
      const path = req.url ?? "?";
      if (overflow) {
        log({ method, path, allowed: false, reason: "cuerpo demasiado grande" });
        return respond(413, { message: "cuerpo demasiado grande" });
      }
      const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const decision = evaluateProxyRequest(req.method ?? "GET", req.url ?? "/", body, policy);
      if (decision.ok === false) {
        log({ method, path, allowed: false, reason: decision.reason });
        return respond(decision.status, { message: decision.reason });
      }
      try {
        const action = decision.action;
        if (action.kind !== "create") {
          // RC2 · PROPIEDAD: inspección previa en el proxy, SIEMPRE por Id completo.
          const pre = await opts.backend.dispatch("GET", `/containers/${action.id}/json`);
          if (pre.status === 404) {
            // No existe (p. ej. AutoRemove tras salir): 404 tal cual; el runner lo
            // trata como «ya parado» y state() como `gone`. No se toca nada.
            log({ method, path, allowed: false, reason: "contenedor inexistente (404)" });
            return respond(404, pre.body || { message: "no such container" });
          }
          if (pre.status !== 200) {
            log({ method, path, allowed: false, reason: `inspect previo falló (${pre.status})` });
            return respond(502, { message: `inspect previo del proxy falló (${pre.status}): no se reenvía` });
          }
          let inspected: unknown;
          try {
            inspected = JSON.parse(pre.body);
          } catch {
            inspected = null;
          }
          const notOwned = ownershipViolation(inspected, action.id, policy);
          if (notOwned) {
            log({ method, path, allowed: false, reason: notOwned });
            return respond(403, { message: `operación ${action.kind} rechazada por el proxy: ${notOwned}` });
          }
          log({ method, path, allowed: true });
          // El inspect ya está hecho: se devuelve tal cual (misma respuesta de la Engine).
          if (action.kind === "inspect") return respond(pre.status, pre.body);
        } else {
          log({ method, path, allowed: true });
        }
        const backendRes = await opts.backend.dispatch(req.method ?? "GET", decision.forwardPath, decision.forwardBody);
        respond(backendRes.status, backendRes.body);
      } catch (e) {
        respond(502, { message: `backend de Docker inaccesible: ${(e as Error).message}` });
      }
    });
  });

  // RC2 · el control de cliente actúa en la CONEXIÓN: un origen no admitido
  // recibe un 403 crudo y se cierra sin que el parser HTTP llegue a leerle nada.
  server.on("connection", (socket: net.Socket) => {
    if (clients.admits(socket.remoteAddress)) return;
    const client = normalizeAddress(socket.remoteAddress ?? "");
    opts.onDecision?.({ method: "-", path: "-", allowed: false, reason: `cliente no autorizado: ${client}`, client });
    socket.end(
      "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\nconnection: close\r\n" +
        `content-length: ${Buffer.byteLength(CLIENT_DENIED_BODY)}\r\n\r\n${CLIENT_DENIED_BODY}`,
      () => socket.destroy(),
    );
  });
  return server;
}

// ── runner del bot-manager a través del proxy ────────────────────────────────

import type { ContainerHandle, ContainerRunner, MeasuredContainerHandle, SandboxSpec } from "./container-runner.js";
import { DockerContainerRunner, cpuMsFromDockerStats, runStateFromInspect } from "./container-runner.js";

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
        // seccomp INLINE (JSON), no ruta: la Docker Engine API exige el contenido.
        SecurityOpt: ["no-new-privileges", `seccomp=${inlineSeccompProfile(spec.seccompProfilePath)}`],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": `rw,noexec,nosuid,nodev,size=${l.tmpfsBytes}` },
        NetworkMode: spec.network,
        Dns: ["0.0.0.0"],
        NanoCpus: Math.round(l.cpus * 1e9),
        Memory: l.memoryBytes,
        MemorySwap: l.memoryBytes, // sin swap extra
        PidsLimit: l.pids,
        ...(spec.autoRemove ? { AutoRemove: true } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
      // DEV-A · TD-001: bootstrap del código de usuario (argumentos del ENTRYPOINT).
      ...(spec.cmd ? { Cmd: spec.cmd } : {}),
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

  async launch(spec: SandboxSpec): Promise<MeasuredContainerHandle> {
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
        // 404 = ya no existe (AutoRemove tras salir): parado, que es lo pedido.
        if (stopped.status !== 204 && stopped.status !== 304 && stopped.status !== 404) {
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
      /**
       * B10 (issue #9) · CPU real consumida por ESTE contenedor, en ms.
       *
       * Falla en NULL, nunca en un número: si el proxy no responde 200 (403,
       * contenedor ya parado, backend caído…) o el cuerpo no trae un
       * `total_usage` positivo, se devuelve `null`. La métrica es diagnóstico;
       * un valor inventado sería peor que su ausencia (issue #9).
       */
      async cpuMs() {
        try {
          const stats = await call("GET", `/containers/${id}/stats?stream=false`);
          if (stats.status !== 200) return null;
          return cpuMsFromDockerStats(stats.json);
        } catch {
          return null;
        }
      },
      /** DEV-A · ¿sigue vivo?, código de salida y OOM (inspect, ya en la allowlist). */
      async state() {
        try {
          const inspected = await call("GET", `/containers/${id}/json`);
          return runStateFromInspect(inspected.status, inspected.json);
        } catch {
          return null;
        }
      },
    };
  }
}
