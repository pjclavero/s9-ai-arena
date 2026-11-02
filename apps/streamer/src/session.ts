/**
 * EQ5b · Orden de arranque desde la API administrativa (Administración →
 * Streaming). El streamer VALIDA todo por su cuenta (no se fía de la API):
 *
 *  - `broadcastUrl` sólo puede ser la vista /broadcast del MISMO origen que
 *    BROADCAST_URL (el Chromium del streamer no navega a donde le digan: SSRF);
 *  - modo, encoder, preset, FPS y bitrate en listas/rangos cerrados; NVENC sólo
 *    si el runtime lo ha confirmado al arrancar;
 *  - la ingesta sólo `rtmps://` y la credencial sólo SELLADA (packages/stream-secrets):
 *    la clave en claro no viaja nunca en el cuerpo.
 */
import { isSealedSecret, type SealedSecret } from "../../../packages/stream-secrets/index.js";
import { parseIngestUrl, type IngestTarget } from "./rtmp/publisher.js";
import type { StreamerConfig } from "./config.js";

export const PRESETS = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
} as const;
export type PresetName = keyof typeof PRESETS;

export const BITRATE_LIMITS = { min: 1000, max: 12000 } as const;

export interface Capabilities {
  /** null = aún comprobándose al arrancar. */
  nvenc: boolean | null;
}

export interface SessionPlan {
  sessionId: string | null;
  config: StreamerConfig;
  preset: PresetName;
  broadcastUrl: string;
  ingest: IngestTarget | null;
  credential: SealedSecret | null;
}

const SESSION_ID = /^[0-9a-zA-Z_-]{1,64}$/;

export function presetOf(cfg: StreamerConfig): PresetName {
  return cfg.outputHeight === 720 ? "720p" : "1080p";
}

/** Comprueba que `url` es la vista /broadcast del origen configurado. */
export function validBroadcastUrl(url: unknown, base: string): string | null {
  if (typeof url !== "string" || url.length > 1024) return null;
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return null;
  }
  if (u.origin !== b.origin) return null;
  if (u.pathname !== "/broadcast" && u.pathname !== "/broadcast/") return null;
  if (u.username || u.password || u.hash) return null;
  return u.toString();
}

export type ParseResult = { ok: true; plan: SessionPlan } | { ok: false; error: string };

export function parseStartRequest(
  body: unknown,
  base: StreamerConfig,
  caps: Capabilities,
  opts: { allowPlainRtmp?: boolean } = {},
): ParseResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const known = new Set([
    "sessionId",
    "broadcastUrl",
    "mode",
    "encoder",
    "preset",
    "fps",
    "videoBitrateKbps",
    "ingestUrl",
    "credential",
    "replace",
  ]);
  for (const k of Object.keys(b)) if (!known.has(k)) return { ok: false, error: `campo no admitido: ${k}` };

  let sessionId: string | null = null;
  if (b.sessionId !== undefined) {
    if (typeof b.sessionId !== "string" || !SESSION_ID.test(b.sessionId))
      return { ok: false, error: "sessionId inválido" };
    sessionId = b.sessionId;
  }
  let broadcastUrl = base.broadcastUrl;
  if (b.broadcastUrl !== undefined) {
    const v = validBroadcastUrl(b.broadcastUrl, base.broadcastUrl);
    if (!v) return { ok: false, error: "broadcastUrl inválida: sólo la vista /broadcast del origen configurado" };
    broadcastUrl = v;
  }
  const mode = b.mode ?? base.mode;
  if (mode !== "rtmps" && mode !== "record") return { ok: false, error: "mode debe ser rtmps o record" };
  const encoder = b.encoder ?? base.encoder;
  if (encoder !== "x264" && encoder !== "nvenc") return { ok: false, error: "encoder debe ser x264 o nvenc" };
  if (encoder === "nvenc" && caps.nvenc !== true) {
    return { ok: false, error: "NVENC no disponible: el runtime no lo ha confirmado (usa x264)" };
  }
  const preset = (b.preset ?? presetOf(base)) as PresetName;
  if (preset !== "1080p" && preset !== "720p") return { ok: false, error: "preset debe ser 1080p o 720p" };
  const fps = b.fps ?? base.fps;
  if (fps !== 30 && fps !== 60) return { ok: false, error: "fps debe ser 30 o 60" };
  const bitrate = b.videoBitrateKbps ?? base.videoBitrateKbps;
  if (
    !Number.isInteger(bitrate) ||
    (bitrate as number) < BITRATE_LIMITS.min ||
    (bitrate as number) > BITRATE_LIMITS.max
  ) {
    return {
      ok: false,
      error: `videoBitrateKbps debe ser un entero entre ${BITRATE_LIMITS.min} y ${BITRATE_LIMITS.max}`,
    };
  }

  let ingest: IngestTarget | null = null;
  let credential: SealedSecret | null = null;
  if (mode === "rtmps") {
    try {
      ingest = parseIngestUrl(typeof b.ingestUrl === "string" ? b.ingestUrl : base.rtmpsUrl, opts.allowPlainRtmp);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (b.credential !== undefined && b.credential !== null) {
      if (!isSealedSecret(b.credential)) return { ok: false, error: "credential debe ser una credencial sellada" };
      credential = b.credential;
    }
  } else if (b.credential !== undefined && b.credential !== null) {
    return { ok: false, error: "el modo record no usa credencial" };
  }

  const size = PRESETS[preset];
  const config: StreamerConfig = {
    ...base,
    mode,
    encoder,
    fps,
    videoBitrateKbps: bitrate as number,
    outputWidth: size.width,
    outputHeight: size.height,
    rtmpsUrl: ingest ? `${ingest.protocol}://${ingest.host}:${ingest.port}/${ingest.app}` : base.rtmpsUrl,
  };
  return { ok: true, plan: { sessionId, config, preset, broadcastUrl, ingest, credential } };
}

/** Huella comparable de una sesión (idempotencia de start con el mismo sessionId). */
export function sessionFingerprint(p: SessionPlan): string {
  const c = p.config;
  return JSON.stringify([
    p.sessionId,
    p.broadcastUrl,
    c.mode,
    c.encoder,
    p.preset,
    c.fps,
    c.videoBitrateKbps,
    p.ingest?.display ?? null,
    p.credential?.ct ?? null,
  ]);
}
