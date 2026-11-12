/**
 * OLA 2 · ME · Xvfb A DEMANDA (Equipo MF). Hoy el Xvfb lo deja corriendo entrypoint.sh
 * durante toda la vida del contenedor; el contrato es que exista SÓLO mientras hay una
 * sesión de emisión. Sin Xvfb/Chromium/FFmpeg reales: procesos falsos por `Spawner`.
 *
 *  - `it` (baseline verde en el BASE_SHA): sin sesión no hay NINGÚN hijo; tras stop(),
 *    todo hijo recibió la señal de parada.
 *  - `contractIt("MF")` (rojo): al iniciar una sesión el supervisor arranca un `Xvfb`
 *    ANTES que el navegador, y lo para en stop().
 *
 * ADAPTADOR: mientras MF no fije el cableado del Xvfb, el contrato se mide por lo
 * observable en el `Spawner` del supervisor (comando `Xvfb`). Si MF lo inyecta de otra
 * forma (p. ej. `XvfbDisplay` propio), adapta SÓLO `makeSupervisor()`.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, createLogger } from "../../src/config.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "../../src/supervisor.js";
import { contractIt } from "../../../../packages/test-contracts/contract-it.js";

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

function makeSupervisor() {
  const spawned: FakeProcess[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args);
    spawned.push(p);
    return p;
  };
  const supervisor = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, maxRetries: 3, retryDelayMs: 1 },
    streamKey: "abcd-1234-SECRETA-9999",
    spawner,
    logger: createLogger("abcd-1234-SECRETA-9999", () => {}),
    sleep: async () => {},
    dial: () => new PassThrough(),
    chromiumBin: "chromium-browser",
    ffmpegBin: "ffmpeg",
  });
  return { supervisor, spawned };
}

describe("MF · streamer: ningún hijo sin sesión (baseline)", () => {
  it("un supervisor recién creado no ha lanzado ningún proceso", () => {
    const { spawned } = makeSupervisor();
    expect(spawned).toEqual([]);
  });

  it("tras stop() todo hijo lanzado recibió una señal de parada", () => {
    const { supervisor, spawned } = makeSupervisor();
    supervisor.start();
    expect(spawned.length).toBeGreaterThan(0);
    supervisor.stop();
    expect(spawned.filter((p) => p.signals.length === 0).map((p) => p.cmd)).toEqual([]);
  });
});

describe("MF · streamer: Xvfb a demanda", () => {
  contractIt("MF", "start() arranca Xvfb antes que Chromium y stop() lo para", () => {
    const { supervisor, spawned } = makeSupervisor();
    supervisor.start();
    const order = spawned.map((p) => p.cmd);
    const xvfb = order.indexOf("Xvfb");
    expect(xvfb, `no se lanzó Xvfb (comandos: ${order.join(", ")})`).toBeGreaterThanOrEqual(0);
    expect(xvfb).toBeLessThan(order.indexOf("chromium-browser"));
    supervisor.stop();
    expect(spawned[xvfb]!.signals.length).toBeGreaterThan(0);
  });
});
