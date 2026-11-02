/**
 * EQ5b · §3 · Relé RTMP(S) dentro del propio streamer.
 *
 * POR QUÉ EXISTE (bloqueante `STREAM_KEY_ARGV_VISIBLE=NO`): FFmpeg sólo acepta
 * el destino RTMP por argv (`rtmps://host/app/<clave>`), y el argv de un
 * proceso lo lee cualquier usuario del host con `ps` o `/proc/<pid>/cmdline`.
 * FFmpeg 6.1 (Alpine 3.20) no tiene ninguna forma de leer la URL de salida de
 * un fichero o de un descriptor (ni `-/opt fichero`, que además es de 7.x y
 * sólo para opciones de filtros/streams; probado: «Unrecognized option»).
 *
 * Diseño: FFmpeg codifica igual que antes pero escribe FLV en un descriptor
 * heredado (`-f flv pipe:3`), SIN destino de red ni clave. Este módulo, en el
 * proceso Node que ya tenía la clave en memoria, abre la conexión TLS con la
 * ingesta, hace el handshake y los comandos RTMP (connect, releaseStream,
 * FCPublish, createStream, publish) y convierte cada etiqueta FLV en un mensaje
 * RTMP. Es exactamente lo que hace el protocolo `rtmp` de FFmpeg con la salida
 * de su muxer FLV; la diferencia es que la clave nunca sale de este proceso:
 * ni argv, ni entorno, ni ficheros, ni logs.
 *
 * Además, a diferencia de FFmpeg (`tls_verify=0` por defecto), el relé
 * VERIFICA el certificado de la ingesta (CA del sistema; NODE_EXTRA_CA_CERTS
 * para una CA propia), así que la clave no se entrega a un intermediario.
 */
import { EventEmitter } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { decodeAmf0Values, encodeAmf0, encodeAmf0Values, type Amf0Object, type Amf0Value } from "./amf0.js";
import {
  ChunkReader,
  encodeMessage,
  MSG_ACK,
  MSG_AUDIO,
  MSG_COMMAND_AMF0,
  MSG_DATA_AMF0,
  MSG_SET_CHUNK_SIZE,
  MSG_USER_CONTROL,
  MSG_VIDEO,
  MSG_WINDOW_ACK_SIZE,
  type RtmpMessage,
} from "./chunk.js";
import { FlvReader, type FlvTag } from "./flv.js";

export interface IngestTarget {
  protocol: "rtmps" | "rtmp";
  host: string;
  port: number;
  app: string;
  tcUrl: string;
  /** Destino apto para logs, /status y la API: SIN clave. */
  display: string;
}

/**
 * Valida y descompone la URL de ingesta. `rtmp://` (sin TLS) sólo con
 * `allowPlain` (pruebas locales): en claro, la clave viajaría legible por la red.
 */
export function parseIngestUrl(raw: string, allowPlain = false): IngestTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("URL de ingesta inválida");
  }
  const protocol = u.protocol.replace(/:$/, "");
  if (protocol !== "rtmps" && !(protocol === "rtmp" && allowPlain)) {
    throw new Error("la ingesta debe ser rtmps:// (TLS)");
  }
  if (u.username || u.password) throw new Error("la URL de ingesta no admite credenciales");
  if (u.search || u.hash) throw new Error("la URL de ingesta no admite query ni fragmento");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("URL de ingesta sin host");
  const port = u.port ? Number(u.port) : protocol === "rtmps" ? 443 : 1935;
  const app = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  if (!app || app.length > 128 || !/^[A-Za-z0-9._~\-/]+$/.test(app)) throw new Error("aplicación RTMP inválida");
  const hostPort = `${u.hostname}:${port}`;
  return {
    protocol: protocol as "rtmps" | "rtmp",
    host,
    port,
    app,
    tcUrl: `${protocol}://${hostPort}/${app}`,
    display: `${protocol}://${hostPort}/${app}/***`,
  };
}

// ── handshake (C1 con digest, como FFmpeg/FMLE; C2 = eco de S1) ───────────────
const HANDSHAKE_SIZE = 1536;
const FP_KEY = Buffer.from("Genuine Adobe Flash Player 001", "latin1");

function digestPos(c1: Buffer): number {
  return ((c1[8] + c1[9] + c1[10] + c1[11]) % 728) + 12;
}

export function buildC1(): Buffer {
  const c1 = randomBytes(HANDSHAKE_SIZE);
  c1.writeUInt32BE(0, 0); // tiempo
  c1[4] = 9; // versión de cliente (la misma que anuncia FFmpeg)
  c1[5] = 0;
  c1[6] = 124;
  c1[7] = 2;
  const pos = digestPos(c1);
  const hmac = createHmac("sha256", FP_KEY);
  hmac.update(c1.subarray(0, pos));
  hmac.update(c1.subarray(pos + 32));
  hmac.digest().copy(c1, pos);
  return c1;
}

export type PublisherState = "idle" | "connecting" | "publishing" | "closed";

export interface PublisherOptions {
  target: IngestTarget;
  streamKey: string;
  connectTimeoutMs?: number;
  /**
   * EQ5c (P2-1) · Plazo de CADA orden RTMP tras el handshake (connect,
   * createStream, publish). Vencido, el relé falla y cierra el socket. Por
   * defecto, el mismo que `connectTimeoutMs`.
   */
  commandTimeoutMs?: number;
  /** Inyectable en tests (servidor RTMP falso). Por defecto TCP/TLS reales. */
  dial?: (t: IngestTarget) => Duplex;
}

const OUT_CHUNK_SIZE = 4096;
const HIGH_WATER = 4 * 1024 * 1024;
const MAX_PENDING = 32 * 1024 * 1024;

function defaultDial(t: IngestTarget): Duplex {
  if (t.protocol === "rtmp") return netConnect({ host: t.host, port: t.port });
  return tlsConnect({
    host: t.host,
    port: t.port,
    // SNI sólo con nombre (no con IP); la verificación del certificado queda ACTIVA.
    servername: isIP(t.host) ? undefined : t.host,
    rejectUnauthorized: true,
  });
}

/**
 * Error del relé: el mensaje nunca contiene la clave (se redacta todo lo que
 * venga del servidor, que puede repetir el nombre del stream).
 */
export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class RtmpPublisher extends EventEmitter {
  private sock: Duplex | null = null;
  private state_: PublisherState = "idle";
  private readonly reader = new ChunkReader();
  private readonly flv = new FlvReader();
  private hsBuf: Buffer = Buffer.alloc(0);
  private hsDone = false;
  private c1: Buffer | null = null;
  private txn = 1;
  private readonly pending = new Map<number, (cmd: string, args: Amf0Value[]) => void>();
  private publishStreamId = 0;
  private queued: FlvTag[] = [];
  private queuedBytes = 0;
  private bytesIn = 0;
  private lastAck = 0;
  private windowAck = 2_500_000;
  private onPublishStatus: ((code: string, desc: string) => void) | null = null;
  private failed = false;
  private openTimer: NodeJS.Timeout | null = null;
  bytesOut = 0;

  constructor(private readonly opts: PublisherOptions) {
    super();
  }

  get state(): PublisherState {
    return this.state_;
  }

  private redact(text: unknown): string {
    const s = String(text ?? "");
    const k = this.opts.streamKey;
    return (k ? s.split(k).join("***") : s).slice(0, 300);
  }

  /**
   * Conecta y PUBLICA. Resuelve con NetStream.Publish.Start.
   *
   * EQ5c (revisión EQ6b, P1) · Cualquier fallo del arranque —también el rechazo
   * EXPLÍCITO de la ingesta (`_error` a `connect`, `onStatus BadName` a
   * `publish`) o un plazo vencido— pasa por `fail()`: cierra el socket y emite
   * 'error', que es lo que escucha el supervisor (estado, `lastError`
   * redactado, reintento). Antes sólo se rechazaba la promesa y el supervisor
   * la tragaba: la emisión se quedaba «streaming» con el relé en `connecting`.
   */
  async start(): Promise<void> {
    try {
      await this.open();
      await this.connectApp();
      await this.publish();
    } catch (e) {
      throw this.failWith(e);
    }
  }

  /**
   * §13 · Prueba sin emisión: TLS + handshake + `connect` a la aplicación y se
   * cierra. NO publica (no hay stream en la plataforma), así que no valida la
   * clave: lo dice el resultado.
   */
  async probe(): Promise<{ tlsVerified: boolean; connectMs: number }> {
    const t0 = Date.now();
    try {
      await this.open();
      await this.connectApp();
    } catch (e) {
      throw this.failWith(e);
    }
    const connectMs = Date.now() - t0;
    this.close();
    return { tlsVerified: this.opts.target.protocol === "rtmps", connectMs };
  }

  /** Alimenta la salida FLV de ffmpeg. `false` = parar el productor hasta 'drain'. */
  writeFlv(chunk: Buffer): boolean {
    if (this.state_ === "closed") return false;
    let tags: FlvTag[];
    try {
      tags = this.flv.push(chunk);
    } catch (e) {
      this.fail(new RelayError(`salida de ffmpeg ilegible: ${this.redact((e as Error).message)}`, "flv"));
      return false;
    }
    if (this.state_ !== "publishing") {
      for (const t of tags) {
        this.queued.push(t);
        this.queuedBytes += t.data.length;
      }
      if (this.queuedBytes > MAX_PENDING) {
        this.fail(new RelayError("la ingesta no aceptó la publicación a tiempo", "queue_overflow"));
        return false;
      }
      return this.queuedBytes < HIGH_WATER;
    }
    for (const t of tags) this.sendTag(t);
    return (this.sock?.writableLength ?? 0) < HIGH_WATER;
  }

  close(): void {
    if (this.state_ === "closed") return;
    try {
      if (this.state_ === "publishing" && this.publishStreamId) {
        this.command("FCUnpublish", [null, this.opts.streamKey], 0);
        this.command("deleteStream", [null, this.publishStreamId], 0);
      }
    } catch {
      /* el socket puede estar ya roto */
    }
    this.state_ = "closed";
    if (this.openTimer) clearTimeout(this.openTimer);
    this.sock?.end();
    this.sock?.destroy();
    this.emit("close");
  }

  // ── internos ──────────────────────────────────────────────────────────────

  /** Normaliza un fallo, lo hace pasar por `fail()` (idempotente) y lo devuelve para relanzarlo. */
  private failWith(e: unknown): RelayError {
    const err =
      e instanceof RelayError ? e : new RelayError(`relé RTMP: ${this.redact((e as Error)?.message ?? e)}`, "protocol");
    this.fail(err);
    return err;
  }

  private get commandTimeoutMs(): number {
    return this.opts.commandTimeoutMs ?? this.opts.connectTimeoutMs ?? 10_000;
  }

  private fail(err: RelayError): void {
    if (this.failed) return;
    this.failed = true;
    for (const [, cb] of this.pending) cb("_error", [null, null, null, { description: err.message } as Amf0Object]);
    this.pending.clear();
    this.onPublishStatus?.("NetStream.Publish.Failed", err.message);
    this.close();
    // Sin oyente, un 'error' de EventEmitter tumbaría el proceso: el que llama ya
    // recibe el rechazo de la promesa (start/probe).
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  private open(): Promise<void> {
    this.state_ = "connecting";
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;
    return new Promise<void>((resolve, reject) => {
      const timer = (this.openTimer = setTimeout(() => {
        const e = new RelayError("la ingesta no respondió a tiempo", "timeout");
        reject(e);
        this.fail(e);
      }, timeoutMs));
      const sock = (this.opts.dial ?? defaultDial)(this.opts.target);
      this.sock = sock;
      const onErr = (e: Error & { code?: string }) => {
        clearTimeout(timer);
        const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(String(e.code ?? e.message));
        const err = new RelayError(
          tls
            ? `certificado TLS de la ingesta no válido (${this.redact(e.code ?? e.message)})`
            : `conexión con la ingesta fallida (${this.redact(e.code ?? e.message)})`,
          tls ? "tls" : "network",
        );
        reject(err);
        this.fail(err);
      };
      sock.once("error", onErr);
      sock.on("close", () => {
        if (this.state_ !== "closed") {
          const err = new RelayError("la ingesta cerró la conexión", "closed_by_server");
          reject(err);
          this.fail(err);
        }
      });
      sock.on("drain", () => this.emit("drain"));
      sock.on("data", (d: Buffer) => {
        try {
          this.onData(d, () => {
            clearTimeout(timer);
            resolve();
          });
        } catch (e) {
          const err = new RelayError(`protocolo RTMP inválido: ${this.redact((e as Error).message)}`, "protocol");
          reject(err);
          this.fail(err);
        }
      });
      // C0 + C1 en cuanto haya transporte (en TLS, net encola hasta el handshake).
      this.c1 = buildC1();
      sock.write(Buffer.concat([Buffer.from([3]), this.c1]));
    });
  }

  private onData(d: Buffer, handshakeDone: () => void): void {
    this.bytesIn += d.length;
    if (!this.hsDone) {
      this.hsBuf = Buffer.concat([this.hsBuf, d]);
      if (this.hsBuf.length < 1 + 2 * HANDSHAKE_SIZE) return;
      if (this.hsBuf[0] !== 3) throw new Error(`versión RTMP no soportada (${this.hsBuf[0]})`);
      const s1 = this.hsBuf.subarray(1, 1 + HANDSHAKE_SIZE);
      const rest = this.hsBuf.subarray(1 + 2 * HANDSHAKE_SIZE);
      this.hsDone = true;
      this.hsBuf = Buffer.alloc(0);
      this.sock!.write(Buffer.from(s1)); // C2 = eco de S1 (lo que hace FFmpeg al publicar)
      this.sendRaw({
        csid: 2,
        type: MSG_SET_CHUNK_SIZE,
        streamId: 0,
        timestamp: 0,
        payload: u32(OUT_CHUNK_SIZE),
      });
      handshakeDone();
      if (rest.length) this.onMessages(this.reader.push(Buffer.from(rest)));
      return;
    }
    this.onMessages(this.reader.push(d));
    if (this.bytesIn - this.lastAck >= this.windowAck) {
      this.lastAck = this.bytesIn;
      this.sendRaw({ csid: 2, type: MSG_ACK, streamId: 0, timestamp: 0, payload: u32(this.bytesIn >>> 0) });
    }
  }

  private onMessages(msgs: RtmpMessage[]): void {
    for (const m of msgs) this.onMessage(m);
  }

  private onMessage(m: RtmpMessage): void {
    switch (m.type) {
      case MSG_SET_CHUNK_SIZE:
        if (m.payload.length >= 4) this.reader.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
        return;
      case MSG_WINDOW_ACK_SIZE:
        if (m.payload.length >= 4) this.windowAck = Math.max(1, m.payload.readUInt32BE(0));
        return;
      case MSG_USER_CONTROL: {
        // Ping del servidor (evento 6) ⇒ respuesta (evento 7) con el mismo sello.
        if (m.payload.length >= 6 && m.payload.readUInt16BE(0) === 6) {
          const pong = Buffer.alloc(6);
          pong.writeUInt16BE(7, 0);
          m.payload.copy(pong, 2, 2, 6);
          this.sendRaw({ csid: 2, type: MSG_USER_CONTROL, streamId: 0, timestamp: 0, payload: pong });
        }
        return;
      }
      case MSG_COMMAND_AMF0: {
        const vals = decodeAmf0Values(m.payload);
        const name = String(vals[0] ?? "");
        const id = typeof vals[1] === "number" ? vals[1] : 0;
        if ((name === "_result" || name === "_error") && this.pending.has(id)) {
          const cb = this.pending.get(id)!;
          this.pending.delete(id);
          cb(name, vals);
          return;
        }
        if (name === "onStatus") {
          const info = (vals[3] ?? {}) as Amf0Object;
          // EQ5c (P3) · el `code` también viene del servidor: se redacta como la descripción.
          const code = this.redact(info.code ?? "").slice(0, 80);
          const desc = this.redact(info.description ?? "");
          if (this.onPublishStatus) this.onPublishStatus(code, desc);
          else if (/Failed|Error|Rejected|BadName|Unpublish/i.test(code) && this.state_ === "publishing") {
            this.fail(new RelayError(`la ingesta detuvo la publicación (${code})`, "publish_rejected"));
          }
        }
        return;
      }
      default:
        return; // ack, peer bandwidth, datos: nada que hacer para un publicador
    }
  }

  private sendRaw(m: RtmpMessage): void {
    if (!this.sock || this.state_ === "closed") return;
    const buf = encodeMessage(m, m.type === MSG_SET_CHUNK_SIZE ? 128 : OUT_CHUNK_SIZE);
    this.bytesOut += buf.length;
    this.sock.write(buf);
  }

  private command(name: string, args: Amf0Value[], streamId: number, txn = 0): void {
    this.sendRaw({
      csid: streamId ? 8 : 3,
      type: MSG_COMMAND_AMF0,
      streamId,
      timestamp: 0,
      payload: encodeAmf0Values([name, txn, ...args]),
    });
  }

  private call(name: string, args: Amf0Value[], streamId = 0): Promise<Amf0Value[]> {
    const id = ++this.txn;
    return new Promise((resolve, reject) => {
      // EQ5c (P2-1) · plazo por orden: una ingesta que completa el handshake y
      // calla ya no cuelga el relé (ni /control/test) para siempre.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new RelayError(`la ingesta no respondió a ${name} a tiempo`, "timeout");
        reject(err);
        this.fail(err);
      }, this.commandTimeoutMs);
      this.pending.set(id, (res, vals) => {
        clearTimeout(timer);
        if (res === "_result") return resolve(vals);
        const info = (vals[3] ?? {}) as Amf0Object;
        reject(
          new RelayError(
            `la ingesta rechazó ${name}: ${this.redact(info.description ?? info.code ?? "sin detalle")}`,
            "rejected",
          ),
        );
      });
      this.command(name, args, streamId, id);
    });
  }

  private async connectApp(): Promise<void> {
    const t = this.opts.target;
    await this.call("connect", [
      { app: t.app, type: "nonprivate", flashVer: "FMLE/3.0 (compatible; S9 AI Arena)", tcUrl: t.tcUrl },
    ]);
  }

  private async publish(): Promise<void> {
    const key = this.opts.streamKey;
    // releaseStream y FCPublish no tienen respuesta obligatoria (FMLE los envía sin esperar).
    this.command("releaseStream", [null, key], 0, ++this.txn);
    this.command("FCPublish", [null, key], 0, ++this.txn);
    const res = await this.call("createStream", [null]);
    const sid = res[3];
    if (typeof sid !== "number" || sid <= 0) throw new RelayError("createStream sin id de stream", "protocol");
    this.publishStreamId = sid;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onPublishStatus = null;
        reject(new RelayError("la ingesta no confirmó la publicación a tiempo", "timeout"));
      }, this.commandTimeoutMs);
      this.onPublishStatus = (code, desc) => {
        if (code === "NetStream.Publish.Start") {
          clearTimeout(timer);
          this.onPublishStatus = null;
          resolve();
        } else if (/Failed|Error|Rejected|BadName|Denied/i.test(code)) {
          clearTimeout(timer);
          this.onPublishStatus = null;
          reject(new RelayError(`la ingesta rechazó la publicación (${code}${desc ? `: ${desc}` : ""})`, "rejected"));
        }
      };
      this.command("publish", [null, key, "live"], sid, ++this.txn);
    });
    this.state_ = "publishing";
    this.emit("publishing");
    const q = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const tag of q) this.sendTag(tag);
    if ((this.sock?.writableLength ?? 0) < HIGH_WATER) this.emit("drain");
  }

  private sendTag(tag: FlvTag): void {
    let type = tag.type;
    let payload = tag.data;
    let csid = 6;
    if (type === MSG_AUDIO) csid = 4;
    else if (type === MSG_VIDEO) csid = 6;
    else if (type === MSG_DATA_AMF0) {
      csid = 5;
      // Como FFmpeg/FMLE: los metadatos se publican con @setDataFrame delante.
      payload = Buffer.concat([encodeAmf0("@setDataFrame"), tag.data]);
    } else return; // tipos FLV desconocidos: no se reenvían
    type = tag.type;
    this.sendRaw({ csid, type, streamId: this.publishStreamId, timestamp: tag.timestamp, payload });
  }
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
