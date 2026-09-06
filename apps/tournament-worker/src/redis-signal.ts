/**
 * E9 · T9.1 — Capa Redis de la cola (cap. 8), deliberadamente FINA.
 *
 * Redis aquí NO es la fuente de verdad (eso es la tabla `jobs`: ADR-E9-001);
 * es el canal de despacho de baja latencia:
 *  - notify(): LPUSH a una lista cuando se encola trabajo, para despertar
 *    workers sin esperar al siguiente poll de la BD.
 *  - wait(): BLPOP con timeout; si no hay Redis, el worker degrada a polling.
 *    Si el socket muere, wait() RECHAZA (no se queda esperando): ver cerrar().
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

/** Error de canal: la conexión se fue, la respuesta que se esperaba no llegará. */
export class RedisSignalDesconectado extends Error {
  constructor(motivo: string) {
    super(`RedisSignal: conexión perdida (${motivo})`);
    this.name = "RedisSignalDesconectado";
  }
}

export class RedisSignal {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly url: string) {}

  /** ¿Hay socket vivo? El worker lo usa para saber si degradar a polling. */
  get conectado(): boolean {
    return this.socket !== null;
  }

  async connect(): Promise<void> {
    // Reconectar sobre una conexión anterior no debe dejarla colgando ni dejar
    // waiters de la sesión vieja esperando una respuesta que ya no vendrá.
    this.cerrar(new RedisSignalDesconectado("reconexión"));
    const u = new URL(this.url);
    await new Promise<void>((resolve, reject) => {
      const s = createConnection({ host: u.hostname, port: Number(u.port || 6379) });
      const fallaInicial = (e: Error) => {
        s.destroy();
        if (this.socket === s) this.socket = null;
        reject(e);
      };
      s.once("error", fallaInicial);
      s.once("connect", () => {
        s.off("error", fallaInicial);
        // A PARTIR DE AQUÍ el socket puede morir en cualquier momento, y ESO era
        // el agujero medido: sin estos dos manejadores, matar el Redis dejaba a
        // los waiters de BLPOP esperando PARA SIEMPRE. El bucle del worker se
        // quedaba parado —sin girar, sin salir, sin recuperarse al volver
        // Redis— mientras el heartbeat (un setInterval aparte) seguía pintando
        // el healthcheck en verde. Un error de canal tiene que RECHAZAR, para
        // que quien espera pueda degradar.
        s.on("error", (e: Error) => this.cerrar(new RedisSignalDesconectado(e.message)));
        s.on("close", () => this.cerrar(new RedisSignalDesconectado("socket cerrado")));
        resolve();
      });
      s.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
      this.socket = s;
    });
  }

  /** Cierra el socket y rechaza a TODO el que estuviera esperando respuesta. */
  private cerrar(motivo: Error): void {
    const s = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    const pendientes = this.waiters;
    this.waiters = [];
    for (const w of pendientes) w.reject(motivo);
    if (s) {
      s.removeAllListeners();
      s.destroy();
    }
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
    const s = this.socket;
    // Promesa RECHAZADA, no excepción síncrona: quien llama hace `await` y
    // espera poder capturarlo con .catch() como cualquier otro fallo de canal.
    if (!s) return Promise.reject(new RedisSignalDesconectado("no conectado"));
    const p = new Promise<unknown>((resolve, reject) => this.waiters.push({ resolve, reject }));
    s.write(encodeCommand(args), (err) => {
      if (err) this.cerrar(new RedisSignalDesconectado(err.message));
    });
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
    this.cerrar(new RedisSignalDesconectado("quit()"));
  }
}
