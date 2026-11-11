/**
 * #256 · BROADCAST_RENDER_READY y vigilante de pantalla en blanco (supervisor).
 *
 * La emisión real de YouTube llegó en blanco porque ffmpeg capturaba —y el relé
 * publicaba— un Xvfb en el que Chromium no había pintado nunca. Aquí, con procesos
 * falsos y una sonda de display falsa (la real es x11grab, frame-check.ts):
 *  - WHITE_FRAME_REGRESSION: con el display en blanco NO se lanza ffmpeg ni se conecta
 *    el relé; vence el plazo, se relanza Chromium y, agotados los reintentos, `failed`
 *    con `render_not_ready` en lastError;
 *  - ffmpeg arranca sólo tras RENDER_READY_CONSECUTIVE frames visibles seguidos;
 *  - el negro uniforme del Xvfb vacío tampoco abre la puerta;
 *  - con la emisión en marcha, RENDER_BLANK_STRIKES lecturas no visibles cortan y relanzan.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, type StreamerConfig } from "./config.js";
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH, lumaStats, type LumaStats } from "./frame-check.js";
import {
  RENDER_BLANK_STRIKES,
  RENDER_READY_CONSECUTIVE,
  StreamSupervisor,
  type SpawnedProcess,
  type Spawner,
} from "./supervisor.js";

const N = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
const WHITE = lumaStats(new Uint8Array(N).fill(255));
const BLACK = lumaStats(new Uint8Array(N).fill(0));
const PAGE = (() => {
  const f = new Uint8Array(N).fill(20);
  for (let i = 0; i < N; i += 7) f[i] = 200;
  return lumaStats(f);
})();

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  exitCode: number | null = null;
  constructor(
    public cmd: string,
    public args: string[],
  ) {
    super();
  }
  kill() {
    this.exitCode = 0;
    return true;
  }
}

function harness(frames: (n: number) => LumaStats, over: Partial<StreamerConfig> = {}) {
  const spawned: FakeProcess[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args);
    spawned.push(p);
    return p;
  };
  let clock = 0;
  let probes = 0;
  const dials: string[] = [];
  const lines: string[] = [];
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", maxRetries: 2, retryDelayMs: 1, ...over },
    streamKey: "clave-centinela-256",
    spawner,
    logger: createLogger("clave-centinela-256", (l) => lines.push(l)),
    chromiumBin: "chromium",
    ffmpegBin: "ffmpeg",
    now: () => clock,
    // Tiempo virtual: cada espera avanza el reloj y cede el turno (macrotarea).
    sleep: (ms) =>
      new Promise((r) => {
        clock += ms;
        setImmediate(r);
      }),
    renderProbe: async () => frames(probes++),
    renderReadyTimeoutMs: 10_000,
    renderPollMs: 500,
    renderWatchIntervalMs: 5_000,
    dial: (() => {
      dials.push("dial");
      throw new Error("sin red en la prueba");
    }) as never,
  });
  const count = (cmd: string) => spawned.filter((p) => p.cmd === cmd).length;
  const until = async (cond: () => boolean, max = 5000) => {
    for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
    return cond();
  };
  return { sup, spawned, count, until, dials, lines, probes: () => probes };
}

describe("#256 · BROADCAST_RENDER_READY", () => {
  it("WHITE_FRAME_REGRESSION: display en blanco ⇒ ni ffmpeg ni relé; relanza y acaba en failed con render_not_ready", async () => {
    const h = harness(() => WHITE, { mode: "rtmps" });
    h.sup.start();
    expect(await h.until(() => h.sup.state === "failed")).toBe(true);
    expect(h.count("ffmpeg")).toBe(0);
    expect(h.dials).toHaveLength(0);
    expect(h.count("chromium")).toBe(3); // arranque + maxRetries (2) relanzamientos
    expect(h.sup.lastError?.message).toMatch(/^render_not_ready: .*BLANCO \(luma media 255, desviación 0\)/);
    expect(h.sup.render.blankEvents).toBe(3);
    expect(h.lines.join("\n")).not.toContain("clave-centinela-256");
  });

  it("el negro uniforme del Xvfb vacío tampoco abre la puerta", async () => {
    const h = harness(() => BLACK);
    h.sup.start();
    expect(await h.until(() => h.sup.state === "failed")).toBe(true);
    expect(h.count("ffmpeg")).toBe(0);
    expect(h.sup.lastError?.message).toContain("UNIFORME");
  });

  it(`ffmpeg arranca sólo tras ${RENDER_READY_CONSECUTIVE} frames visibles seguidos (blanco inicial de la ventana incluido)`, async () => {
    // negro (Xvfb vacío), blanco (ventana sin pintar), visible, blanco (parpadeo), visible, visible…
    const seq = [BLACK, WHITE, PAGE, WHITE, PAGE, PAGE];
    const h = harness((n) => seq[n] ?? PAGE);
    h.sup.start();
    expect(h.count("ffmpeg")).toBe(0);
    expect(h.sup.render.state).toBe("waiting");
    expect(await h.until(() => h.count("ffmpeg") === 1)).toBe(true);
    expect(h.probes()).toBe(6); // el visible suelto entre blancos NO basta
    expect(h.sup.render.state).toBe("ready");
    expect(h.sup.render.lastFrame?.verdict).toBe("visible");
    h.sup.stop();
  });

  it(`vigilante: ${RENDER_BLANK_STRIKES} lecturas seguidas en blanco con la emisión en marcha ⇒ corta y relanza`, async () => {
    // listo con 2 visibles; luego el vigilante ve visible, blanco ×3.
    const seq = [PAGE, PAGE, PAGE, WHITE, WHITE, WHITE];
    const h = harness((n) => seq[n] ?? PAGE);
    h.sup.start();
    expect(await h.until(() => h.sup.lastError?.message.startsWith("render_blank") ?? false)).toBe(true);
    expect(h.sup.render.blankEvents).toBe(1);
    // relanzado: segundo Chromium y, tras volver a ver la página, segundo ffmpeg.
    expect(await h.until(() => h.count("chromium") === 2 && h.count("ffmpeg") === 2)).toBe(true);
    h.sup.stop();
  });

  it("stop() durante la espera de render no lanza ffmpeg después", async () => {
    let calls = 0;
    const h = harness(() => (++calls > 3 ? PAGE : WHITE));
    h.sup.start();
    await h.until(() => calls >= 1);
    h.sup.stop();
    await h.until(() => false, 200);
    expect(h.count("ffmpeg")).toBe(0);
    expect(h.sup.render.state).toBe("off");
  });
});
