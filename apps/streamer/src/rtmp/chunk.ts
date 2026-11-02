/**
 * EQ5b · Capa de chunks RTMP (especificación RTMP 1.0 de Adobe, §5.3):
 * escritura de mensajes troceados y lectura/reensamblado de los que llegan.
 *
 * El relé sólo PUBLICA: escribe siempre cabecera tipo 0 (11 bytes, absoluta)
 * en el primer chunk de cada mensaje y tipo 3 en las continuaciones. Lee los
 * cuatro tipos porque el servidor puede usarlos todos.
 */

export const MSG_SET_CHUNK_SIZE = 1;
export const MSG_ABORT = 2;
export const MSG_ACK = 3;
export const MSG_USER_CONTROL = 4;
export const MSG_WINDOW_ACK_SIZE = 5;
export const MSG_SET_PEER_BANDWIDTH = 6;
export const MSG_AUDIO = 8;
export const MSG_VIDEO = 9;
export const MSG_DATA_AMF0 = 18;
export const MSG_COMMAND_AMF0 = 20;

export interface RtmpMessage {
  csid: number;
  type: number;
  streamId: number;
  timestamp: number;
  payload: Buffer;
}

const EXT = 0xffffff;
/** Tope de un mensaje entrante: el relé sólo recibe comandos y control. */
const MAX_INCOMING_MESSAGE = 1024 * 1024;

function basicHeader(fmt: number, csid: number): Buffer {
  if (csid < 2 || csid > 63) throw new Error(`csid fuera de rango: ${csid}`);
  return Buffer.from([(fmt << 6) | csid]);
}

/** Serializa un mensaje en chunks del tamaño de salida pactado. */
export function encodeMessage(m: RtmpMessage, chunkSize: number): Buffer {
  const ts = Math.max(0, Math.floor(m.timestamp)) >>> 0;
  const ext = ts >= EXT;
  const h = Buffer.alloc(11);
  h.writeUIntBE(ext ? EXT : ts, 0, 3);
  h.writeUIntBE(m.payload.length, 3, 3);
  h[6] = m.type;
  h.writeUInt32LE(m.streamId >>> 0, 7); // el id de stream va en little endian (§5.3.1.2.1)
  const extBuf = ext ? Buffer.alloc(4) : null;
  if (extBuf) extBuf.writeUInt32BE(ts, 0);

  const parts: Buffer[] = [basicHeader(0, m.csid), h];
  if (extBuf) parts.push(extBuf);
  let off = 0;
  const first = Math.min(chunkSize, m.payload.length);
  parts.push(m.payload.subarray(0, first));
  off = first;
  while (off < m.payload.length) {
    parts.push(basicHeader(3, m.csid));
    if (extBuf) parts.push(extBuf);
    const n = Math.min(chunkSize, m.payload.length - off);
    parts.push(m.payload.subarray(off, off + n));
    off += n;
  }
  return Buffer.concat(parts);
}

interface StreamState {
  timestamp: number;
  delta: number;
  length: number;
  type: number;
  streamId: number;
  hasExt: boolean;
  parts: Buffer[];
  received: number;
}

/** Lector incremental de chunks: alimenta bytes, devuelve mensajes completos. */
export class ChunkReader {
  private buf: Buffer = Buffer.alloc(0);
  private chunkSize = 128;
  private readonly streams = new Map<number, StreamState>();

  setChunkSize(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 0x7fffffff) throw new Error("tamaño de chunk inválido");
    this.chunkSize = n;
  }

  push(data: Buffer): RtmpMessage[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    const out: RtmpMessage[] = [];
    for (;;) {
      const m = this.readOne();
      if (m === null) break;
      if (m !== undefined) {
        // Set Chunk Size se aplica AL MOMENTO: los chunks que le siguen en el
        // mismo paquete TCP ya vienen con el tamaño nuevo.
        if (m.type === MSG_SET_CHUNK_SIZE && m.payload.length >= 4) {
          this.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
        }
        out.push(m);
      }
    }
    return out;
  }

  /** null = faltan bytes; undefined = chunk consumido sin mensaje completo. */
  private readOne(): RtmpMessage | null | undefined {
    const b = this.buf;
    if (b.length < 1) return null;
    const fmt = b[0] >> 6;
    let csid = b[0] & 0x3f;
    let p = 1;
    if (csid === 0) {
      if (b.length < 2) return null;
      csid = 64 + b[1];
      p = 2;
    } else if (csid === 1) {
      if (b.length < 3) return null;
      csid = 64 + b[1] + b[2] * 256;
      p = 3;
    }
    const hlen = [11, 7, 3, 0][fmt];
    if (b.length < p + hlen) return null;
    let st = this.streams.get(csid);
    if (!st) {
      if (fmt !== 0) throw new Error(`chunk tipo ${fmt} sin cabecera previa en csid ${csid}`);
      st = { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, hasExt: false, parts: [], received: 0 };
      this.streams.set(csid, st);
    }
    const startingNew = st.received === 0;
    let tsField = 0;
    let len = st.length;
    let type = st.type;
    let streamId = st.streamId;
    if (fmt <= 2) tsField = b.readUIntBE(p, 3);
    if (fmt <= 1) {
      len = b.readUIntBE(p + 3, 3);
      type = b[p + 6];
    }
    if (fmt === 0) streamId = b.readUInt32LE(p + 7);
    p += hlen;
    let hasExt = fmt <= 2 ? tsField === EXT : st.hasExt;
    let extTs = 0;
    if (hasExt) {
      if (b.length < p + 4) return null;
      extTs = b.readUInt32BE(p);
      p += 4;
    }
    if (len > MAX_INCOMING_MESSAGE) throw new Error("mensaje RTMP entrante demasiado grande");
    const remaining = startingNew ? len : st.length - st.received;
    const n = Math.min(this.chunkSize, remaining);
    if (b.length < p + n) return null;

    // Cabecera completa y carga disponible: se confirma el estado.
    if (startingNew) {
      const tsVal = hasExt ? extTs : tsField;
      if (fmt === 0) {
        st.timestamp = tsVal;
        st.delta = 0;
      } else if (fmt === 1 || fmt === 2) {
        st.delta = tsVal;
        st.timestamp = (st.timestamp + tsVal) >>> 0;
      } else {
        st.timestamp = (st.timestamp + st.delta) >>> 0;
      }
      st.length = len;
      st.type = type;
      st.streamId = streamId;
      st.hasExt = hasExt;
    } else {
      hasExt = st.hasExt;
    }
    st.parts.push(b.subarray(p, p + n));
    st.received += n;
    this.buf = b.subarray(p + n);
    if (st.received < st.length) return undefined;
    const payload = Buffer.concat(st.parts);
    st.parts = [];
    st.received = 0;
    return { csid, type: st.type, streamId: st.streamId, timestamp: st.timestamp, payload };
  }
}
