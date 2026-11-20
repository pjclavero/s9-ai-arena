/**
 * #256 · CLI del detector de frame blanco/uniforme (apps/streamer/src/frame-check.ts).
 *
 *   npx tsx tests/streaming-e2e/frame-detect.ts <etiqueta> <fichero> [fps]
 *
 * <fichero>: PNG (un frame) o vídeo/flujo (MP4, FLV…): éste se muestrea a `fps`
 * frames por segundo (1 por defecto). Imprime una línea por frame con media y
 * desviación de luma y su veredicto, y un resumen:
 *
 *   <etiqueta> frames=N visible=V white=W uniform=U first_visible_index=I all_visible=0|1
 *
 * rc 0 ⇔ TODOS los frames son visibles; rc 1 si alguno es blanco/uniforme; rc 2 si
 * no se pudo leer ningún frame. Necesita ffmpeg en el PATH (FFMPEG_BIN para otro).
 */
import { execFileSync } from "node:child_process";
import {
  classifyFrame,
  describeFrame,
  GRAY_FILTER,
  lumaStats,
  splitGrayFrames,
} from "../../apps/streamer/src/frame-check.js";

const [label, file, fpsArg] = process.argv.slice(2);
if (!label || !file) {
  console.error("uso: frame-detect.ts <etiqueta> <fichero> [fps]");
  process.exit(2);
}
const isImage = /\.(png|jpe?g|bmp|xwd)$/i.test(file);
const vf = isImage ? GRAY_FILTER : `fps=${Number(fpsArg) > 0 ? Number(fpsArg) : 1},${GRAY_FILTER}`;
let raw: Buffer;
try {
  raw = execFileSync(
    process.env.FFMPEG_BIN ?? "ffmpeg",
    ["-nostdin", "-loglevel", "error", "-i", file, "-vf", vf, "-f", "rawvideo", "pipe:1"],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
} catch (e) {
  // ffmpeg puede salir con error al final de un FLV truncado y aun así haber dado frames.
  raw = ((e as { stdout?: Buffer }).stdout ?? Buffer.alloc(0)) as Buffer;
}
const frames = splitGrayFrames(raw);
let visible = 0;
let white = 0;
let uniform = 0;
let firstVisible = -1;
frames.forEach((f, i) => {
  const s = lumaStats(f);
  const v = classifyFrame(s);
  if (v === "visible") {
    visible++;
    if (firstVisible < 0) firstVisible = i;
  } else if (v === "white") white++;
  else uniform++;
  console.log(describeFrame(`${label}[${i}]`, s));
});
const all = frames.length > 0 && visible === frames.length;
console.log(
  `${label} frames=${frames.length} visible=${visible} white=${white} uniform=${uniform} first_visible_index=${firstVisible} all_visible=${all ? 1 : 0}`,
);
process.exit(frames.length === 0 ? 2 : all ? 0 : 1);
