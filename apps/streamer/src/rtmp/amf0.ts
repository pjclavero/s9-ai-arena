/**
 * EQ5b · Codificación AMF0 mínima para los comandos RTMP del relé de emisión
 * (connect, releaseStream, FCPublish, createStream, publish, @setDataFrame).
 *
 * Sólo los tipos que usan esos comandos y sus respuestas (_result, _error,
 * onStatus). Los objetos decodificados se crean SIN prototipo: las claves
 * vienen de un servidor remoto (la ingesta) y un `__proto__` no debe colarse.
 */

export type Amf0Value = number | boolean | string | null | undefined | Amf0Object | Amf0Value[];
export interface Amf0Object {
  [key: string]: Amf0Value;
}

const NUMBER = 0x00;
const BOOLEAN = 0x01;
const STRING = 0x02;
const OBJECT = 0x03;
const NULL = 0x05;
const UNDEFINED = 0x06;
const ECMA_ARRAY = 0x08;
const OBJECT_END = 0x09;
const STRICT_ARRAY = 0x0a;
const DATE = 0x0b;
const LONG_STRING = 0x0c;

function encodeKey(k: string): Buffer {
  const b = Buffer.from(k, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

export function encodeAmf0(value: Amf0Value): Buffer {
  if (value === null) return Buffer.from([NULL]);
  if (value === undefined) return Buffer.from([UNDEFINED]);
  if (typeof value === "number") {
    const b = Buffer.alloc(9);
    b[0] = NUMBER;
    b.writeDoubleBE(value, 1);
    return b;
  }
  if (typeof value === "boolean") return Buffer.from([BOOLEAN, value ? 1 : 0]);
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    if (s.length > 0xffff) {
      const h = Buffer.alloc(5);
      h[0] = LONG_STRING;
      h.writeUInt32BE(s.length, 1);
      return Buffer.concat([h, s]);
    }
    const h = Buffer.alloc(3);
    h[0] = STRING;
    h.writeUInt16BE(s.length, 1);
    return Buffer.concat([h, s]);
  }
  if (Array.isArray(value)) {
    const h = Buffer.alloc(5);
    h[0] = STRICT_ARRAY;
    h.writeUInt32BE(value.length, 1);
    return Buffer.concat([h, ...value.map(encodeAmf0)]);
  }
  const parts: Buffer[] = [Buffer.from([OBJECT])];
  for (const [k, v] of Object.entries(value)) {
    parts.push(encodeKey(k), encodeAmf0(v));
  }
  parts.push(Buffer.from([0x00, 0x00, OBJECT_END]));
  return Buffer.concat(parts);
}

export function encodeAmf0Values(values: Amf0Value[]): Buffer {
  return Buffer.concat(values.map(encodeAmf0));
}

class Reader {
  constructor(
    private readonly b: Buffer,
    public pos = 0,
  ) {}
  need(n: number) {
    if (this.pos + n > this.b.length) throw new Error("AMF0 truncado");
  }
  u8() {
    this.need(1);
    return this.b[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.b.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  skip(n: number) {
    this.need(n);
    this.pos += n;
  }
  str(n: number) {
    this.need(n);
    const v = this.b.toString("utf8", this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  get done() {
    return this.pos >= this.b.length;
  }
}

function readProps(r: Reader, depth: number): Amf0Object {
  const out: Amf0Object = Object.create(null);
  for (;;) {
    const klen = r.u16();
    if (klen === 0) {
      const end = r.u8();
      if (end !== OBJECT_END) throw new Error("AMF0: fin de objeto inválido");
      return out;
    }
    const k = r.str(klen);
    out[k] = readValue(r, depth + 1);
  }
}

function readValue(r: Reader, depth: number): Amf0Value {
  if (depth > 16) throw new Error("AMF0: anidamiento excesivo");
  const t = r.u8();
  switch (t) {
    case NUMBER:
      return r.f64();
    case BOOLEAN:
      return r.u8() !== 0;
    case STRING:
      return r.str(r.u16());
    case LONG_STRING:
      return r.str(r.u32());
    case OBJECT:
      return readProps(r, depth);
    case ECMA_ARRAY:
      r.u32(); // recuento orientativo; el final lo marca OBJECT_END
      return readProps(r, depth);
    case STRICT_ARRAY: {
      const n = r.u32();
      if (n > 4096) throw new Error("AMF0: array demasiado grande");
      const arr: Amf0Value[] = [];
      for (let i = 0; i < n; i++) arr.push(readValue(r, depth + 1));
      return arr;
    }
    case DATE: {
      const v = r.f64();
      r.skip(2); // zona horaria (siempre 0)
      return v;
    }
    case NULL:
      return null;
    case UNDEFINED:
      return undefined;
    default:
      throw new Error(`AMF0: tipo no soportado 0x${t.toString(16)}`);
  }
}

/** Decodifica TODOS los valores AMF0 de un mensaje de comando. */
export function decodeAmf0Values(b: Buffer): Amf0Value[] {
  const r = new Reader(b);
  const out: Amf0Value[] = [];
  while (!r.done) out.push(readValue(r, 0));
  return out;
}
