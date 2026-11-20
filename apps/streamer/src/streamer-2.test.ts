/**
 * STREAMER-2 · correcciones H1 y H2 de la revisión de #242, con procesos REALES
 * (scripts de shell lanzados por `realSpawner`) y el relé RTMP real contra una
 * ingesta falsa en 127.0.0.1 (puerto efímero; nada sale a la red).
 *
 *  - H1: la salida de Chromium (stdout y stderr) nunca bloquea por backpressure.
 *    Rojo sobre 588c842: Chromium se queda parado en write() y la emisión sigue
 *    «streaming» con la imagen congelada.
 *  - H2: cuando la ingesta rechaza la clave, `lastError` conserva la causa raíz
 *    (redactada), no el ruido que ffmpeg escribe al pararlo.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, SecretRegistry, type StreamerConfig } from "./config.js";
import { realSpawner } from "./main.js";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import type { IngestTarget } from "./rtmp/publisher.js";
import { ProgressParser } from "./metrics.js";
import { CHROMIUM_OUTPUT_TAIL_BYTES, StreamSupervisor } from "./supervisor.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function script(dir: string, name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const lineCount = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);

const servers: Server[] = [];
const sockets: Socket[] = [];
const sups: StreamSupervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) s.stop();
  await sleep(500); // > gracia de parada (300 ms): nada queda vivo
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function realSup(o: {
  dir: string;
  chromium: string;
  ffmpeg: string;
  over?: Partial<StreamerConfig>;
  streamKey?: string;
  dial?: (t: IngestTarget) => Duplex;
}) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, mode: "record", recordDir: o.dir, retryDelayMs: 50, maxRetries: 50, ...o.over },
    spawner: realSpawner,
    logger: createLogger(secrets, (l) => lines.push(l)),
    secrets,
    streamKey: o.streamKey,
    processTree: true,
    stopGraceMs: 300,
    chromiumBin: o.chromium,
    ffmpegBin: o.ffmpeg,
    dial: o.dial,
    allowPlainRtmp: true,
  });
  sups.push(sup);
  return { sup, lines };
}

// ffmpeg falso: bloques de `-progress` con el contador de frames avanzando.
const FFMPEG_PROGRESS = `i=0
while :; do
  i=$((i+3))
  printf 'frame=%d\\nfps=30\\ndrop_frames=0\\nbitrate=1000.0kbits/s\\nprogress=continue\\n' "$i"
  sleep 0.05
done`;

describe("STREAMER-2 · H1 · la salida de Chromium no bloquea nunca (H1_CHROMIUM_BACKPRESSURE)", () => {
  it("Chromium escribe ≥ 2 MiB por stderr y por stdout y sigue escribiendo: avanza, la emisión sigue «streaming» y los frames suben", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-str2-h1-"));
    const ticks = join(dir, "ticks");
    // 1 MiB a cada pipe de golpe y luego 64 KiB a cada pipe cada 20 ms, anotando
    // cada vuelta. Sin lector, write() se bloquea entre 128 y 256 KiB.
    const chromium = script(
      dir,
      "chromium.sh",
      `head -c 1048576 /dev/zero | tr '\\0' e >&2
head -c 1048576 /dev/zero | tr '\\0' o
while :; do
  head -c 65536 /dev/zero | tr '\\0' e >&2
  head -c 65536 /dev/zero | tr '\\0' o
  echo t >> ${ticks}
  sleep 0.02
done`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", FFMPEG_PROGRESS);
    const { sup } = realSup({ dir, chromium, ffmpeg });
    sup.start();
    await sleep(1500);
    const t1 = lineCount(ticks);
    const f1 = sup.metrics.snapshot().frames;
    await sleep(1500);
    const t2 = lineCount(ticks);
    const f2 = sup.metrics.snapshot().frames;
    const view = { state: sup.state, t1, t2, f1, f2, bytesAfterBurst: t2 * 2 * 65536 };
    // ≥ 1 MiB adicional después de la ráfaga inicial de 2 MiB, y sigue avanzando.
    expect(view.bytesAfterBurst, JSON.stringify(view)).toBeGreaterThan(1024 * 1024);
    expect(t2, JSON.stringify(view)).toBeGreaterThan(t1);
    expect(f2, JSON.stringify(view)).toBeGreaterThan(f1);
    expect(sup.state).toBe("streaming");
    expect(sup.restarts).toBe(0);
  }, 20_000);

  it("diagnóstico: al caer Chromium se registra sólo una COLA acotada de su stderr, redactada (la clave no sale)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-str2-h1d-"));
    const key = `str2-${randomBytes(12).toString("hex")}-Kz`;
    const keyFile = join(dir, "k");
    writeFileSync(keyFile, key, { mode: 0o600 });
    const chromium = script(
      dir,
      "chromium.sh",
      `head -c 1048576 /dev/zero | tr '\\0' e >&2
printf '\\nFATAL: gpu process crashed key=%s\\n' "$(cat ${keyFile})" >&2
exit 7`,
    );
    const ffmpeg = script(dir, "ffmpeg.sh", FFMPEG_PROGRESS);
    const { sup, lines } = realSup({ dir, chromium, ffmpeg, streamKey: key, over: { maxRetries: 1 } });
    sup.start();
    for (let i = 0; i < 100 && !lines.some((l) => l.includes("chromium terminó")); i++) await sleep(20);
    const line = lines.find((l) => l.includes("chromium terminó"));
    expect(line, lines.join("\n")).toBeDefined();
    const entry = JSON.parse(line!) as { outputTail?: string };
    expect(entry.outputTail ?? "").toContain("FATAL: gpu process crashed");
    expect((entry.outputTail ?? "").length).toBeLessThanOrEqual(CHROMIUM_OUTPUT_TAIL_BYTES);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n").length).toBeLessThan(64 * 1024); // el MiB de ruido no llega al log
  }, 20_000);
});

// ── H2 · ingesta RTMP falsa que rechaza la clave en `publish` ────────────────
async function rejectingIngest() {
  const seen = { publishes: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    const reader = new ChunkReader();
    const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
    const reply = (name: string, txn: number, args: unknown[], streamId = 0) =>
      send({
        csid: 3,
        type: MSG_COMMAND_AMF0,
        streamId,
        timestamp: 0,
        payload: encodeAmf0Values([name, txn, ...(args as never[])]),
      });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "c0c1") {
        if (buf.length < 1537) return;
        sock.write(Buffer.concat([Buffer.from([3]), randomBytes(1536), buf.subarray(1, 1537)]));
        buf = buf.subarray(1537);
        phase = "c2";
      }
      if (phase === "c2") {
        if (buf.length < 1536) return;
        buf = buf.subarray(1536);
        phase = "chunks";
      }
      if (phase !== "chunks" || !buf.length) return;
      const msgs = reader.push(buf);
      buf = Buffer.alloc(0);
      for (const m of msgs) {
        if (m.type === MSG_SET_CHUNK_SIZE) {
          if (m.payload.length >= 4) reader.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
          continue;
        }
        if (m.type !== MSG_COMMAND_AMF0) continue;
        const v = decodeAmf0Values(m.payload);
        const name = String(v[0]);
        const txn = Number(v[1]);
        if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
        if (name === "createStream") reply("_result", txn, [null, 1]);
        if (name === "publish") {
          seen.publishes++;
          reply(
            "onStatus",
            0,
            [null, { level: "error", code: "NetStream.Publish.BadName", description: "invalid key" }],
            1,
          );
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, dial: (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port }) as Duplex };
}

describe("STREAMER-2 · H2 · lastError conserva la causa raíz del rechazo (H2_ROOT_ERROR_PRESERVED)", () => {
  it("la ingesta rechaza la clave: estado `failed` y lastError = rechazo redactado, no el «Nothing was written…» de la parada de ffmpeg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s9-str2-h2-"));
    const key = `str2-${randomBytes(12).toString("hex")}-Kz`;
    const chromium = script(dir, "chromium.sh", "exec sleep 300");
    // ffmpeg falso que, como el real, escribe por stderr al recibir SIGTERM.
    const ffmpeg = script(
      dir,
      "ffmpeg.sh",
      `trap 'echo "[out#0/flv @ 0x55d0] Nothing was written into output file, because at least one of its streams received no packets." >&2; exit 255' TERM
while :; do sleep 0.05; done`,
    );
    const ing = await rejectingIngest();
    const { sup, lines } = realSup({
      dir,
      chromium,
      ffmpeg,
      streamKey: key,
      dial: ing.dial,
      over: { mode: "rtmps", rtmpsUrl: `rtmp://127.0.0.1:${ing.port}/live2`, maxRetries: 2, retryDelayMs: 150 },
    });
    sup.start();
    for (let i = 0; i < 200 && sup.state !== "failed"; i++) await sleep(25);
    expect(sup.state).toBe("failed");
    // El ruido de la parada llega DESPUÉS del fallo terminal: se espera al de CADA
    // ffmpeg lanzado (también el del último intento).
    const count = (s: string) => lines.filter((l) => l.includes(s)).length;
    for (let i = 0; i < 80 && count("Nothing was written") < count("ffmpeg lanzado"); i++) await sleep(25);
    const view = { state: sup.state, publishes: ing.seen.publishes, lastError: sup.lastError?.message ?? null };
    // Control del arnés: la ingesta recibió el publish y ffmpeg sí escribió su ruido.
    expect(view.publishes, JSON.stringify(view)).toBeGreaterThan(0);
    expect(count("ffmpeg lanzado"), lines.join("\n")).toBe(3); // 1 + maxRetries
    expect(count("Nothing was written"), lines.join("\n")).toBe(3);
    // Lo exigible: la causa raíz, redactada.
    expect(view.lastError ?? "", JSON.stringify(view)).toMatch(/la ingesta rechazó la publicación/);
    expect(view.lastError ?? "").not.toMatch(/Nothing was written/);
    expect(JSON.stringify(view) + lines.join("\n")).not.toContain(key);
  }, 20_000);
});

// ── H3 · la métrica de frames descartados es la que reporta ffmpeg ─────────────
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const mustRunFfmpeg = process.env.CI === "true";
describe.skipIf(!hasFfmpeg && !mustRunFfmpeg)(
  "STREAMER-2 · H3 · dropped frames = lo que dice ffmpeg (ffmpeg REAL)",
  () => {
    it("60 fps de entrada a 30 de salida: droppedFrames/frames del parser = drop_frames/frame del último bloque de -progress = drop=/frame= del resumen final de ffmpeg", async () => {
      expect(hasFfmpeg).toBe(true);
      const child = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-loglevel",
          "info",
          "-progress",
          "pipe:1",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=160x120:rate=60",
          "-t",
          "2",
          "-r",
          "30",
          "-f",
          "null",
          "-",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const parser = new ProgressParser();
      let raw = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        raw += c.toString();
        parser.push(c);
      });
      child.stderr.on("data", (c: Buffer) => (err += c.toString()));
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      expect(code).toBe(0);
      const lastOf = (k: string) => Number([...raw.matchAll(new RegExp(`^${k}=(\\d+)$`, "gm"))].at(-1)?.[1]);
      const summary = /frame=\s*(\d+).*drop=(\d+)/.exec(
        err
          .split(/\r|\n/)
          .filter((l) => l.includes("drop="))
          .at(-1) ?? "",
      );
      const view = {
        parser: parser.snapshot(),
        progress: { frame: lastOf("frame"), drop_frames: lastOf("drop_frames") },
        summary: summary ? { frame: Number(summary[1]), drop: Number(summary[2]) } : null,
      };
      expect(view.progress.drop_frames, JSON.stringify(view)).toBeGreaterThan(0); // control: hay descartes de verdad
      expect(view.parser.droppedFrames, JSON.stringify(view)).toBe(view.progress.drop_frames);
      expect(view.parser.frames, JSON.stringify(view)).toBe(view.progress.frame);
      expect(view.summary, JSON.stringify(view)).toEqual({
        frame: view.parser.frames,
        drop: view.parser.droppedFrames,
      });
    }, 20_000);
  },
);
