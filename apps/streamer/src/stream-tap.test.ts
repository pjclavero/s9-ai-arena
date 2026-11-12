/**
 * DIAG · tap pasivo de la señal de ingesta (tap.ts). Cada garantía tiene su
 * mutante en scripts/stream-tap-mutants.py:
 *
 *  G1 OFF por defecto ............................ TAP-M1, TAP-M2
 *  G2 salida al relé idéntica byte a byte (hash) .. TAP-M3
 *  G3 nunca bloquea ni aplica backpressure ........ TAP-M4, TAP-M5, TAP-M6
 *  G4 rotación y límite ........................... TAP-M7, TAP-M8, TAP-M9
 *  G5 ningún secreto en ficheros, logs ni nombres . TAP-M10
 *  G6 captura el ÚLTIMO keyframe (y es decodificable) TAP-M11
 *
 * Servidor RTMP falso en 127.0.0.1 con puerto efímero; nada sale a la red.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { createLogger, DEFAULT_CONFIG, SecretRegistry } from "./config.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import {
  createTapFromEnv,
  decodeTapJpeg,
  IngestTap,
  loadTapConfig,
  TAP_DEFAULTS,
  TAP_FILE,
  TAP_LATEST,
  type TapConfig,
  type TapFs,
} from "./tap.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer | Buffer[]) => {
  const h = createHash("sha256");
  for (const x of Array.isArray(b) ? b : [b]) h.update(x);
  return h.digest("hex");
};

// ── flujo FLV sintético (determinista) ────────────────────────────────────────
function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}
function flvTag(type: number, ts: number, data: Buffer): Buffer {
  const h = Buffer.alloc(11);
  h[0] = type;
  h.writeUIntBE(data.length, 1, 3);
  h.writeUIntBE(ts & 0xffffff, 4, 3);
  h[7] = (ts >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length, 0);
  return Buffer.concat([h, data, prev]);
}
function videoData(frameType: number, pkt: number, cts: number, body: Buffer): Buffer {
  const h = Buffer.from([(frameType << 4) | 7, pkt, (cts >> 16) & 0xff, (cts >> 8) & 0xff, cts & 0xff]);
  return Buffer.concat([h, body]);
}
const CTS = 66;
interface Synthetic {
  bytes: Buffer;
  keyframes: { dts: number; marker: string; endOffset: number }[];
}
/** FLV con onMetaData, secuencia AVC, keyframe cada 30 frames, P-frames y audio. */
function syntheticFlv(frames = 300, seed = 7): Synthetic {
  const rnd = prng(seed);
  const fill = (n: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i += 4) b.writeUInt32BE(rnd(), Math.min(i, n - 4));
    return b;
  };
  const parts: Buffer[] = [Buffer.from([0x46, 0x4c, 0x56, 1, 0x05, 0, 0, 0, 9, 0, 0, 0, 0])];
  parts.push(flvTag(18, 0, encodeAmf0Values(["onMetaData", { width: 320, height: 240, framerate: 30 }])));
  parts.push(flvTag(9, 0, videoData(1, 0, 0, Buffer.from("AVCC-SEQ-HEADER"))));
  const keyframes: Synthetic["keyframes"] = [];
  let off = parts.reduce((a, p) => a + p.length, 0);
  for (let i = 0; i < frames; i++) {
    const dts = Math.round((i * 1000) / 30);
    const key = i % 30 === 0;
    const marker = `KF#${String(i).padStart(4, "0")}`;
    const body = key ? Buffer.concat([Buffer.from(marker), fill(40_000)]) : fill(4_000);
    const v = flvTag(9, dts, videoData(key ? 1 : 2, 1, CTS, body));
    parts.push(v);
    off += v.length;
    if (key) keyframes.push({ dts, marker, endOffset: off });
    const a = flvTag(8, dts, Buffer.concat([Buffer.from([0xaf, 1]), fill(300)]));
    parts.push(a);
    off += a.length;
  }
  return { bytes: Buffer.concat(parts), keyframes };
}
function chunked(b: Buffer, seed = 3, max = 65_536): Buffer[] {
  const rnd = prng(seed);
  const out: Buffer[] = [];
  for (let i = 0; i < b.length;) {
    const n = 1 + (rnd() % max);
    out.push(Buffer.from(b.subarray(i, i + n))); // trozos independientes, como los de un pipe
    i += n;
  }
  return out;
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `s9-tap-${p}-`));
const cfg = (dir: string, o: Partial<TapConfig> = {}): TapConfig => ({
  ...TAP_DEFAULTS,
  enabled: true,
  dir,
  intervalMs: 3_600_000, // en las unitarias se llama a flush() a mano
  ...o,
});

// ── G1 · OFF por defecto ─────────────────────────────────────────────────────
describe("G1 · el tap está APAGADO por defecto", () => {
  it("sin variables, vacío, 'false', '0' o cualquier otra cosa ⇒ apagado y SIN objeto", () => {
    for (const v of [undefined, "", "false", "0", "no", "off", "yes", "enabled", " FALSE "]) {
      const env = v === undefined ? {} : { STREAM_TAP_ENABLED: v };
      expect(loadTapConfig(env).enabled, String(v)).toBe(false);
      expect(createTapFromEnv(env), String(v)).toBeNull();
    }
    expect(TAP_DEFAULTS.enabled).toBe(false);
  });
  it("sólo 'true' o '1' lo encienden; intervalo y retención configurables y acotados", () => {
    const c = loadTapConfig({
      STREAM_TAP_ENABLED: "true",
      STREAM_TAP_DIR: "/tmp/x",
      STREAM_TAP_INTERVAL_SEC: "5",
      STREAM_TAP_MAX_FILES: "4",
      STREAM_TAP_MAX_MB: "8",
    });
    expect(c).toEqual({ enabled: true, dir: "/tmp/x", intervalMs: 5000, maxFiles: 4, maxBytes: 8 * 1024 * 1024 });
    expect(loadTapConfig({ STREAM_TAP_ENABLED: "1" }).enabled).toBe(true);
    const b = loadTapConfig({ STREAM_TAP_INTERVAL_SEC: "0", STREAM_TAP_MAX_FILES: "100000", STREAM_TAP_MAX_MB: "-3" });
    expect([b.intervalMs, b.maxFiles, b.maxBytes]).toEqual([1000, 200, 1024 * 1024]);
    expect(createTapFromEnv({ STREAM_TAP_ENABLED: "true" })).toBeInstanceOf(IngestTap);
  });
  it("un tap con enabled=false no analiza ni guarda nada", async () => {
    const dir = tmp("off");
    const t = new IngestTap({ ...cfg(dir), enabled: false });
    t.start();
    t.beginStream();
    t.observe(syntheticFlv(60).bytes);
    t.flush();
    await t.whenIdle();
    expect([t.stats.bytesSeen, t.stats.keyframes, readdirSync(dir).length]).toEqual([0, 0, 0]);
  });
});

// ── G6 · qué se captura ──────────────────────────────────────────────────────
describe("G6 · captura el ÚLTIMO keyframe que recibió el relé, con su timestamp y PTS", () => {
  it("trozos aleatorios y byte a byte dan la MISMA captura; es el último keyframe; PTS = DTS + cts", async () => {
    const s = syntheticFlv(300);
    const last = s.keyframes[s.keyframes.length - 1];
    const results: Buffer[] = [];
    for (const [name, chunks] of [
      ["aleatorio", chunked(s.bytes)],
      [
        "byte a byte",
        Array.from(s.bytes.subarray(0, 300_000), (x) => Buffer.from([x])).concat([s.bytes.subarray(300_000)]),
      ],
      ["entero", [s.bytes]],
    ] as const) {
      const dir = tmp("g6");
      const t = new IngestTap(cfg(dir));
      t.start();
      t.beginStream();
      for (const c of chunks) t.observe(c);
      t.flush();
      await t.whenIdle();
      expect(t.stats.keyframes, name).toBe(s.keyframes.length);
      expect(t.latest?.flvTimestampMs, name).toBe(last.dts);
      expect(t.latest?.compositionTimeMs, name).toBe(CTS);
      expect(t.latest?.ptsMs, name).toBe(last.dts + CTS);
      expect(t.latest?.hasAvcSequenceHeader, name).toBe(true);
      const flv = readFileSync(join(dir, t.latest!.file));
      expect(flv.includes(Buffer.from(last.marker)), name).toBe(true);
      expect(flv.includes(Buffer.from("AVCC-SEQ-HEADER")), name).toBe(true);
      expect(flv.includes(Buffer.from("KF#0000")), name).toBe(false);
      results.push(flv);
      // FLV mínimo bien formado: cabecera + 3 etiquetas (meta, secuencia, keyframe) con sello 0.
      expect(flv.toString("latin1", 0, 3)).toBe("FLV");
      let p = 13;
      const types: number[] = [];
      while (p < flv.length) {
        const size = flv.readUIntBE(p + 1, 3);
        expect(flv.readUIntBE(p + 4, 3) | flv[p + 7]).toBe(0);
        types.push(flv[p]);
        p += 11 + size + 4;
      }
      expect(p).toBe(flv.length);
      expect(types).toEqual([18, 9, 9]);
      const json = JSON.parse(readFileSync(join(dir, TAP_LATEST), "utf8"));
      expect(json.file).toBe(t.latest!.file);
    }
    expect(sha(results[1])).toBe(sha(results[0]));
    expect(sha(results[2])).toBe(sha(results[0]));
  });

  it("observe() NO modifica los trozos que recibe (hash antes y después)", async () => {
    const chunks = chunked(syntheticFlv(300).bytes, 11, 20_000);
    const before = chunks.map((c) => sha(c));
    const t = new IngestTap(cfg(tmp("ro")));
    t.start();
    t.beginStream();
    for (const c of chunks) t.observe(c);
    t.flush();
    await t.whenIdle();
    expect(chunks.map((c) => sha(c))).toEqual(before);
  });

  it("basura en el flujo: el tap se apaga para ESE flujo sin lanzar; el siguiente flujo vuelve a analizarse", () => {
    const t = new IngestTap(cfg(tmp("bad")));
    t.beginStream();
    expect(() => t.observe(Buffer.from("esto no es un FLV, es ruido ".repeat(10)))).not.toThrow();
    expect(t.stats.parserDisabled).toBe(true);
    t.beginStream();
    t.observe(syntheticFlv(31).bytes);
    expect([t.stats.parserDisabled, t.stats.keyframes]).toEqual([false, 2]);
  });
});

// ── G3 · nunca bloquea ───────────────────────────────────────────────────────
describe("G3 · el tap nunca bloquea: si su consumidor (el disco) se detiene, descarta", () => {
  it("disco COLGADO: una sola escritura en vuelo, el resto se descarta y observe() sigue a tiempo constante", async () => {
    let calls = 0;
    const hung: TapFs = {
      writeFile: () => {
        calls++;
        return new Promise<void>(() => {}); // nunca termina
      },
      rename: async () => {},
      unlink: async () => {},
    };
    const s = syntheticFlv(600);
    const t = new IngestTap(cfg(tmp("hung")), { fs: hung });
    t.beginStream();
    let flushes = 0;
    let fed = 0;
    for (const k of s.keyframes) {
      t.observe(s.bytes.subarray(fed, k.endOffset));
      fed = k.endOffset;
      t.flush();
      flushes++;
    }
    t.observe(s.bytes.subarray(fed));
    expect(calls).toBe(1);
    expect(t.stats.dropped).toBe(flushes - 1);
    expect(t.stats.keyframes).toBe(s.keyframes.length);
  });

  it("disco que FALLA: cuenta el error, no lanza y sigue capturando", async () => {
    const broken: TapFs = {
      writeFile: async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
      rename: async () => {},
      unlink: async () => {},
    };
    const logs: string[] = [];
    const t = new IngestTap(cfg(tmp("broken")), { fs: broken, log: (_l, m) => logs.push(m) });
    t.beginStream();
    t.observe(syntheticFlv(31).bytes);
    t.flush();
    await t.whenIdle();
    expect([t.stats.writeErrors, t.stats.written]).toEqual([1, 0]);
    expect(logs.length).toBe(1);
  });
});

// ── G4 · rotación y límite ───────────────────────────────────────────────────
/** Alimenta el flujo y guarda una captura tras cada keyframe. */
async function feedCapturing(t: IngestTap, s: Synthetic) {
  let fed = 0;
  t.beginStream();
  for (const k of s.keyframes) {
    t.observe(s.bytes.subarray(fed, k.endOffset));
    fed = k.endOffset;
    t.flush();
    await t.whenIdle();
  }
  t.observe(s.bytes.subarray(fed));
}
const tapFiles = (dir: string) => readdirSync(dir).filter((n) => TAP_FILE.test(n));
const dirBytes = (dir: string) => tapFiles(dir).reduce((a, n) => a + statSync(join(dir, n)).size, 0);

describe("G4 · almacenamiento limitado y rotado", () => {
  it("maxFiles: con 20 keyframes quedan sólo las 3 capturas MÁS RECIENTES (y latest apunta a la última)", async () => {
    const dir = tmp("rot");
    const s = syntheticFlv(600);
    const t = new IngestTap(cfg(dir, { maxFiles: 3 }));
    t.start();
    await feedCapturing(t, s);
    expect(t.stats.written).toBe(20);
    const flvs = tapFiles(dir)
      .filter((n) => n.endsWith(".flv"))
      .sort();
    expect(flvs.length).toBe(3);
    expect(tapFiles(dir).length).toBe(6);
    const latest = JSON.parse(readFileSync(join(dir, TAP_LATEST), "utf8"));
    expect(flvs[2]).toBe(latest.file);
    expect(readFileSync(join(dir, latest.file)).includes(Buffer.from(s.keyframes[19].marker))).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("maxBytes: el total en disco no supera el límite aunque maxFiles sea alto", async () => {
    const dir = tmp("bytes");
    const s = syntheticFlv(600);
    const limit = 1024 * 1024; // ~25 capturas de 40 KB no caben: deben quedar ≤ 1 MiB
    const t = new IngestTap(cfg(dir, { maxFiles: 200, maxBytes: 150_000 }));
    t.start();
    await feedCapturing(t, s);
    expect(t.stats.written).toBe(20);
    expect(dirBytes(dir)).toBeLessThanOrEqual(150_000);
    expect(dirBytes(dir)).toBeLessThan(limit);
    expect(tapFiles(dir).length).toBeGreaterThan(0);
  });

  it("tras un reinicio cuenta las capturas previas; NUNCA borra ficheros que no son del tap", async () => {
    const dir = tmp("restart");
    writeFileSync(join(dir, "otro-fichero.flv"), "no es del tap");
    writeFileSync(join(dir, "tap-notas.json"), "{}");
    const s = syntheticFlv(300);
    const a = new IngestTap(cfg(dir, { maxFiles: 4 }));
    a.start();
    await feedCapturing(a, s);
    a.stop();
    const b = new IngestTap(cfg(dir, { maxFiles: 4 }));
    b.start();
    await feedCapturing(b, s);
    b.stop();
    expect(tapFiles(dir).filter((n) => n.endsWith(".flv")).length).toBe(4);
    expect(readdirSync(dir)).toContain("otro-fichero.flv");
    expect(readdirSync(dir)).toContain("tap-notas.json");
    // La numeración continúa: la última captura es posterior a todas las del primer arranque.
    const seqs = tapFiles(dir).map((n) => Number(/^tap-(\d{8})-/.exec(n)![1]));
    expect(Math.max(...seqs)).toBe(20);
  });
});

// ── Supervisor + relé: G2, G3, G5 ────────────────────────────────────────────
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const FIXED_S1 = Buffer.alloc(1536, 0x5a);
/** Ingesta RTMP falsa: S1 fijo (C2 determinista) y registro de TODO lo que llega tras C0+C1. */
async function fakeIngest() {
  const seen = { afterC1: [] as Buffer[], bytes: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" | "media" = "c0c1";
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
      if (phase !== "c0c1") {
        seen.afterC1.push(Buffer.from(d));
        seen.bytes += d.length;
      }
      if (phase === "media") return;
      buf = Buffer.concat([buf, d]);
      if (phase === "c0c1") {
        if (buf.length < 1537) return;
        const rest = buf.subarray(1537);
        if (rest.length) {
          seen.afterC1.push(Buffer.from(rest));
          seen.bytes += rest.length;
        }
        sock.write(Buffer.concat([Buffer.from([3]), FIXED_S1, buf.subarray(1, 1537)]));
        buf = rest;
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
          reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
          phase = "media";
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, dial: (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port }) as Duplex };
}

class FakeMedia extends EventEmitter {
  pauses = 0;
  pause() {
    this.pauses++;
  }
  resume() {}
}
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new FakeMedia();
  stdio = [null, null, null, this.media] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

const KEY = `tap-${randomBytes(12).toString("hex")}-Kq`;
/** ¿Sobrevive algún trozo de ≥8 de la clave (tal cual, hex o base64) en `b`? */
function leaked(b: Buffer | string, k = KEY): string[] {
  const text = (typeof b === "string" ? b : b.toString("latin1")).toLowerCase();
  const forms = [k, Buffer.from(k).toString("hex"), Buffer.from(k).toString("base64").replace(/=+$/, "")];
  const out: string[] = [];
  for (const f of forms)
    for (let i = 0; i + 8 <= f.length; i++)
      if (text.includes(f.slice(i, i + 8).toLowerCase())) out.push(f.slice(i, i + 8));
  return out;
}

interface RunOpts {
  tap?: IngestTap | { beginStream(): void; observe(c: Buffer): void } | null;
  chunks: Buffer[];
}
/** Una emisión con el supervisor REAL y el relé REAL contra la ingesta falsa. */
async function run(o: RunOpts) {
  const ing = await fakeIngest();
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const children: FakeChild[] = [];
  const config = { ...DEFAULT_CONFIG, retryDelayMs: 10, maxRetries: 1 };
  const fed: Buffer[] = [];
  const orig = RtmpPublisher.prototype.writeFlv;
  RtmpPublisher.prototype.writeFlv = function (this: RtmpPublisher, c: Buffer) {
    fed.push(Buffer.from(c));
    return orig.call(this, c);
  };
  try {
    const sup = new StreamSupervisor({
      config,
      spawner: (_c, _a, so) => {
        const ch = new FakeChild();
        if (so?.mediaFd) children.push(ch);
        return ch;
      },
      logger,
      secrets,
      streamKey: KEY,
      dial: ing.dial,
      tap: o.tap as IngestTap | null,
    });
    sup.start();
    for (let i = 0; i < 200 && sup.relayState !== "publishing"; i++) await sleep(10);
    expect(sup.relayState).toBe("publishing");
    const media = children[0].media;
    const emitErrors: unknown[] = [];
    for (let i = 0; i < o.chunks.length; i++) {
      try {
        media.emit("data", o.chunks[i]);
      } catch (e) {
        emitErrors.push(e);
      }
      if (i % 16 === 15) await sleep(1);
    }
    let last = -1;
    for (let i = 0; i < 300 && ing.seen.bytes !== last; i++) {
      last = ing.seen.bytes;
      await sleep(20);
    }
    const relayHash = sha(ing.seen.afterC1);
    const result = {
      relayHash,
      relayBytes: ing.seen.bytes,
      fedHash: sha(fed),
      pauses: media.pauses,
      emitErrors,
      lines,
      sup,
    };
    sup.stop();
    return result;
  } finally {
    RtmpPublisher.prototype.writeFlv = orig;
  }
}

describe("G2/G3 · la salida al relé es IDÉNTICA con el tap encendido y apagado", () => {
  it("hash del flujo que recibe el relé y de lo que el relé envía a la ingesta: OFF == ON (con el disco del tap colgado)", async () => {
    const s = syntheticFlv(300);
    const chunks = chunked(s.bytes, 5, 32_768);
    const off = await run({ tap: null, chunks });
    let writes = 0;
    const hung: TapFs = {
      writeFile: () => {
        writes++;
        return new Promise<void>(() => {});
      },
      rename: async () => {},
      unlink: async () => {},
    };
    const tap = new IngestTap(cfg(tmp("sup-on"), { intervalMs: 5 }), { fs: hung });
    tap.start();
    const on = await run({ tap, chunks });
    tap.stop();
    // El tap vio TODO el flujo, se atascó en el disco y descartó: aun así, nada cambia.
    expect(tap.stats.bytesSeen).toBe(s.bytes.length);
    expect(tap.stats.keyframes).toBe(s.keyframes.length);
    expect(writes).toBe(1);
    expect(tap.stats.dropped).toBeGreaterThan(0);
    expect(off.fedHash).toBe(sha(s.bytes));
    expect(on.fedHash).toBe(off.fedHash);
    expect(on.relayBytes).toBe(off.relayBytes);
    expect(on.relayHash).toBe(off.relayHash);
    // Sin contrapresión de ningún lado (la ingesta lee rápido) y sin errores.
    expect([off.pauses, on.pauses]).toEqual([0, 0]);
    expect(on.emitErrors).toEqual([]);
  }, 30_000);

  it("un tap que LANZA en cada trozo no rompe la emisión ni cambia un byte", async () => {
    const s = syntheticFlv(120);
    const chunks = chunked(s.bytes, 9, 16_384);
    const off = await run({ tap: null, chunks });
    const angry = {
      beginStream() {},
      observe() {
        throw new Error("consumidor del tap roto");
      },
    };
    const on = await run({ tap: angry, chunks });
    expect(on.emitErrors).toEqual([]);
    expect(on.relayHash).toBe(off.relayHash);
    expect(on.fedHash).toBe(off.fedHash);
  }, 30_000);
});

describe("G5 · ningún secreto en ficheros, nombres, logs ni respuestas del tap", () => {
  it("emisión con clave y tap encendido: ni los ficheros, ni sus nombres, ni los logs, ni /diag/tap* llevan la clave", async () => {
    const dir = tmp("secret");
    const logs: string[] = [];
    const tap = new IngestTap(cfg(dir, { intervalMs: 5 }), {
      log: (l, m, e) => logs.push(JSON.stringify({ l, m, e })),
    });
    tap.start();
    const s = syntheticFlv(300);
    const r = await run({ tap, chunks: chunked(s.bytes, 13, 32_768) });
    tap.flush();
    await tap.whenIdle();
    tap.stop();
    expect(tap.stats.written).toBeGreaterThan(0);
    // Control positivo: la clave SÍ viajó por el relé (publish), así que el detector funciona.
    const config = { ...DEFAULT_CONFIG };
    const control = createControlServer({
      supervisor: r.sup,
      config,
      logger: createLogger(null, () => {}),
      controlSecret: "diag-secret",
      requireControlSecret: true,
      tap,
      decodeJpeg: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    servers.push(control as unknown as Server);
    await new Promise<void>((res) => control.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
    const h = { "x-streamer-auth": "diag-secret" };
    expect((await fetch(`${base}/diag/tap`)).status).toBe(401);
    const bodies: string[] = [];
    for (const p of ["/diag/tap", "/diag/tap/latest", "/diag/tap/latest.flv", "/diag/tap/latest.jpg"]) {
      const res = await fetch(`${base}${p}`, { headers: h });
      expect(res.status, p).toBe(200);
      bodies.push(JSON.stringify([...res.headers]), Buffer.from(await res.arrayBuffer()).toString("latin1"));
    }
    const names = readdirSync(dir);
    const contents = names.map((n) => readFileSync(join(dir, n)));
    expect({
      names: leaked(names.join("\n")),
      contents: contents.flatMap((c) => leaked(c)),
      tapLogs: leaked(logs.join("\n")),
      streamerLogs: leaked(r.lines.join("\n")),
      responses: leaked(bodies.join("\n")),
      stats: leaked(JSON.stringify(tap.stats)),
    }).toEqual({ names: [], contents: [], tapLogs: [], streamerLogs: [], responses: [], stats: [] });
    expect(leaked(`publish ${KEY}`).length).toBeGreaterThan(0); // el detector detecta
  }, 30_000);

  it("con el tap APAGADO el control responde enabled=false y 404 a las capturas (y exige el secreto)", async () => {
    const sup = new StreamSupervisor({
      config: DEFAULT_CONFIG,
      spawner: () => new FakeChild(),
      logger: createLogger(null, () => {}),
    });
    const control = createControlServer({
      supervisor: sup,
      config: DEFAULT_CONFIG,
      logger: createLogger(null, () => {}),
      controlSecret: "diag-secret",
      requireControlSecret: true,
    });
    servers.push(control as unknown as Server);
    await new Promise<void>((res) => control.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
    const h = { "x-streamer-auth": "diag-secret" };
    expect((await fetch(`${base}/diag/tap/latest`)).status).toBe(401);
    expect(await (await fetch(`${base}/diag/tap`, { headers: h })).json()).toMatchObject({
      enabled: false,
      stats: null,
    });
    expect((await fetch(`${base}/diag/tap/latest`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/diag/tap/latest.jpg`, { headers: h })).status).toBe(404);
  });
});

// ── G6 con ffmpeg REAL: la captura es decodificable y es el fotograma correcto ─
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const mustRunFfmpeg = process.env.CI === "true";

/** Color medio (r,g,b) de un JPEG, decodificado con ffmpeg a 1×1. */
function meanRgb(jpg: Buffer): number[] {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { input: jpg },
  );
  return [raw[0], raw[1], raw[2]];
}

describe.skipIf(!hasFfmpeg && !mustRunFfmpeg)("G6 · con el FLV REAL de ffmpeg (libx264, B-frames)", () => {
  it("la CI tiene ffmpeg (si no, este test falla en vez de saltarse)", () => {
    expect(hasFfmpeg).toBe(true);
  });
  it("1 s ROJO y 1 s AZUL: la captura a mitad es roja, la final es azul; ambas se decodifican a JPG a demanda", async () => {
    const flv = execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x120:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x120:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-g",
        "15",
        "-bf",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        "pipe:1",
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const dir = tmp("real");
    const t = new IngestTap(cfg(dir));
    t.start();
    t.beginStream();
    const chunks = chunked(flv, 21, 4096);
    let i = 0;
    while (i < chunks.length && t.stats.keyframes < 1) t.observe(chunks[i++]);
    t.flush();
    await t.whenIdle();
    const first = t.latest!;
    const jpgRed = await decodeTapJpeg("ffmpeg", join(dir, first.file));
    expect(jpgRed.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const [r1, , b1] = meanRgb(jpgRed);
    expect(r1).toBeGreaterThan(200);
    expect(b1).toBeLessThan(60);
    while (i < chunks.length) t.observe(chunks[i++]);
    t.flush();
    await t.whenIdle();
    const last = t.latest!;
    expect(t.stats.keyframes).toBeGreaterThanOrEqual(4);
    expect(last.ptsMs).toBeGreaterThanOrEqual(1000);
    expect(last.ptsMs).toBe(last.flvTimestampMs + last.compositionTimeMs);
    const [r2, , b2] = meanRgb(await decodeTapJpeg("ffmpeg", join(dir, last.file)));
    expect(b2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(60);
  }, 30_000);
});
