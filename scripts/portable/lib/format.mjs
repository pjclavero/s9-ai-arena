/**
 * Formato portable de bots y equipos de S9 AI Arena (formatVersion 1).
 * Documentado en docs/operations/portable-export.md.
 *
 * Este módulo es PURO (sin red): estructura, verificación y escaneo del export.
 * Lo comparten el export, el import y los tests; el import llama a `verifyExport`
 * ANTES de escribir nada en la instalación de destino.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";

export const FORMAT_VERSION = 1;
export const TOOL_NAME = "s9-portable-export";
export const MANIFEST = "manifest.json";
export const CHECKSUMS = "checksums.sha256";
export const INCOMPLETE_MARKER = ".export-incomplete";

/**
 * Motores cuyo contenido (loadouts de catálogo `mvp@1`, código de bot sobre el protocolo
 * `arena/1`) sabemos que es portable entre sí. Un export de un motor desconocido o un destino
 * desconocido se rechaza: mejor parar que importar a ciegas. Se amplía a mano al subir el motor.
 */
export const SUPPORTED_ENGINE_VERSIONS = ["0.3.0", "0.4.0", "0.5.0"];

export class PortableError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PortableError";
    this.code = code;
    this.details = details;
  }
}

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

const versionTuple = (v) =>
  String(v)
    .split(".")
    .map((n) => Number.parseInt(n, 10));
export function compareVersions(a, b) {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Compatibilidad de motor: el export sólo se importa en un destino del MISMO motor o más nuevo,
 * y ambos deben estar en la lista de soportados.
 */
export function assertEngineCompatible(sourceEngine, targetEngine) {
  if (!SUPPORTED_ENGINE_VERSIONS.includes(sourceEngine)) {
    throw new PortableError(
      "engine_unsupported",
      `engineVersion del export (${sourceEngine}) no soportado por esta herramienta (${SUPPORTED_ENGINE_VERSIONS.join(", ")}).`,
    );
  }
  if (!SUPPORTED_ENGINE_VERSIONS.includes(targetEngine)) {
    throw new PortableError(
      "engine_unsupported",
      `El motor del destino (${targetEngine}) no está entre los soportados (${SUPPORTED_ENGINE_VERSIONS.join(", ")}).`,
    );
  }
  if (compareVersions(sourceEngine, targetEngine) > 0) {
    throw new PortableError(
      "engine_newer_than_target",
      `El export viene de un motor más nuevo (${sourceEngine}) que el destino (${targetEngine}): no se importa hacia atrás.`,
    );
  }
}

/** slug estable: minúsculas ASCII, `[a-z0-9-]`, 1..48. Nunca vacío, nunca con separadores de ruta. */
export function slugify(name) {
  const base = String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Un nombre con forma de UUID daría un slug (y una ruta) que el escáner tomaría por un id interno:
    // se le quitan los guiones al tramo con forma de UUID (sigue siendo [a-z0-9-] y único tras assignSlugs).
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (m) => m.replace(/-/g, ""))
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || `x-${sha256Hex(Buffer.from(String(name))).slice(0, 8)}`;
}

/** Asigna slugs únicos de forma determinista (el orden de entrada decide quién conserva el slug base). */
export function assignSlugs(names) {
  const used = new Set();
  return names.map((name) => {
    const base = slugify(name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** JSON canónico (claves ordenadas, 2 espacios, \n final): mismo contenido ⇒ mismos bytes ⇒ mismo hash. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort(v[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

// ---------------------------------------------------------------- selección de versiones
const PLAYABLE_ORDER = ["published", "frozen", "validated", "suspended", "retired"];

/**
 * Qué versiones de un bot se exportan.
 *  - `all` (POR DEFECTO): todas. Es la única política que no pierde nada: las versiones congeladas
 *    para torneos (y las que fueron la cabeza jugable antes de otra posterior) sólo sobreviven a una
 *    reinstalación si viajan. La migración es el uso normal de esta herramienta; el coste (el límite
 *    de 60 versiones/hora al importar) lo absorbe la espera y la reanudación del import.
 *  - `heads` (opt-in, `--versions heads`): la «cabeza jugable» (última published; si no hay, la última frozen,
 *    validated, suspended o retired, en ese orden de preferencia) + la última en borrador
 *    (state=draft, exista o no una publicada) + la última rejected/validating si es posterior a todo lo
 *    ya elegido. Todo bot con alguna versión exporta al menos una. PIERDE versiones congeladas
 *    antiguas: sólo para copias parciales deliberadas.
 * Devuelve `{ selected, omitted }` (omitted lleva estado y motivo).
 */
export const DEFAULT_VERSIONS_POLICY = "all";
export function selectVersions(versions, policy = DEFAULT_VERSIONS_POLICY) {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  if (policy === "all") return { selected: sorted, omitted: [] };
  if (policy !== "heads") throw new PortableError("bad_policy", `Política de versiones desconocida: ${policy}`);
  const chosen = new Map();
  const last = (states) => [...sorted].reverse().find((v) => states.includes(v.state));
  for (const st of PLAYABLE_ORDER) {
    const v = last([st]);
    if (v) {
      chosen.set(v.version, "playable_head");
      break;
    }
  }
  const draft = last(["draft"]);
  if (draft && !chosen.has(draft.version)) chosen.set(draft.version, "latest_draft");
  const inflight = last(["rejected", "validating"]);
  const maxChosen = Math.max(0, ...chosen.keys());
  if (inflight && inflight.version > maxChosen) chosen.set(inflight.version, "latest_in_flight");
  const selected = sorted.filter((v) => chosen.has(v.version));
  const omitted = sorted
    .filter((v) => !chosen.has(v.version))
    .map((v) => ({ version: v.version, state: v.state, reason: "not_selected_by_policy_heads" }));
  return { selected, omitted };
}

// ---------------------------------------------------------------- escaneo de secretos
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/;
const STREAM_KEY_RE = /\b(?:rtmps?:\/\/[^\s"']+|live_[0-9]{6,}_[A-Za-z0-9]{10,})/;
const TOKEN_LIKE_RE =
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const FORBIDDEN_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "api_key",
  "streamkey",
  "stream_key",
  "email",
  "ownerid",
  "owner_id",
  "userid",
  "user_id",
  "captainid",
  "captain_id",
  "totp",
  "totp_secret",
  "recovery_codes",
  "sealed",
  "ip",
]);

/**
 * Campos de TEXTO LIBRE puestos por el usuario: su nombre puede parecer un correo o un UUID sin ser un
 * secreto («juan@club.es», «3f2c…»). En `meta`, EMAIL_RE y UUID_RE no miran estos valores. Lista
 * blanca por NOMBRE DE CAMPO (`name` en bots, equipos, loadouts y externalBots) y por el campo
 * `warnings` del manifest (llevan nombres de equipo). Los patrones de credencial de alta confianza
 * (JWT, PEM, Bearer, tokens, streaming) y los valores sensibles conocidos siguen aplicándose a TODO el texto.
 */
export const FREE_TEXT_KEYS = new Set(["name"]);
const stripFreeText = (value, key) => {
  if (Array.isArray(value)) return key === "warnings" ? [] : value.map((v) => stripFreeText(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripFreeText(v, k)]));
  return typeof value === "string" && FREE_TEXT_KEYS.has(key) ? "" : value;
};

const keyHits = (value, path, out) => {
  if (Array.isArray(value)) value.forEach((v, i) => keyHits(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) out.push(`${path}.${k}: clave prohibida`);
      keyHits(v, `${path}.${k}`, out);
    }
  }
};

/**
 * Escanea un fichero del export. `kind`: "meta" (JSON del formato: todo patrón y toda clave
 * prohibida cuentan, y NINGÚN UUID: el export no lleva ids internos) o "source" (código del bot,
 * del operador: sólo patrones de credencial de alta confianza; un correo en un comentario no es un
 * secreto). `known` = valores sensibles concretos (correo, id de usuario…) que no pueden aparecer.
 * Devuelve la lista de hallazgos (vacía = limpio).
 */
export function scanBuffer(buf, kind, label, known = []) {
  const text = buf.toString("utf8");
  const hits = [];
  for (const k of known) {
    if (k && text.includes(k)) hits.push(`${label}: contiene un valor sensible conocido`);
  }
  if (JWT_RE.test(text)) hits.push(`${label}: parece un JWT`);
  if (PEM_RE.test(text)) hits.push(`${label}: clave privada PEM`);
  if (BEARER_RE.test(text)) hits.push(`${label}: cabecera Bearer`);
  if (TOKEN_LIKE_RE.test(text)) hits.push(`${label}: token de proveedor`);
  if (STREAM_KEY_RE.test(text)) hits.push(`${label}: clave o destino de streaming`);
  if (kind === "meta") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* no es JSON: ya se rechaza en la verificación estructural */
    }
    // Con JSON válido, correo y UUID se buscan fuera de los campos de texto libre; si no se puede
    // parsear, se busca en todo el texto (falla seguro).
    const probe = parsed === undefined ? text : JSON.stringify(stripFreeText(parsed, ""));
    if (EMAIL_RE.test(probe)) hits.push(`${label}: contiene un correo electrónico`);
    if (UUID_RE.test(probe)) hits.push(`${label}: contiene un UUID (id interno)`);
    if (parsed !== undefined) keyHits(parsed, label, hits);
  }
  return hits;
}

/** Escanea todos los ficheros listados de un export ya escrito. */
export function scanExportDir(dir, files, known = []) {
  const hits = [];
  for (const f of files) {
    const buf = readFileSync(join(dir, ...f.path.split("/")));
    hits.push(...scanBuffer(buf, f.path.endsWith(".json") ? "meta" : "source", f.path, known));
  }
  return hits;
}

// ---------------------------------------------------------------- verificación
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code, message, details) => {
  throw new PortableError(code, message, details);
};

function safeRel(p) {
  if (typeof p !== "string" || !p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  const n = posix.normalize(p);
  return n === p && !n.startsWith("../") && n !== ".." && !n.split("/").includes("..");
}

function listFiles(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) fail("symlink", `Enlace simbólico no permitido en el export: ${r}`);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
    else fail("special_file", `Fichero especial no permitido: ${r}`);
  }
  return out;
}

export function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) fail("checksums_malformed", `Línea de checksums.sha256 inválida: ${line.slice(0, 80)}`);
    if (map.has(m[2])) fail("checksums_malformed", `Ruta duplicada en checksums.sha256: ${m[2]}`);
    map.set(m[2], m[1]);
  }
  return map;
}

const readJson = (dir, rel) => {
  try {
    return JSON.parse(readFileSync(join(dir, ...rel.split("/")), "utf8"));
  } catch (e) {
    return fail("bad_json", `${rel}: JSON inválido (${e.message})`);
  }
};

/**
 * Verifica un export COMPLETO sin tocar la red: marcador de incompleto, manifest, formatVersion,
 * checksums (recalculados desde disco), lista de ficheros = ficheros reales (sin sobrantes ni
 * faltantes), recuentos y referencias cruzadas (revisiones de loadout, versiones padre, bots de
 * cada equipo). Lanza PortableError en la primera inconsistencia; si todo cuadra devuelve
 * `{ manifest, bots, teams }` ya parseados.
 */
export const DEFAULT_LIMITS = Object.freeze({
  /** Por fichero (el código de un bot: la API acepta como máximo 10 MiB). */
  maxFileBytes: 10 * 1024 * 1024,
  /** manifest.json lista todos los ficheros: puede ser mucho mayor que un fichero normal. */
  maxManifestBytes: 64 * 1024 * 1024,
  /** Suma de todos los ficheros del export. */
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

/** Mira el TAMAÑO de lo que hay en disco ANTES de leer nada a memoria. */
function enforceLimits(dir, real, limits) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let total = 0;
  for (const rel of real) {
    const size = statSync(join(dir, ...rel.split("/"))).size;
    total += size;
    const cap = rel === MANIFEST || rel === CHECKSUMS ? lim.maxManifestBytes : lim.maxFileBytes;
    if (size > cap)
      fail("file_too_large", `${rel}: ${size} bytes superan el tope por fichero (${cap}). Ver --max-file-mb.`);
    if (total > lim.maxTotalBytes)
      fail("export_too_large", `El export supera el tope total (${lim.maxTotalBytes} bytes). Ver --max-total-mb.`);
  }
}

export function verifyExport(dir, limits = {}) {
  let top;
  try {
    top = readdirSync(dir);
  } catch (e) {
    return fail("not_found", `No se puede leer el directorio del export: ${e.message}`);
  }
  if (top.includes(INCOMPLETE_MARKER))
    fail("incomplete", "El export está marcado como incompleto (.export-incomplete).");
  if (!top.includes(MANIFEST)) fail("no_manifest", "Falta manifest.json.");
  if (!top.includes(CHECKSUMS)) fail("no_checksums", "Falta checksums.sha256.");

  const real = listFiles(dir);
  enforceLimits(dir, real, limits);
  const checks = parseChecksums(readFileSync(join(dir, CHECKSUMS), "utf8"));

  // 1) checksums.sha256 cubre TODO (incluido el manifest) y coincide con el disco.
  for (const rel of real) {
    if (rel === CHECKSUMS) continue;
    if (!safeRel(rel)) fail("unsafe_path", `Ruta no permitida en el export: ${rel}`);
    const want = checks.get(rel);
    if (!want) fail("unlisted_file", `Fichero que no figura en checksums.sha256: ${rel}`);
    if (sha256Hex(readFileSync(join(dir, ...rel.split("/")))) !== want) {
      fail("checksum_mismatch", `El checksum no coincide: ${rel}`);
    }
  }
  for (const rel of checks.keys()) {
    if (!safeRel(rel)) fail("unsafe_path", `Ruta no permitida en checksums.sha256: ${rel}`);
    if (!real.includes(rel)) fail("missing_file", `Falta un fichero listado en checksums.sha256: ${rel}`);
  }

  // 2) manifest.
  const manifest = readJson(dir, MANIFEST);
  if (!isObj(manifest)) fail("manifest_invalid", "manifest.json no es un objeto.");
  if (manifest.formatVersion !== FORMAT_VERSION) {
    fail(
      "format_unsupported",
      `formatVersion ${String(manifest.formatVersion)} no soportada (esta herramienta lee la ${FORMAT_VERSION}).`,
    );
  }
  for (const k of ["sourceSha", "engineVersion", "createdAt"]) {
    if (typeof manifest[k] !== "string" || !manifest[k])
      fail("manifest_invalid", `manifest.${k} ausente o no es texto.`);
  }
  if (!Array.isArray(manifest.files) || !isObj(manifest.counts))
    fail("manifest_invalid", "manifest.files/counts ausentes.");
  const listed = new Map();
  for (const f of manifest.files) {
    if (!isObj(f) || !safeRel(f.path) || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      fail("manifest_invalid", "Entrada de manifest.files inválida.");
    }
    if (f.path === MANIFEST || f.path === CHECKSUMS)
      fail("manifest_invalid", `manifest.files no puede listar ${f.path}.`);
    if (listed.has(f.path)) fail("manifest_invalid", `Ruta duplicada en manifest.files: ${f.path}`);
    listed.set(f.path, f);
  }
  const body = real.filter((r) => r !== MANIFEST && r !== CHECKSUMS);
  for (const rel of body) {
    const f = listed.get(rel);
    if (!f) fail("unlisted_file", `Fichero que no figura en manifest.json: ${rel}`);
    const buf = readFileSync(join(dir, ...rel.split("/")));
    if (sha256Hex(buf) !== f.sha256 || (typeof f.bytes === "number" && buf.length !== f.bytes)) {
      fail("checksum_mismatch", `manifest.json: hash o tamaño distinto en ${rel}`);
    }
  }
  for (const rel of listed.keys()) {
    if (!body.includes(rel)) fail("missing_file", `Falta un fichero listado en manifest.json: ${rel}`);
  }
  for (const rel of body) {
    if (!/^(bots\/[^/]+\/(bot\.json|versions\/v[0-9]+\/source\.bin)|teams\/[^/]+\.json)$/.test(rel)) {
      fail("unexpected_file", `Fichero fuera del formato: ${rel}`);
    }
  }

  // 3) contenido semántico y referencias cruzadas.
  const bots = [];
  const botSlugs = new Set();
  for (const rel of body.filter((r) => /^bots\/[^/]+\/bot\.json$/.test(r))) {
    const bot = readJson(dir, rel);
    if (!isObj(bot) || !SLUG_RE.test(bot.slug ?? "") || rel !== `bots/${bot.slug}/bot.json`) {
      fail("bot_invalid", `${rel}: slug inválido o distinto de su carpeta.`);
    }
    if (typeof bot.name !== "string" || !bot.name || !Array.isArray(bot.loadouts) || !Array.isArray(bot.versions)) {
      fail("bot_invalid", `${rel}: faltan name/loadouts/versions.`);
    }
    const revs = new Set();
    for (const l of bot.loadouts) {
      if (
        !Number.isInteger(l.revision) ||
        revs.has(l.revision) ||
        typeof l.chassis !== "string" ||
        !Array.isArray(l.modules)
      ) {
        fail("bot_invalid", `${rel}: revisión de loadout inválida o repetida.`);
      }
      revs.add(l.revision);
    }
    const vers = new Set(bot.versions.map((v) => v.version));
    if (vers.size !== bot.versions.length) fail("bot_invalid", `${rel}: versiones repetidas.`);
    for (const v of bot.versions) {
      if (!Number.isInteger(v.version) || !["python", "node"].includes(v.runtime)) {
        fail("bot_invalid", `${rel}: versión/runtime inválidos.`);
      }
      if (!revs.has(v.loadoutRevision)) {
        fail(
          "dangling_loadout",
          `${rel}: la versión ${v.version} usa la revisión ${v.loadoutRevision}, que no existe.`,
        );
      }
      if (v.parentVersion != null && !vers.has(v.parentVersion)) {
        fail(
          "dangling_parent",
          `${rel}: la versión ${v.version} apunta a un padre (${v.parentVersion}) que no está en el export.`,
        );
      }
      const s = v.source;
      if (!isObj(s) || !listed.has(s.file) || !s.file.startsWith(`bots/${bot.slug}/`)) {
        fail("bot_invalid", `${rel}: la versión ${v.version} no tiene un fichero de código listado.`);
      }
      if (listed.get(s.file).sha256 !== s.sha256) {
        fail("checksum_mismatch", `${rel}: sha256 de código de la v${v.version} distinto del fichero.`);
      }
    }
    botSlugs.add(bot.slug);
    bots.push(bot);
  }
  const teams = [];
  for (const rel of body.filter((r) => /^teams\/[^/]+\.json$/.test(r))) {
    const team = readJson(dir, rel);
    if (
      !isObj(team) ||
      !SLUG_RE.test(team.slug ?? "") ||
      rel !== `teams/${team.slug}.json` ||
      typeof team.name !== "string" ||
      !team.name
    ) {
      fail("team_invalid", `${rel}: slug o nombre inválidos.`);
    }
    if (!Array.isArray(team.bots)) fail("team_invalid", `${rel}: falta la lista de bots.`);
    for (const b of team.bots) {
      if (typeof b !== "string" || !botSlugs.has(b)) {
        fail("dangling_team_bot", `${rel}: el equipo referencia el bot «${String(b)}», que no existe en el export.`);
      }
    }
    if (new Set(team.bots).size !== team.bots.length) fail("team_invalid", `${rel}: bots repetidos.`);
    teams.push(team);
  }
  const nVersions = bots.reduce((n, b) => n + b.versions.length, 0);
  const nLoadouts = bots.reduce((n, b) => n + b.loadouts.length, 0);
  const c = manifest.counts;
  if (c.bots !== bots.length || c.teams !== teams.length || c.versions !== nVersions || c.loadouts !== nLoadouts) {
    fail(
      "count_mismatch",
      `Los recuentos del manifest no cuadran (manifest ${JSON.stringify({ bots: c.bots, teams: c.teams, versions: c.versions, loadouts: c.loadouts })}, real ${JSON.stringify({ bots: bots.length, teams: teams.length, versions: nVersions, loadouts: nLoadouts })}).`,
    );
  }
  return { manifest, bots, teams };
}

export const nativePath = (rel) => rel.split("/").join(sep);

/** Forma canónica de un loadout para comparar (ignora revisión, summary y orden de módulos). */
export function loadoutKey(l) {
  const mods = [...(l.modules ?? [])].map((m) => ({
    slot: m.slot,
    moduleId: m.moduleId,
    ...(m.ammo ? { ammo: m.ammo } : {}),
  }));
  mods.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return JSON.stringify({ c: l.catalogVersion ?? null, ch: l.chassis, n: l.name ?? null, m: mods });
}
