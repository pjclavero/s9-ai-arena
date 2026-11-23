/**
 * Apoyo de test · lanzar `docker-proxy-main.ts` (o un sustituto) como proceso real y esperar a
 * EVENTOS concretos de su salida, no a tiempos.
 *
 * Dos carreras reales (flaky `unit` en main, 2026-11-22) que este módulo cierra:
 *
 *  1. Puerto: `freePort()` abre un servidor en el puerto 0, lee el puerto y lo CIERRA; el servicio
 *     lo abre después. En ese hueco otro proceso (la suite padre, otro fichero de test, un cliente
 *     saliente que toma un efímero) puede quedarse con él ⇒ el servicio sale con
 *     `listen EADDRINUSE`. Producción rechaza `DOCKER_PROXY_PORT=0`, así que el test no puede
 *     delegar el puerto al servicio: `startMain` detecta EXACTAMENTE ese fallo (`EADDRINUSE` en la
 *     salida del hijo, que ya terminó) y relanza con otro puerto. Cualquier otra salida prematura
 *     se propaga tal cual: no es un reintento ciego.
 *
 *  2. Lectura: la respuesta HTTP y la línea de log de ese mismo request viajan por canales
 *     distintos (socket y tubería de stdout/stderr del hijo). Que el cliente ya tenga la respuesta
 *     no implica que el padre haya leído la línea. Hay que ESPERAR a la línea (`waitFor`) en vez de
 *     inspeccionar `output()` en el acto.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { killTree, spawnService } from "../../../../packages/test-process/index.js";

export interface MainProcess {
  child: ChildProcess;
  exited: Promise<number | null>;
  /** Salida Y cierre de las tuberías: sólo tras esto `output()` está completo. */
  closed: Promise<void>;
  ready: Promise<void>;
  output: () => string;
  /** Resuelve cuando la salida acumulada (stdout+stderr) casa con `re`; rechaza si el hijo sale antes o vence el plazo. */
  waitFor: (re: RegExp, timeoutMs?: number) => Promise<void>;
}

export interface RunOptions {
  command: string;
  args: readonly string[];
  /** Entorno base del hijo (se mezcla con el específico del caso). */
  baseEnv?: Record<string, string>;
  untilLog?: RegExp;
  timeoutMs?: number;
}

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export function runMain(env: Record<string, string>, opts: RunOptions): MainProcess {
  const child = spawnService(opts.command, opts.args, {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...opts.baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const listeners = new Set<() => void>();
  const onData = (c: Buffer | string) => {
    out += c;
    for (const l of [...listeners]) l();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  // `exit` puede llegar antes de que se haya leído el final de las tuberías: se espera a `close`.
  const closed = new Promise<void>((r) => child.on("close", () => r()));
  const waitFor = (re: RegExp, timeoutMs = 20_000) =>
    new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(t);
        listeners.delete(check);
        fn();
      };
      const check = () => {
        if (re.test(out)) done(resolve);
      };
      const t = setTimeout(() => done(() => reject(new Error(`timeout esperando ${re}: ${out}`))), timeoutMs);
      listeners.add(check);
      void closed.then(() => {
        if (re.test(out)) done(resolve);
        else done(() => reject(new Error(`salió antes de ${re}: ${out}`)));
      });
      check();
    });
  const ready = opts.untilLog ? waitFor(opts.untilLog, opts.timeoutMs) : closed;
  // Un `ready` rechazado que nadie ha esperado aún no debe tumbar el proceso de test.
  ready.catch(() => {});
  return { child, exited, closed, ready, output: () => out, waitFor };
}

export interface StartOptions extends RunOptions {
  untilLog: RegExp;
  pickPort?: () => Promise<number>;
  maxAttempts?: number;
}

/** Arranca el servicio con un puerto libre y espera a que anuncie `untilLog`; relanza sólo ante EADDRINUSE. */
export async function startMain(
  envForPort: (port: number) => Record<string, string>,
  opts: StartOptions,
): Promise<{ p: MainProcess; port: number; attempts: number }> {
  const pick = opts.pickPort ?? freePort;
  const max = opts.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    const port = await pick();
    const p = runMain(envForPort(port), opts);
    try {
      await p.ready;
      return { p, port, attempts: attempt };
    } catch (e) {
      await killTree(p.child, "SIGTERM");
      await p.exited;
      if (!/listen EADDRINUSE/.test(p.output()) || attempt >= max) throw e;
    }
  }
}
