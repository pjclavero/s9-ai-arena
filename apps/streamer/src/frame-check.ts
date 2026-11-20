/**
 * #256 · Detector AUTOMÁTICO de frame blanco o uniforme.
 *
 * La emisión real de YouTube llegó «técnicamente válida» (H.264, 1080p30,
 * caudal correcto) y en blanco: ninguna prueba miraba el CONTENIDO del vídeo.
 * Este módulo lo mira con números, sin comparación manual:
 *
 *   - el frame se reduce a luma (gris, 8 bits) a baja resolución;
 *   - se calcula la media y la desviación típica de la luma;
 *   - BLANCO   ⇔ media > WHITE_MEAN_MIN y desviación < WHITE_STDDEV_MAX;
 *   - UNIFORME ⇔ desviación < UNIFORM_STDDEV_MAX (cualquier color: negro, el
 *     gris de un compositor sin pintar…);
 *   - si no, VISIBLE.
 *
 * Calibración MEDIDA con la imagen real del streamer (docs/operations/streaming.md, #256):
 *   - batalla en directo en /broadcast: media ≈25, desviación ≈12.7;
 *   - pantalla final de /broadcast (sólo DOM): media ≈21-23, desviación ≈11.2-11.4;
 *   - ventana de Chromium sin pintar (el blanco de YouTube): media 254.6, desviación 3.1;
 *   - Xvfb vacío: media 1, desviación 0.1; fondo del escenario sin texto: 19 / 0.1.
 * Ninguna pantalla útil baja de desviación 11; blanco y uniforme quedan por debajo de 3.2.
 *
 * La extracción de luma usa ffmpeg (lo hay en la imagen del streamer, en la CI y
 * en la máquina de pruebas); el cálculo es puro y se prueba sin ffmpeg.
 */
import { execFile } from "node:child_process";

/** Media de luma por encima de la cual un frame plano cuenta como «blanco». */
export const WHITE_MEAN_MIN = 230;
/** Un frame «blanco» puede tener algo de ruido de compresión, pero poco. */
export const WHITE_STDDEV_MAX = 12;
/** Por debajo de esta desviación el frame es plano: no hay nada que ver. */
export const UNIFORM_STDDEV_MAX = 3;

/** Resolución a la que se analiza el frame (de sobra para ver texto, HUD o escena). */
export const ANALYSIS_WIDTH = 192;
export const ANALYSIS_HEIGHT = 108;

export interface LumaStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  pixels: number;
}

export type FrameVerdict = "visible" | "white" | "uniform";

export function lumaStats(gray: Uint8Array): LumaStats {
  const n = gray.length;
  if (n === 0) return { mean: 0, stddev: 0, min: 0, max: 0, pixels: 0 };
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - mean;
    sq += d * d;
  }
  return { mean, stddev: Math.sqrt(sq / n), min, max, pixels: n };
}

export function classifyFrame(s: LumaStats): FrameVerdict {
  // Sin píxeles no hay frame: cuenta como plano (fail-closed).
  if (s.pixels === 0) return "uniform";
  if (s.mean > WHITE_MEAN_MIN && s.stddev < WHITE_STDDEV_MAX) return "white";
  if (s.stddev < UNIFORM_STDDEV_MAX) return "uniform";
  return "visible";
}

/** Línea de evidencia estable (la leen los scripts E2E y el informe). */
export function describeFrame(label: string, s: LumaStats): string {
  const v = classifyFrame(s);
  return `${label} verdict=${v === "visible" ? "VISIBLE" : v === "white" ? "WHITE_FAIL" : "UNIFORM_FAIL"} luma_mean=${s.mean.toFixed(2)} luma_stddev=${s.stddev.toFixed(2)} luma_min=${s.min} luma_max=${s.max} pixels=${s.pixels}`;
}

/** Trocea una salida rawvideo gris en frames de `w`×`h` (descarta un resto incompleto). */
export function splitGrayFrames(buf: Uint8Array, w = ANALYSIS_WIDTH, h = ANALYSIS_HEIGHT): Uint8Array[] {
  const size = w * h;
  const out: Uint8Array[] = [];
  for (let off = 0; off + size <= buf.length; off += size) out.push(buf.subarray(off, off + size));
  return out;
}

/** Filtro ffmpeg que deja el frame en gris a la resolución de análisis. */
export const GRAY_FILTER = `scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=area,format=gray`;

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { encoding: "buffer"; maxBuffer: number; timeout: number },
  cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void,
) => unknown;

/**
 * Lee UN frame del DISPLAY del Xvfb (x11grab) en gris. Es exactamente la
 * superficie que captura el ffmpeg de la emisión: no se infiere nada de que
 * Chromium esté vivo.
 */
export function grabDisplayLuma(
  ffmpegBin: string,
  display: string,
  width: number,
  height: number,
  exec: ExecFileLike = execFile as unknown as ExecFileLike,
  timeoutMs = 10_000,
): Promise<LumaStats> {
  const args = [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-video_size",
    `${width}x${height}`,
    "-i",
    display,
    "-frames:v",
    "1",
    "-vf",
    GRAY_FILTER,
    "-f",
    "rawvideo",
    "pipe:1",
  ];
  return new Promise((resolve, reject) => {
    exec(ffmpegBin, args, { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      const frames = splitGrayFrames(stdout);
      if (frames.length === 0) return reject(new Error("x11grab no devolvió ningún frame"));
      resolve(lumaStats(frames[0]));
    });
  });
}
