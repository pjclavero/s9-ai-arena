/**
 * RE-REVISIÓN INDEPENDIENTE de #242 (ronda corta H1-H3, @74fe45f) · pruebas de
 * rotura. NO MERGEAR: viven en `review/streamer-242-r2` (PR draft).
 *
 * Convención: `DEFECTO` afirma lo correcto (rojo si el defecto existe);
 * `CONTROL` calibra el arnés; el resto son comprobaciones de cierre.
 */
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, SecretRegistry, type StreamerConfig } from "./config.js";
import { realSpawner } from "./main.js";
import { ProgressParser } from "./metrics.js";
import { CHROMIUM_OUTPUT_TAIL_BYTES, StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lineCount = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);

function script(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const sups: StreamSupervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) s.stop();
  await sleep(500);
});

function realSup(dir: string, chromium: string, ffmpeg: string, key?: string, over: Partial<StreamerConfig> = {}) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", recordDir: dir, retryDelayMs: 50, maxRetries: 50, ...over },
    spawner: realSpawner,
    logger: createLogger(secrets, (l) => lines.push(l)),
    secrets,
    streamKey: key,
    processTree: true,
    stopGraceMs: 300,
    chromiumBin: chromium,
    ffmpegBin: ffmpeg,
  });
  sups.push(sup);
  return { sup, lines };
}

const FFMPEG_PROGRESS = `i=0
while :; do
  i=$((i+3))
  printf 'frame=%d\\nfps=30\\ndrop_frames=0\\nprogress=continue\\n' "$i"
  sleep 0.05
done`;

// ── H1 · salida hostil de Chromium con procesos reales ──────────────────────
describe("R2 · H1 · ninguna forma de salida de Chromium bloquea la emisión", () => {
  it("ráfagas > 2 MiB, línea de 4 MiB sin salto, binario aleatorio y UTF-8 partido por ambos pipes: Chromium avanza y los frames suben", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-r2-h1-"));
    const ticks = join(dir, "ticks");
    const chromium = script(
      dir,
      "chromium.sh",
      `head -c 3145728 /dev/zero | tr '\\0' e >&2
head -c 3145728 /dev/zero | tr '\\0' o
head -c 4194304 /dev/zero | tr '\\0' L >&2
head -c 4194304 /dev/zero | tr '\\0' L
head -c 1048576 /dev/urandom >&2
head -c 1048576 /dev/urandom
i=0; while [ $i -lt 2000 ]; do printf 'ñ€😀'; i=$((i+1)); done | head -c 9999 >&2
while :; do
  head -c 131072 /dev/urandom >&2
  head -c 131071 /dev/zero | tr '\\0' z
  echo t >> ${ticks}
  sleep 0.02
done`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", FFMPEG_PROGRESS);
    const { sup } = realSup(dir, chromium, ffmpeg);
    sup.start();
    for (let i = 0; i < 200 && lineCount(ticks) < 2; i++) await sleep(25);
    const t1 = lineCount(ticks);
    const f1 = sup.metrics.snapshot().frames;
    await sleep(1500);
    const t2 = lineCount(ticks);
    const f2 = sup.metrics.snapshot().frames;
    const view = { state: sup.state, t1, t2, f1, f2, restarts: sup.restarts };
    expect(t1, JSON.stringify(view)).toBeGreaterThan(0); // pasó las ráfagas (≈ 22 MiB)
    expect(t2 - t1, JSON.stringify(view)).toBeGreaterThan(10); // > 2.5 MiB más tras ellas
    expect(f2, JSON.stringify(view)).toBeGreaterThan(f1);
    expect(view.state).toBe("streaming");
    expect(view.restarts).toBe(0);
  }, 30_000);

  it("la clave en el stderr de Chromium, partida en dos escrituras y codificada, NO aparece (ni un trozo de ≥ 8) en outputTail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-r2-h1k-"));
    const key = `r2k-${randomBytes(14).toString("hex")}`;
    const keyFile = join(dir, "k");
    writeFileSync(keyFile, key, { mode: 0o600 });
    const chromium = script(
      dir,
      "chromium.sh",
      `K=$(cat ${keyFile})
printf 'url=rtmp://x/live2/%s' "$(printf %s "$K" | cut -c1-12)" >&2
sleep 0.2
printf '%s\\n' "$(printf %s "$K" | cut -c13-)" >&2
printf 'b64=%s\\n' "$(printf %s "$K" | base64 -w0)" >&2
exit 3`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", FFMPEG_PROGRESS);
    const { sup, lines } = realSup(dir, chromium, ffmpeg, key, { maxRetries: 0 });
    sup.start();
    for (let i = 0; i < 100 && !lines.some((l) => l.includes("chromium terminó")); i++) await sleep(20);
    const line = lines.find((l) => l.includes("chromium terminó"));
    expect(line, lines.join("\n")).toBeDefined();
    const tail = (JSON.parse(line!) as { outputTail: string }).outputTail;
    expect(tail).toContain("url=rtmp://x/live2/"); // CONTROL: la cola sí llegó
    for (let i = 0; i + 8 <= key.length; i++) expect(tail).not.toContain(key.slice(i, i + 8));
    expect(tail).not.toContain(Buffer.from(key).toString("base64").slice(0, 12));
  }, 20_000);

  it("clave cortada por el borde de la cola (quedan 9 caracteres dentro): se redacta igual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-r2-h1b-"));
    const key = `r2k-${randomBytes(14).toString("hex")}`;
    const keyFile = join(dir, "k");
    writeFileSync(keyFile, key, { mode: 0o600 });
    // La cola son los últimos 2048 bytes: tras la clave van 2048-9 bytes de relleno.
    const chromium = script(
      dir,
      "chromium.sh",
      `printf '%s' "$(cat ${keyFile})" >&2
head -c ${CHROMIUM_OUTPUT_TAIL_BYTES - 9} /dev/zero | tr '\\0' p >&2
exit 3`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", FFMPEG_PROGRESS);
    const { sup, lines } = realSup(dir, chromium, ffmpeg, key, { maxRetries: 0 });
    sup.start();
    for (let i = 0; i < 100 && !lines.some((l) => l.includes("chromium terminó")); i++) await sleep(20);
    const tail = (JSON.parse(lines.find((l) => l.includes("chromium terminó"))!) as { outputTail: string }).outputTail;
    expect(tail.startsWith("***")).toBe(true);
    expect(tail).not.toContain(key.slice(-9, -1));
    expect(lines.join("\n")).not.toContain(key.slice(-9));
  }, 20_000);
});

// ── H1 · cola acotada y sin fugas de listeners (spawner falso) ──────────────
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdio: unknown[] = [null, this.stdout, this.stderr, new PassThrough()];
  pid = undefined;
  exitCode: number | null = null;
  signalCode = null;
  constructor(readonly cmd: string) {
    super();
  }
  kill(): boolean {
    if (this.exitCode === null) {
      this.exitCode = 143;
      setImmediate(() => this.emit("exit", 143));
    }
    return true;
  }
}

function fakeSup(over: Partial<StreamerConfig> = {}) {
  const children: FakeChild[] = [];
  const spawner: Spawner = (cmd) => {
    const c = new FakeChild(cmd);
    children.push(c);
    return c;
  };
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", recordDir: tmpdir(), retryDelayMs: 0, maxRetries: 1000, ...over },
    spawner,
    logger: createLogger(secrets, (l) => lines.push(l)),
    secrets,
    stopGraceMs: 50,
    chromiumBin: "chromium",
    ffmpegBin: "ffmpeg",
    sleep: async () => {},
  });
  sups.push(sup);
  return { sup, children, lines };
}

describe("R2 · H1 · la cola no crece y los relanzamientos no acumulan listeners", () => {
  it("64 MiB por stderr en trozos de 64 KiB: outputTail ≤ CHROMIUM_OUTPUT_TAIL_BYTES y es el FINAL de la salida", async () => {
    const { sup, children, lines } = fakeSup({ maxRetries: 0 });
    sup.start();
    const chromium = children.find((c) => c.cmd === "chromium")!;
    const chunk = Buffer.alloc(65536, "a");
    for (let i = 0; i < 1024; i++) chromium.stderr.write(chunk);
    chromium.stderr.write("FIN-DE-LA-SALIDA");
    await sleep(50);
    chromium.exitCode = 1;
    chromium.emit("exit", 1);
    const tail = (JSON.parse(lines.find((l) => l.includes("chromium terminó"))!) as { outputTail: string }).outputTail;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(CHROMIUM_OUTPUT_TAIL_BYTES);
    expect(tail.endsWith("FIN-DE-LA-SALIDA")).toBe(true);
  });

  it("40 caídas de Chromium: cada hijo nuevo tiene exactamente 1 lector por pipe y no hay MaxListenersExceededWarning", async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarn);
    try {
      const { sup, children } = fakeSup();
      sup.start();
      for (let i = 0; i < 40; i++) {
        const c = children.filter((x) => x.cmd === "chromium").at(-1)!;
        c.exitCode = 1;
        c.emit("exit", 1);
        await sleep(5);
      }
      const chromiums = children.filter((x) => x.cmd === "chromium");
      expect(chromiums.length).toBe(41);
      for (const c of chromiums) {
        expect(c.stdout.listenerCount("data")).toBe(1);
        expect(c.stderr.listenerCount("data")).toBe(1);
        expect(c.listenerCount("exit")).toBeLessThanOrEqual(2);
      }
      expect(warnings.filter((w) => w === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarn);
    }
  });
});

// ── H2 · la guarda no tapa fallos legítimos de una generación nueva ─────────
describe("R2 · H2 · guarda de generación: ruido viejo fuera, fallo nuevo visible", () => {
  it("re-START: el ruido tardío del ffmpeg ANTERIOR no pisa lastError; el error real del ffmpeg NUEVO sí se ve", async () => {
    const { sup, children } = fakeSup();
    sup.start();
    const oldFfmpeg = children.find((c) => c.cmd === "ffmpeg")!;
    oldFfmpeg.stderr.write("Error: raíz original\n");
    await sleep(10);
    expect(sup.lastError?.message).toMatch(/raíz original/); // CONTROL: generación vigente se ve
    sup.stop();
    sup.start();
    const newFfmpeg = children.filter((c) => c.cmd === "ffmpeg").at(-1)!;
    expect(newFfmpeg).not.toBe(oldFfmpeg);
    oldFfmpeg.stderr.write("Nothing was written into output file (ruido de la parada)\n");
    await sleep(10);
    expect(sup.lastError?.message ?? "").not.toMatch(/Nothing was written/);
    newFfmpeg.stderr.write("Unknown encoder 'libx264' (fallo real nuevo)\n");
    await sleep(10);
    expect(sup.lastError?.message).toMatch(/Unknown encoder/);
  });

  it("tras un fallo terminal (failed) y re-START, un fallo real del nuevo intento reemplaza la causa vieja", async () => {
    const { sup, children } = fakeSup({ maxRetries: 0 });
    sup.start();
    const f1 = children.find((c) => c.cmd === "ffmpeg")!;
    f1.exitCode = 1;
    f1.emit("exit", 1);
    await sleep(10);
    expect(sup.state).toBe("failed");
    expect(sup.lastError?.message).toMatch(/ffmpeg terminó \(código 1\)/);
    sup.start();
    const f2 = children.filter((c) => c.cmd === "ffmpeg").at(-1)!;
    expect(sup.lastError).toBeNull(); // start() limpia
    f2.stderr.write("Conversion failed! (fallo real nuevo)\n");
    await sleep(10);
    expect(sup.lastError?.message).toMatch(/Conversion failed/);
  });
});

// ── H3 · ¿stream_dropped_frames_total = drop_frames de ffmpeg tras relanzar? ──
function runFfmpeg(parser: ProgressParser, inRate: number): Promise<{ frame: number; drop: number }> {
  return new Promise((resolve, reject) => {
    const c = spawn(
      "ffmpeg",
      [
        ...["-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-f", "lavfi", "-i"],
        `testsrc=size=160x120:rate=${inRate}`,
        ...["-t", "2", "-r", "30", "-f", "null", "-"],
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let raw = "";
    c.stdout.on("data", (d: Buffer) => {
      raw += d.toString();
      parser.push(d);
    });
    c.on("error", reject);
    c.on("close", () => {
      const last = (k: string) => Number([...raw.matchAll(new RegExp(`^${k}=(\\d+)$`, "gm"))].at(-1)?.[1]);
      resolve({ frame: last("frame"), drop: last("drop_frames") });
    });
  });
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasFfmpeg)("R2 · H3 · métrica de descartes tras un relanzamiento (ffmpeg REAL)", () => {
  it("DEFECTO (P3) · tras relanzar ffmpeg, droppedFrames debe ser el drop_frames del ffmpeg EN CURSO (no el del anterior)", async () => {
    const parser = new ProgressParser();
    const a = await runFfmpeg(parser, 60); // con descartes
    expect(a.drop).toBeGreaterThan(0); // CONTROL
    expect(parser.snapshot().droppedFrames).toBe(a.drop); // CONTROL: primer ffmpeg = exacto
    parser.markRestart(); // lo que hace launchFfmpeg()
    const b = await runFfmpeg(parser, 30); // sin descartes
    expect(b.drop).toBe(0); // CONTROL: el ffmpeg nuevo dice 0
    const view = { ffmpegAnterior: a, ffmpegEnCurso: b, metrica: parser.snapshot() };
    expect(view.metrica.frames, JSON.stringify(view)).toBe(b.frame); // frames sí sigue al nuevo
    expect(view.metrica.droppedFrames, JSON.stringify(view)).toBe(b.drop); // rojo: conserva el del anterior
  }, 20_000);
});
