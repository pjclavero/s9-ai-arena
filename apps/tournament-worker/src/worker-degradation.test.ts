/**
 * DEGRADACIÓN DEL WORKER CUANDO REDIS SE CAE **DESPUÉS** DEL ARRANQUE.
 *
 * El caso «no hay Redis al arrancar» ya estaba cubierto: main.ts no cablea la
 * señal y el bucle hace polling. El que NO lo estaba —y el que ocurre en
 * producción— es que Redis se caiga con el worker ya en marcha.
 *
 * MEDIDO en laboratorio aislado (worker real + Redis real en contenedor propio,
 * matando el proceso `redis-server` a mitad; mismo arnés antes y después):
 *
 *   código anterior   A redis vivo   8 claims/8 s · 0,2 % CPU
 *                     B redis MUERTO 0 claims/7 s · 0,0 % CPU   ← el bucle se para
 *                     C redis VUELTO 0 claims/8 s               ← no se recupera
 *                     stop() NO retorna nunca (unsettled await, rc 13)
 *
 *   con este arreglo  A 8 claims/8 s · B 7 claims/7 s (freno intacto, 0,1 % CPU)
 *                     C reconexiones=1, degradado=false, stop() en 143 ms
 *
 * Es decir: el defecto real NO era el giro sin freno que se sospechaba, sino
 * PARÁLISIS SILENCIOSA PERMANENTE — `RedisSignal` no rechazaba a sus waiters al
 * morir el socket, así que el `.catch()` del bucle ni siquiera llegaba a
 * ejecutarse. El giro sin freno es lo que APARECERÍA al arreglar sólo eso, si
 * la pausa no se conservara: por eso las dos garantías se prueban juntas.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { AddressInfo } from "node:net";
import { clasificarEspera, RedisSignal, RedisSignalDesconectado } from "./redis-signal.js";
import { conVencimiento, TournamentWorker } from "./worker.js";

/** BD de mentira: sólo cuenta los claims. `claimJob` no necesita nada más. */
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

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Registro de workers vivos: un test que falla ANTES de su `worker.stop()`
// dejaría el bucle girando dentro del proceso de vitest y el proceso no podría
// terminar (medido con la mutación M1: minutos colgado por mutación). El
// afterEach los para SIEMPRE, fallen o no las aserciones.
const vivos: TournamentWorker[] = [];
function nuevoWorker(cfg: any): TournamentWorker {
  // Los dobles de estos tests describen el CANAL (`wait`/`connect`); la
  // clasificación del desenlace NO se reimplementa aquí: se usa la misma
  // `clasificarEspera` que usa RedisSignal en producción, para que una mutación
  // de la regla no pueda sobrevivir escondida en el doble.
  if (cfg.signal && !cfg.signal.esperarTrabajo) {
    const doble = cfg.signal;
    doble.esperarTrabajo = (queue: string, timeoutS: number, guardMs: number) =>
      clasificarEspera(Promise.resolve(doble.wait(queue, timeoutS)), guardMs, () => doble.conectado ?? true);
  }
  const w = new TournamentWorker(cfg);
  vivos.push(w);
  return w;
}
afterEach(async () => {
  const pendientes = vivos.splice(0, vivos.length);
  await Promise.allSettled(pendientes.map((w) => conVencimiento(w.stop(), 5000, "stop() colgado")));
});

// Estos tests miden RITMOS en ventanas de menos de tres segundos: aquí un fallo
// es «se colgó», y el testTimeout global de 3 min convertiría cada mutación del
// diferencial en tres minutos de espera. 20 s son de sobra.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

describe("conVencimiento · ningún await del bucle puede durar para siempre", () => {
  it("deja pasar el valor cuando la promesa llega a tiempo", async () => {
    await expect(conVencimiento(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
  });

  it("rechaza cuando la promesa NO llega, con el motivo declarado", async () => {
    await expect(conVencimiento(new Promise(() => {}), 20, "signal.wait vencido")).rejects.toThrow(/vencido/);
  });

  it("propaga el rechazo original sin taparlo con el vencimiento", async () => {
    await expect(conVencimiento(Promise.reject(new Error("caído")), 1000, "x")).rejects.toThrow("caído");
  });
});

describe("FRENO · una señal que RECHAZA no puede convertir el bucle en un giro libre", () => {
  it("con wait() rechazando al instante, el bucle sigue el ritmo de pollMs (no gira)", async () => {
    const { db, estado } = dbContador();
    const signal: any = {
      wait: () => Promise.reject(new RedisSignalDesconectado("socket cerrado")),
      connect: () => Promise.reject(new Error("sigue caído")),
    };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 200,
      signalRetryMs: 50,
    });
    worker.start();
    await dormir(1000);
    await worker.stop();

    // Con freno: ~1 claim por pollMs. Sin freno (el `.catch(() => undefined)`
    // que retorna al instante) esto se cuenta por miles. La cota ALTA es la que
    // caza el giro libre y la carga de la máquina sólo la hace más holgada; la
    // BAJA distingue «sigue trabajando» de «se paró», que es lo que importa.
    expect(estado.claims).toBeLessThanOrEqual(15);
    expect(estado.claims).toBeGreaterThanOrEqual(1);
    expect(worker.degradado).toBe(true);
  });

  it("el freno se respeta AUNQUE la señal falle en cada vuelta durante toda la ventana", async () => {
    const { db, estado } = dbContador();
    let intentos = 0;
    const signal: any = {
      wait: () => {
        intentos++;
        return Promise.reject(new Error("canal roto"));
      },
      connect: () => {
        intentos++;
        return Promise.reject(new Error("canal roto"));
      },
    };
    const worker = nuevoWorker({ db, handlers: {}, signal, concurrency: 1, pollMs: 150, signalRetryMs: 10 });
    worker.start();
    await dormir(600);
    await worker.stop();
    expect(estado.claims).toBeLessThanOrEqual(20);
    expect(estado.claims).toBeGreaterThanOrEqual(1);
    expect(intentos).toBeLessThanOrEqual(120);
  });

  it("un NORMAL_IDLE que vuelve AL INSTANTE tampoco suelta el freno", async () => {
    // Encontrado al mutar: separar «no hay trabajo» de «Redis caído» invita a
    // salir de la pausa en cuanto la espera dice «idle»… y una espera que ni
    // llega a bloquear (canal que responde al instante) devolvería el bucle al
    // giro libre contra la BD, justo lo que el freno existe para impedir.
    const { db, estado } = dbContador();
    const signal: any = {
      esperarTrabajo: async () => ({ tipo: "NORMAL_IDLE", motivo: "blpop-vencido" }),
      wait: async () => false,
      connect: () => Promise.resolve(),
    };
    const worker = nuevoWorker({ db, handlers: {}, signal, concurrency: 1, pollMs: 200 });
    worker.start();
    await dormir(1000);
    await worker.stop();

    expect(worker.degradado).toBe(false); // idle NO es degradación
    expect(estado.claims).toBeLessThanOrEqual(15); // …y sigue frenado
    expect(estado.claims).toBeGreaterThanOrEqual(1);
  });
});

describe("AVANCE · una señal que se cuelga tampoco puede parar el bucle", () => {
  it("wait() que no se resuelve NUNCA: el vencimiento devuelve el control y se sigue consultando la BD", async () => {
    const { db, estado } = dbContador();
    const signal: any = { wait: () => new Promise(() => {}), connect: () => Promise.reject(new Error("caído")) };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 100,
      signalGraceMs: 50,
      signalRetryMs: 1000,
    });
    worker.start();
    // El vencimiento no puede ser más corto que el BLPOP que envuelve: con
    // pollMs=100 el timeout de BLPOP se redondea a 1 s (Redis los cuenta en
    // segundos), así que cada vuelta cuesta ~1,05 s. La ventana lo respeta.
    await dormir(2500);
    await worker.stop();

    // ESTE es el número que en `main` era 0 durante toda la caída.
    expect(estado.claims).toBeGreaterThanOrEqual(1);
    expect(worker.signalStats.vencimientos).toBeGreaterThanOrEqual(1);
  });

  it("stop() retorna aunque la señal esté colgada (en `main` no retornaba nunca)", async () => {
    const { db } = dbContador();
    const signal: any = { wait: () => new Promise(() => {}), connect: () => new Promise(() => {}) };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 100,
      signalGraceMs: 50,
      signalRetryMs: 1000,
    });
    worker.start();
    await dormir(200);
    const t0 = Date.now();
    await conVencimiento(worker.stop(), 3000, "stop() colgado");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("NO EN SILENCIO · degradar se notifica y se cuenta", () => {
  it("cada fallo del canal llega a onSignalError con el estado de degradación", async () => {
    const { db } = dbContador();
    const onSignalError = vi.fn();
    const signal: any = {
      wait: () => Promise.reject(new RedisSignalDesconectado("socket cerrado")),
      connect: () => Promise.reject(new Error("sigue caído")),
    };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 100,
      signalRetryMs: 50,
      onSignalError,
    });
    worker.start();
    await dormir(300);
    await worker.stop();

    expect(onSignalError).toHaveBeenCalled();
    const [err, estado] = onSignalError.mock.calls[0];
    expect(String(err)).toMatch(/conexión perdida|caído/);
    expect(estado.degradado).toBe(true);
    expect(worker.signalStats.fallos).toBeGreaterThanOrEqual(1);
  });

  it("el aviso sale de la PAUSA, no del reintento: se notifica aunque aún no toque reconectar", async () => {
    // Sin este control, quitar el aviso de la pausa pasaba desapercibido porque
    // el reintento de reconexión notificaba por su cuenta (mutación M4, que
    // SOBREVIVÍA). Con signalRetryMs de 10 minutos no hay reintento posible en
    // la ventana: si llega un aviso, viene de la pausa y de ningún otro sitio.
    const { db } = dbContador();
    const onSignalError = vi.fn();
    let conexiones = 0;
    const signal: any = {
      wait: () => Promise.reject(new RedisSignalDesconectado("socket cerrado")),
      connect: () => {
        conexiones++;
        return Promise.reject(new Error("no debería llegar aquí"));
      },
    };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 50,
      signalRetryMs: 600_000,
      onSignalError,
    });
    worker.start();
    await dormir(300);
    await worker.stop();

    expect(conexiones).toBe(0); // el reintento no ha entrado en juego
    expect(onSignalError).toHaveBeenCalledTimes(1);
    expect(String(onSignalError.mock.calls[0][0])).toMatch(/conexión perdida/);
    expect(onSignalError.mock.calls[0][1]).toEqual({ degradado: true, fallos: 1, degradaciones: 1, recuperaciones: 0 });
  });
});

describe("RECUPERACIÓN · al volver Redis, el worker vuelve al canal de aviso", () => {
  it("reconecta y sale de degradado, sin reintentar más deprisa que signalRetryMs", async () => {
    const { db } = dbContador();
    let redisVivo = false;
    let conexiones = 0;
    const signal: any = {
      wait: () => (redisVivo ? dormir(60).then(() => true) : Promise.reject(new Error("canal roto"))),
      connect: () => {
        conexiones++;
        return redisVivo ? Promise.resolve() : Promise.reject(new Error("ECONNREFUSED"));
      },
    };
    const worker = nuevoWorker({ db, handlers: {}, signal, concurrency: 1, pollMs: 80, signalRetryMs: 60 });
    worker.start();
    await dormir(400);
    expect(worker.degradado).toBe(true);
    const intentosCaido = conexiones;

    redisVivo = true;
    await dormir(600);
    await worker.stop();

    expect(worker.degradado).toBe(false);
    expect(worker.signalStats.reconexiones).toBeGreaterThanOrEqual(1);
    // El reintento tiene freno propio: no una tormenta de connect() por vuelta.
    expect(intentosCaido).toBeLessThanOrEqual(12);
  });

  it("el freno del reintento es REAL: con signalRetryMs alto se intenta UNA vez, no una por vuelta", async () => {
    // Sin freno, el reintento se dispararía en cada pausa del bucle (≈ 1 cada
    // pollMs) y una caída larga de Redis se convertiría en una tormenta de
    // conexiones. Con freno: como mucho una cada signalRetryMs.
    const { db } = dbContador();
    let conexiones = 0;
    const signal: any = {
      wait: () => Promise.reject(new Error("canal roto")),
      connect: () => {
        conexiones++;
        return Promise.reject(new Error("ECONNREFUSED"));
      },
    };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 50,
      signalRetryMs: 600_000,
    });
    worker.start();
    await dormir(800);
    await worker.stop();

    // El primer fallo marca el instante del reintento; con 10 min de freno no
    // puede haber un segundo intento en esta ventana.
    expect(conexiones).toBeLessThanOrEqual(1);
    expect(worker.signalStats.pausasDegradadas).toBeGreaterThanOrEqual(3);
  });

  it("CONTROL POSITIVO · con la señal sana no se degrada ni se cuenta ningún fallo", async () => {
    const { db, estado } = dbContador();
    const signal: any = { wait: () => dormir(50).then(() => true), connect: () => Promise.resolve() };
    const worker = nuevoWorker({ db, handlers: {}, signal, concurrency: 1, pollMs: 1000 });
    worker.start();
    await dormir(500);
    await worker.stop();

    expect(worker.degradado).toBe(false);
    expect(worker.signalStats.fallos).toBe(0);
    // La señal SIGUE mandando: se avanza al ritmo de wait() (50 ms), no al de
    // pollMs (1 s). Con el freno mal puesto sobre la señal sana, esto sería 1.
    expect(estado.claims).toBeGreaterThanOrEqual(3);
  });
});

describe("RedisSignal · el socket que muere RECHAZA a quien espera (era el agujero)", () => {
  /** Servidor RESP mínimo: acepta y calla, para poder matarlo a voluntad. */
  async function servidorMudo(): Promise<{ server: Server; puerto: number; sockets: Socket[] }> {
    const sockets: Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, puerto: (server.address() as AddressInfo).port, sockets };
  }

  it("si el servidor cierra la conexión, wait() RECHAZA en vez de esperar para siempre", async () => {
    const { server, puerto, sockets } = await servidorMudo();
    const signal = new RedisSignal(`redis://127.0.0.1:${puerto}`);
    await signal.connect();
    const espera = signal.wait("jobs", 5);
    await dormir(50);
    for (const s of sockets) s.destroy();

    await expect(conVencimiento(espera, 5000, "wait colgado")).rejects.toBeInstanceOf(RedisSignalDesconectado);
    expect(signal.conectado).toBe(false);
    server.close();
  });

  it("TODOS los que esperaban se enteran, no sólo el primero", async () => {
    const { server, puerto, sockets } = await servidorMudo();
    const signal = new RedisSignal(`redis://127.0.0.1:${puerto}`);
    await signal.connect();
    const esperas = [signal.wait("a", 5), signal.wait("b", 5), signal.tryLock("k", "t", 1000)];
    const resultados = esperas.map((p) => p.then(() => "resuelta").catch((e) => String(e.name)));
    await dormir(50);
    for (const s of sockets) s.destroy();

    await expect(conVencimiento(Promise.all(resultados), 5000, "alguno colgado")).resolves.toEqual([
      "RedisSignalDesconectado",
      "RedisSignalDesconectado",
      "RedisSignalDesconectado",
    ]);
    server.close();
  });

  it("CONTROL POSITIVO · con el servidor respondiendo, wait() resuelve normalmente", async () => {
    const server = createServer((s) => {
      s.on("data", () => s.write("*2\r\n$10\r\ns9:wake:jobs\r\n$1\r\n1\r\n"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const puerto = (server.address() as AddressInfo).port;
    const signal = new RedisSignal(`redis://127.0.0.1:${puerto}`);
    await signal.connect();
    await expect(conVencimiento(signal.wait("jobs", 5), 5000, "wait colgado")).resolves.toBe(true);
    await signal.quit();
    server.close();
  });

  it("send() sin conexión devuelve una promesa RECHAZADA (capturable), no una excepción síncrona", async () => {
    const signal = new RedisSignal("redis://127.0.0.1:1");
    // Sin connect(): el bucle hace `await signal.wait(...)` y tiene que poder
    // capturarlo como cualquier otro fallo de canal.
    await expect(signal.wait("jobs", 1)).rejects.toBeInstanceOf(RedisSignalDesconectado);
  });

  it("connect() sobre una conexión anterior no deja waiters de la sesión vieja colgados", async () => {
    const { server, puerto } = await servidorMudo();
    const signal = new RedisSignal(`redis://127.0.0.1:${puerto}`);
    await signal.connect();
    const viejo = signal.wait("jobs", 5);
    const capturado = viejo.catch((e) => String(e.name));
    await dormir(20);
    await signal.connect();
    await expect(conVencimiento(capturado, 5000, "waiter viejo colgado")).resolves.toBe("RedisSignalDesconectado");
    await signal.quit();
    server.close();
  });

  it("un error del socket TRAS conectar no tumba el proceso: se convierte en rechazo", async () => {
    const { server, puerto, sockets } = await servidorMudo();
    const signal = new RedisSignal(`redis://127.0.0.1:${puerto}`);
    await signal.connect();
    const espera = signal.wait("jobs", 5).catch((e) => String(e.name));
    await dormir(20);
    for (const s of sockets) s.resetAndDestroy(); // RST: 'error', no 'close' limpio
    await expect(conVencimiento(espera, 5000, "colgado")).resolves.toBe("RedisSignalDesconectado");
    server.close();
  });
});

describe("el bucle SOBREVIVE al ciclo completo caída → polling → vuelta, sin perder el proceso", () => {
  it("degrada con freno, avisa, se recupera y termina limpiamente", async () => {
    const { db, estado } = dbContador();
    let vivo = true;
    const eventos: string[] = [];
    const signal: any = {
      wait: () => (vivo ? dormir(40).then(() => true) : Promise.reject(new Error("canal roto"))),
      connect: () => (vivo ? Promise.resolve() : Promise.reject(new Error("ECONNREFUSED"))),
    };
    const worker = nuevoWorker({
      db,
      handlers: {},
      signal,
      concurrency: 1,
      pollMs: 80,
      signalRetryMs: 60,
      onSignalError: (err) => eventos.push(err === null ? "recuperado" : "fallo"),
    });
    worker.start();
    await dormir(400);
    const durante = estado.claims;

    vivo = false;
    await dormir(500);
    const trasCaida = estado.claims - durante;

    vivo = true;
    await dormir(500);
    await worker.stop();

    expect(durante).toBeGreaterThan(0);
    expect(trasCaida).toBeGreaterThan(0); // sigue trabajando por polling
    expect(trasCaida).toBeLessThanOrEqual(50); // …y con freno
    expect(eventos).toContain("fallo");
    expect(eventos).toContain("recuperado");
    expect(worker.degradado).toBe(false);
  });
});
