/**
 * REVISIÓN INDEPENDIENTE de #242 (STREAMER real) · pruebas de rotura del lado
 * streamer. NO MERGEAR: van en `review/streamer-242`.
 *
 * Convención: `DEFECTO` afirma el comportamiento CORRECTO (rojo mientras el
 * defecto exista); `OBS` documenta un límite medido (verde mientras siga así);
 * `CONTROL` fija lo que ya funciona y calibra el arnés (si un CONTROL se pone
 * rojo, el arnés no mide lo que dice).
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, SecretRegistry, type StreamerConfig } from "./config.js";
import { createControlServer } from "./control.js";
import { realSpawner } from "./main.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number) => randomBytes(4).readUInt32BE(0) % n;

// ── arnés con procesos falsos (cuenta procesos VIVOS) ────────────────────────
class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  exitCode: number | null = null;
  constructor(public cmd: string) {
    super();
  }
  kill(sig?: NodeJS.Signals) {
    if (this.exitCode === null) {
      this.exitCode = sig === "SIGKILL" ? 137 : 143;
      setImmediate(() => this.emit("exit", this.exitCode));
    }
    return true;
  }
}

function harness(over: Partial<StreamerConfig> = {}, sleepFn?: (ms: number) => Promise<void>) {
  const spawned: FakeProcess[] = [];
  let maxLive = 0;
  const live = () => spawned.filter((p) => p.exitCode === null);
  const spawner: Spawner = (cmd) => {
    const p = new FakeProcess(cmd);
    spawned.push(p);
    maxLive = Math.max(maxLive, live().length);
    return p;
  };
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config: StreamerConfig = { ...DEFAULT_CONFIG, retryDelayMs: 1, mode: "record", ...over };
  const sup = new StreamSupervisor({
    config,
    spawner,
    logger,
    secrets,
    sleep: sleepFn ?? (async () => {}),
    dial: () => new PassThrough(),
    stopGraceMs: 20,
  });
  return {
    sup,
    spawned,
    lines,
    config,
    logger,
    live,
    get maxLive() {
      return maxLive;
    },
  };
}

async function withControl(
  h: ReturnType<typeof harness>,
  fn: (call: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>,
) {
  const server = createControlServer({ supervisor: h.sup, config: h.config, logger: h.logger, capabilities: { nvenc: false } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await r.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { text };
    }
    return { status: r.status, body: parsed };
  };
  try {
    await fn(call);
  } finally {
    h.sup.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const recordStart = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  mode: "record",
  encoder: "x264",
  preset: "1080p",
  fps: 30,
  videoBitrateKbps: 4500,
  ...extra,
});

describe("R242 · §36 dos streams a la vez (API de control real, procesos falsos)", () => {
  it("CONTROL · 40 START simultáneos de sesiones distintas ⇒ exactamente 1 aceptado, 39 × 409 already_active, nunca más de 1 ffmpeg + 1 chromium vivos", async () => {
    const h = harness();
    await withControl(h, async (call) => {
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => call("POST", "/control/start", recordStart(`s${i}`))));
      const ok = rs.filter((r) => r.status === 200);
      expect(ok).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.error === "already_active")).toHaveLength(39);
      expect(h.maxLive).toBeLessThanOrEqual(2);
      expect(h.live()).toHaveLength(2);
    });
  });

  it("CONTROL · 300 rondas aleatorias de START‖STOP‖START(replace)‖stop{ifSession}: nunca > 2 procesos vivos y al final 0 vivos", async () => {
    const h = harness();
    await withControl(h, async (call) => {
      for (let i = 0; i < 300; i++) {
        const ops = Array.from({ length: 3 + rnd(3) }, () => {
          const k = rnd(4);
          const sid = `s${rnd(5)}`;
          if (k === 0) return call("POST", "/control/start", recordStart(sid));
          if (k === 1) return call("POST", "/control/start", recordStart(sid, { replace: true }));
          if (k === 2) return call("POST", "/control/stop", {});
          return call("POST", "/control/stop", { ifSession: sid });
        });
        const rs = await Promise.all(ops);
        expect(rs.every((r) => [200, 409].includes(r.status))).toBe(true);
        await sleep(0);
        expect(h.live().length).toBeLessThanOrEqual(2);
      }
      await call("POST", "/control/stop", {});
      await sleep(30);
      expect(h.live()).toHaveLength(0);
      expect(h.maxLive).toBeLessThanOrEqual(2);
    });
  }, 60_000);

  it("CONTROL · stop() durante la espera de un reintento: al despertar NO relanza nada", async () => {
    let release!: () => void;
    const gate = () => new Promise<void>((r) => (release = r));
    const h = harness({}, gate);
    h.sup.start();
    const spawnedBefore = h.spawned.length;
    h.spawned.at(-1)!.emit("exit", 1); // ffmpeg cae ⇒ retrying (espera bloqueada)
    await sleep(5);
    expect(h.sup.state).toBe("retrying");
    h.sup.stop();
    release();
    await sleep(20);
    expect(h.spawned.length).toBe(spawnedBefore);
    expect(h.sup.state).toBe("stopped");
    expect(h.live()).toHaveLength(0);
  });

  it("CONTROL · START(B, replace) durante la espera de un reintento de A: al despertar sólo emite B (2 procesos)", async () => {
    let release!: () => void;
    const gate = () => new Promise<void>((r) => (release = r));
    const h = harness({}, gate);
    await withControl(h, async (call) => {
      expect((await call("POST", "/control/start", recordStart("A"))).status).toBe(200);
      h.spawned.at(-1)!.emit("exit", 1);
      await sleep(5);
      expect(h.sup.state).toBe("retrying");
      // retrying cuenta como activa: sin replace ⇒ 409
      expect((await call("POST", "/control/start", recordStart("B"))).status).toBe(409);
      expect((await call("POST", "/control/start", recordStart("B", { replace: true }))).status).toBe(200);
      release();
      await sleep(20);
      expect(h.live()).toHaveLength(2);
      expect(h.sup.currentSessionId).toBe("B");
      // el stop condicionado a A (reconciliador tardío) no corta B
      expect((await call("POST", "/control/stop", { ifSession: "A" })).status).toBe(409);
      expect(h.sup.state).toBe("streaming");
    });
  });
});

// ── procesos REALES ─────────────────────────────────────────────────────────
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false;
  }
};

function script(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function realSup(dir: string, chromiumBin: string, ffmpegBin: string, over: Partial<StreamerConfig> = {}) {
  const lines: string[] = [];
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", recordDir: dir, retryDelayMs: 50, maxRetries: 50, ...over },
    spawner: realSpawner,
    logger: createLogger(null, (l) => lines.push(l)),
    processTree: true,
    stopGraceMs: 300,
    chromiumBin,
    ffmpegBin,
  });
  return { sup, lines };
}

describe("R242 · §20 la salida de Chromium no se consume (pipe sin lector)", () => {
  // Chromium se lanza con stdout/stderr en `pipe` (realSpawner) y el supervisor
  // NO lee esos pipes (sólo los de ffmpeg). Un proceso que escribe más de lo
  // que cabe en el pipe + el búfer de Node se BLOQUEA en write(2).
  for (const [label, bytes, expectBlocked] of [
    ["CONTROL (calibración) · 4 KiB a stderr: el «chromium» sigue vivo y avanza", 4096, false],
    ["DEFECTO P3 · 1 MiB a stderr: el «chromium» se queda BLOQUEADO en write() y deja de avanzar (latente: Chromium real escribió ~15 KB al arrancar y 0 B en los 90 s siguientes)", 1024 * 1024, true],
  ] as const) {
    it(label, async () => {
      const dir = mkdtempSync(join(tmpdir(), "s9-r242-pipe-"));
      const marker = join(dir, "avanzo");
      const chromium = script(dir, "chromium.sh", `head -c ${bytes} /dev/zero | tr '\\0' 'x' >&2\ntouch ${marker}\nexec sleep 300`);
      const ffmpeg = script(dir, "ffmpeg.sh", "exec sleep 300");
      const { sup } = realSup(dir, chromium, ffmpeg);
      sup.start();
      for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(20);
      const advanced = existsSync(marker);
      sup.stop();
      await sleep(400);
      // DEFECTO afirma lo correcto: el navegador NO debe bloquearse por su propia salida.
      if (expectBlocked) expect({ advanced }).toEqual({ advanced: true });
      else expect(advanced).toBe(true);
    }, 15_000);
  }
});

describe("R242 · §36.4 STOP del árbol cuando el padre muere antes (ppid reasignado a init)", () => {
  it("OBS P3 · el «chromium» muere por SIGKILL externo dejando 2 hijos: el reintento NO los recoge (ya no cuelgan de su pid) y siguen vivos tras STOP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-r242-orphan-"));
    const pidFile = join(dir, "pids");
    const chromium = script(
      dir,
      "chromium.sh",
      `echo $$ >> ${pidFile}\nsleep 300 & echo $! >> ${pidFile}\nsleep 300 & echo $! >> ${pidFile}\nwait`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", "exec sleep 300");
    const { sup } = realSup(dir, chromium, ffmpeg);
    const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
    try {
      sup.start();
      for (let i = 0; i < 100 && pids().length < 3; i++) await sleep(20);
      const [main, ...kids] = pids();
      expect(kids).toHaveLength(2);
      process.kill(main, "SIGKILL"); // crash del proceso principal (OOM, segfault…)
      for (let i = 0; i < 100 && pids().length < 6; i++) await sleep(20); // relanzado
      sup.stop();
      await sleep(800); // > gracia (300 ms) + SIGKILL
      const survivors = kids.filter(alive);
      // Se documenta el límite: el árbol se lee por ppid y los hijos huérfanos ya
      // cuelgan de init/subreaper. Con Chromium real hay que medir si salen solos
      // (ver informe: medición dentro del contenedor).
      expect(survivors).toEqual(kids);
    } finally {
      for (const p of pids()) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* ya no existe */
        }
      }
    }
  }, 20_000);
});
