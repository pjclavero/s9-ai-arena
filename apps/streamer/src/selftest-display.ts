/**
 * AUD2-13 / flaky del build `streamer` · display PROPIO y DETERMINISTA para la
 * autoprueba de render (render-selftest.ts).
 *
 * CAUSA RAÍZ. La autoprueba levantaba UN Xvfb para los dos casos (positivo y
 * negativo) y daba por «listo» un display con sólo ver que existía su fichero de
 * socket. Xvfb, sin `-noreset`, REINICIA el servidor X cuando se va su último
 * cliente: cierra los sockets de escucha y los reabre pasados unos milisegundos.
 * El positivo termina parando Chromium y ffmpeg (los últimos clientes) y el
 * negativo lanza un Chromium nuevo ~100 ms después: si cae en esa ventana el
 * connect() es rechazado, Chromium sale con «Missing X server or $DISPLAY» (código
 * 1) y, con maxRetries=0 del caso negativo, la emisión queda en `failed` con otro
 * motivo que `render_not_ready` ⇒ negativo=FALLO y el build se cae «a veces».
 *
 * Arreglo (sin reintentos ciegos ni más tiempo):
 *  1. `-noreset`: el servidor ya no se reinicia al irse el último cliente.
 *  2. Un Xvfb NUEVO por caso, en un display distinto, parado Y ESPERADO (exit)
 *     antes de arrancar el siguiente: ningún caso hereda estado de otro.
 *  3. «Listo» = el socket ACEPTA una conexión (condición observada), no «el
 *     fichero existe».
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

export const X_SOCKET_DIR = "/tmp/.X11-unix";

export function displaySocketPath(display: string, dir = X_SOCKET_DIR): string {
  return `${dir}/X${display.replace(/^:/, "").split(".")[0]}`;
}

/** Argumentos del Xvfb de la autoprueba. `-noreset` es la corrección de la carrera. */
export function xvfbArgs(display: string, width = 1920, height = 1080): string[] {
  return [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-noreset"];
}

/** ¿El socket X acepta ahora mismo una conexión? (true = servidor listo). */
export function canConnect(sockPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Inyectable (tests): por defecto, connect() real al socket. */
  probe?: (sockPath: string) => Promise<boolean>;
  /** Si el proceso del display ya murió no se espera más. */
  isDead?: () => boolean;
}

/** Espera A LA CONDICIÓN (el socket acepta conexiones); falla cerrado al plazo o si el Xvfb muere. */
export async function waitForDisplay(sockPath: string, o: WaitOptions = {}): Promise<void> {
  const end = Date.now() + (o.timeoutMs ?? 10_000);
  const probe = o.probe ?? canConnect;
  for (;;) {
    if (o.isDead?.()) throw new Error(`Xvfb terminó antes de aceptar conexiones en ${sockPath}`);
    if (await probe(sockPath)) return;
    if (Date.now() >= end) throw new Error(`Xvfb no aceptó conexiones en ${sockPath} a tiempo`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 50));
  }
}

export interface DisplayHandle {
  display: string;
  /** Para el Xvfb (TERM → KILL tras la gracia) y RESUELVE cuando ha salido. */
  stop(): Promise<void>;
}

export interface StartOptions extends WaitOptions {
  bin?: string;
  width?: number;
  height?: number;
  stopGraceMs?: number;
  /** Inyectable (tests): lanza el proceso del display. */
  spawnXvfb?: (bin: string, args: string[]) => ChildProcess;
  /** Inyectable (tests): ruta del socket. */
  socketPath?: string;
}

export async function startDisplay(display: string, o: StartOptions = {}): Promise<DisplayHandle> {
  const bin = o.bin ?? "Xvfb";
  const proc = (o.spawnXvfb ?? ((b, a) => spawn(b, a, { stdio: "ignore" })))(bin, xvfbArgs(display, o.width, o.height));
  let exited = proc.exitCode !== null || proc.signalCode !== null;
  const exitP = new Promise<void>((resolve) => {
    if (exited) return resolve();
    const fin = () => {
      exited = true;
      resolve();
    };
    proc.once("exit", fin);
    proc.once("error", fin);
  });
  const stop = async (): Promise<void> => {
    if (exited) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ya no existe */
    }
    const t = setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ya no existe */
        }
      }
    }, o.stopGraceMs ?? 3_000);
    await exitP;
    clearTimeout(t);
  };
  try {
    await waitForDisplay(o.socketPath ?? displaySocketPath(display), { ...o, isDead: () => exited });
  } catch (e) {
    await stop();
    throw e;
  }
  return { display, stop };
}

/**
 * Ejecuta cada caso con SU PROPIO display: arranca, espera a que acepte conexiones, corre el
 * caso y —pase lo que pase— lo para y espera su salida ANTES de pasar al siguiente.
 */
export async function runIsolatedCases<T>(
  cases: ReadonlyArray<{ name: string; display: string }>,
  start: (display: string) => Promise<DisplayHandle>,
  run: (name: string, display: string) => Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (const c of cases) {
    const h = await start(c.display);
    try {
      out.push(await run(c.name, h.display));
    } finally {
      await h.stop();
    }
  }
  return out;
}

/**
 * SELFTEST_DISPLAY = ":N" (o "N", con sufijo ".pantalla" opcional): número base del display; el
 * positivo usa N y el negativo N+1. Mal formado => error CLARO (nunca `NaN` ni un display raro).
 */
export function parseSelftestDisplay(raw: string | undefined, fallback = 95): number {
  if (raw === undefined || raw === "") return fallback;
  const m = /^:?(\d{1,5})(?:\.\d+)?$/.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  // N y N+1 deben ser displays X validos (< 32000) y no colisionar con ":0".
  if (!m || n < 1 || n + 1 >= 32000) {
    throw new Error(
      `SELFTEST_DISPLAY mal formado (${JSON.stringify(raw)}): se espera ":N" con N entero entre 1 y 31998`,
    );
  }
  return n;
}
