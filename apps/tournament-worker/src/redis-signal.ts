/**
 * E9 · T9.1 — Capa Redis de la cola (cap. 8), deliberadamente FINA.
 *
 * Redis aquí NO es la fuente de verdad (eso es la tabla `jobs`: ADR-E9-001);
 * es el canal de despacho de baja latencia:
 *  - notify(): LPUSH a una lista cuando se encola trabajo, para despertar
 *    workers sin esperar al siguiente poll de la BD.
 *  - wait(): BLPOP con timeout; si no hay Redis, el worker degrada a polling.
 *  - tryLock()/unlock(): candado SET NX PX por batalla, como cinturón extra
 *    sobre el bloqueo por fila de PostgreSQL (nunca en sustitución).
 *
 * Cliente RESP mínimo sin dependencias (node:net): en este entorno no hay
 * servidor Redis disponible (sin docker/sudo), así que se prueba contra un
 * stub RESP en proceso y queda documentado como pendiente de validación real.
 */
import { createConnection, type Socket } from "node:net";

function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

/** Parser RESP incremental: devuelve [valor, bytesConsumidos] o null si falta data. */
function parseReply(buf: Buffer, at = 0): [unknown, number] | null {
  const nl = buf.indexOf("\r\n", at);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const head = buf.toString("utf8", at + 1, nl);
  const after = nl + 2;
  switch (type) {
    case "+":
      return [head, after];
    case "-":
      return [new Error(head), after];
    case ":":
      return [Number(head), after];
    case "$": {
      const len = Number(head);
      if (len === -1) return [null, after];
      if (buf.length < after + len + 2) return null;
      return [buf.toString("utf8", after, after + len), after + len + 2];
    }
    case "*": {
      const n = Number(head);
      if (n === -1) return [null, after];
      const items: unknown[] = [];
      let pos = after;
      for (let i = 0; i < n; i++) {
        const parsed = parseReply(buf, pos);
        if (!parsed) return null;
        items.push(parsed[0]);
        pos = parsed[1];
      }
      return [items, pos];
    }
    default:
      return [new Error(`RESP: tipo desconocido '${type}'`), after];
  }
}

export class RedisSignal {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    const u = new URL(this.url);
    await new Promise<void>((resolve, reject) => {
      const s = createConnection({ host: u.hostname, port: Number(u.port || 6379) });
      s.once("connect", () => resolve());
      s.once("error", reject);
      s.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
      this.socket = s;
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const parsed = parseReply(this.buffer);
      if (!parsed) return;
      const [value, consumed] = parsed;
      this.buffer = this.buffer.subarray(consumed);
      const w = this.waiters.shift()!;
      if (value instanceof Error) w.reject(value);
      else w.resolve(value);
    }
  }

  private send(args: string[]): Promise<unknown> {
    if (!this.socket) throw new Error("RedisSignal: no conectado");
    const p = new Promise<unknown>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.socket.write(encodeCommand(args));
    return p;
  }

  /** Aviso de "hay trabajo nuevo" para despertar workers. */
  async notify(queue: string): Promise<void> {
    await this.send(["LPUSH", `s9:wake:${queue}`, "1"]);
  }

  /** Espera un aviso hasta timeoutS. Devuelve true si lo hubo. */
  async wait(queue: string, timeoutS: number): Promise<boolean> {
    const reply = await this.send(["BLPOP", `s9:wake:${queue}`, String(timeoutS)]);
    return reply !== null;
  }

  /** Candado de batalla (cinturón extra sobre el lock por fila de PostgreSQL). */
  async tryLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const reply = await this.send(["SET", `s9:lock:${key}`, token, "NX", "PX", String(ttlMs)]);
    return reply === "OK";
  }

  /** Libera el candado solo si el token coincide (no atómico: documentado). */
  async unlock(key: string, token: string): Promise<void> {
    const current = await this.send(["GET", `s9:lock:${key}`]);
    if (current === token) await this.send(["DEL", `s9:lock:${key}`]);
  }

  async quit(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
  }
}
