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
import type { Db } from "../db/connection.js";
import { keyIdOf } from "../../../../packages/stream-secrets/index.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { rulesOf } from "./battle-rules.js";
import { resolveBattleRuleset } from "./battle-ruleset-resolver.js";
import { whereOnlyPublicBots } from "../battle-access.js";

// ── catálogo de plataformas (extensible: añadir una entrada aquí) ───────────
export interface PlatformDef {
  id: string;
  label: string;
  /** Ingesta fija; null = la escribe el operador (RTMPS personalizado). */
  ingestUrl: string | null;
}
export const PLATFORMS: readonly PlatformDef[] = [
  { id: "youtube", label: "YouTube", ingestUrl: "rtmps://a.rtmps.youtube.com/live2" },
  { id: "custom", label: "RTMPS personalizado", ingestUrl: null },
];
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

/** Mismas reglas que el streamer (parseIngestUrl): sólo rtmps, sin credenciales ni query. */
export function validIngestUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 512) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "rtmps:" || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  const app = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  if (!app || app.length > 128 || !/^[A-Za-z0-9._~\-/]+$/.test(app)) return null;
  return v;
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
  ctx: { nvenc: boolean | null },
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
      const v = validIngestUrl(patch.ingestUrl);
      if (!v) errors.push("ingestUrl debe ser rtmps://host[:puerto]/aplicación, sin credenciales ni query");
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

/** Configuración que se aplica a una emisión (lo que se compara para «pendiente de reinicio»). */
export function appliedConfig(s: StreamingSettings, credentialStamp: string | null) {
  return {
    mode: s.mode,
    platform: s.platform,
    ingestUrl: s.mode === "rtmps" ? effectiveIngest(s) : null,
    encoder: s.encoder,
    preset: s.preset,
    fps: s.fps,
    videoBitrateKbps: s.videoBitrateKbps,
    branding: s.branding,
    credential: s.mode === "rtmps" ? credentialStamp : null,
  };
}

export function effectiveIngest(s: StreamingSettings): string | null {
  const p = platformById(s.platform);
  return p?.ingestUrl ?? s.ingestUrl;
}

// ── destino y retardo ───────────────────────────────────────────────────────
export type TargetKind = "battle" | "tournament";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TargetInfo {
  kind: TargetKind;
  id: string;
  label: string;
  status: string;
  /** /broadcast es ANÓNIMA: sólo se emite lo que un visitante puede ver. */
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
export async function resolveTarget(db: Db, t: { kind: TargetKind; id: string }): Promise<TargetInfo | null> {
  if (t.kind === "battle") {
    const b = await db("battles")
      .where({ id: t.id })
      .first()
      .catch(() => null);
    if (!b) return null;
    const pub = await whereOnlyPublicBots(db, db("battles").where("battles.id", t.id)).first();
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
    return {
      kind: "battle",
      id: t.id,
      label: `Batalla ${t.id.slice(0, 8)} (${b.mode})`,
      status: b.status,
      publicBroadcastable: !!pub,
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
  return {
    kind: "tournament",
    id: t.id,
    label: String(tr.name ?? `Torneo ${t.id.slice(0, 8)}`).slice(0, 120),
    status: tr.state,
    // El director de torneo sólo muestra batallas sin bots privados (lo filtra la API pública).
    publicBroadcastable: true,
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
