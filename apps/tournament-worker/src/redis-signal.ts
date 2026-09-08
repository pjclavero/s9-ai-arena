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

/**
 * Desenlace de una espera de trabajo. Existe para que NADIE tenga que deducir
 * de un booleano o de un mensaje de error si Redis está caído: el vencimiento
 * normal y la caída real son cosas distintas y se nombran distinto.
 */
export type SignalOutcome =
  | { tipo: "SIGNALED" }
  | { tipo: "NORMAL_IDLE"; motivo: "blpop-vencido" | "guardian" | "conexion-ocupada" }
  | { tipo: "REDIS_UNAVAILABLE"; error: Error };

const GUARDIAN = Symbol("guardian");

/**
 * LA REGLA DE CLASIFICACIÓN, en un solo sitio (worker y pruebas comparten esta
 * misma función: un doble de prueba no puede clasificar «a su manera»).
 *
 *   resuelve true    -> SIGNALED           hay trabajo
 *   resuelve false   -> NORMAL_IDLE        BLPOP vencido: NO hay trabajo, Redis sano
 *   rechaza          -> REDIS_UNAVAILABLE  el canal falló de verdad
 *   guardián vencido -> lo dice el SOCKET, no el reloj: vivo = NORMAL_IDLE,
 *                       muerto = REDIS_UNAVAILABLE
 */
export async function clasificarEspera(
  huboTrabajo: Promise<boolean>,
  guardMs: number,
  socketVivo: () => boolean,
): Promise<SignalOutcome> {
  huboTrabajo.catch(() => undefined);
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    const guardian = new Promise<typeof GUARDIAN>((resolve) => {
      temporizador = setTimeout(() => resolve(GUARDIAN), guardMs);
    });
    const resultado = await Promise.race([huboTrabajo.then((v) => ({ valor: v })), guardian]);
    if (resultado === GUARDIAN) {
      if (socketVivo()) return { tipo: "NORMAL_IDLE", motivo: "guardian" };
      return { tipo: "REDIS_UNAVAILABLE", error: new RedisSignalDesconectado("guardián sin socket vivo") };
    }
    return resultado.valor ? { tipo: "SIGNALED" } : { tipo: "NORMAL_IDLE", motivo: "blpop-vencido" };
  } catch (err) {
    return { tipo: "REDIS_UNAVAILABLE", error: comoError(err) };
  } finally {
    if (temporizador) clearTimeout(temporizador);
  }
}
const dormirMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const comoError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export class RedisSignal {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  /** BLPOP en curso: sólo uno por conexión (ver esperarTrabajo). */
  private blpopEnVuelo: Promise<unknown> | null = null;

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
    this.blpopEnVuelo = null;
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

  /**
   * ESPERA CLASIFICADA — el contrato que faltaba.
   *
   * `wait()` sólo dice true/false y deja al que llama adivinar qué significa un
   * rechazo o un vencimiento del guardián. Medido en producción: el worker
   * clasificaba el vencimiento NORMAL del BLPOP (cola vacía, Redis sano) como
   * «Redis no disponible», con 379 degradaciones y 126 recuperaciones en media
   * hora con Redis sano TODO el tiempo. Una alarma que grita siempre no
   * distingue la caída real.
   *
   * Aquí se separan los tres desenlaces de una vez:
   *   SIGNALED          hay trabajo
   *   NORMAL_IDLE       no hay trabajo (BLPOP vencido, o guardián con socket
   *                     VIVO, o otra espera ya ocupaba la conexión)
   *   REDIS_UNAVAILABLE el canal falló de verdad (rechazo, o guardián con el
   *                     socket ya muerto)
   *
   * Y se SERIALIZA el BLPOP por conexión: con varios bucles compartiendo un
   * socket, Redis atiende los BLPOP pipelineados DE UNO EN UNO, así que el
   * tercero tardaba 3·timeoutS y vencía el guardián sin que nada estuviera
   * roto. Ése era el generador del ruido en producción.
   */
  async esperarTrabajo(queue: string, timeoutS: number, guardMs: number): Promise<SignalOutcome> {
    const enVuelo = this.blpopEnVuelo;
    if (enVuelo) {
      // Otra espera ya tiene el turno de BLPOP: no se apila otro comando.
      // Se acompaña su desenlace (acotado) y se vuelve a esperar normalmente.
      const fin = await Promise.race([
        enVuelo.then(
          () => "fin" as const,
          (err: unknown) => ({ err }),
        ),
        dormirMs(timeoutS * 1000).then(() => "tiempo" as const),
      ]);
      if (typeof fin === "object") return { tipo: "REDIS_UNAVAILABLE", error: comoError(fin.err) };
      return { tipo: "NORMAL_IDLE", motivo: "conexion-ocupada" };
    }

    const peticion = this.send(["BLPOP", `s9:wake:${queue}`, String(timeoutS)]);
    // Si vence el guardián, esta promesa puede rechazar más tarde: se neutraliza
    // aquí para no dejar un unhandledRejection suelto.
    peticion.catch(() => undefined);
    this.blpopEnVuelo = peticion;
    const liberar = () => {
      if (this.blpopEnVuelo === peticion) this.blpopEnVuelo = null;
    };
    peticion.then(liberar, liberar);
    try {
      return await clasificarEspera(
        peticion.then((reply) => reply !== null),
        guardMs,
        () => this.conectado,
      );
    } finally {
      liberar();
    }
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
