/**
 * SEMÁNTICA DE LA SEÑAL — «no hay trabajo» NO es «Redis no disponible».
 *
 * MEDIDO EN PRODUCCIÓN (VM108, worker `82c74a8`, arreglo de #142 ya desplegado):
 * el worker consumía por BLPOP y despachaba trabajo (jobs done=22), Redis sano
 * todo el tiempo (`cmd=blpop`, 1.305.260 BLPOP acumulados)… y aun así escupía
 *
 *   "Redis no disponible: el worker degrada a polling"  err="signal.wait vencido"
 *   degradado:true  fallos:379   ·  379 degradaciones y 126 recuperaciones en media hora
 *
 * en un patrón exacto de 3 degradaciones : 1 recuperación. Tres, porque el
 * worker corre con concurrencia 3 sobre UNA conexión: Redis atiende los BLPOP
 * pipelineados de uno en uno, así que el tercer bucle esperaba 3·timeout y
 * vencía el guardián de la espera… que #142 clasificaba como caída del canal.
 * Habíamos cambiado una parálisis silenciosa por una alarma que grita siempre:
 * cuando Redis caiga de verdad, ese mensaje no lo distinguirá de lo normal.
 *
 * El contrato que se prueba aquí, con un servidor RESP REAL por TCP (y contra
 * un Redis REAL si hay REDIS_TEST_URL) — nunca sólo con dobles, porque el
 * defecto de hoy pasaría cualquier prueba que se limite a inyectar errores:
 *
 *   BLPOP vencido / sin trabajo -> NORMAL_IDLE        sin degradar, sin contar
 *   error de conexión REAL      -> REDIS_UNAVAILABLE  degrada, +1 POR TRANSICIÓN
 *   Redis vuelve                -> REDIS_RECOVERED    +1 POR TRANSICIÓN
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { RedisSignal } from "./redis-signal.js";
import { conVencimiento, TournamentWorker } from "./worker.js";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BD de mentira: sólo cuenta los claims (es lo único que hace `claimJob` aquí). */
function dbContador() {
  const estado = { claims: 0 };
  const db: any = {
    raw: async () => {
      estado.claims++;
      return { rows: [] };
    },
  };
  return { db, estado };
}

/**
 * SERVIDOR RESP DE VERDAD (TCP, protocolo real, BLPOP que BLOQUEA de verdad y
 * vence de verdad). No es un doble de `RedisSignal`: el cliente bajo prueba
 * habla por socket exactamente igual que con Redis. Se puede matar y levantar
 * en el MISMO puerto, que es lo que hace observables las transiciones.
 */
class RedisFalsoPeroReal {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private listas = new Map<string, string[]>();
  private bloqueados: { key: string; responder: (v: string | null) => void }[] = [];
  puerto = 0;

  async levantar(puerto = 0): Promise<number> {
    this.server = createServer((s) => this.atender(s));
    await new Promise<void>((r) => this.server!.listen(puerto, "127.0.0.1", r));
    this.puerto = (this.server!.address() as AddressInfo).port;
    return this.puerto;
  }

  /** Caída REAL: se cierran los sockets vivos y deja de escuchar el puerto. */
  async caer(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.bloqueados = [];
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.puerto}`;
  }

  private atender(s: Socket): void {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
    s.on("error", () => undefined);
    let buf = "";
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Parser de peticiones RESP suficiente para LPUSH/BLPOP/SET/GET/DEL.
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buf);
        if (!m) return;
        const n = Number(m[1]);
        let pos = m[0].length;
        const args: string[] = [];
        for (let i = 0; i < n; i++) {
          const h = /^\$(\d+)\r\n/.exec(buf.slice(pos));
          if (!h) return;
          pos += h[0].length;
          const len = Number(h[1]);
          if (buf.length < pos + len + 2) return;
          args.push(buf.slice(pos, pos + len));
          pos += len + 2;
        }
        buf = buf.slice(pos);
        this.ejecutar(s, args);
      }
    });
  }

  private ejecutar(s: Socket, args: string[]): void {
    const cmd = args[0].toUpperCase();
    if (cmd === "LPUSH") {
      const key = args[1];
      const bloqueado = this.bloqueados.findIndex((b) => b.key === key);
      if (bloqueado >= 0) {
        const [b] = this.bloqueados.splice(bloqueado, 1);
        b.responder(args[2]);
      } else {
        this.listas.set(key, [args[2], ...(this.listas.get(key) ?? [])]);
      }
      s.write(`:1\r\n`);
      return;
    }
    if (cmd === "BLPOP") {
      const key = args[1];
      const timeoutS = Number(args[args.length - 1]);
      const lista = this.listas.get(key) ?? [];
      const responder = (v: string | null) => {
        if (s.destroyed) return;
        if (v === null)
          s.write(`*-1\r\n`); // ← el vencimiento NORMAL de Redis
        else s.write(`*2\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n$${Buffer.byteLength(v)}\r\n${v}\r\n`);
      };
      if (lista.length > 0) {
        responder(lista.shift()!);
        this.listas.set(key, lista);
        return;
      }
      const entrada = { key, responder };
      this.bloqueados.push(entrada);
      setTimeout(() => {
        const i = this.bloqueados.indexOf(entrada);
        if (i >= 0) {
          this.bloqueados.splice(i, 1);
          responder(null);
        }
      }, timeoutS * 1000);
      return;
    }
    s.write(`+OK\r\n`);
  }
}

/**
 * Interruptor de red delante de un Redis REAL: el worker habla con el proxy,
 * y cortarlo es una pérdida de conexión auténtica sin tocar el Redis de nadie.
 */
class Interruptor {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  puerto = 0;
  constructor(private readonly destino: URL) {}

  async levantar(puerto = 0): Promise<number> {
    this.server = createServer((cliente) => {
      this.sockets.add(cliente);
      const arriba = connect({ host: this.destino.hostname, port: Number(this.destino.port || 6379) });
      this.sockets.add(arriba);
      cliente.pipe(arriba);
      arriba.pipe(cliente);
      const cerrar = () => {
        cliente.destroy();
        arriba.destroy();
      };
      cliente.on("error", cerrar);
      arriba.on("error", cerrar);
      cliente.on("close", cerrar);
      arriba.on("close", cerrar);
    });
    await new Promise<void>((r) => this.server!.listen(puerto, "127.0.0.1", r));
    this.puerto = (this.server!.address() as AddressInfo).port;
    return this.puerto;
  }

  async cortar(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  get url(): string {
    return `redis://127.0.0.1:${this.puerto}`;
  }
}

const vivos: { worker?: TournamentWorker; cerrar?: () => Promise<void> }[] = [];
afterEach(async () => {
  const p = vivos.splice(0, vivos.length);
  for (const x of p) {
    if (x.worker) await conVencimiento(x.worker.stop(), 5000, "stop() colgado").catch(() => undefined);
    if (x.cerrar) await x.cerrar().catch(() => undefined);
  }
});

describe("CONTRATO · desenlaces de la espera contra un servidor RESP real", () => {
  it("cola vacía: el BLPOP vencido es NORMAL_IDLE, no una caída", async () => {
    const redis = new RedisFalsoPeroReal();
    await redis.levantar();
    const signal = new RedisSignal(redis.url);
    await signal.connect();
    vivos.push({
      cerrar: async () => {
        await signal.quit();
        await redis.caer();
      },
    });

    const r = await signal.esperarTrabajo("jobs", 1, 5000);
    expect(r).toEqual({ tipo: "NORMAL_IDLE", motivo: "blpop-vencido" });
  });

  it("hay trabajo: SIGNALED", async () => {
    const redis = new RedisFalsoPeroReal();
    await redis.levantar();
    const signal = new RedisSignal(redis.url);
    await signal.connect();
    vivos.push({
      cerrar: async () => {
        await signal.quit();
        await redis.caer();
      },
    });

    const espera = signal.esperarTrabajo("jobs", 2, 5000);
    await dormir(50);
    await signal.notify("jobs");
    expect(await espera).toEqual({ tipo: "SIGNALED" });
  });

  it("el servidor se cae con la espera en vuelo: REDIS_UNAVAILABLE", async () => {
    const redis = new RedisFalsoPeroReal();
    await redis.levantar();
    const signal = new RedisSignal(redis.url);
    await signal.connect();
    vivos.push({ cerrar: async () => signal.quit() });

    const espera = signal.esperarTrabajo("jobs", 5, 10_000);
    await dormir(50);
    await redis.caer();
    const r = await espera;
    expect(r.tipo).toBe("REDIS_UNAVAILABLE");
  });

  it("varias esperas concurrentes NO se apilan en la conexión (el generador del ruido de VM108)", async () => {
    const redis = new RedisFalsoPeroReal();
    await redis.levantar();
    const signal = new RedisSignal(redis.url);
    await signal.connect();
    vivos.push({
      cerrar: async () => {
        await signal.quit();
        await redis.caer();
      },
    });

    // Tres bucles a la vez, como en producción (concurrencia 3), con un
    // guardián AJUSTADO: si se pipeliniaran, el tercero tardaría 3 s y vencería
    // con el socket vivo. Ninguna puede salir como indisponibilidad.
    const t0 = Date.now();
    const rs = await Promise.all([
      signal.esperarTrabajo("jobs", 1, 1500),
      signal.esperarTrabajo("jobs", 1, 1500),
      signal.esperarTrabajo("jobs", 1, 1500),
    ]);
    expect(rs.every((r) => r.tipo === "NORMAL_IDLE")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe("CICLO COMPLETO del worker con Redis real: contadores POR TRANSICIÓN", () => {
  it("sano→caída→sigue caído→vuelta→sano: 1 degradación y 1 recuperación, ni una más", async () => {
    const redis = new RedisFalsoPeroReal();
    const puerto = await redis.levantar();
    const signal = new RedisSignal(redis.url);
    await signal.connect();
    const { db, estado } = dbContador();
    const eventos: string[] = [];
    const worker = new TournamentWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 1000,
      signalGraceMs: 500,
      signalRetryMs: 300,
      onSignalError: (err) => eventos.push(err === null ? "recuperado" : "degradado"),
    });
    vivos.push({ worker, cerrar: async () => redis.caer() });
    worker.start();

    // ── 1 · Redis SANO y cola VACÍA: varios BLPOP vencidos ────────────────
    await dormir(3200);
    expect(worker.signalStats.idles).toBeGreaterThanOrEqual(2);
    expect(worker.signalStats.degradaciones).toBe(0);
    expect(worker.signalStats.recuperaciones).toBe(0);
    expect(worker.degradado).toBe(false); // el fallback de polling NO está activo
    expect(eventos).toEqual([]);
    const claimsSanos = estado.claims;
    expect(claimsSanos).toBeGreaterThan(0);

    // ── 2 · Redis CAE de verdad ───────────────────────────────────────────
    await redis.caer();
    await dormir(1200);
    expect(worker.signalStats.degradaciones).toBe(1);
    expect(worker.degradado).toBe(true);
    const claimsTrasCaida = estado.claims;
    expect(claimsTrasCaida).toBeGreaterThan(claimsSanos); // el polling sigue reclamando

    // ── 3 · Redis SIGUE caído: sin spam de degradaciones ──────────────────
    await dormir(1500);
    expect(worker.signalStats.degradaciones).toBe(1);
    expect(eventos.filter((e) => e === "degradado")).toHaveLength(1);
    expect(estado.claims).toBeGreaterThan(claimsTrasCaida); // continúa el polling

    // ── 4 · Redis VUELVE ──────────────────────────────────────────────────
    await redis.levantar(puerto);
    await dormir(2000);
    expect(worker.signalStats.recuperaciones).toBe(1);
    expect(worker.degradado).toBe(false);
    expect(eventos).toEqual(["degradado", "recuperado"]);

    // ── 5 · Sano otra vez y cola vacía: vuelve a ser NORMAL_IDLE ───────────
    const idlesAntes = worker.signalStats.idles;
    await dormir(2500);
    expect(worker.signalStats.idles).toBeGreaterThan(idlesAntes);
    expect(worker.signalStats.degradaciones).toBe(1);
    expect(worker.signalStats.recuperaciones).toBe(1);

    // ── 6 · stop() en tiempo acotado ──────────────────────────────────────
    const t0 = Date.now();
    await conVencimiento(worker.stop(), 5000, "stop() colgado");
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 30_000);
});

// Con REDIS_TEST_URL apuntando a un Redis REAL (contenedor propio y temporal),
// el mismo contrato se ejercita contra el servidor de verdad; la caída se
// provoca cortando un interruptor TCP delante, sin tocar el Redis.
describe.runIf(process.env.REDIS_TEST_URL)("CONTRATO contra Redis REAL (REDIS_TEST_URL)", () => {
  it("vencido = NORMAL_IDLE, aviso = SIGNALED, corte = REDIS_UNAVAILABLE, vuelta = recuperación", async () => {
    const interruptor = new Interruptor(new URL(process.env.REDIS_TEST_URL!));
    const puerto = await interruptor.levantar();
    const signal = new RedisSignal(interruptor.url);
    await signal.connect();
    const { db, estado } = dbContador();
    const worker = new TournamentWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 1000,
      signalGraceMs: 500,
      signalRetryMs: 300,
    });
    vivos.push({ worker, cerrar: async () => interruptor.cortar() });
    worker.start();

    await dormir(3200);
    expect(worker.signalStats.idles).toBeGreaterThanOrEqual(2);
    expect(worker.signalStats.degradaciones).toBe(0);
    expect(worker.degradado).toBe(false);
    const claimsSanos = estado.claims;

    await interruptor.cortar();
    await dormir(1500);
    expect(worker.signalStats.degradaciones).toBe(1);
    expect(estado.claims).toBeGreaterThan(claimsSanos);

    await dormir(1500);
    expect(worker.signalStats.degradaciones).toBe(1); // sin spam

    await interruptor.levantar(puerto);
    await dormir(2000);
    expect(worker.signalStats.recuperaciones).toBe(1);
    expect(worker.degradado).toBe(false);

    // Con la señal viva otra vez, un aviso despierta al worker por Redis.
    const directo = new RedisSignal(process.env.REDIS_TEST_URL!);
    await directo.connect();
    await directo.notify("jobs");
    await directo.quit();
    await dormir(500);
    expect(worker.signalStats.degradaciones).toBe(1);
    expect(worker.signalStats.recuperaciones).toBe(1);
  }, 30_000);
});
