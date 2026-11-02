/**
 * EQ5b · Lector incremental de FLV (Adobe FLV v10, anexo E).
 *
 * FFmpeg escribe la emisión como FLV por un descriptor heredado (fd 3) y el
 * relé convierte cada etiqueta (audio 8, vídeo 9, script 18) en un mensaje
 * RTMP: es lo mismo que hace internamente el protocolo `rtmp` de FFmpeg con la
 * salida de su muxer FLV, sólo que aquí la clave no sale del proceso Node.
 */

export interface FlvTag {
  type: number;
  timestamp: number;
  data: Buffer;
}

/** Tope de una etiqueta: un keyframe 1080p a 12 Mbit/s cabe con holgura. */
const MAX_TAG = 16 * 1024 * 1024;

export class FlvReader {
  private buf: Buffer = Buffer.alloc(0);
  private headerDone = false;

  push(chunk: Buffer): FlvTag[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: FlvTag[] = [];
    if (!this.headerDone) {
      if (this.buf.length < 9) return out;
      if (this.buf.toString("latin1", 0, 3) !== "FLV") throw new Error("la salida de ffmpeg no es FLV");
      const headerSize = this.buf.readUInt32BE(5);
      if (headerSize < 9 || headerSize > 1024) throw new Error("cabecera FLV inválida");
      if (this.buf.length < headerSize + 4) return out;
      this.buf = this.buf.subarray(headerSize + 4); // + PreviousTagSize0
      this.headerDone = true;
    }
    for (;;) {
      if (this.buf.length < 11) break;
      const type = this.buf[0] & 0x1f;
      const size = this.buf.readUIntBE(1, 3);
      if (size > MAX_TAG) throw new Error("etiqueta FLV demasiado grande");
      const ts = this.buf.readUIntBE(4, 3) | (this.buf[7] << 24);
      const total = 11 + size + 4;
      if (this.buf.length < total) break;
      out.push({ type, timestamp: ts >>> 0, data: Buffer.from(this.buf.subarray(11, 11 + size)) });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}
