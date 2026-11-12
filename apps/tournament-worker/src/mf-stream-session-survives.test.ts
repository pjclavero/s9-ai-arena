/**
 * OLA2-MF · CONTRATO con MS: BATTLE_FINISHED != STREAM_SESSION_FINISHED.
 *
 * El cleanup de una batalla (teardown único y reaper) SOLO libera los recursos del
 * ítem de batalla (contenedores de bot, sandbox host, protocol server, feed del
 * espectador...). Una sesión de streaming ACTIVA (publisher RTMP/relé, FFmpeg,
 * Chromium principal, Xvfb) sigue viva hasta su propio cierre. Procesos falsos.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG } from "../../streamer/src/config.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "../../streamer/src/supervisor.js";
import { XvfbDisplay } from "../../streamer/src/xvfb.js";
import { BATTLE_END_REASONS, BattleResourceRegistry } from "./battle-resources.js";
import { reapOnce } from "./battle-reaper.js";
import { LABEL_ROLE, ROLE_BATTLE_BOT, type ManagedContainer } from "../../bot-manager/src/container-runner.js";

class Fake extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  exitCode: number | null = null;
  signals: string[] = [];
  constructor(public cmd: string) {
    super();
  }
  kill(sig?: NodeJS.Signals) {
    this.signals.push(sig ?? "SIGTERM");
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

function liveSession() {
  const spawned: Fake[] = [];
  const files = new Set<string>();
  const spawner: Spawner = (cmd) => {
    const p = new Fake(cmd);
    spawned.push(p);
    if (cmd === "Xvfb") setImmediate(() => files.add("/tmp/.X11-unix/X99"));
    return p;
  };
  const display = new XvfbDisplay({
    spawner, display: ":99", width: 1920, height: 1080, readyTimeoutMs: 200, stopGraceMs: 20,
    exists: (p) => files.has(p), readFile: () => { throw new Error("no existe"); },
    remove: (p) => void files.delete(p), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", maxRetries: 1, retryDelayMs: 1 },
    streamKey: null, spawner, logger: createLogger("centinela-mf", () => undefined),
    chromiumBin: "chromium", ffmpegBin: "ffmpeg", stopGraceMs: 20, display,
  });
  const alive = (cmd: string) => spawned.filter((p) => p.cmd === cmd && p.alive).length;
  return { sup, spawned, alive };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("OLA2-MF · una sesión de streaming activa sobrevive al cleanup de la batalla", () => {
  for (const reason of BATTLE_END_REASONS) {
    it(`cleanup (${reason}) libera el ítem de batalla y NO toca Chromium, FFmpeg ni Xvfb`, async () => {
      const s = liveSession();
      s.sup.start();
      await tick();
      expect(s.sup.streamChildren).toMatchObject({ chromium: 1, ffmpeg: 1, xvfb: 1 });
      const signalsBefore = s.spawned.map((p) => p.signals.length);

      const res = new BattleResourceRegistry();
      const released: string[] = [];
      for (const kind of ["protocol_server", "container:veh_1", "container_remove:veh_1", "sandbox_host"]) {
        res.register("b-live", { kind, phase: kind.startsWith("container") ? "containers" : "terminate", release: () => void released.push(kind) });
      }
      const rep = await res.cleanupBattleResources("b-live", reason);
      expect(released.sort()).toEqual(["container:veh_1", "container_remove:veh_1", "protocol_server", "sandbox_host"]);
      expect(rep.remaining).toEqual([]);

      await tick(80);
      expect([s.alive("Xvfb"), s.alive("chromium"), s.alive("ffmpeg")]).toEqual([1, 1, 1]);
      expect(s.spawned.map((p) => p.signals.length)).toEqual(signalsBefore);
      expect(s.sup.state).not.toBe("failed");
      expect(s.sup.streamChildren).toMatchObject({ chromium: 1, ffmpeg: 1, xvfb: 1, terminating: 0 });

      // Sólo su propio cierre (stop de la sesión) la termina.
      s.sup.stop();
      await tick(80);
      expect([s.alive("Xvfb"), s.alive("chromium"), s.alive("ffmpeg")]).toEqual([0, 0, 0]);
    });
  }

  it("el reaper nunca pide borrar contenedores ajenos a las batallas (streamer) y la sesión sigue viva", async () => {
    const s = liveSession();
    s.sup.start();
    await tick();
    const streamerCt: ManagedContainer = { id: "streamer0000000000", state: "running", createdAtMs: 0, labels: { [LABEL_ROLE]: "streamer" } } as ManagedContainer;
    const asked: Record<string, string>[] = [];
    const removed: string[] = [];
    const db = (() => { throw new Error("la BD no debe consultarse sin contenedores de batalla"); }) as unknown as Knex;
    const r = await reapOnce({
      db,
      resources: new BattleResourceRegistry(),
      runner: {
        // como el proxy: el filtro de labels es obligatorio y se respeta.
        async list(labels) {
          asked.push(labels);
          return [streamerCt].filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v));
        },
        async removeById(id) { removed.push(id); },
      },
      now: () => 10 ** 12,
    });
    expect(asked).toEqual([{ [LABEL_ROLE]: ROLE_BATTLE_BOT }]);
    expect(removed).toEqual([]);
    expect(r.removed).toEqual([]);
    await tick(60);
    expect([s.alive("Xvfb"), s.alive("chromium"), s.alive("ffmpeg")]).toEqual([1, 1, 1]);
    s.sup.stop();
    await tick(80);
  });
});
