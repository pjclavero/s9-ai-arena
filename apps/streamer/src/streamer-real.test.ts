/**
 * STREAMER · cierre para producción (lado streamer). Rojo → verde:
 *  - #241 R4-3 · el logger redacta POR VALOR (replacer), no la línea serializada:
 *    con `\n` + 7 caracteres de la clave la línea dejaba de ser JSON (`\***`);
 *  - #241 R4-1 · `/control/stop` CONDICIONADO a la sesión (`ifSession`);
 *  - §12 · SIGTERM y SIGKILL tras la espera, al ÁRBOL de procesos;
 *  - §20/§31 NO_ORPHAN_PROCESS con procesos REALES (hijos de un «chromium» de prueba);
 *  - §31 FFMPEG_START_FAILURE con el ffmpeg REAL del sistema (x11grab sin display);
 *  - §28 métricas `stream_*`; §30 rotación de la clave heredada sin reiniciar;
 *  - §27 logs útiles (arranque con sesión, parada, ffmpeg terminó, reintento).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, redactSecret, SecretRegistry, type StreamerConfig } from "./config.js";
import { createControlServer } from "./control.js";
import { realSpawner } from "./main.js";
import { renderPrometheus } from "./metrics.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";
import { sealSecret } from "../../../packages/stream-secrets/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number) => randomBytes(4).readUInt32BE(0) % n;

// ── R4-3 ────────────────────────────────────────────────────────────────────
function youtubeKey() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => a[rnd(a.length)]).join("")).join("-");
}
const SHORT_ESC: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/** Lo que devuelve una ingesta hostil (revisión R4b): control cuyo escape termina en K[j] + 7 caracteres. */
function escapeSplitting(key: string): string | null {
  for (let j = 0; j + 8 <= key.length; j++) {
    const c = key[j];
    if (c in SHORT_ESC) return SHORT_ESC[c] + key.slice(j + 1, j + 8);
    if (/[0-9a-f]/.test(c)) return String.fromCharCode(0x10 + parseInt(c, 16)) + key.slice(j + 1, j + 8);
  }
  return null;
}

describe("STREAMER · #241 R4-3 · el log del streamer sigue siendo JSON", () => {
  it("ingesta hostil (control + 7 caracteres de la clave): la línea es JSON y no lleva la clave", () => {
    const key = "abcd-efgh-ijkn-mnop-qrst";
    const lines: string[] = [];
    createLogger(key, (l) => lines.push(l))("warn", "relé RTMP: corte de la ingesta", {
      detail: `la ingesta rechazó publish: no: ${escapeSplitting(key)}`,
    });
    expect(() => JSON.parse(lines[0]), lines[0]).not.toThrow();
    expect(lines[0].includes(key)).toBe(false);
  });

  it("barrido: 500 claves con forma YouTube, todas atacables ⇒ 0 líneas rotas y 0 claves", () => {
    let attackable = 0;
    for (let k = 0; k < 500; k++) {
      const key = youtubeKey();
      const txt = escapeSplitting(key);
      if (!txt) continue;
      attackable++;
      const lines: string[] = [];
      createLogger(key, (l) => lines.push(l))("warn", "relé RTMP: corte de la ingesta", {
        detail: `la ingesta rechazó publish: ${redactSecret(txt, key)} ${key}`,
        nested: { url: `rtmps://a/live2/${key}`, list: [key, `x${key}y`] },
      });
      expect(() => JSON.parse(lines[0]), lines[0]).not.toThrow();
      expect(lines[0].includes(key)).toBe(false);
    }
    expect(attackable).toBeGreaterThan(490);
  });

  it('clave admitida por la API con `"` y una palabra del log (`Zq9streamer"Zq9x`): JSON válido, sobre-redacción documentada', () => {
    const lines: string[] = [];
    createLogger(`Zq9streamer"Zq9x`, (l) => lines.push(l))("info", "relé publicando", {});
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe("relé publicando");
    expect(parsed.service).toBe("***");
  });

  it("un Error en los campos se registra por su mensaje redactado", () => {
    const key = youtubeKey();
    const lines: string[] = [];
    createLogger(key, (l) => lines.push(l))("error", "x", { err: new Error(`fallo ${key}`) });
    expect(JSON.parse(lines[0]).err).toBe("fallo ***");
  });
});

// ── arnés con procesos falsos ───────────────────────────────────────────────
class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  signals: string[] = [];
  exitCode: number | null = null;
  constructor(
    public cmd: string,
    public args: string[],
    public ignoreTerm = false,
  ) {
    super();
  }
  kill(sig?: NodeJS.Signals) {
    this.signals.push(sig ?? "SIGTERM");
    if (sig === "SIGKILL" || !this.ignoreTerm) {
      this.exitCode = sig === "SIGKILL" ? 137 : 143;
      setImmediate(() => this.emit("exit", this.exitCode));
    }
    return true;
  }
}

function harness(
  over: Partial<StreamerConfig> = {},
  o: { ignoreTerm?: boolean; graceMs?: number; now?: () => number } = {},
) {
  const spawned: FakeProcess[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args, o.ignoreTerm);
    spawned.push(p);
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
    sleep: async () => {},
    dial: () => new PassThrough(),
    stopGraceMs: o.graceMs ?? 50,
    now: o.now,
  });
  return { sup, spawned, lines, config, secrets, logger };
}

async function control(
  h: ReturnType<typeof harness>,
  fn: (
    call: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>,
  ) => Promise<void>,
  extra: Partial<Parameters<typeof createControlServer>[0]> = {},
) {
  const server = createControlServer({
    supervisor: h.sup,
    config: h.config,
    logger: h.logger,
    capabilities: { nvenc: false },
    ...extra,
  });
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

const recordStart = (sessionId: string) => ({
  sessionId,
  mode: "record",
  encoder: "x264",
  preset: "1080p",
  fps: 30,
  videoBitrateKbps: 4500,
});

describe("STREAMER · #241 R4-1 · stop condicionado a la sesión (RECONCILER_STOP_RACE)", () => {
  it("`ifSession` de OTRA sesión ⇒ 409 session_mismatch y la emisión sigue", async () => {
    const h = harness();
    await control(h, async (call) => {
      expect((await call("POST", "/control/start", recordStart("sesion-B"))).status).toBe(200);
      const r = await call("POST", "/control/stop", { ifSession: "sesion-A" });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("session_mismatch");
      expect(h.sup.state).toBe("streaming");
      expect(h.sup.currentSessionId).toBe("sesion-B");
    });
  });

  it("`ifSession` de la sesión que emite ⇒ para; repetirlo ⇒ 409 (nada que parar), sin romper nada", async () => {
    const h = harness();
    await control(h, async (call) => {
      await call("POST", "/control/start", recordStart("sesion-A"));
      const r = await call("POST", "/control/stop", { ifSession: "sesion-A" });
      expect(r).toMatchObject({ status: 200, body: { state: "stopped", wasActive: true } });
      expect((await call("POST", "/control/stop", { ifSession: "sesion-A" })).status).toBe(409);
      expect(h.sup.state).toBe("stopped");
    });
  });

  it("`ifSession: null` sólo para una emisión SIN sesión (heredada/AUTOSTART), nunca una con sesión", async () => {
    const h = harness();
    await control(h, async (call) => {
      await call("POST", "/control/start", recordStart("sesion-A"));
      expect((await call("POST", "/control/stop", { ifSession: null })).status).toBe(409);
      h.sup.stop();
      h.sup.start(); // heredado: sin plan ⇒ sin sesión (y NO hereda la anterior)
      expect(h.sup.currentSessionId).toBeNull();
      expect((await call("POST", "/control/stop", { ifSession: null })).status).toBe(200);
      expect(h.sup.state).toBe("stopped");
    });
  });

  it("`ifSession` con formato inválido ⇒ 400; stop sin cuerpo sigue siendo idempotente (STREAM_STOP_IDEMPOTENT)", async () => {
    const h = harness();
    await control(h, async (call) => {
      expect((await call("POST", "/control/stop", { ifSession: "../x" })).status).toBe(400);
      expect((await call("POST", "/control/stop")).body).toMatchObject({ state: "stopped", wasActive: false });
      expect((await call("POST", "/control/stop")).body).toMatchObject({ state: "stopped", wasActive: false });
    });
  });
});

describe("STREAMER · §12 · SIGTERM, espera y SIGKILL", () => {
  it("un proceso que ignora SIGTERM recibe SIGKILL tras la espera; se cuenta y se registra", async () => {
    const h = harness({}, { ignoreTerm: true, graceMs: 30 });
    h.sup.start();
    h.sup.stop();
    expect(h.sup.pendingChildren).toBe(2);
    await sleep(80);
    for (const p of h.spawned) expect(p.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.sup.pendingChildren).toBe(0);
    expect(h.sup.counters.killed).toBe(2);
    expect(h.lines.some((l) => l.includes("SIGKILL"))).toBe(true);
  });

  it("un proceso que atiende SIGTERM no recibe SIGKILL", async () => {
    const h = harness({}, { graceMs: 30 });
    h.sup.start();
    h.sup.stop();
    await sleep(80);
    for (const p of h.spawned) expect(p.signals).toEqual(["SIGTERM"]);
    expect(h.sup.counters.killed).toBe(0);
  });
});

describe("STREAMER · §28 métricas stream_* y §27 logs útiles", () => {
  it("start, stop, fallo terminal y uptime se reflejan en /metrics con los nombres del encargo", async () => {
    let now = 1_000_000;
    const h = harness({ maxRetries: 1 }, { now: () => now });
    await control(
      h,
      async (call) => {
        await call("POST", "/control/start", recordStart("s1"));
        now += 42_000;
        let m = String((await call("GET", "/metrics")).body.text);
        expect(m).toMatch(/^stream_active 1$/m);
        expect(m).toMatch(/^stream_start_total 1$/m);
        expect(m).toMatch(/^stream_uptime_seconds 42$/m);
        await call("POST", "/control/stop");
        await call("POST", "/control/stop"); // idempotente: no cuenta dos veces
        // Fallo terminal: ffmpeg cae dos veces seguidas (maxRetries 1).
        await call("POST", "/control/start", recordStart("s2"));
        h.spawned.at(-1)!.emit("exit", 1);
        await sleep(5);
        h.spawned.at(-1)!.emit("exit", 1);
        await sleep(5);
        expect(h.sup.state).toBe("failed");
        m = String((await call("GET", "/metrics")).body.text);
        expect(m).toMatch(/^stream_active 0$/m);
        expect(m).toMatch(/^stream_start_total 2$/m);
        expect(m).toMatch(/^stream_stop_total 1$/m);
        expect(m).toMatch(/^stream_failures_total 1$/m);
        expect(m).toMatch(/^stream_reconnects_total 2$/m);
        expect(m).toMatch(/^stream_uptime_seconds 0$/m);
        for (const n of ["stream_frames_total", "stream_dropped_frames_total", "stream_killed_total"]) {
          expect(m).toMatch(new RegExp(`^# TYPE ${n} counter$`, "m"));
        }
      },
      { now: () => now },
    );
    h.sup.stop();
    const msgs = h.lines.map((l) => JSON.parse(l).msg);
    for (const m of ["emisión arrancada", "emisión parada por control", "ffmpeg terminó", "reintento de emisión"]) {
      expect(msgs).toContain(m);
    }
    expect(h.lines.find((l) => l.includes("emisión arrancada") && l.includes('"sessionId":"s1"'))).toBeTruthy();
  });

  it("renderPrometheus sin contadores no rompe (compatibilidad)", () => {
    const t = renderPrometheus({
      state: "idle",
      restarts: 0,
      stats: { frames: 0, fps: 0, bitrateKbps: 0, outTimeSeconds: 0, droppedFrames: 0, reporting: false },
    });
    expect(t).toMatch(/^stream_start_total 0$/m);
  });
});

describe("STREAMER · §30 rotación de la clave sin reconstruir ni reiniciar", () => {
  it("clave heredada en fichero: el siguiente START usa la nueva y la anterior deja de usarse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-rot-"));
    const file = join(dir, "stream_key");
    const keyA = `rotA-${randomBytes(8).toString("hex")}`;
    const keyB = `rotB-${randomBytes(8).toString("hex")}`;
    writeFileSync(file, keyA, { mode: 0o600 });
    const h = harness({ mode: "rtmps", rtmpsUrl: "rtmps://ingest.example/live2" });
    await control(
      h,
      async (call) => {
        expect((await call("POST", "/control/start")).status).toBe(200);
        expect((h.sup as unknown as { key: string }).key).toBe(keyA);
        await call("POST", "/control/stop");
        writeFileSync(file, keyB, { mode: 0o600 }); // en el sitio, como docs/operations/streaming.md
        expect((await call("POST", "/control/start")).status).toBe(200);
        expect((h.sup as unknown as { key: string }).key).toBe(keyB);
        const status = JSON.stringify((await call("GET", "/status")).body);
        expect(status.includes(keyA) || status.includes(keyB)).toBe(false);
      },
      { readLegacyKey: () => readFileSync(file, "utf8").trim() || null },
    );
  });

  it("par de sellado: la privada se relee en cada apertura (un sobre con la clave nueva abre sin reiniciar)", async () => {
    const gen = () =>
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
    const k1 = gen();
    const k2 = gen();
    let priv = k1.privateKey;
    const bind = { platform: "custom", ingest: "rtmps://ingest.example/live2" };
    const h = harness({ mode: "rtmps", rtmpsUrl: "rtmps://ingest.example/live2" });
    const body = (pub: string) => ({
      sessionId: `s-${randomBytes(3).toString("hex")}`,
      mode: "rtmps",
      ingestUrl: "rtmps://ingest.example/live2",
      platform: "custom",
      credential: sealSecret("clave-de-prueba-rotada", pub, bind),
    });
    await control(
      h,
      async (call) => {
        expect((await call("POST", "/control/start", body(k1.publicKey))).status).toBe(200);
        await call("POST", "/control/stop");
        priv = k2.privateKey; // rotación del par (ficheros sustituidos)
        expect((await call("POST", "/control/start", body(k1.publicKey))).status).toBe(409); // sobre viejo ya no abre
        expect((await call("POST", "/control/start", body(k2.publicKey))).status).toBe(200);
      },
      { readPrivateKey: () => priv },
    );
  });
});

// ── procesos REALES ─────────────────────────────────────────────────────────
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** «Chromium» de prueba: lanza 2 hijos (como zygote/renderer), apunta sus pid y espera. */
function fakeBrowser(dir: string, ignoreTerm: boolean): { bin: string; pids: () => number[] } {
  const pidFile = join(dir, `pids-${ignoreTerm ? "t" : "n"}`);
  const bin = join(dir, `fake-browser-${ignoreTerm ? "t" : "n"}.sh`);
  writeFileSync(
    bin,
    `#!/bin/sh\n${ignoreTerm ? "trap '' TERM\n" : ""}echo $$ >> ${pidFile}\nsleep 300 & echo $! >> ${pidFile}\nsleep 300 & echo $! >> ${pidFile}\nwait\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    pids: () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []),
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // Un zombi responde a kill 0: cuenta como vivo sólo si no está en estado Z.
    const st = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
    return st !== "Z";
  } catch {
    return false;
  }
};

describe("STREAMER · §20/§31 NO_ORPHAN_PROCESS con procesos reales", () => {
  for (const ignoreTerm of [false, true]) {
    it(`tras STOP no queda NINGÚN proceso del árbol (hijos incluidos)${ignoreTerm ? " aunque ignoren SIGTERM (SIGKILL al árbol)" : ""}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "s9-orphan-"));
      const browser = fakeBrowser(dir, ignoreTerm);
      const ff = fakeBrowser(join(dir), ignoreTerm);
      const lines: string[] = [];
      const sup = new StreamSupervisor({
        config: { ...DEFAULT_CONFIG, mode: "record", recordDir: dir },
        spawner: realSpawner,
        logger: createLogger(null, (l) => lines.push(l)),
        processTree: true,
        stopGraceMs: 300,
        chromiumBin: browser.bin,
        ffmpegBin: ff.bin,
      });
      sup.start();
      for (let i = 0; i < 100 && browser.pids().length < 6; i++) await sleep(20);
      const pids = browser.pids(); // ambos scripts escriben en el mismo fichero
      expect(pids.length).toBe(6);
      expect(pids.every(alive)).toBe(true);
      sup.stop();
      for (let i = 0; i < 100 && pids.some(alive); i++) await sleep(20);
      expect(pids.filter(alive)).toEqual([]);
      expect(sup.pendingChildren).toBe(0);
      expect(sup.counters.killed).toBe(ignoreTerm ? 2 : 0);
    }, 20_000);
  }
});

// En la CI es obligatorio (el job `unit` lo instala): sólo se salta en local sin ffmpeg.
const mustRunFfmpeg = process.env.CI === "true";
describe.skipIf(!hasFfmpeg && !mustRunFfmpeg)("STREAMER · §31 FFMPEG_START_FAILURE con el ffmpeg REAL", () => {
  it("la CI tiene ffmpeg (si no, este test falla en vez de saltarse)", () => {
    expect(hasFfmpeg).toBe(true);
  });
  it("x11grab contra un display inexistente: ffmpeg sale con error, se reintenta, acaba FAILED con el error y sin procesos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-ffreal-"));
    const browser = fakeBrowser(dir, false);
    const lines: string[] = [];
    const sup = new StreamSupervisor({
      config: { ...DEFAULT_CONFIG, mode: "record", recordDir: dir, display: ":987", maxRetries: 2, retryDelayMs: 50 },
      spawner: realSpawner,
      logger: createLogger(null, (l) => lines.push(l)),
      processTree: true,
      stopGraceMs: 300,
      chromiumBin: browser.bin,
      ffmpegBin: "ffmpeg",
    });
    sup.start();
    for (let i = 0; i < 300 && sup.state !== "failed"; i++) await sleep(20);
    expect(sup.state).toBe("failed");
    expect(sup.counters.failures).toBe(1);
    expect(sup.restarts).toBe(3);
    expect(lines.some((l) => JSON.parse(l).msg === "ffmpeg terminó")).toBe(true);
    expect(sup.lastError?.message ?? "").toMatch(/ffmpeg/);
    for (let i = 0; i < 100 && browser.pids().some(alive); i++) await sleep(20);
    expect(browser.pids().filter(alive)).toEqual([]);
    sup.stop();
  }, 30_000);
});
