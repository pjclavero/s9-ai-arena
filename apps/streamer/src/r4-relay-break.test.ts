/**
 * Revisión independiente · ronda 4 del PR #227 (sobre 25bc372) · streamer.
 * NO es una suite del autor y NO se mergea. Arnés RTMP falso copiado de
 * r3-relay-break.test.ts (127.0.0.1, puerto efímero; nada sale a la red).
 *  - `CONTROL`: lo que la entrega resiste.  - `OBS`: comportamiento medido que se informa.
 */
import { randomBytes } from "node:crypto";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { createLogger, foldSameLength, redactSecret, REDACT_MIN_FRAGMENT, SecretRegistry } from "./config.js";

const KEY = `r4-${randomBytes(12).toString("hex")}-Zq`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

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

// ── R3-A · foldSameLength / redactSecret ────────────────────────────────────
/** Caracteres hostiles: cambian de longitud o de forma al pasar a minúsculas, o se combinan. */
const HOSTILE = [
  "İ", // İ  → i̇ (2 unidades con toLowerCase)
  "ß", // ß
  "ẞ", // ẞ  → ß
  "ﬁ", // ﬁ
  "Σ", // Σ  (sigma final dependiente del contexto en toLowerCase de cadena)
  "ς", // ς
  "́", // acento agudo combinante
  "‍", // ZWJ
  "ǅ", // ǅ (titlecase)
  "K", // K Kelvin → k
  "ſ", // ſ
  "ı", // ı
  "𐐀", // 𐐀 Deseret (astral, cambia a 𐐨)
  "👨‍👩", // emoji con ZWJ
  "\ud800", // surrogate alto suelto
  "\udc00", // surrogate bajo suelto
  "İ", // I + punto combinante
];
function rnd(n: number) {
  return randomBytes(4).readUInt32BE(0) % n;
}
function hostile(len: number) {
  let s = "";
  for (let i = 0; i < len; i++) s += rnd(3) === 0 ? String.fromCharCode(0x20 + rnd(95)) : HOSTILE[rnd(HOSTILE.length)];
  return s;
}
/** Comprobación independiente: ningún 8-grama de ninguna forma sobrevive, comparando con plegado de ESTE test. */
function survivingGrams(out: string, forms: string[]) {
  const f = (x: string) =>
    [...x]
      .map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c.length === 1 ? c.toLowerCase()[0] : c))
      .join("");
  const lo = f(out);
  const bad: string[] = [];
  for (const form of forms) {
    const lf = f(form);
    const n = Math.min(REDACT_MIN_FRAGMENT, lf.length);
    for (let i = 0; i + n <= lf.length; i++) if (lo.includes(lf.slice(i, i + n))) bad.push(lf.slice(i, i + n));
  }
  return bad;
}
function formsOf(key: string) {
  const b = Buffer.from(key, "utf8");
  const forms = [
    key,
    JSON.stringify(key).slice(1, -1),
    encodeURIComponent(key),
    b.toString("hex"),
    b.toString("hex").toUpperCase(),
  ];
  for (let o = 0; o < 3; o++) {
    const n = Math.floor((b.length - o) / 3) * 3;
    if (n > 0) {
      const s = b.subarray(o, o + n).toString("base64");
      forms.push(s, s.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return forms;
}

describe("R4 · R3-A · plegado de longitud constante", () => {
  it("CONTROL · foldSameLength conserva la longitud y la alineación carácter a carácter (5 000 cadenas hostiles)", () => {
    for (let k = 0; k < 5000; k++) {
      const t = hostile(1 + rnd(40));
      const f = foldSameLength(t);
      expect(f.length).toBe(t.length);
      // Alineación: cada punto de código del original ocupa las mismas posiciones en el plegado.
      for (let i = 0; i < t.length;) {
        const w = (t.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
        expect(foldSameLength(t.slice(i, i + w)), JSON.stringify(t)).toBe(f.slice(i, i + w));
        i += w;
      }
    }
  });

  it("CONTROL · clave ASCII (forma de la API) con prefijo/sufijo hostil y en todas sus codificaciones (tal cual, MAYÚSCULAS, JSON, URL, hex, base64 ×3 alineaciones, url-safe): no sobrevive ningún 8-grama (2 000 casos)", () => {
    for (let k = 0; k < 2000; k++) {
      const key = `${randomBytes(4).toString("hex")}-${randomBytes(3).toString("base64url")}-${randomBytes(4).toString("hex")}`;
      const forms = formsOf(key);
      const pick = [...forms, key.toUpperCase()][rnd(forms.length + 1)];
      // Trozo de la clave dentro de un texto más largo codificado en base64 (alineación arbitraria).
      const wrapped = Buffer.from(`${"x".repeat(rnd(3))}${key}${"y".repeat(rnd(3))}`).toString("base64");
      const text = `${hostile(rnd(30))}${pick}${hostile(rnd(10))} ${wrapped} ${hostile(rnd(10))}`;
      const out = redactSecret(text, key);
      expect(survivingGrams(out, forms), JSON.stringify({ key, text, out })).toEqual([]);
    }
  });

  it("CONTROL · clave HEREDADA no ASCII (fichero STREAM_KEY_FILE) con İ/ß/ﬁ/Σ/combinantes/astrales/ZWJ/ǅ: tal cual o con letras ASCII en mayúsculas, no sobrevive (2 000 casos)", () => {
    for (let k = 0; k < 2000; k++) {
      // Una clave leída de fichero UTF-8 no puede tener surrogates sueltos (se decodifican a U+FFFD).
      const key = `${randomBytes(3).toString("hex")}${(hostile(6) as unknown as { toWellFormed(): string }).toWellFormed()}${randomBytes(3).toString("hex")}`;
      const forms = formsOf(key);
      const variant = rnd(2) === 0 ? key : key.replace(/[a-z]/g, (c) => c.toUpperCase());
      const text = `${hostile(rnd(25))}${variant}${hostile(rnd(25))}`;
      const out = redactSecret(text, key);
      expect(survivingGrams(out, forms), JSON.stringify({ key, text, out })).toEqual([]);
      expect(out.includes(key)).toBe(false);
    }
  });

  it("CONTROL · el logger sigue emitiendo JSON válido con claves realistas (forma YouTube) y texto hostil, incluida la sobre-redacción documentada de `streamer` (3 000 líneas)", () => {
    const lines: string[] = [];
    const reg = new SecretRegistry();
    const log = createLogger(reg, (l) => lines.push(l));
    for (let k = 0; k < 3000; k++) {
      const key =
        k % 10 === 0
          ? `ab${"streamer"}cd-${randomBytes(4).toString("hex")}` // contiene una palabra del log
          : Array.from({ length: 5 }, () => randomBytes(3).toString("hex").slice(0, 4)).join("-");
      reg.add(key);
      log("error", `fallo ${hostile(rnd(20))}`, {
        detail: `${hostile(rnd(10))}${key}${hostile(rnd(10))}`,
        url: `rtmps://a/live2/${key}`,
      });
      reg.delete(key);
      const line = lines[lines.length - 1];
      expect(() => JSON.parse(line), line).not.toThrow();
      expect(line.includes(key)).toBe(false);
    }
  });

  it('OBS P3 · una clave ADMITIDA por la API (`validStreamKey`: ASCII imprimible, incluye `"`) que contiene `streamer"` rompe el JSON de la línea de log: se redacta el texto ya serializado', () => {
    const lines: string[] = [];
    const key = `Zq9streamer"Zq9x`; // ASCII imprimible, 8..256: la API la acepta
    const log = createLogger(key, (l) => lines.push(l));
    log("info", "relé publicando", {});
    let parsed = true;
    try {
      JSON.parse(lines[0]);
    } catch {
      parsed = false;
    }
    expect({ line: lines[0], parsed }).toMatchObject({ parsed: false });
  });
});

// ── R3-C · plazo de escritura ──────────────────────────────────────────────
async function relayWith(W: number, read: (gd: GatedDuplex) => void) {
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
  gd.gated = true;
  read(gd);
  return {
    pub,
    get err() {
      return err as Error | null;
    },
    get gd() {
      return gd;
    },
  };
}

describe("R4 · R3-C · plazo de escritura", () => {
  it("CONTROL · ingesta que deja de leer del todo ⇒ write_timeout y SIN timer de plazo vivo tras el fallo", async () => {
    const W = 300;
    const r = await relayWith(W, () => {});
    const p = pump(r.pub, 0, 200_000);
    await sleep(W * 6);
    p.stop();
    expect(r.err?.message ?? "").toMatch(/plazo de escritura/);
    expect((r.pub as unknown as { stallTimer: unknown }).stallTimer).toBeNull();
    r.pub.close();
  }, 20_000);

  it("CONTROL · close() con el plazo armado lo desarma (sin fugas de timers)", async () => {
    const W = 5000;
    const r = await relayWith(W, () => {});
    const p = pump(r.pub, 0, 200_000);
    for (let i = 0; i < 200 && !p.paused; i++) await sleep(10);
    expect(p.paused).toBe(true);
    expect((r.pub as unknown as { stallTimer: unknown }).stallTimer).not.toBeNull();
    p.stop();
    r.pub.close();
    expect((r.pub as unknown as { stallTimer: unknown }).stallTimer).toBeNull();
  }, 20_000);

  it("OBS P3 · sin caudal mínimo: una ingesta que lee UN fotograma (~83 KB) por plazo sigue «publishing» indefinidamente (con W=10 s reales ≈ 67 kbit/s frente a 20 Mbit/s)", async () => {
    const W = 300;
    let tick: NodeJS.Timeout | null = null;
    const r = await relayWith(W, (gd) => {
      tick = setInterval(() => gd.release(90_000), W * 0.9);
    });
    const p = pump(r.pub, 0, 20_000);
    await sleep(W * 12);
    p.stop();
    if (tick) clearInterval(tick);
    const view = { state: r.pub.state, err: r.err?.message ?? null };
    r.pub.close();
    expect(view).toEqual({ state: "publishing", err: null });
  }, 20_000);
});
