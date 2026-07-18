/**
 * T11.2 · Tests del streamer SIN Chromium/FFmpeg reales (no hay navegador ni
 * docker en este entorno): procesos hijos falsos inyectados por `Spawner`.
 * Cubren: secreto por archivo y redacción total (la clave jamás en logs,
 * argv loggable, /status ni /metrics), líneas de comando x264/nvenc/record,
 * parser de progreso → métricas Prometheus, reintentos ante corte RTMPS
 * (test de caos con corte largo) y la API interna start/stop.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  createLogger,
  loadConfig,
  loadStreamKey,
  redactSecret,
  type StreamerConfig,
} from "./config.js";
import { buildChromiumArgs, buildFfmpegArgs, redactArgs } from "./ffmpeg.js";
import { ProgressParser, renderPrometheus } from "./metrics.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";
import { createControlServer } from "./control.js";

const KEY = "abcd-1234-SECRETA-9999";

const cfg = (over: Partial<StreamerConfig> = {}): StreamerConfig => ({
  ...DEFAULT_CONFIG,
  maxRetries: 3,
  retryDelayMs: 1,
  ...over,
});

// ───────────────────────────────────────────── procesos hijos falsos

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string | null = null;
  constructor(
    public cmd: string,
    public args: string[],
  ) {
    super();
  }
  kill(signal?: string) {
    this.killed = signal ?? "SIGTERM";
    return true;
  }
  /** El "ffmpeg" falso informa progreso como el real: bloques clave=valor. */
  reportProgress(frames: number, bitrate: number) {
    this.stdout.emit(
      "data",
      `frame=${frames}\nfps=30.0\nbitrate=${bitrate}kbits/s\nout_time_us=${frames * 33333}\ndrop_frames=0\nprogress=continue\n`,
    );
  }
}

function fakeSpawner() {
  const spawned: FakeProcess[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args);
    spawned.push(p);
    return p;
  };
  const last = (cmd: string) => [...spawned].reverse().find((p) => p.cmd.includes(cmd))!;
  return { spawner, spawned, last };
}

const silentLogger = (lines: string[]) => createLogger(KEY, (l) => lines.push(l));

// ─────────────────────────────────────────────────────── configuración/secreto

describe("T11.2 secreto por archivo y redacción", () => {
  it("la clave entra SOLO por STREAM_KEY_FILE y nunca por variable", () => {
    const key = loadStreamKey(
      { STREAM_KEY_FILE: "/run/secrets/stream_key" },
      ((f: string) => {
        expect(f).toBe("/run/secrets/stream_key");
        return `${KEY}\n`;
      }) as any,
      "rtmps",
    );
    expect(key).toBe(KEY);
    // Sin archivo o vacío en modo rtmps: error claro, no emisión sin clave.
    expect(() => loadStreamKey({}, (() => "") as any, "rtmps")).toThrow(/STREAM_KEY_FILE/);
    expect(() => loadStreamKey({ STREAM_KEY_FILE: "/x" }, (() => "") as any, "rtmps")).toThrow(/vacío/);
    // En modo record no hace falta clave (E11.M).
    expect(loadStreamKey({ STREAM_KEY_FILE: "/x" }, (() => "") as any, "record")).toBeNull();
  });

  it("la config es loggable: no contiene la clave; redactSecret la tapa en texto", () => {
    const config = loadConfig({ BROADCAST_URL: "http://web:3000/broadcast?tournament=t1", STREAM_ENCODER: "nvenc" });
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(config.encoder).toBe("nvenc");
    expect(redactSecret(`url rtmps://x/${KEY} fin`, KEY)).toBe("url rtmps://x/*** fin");
  });

  it("el logger redacta la clave en TODO lo que escribe (revisión automatizada)", () => {
    const lines: string[] = [];
    const log = silentLogger(lines);
    log("error", `ffmpeg falló abriendo rtmps://a.rtmps.youtube.com/live2/${KEY}`, {
      argv: `-i x -f flv rtmps://y/${KEY}`,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(KEY);
    expect(lines[0]).toContain("***");
  });
});

// ─────────────────────────────────────────────────────── líneas de comando

describe("T11.2 líneas de comando", () => {
  it("x264 por software es la base; nvenc solo como opción (GPU passthrough)", () => {
    const base = buildFfmpegArgs(cfg(), KEY);
    expect(base.args).toContain("libx264");
    expect(base.args.join(" ")).toContain("-tune zerolatency");
    const nv = buildFfmpegArgs(cfg({ encoder: "nvenc" }), KEY);
    expect(nv.args).toContain("h264_nvenc");
  });

  it("emite a RTMPS con la clave SOLO en el argv, y el destino descrito va redactado", () => {
    const plan = buildFfmpegArgs(cfg(), KEY);
    expect(plan.args[plan.args.length - 1]).toBe(`rtmps://a.rtmps.youtube.com/live2/${KEY}`);
    expect(plan.describeTarget).toBe("rtmps://a.rtmps.youtube.com/live2/***");
    expect(redactArgs(plan.args, KEY).join(" ")).not.toContain(KEY);
    // Captura del Xvfb + audio de silencio (YouTube exige pista de audio) + progreso
    const s = plan.args.join(" ");
    expect(s).toContain("x11grab");
    expect(s).toContain("1920x1080");
    expect(s).toContain("anullsrc");
    expect(s).toContain("-progress pipe:1");
  });

  it("modo 'solo grabación' (E11.M): archivo mp4 en arena_replays/video, sin clave", () => {
    const plan = buildFfmpegArgs(cfg({ mode: "record" }), null, () => new Date("2026-07-16T12:00:00Z"));
    expect(plan.args[plan.args.length - 1]).toBe("/data/replays/video/broadcast-2026-07-16T12-00-00-000Z.mp4");
    expect(plan.args.join(" ")).not.toContain("rtmps://");
    // rtmps sin clave: prohibido
    expect(() => buildFfmpegArgs(cfg(), null)).toThrow(/clave/);
  });

  it("chromium en kiosco sobre la vista /broadcast, tamaño exacto de emisión", () => {
    const args = buildChromiumArgs(cfg(), "http://web:3000/broadcast?tournament=t1");
    expect(args).toContain("--kiosk");
    expect(args).toContain("--window-size=1920,1080");
    expect(args[args.length - 1]).toBe("--app=http://web:3000/broadcast?tournament=t1");
  });
});

// ───────────────────────────────────────────────────────────── métricas

describe("T11.2 métricas de frames/bitrate para E10", () => {
  it("parsea el -progress de ffmpeg aunque llegue troceado", () => {
    const p = new ProgressParser();
    p.push("frame=90\nfps=30.0\nbitr");
    p.push("ate=4499.8kbits/s\nout_time_us=3000000\ndrop_frames=2\nprogress=continue\n");
    expect(p.snapshot()).toMatchObject({
      frames: 90,
      fps: 30,
      bitrateKbps: 4499.8,
      outTimeSeconds: 3,
      droppedFrames: 2,
      reporting: true,
    });
  });

  it("expone Prometheus con up/frames/bitrate/reintentos", () => {
    const p = new ProgressParser();
    p.push("frame=100\nfps=30.0\nbitrate=4500.0kbits/s\nprogress=continue\n");
    const text = renderPrometheus({ state: "streaming", restarts: 2, stats: p.snapshot() });
    expect(text).toContain("streamer_up 1");
    expect(text).toContain("streamer_frames_total 100");
    expect(text).toContain("streamer_bitrate_kbps 4500");
    expect(text).toContain("streamer_restarts_total 2");
    // Sin emisión activa, up=0 (alerta de E10)
    expect(renderPrometheus({ state: "stopped", restarts: 2, stats: p.snapshot() })).toContain("streamer_up 0");
  });
});

// ─────────────────────────────────────────────────────────── supervisor

describe("T11.2 supervisor: reintentos ante corte de RTMPS (caos)", () => {
  function makeSupervisor(over: Partial<StreamerConfig> = {}) {
    const { spawner, spawned, last } = fakeSpawner();
    const lines: string[] = [];
    const supervisor = new StreamSupervisor({
      config: cfg(over),
      streamKey: KEY,
      spawner,
      logger: silentLogger(lines),
      sleep: async () => {}, // sin relojes reales en tests
      chromiumBin: "chromium-browser",
      ffmpegBin: "ffmpeg",
    });
    return { supervisor, spawned, last, lines };
  }

  const settle = () => new Promise<void>((r) => setImmediate(r));

  it("arranca chromium + ffmpeg y pasa a streaming", () => {
    const { supervisor, spawned } = makeSupervisor();
    supervisor.start();
    expect(supervisor.state).toBe("streaming");
    expect(spawned.map((p) => p.cmd)).toEqual(["chromium-browser", "ffmpeg"]);
  });

  it("corte de RTMPS: ffmpeg muere y se relanza solo; el progreso posterior salda el corte", async () => {
    const { supervisor, spawned, last } = makeSupervisor();
    supervisor.start();
    last("ffmpeg").reportProgress(300, 4500);

    // Corte de red: ffmpeg muere. (Un corte de 30 s son varios ciclos así.)
    last("ffmpeg").emit("exit", 1);
    await settle();
    expect(supervisor.state).toBe("streaming");
    expect(supervisor.restarts).toBe(1);
    expect(spawned.filter((p) => p.cmd === "ffmpeg")).toHaveLength(2);

    // Vuelve la red: progreso de nuevo ⇒ contador de intentos saldado.
    last("ffmpeg").reportProgress(600, 4500);
    last("ffmpeg").emit("exit", 1); // otro corte más tarde: sigue reintentando
    await settle();
    expect(supervisor.state).toBe("streaming");
  });

  it("reintentos agotados sin progreso ⇒ failed (y no spawnea más)", async () => {
    const { supervisor, spawned, last } = makeSupervisor({ maxRetries: 2 });
    supervisor.start();
    for (let i = 0; i < 3; i++) {
      last("ffmpeg").emit("exit", 1);
      await settle();
    }
    expect(supervisor.state).toBe("failed");
    const count = spawned.filter((p) => p.cmd === "ffmpeg").length;
    last("ffmpeg").emit("exit", 1); // ya no hay generación viva
    await settle();
    expect(spawned.filter((p) => p.cmd === "ffmpeg")).toHaveLength(count);
  });

  it("la muerte de ffmpeg NO duplica reintentos por el exit del chromium que matamos", async () => {
    const { supervisor, spawned, last } = makeSupervisor();
    supervisor.start();
    const chromium = last("chromium-browser");
    last("ffmpeg").emit("exit", 1);
    chromium.emit("exit", 0); // consecuencia del kill del reintento
    await settle();
    expect(supervisor.restarts).toBe(1);
    expect(spawned.filter((p) => p.cmd === "ffmpeg")).toHaveLength(2);
  });

  it("stop() para ambos procesos y no reintenta", async () => {
    const { supervisor, last } = makeSupervisor();
    supervisor.start();
    const ff = last("ffmpeg");
    const ch = last("chromium-browser");
    supervisor.stop();
    expect(ff.killed).toBe("SIGTERM");
    expect(ch.killed).toBe("SIGTERM");
    ff.emit("exit", 0);
    await settle();
    expect(supervisor.state).toBe("stopped");
    expect(supervisor.restarts).toBe(0);
  });

  it("la clave no aparece en NINGUNA línea de log del ciclo completo", async () => {
    const { supervisor, last, lines } = makeSupervisor();
    supervisor.start();
    last("ffmpeg").stderr.emit("data", `Failed to open rtmps://a.rtmps.youtube.com/live2/${KEY}: timeout`);
    last("ffmpeg").emit("exit", 1);
    await settle();
    supervisor.stop();
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l).not.toContain(KEY);
  });
});

// ───────────────────────────────────────────────────── API interna de control

describe("T11.2 API de control (start/stop/status/metrics)", () => {
  async function withServer(fn: (base: string, sup: StreamSupervisor, lines: string[]) => Promise<void>) {
    const { spawner } = fakeSpawner();
    const lines: string[] = [];
    const config = cfg();
    const supervisor = new StreamSupervisor({
      config,
      streamKey: KEY,
      spawner,
      logger: silentLogger(lines),
      sleep: async () => {},
    });
    const server = createControlServer({ supervisor, config, logger: silentLogger(lines) });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${addr.port}`, supervisor, lines);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  it("start sobre una URL de broadcast, status y stop", async () => {
    await withServer(async (base, sup) => {
      const start = await fetch(`${base}/control/start`, {
        method: "POST",
        body: JSON.stringify({ broadcastUrl: "http://web:3000/broadcast?battle=b1" }),
      });
      expect(start.status).toBe(200);
      expect(await start.json()).toEqual({ state: "streaming", broadcastUrl: "http://web:3000/broadcast?battle=b1" });

      const status = await (await fetch(`${base}/status`)).json();
      expect(status.state).toBe("streaming");
      expect(status.broadcastUrl).toBe("http://web:3000/broadcast?battle=b1");

      const stop = await fetch(`${base}/control/stop`, { method: "POST" });
      expect((await stop.json()).state).toBe("stopped");
      expect(sup.state).toBe("stopped");
    });
  });

  it("valida la URL de broadcast (nada de file:// ni basura)", async () => {
    await withServer(async (base) => {
      const bad = await fetch(`${base}/control/start`, {
        method: "POST",
        body: JSON.stringify({ broadcastUrl: "file:///etc/passwd" }),
      });
      expect(bad.status).toBe(400);
    });
  });

  it("ni /status ni /metrics ni /healthz filtran la clave (revisión automatizada)", async () => {
    await withServer(async (base) => {
      await fetch(`${base}/control/start`, { method: "POST" });
      for (const path of ["/status", "/metrics", "/healthz"]) {
        const text = await (await fetch(`${base}${path}`)).text();
        expect(text, `${path} no debe contener la clave`).not.toContain(KEY);
      }
      const status = await (await fetch(`${base}/status`)).json();
      expect(status.target).toBe("rtmps://a.rtmps.youtube.com/live2/***");
    });
  });

  it("/metrics sirve Prometheus para el scrape de E10", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("streamer_up 0"); // parado: la alerta de E10 tiene señal
      expect(text).toContain("streamer_restarts_total 0");
    });
  });
});
