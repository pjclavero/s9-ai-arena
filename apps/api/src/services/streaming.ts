/**
 * EQ5b · Administración → Streaming: modelo, validación y clasificación de cambios.
 *
 * Administra lo que YA existe (apps/streamer, /broadcast, director, retardo del
 * ruleset): no lo reimplementa. La autoridad de cada dato:
 *  - configuración no sensible → `streaming_settings` (migración 017);
 *  - clave de emisión → SOBRE sellado con la pública (packages/stream-secrets); la
 *    API no puede abrirlo, sólo el streamer;
 *  - retardo → copia de reglas de la batalla/torneo (`spectator.delaySeconds`), que
 *    es lo que aplica el gateway. Aquí se LEE para mostrarlo, nunca se guarda;
 *  - estado de la emisión → el streamer (`/status`), reconciliado con la sesión en BD.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import type { Db } from "../db/connection.js";
import { BACKUP_QUERY, canonicalIngestUrl, keyIdOf } from "../../../../packages/stream-secrets/index.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { rulesOf } from "./battle-rules.js";
import { resolveBattleRuleset } from "./battle-ruleset-resolver.js";
import { publicShowabilityOf, type BroadcastBlockedReason } from "../replay-access.js";
import type { BattleVisibility } from "../battle-access.js";
import {
  battleBroadcastState,
  tournamentBroadcastState,
  type BroadcastEffectiveState,
  type BroadcastUnavailableReason,
} from "../broadcast-effective.js";

/** MG · visibilidad pública por defecto si el llamador no pasa la vigente (fail-closed). */
const NO_PUBLIC: BattleVisibility = { publicSpectate: false, publicReplays: false };

/** MG · campos de estado EFECTIVO que acompañan a un destino (broadcast-effective.ts). */
export interface BroadcastEffectiveFields {
  /** /broadcast (anónima) puede mostrar el destino AHORA (misma política que lee la página). */
  broadcastAvailable: boolean;
  /** Motivo real si no (null si sí). */
  reason: BroadcastUnavailableReason | null;
  publicSpectateEffective: boolean;
  publicReplaysEffective: boolean;
}

function effectiveFields(e: BroadcastEffectiveState | null): BroadcastEffectiveFields {
  return {
    broadcastAvailable: !!e?.broadcastAvailable,
    reason: e ? e.reason : "other",
    publicSpectateEffective: !!e?.publicSpectateEffective,
    publicReplaysEffective: !!e?.publicReplaysEffective,
  };
}

// ── catálogo de plataformas (extensible: añadir una entrada aquí) ───────────
export interface PlatformDef {
  id: string;
  label: string;
  /**
   * Ingesta principal POR DEFECTO (la que se usa mientras el operador no guarde
   * otra en `streaming_ingests`); null = la escribe el operador (RTMPS personalizado).
   * STREAMING-UX (§17) · ya no es fija: es sólo el valor inicial editable.
   */
  ingestUrl: string | null;
  /** Ingesta de respaldo por defecto (null = sin respaldo hasta que se configure). */
  backupIngestUrl: string | null;
  /** §20 · ¿admite `?backup=1` en la ingesta de respaldo? (sólo YouTube). */
  backupQuery: boolean;
  /**
   * Ronda 1 (R-H6) · aplicación RTMP OBLIGATORIA, si la plataforma la fija. En YouTube es
   * `live2` (y `live2?backup=1` en el respaldo): un segundo segmento de path sólo puede ser
   * la clave pegada por error en el campo del servidor, y se rechaza antes de guardarla.
   */
  fixedApp: string | null;
}
export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: "youtube",
    label: "YouTube",
    ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
    backupIngestUrl: "rtmps://b.rtmps.youtube.com/live2?backup=1",
    backupQuery: true,
    fixedApp: "live2",
  },
  {
    id: "custom",
    label: "RTMPS personalizado",
    ingestUrl: null,
    backupIngestUrl: null,
    backupQuery: false,
    fixedApp: null,
  },
];

/** STREAMING-UX · §16-§22 · Ingestas efectivas de una plataforma (tal cual se configuraron). */
export interface PlatformIngests {
  platform: string;
  primaryIngestUrl: string | null;
  backupIngestUrl: string | null;
  /** `default` = las del catálogo (no hay fila en `streaming_ingests`). */
  source: "configured" | "default";
}

export interface IngestRow {
  platform: string;
  primary_ingest_url: string;
  backup_ingest_url: string | null;
}

/**
 * Autoridad de cada URL:
 *  - con fila en `streaming_ingests` ⇒ la fila (lo que guardó el operador, sin transformar);
 *  - sin fila ⇒ el catálogo; en RTMPS personalizado la principal es `settings.ingestUrl`
 *    (compatibilidad con 0.15: es el campo que ya existía).
 * Para `custom` la principal SIEMPRE es `settings.ingestUrl` (la fila sólo aporta el
 * respaldo): una sola autoridad por dato, nunca dos copias que puedan divergir.
 */
export function ingestsOf(s: StreamingSettings, rows: readonly IngestRow[], platform: string): PlatformIngests {
  const p = platformById(platform);
  const row = rows.find((r) => r.platform === platform);
  if (p && p.ingestUrl === null) {
    return {
      platform,
      primaryIngestUrl: s.ingestUrl,
      backupIngestUrl: row?.backup_ingest_url ?? null,
      source: row ? "configured" : "default",
    };
  }
  if (row) {
    return {
      platform,
      primaryIngestUrl: row.primary_ingest_url,
      backupIngestUrl: row.backup_ingest_url,
      source: "configured",
    };
  }
  return {
    platform,
    primaryIngestUrl: p?.ingestUrl ?? null,
    backupIngestUrl: p?.backupIngestUrl ?? null,
    source: "default",
  };
}

export async function loadIngestRows(db: Db): Promise<IngestRow[]> {
  // Sin la 020 (BD sin migrar) se usan los valores del catálogo: es lo honesto.
  return db("streaming_ingests")
    .select("platform", "primary_ingest_url", "backup_ingest_url")
    .catch(() => [] as IngestRow[]);
}
export function platformById(id: unknown): PlatformDef | undefined {
  return typeof id === "string" ? PLATFORMS.find((p) => p.id === id) : undefined;
}

export const PRESETS = ["1080p", "720p"] as const;
export const BITRATE_LIMITS = { min: 1000, max: 12000 } as const;

/** Rangos recomendados (kbit/s) por preset y FPS: guía de ingesta H.264 de YouTube. */
export function bitrateRecommendation(preset: string, fps: number): { min: number; max: number; recommended: number } {
  if (preset === "720p")
    return fps === 60 ? { min: 2250, max: 6000, recommended: 4500 } : { min: 1500, max: 4000, recommended: 3000 };
  return fps === 60 ? { min: 4500, max: 9000, recommended: 6000 } : { min: 3000, max: 6000, recommended: 4500 };
}

export interface Branding {
  eventName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
}
export const DEFAULT_BRANDING: Branding = {
  eventName: "S9 AI Arena",
  logoUrl: null,
  primaryColor: "#10141f",
  accentColor: "#ffb300",
};

export interface Retention {
  enabled: boolean;
  maxAgeDays: number | null;
  maxTotalBytes: number | null;
}

export interface StreamingSettings {
  enabled: boolean;
  mode: "rtmps" | "record";
  platform: string;
  ingestUrl: string | null;
  encoder: "x264" | "nvenc";
  preset: "1080p" | "720p";
  fps: 30 | 60;
  videoBitrateKbps: number;
  branding: Branding;
  retention: Retention;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

function json<T>(v: unknown, fallback: T): T {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v as T) ?? fallback;
}

export async function loadSettings(db: Db): Promise<StreamingSettings> {
  const r = await db("streaming_settings").where({ id: 1 }).first();
  if (!r) throw new Error("streaming_settings sin fila (migración 017 no aplicada)");
  return {
    enabled: r.enabled,
    mode: r.mode,
    platform: r.platform,
    ingestUrl: r.ingest_url ?? null,
    encoder: r.encoder,
    preset: r.preset,
    fps: Number(r.fps) as 30 | 60,
    videoBitrateKbps: Number(r.video_bitrate_kbps),
    branding: { ...DEFAULT_BRANDING, ...json<Partial<Branding>>(r.branding, {}) },
    retention: { enabled: false, maxAgeDays: 14, maxTotalBytes: null, ...json<Partial<Retention>>(r.retention, {}) },
    version: Number(r.version),
    updatedAt: new Date(r.updated_at).toISOString(),
    updatedBy: r.updated_by ?? null,
  };
}

// ── validación ──────────────────────────────────────────────────────────────
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

export function validLogoUrl(v: string): boolean {
  if (v.length > 512 || /[\s"'<>\\`]/.test(v)) return false;
  if (v.startsWith("/") && !v.startsWith("//")) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * EQ5c (revisión EQ6b, P3 · SSRF) · ¿El host de la ingesta es interno? La prueba
 * de ingesta y la emisión las hace el STREAMER desde la red del despliegue: una
 * ingesta «personalizada» no puede apuntar a servicios internos (nombres de
 * Docker sin punto como `postgres`/`api`), loopback, redes privadas, link-local
 * (metadatos 169.254.169.254) ni ULA/link-local IPv6.
 * Límite declarado: es una comprobación del NOMBRE escrito; un nombre público
 * que resuelva a una IP interna (DNS rebinding) no se detecta aquí.
 * EQ5d · las IPv6 que incrustan una IPv4 se normalizan (ver `internalV6`).
 */
export function isInternalIngestHost(hostname: string): boolean {
  const h = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h) return true;
  const fam = isIP(h);
  if (fam === 4) return internalV4(h);
  if (fam === 6) return internalV6(h);
  // IPv4 en forma no canónica (octal, hex, abreviada: `0x7f.1`, `127.1`): getaddrinfo
  // la aceptaría como dirección; aquí no se admite ninguna dirección que no sea canónica.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}\.?$/i.test(h)) return true;
  if (!h.includes(".")) return true; // nombre de una sola etiqueta: servicio de la red interna
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain)$/.test(h);
}

/** Los 8 grupos de 16 bits de una IPv6 ya validada por `isIP` (con IPv4 final o `::`). */
export function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":").map((g) => parseInt(g, 16)) : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const out = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (out.length !== 8 || out.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return out;
}

function internalV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadatos
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast y reservadas
  );
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * EQ5d (revisión EQ6c, P3 · SSRF IPv6) · se normaliza la dirección a sus 8
 * grupos y se EXTRAE la IPv4 que incrusta, aplicándole la misma lista que a
 * una IPv4 escrita tal cual:
 *  - `::/96` (compatible, `::a.b.c.d`; obsoleta), `::ffff:0:0/96` (mapeada) y
 *    `::ffff:0:0:0/96` (traducida, SIIT): formas que ninguna ingesta pública
 *    usa ⇒ se rechazan SIEMPRE, sea cual sea la IPv4;
 *  - `64:ff9b::/96` (NAT64 bien conocido) y `2002::/16` (6to4): se extrae la
 *    IPv4 y se aplica `internalV4`; `64:ff9b:1::/48` (NAT64 local) se rechaza;
 *  - Teredo `2001::/32` (incrusta la IPv4 ofuscada) y descarte `100::/64`: rechazo;
 *  - ULA `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10` y multicast `ff00::/8`.
 */
function internalV6(ip: string): boolean {
  const g = ipv6Hextets(ip);
  if (!g) return true; // no se pudo normalizar: fail-closed
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return true; // ::/96 y ::ffff:0:0/96
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true; // ::ffff:0:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true; // 64:ff9b:1::/48 (NAT64 de uso local)
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return internalV4(v4Of(g[6], g[7]));
    return true;
  }
  if (g[0] === 0x2002) return internalV4(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // descarte 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local, obsoleta)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * Mismas reglas que el streamer (parseIngestUrl): sólo rtmps, sin credenciales ni query.
 * EQ5c · y sin hosts internos, salvo `allowInternal` (sólo el E2E local:
 * STREAMING_ALLOW_INTERNAL_INGEST=1, nunca en el Compose).
 */
export function validIngestUrl(
  v: unknown,
  opts: { allowInternal?: boolean; allowBackupQuery?: boolean; fixedApp?: string | null } = {},
): string | null {
  if (typeof v !== "string" || v.length > 512) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "rtmps:" || !u.hostname || u.username || u.password || u.hash) return null;
  // Ronda 1 (H-4) · guardado = efectivo. Sólo ASCII visible: WHATWG borra TAB y saltos de
  // línea en silencio, así que la API guardaría un carácter de control que el relé no usa.
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  if (u.port === "0") return null; // puerto 0: no es un destino
  // …y el path TAL CUAL se escribió tiene que ser ya la aplicación que usará el relé: nada de
  // `//`, `/./`, `/../`, `%xx` ni barra final, que el relé normaliza a otra cosa.
  const rawPath = /^rtmps:\/\/[^/?#]*(\/[^?#]*)?/i.exec(v)?.[1] ?? "";
  const segs = rawPath.split("/").slice(1);
  // STREAMING-UX (§20) · el ÚNICO caso con query: la ingesta de RESPALDO de YouTube con
  // exactamente `?backup=1` (`allowBackupQuery` sólo lo pone quien valida ese campo de esa
  // plataforma). Ni otra clave, ni otro valor, ni parámetros añadidos, ni `?` vacío: la
  // forma se compara con el texto ORIGINAL, no con la URL ya normalizada.
  if (u.search || v.includes("?")) {
    if (!opts.allowBackupQuery || u.search !== BACKUP_QUERY || !v.endsWith(BACKUP_QUERY)) return null;
    if (v.indexOf("?") !== v.length - BACKUP_QUERY.length) return null;
  }
  const app = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  if (!app || app.length > 128 || !/^[A-Za-z0-9._~\-/]+$/.test(app)) return null;
  // Una sola guarda para todo eso: lo que el relé usará (`app`, ya normalizado y decodificado)
  // tiene que ser carácter a carácter lo escrito.
  if (app !== segs.join("/")) return null;
  // Ronda 1 (R-H6) · «URL + clave» pegada en el campo del servidor (cualquier plataforma).
  if (opts.fixedApp !== undefined && opts.fixedApp !== null && app !== opts.fixedApp) return null;
  if (looksLikeStreamKeyPath(segs)) return null;
  try {
    canonicalIngestUrl(v); // host normalizable (sin `%xx` ni caracteres raros): la clave se ata a esta forma
  } catch {
    return null;
  }
  if (!opts.allowInternal && isInternalIngestHost(u.hostname)) return null;
  return v;
}

/**
 * Ronda 1 (R-H6) · ¿algún segmento del path tiene forma de clave de emisión? Decisión para
 * «RTMPS personalizado» (donde la aplicación es libre): RECHAZAR, no avisar. Un aviso no
 * impediría que la URL se guardase en claro en la BD, en la auditoría (`from`/`to`), en la UI
 * y en el `display` del relé (logs y `/status`): el daño ya estaría hecho. El rechazo es
 * barato de corregir (el mensaje dice qué hacer) y no tiene falsos positivos en las
 * aplicaciones reales conocidas (`live`, `live2`, `app`, `rtmp`, `live/app`…), que son
 * palabras cortas. Formas que se rechazan:
 *  - la de YouTube: 4+ grupos de 4 alfanuméricos separados por guiones (`xxxx-xxxx-xxxx-xxxx`);
 *  - la de Twitch: `live_<dígitos>_<alfanuméricos>`;
 *  - la de Facebook: `FB-…`;
 *  - cualquier segmento largo (≥ 20 caracteres) con letras Y dígitos: ningún nombre de
 *    aplicación RTMP real lo es, y casi cualquier clave sí.
 */
export function looksLikeStreamKeyPath(segs: readonly string[]): boolean {
  return segs.some(
    (g) =>
      /^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){3,}$/.test(g) ||
      /^live_\d+_[A-Za-z0-9]+$/.test(g) ||
      /^FB-/i.test(g) ||
      (g.length >= 20 && /[A-Za-z]/.test(g) && /\d/.test(g)),
  );
}

/** Clave de emisión: ASCII imprimible sin espacios (YouTube/Twitch/RTMPS genérico). */
export function validStreamKey(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v);
}

export interface SettingsPatchResult {
  next: StreamingSettings;
  errors: string[];
  changed: string[];
  warnings: string[];
}

const SETTABLE = [
  "enabled",
  "mode",
  "platform",
  "ingestUrl",
  "encoder",
  "preset",
  "fps",
  "videoBitrateKbps",
  "branding",
  "retention",
] as const;

export function applySettingsPatch(
  current: StreamingSettings,
  patch: Record<string, unknown>,
  ctx: { nvenc: boolean | null; allowInternalIngest?: boolean },
): SettingsPatchResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const next: StreamingSettings = {
    ...current,
    branding: { ...current.branding },
    retention: { ...current.retention },
  };
  const allowedMeta = new Set(["version", "confirmStop", "confirmHighFps"]);
  for (const k of Object.keys(patch)) {
    if (!(SETTABLE as readonly string[]).includes(k) && !allowedMeta.has(k)) errors.push(`campo no admitido: ${k}`);
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);

  if (has("enabled")) {
    if (typeof patch.enabled !== "boolean") errors.push("enabled debe ser booleano");
    else next.enabled = patch.enabled;
  }
  if (has("mode")) {
    if (patch.mode !== "rtmps" && patch.mode !== "record") errors.push("mode debe ser rtmps o record");
    else next.mode = patch.mode;
  }
  if (has("platform")) {
    if (!platformById(patch.platform)) errors.push("plataforma desconocida");
    else next.platform = patch.platform as string;
  }
  if (has("ingestUrl")) {
    if (patch.ingestUrl === null || patch.ingestUrl === "") next.ingestUrl = null;
    else {
      const v = validIngestUrl(patch.ingestUrl, { allowInternal: ctx.allowInternalIngest });
      if (!v)
        errors.push(
          "ingestUrl debe ser rtmps://host[:puerto]/aplicación, sin credenciales, query, barras sobrantes ni la clave en la ruta (va en su propio campo), y con un host público (no interno, loopback ni link-local)",
        );
      else next.ingestUrl = v;
    }
  }
  if (has("encoder")) {
    if (patch.encoder !== "x264" && patch.encoder !== "nvenc") errors.push("encoder debe ser x264 o nvenc");
    else next.encoder = patch.encoder;
  }
  if (next.encoder === "nvenc" && ctx.nvenc !== true && (has("encoder") || current.encoder !== "nvenc")) {
    errors.push("NVENC no disponible: el runtime del streamer no lo ha confirmado");
  }
  if (has("preset")) {
    if (!(PRESETS as readonly unknown[]).includes(patch.preset)) errors.push("preset debe ser 1080p o 720p");
    else next.preset = patch.preset as "1080p" | "720p";
  }
  if (has("fps")) {
    if (patch.fps !== 30 && patch.fps !== 60) errors.push("fps debe ser 30 o 60");
    else {
      if (patch.fps === 60 && current.fps !== 60 && patch.confirmHighFps !== true) {
        errors.push("60 FPS dobla el coste de CPU y de ancho de banda: confírmalo (confirmHighFps)");
      }
      next.fps = patch.fps;
    }
  }
  if (has("videoBitrateKbps")) {
    const b = patch.videoBitrateKbps;
    if (!Number.isInteger(b) || (b as number) < BITRATE_LIMITS.min || (b as number) > BITRATE_LIMITS.max) {
      errors.push(`videoBitrateKbps debe ser un entero entre ${BITRATE_LIMITS.min} y ${BITRATE_LIMITS.max}`);
    } else next.videoBitrateKbps = b as number;
  }
  if (has("branding")) {
    const b = patch.branding as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b)) errors.push("branding inválido");
    else {
      for (const k of Object.keys(b)) {
        if (!["eventName", "logoUrl", "primaryColor", "accentColor"].includes(k))
          errors.push(`branding.${k} no admitido`);
      }
      if (b.eventName !== undefined) {
        const v = typeof b.eventName === "string" ? b.eventName.trim() : "";
        if (!v || v.length > 80 || CONTROL.test(v)) errors.push("branding.eventName: 1-80 caracteres, sin controles");
        else next.branding.eventName = v;
      }
      if (b.logoUrl !== undefined) {
        if (b.logoUrl === null || b.logoUrl === "") next.branding.logoUrl = null;
        else if (typeof b.logoUrl !== "string" || !validLogoUrl(b.logoUrl.trim())) {
          errors.push("branding.logoUrl: https:// o ruta del propio sitio (/...), sin comillas ni espacios");
        } else next.branding.logoUrl = b.logoUrl.trim();
      }
      for (const c of ["primaryColor", "accentColor"] as const) {
        if (b[c] !== undefined) {
          if (typeof b[c] !== "string" || !HEX.test(b[c] as string)) errors.push(`branding.${c}: color #rgb o #rrggbb`);
          else next.branding[c] = (b[c] as string).toLowerCase();
        }
      }
    }
  }
  if (has("retention")) {
    const r = patch.retention as Record<string, unknown>;
    if (!r || typeof r !== "object" || Array.isArray(r)) errors.push("retention inválida");
    else {
      for (const k of Object.keys(r)) {
        if (!["enabled", "maxAgeDays", "maxTotalBytes"].includes(k)) errors.push(`retention.${k} no admitido`);
      }
      if (r.enabled !== undefined) {
        if (typeof r.enabled !== "boolean") errors.push("retention.enabled debe ser booleano");
        else next.retention.enabled = r.enabled;
      }
      if (r.maxAgeDays !== undefined) {
        const v = r.maxAgeDays;
        if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 3650)) {
          errors.push("retention.maxAgeDays: entero entre 1 y 3650 (7, 14, 30 o personalizado) o null");
        } else next.retention.maxAgeDays = v as number | null;
      }
      if (r.maxTotalBytes !== undefined) {
        const v = r.maxTotalBytes;
        if (v !== null && (!Number.isSafeInteger(v) || (v as number) < 1024 * 1024)) {
          errors.push("retention.maxTotalBytes: entero de al menos 1 MiB o null");
        } else next.retention.maxTotalBytes = v as number | null;
      }
      if (next.retention.enabled && next.retention.maxAgeDays === null && next.retention.maxTotalBytes === null) {
        errors.push("la retención activa necesita una edad o un tamaño máximo");
      }
    }
  }
  if (next.mode === "rtmps" && platformById(next.platform)?.ingestUrl === null && !next.ingestUrl) {
    errors.push("RTMPS personalizado necesita ingestUrl");
  }
  const rec = bitrateRecommendation(next.preset, next.fps);
  if (next.videoBitrateKbps < rec.min || next.videoBitrateKbps > rec.max) {
    warnings.push(
      `bitrate fuera del rango recomendado para ${next.preset}${next.fps} (${rec.min}-${rec.max} kbit/s; recomendado ${rec.recommended})`,
    );
  }
  const changed = SETTABLE.filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
  return { next, errors, changed: [...changed], warnings };
}

/**
 * §20 · Qué exige cada cambio con una emisión ACTIVA. Nunca se reinicia en
 * silencio: la API sólo guarda y avisa; reiniciar o parar lo pide el operador.
 */
export const CHANGE_CLASSES: Record<string, "hot" | "restart" | "stop"> = {
  retention: "hot",
  mode: "restart",
  platform: "restart",
  ingestUrl: "restart",
  encoder: "restart",
  preset: "restart",
  fps: "restart",
  videoBitrateKbps: "restart",
  branding: "restart",
  credential: "restart",
  enabled: "stop",
};

/**
 * Configuración que se aplica a una emisión (lo que se compara para «pendiente de reinicio»).
 * STREAMING-UX · incluye la ingesta de RESPALDO: cambiarla también pide reiniciar.
 */
// Ronda 1 (Q-H1) · `rows` es OBLIGATORIO: con el `= []` de antes, start y restart guardaban
// en la sesión las ingestas del catálogo mientras el estado comparaba con las configuradas, y
// el aviso «pendiente de reinicio» salía siempre (y no se iba al reiniciar).
export function appliedConfig(s: StreamingSettings, credentialStamp: string | null, rows: readonly IngestRow[]) {
  const ing = ingestsOf(s, rows, s.platform);
  return {
    mode: s.mode,
    platform: s.platform,
    ingestUrl: s.mode === "rtmps" ? ing.primaryIngestUrl : null,
    backupIngestUrl: s.mode === "rtmps" ? ing.backupIngestUrl : null,
    encoder: s.encoder,
    preset: s.preset,
    fps: s.fps,
    videoBitrateKbps: s.videoBitrateKbps,
    branding: s.branding,
    credential: s.mode === "rtmps" ? credentialStamp : null,
  };
}

/** Ingesta PRINCIPAL efectiva de `platform` (tal cual se configuró). */
export function effectiveIngest(
  s: StreamingSettings,
  platform: string = s.platform,
  rows: readonly IngestRow[] = [],
): string | null {
  return ingestsOf(s, rows, platform).primaryIngestUrl;
}

export type IngestRole = "primary" | "backup";

/**
 * EQ5c (P2-2) · Destino al que se ata la clave de `platform` con la
 * configuración `s`: plataforma + ingesta CANÓNICA. null = aún no hay ingesta
 * (RTMPS personalizado sin URL, o plataforma sin respaldo).
 *
 * STREAMING-UX · hay UN sobre por papel: el principal se ata a la ingesta
 * principal y el de respaldo a la de respaldo (`sealed_backup`). Ningún sobre
 * vale para dos destinos, así que la clave sólo puede publicarse en las dos
 * URLs que estaban configuradas al sellarla.
 */
export function credentialBinding(
  s: StreamingSettings,
  platform: string,
  rows: readonly IngestRow[] = [],
  role: IngestRole = "primary",
): { platform: string; ingest: string } | null {
  const ing = ingestsOf(s, rows, platform);
  const raw = role === "primary" ? ing.primaryIngestUrl : ing.backupIngestUrl;
  if (!raw) return null;
  try {
    return { platform, ingest: canonicalIngestUrl(raw) };
  } catch {
    return null;
  }
}

// ── destino y retardo ───────────────────────────────────────────────────────
export type TargetKind = "battle" | "tournament";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TargetInfo extends BroadcastEffectiveFields {
  kind: TargetKind;
  id: string;
  label: string;
  status: string;
  /**
   * VISIBILIDAD · el destino está AUTORIZADO para retransmisión: /broadcast (anónima)
   * puede mostrarlo con la proyección de competición (`wherePubliclyShowable`). NO
   * exige que los bots sean públicos: basta con que la batalla sea de un torneo con
   * `broadcast`. Ningún bot cambia de visibilidad por emitirse.
   */
  broadcastable: boolean;
  /**
   * Motivo REAL cuando no se puede emitir (null si se puede):
   *  - `battle_not_public`: batalla suelta (sin torneo) con bots no públicos. Sólo un
   *    torneo autoriza mostrar bots privados o de equipo; no hay flag por batalla.
   *  - `tournament_not_broadcastable`: batalla de un torneo creado sin `broadcast`
   *    que tiene bots no públicos.
   */
  broadcastBlockedReason: BroadcastBlockedReason | null;
  /** El torneo autoriza la retransmisión (destino torneo, o batalla de un torneo). */
  tournamentBroadcast: boolean | null;
  /**
   * @deprecated MG · ya NO es alias de `broadcastable`: vale lo mismo que
   * `broadcastAvailable` (antes decía `true` con el espectador público apagado).
   */
  publicBroadcastable: boolean;
  delaySeconds: number;
  delaySource: "snapshot" | "ruleset" | "final_visible" | "none";
}

export function parseTarget(kind: unknown, id: unknown): { kind: TargetKind; id: string } | null {
  if ((kind !== "battle" && kind !== "tournament") || typeof id !== "string" || !UUID.test(id)) return null;
  return { kind, id: id.toLowerCase() };
}

function delayOf(r: { spectator?: { delaySeconds?: number } } | null | undefined): number | null {
  const d = r?.spectator?.delaySeconds;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : null;
}

/** null = no existe. El retardo SALE de la copia de reglas (única fuente de verdad). */
export async function resolveTarget(
  db: Db,
  t: { kind: TargetKind; id: string },
  vis: BattleVisibility = NO_PUBLIC,
): Promise<TargetInfo | null> {
  if (t.kind === "battle") {
    const b = await db("battles")
      .where({ id: t.id })
      .first()
      .catch(() => null);
    if (!b) return null;
    // VISIBILIDAD · la MISMA regla que usa la lectura pública (/broadcast): se puede
    // emitir exactamente lo que un visitante puede ver, ni más ni menos.
    const show = await publicShowabilityOf(db, t.id);
    if (!show) return null;
    const pub = show.showable;
    const eff = effectiveFields(await battleBroadcastState(db, t.id, vis));
    let delaySeconds = 0;
    let delaySource: TargetInfo["delaySource"] = "none";
    if (b.spectator_mode === "visible") {
      delaySource = "final_visible";
    } else {
      const snap = rulesOf(b);
      const fromSnap = snap ? delayOf(snap.engineRuleset) : null;
      if (snap) {
        delaySeconds = fromSnap ?? 0;
        delaySource = fromSnap !== null ? "snapshot" : "none";
      } else {
        const res = await resolveBattleRuleset(db, b.mode, b.ruleset_id);
        const d = res.ok ? delayOf(loadRuleset(res.ruleset.rulesetId)) : null;
        delaySeconds = d ?? 0;
        delaySource = d !== null ? "ruleset" : "none";
      }
    }
    // STREAMING-UX (§4) · nombre legible; el UUID queda en los detalles técnicos.
    const parts = await db("participants")
      .leftJoin("bots", "bots.id", "participants.bot_id")
      .where("participants.battle_id", t.id)
      .orderBy(["participants.team", "bots.name"])
      .select("participants.team", "bots.name as bot_name")
      .catch(() => []);
    return {
      kind: "battle",
      id: t.id,
      label: parts.length
        ? battleLabel(
            parts.map((p: { team: string; bot_name: string | null }) => ({ team: p.team, botName: p.bot_name })),
          )
        : `Batalla ${t.id.slice(0, 8)} (${b.mode})`,
      status: b.status,
      broadcastable: pub,
      broadcastBlockedReason: show.reason,
      tournamentBroadcast: show.tournamentBroadcast,
      publicBroadcastable: eff.broadcastAvailable,
      ...eff,
      delaySeconds,
      delaySource,
    };
  }
  const tr = await db("tournaments")
    .where({ id: t.id })
    .first()
    .catch(() => null);
  if (!tr) return null;
  const snap = rulesOf(tr);
  const d = snap ? delayOf(snap.engineRuleset) : null;
  const teff = effectiveFields(await tournamentBroadcastState(db, t.id, vis));
  return {
    kind: "tournament",
    id: t.id,
    label: String(tr.name ?? `Torneo ${t.id.slice(0, 8)}`).slice(0, 120),
    status: tr.state,
    // Un torneo siempre se puede emitir (compatibilidad): el director muestra las batallas
    // que la API pública deja leer. Con `broadcast`, TODAS (con la proyección de competición
    // de sus bots privados o de equipo); sin él, sólo las que no tienen bots no públicos.
    broadcastable: true,
    broadcastBlockedReason: null,
    tournamentBroadcast: tr.broadcast === true,
    publicBroadcastable: teff.broadcastAvailable,
    ...teff,
    delaySeconds: d ?? 0,
    delaySource: d !== null ? "snapshot" : "none",
  };
}

/** URL de /broadcast que captura el streamer (branding por query, saneado allí también). */
export function broadcastUrlFor(base: string, t: { kind: TargetKind; id: string }, b: Branding): string {
  const u = new URL(base);
  u.search = "";
  u.searchParams.set(t.kind, t.id);
  u.searchParams.set("event", b.eventName);
  if (b.logoUrl) u.searchParams.set("logo", b.logoUrl);
  u.searchParams.set("primary", b.primaryColor);
  u.searchParams.set("accent", b.accentColor);
  return u.toString();
}

// ── STREAMING-UX · ingestas editables (§16-§21) ─────────────────────────────
export interface IngestsPatchResult {
  primaryIngestUrl: string | null;
  backupIngestUrl: string | null;
  errors: string[];
}

/**
 * Valida el cambio de ingestas de una plataforma. Reglas (§20, §21):
 *  - la principal es obligatoria, sin query y con las reglas de siempre (rtmps,
 *    sin credenciales y con un host público);
 *  - la de respaldo es opcional (null = sin respaldo), con las mismas reglas, y
 *    SÓLO en YouTube admite exactamente `?backup=1`; cualquier otra query se rechaza;
 *  - la principal y la de respaldo no pueden ser el mismo destino;
 *  - se guardan TAL CUAL llegan (sin recortar ni concatenar nada).
 */
export function validateIngestsPatch(
  platform: PlatformDef,
  body: Record<string, unknown>,
  ctx: { allowInternalIngest?: boolean } = {},
): IngestsPatchResult {
  const errors: string[] = [];
  for (const k of Object.keys(body)) {
    if (k !== "primaryIngestUrl" && k !== "backupIngestUrl") errors.push(`campo no admitido: ${k}`);
  }
  const primary = validIngestUrl(body.primaryIngestUrl, {
    allowInternal: ctx.allowInternalIngest,
    fixedApp: platform.fixedApp,
  });
  if (!primary) {
    errors.push(
      platform.fixedApp
        ? `Servidor principal: debe ser rtmps://host[:puerto]/${platform.fixedApp}, sin nada más en la ruta (la clave va en su propio campo, nunca en la URL), sin query y con un host público`
        : "Servidor principal: debe ser rtmps://host[:puerto]/aplicación, sin credenciales, query, barras sobrantes ni la clave en la ruta (va en su propio campo), y con un host público",
    );
  }
  let backup: string | null = null;
  if (body.backupIngestUrl !== undefined && body.backupIngestUrl !== null && body.backupIngestUrl !== "") {
    backup = validIngestUrl(body.backupIngestUrl, {
      allowInternal: ctx.allowInternalIngest,
      allowBackupQuery: platform.backupQuery,
      fixedApp: platform.fixedApp,
    });
    // R-H6 · en YouTube el respaldo es EXACTAMENTE `live2?backup=1` (la query es obligatoria).
    if (backup && platform.fixedApp && platform.backupQuery && !backup.endsWith(BACKUP_QUERY)) backup = null;
    if (!backup) {
      errors.push(
        platform.fixedApp && platform.backupQuery
          ? `Servidor de respaldo: debe ser rtmps://host[:puerto]/${platform.fixedApp}${BACKUP_QUERY}, sin nada más en la ruta (la clave va en su propio campo, nunca en la URL) y con un host público`
          : "Servidor de respaldo: debe ser rtmps://host[:puerto]/aplicación, sin credenciales, query, barras sobrantes ni la clave en la ruta (va en su propio campo), y con un host público",
      );
    }
  }
  if (primary && backup) {
    try {
      // El mismo servidor con o sin `?backup=1` sigue siendo el mismo servidor.
      const server = (u: string) => canonicalIngestUrl(u).replace(/\?.*$/, "");
      if (server(primary) === server(backup)) {
        errors.push("El servidor de respaldo no puede ser el mismo que el principal");
      }
    } catch {
      /* ya validadas arriba */
    }
  }
  return { primaryIngestUrl: primary, backupIngestUrl: backup, errors };
}

// ── STREAMING-UX · selector de destinos sin UUID (§4, §6) ───────────────────
export interface DestinationItem extends BroadcastEffectiveFields {
  kind: TargetKind;
  id: string;
  /** Nombre legible: «Bot A vs Bot B», «Rojo vs Azul (4v4)» o el nombre del torneo. */
  label: string;
  status: string;
  mode: string | null;
  tournamentName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  broadcastable: boolean;
  broadcastBlockedReason: BroadcastBlockedReason | null;
  tournamentBroadcast: boolean | null;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Nombre humano de una batalla a partir de sus participantes (admin: ve todos los nombres). */
export function battleLabel(parts: { team: string; botName: string | null }[]): string {
  const teams = new Map<string, string[]>();
  for (const p of parts) {
    const list = teams.get(p.team) ?? [];
    list.push(p.botName || "bot");
    teams.set(p.team, list);
  }
  if (teams.size === 0) return "Batalla sin participantes";
  // Ronda 1 (P3) · orden del enfrentamiento: rojo (equipo A) primero y azul después, como los
  // asigna el lanzador; la consulta ordena por nombre de equipo y salía «Team B vs Team A».
  const rank = (t: string) => (t === "red" ? 0 : t === "blue" ? 1 : 2);
  const groups = [...teams.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  if (groups.every(([, bots]) => bots.length === 1)) return groups.map(([, bots]) => bots[0]).join(" vs ");
  const size = groups.map(([, bots]) => bots.length).join("v");
  return `${groups.map(([team]) => team).join(" vs ")} (${size})`;
}

/**
 * Batallas en curso y terminadas (las en curso primero; dentro de cada grupo, de la más
 * reciente a la más antigua) y torneos, con su nombre legible y si se pueden retransmitir,
 * aplicando la MISMA regla que `resolveTarget` (y que la lectura pública de /broadcast).
 */
export async function listDestinations(
  db: Db,
  o: { limit?: number; vis?: BattleVisibility } = {},
): Promise<{ battles: DestinationItem[]; tournaments: DestinationItem[] }> {
  const vis = o.vis ?? NO_PUBLIC;
  const limit = Math.min(Math.max(o.limit ?? 20, 1), 50);
  const rows = await db("battles")
    .leftJoin("tournaments", "tournaments.id", "battles.tournament_id")
    .whereIn("battles.status", ["running", "finished"])
    .orderByRaw("CASE WHEN battles.status = 'running' THEN 0 ELSE 1 END")
    .orderByRaw("COALESCE(battles.finished_at, battles.started_at, battles.created_at) DESC")
    .limit(limit)
    .select(
      "battles.id",
      "battles.status",
      "battles.mode",
      "battles.created_at",
      "battles.started_at",
      "battles.finished_at",
      "tournaments.name as tournament_name",
    );
  const ids = rows.map((r: { id: string }) => r.id);
  const parts = ids.length
    ? await db("participants")
        .leftJoin("bots", "bots.id", "participants.bot_id")
        .whereIn("participants.battle_id", ids)
        .orderBy(["participants.team", "bots.name"])
        .select("participants.battle_id", "participants.team", "bots.name as bot_name")
    : [];
  const battles: DestinationItem[] = [];
  for (const r of rows) {
    const show = await publicShowabilityOf(db, r.id);
    battles.push({
      kind: "battle",
      id: r.id,
      label: battleLabel(
        parts
          .filter((p: { battle_id: string }) => p.battle_id === r.id)
          .map((p: { team: string; bot_name: string | null }) => ({ team: p.team, botName: p.bot_name })),
      ),
      status: r.status,
      mode: r.mode ?? null,
      tournamentName: r.tournament_name ?? null,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      createdAt: iso(r.created_at)!,
      broadcastable: !!show?.showable,
      broadcastBlockedReason: show?.reason ?? null,
      tournamentBroadcast: show?.tournamentBroadcast ?? null,
      ...effectiveFields(await battleBroadcastState(db, r.id, vis)),
    });
  }
  const trs = await db("tournaments")
    .whereNotIn("state", ["draft", "cancelled"])
    .orderByRaw("CASE WHEN state = 'running' THEN 0 ELSE 1 END")
    .orderBy("created_at", "desc")
    .limit(limit)
    .select("id", "name", "state", "mode", "created_at", "broadcast");
  const tournaments: DestinationItem[] = [];
  for (const t of trs as Record<string, unknown>[])
    tournaments.push({
      kind: "tournament" as const,
      id: t.id as string,
      label: String(t.name ?? "Torneo").slice(0, 120),
      status: t.state as string,
      mode: (t.mode as string) ?? null,
      tournamentName: String(t.name ?? ""),
      startedAt: null,
      finishedAt: null,
      createdAt: iso(t.created_at)!,
      // Misma regla que resolveTarget: un torneo siempre se puede emitir.
      broadcastable: true,
      broadcastBlockedReason: null,
      tournamentBroadcast: t.broadcast === true,
      ...effectiveFields(await tournamentBroadcastState(db, t.id as string, vis)),
    });
  return { battles, tournaments };
}

// ── clave pública de sellado ────────────────────────────────────────────────
export function readPublicKey(env: NodeJS.ProcessEnv = process.env): { pem: string; kid: string } | null {
  const f = env.STREAM_SECRETS_PUBLIC_KEY_FILE;
  if (!f) return null;
  try {
    const pem = readFileSync(f, "utf8");
    return { pem, kid: keyIdOf(pem) };
  } catch {
    return null;
  }
}
