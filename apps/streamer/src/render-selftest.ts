/**
 * #256 · Autoprueba de render DENTRO de la imagen del streamer (la ejecuta el Dockerfile
 * en cada build de la CI): el MISMO Chromium, Xvfb, ffmpeg y supervisor que en producción,
 * sin red y sin ingesta (modo record).
 *
 *  1. Control POSITIVO: una página con contenido ⇒ la puerta BROADCAST_RENDER_READY se
 *     abre, ffmpeg graba y TODOS los frames del MP4 —el primero incluido— son VISIBLES
 *     (antes de #256 el vídeo empezaba con ~2 s de blanco y, si Chromium no pintaba, era
 *     blanco entero) [XVFB_FRAME_VISIBLE, FFMPEG_FRAME_VISIBLE].
 *  2. Control NEGATIVO: una página BLANCA ⇒ la puerta NO se abre, ffmpeg no llega a
 *     arrancar, no hay MP4 y la emisión acaba en `failed` con `render_not_ready`
 *     [WHITE_FRAME_REGRESSION]. Sin este negativo, una puerta que siempre dijera «listo»
 *     pasaría por buena.
 *
 *   tsx apps/streamer/src/render-selftest.ts   (rc 0 = ambos controles correctos)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, DEFAULT_CONFIG, type StreamerConfig } from "./config.js";
import {
  classifyFrame,
  describeFrame,
  grabDisplayLuma,
  GRAY_FILTER,
  lumaStats,
  splitGrayFrames,
} from "./frame-check.js";
import { realSpawner } from "./main.js";
import { StreamSupervisor } from "./supervisor.js";

const DISPLAY = process.env.SELFTEST_DISPLAY ?? ":95";
// Chromium toma el display del ENTORNO (buildChromiumArgs no lo pasa): en producción el
// entrypoint arranca el Xvfb en $DISPLAY; aquí el Xvfb propio va en DISPLAY y el entorno
// heredado por los hijos tiene que apuntar a él (la CI lo cazó: la imagen trae DISPLAY=:99).
process.env.DISPLAY = DISPLAY;
const DIR = process.env.SELFTEST_DIR ?? "/tmp/render-selftest";
const CHROMIUM = process.env.CHROMIUM_BIN ?? "chromium-browser";
const FFMPEG = process.env.FFMPEG_BIN ?? "ffmpeg";

const PAGES = {
  ok: `<!doctype html><html lang="es"><body style="margin:0;background:#10141f;color:#f5f5f5;font:48px sans-serif">
<h1 style="color:#ffb300;margin:24px">S9 AI Arena · autoprueba</h1><canvas id="c" width="1600" height="800"></canvas>
<script>const x=document.getElementById("c").getContext("2d");let f=0;(function d(){f++;x.fillStyle="#1a2a1a";x.fillRect(0,0,1600,800);
x.fillStyle="#d33";x.fillRect((f*7)%1500,300,100,100);x.fillStyle="#36f";x.fillRect(1500-(f*5)%1500,500,100,100);requestAnimationFrame(d)})()</script></body></html>`,
  white: `<!doctype html><html><body style="margin:0;background:#fff"></body></html>`,
};

function log(msg: string) {
  console.log(`render-selftest: ${msg}`);
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return cond();
}

async function run(kind: keyof typeof PAGES): Promise<boolean> {
  const rec = join(DIR, `rec-${kind}`);
  rmSync(rec, { recursive: true, force: true });
  mkdirSync(rec, { recursive: true });
  const page = join(DIR, `${kind}.html`);
  writeFileSync(page, PAGES[kind]);
  const config: StreamerConfig = {
    ...DEFAULT_CONFIG,
    mode: "record",
    recordDir: rec,
    display: DISPLAY,
    maxRetries: kind === "ok" ? 2 : 0,
    retryDelayMs: 500,
  };
  const sup = new StreamSupervisor({
    config,
    spawner: realSpawner,
    // Avisos y errores del supervisor a la salida del build (diagnóstico si falla).
    logger: createLogger(null, (l) => {
      if (/"level":"(warn|error)"/.test(l)) console.log(`render-selftest: [${kind}] ${l.slice(0, 600)}`);
    }),
    processTree: true,
    chromiumBin: CHROMIUM,
    ffmpegBin: FFMPEG,
    renderProbe: () => grabDisplayLuma(FFMPEG, DISPLAY, config.width, config.height),
    renderReadyTimeoutMs: kind === "ok" ? 30_000 : 8_000,
  });
  sup.start(`file://${page}`);
  let ok: boolean;
  if (kind === "ok") {
    const ready = await until(() => sup.render.state === "ready" || sup.state === "failed", 120_000);
    const recorded = ready && (await until(() => sup.metrics.snapshot().frames >= 75, 30_000));
    sup.stop();
    await until(() => sup.pendingChildren === 0, 10_000);
    const mp4 = readdirSync(rec).filter((f) => f.endsWith(".mp4"));
    log(
      `positivo: render=${sup.render.state} frames_codificados=${sup.metrics.snapshot().frames} mp4=${mp4.length} lastError=${sup.lastError?.message ?? "ninguno"}`,
    );
    if (!recorded || mp4.length === 0) return false;
    let raw: Buffer;
    try {
      raw = execFileSync(
        FFMPEG,
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          join(rec, mp4[0]),
          "-vf",
          `fps=4,${GRAY_FILTER}`,
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    } catch (e) {
      raw = ((e as { stdout?: Buffer }).stdout ?? Buffer.alloc(0)) as Buffer;
    }
    const frames = splitGrayFrames(raw).map(lumaStats);
    frames.forEach((s, i) => log(describeFrame(`positivo-mp4[${i}]`, s)));
    const bad = frames.filter((s) => classifyFrame(s) !== "visible").length;
    ok = frames.length >= 4 && bad === 0;
    log(`positivo: ${frames.length} frames analizados, ${bad} blancos/uniformes ⇒ ${ok ? "OK" : "FALLO"}`);
  } else {
    await until(() => sup.state === "failed", 60_000);
    const mp4 = readdirSync(rec).filter((f) => f.endsWith(".mp4"));
    log(
      `negativo: estado=${sup.state} render=${sup.render.state} mp4=${mp4.length} lastError=${sup.lastError?.message ?? "ninguno"}`,
    );
    ok = sup.state === "failed" && mp4.length === 0 && (sup.lastError?.message ?? "").startsWith("render_not_ready");
    sup.stop();
    await until(() => sup.pendingChildren === 0, 10_000);
    log(`negativo ⇒ ${ok ? "OK" : "FALLO"}`);
  }
  return ok;
}

// Sin top-level await: en la imagen no hay package.json con "type": "module" y tsx
// transforma este fichero a CommonJS (lo cazó la CI).
async function selftest(): Promise<number> {
  mkdirSync(DIR, { recursive: true });
  const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], { stdio: "ignore" });
  const sock = `/tmp/.X11-unix/X${DISPLAY.replace(/^:/, "").split(".")[0]}`;
  let rc = 1;
  try {
    if (!(await until(() => existsSync(sock), 10_000))) throw new Error(`Xvfb no creó ${sock}`);
    const positive = await run("ok");
    const negative = await run("white");
    log(`RESULTADO positivo=${positive ? "OK" : "FALLO"} negativo=${negative ? "OK" : "FALLO"}`);
    rc = positive && negative ? 0 : 1;
  } catch (e) {
    log(`error: ${(e as Error).message}`);
  } finally {
    xvfb.kill("SIGTERM");
    rmSync(DIR, { recursive: true, force: true });
  }
  return rc;
}

void selftest().then((rc) => process.exit(rc));
