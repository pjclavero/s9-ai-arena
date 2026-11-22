/**
 * OLA2-MF · streamer A DEMANDA: sin emisión activa no queda NINGÚN hijo de
 * emisión (CHROMIUM=0, FFMPEG=0, TEMP_RELAY=0, STREAM_CHILDREN=0) y el Xvfb sólo
 * existe mientras se emite. Procesos falsos (sin Xvfb/Chromium/FFmpeg reales).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG } from "./config.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";
import { XvfbDisplay } from "./xvfb.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  exitCode: number | null = null;
  signals: string[] = [];
  constructor(
    public cmd: string,
    public args: string[],
    private readonly ignoreTerm = false,
  ) {
    super();
  }
  kill(sig?: NodeJS.Signals) {
    this.signals.push(sig ?? "SIGTERM");
    if (this.ignoreTerm && sig !== "SIGKILL") return true;
    if (this.exitCode === null) {
      this.exitCode = 0;
      setImmediate(() => this.emit("exit", 0));
    }
    return true;
  }
  get alive() {
    return this.exitCode === null;
  }
}

function harness(opts: { xvfbIgnoresTerm?: boolean; xvfbNeverReady?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  const files = new Set<string>();
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args, cmd === "Xvfb" && !!opts.xvfbIgnoresTerm);
    spawned.push(p);
    // Un Xvfb «real» crea su socket al arrancar.
    if (cmd === "Xvfb" && !opts.xvfbNeverReady) setImmediate(() => files.add("/tmp/.X11-unix/X99"));
    return p;
  };
  const display = new XvfbDisplay({
    spawner,
    display: ":99",
    width: 1920,
    height: 1080,
    readyTimeoutMs: 200,
    stopGraceMs: 20,
    exists: (p) => files.has(p),
    readFile: () => {
      throw new Error("no existe");
    },
    remove: (p) => void files.delete(p),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", maxRetries: 1, retryDelayMs: 1 },
    streamKey: null,
    spawner,
    logger: createLogger("centinela-mf", () => undefined),
    chromiumBin: "chromium",
    ffmpegBin: "ffmpeg",
    stopGraceMs: 20,
    display,
  });
  const alive = (cmd: string) => spawned.filter((p) => p.cmd === cmd && p.alive).length;
  return { sup, display, spawned, files, alive };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("OLA2-MF · Xvfb y procesos de emisión a demanda", () => {
  it("en idle no hay ningún hijo de emisión ni Xvfb", () => {
    const h = harness();
    expect(h.spawned).toEqual([]);
    expect(h.sup.streamChildren).toEqual({ chromium: 0, ffmpeg: 0, relay: 0, xvfb: 0, terminating: 0 });
  });

  it("start: el Xvfb arranca ANTES que Chromium; stop: Xvfb, Chromium y FFmpeg terminan", async () => {
    const h = harness();
    h.sup.start();
    await tick();
    expect(h.spawned.map((p) => p.cmd)).toEqual(["Xvfb", "chromium", "ffmpeg"]);
    expect(h.sup.streamChildren).toMatchObject({ chromium: 1, ffmpeg: 1, xvfb: 1 });
    h.sup.stop();
    await tick(80);
    expect([h.alive("Xvfb"), h.alive("chromium"), h.alive("ffmpeg")]).toEqual([0, 0, 0]);
    expect(h.sup.streamChildren).toEqual({ chromium: 0, ffmpeg: 0, relay: 0, xvfb: 0, terminating: 0 });
  });

  it("emisión agotada (failed) libera también el Xvfb", async () => {
    const h = harness();
    h.sup.start();
    await tick();
    // ffmpeg muere una y otra vez: maxRetries=1 ⇒ failed.
    for (let i = 0; i < 3; i++) {
      for (const p of h.spawned.filter((x) => x.cmd === "ffmpeg" && x.alive)) {
        p.exitCode = 1;
        p.emit("exit", 1);
      }
      await tick();
    }
    expect(h.sup.state).toBe("failed");
    await tick(80);
    expect(h.alive("Xvfb")).toBe(0);
  });

  it("un Xvfb que ignora TERM recibe SIGKILL tras la gracia", async () => {
    const h = harness({ xvfbIgnoresTerm: true });
    h.sup.start();
    await tick();
    h.sup.stop();
    await tick(80);
    const x = h.spawned.find((p) => p.cmd === "Xvfb")!;
    expect(x.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.display.stats.killed).toBe(1);
  });

  it("Xvfb que no crea su socket → no se lanza Chromium (fallo cerrado) y no queda vivo", async () => {
    const h = harness({ xvfbNeverReady: true });
    h.sup.start();
    await tick(400);
    expect(h.spawned.filter((p) => p.cmd === "chromium")).toEqual([]);
    h.sup.stop();
    await tick(80);
    expect(h.alive("Xvfb")).toBe(0);
  });

  it("#251 · un lock rancio (pid sin Xvfb) se limpia antes de arrancar", async () => {
    const h = harness();
    h.files.add("/tmp/.X99-lock");
    h.files.add("/tmp/.X11-unix/X99");
    await h.display.ensure();
    expect(h.files.has("/tmp/.X99-lock")).toBe(false);
    h.display.release();
  });

  it("carrera stop→start: ensure() espera a que muera el Xvfb anterior (su lock sigue vivo) en vez de rechazar", async () => {
    // Modelo realista: el Xvfb viejo sigue en /proc (comm=Xvfb) con su lock hasta que SALE (40 ms tras el TERM).
    const spawned: FakeProcess[] = [];
    const files = new Set<string>();
    const alivePids = new Set<string>();
    let nextPid = 100;
    const spawner: Spawner = (cmd, args) => {
      const p = new FakeProcess(cmd, args);
      const pid = String(nextPid++);
      alivePids.add(pid);
      files.add("/tmp/.X99-lock");
      files.add("/tmp/.X11-unix/X99");
      (p as any).pidStr = pid;
      p.kill = (sig?: NodeJS.Signals) => {
        p.signals.push(sig ?? "SIGTERM");
        if (p.exitCode === null) {
          p.exitCode = 0;
          setTimeout(() => {
            alivePids.delete(pid);
            files.delete("/tmp/.X99-lock");
            files.delete("/tmp/.X11-unix/X99");
            p.emit("exit", 0);
          }, 40);
        }
        return true;
      };
      spawned.push(p);
      return p;
    };
    const display = new XvfbDisplay({
      spawner,
      display: ":99",
      width: 1920,
      height: 1080,
      readyTimeoutMs: 500,
      stopGraceMs: 500,
      exists: (p) => files.has(p),
      readFile: (p) => {
        if (p === "/tmp/.X99-lock") return `${[...alivePids].at(-1) ?? "0"}\n`;
        const m = /^\/proc\/(\d+)\/comm$/.exec(p);
        if (m && alivePids.has(m[1])) return "Xvfb\n";
        throw new Error("no existe");
      },
      remove: (p) => void files.delete(p),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    });
    await display.ensure();
    display.release();
    await display.ensure(); // inmediatamente: antes fallaba con «ya lo usa un Xvfb vivo ajeno»
    expect(display.running).toBe(true);
    expect(display.stats.starts).toBe(2);
    expect(spawned.filter((p) => p.alive)).toHaveLength(1);
    display.release();
    await tick(80);
  });
});

// D-OP-32 · ausencia de procesos abandonados al reiniciar, reintentar o parar la emisión.
// Reutiliza el harness de arriba (procesos falsos, sin Chromium/FFmpeg/Xvfb reales); la
// prueba con procesos REALES de STOP está en streamer-real.test.ts (NO_ORPHAN_PROCESS).
describe("D-OP-32 · reinicio, reintentos y paradas repetidas no dejan Chromium ni ffmpeg huérfanos", () => {
  const liveStream = (h: ReturnType<typeof harness>) => ({
    chromium: h.alive("chromium"),
    ffmpeg: h.alive("ffmpeg"),
  });

  it("SR-1: reiniciar la emisión (start sobre una emisión en marcha) termina Chromium y ffmpeg anteriores", async () => {
    const h = harness();
    h.sup.start();
    await tick();
    const first = h.spawned.filter((p) => p.cmd === "chromium" || p.cmd === "ffmpeg");
    expect(first).toHaveLength(2);
    h.sup.start(); // reinicio: nueva sesión sobre la misma instancia
    await tick(80);
    expect(
      first.every((p) => !p.alive),
      "los procesos de la emisión anterior siguen vivos",
    ).toBe(true);
    expect(liveStream(h)).toEqual({ chromium: 1, ffmpeg: 1 });
    h.sup.stop();
    await tick(80);
    expect(liveStream(h)).toEqual({ chromium: 0, ffmpeg: 0 });
    expect(h.sup.streamChildren).toEqual({ chromium: 0, ffmpeg: 0, relay: 0, xvfb: 0, terminating: 0 });
  });

  it("SR-2: 6 ciclos start/stop seguidos acaban con 0 procesos de emisión vivos y sin ficheros del display", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.sup.start();
      await tick(40);
      h.sup.stop();
      await tick(60);
    }
    expect(h.spawned.length).toBeGreaterThanOrEqual(6); // al menos el Xvfb de cada ciclo
    expect(h.spawned.filter((p) => p.alive)).toEqual([]);
    expect(h.sup.streamChildren).toEqual({ chromium: 0, ffmpeg: 0, relay: 0, xvfb: 0, terminating: 0 });
    expect([...h.files].filter((f) => f.includes("-lock"))).toEqual([]);
  });

  it("SR-3: caídas repetidas de ffmpeg (reintentos) no acumulan Chromium: nunca más de uno vivo y 0 tras parar", async () => {
    const h = harness();
    h.sup.start();
    await tick();
    let maxChromium = 0;
    for (let i = 0; i < 4; i++) {
      for (const p of h.spawned.filter((x) => x.cmd === "ffmpeg" && x.alive)) {
        p.exitCode = 1;
        p.emit("exit", 1);
      }
      await tick(40);
      maxChromium = Math.max(maxChromium, h.alive("chromium"));
    }
    expect(maxChromium).toBeLessThanOrEqual(1);
    h.sup.stop();
    await tick(100);
    expect(liveStream(h)).toEqual({ chromium: 0, ffmpeg: 0 });
    expect(h.alive("Xvfb")).toBe(0);
  });
});
