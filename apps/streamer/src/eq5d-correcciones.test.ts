/**
 * EQ5d · Regresiones propias de las correcciones de la re-revisión EQ6c (ronda 2)
 * en el streamer y en packages/stream-secrets. Complementan (no sustituyen) las
 * pruebas de rotura del revisor (eq6c-relay-break.test.ts).
 *
 *  - P3-2 · GCM: sólo etiquetas de 16 bytes (y IV de 12) en base64 canónico; los
 *    sobres que no se abren quedan REGISTRADOS (sin material secreto).
 *  - P3-3 · redacción: fragmentos de ≥8 caracteres de la clave, de su base64
 *    (estándar/URL-safe, cualquier alineación) y de su hex.
 *  - P3-4 · plazo de escritura del relé ya publicando.
 *
 * Servidores RTMP falsos en 127.0.0.1 con puerto efímero; nada sale a la red.
 */
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { parseIngestUrl, RtmpPublisher } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG, redactSecret, REDACT_MIN_FRAGMENT, SecretRegistry } from "./config.js";
import { isSealedSecret, openSecret, sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `eq5d-${randomBytes(12).toString("hex")}-Qx`;
const YT = { platform: "youtube", ingest: "rtmps://a.rtmps.youtube.com/live2" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

// ── P3-2 · GCM ──────────────────────────────────────────────────────────────
describe("EQ5d · P3-2 · etiqueta e IV de GCM de longitud exacta", () => {
  const s = sealSecret(KEY, PUB, YT);
  const tagBytes = Buffer.from(s.tag, "base64");
  const ivBytes = Buffer.from(s.iv, "base64");

  it("el sobre legítimo trae etiqueta de 16 bytes e IV de 12, y se abre", () => {
    expect(tagBytes.length).toBe(16);
    expect(ivBytes.length).toBe(12);
    expect(isSealedSecret(s)).toBe(true);
    expect(openSecret(s, PRIV, YT)).toBe(KEY);
  });

  for (const n of [1, 4, 8, 12, 15]) {
    it(`etiqueta truncada a ${n} bytes ⇒ formato inválido (no llega a GCM)`, () => {
      const short = { ...s, tag: tagBytes.subarray(0, n).toString("base64") };
      expect(isSealedSecret(short)).toBe(false);
      expect(() => openSecret(short, PRIV, YT)).toThrow(/formato inválido/);
    });
  }

  it("etiqueta de 17 bytes, IV de 8 o 16 bytes y base64 no canónico ⇒ rechazo", () => {
    const variants = [
      { ...s, tag: Buffer.concat([tagBytes, Buffer.from([0])]).toString("base64") },
      { ...s, iv: ivBytes.subarray(0, 8).toString("base64") },
      { ...s, iv: Buffer.concat([ivBytes, Buffer.alloc(4)]).toString("base64") },
      // Mismos 16 bytes, pero con relleno sobrante: Buffer.from lo aceptaría.
      { ...s, tag: `${s.tag}==` },
    ];
    for (const v of variants) {
      expect(isSealedSecret(v), JSON.stringify({ tag: v.tag, iv: v.iv })).toBe(false);
      expect(() => openSecret(v, PRIV, YT)).toThrow();
    }
  });
});

// ── P3-2 · registro de los sobres rechazados ────────────────────────────────
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

async function control(dial: () => Duplex) {
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
    controlSecret: "s3cr3t-eq5d",
    requireControlSecret: true,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => null,
    dial,
    testDeadlineMs: 1500,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-streamer-auth": "s3cr3t-eq5d" },
      body: JSON.stringify(body),
    });
  return { sup, post, lines };
}

describe("EQ5d · P3-2 · los sobres que no se abren quedan registrados", () => {
  it("etiqueta manipulada (undecryptable) y truncada (invalid): 409/400, una línea de log con el código y SIN la clave", async () => {
    let dialed = 0;
    const c = await control(() => {
      dialed++;
      return netConnect({ host: "127.0.0.1", port: 9 }) as Duplex;
    });
    const s = sealSecret(KEY, PUB, YT);
    const t = Buffer.from(s.tag, "base64");
    t[0] ^= 1;
    const flipped = { ...s, tag: t.toString("base64") };
    const truncated = { ...s, tag: t.subarray(0, 4).toString("base64") };
    const body = (credential: unknown) => ({
      sessionId: "s-eq5d",
      mode: "rtmps",
      ingestUrl: YT.ingest,
      platform: "youtube",
      credential,
    });
    const r1 = await c.post("/control/start", body(flipped));
    const r2 = await c.post("/control/start", body(truncated));
    c.sup.stop();
    expect([r1.status, r2.status]).toEqual([409, 400]);
    expect(dialed).toBe(0);
    const rejected = c.lines
      .map((l) => JSON.parse(l) as { msg: string; code?: string })
      .filter((l) => /credencial sellada rechazada/.test(l.msg));
    expect(rejected.map((l) => l.code)).toEqual(["undecryptable", "invalid"]);
    expect(c.lines.join("\n")).not.toContain(KEY);
  });
});

// ── P3-3 · redacción ────────────────────────────────────────────────────────
describe("EQ5d · P3-3 · redacción de fragmentos y codificaciones", () => {
  const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64");
  const b64url = (x: string | Buffer) => b64(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hex = (x: string) => Buffer.from(x).toString("hex");
  /** ¿Sobrevive algún 8-grama de alguna forma de la clave? (el criterio que se exige). */
  function survivors(out: string): string[] {
    const forms = [KEY, hex(KEY)];
    for (const pre of ["", "x", "xy"]) forms.push(b64(pre + KEY).slice(4), b64url(pre + KEY).slice(4));
    const found: string[] = [];
    const lo = out.toLowerCase();
    for (const f of forms) {
      const lf = f.toLowerCase();
      for (let i = 0; i + 8 <= lf.length - 4; i++) if (lo.includes(lf.slice(i, i + 8))) found.push(lf.slice(i, i + 8));
    }
    return found;
  }

  const cases: Record<string, string> = {
    tal_cual: `rechazo ${KEY} fin`,
    mayusculas: `rechazo ${KEY.toUpperCase()} fin`,
    fragmento_10: `rechazo ${KEY.slice(3, 13)} fin`,
    fragmento_8_final: `rechazo …${KEY.slice(-8)}`,
    url: `rechazo ${encodeURIComponent(KEY)}`,
    b64_alineado: `bad ${b64(KEY)}`,
    b64_desplazado_1: `bad ${b64(`x${KEY}`)}`,
    b64_desplazado_2: `bad ${b64(`xy${KEY}`)}`,
    b64_url: `bad ${b64url(`?>${KEY}`)}`,
    b64_prefijo_16: `bad ${b64(KEY).slice(0, 16)}`,
    hex: `bad ${hex(KEY)}`,
    hex_mayusculas: `bad ${hex(KEY).toUpperCase()}`,
    hex_fragmento: `bad ${hex(KEY).slice(6, 30)}`,
    json: JSON.stringify({ description: `stream ${KEY}` }),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`${name}: no sobrevive ningún fragmento de ≥${REDACT_MIN_FRAGMENT}`, () => {
      const out = redactSecret(text, KEY);
      expect(out).toContain("***");
      expect(survivors(out), out).toEqual([]);
    });
  }

  it("control: un texto sin la clave queda intacto y un fragmento de 7 caracteres no se considera fuga", () => {
    const plain = "la ingesta rechazó la publicación (NetStream.Publish.BadName: invalid key)";
    expect(redactSecret(plain, KEY)).toBe(plain);
    const seven = `x ${KEY.slice(5, 12)} y`;
    expect(redactSecret(seven, KEY)).toBe(seven);
  });

  it("el registro vivo de secretos redacta las mismas formas en el logger", () => {
    const lines: string[] = [];
    const reg = new SecretRegistry();
    reg.add(KEY);
    createLogger(reg, (l) => lines.push(l))("warn", "relé", { detail: `bad ${b64(`x${KEY}`)} ${hex(KEY)}` });
    expect(survivors(lines.join("\n"))).toEqual([]);
  });
});

// ── P3-4 · plazo de escritura ───────────────────────────────────────────────
async function ingest(mode: "stall" | "read") {
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
    let publishing = false;
    sock.on("data", (d: Buffer) => {
      if (publishing) return; // ya publicando: «read» descarta, «stall» ni siquiera lee (pause)
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
          reader.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
          continue;
        }
        if (m.type !== MSG_COMMAND_AMF0) continue;
        const v = decodeAmf0Values(m.payload);
        const name = String(v[0]);
        const txn = Number(v[1]);
        if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
        if (name === "createStream") reply("_result", txn, [null, 1]);
        if (name === "publish") {
          reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start" }], 1);
          publishing = true;
          if (mode === "stall") sock.pause();
          return;
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function video(ts: number, size: number): Buffer {
  const b = Buffer.alloc(11 + size + 4);
  b[0] = 9;
  b.writeUIntBE(size, 1, 3);
  b.writeUIntBE(ts & 0xffffff, 4, 3);
  b.writeUInt32BE(11 + size, 11 + size);
  return b;
}
const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);

describe("EQ5d · P3-4 · plazo de escritura del relé", () => {
  it("ingesta que deja de leer: 'error' con write_timeout cerca del plazo (no a los minutos) y relé cerrado", async () => {
    const port = await ingest("stall");
    const pub = new RtmpPublisher({
      target: parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true),
      streamKey: KEY,
      dial: (t) => netConnect({ host: t.host, port: t.port }) as Duplex,
      connectTimeoutMs: 2000,
      writeTimeoutMs: 300,
    });
    let err: { code?: string; message: string } | null = null;
    pub.on("error", (e: { code?: string; message: string }) => (err = e));
    await pub.start();
    let ok = pub.writeFlv(FLV_HEADER);
    let ts = 0;
    for (let i = 0; i < 400 && ok; i++) ok = pub.writeFlv(video((ts += 33), 256 * 1024));
    expect(ok).toBe(false);
    const t0 = Date.now();
    for (let i = 0; i < 100 && !err; i++) await sleep(20);
    const view = { err, state: pub.state, ms: Date.now() - t0 };
    pub.close();
    expect(view.err, JSON.stringify(view)).not.toBeNull();
    expect((view.err as unknown as { code: string }).code).toBe("write_timeout");
    expect(view.state).toBe("closed");
    expect(view.ms).toBeLessThan(1500);
  });

  it("control: una ingesta que SÍ lee, con escritura sostenida durante varias veces el plazo, no falla", async () => {
    const port = await ingest("read");
    const pub = new RtmpPublisher({
      target: parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true),
      streamKey: KEY,
      dial: (t) => netConnect({ host: t.host, port: t.port }) as Duplex,
      connectTimeoutMs: 2000,
      writeTimeoutMs: 150,
    });
    let errored = false;
    pub.on("error", () => (errored = true));
    await pub.start();
    pub.writeFlv(FLV_HEADER);
    let ts = 0;
    const until = Date.now() + 800;
    while (Date.now() < until) {
      if (!pub.writeFlv(video((ts += 33), 512 * 1024))) await new Promise((r) => pub.once("drain", r));
      else await sleep(5);
    }
    const view = { errored, state: pub.state, bytesOut: pub.bytesOut };
    pub.close();
    expect(view).toMatchObject({ errored: false, state: "publishing" });
    expect(view.bytesOut).toBeGreaterThan(4 * 1024 * 1024);
  });
});
