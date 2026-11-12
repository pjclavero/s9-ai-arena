/**
 * OLA 2 · ME · Xvfb A DEMANDA (Equipo MF). Hoy el Xvfb lo deja corriendo entrypoint.sh
 * durante toda la vida del contenedor; el contrato es que exista SÓLO mientras hay una
 * sesión de emisión. Sin Xvfb/Chromium/FFmpeg reales: procesos falsos por `Spawner`.
 *
 *  - `it` (baseline verde en el BASE_SHA): sin sesión no hay NINGÚN hijo; tras stop(),
 *    todo hijo recibió la señal de parada.
 *  - [CUMPLIDO en G2] al iniciar una sesión el supervisor arranca un `Xvfb` ANTES que el
 *    navegador, y lo para en stop().
 *
 * ADAPTADOR (G2): MF implementó el Xvfb como `DisplayManager` (`XvfbDisplay`, xvfb.ts) que se
 * INYECTA al supervisor (`display`). `makeSupervisor()` lo cablea igual que producción
 * (main.ts) con un `Spawner` falso; las aserciones miden lo observable en ese `Spawner`.
 * Como `display.ensure()` es asíncrono (espera el socket), el arranque se observa tras
 * ceder el turno.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, createLogger } from "../../src/config.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "../../src/supervisor.js";
import { XvfbDisplay } from "../../src/xvfb.js";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  signals: string[] = [];
  constructor(
    public cmd: string,
    public args: string[],
  ) {
    super();
  }
  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM");
    return true;
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeSupervisor() {
  const spawned: FakeProcess[] = [];
  const files = new Set<string>();
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args);
    spawned.push(p);
    // Un Xvfb «real» crea su socket al arrancar.
    if (cmd === "Xvfb") setImmediate(() => files.add("/tmp/.X11-unix/X99"));
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
  const supervisor = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, maxRetries: 3, retryDelayMs: 1 },
    streamKey: "abcd-1234-SECRETA-9999",
    spawner,
    logger: createLogger("abcd-1234-SECRETA-9999", () => {}),
    sleep: async () => {},
    dial: () => new PassThrough(),
    chromiumBin: "chromium-browser",
    ffmpegBin: "ffmpeg",
    display,
  });
  return { supervisor, spawned, display };
}

describe("MF · streamer: ningún hijo sin sesión (baseline)", () => {
  it("un supervisor recién creado no ha lanzado ningún proceso", () => {
    const { spawned } = makeSupervisor();
    expect(spawned).toEqual([]);
  });

  it("tras stop() todo hijo lanzado recibió una señal de parada (Xvfb incluido)", async () => {
    const { supervisor, spawned } = makeSupervisor();
    supervisor.start();
    await tick();
    expect(spawned.length).toBeGreaterThan(0);
    supervisor.stop();
    await tick();
    expect(spawned.filter((p) => p.signals.length === 0).map((p) => p.cmd)).toEqual([]);
  });
});

describe("MF · streamer: Xvfb a demanda", () => {
  it("[contrato MF cumplido · G2] start() arranca Xvfb antes que Chromium y stop() lo para", async () => {
    const { supervisor, spawned } = makeSupervisor();
    supervisor.start();
    await tick();
    const order = spawned.map((p) => p.cmd);
    const xvfb = order.indexOf("Xvfb");
    expect(xvfb, `no se lanzó Xvfb (comandos: ${order.join(", ")})`).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("chromium-browser"), `Chromium no se lanzó (comandos: ${order.join(", ")})`).toBeGreaterThan(
      xvfb,
    );
    supervisor.stop();
    await tick();
    expect(spawned[xvfb]!.signals.length).toBeGreaterThan(0);
  });

  it("[G2] sin sesión no hay Xvfb: el display a demanda no arranca hasta start()", async () => {
    const { spawned, display } = makeSupervisor();
    await tick();
    expect(spawned.filter((p) => p.cmd === "Xvfb")).toEqual([]);
    expect(display.running).toBe(false);
  });
});
