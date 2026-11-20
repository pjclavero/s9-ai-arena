/**
 * Revisión independiente · ronda 3 del PR #227 (sobre 787db33) · streamer.
 * NO es una suite del autor y NO se mergea.
 *
 *  - `CIERRE`: hallazgo de la ronda 2 cerrado por el arreglo (verde en 787db33).
 *  - `DEFECTO`: hallazgo NUEVO de la ronda 3, en ROJO a propósito sobre 787db33.
 *  - `CONTROL`: lo que la entrega resiste.
 * Servidores RTMP falsos en 127.0.0.1 con puerto efímero; nada sale a la red.
 */
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG, redactSecret, SecretRegistry } from "./config.js";
import { sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `r3-${randomBytes(12).toString("hex")}-Zq`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** ¿Sobrevive algún trozo de ≥8 caracteres de la clave (tal cual, sin distinguir mayúsculas)? */
function leaked(text: string, k = KEY): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  for (let i = 0; i + 8 <= k.length; i++) if (t.includes(k.slice(i, i + 8).toLowerCase())) out.push(k.slice(i, i + 8));
  return out;
}

type IngestOpts = {
  /** Descripción del rechazo de `publish` (recibe la clave publicada). */
  rejectWith?: (key: string) => string;
  /** Tras Publish.Start: patrón de lectura. */
  afterPublish?: (sock: Socket) => void;
};

async function fakeIngest(o: IngestOpts) {
  const seen = { published: [] as string[], bytesAfterPublish: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" | "media" = "c0c1";
    const s1 = randomBytes(1536);
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
      if (phase === "media") {
        seen.bytesAfterPublish += d.length;
        return;
      }
      buf = Buffer.concat([buf, d]);
      if (phase === "c0c1") {
        if (buf.length < 1537) return;
        sock.write(Buffer.concat([Buffer.from([3]), s1, buf.subarray(1, 1537)]));
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
          const key = String(v[3]);
          if (o.rejectWith) {
            reply(
              "onStatus",
              0,
              [null, { level: "error", code: "NetStream.Publish.BadName", description: o.rejectWith(key) }],
              1,
            );
            continue;
          }
          seen.published.push(key);
          reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
          phase = "media";
          o.afterPublish?.(sock);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, dial: (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port }) as Duplex };
}

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdio = [
    null,
    null,
    null,
    Object.assign(new EventEmitter(), { pause() {}, resume() {} }),
  ] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

async function control(dial: (t: IngestTarget) => Duplex) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config = { ...DEFAULT_CONFIG, retryDelayMs: 10, maxRetries: 1 };
  const sup = new StreamSupervisor({ config, spawner: () => new FakeChild(), logger, secrets, dial });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: false },
    controlSecret: "s3cr3t-r3",
    requireControlSecret: true,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => null,
    dial,
    testDeadlineMs: 1500,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { "content-type": "application/json", "x-streamer-auth": "s3cr3t-r3" };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const status = async () => (await (await fetch(`${base}/status`, { headers: h })).json()) as Record<string, unknown>;
  return { sup, post, status, lines };
}

// ── Redacción ───────────────────────────────────────────────────────────────
describe("R3 · redacción: lo que la entrega resiste (fragmentos ≥8, base64 url-safe, hex)", () => {
  const bytes = Buffer.from(KEY);
  const cases: Array<[string, string]> = [
    ["tal cual", `x ${KEY} y`],
    ["MAYÚSCULAS", `x ${KEY.toUpperCase()} y`],
    ["fragmento de 8 en medio", `x ${KEY.slice(5, 13)} y`],
    ["hex minúsculas", bytes.toString("hex")],
    ["hex MAYÚSCULAS", bytes.toString("hex").toUpperCase()],
    ["hex de un fragmento a desfase impar", `0${bytes.subarray(3, 15).toString("hex")}`],
    ["base64 estándar", bytes.toString("base64")],
    ["base64 url-safe sin relleno", bytes.toString("base64url")],
    ["base64 con la clave desplazada 1 byte", Buffer.concat([Buffer.from("A"), bytes]).toString("base64")],
    ["base64 con la clave desplazada 2 bytes", Buffer.concat([Buffer.from("AB"), bytes]).toString("base64url")],
    ["JSON escapado", JSON.stringify({ k: KEY })],
    ["URL-codificada", encodeURIComponent(`k=${KEY}`)],
  ];
  for (const [name, text] of cases) {
    it(`CONTROL · ${name}: no sobrevive un trozo de ≥8 de ninguna forma`, () => {
      const out = redactSecret(text, KEY);
      const b64 = bytes.toString("base64").replace(/=+$/, "");
      const hex = bytes.toString("hex");
      const forms = [KEY, hex, b64, bytes.toString("base64url")];
      const survivors = forms.flatMap((f) => {
        const r: string[] = [];
        for (let i = 0; i + 12 <= f.length; i++)
          if (out.toLowerCase().includes(f.slice(i, i + 12).toLowerCase())) r.push(f.slice(i, i + 12));
        return r;
      });
      expect(survivors, out).toEqual([]);
    });
  }
  it("CONTROL · sin falsos positivos con una clave aleatoria: una línea de log real (UUID, URL, argv) queda intacta y sigue siendo JSON", () => {
    const line = JSON.stringify({
      level: "info",
      service: "streamer",
      msg: "ffmpeg lanzado",
      target: "rtmps://a.rtmps.youtube.com/live2",
      sessionId: "8c0f6c3e-9a1b-4f7e-8d2a-1b3c5d7e9f01",
      argv: "-f x11grab -video_size 1920x1080 -framerate 30 -i :99 -c:v libx264 -b:v 4500k -f flv pipe:3",
    });
    for (let i = 0; i < 200; i++) {
      const k = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`;
      expect(redactSecret(line, k)).toBe(line);
    }
  });
});

describe("R3 · DEFECTO P3 · la redacción se salta con caracteres que cambian de longitud al pasar a minúsculas", () => {
  it("DEFECTO P3 · redactSecret: 'İ' (U+0130) ×N delante de la clave desplaza la marca y la clave sale ENTERA", () => {
    const out = redactSecret(`${"İ".repeat(KEY.length)}${KEY}`, KEY);
    expect(leaked(out), out).toEqual([]);
  });
  it("DEFECTO P3 · ingesta hostil: el rechazo de `publish` con 'İ'×N + clave llega a /status (lastError) y a los logs", async () => {
    const ing = await fakeIngest({ rejectWith: (k) => `${"İ".repeat(40)}${k}` });
    const c = await control(ing.dial);
    const url = "rtmps://ingest.example/live2";
    await c.post("/control/start", {
      sessionId: "s-r3",
      mode: "rtmps",
      ingestUrl: url,
      platform: "custom",
      credential: sealSecret(KEY, PUB, { platform: "custom", ingest: url }),
    });
    let st = await c.status();
    for (let i = 0; i < 100 && st.state !== "failed"; i++) {
      await sleep(30);
      st = await c.status();
    }
    c.sup.stop();
    expect(st.lastError).not.toBeNull(); // control: el rechazo llegó
    expect({ status: leaked(JSON.stringify(st)), logs: leaked(c.lines.join("\n")) }).toEqual({ status: [], logs: [] });
  }, 20_000);
});

// ── Plazo de escritura ──────────────────────────────────────────────────────
/** Lo que hace el supervisor: escribir mientras writeFlv diga que sí; si no, parar hasta 'drain'. */
function pump(pub: RtmpPublisher, ms: number, kbps: number) {
  let ts = 0;
  let paused = false;
  let wrote = 0;
  pub.on("drain", () => (paused = false));
  pub.writeFlv(Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]));
  const per = Math.round((kbps * 1000) / 8 / 30); // bytes por frame a 30 fps
  const t = setInterval(() => {
    if (paused || pub.state === "closed") return;
    const b = Buffer.alloc(11 + per + 4);
    b[0] = 9;
    b.writeUIntBE(per, 1, 3);
    b.writeUIntBE((ts += 33) & 0xffffff, 4, 3);
    b.writeUInt32BE(11 + per, 11 + per);
    wrote += b.length;
    if (!pub.writeFlv(b)) paused = true;
  }, 33);
  return {
    stop: () => clearInterval(t),
    get paused() {
      return paused;
    },
    get wrote() {
      return wrote;
    },
  };
}

describe("R3 · plazo de escritura del relé (P3-4 de la ronda 2)", () => {
  it("CONTROL · ingesta lenta pero LEGÍTIMA (lee a ráfagas con pausas de 1,5 s, por encima del bitrate) durante 3× el plazo: no se corta", async () => {
    const ing = await fakeIngest({
      afterPublish: (sock) => {
        const t = setInterval(() => {
          sock.pause();
          setTimeout(() => sock.resume(), 1500);
        }, 2000);
        sock.on("close", () => clearInterval(t));
      },
    });
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.example/live2"),
      streamKey: KEY,
      dial: ing.dial,
      connectTimeoutMs: 2000,
    });
    let err: Error | null = null;
    pub.on("error", (e: Error) => (err = e));
    await pub.start();
    const p = pump(pub, 6000, 40_000); // 40 Mbit/s: satura el socket a ratos
    await sleep(6000);
    p.stop();
    const view = { state: pub.state, err: (err as Error | null)?.message ?? null, read: ing.seen.bytesAfterPublish };
    pub.close();
    expect(view.read).toBeGreaterThan(0);
    expect({ state: view.state, err: view.err }).toEqual({ state: "publishing", err: null });
  }, 20_000);

  /**
   * Camino de envío con presupuesto de bytes: modela el socket TCP cuyo par deja
   * de leer (el `_write` no se confirma) y luego lee EXACTAMENTE `release(n)`
   * bytes. `writableLength` y 'drain' tienen la semántica real de Node.
   */
  class GatedDuplex extends Duplex {
    gated = false;
    budget = 0;
    private pending: { chunk: Buffer; cb: (e?: Error | null) => void } | null = null;
    constructor(private readonly inner: Socket) {
      super();
      inner.on("data", (d: Buffer) => this.push(d));
      inner.on("close", () => this.destroy());
      inner.on("error", (e) => this.destroy(e));
    }
    _read() {}
    _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
      if (!this.gated) return void this.inner.write(chunk, cb);
      if (this.budget >= chunk.length) {
        this.budget -= chunk.length;
        return void this.inner.write(chunk, cb);
      }
      this.pending = { chunk, cb };
    }
    release(n: number) {
      this.budget += n;
      const p = this.pending;
      if (p && this.budget >= p.chunk.length) {
        this.pending = null;
        this.budget -= p.chunk.length;
        this.inner.write(p.chunk, p.cb);
      }
    }
    _destroy(e: Error | null, cb: (e: Error | null) => void) {
      this.inner.destroy();
      cb(e);
    }
  }

  async function stalledRelay(W: number, releaseBytes: number | null) {
    const ing = await fakeIngest({});
    let gd!: GatedDuplex;
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.example/live2"),
      streamKey: KEY,
      dial: (t) => (gd = new GatedDuplex(ing.dial(t) as Socket)),
      connectTimeoutMs: 2000,
      writeTimeoutMs: W,
    });
    let err: Error | null = null;
    pub.on("error", (e: Error) => (err = e));
    await pub.start();
    gd.gated = true; // la ingesta deja de leer ya publicando
    // Productor como el supervisor: escribe mientras writeFlv diga que sí y reanuda con 'drain'.
    const p = pump(pub, 0, 200_000);
    for (let i = 0; i < 200 && !p.paused; i++) await sleep(10);
    const pausedAt = p.paused; // control: la contrapresión llegó
    if (releaseBytes !== null) setTimeout(() => gd.release(releaseBytes), W * 0.6); // lee un poco… y se cuelga
    await sleep(W * 8);
    p.stop();
    const view = {
      pausedAt,
      state: pub.state,
      err: (err as Error | null)?.message ?? null,
      writableLength: gd.writableLength,
    };
    pub.close();
    return view;
  }

  it("CONTROL (calibración del arnés) · la ingesta deja de leer del todo ⇒ write_timeout cerca del plazo", async () => {
    const v = await stalledRelay(400, null);
    expect(v.pausedAt).toBe(true);
    expect(v.err, JSON.stringify(v)).toMatch(/plazo de escritura/);
  }, 20_000);

  it("DEFECTO P3 · la ingesta lee 1 MiB poco antes de vencer el plazo y se cuelga: el plazo NO se rearma y el relé queda «publishing» para siempre", async () => {
    const v = await stalledRelay(400, 1024 * 1024);
    expect(v.pausedAt).toBe(true); // control: la contrapresión llegó
    expect(v.writableLength).toBeGreaterThan(0); // sigue sin poder escribir (sin 'drain')
    // Exigible: un relé que sigue sin poder escribir pasado el plazo falla (y el supervisor reintenta).
    expect(v.state === "closed" || v.err !== null, JSON.stringify(v)).toBe(true);
  }, 20_000);
});
