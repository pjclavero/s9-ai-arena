/**
 * T11.2 · Configuración del servicio streamer (cap. 21).
 *
 * La clave RTMPS de YouTube entra SOLO por archivo (STREAM_KEY_FILE, secreto
 * del Compose vía init-secrets.sh) y vive separada del objeto de configuración:
 * `StreamerConfig` es serializable/loggable sin riesgo; la clave viaja aparte
 * y todo texto que salga por el logger pasa por `redactSecret`.
 */
import type { readFileSync as ReadFileSync } from "node:fs";

export interface StreamerConfig {
  /** URL de la vista /broadcast de T11.1 que captura Chromium. */
  broadcastUrl: string;
  /** Ingesta RTMPS (YouTube: rtmps://a.rtmps.youtube.com/live2). */
  rtmpsUrl: string;
  /** rtmps = emitir; record = "solo grabación" a archivo (E11.M, sin canal). */
  mode: "rtmps" | "record";
  /** Directorio del modo grabación (E11.M: arena_replays/video). */
  recordDir: string;
  /** x264 por software (base); nvenc exige GPU con passthrough en Proxmox. */
  encoder: "x264" | "nvenc";
  /** Tamaño del Xvfb/Chromium (lo que se CAPTURA): siempre el de la composición 1920×1080. */
  width: number;
  height: number;
  /** EQ5b · Tamaño CODIFICADO (preset 1080p o 720p): si difiere, ffmpeg escala. */
  outputWidth: number;
  outputHeight: number;
  fps: number;
  videoBitrateKbps: number;
  /** DISPLAY del Xvfb donde pinta Chromium y captura FFmpeg. */
  display: string;
  /** Puerto de la API interna de control (red platform; jamás publicado). */
  controlPort: number;
  /** Reintentos ante corte de RTMPS y espera entre ellos. */
  maxRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_CONFIG: StreamerConfig = {
  broadcastUrl: "http://web:3000/broadcast",
  rtmpsUrl: "rtmps://a.rtmps.youtube.com/live2",
  mode: "rtmps",
  recordDir: "/data/replays/video",
  encoder: "x264",
  width: 1920,
  height: 1080,
  outputWidth: 1920,
  outputHeight: 1080,
  fps: 30,
  videoBitrateKbps: 4500,
  display: ":99",
  controlPort: 8090,
  maxRetries: 20,
  retryDelayMs: 3000,
};

function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: Record<string, string | undefined>): StreamerConfig {
  const mode = env.STREAM_MODE === "record" ? "record" : "rtmps";
  const encoder = env.STREAM_ENCODER === "nvenc" ? "nvenc" : "x264";
  return {
    ...DEFAULT_CONFIG,
    broadcastUrl: env.BROADCAST_URL || DEFAULT_CONFIG.broadcastUrl,
    rtmpsUrl: env.RTMPS_URL || DEFAULT_CONFIG.rtmpsUrl,
    mode,
    recordDir: env.RECORD_DIR || DEFAULT_CONFIG.recordDir,
    encoder,
    fps: intEnv(env.STREAM_FPS, DEFAULT_CONFIG.fps),
    videoBitrateKbps: intEnv(env.STREAM_BITRATE_KBPS, DEFAULT_CONFIG.videoBitrateKbps),
    display: env.DISPLAY || DEFAULT_CONFIG.display,
    controlPort: intEnv(env.STREAMER_CONTROL_PORT, DEFAULT_CONFIG.controlPort),
    maxRetries: intEnv(env.STREAM_MAX_RETRIES, DEFAULT_CONFIG.maxRetries),
    retryDelayMs: intEnv(env.STREAM_RETRY_DELAY_MS, DEFAULT_CONFIG.retryDelayMs),
  };
}

/**
 * Lee la clave de emisión del ARCHIVO de secreto (cap. 21: "nunca en variables
 * visibles ni logs"). En modo record no hace falta clave.
 */
export function loadStreamKey(
  env: Record<string, string | undefined>,
  readFile: typeof ReadFileSync,
  mode: StreamerConfig["mode"],
): string | null {
  const file = env.STREAM_KEY_FILE;
  if (!file) {
    if (mode === "record") return null;
    throw new Error("STREAM_KEY_FILE no definido: la clave RTMPS va por archivo de secreto");
  }
  let raw = "";
  try {
    raw = String(readFile(file, "utf8")).trim();
  } catch {
    raw = "";
  }
  if (!raw && mode === "rtmps") {
    throw new Error(`El secreto ${file} está vacío: rellenar con la clave de YouTube (init-secrets.sh)`);
  }
  return raw || null;
}

/** EQ5d · Longitud mínima de un fragmento de la clave que se considera fuga. */
export const REDACT_MIN_FRAGMENT = 8;

/**
 * Codificaciones en que la clave (o un trozo) puede reaparecer: tal cual, base64
 * estándar y URL-safe en las TRES alineaciones de byte (un trozo de la clave
 * dentro de un texto más largo se codifica desplazado) y hex. De cada
 * alineación sólo se toman los grupos completos (los extremos dependen de los
 * bytes vecinos).
 */
function encodedForms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), bytes.toString("hex")];
  for (let o = 0; o < 3 && o < bytes.length; o++) {
    const n = Math.floor((bytes.length - o) / 3) * 3;
    if (n <= 0) continue;
    const b64 = bytes.subarray(o, o + n).toString("base64");
    forms.push(b64, b64.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return forms.filter((f) => f.length > 0);
}

/**
 * EQ5e (revisión ronda 3, R3-A) · Paso a minúsculas que NO cambia la longitud.
 * `String#toLowerCase` no conserva la longitud ('İ' U+0130 → 'i' + U+0307), y
 * los índices calculados sobre el texto en minúsculas se aplicaban al original:
 * la marca se desplazaba y la clave salía entera. Aquí cada punto de código se
 * pliega por separado y sólo se acepta el plegado si mide lo mismo (UTF-16); si
 * no, se toma su primera unidad cuando el original mide una (İ → i) o se deja
 * tal cual. Resultado: `foldSameLength(t).length === t.length` y el índice i
 * del plegado corresponde al índice i del original.
 */
export function foldSameLength(text: string): string {
  // Camino rápido: ASCII puro no cambia de longitud al pasar a minúsculas.
  if (!/[^\x00-\x7f]/.test(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + w);
    const low = ch.toLowerCase();
    out += low.length === w ? low : w === 1 ? low[0] : ch;
    i += w;
  }
  return out;
}

/**
 * Sustituye la clave por *** en cualquier texto destinado a logs/respuestas.
 *
 * EQ5c · tal cual, escapada en JSON y URL-codificada, sin distinguir mayúsculas.
 * EQ5d (revisión EQ6c, P3) · y además CUALQUIER fragmento de
 * `REDACT_MIN_FRAGMENT` (8) o más caracteres de la clave, de su base64 (estándar
 * o URL-safe) o de su hex: una ingesta hostil devolvía la clave codificada en el
 * rechazo y llegaba a `lastError` y a los logs. Se marca toda ventana de 8
 * caracteres que sea un 8-grama de alguna forma (sin distinguir mayúsculas) y
 * se sustituye cada tramo marcado por ***. Si la clave (o una forma) es más
 * corta que 8, cuenta la forma entera.
 *
 * EQ5e (R3-A) · la comparación usa `foldSameLength` (texto y formas): los
 * índices de la marca valen tal cual sobre el texto original.
 *
 * Falso positivo ACEPTADO (documentado en docs/operations/streaming.md): si la
 * clave contiene una palabra de 8 o más letras que aparece en el log (p. ej.
 * `streamer`), esa palabra también se redacta (`"service":"***"`). Se
 * sobre-redacta, nunca se fuga: con una clave aleatoria la probabilidad es
 * despreciable y distinguir «palabra común» de «trozo de la clave» exigiría
 * dejar pasar trozos de la clave.
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || !text) return text;
  const grams = new Map<number, Set<string>>();
  for (const f of encodedForms(secret)) {
    const n = Math.min(REDACT_MIN_FRAGMENT, f.length);
    let set = grams.get(n);
    if (!set) grams.set(n, (set = new Set()));
    const lf = foldSameLength(f);
    for (let i = 0; i + n <= lf.length; i++) set.add(lf.slice(i, i + n));
  }
  const lower = foldSameLength(text);
  const mark = new Uint8Array(text.length);
  let any = false;
  for (const [n, set] of grams) {
    for (let i = 0; i + n <= lower.length; i++) {
      if (set.has(lower.slice(i, i + n))) {
        mark.fill(1, i, i + n);
        any = true;
      }
    }
  }
  if (!any) return text;
  let out = "";
  for (let i = 0; i < text.length;) {
    if (!mark[i]) {
      out += text[i++];
      continue;
    }
    while (i < text.length && mark[i]) i++;
    out += "***";
  }
  return out;
}

/**
 * EQ5b · Conjunto VIVO de secretos a redactar: la clave ya no se conoce al
 * arrancar (llega sellada en cada orden de arranque), así que el logger
 * redacta lo que haya en el conjunto en el momento de escribir.
 */
export class SecretRegistry {
  private readonly secrets = new Set<string>();
  add(s: string | null | undefined): void {
    if (s && s.length >= 4) this.secrets.add(s);
  }
  delete(s: string | null | undefined): void {
    if (s) this.secrets.delete(s);
  }
  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = redactSecret(out, s);
    return out;
  }
}

/** Logger JSON que REDACTA la clave en todo lo que escribe (revisión T11.2). */
export function createLogger(
  secret: string | null | SecretRegistry,
  write: (line: string) => void = (l) => console.log(l),
) {
  const registry = secret instanceof SecretRegistry ? secret : new SecretRegistry();
  if (!(secret instanceof SecretRegistry)) registry.add(secret);
  return (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ level, service: "streamer", msg, ...extra });
    write(registry.redact(line));
  };
}
export type Logger = ReturnType<typeof createLogger>;
