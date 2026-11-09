/**
 * #256 · WHITE_FRAME_REGRESSION (parte pura): el detector de frame blanco/uniforme.
 *
 * Con frames sintéticos de luma y, si hay ffmpeg en la máquina (la CI lo instala para
 * las pruebas del streamer), con frames CODIFICADOS de verdad: un blanco que sale de
 * x264 + yuv420p sigue siendo blanco, y una escena con contraste sigue siendo visible.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_HEIGHT,
  ANALYSIS_WIDTH,
  classifyFrame,
  describeFrame,
  GRAY_FILTER,
  grabDisplayLuma,
  lumaStats,
  splitGrayFrames,
  type ExecFileLike,
} from "./frame-check.js";

const N = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
const flat = (v: number) => new Uint8Array(N).fill(v);
/** Escena tipo /broadcast: fondo oscuro, cabecera con texto claro, bloques de escena. */
function scene(): Uint8Array {
  const f = flat(20);
  for (let y = 0; y < ANALYSIS_HEIGHT; y++)
    for (let x = 0; x < ANALYSIS_WIDTH; x++) {
      if (y < 8 && x % 7 < 3) f[y * ANALYSIS_WIDTH + x] = 220; // texto de cabecera
      if (y > 30 && y < 60 && x > 40 && x < 70) f[y * ANALYSIS_WIDTH + x] = 120; // vehículo/muro
    }
  return f;
}

describe("#256 · detector de frame blanco/uniforme", () => {
  it("un frame blanco es WHITE (también con algo de ruido de compresión)", () => {
    expect(classifyFrame(lumaStats(flat(255)))).toBe("white");
    const noisy = flat(250);
    for (let i = 0; i < N; i += 13) noisy[i] = 236;
    expect(classifyFrame(lumaStats(noisy))).toBe("white");
  });

  it("un frame plano de cualquier color es UNIFORME (negro de Xvfb, gris de compositor)", () => {
    expect(classifyFrame(lumaStats(flat(0)))).toBe("uniform");
    expect(classifyFrame(lumaStats(flat(128)))).toBe("uniform");
    expect(classifyFrame(lumaStats(flat(16)))).toBe("uniform"); // negro en rango limitado
  });

  it("una escena con contraste es VISIBLE", () => {
    const s = lumaStats(scene());
    expect(classifyFrame(s)).toBe("visible");
    expect(describeFrame("x", s)).toMatch(/^x verdict=VISIBLE luma_mean=\d+\.\d\d luma_stddev=\d+\.\d\d/);
  });

  it("sin píxeles no hay frame: falla cerrado", () => {
    expect(classifyFrame(lumaStats(new Uint8Array(0)))).toBe("uniform");
  });

  it("splitGrayFrames trocea por tamaño exacto y descarta restos", () => {
    const buf = new Uint8Array(N * 2 + 5);
    expect(splitGrayFrames(buf)).toHaveLength(2);
  });

  it("grabDisplayLuma pide 1 frame x11grab sin cursor en gris y lo clasifica", async () => {
    let seen: string[] = [];
    const fake: ExecFileLike = (_f, args, _o, cb) => {
      seen = args;
      cb(null, Buffer.from(flat(255)), Buffer.alloc(0));
    };
    const s = await grabDisplayLuma("ffmpeg", ":99", 1920, 1080, fake);
    expect(classifyFrame(s)).toBe("white");
    expect(seen.join(" ")).toContain("-f x11grab -draw_mouse 0 -video_size 1920x1080 -i :99 -frames:v 1");
    expect(seen.join(" ")).toContain(GRAY_FILTER);
  });

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("con ffmpeg real: blanco codificado x264/yuv420p ⇒ WHITE; patrón de prueba ⇒ VISIBLE", () => {
    const enc = (src: string) =>
      execFileSync("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", src, "-frames:v", "1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "h264", "pipe:1",
      ]);
    const gray = (h264: Buffer) =>
      execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-vf", GRAY_FILTER, "-f", "rawvideo", "pipe:1"], {
        input: h264,
      });
    const white = splitGrayFrames(gray(enc("color=c=white:s=640x360")))[0];
    const black = splitGrayFrames(gray(enc("color=c=black:s=640x360")))[0];
    const bars = splitGrayFrames(gray(enc("testsrc2=s=640x360")))[0];
    expect(classifyFrame(lumaStats(white))).toBe("white");
    expect(classifyFrame(lumaStats(black))).toBe("uniform");
    expect(classifyFrame(lumaStats(bars))).toBe("visible");
  });
});
