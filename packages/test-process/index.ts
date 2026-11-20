/**
 * EQ1 · Robustez · lanzar servicios desde tests SIN dejar huérfanos.
 *
 * Un servicio arrancado con tsx es un ÁRBOL: `node tsx/cli main.ts` (envoltorio) →
 * `node --require tsx/preflight --import loader main.ts` (el servicio) → sus propios
 * hijos (esbuild, ffmpeg, chromium…). Matar sólo el envoltorio deja vivo al resto, que
 * pasa a colgar de init (ppid=1) indefinidamente. Así se acumularon >100 procesos en el host de desarrollo.
 *
 * Regla: cada servicio va en su PROPIO grupo de procesos (`detached: true` lo hace líder
 * de grupo) y se mata el GRUPO entero (`process.kill(-pgid)`), esperando a que quede
 * vacío. Si el proceso de test termina sin haber limpiado (fallo, timeout de un hook),
 * un manejador `exit` mata todos los grupos registrados que sigan vivos.
 *
 * Además, si existe `S9_TEST_PROCESS_MARK` en el entorno del test, se propaga siempre al
 * servicio (aunque el test le pase un entorno mínimo): es la marca con la que
 * `no-orphans.test.ts` encuentra descendientes que sobrevivan.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const MARK_VAR = "S9_TEST_PROCESS_MARK";

const groups = new Set<number>();

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    // EPERM: hay miembros pero no son nuestros (no debería pasar): se tratan como vivos.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: el grupo ya está vacío.
  }
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Síncrono por definición: en `exit` no hay bucle de eventos.
  process.on("exit", () => {
    for (const pgid of groups) signalGroup(pgid, "SIGKILL");
  });
}

/**
 * `spawn` para servicios de larga duración lanzados desde tests: el hijo es líder de su
 * propio grupo de procesos, queda registrado para la limpieza de respaldo y hereda la
 * marca de huérfanos si existe. Mismo contrato que `child_process.spawn`.
 */
export function spawnService(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  installExitHook();
  const mark = process.env[MARK_VAR];
  const env = options.env ?? process.env;
  const child = spawn(command, args, {
    ...options,
    env: mark === undefined ? env : { ...env, [MARK_VAR]: mark },
    detached: true,
  });
  const pgid = child.pid;
  if (pgid !== undefined) {
    groups.add(pgid);
    // El grupo NO se da por vacío cuando sale el líder (los nietos siguen en él):
    // sólo `killTree` o el manejador `exit` lo retiran del registro.
  }
  return child;
}

/**
 * Mata el ÁRBOL completo de un servicio lanzado con `spawnService` (todo su grupo de
 * procesos) y espera a que no quede ningún miembro vivo. Primero `signal` (por defecto
 * SIGKILL); si al cabo de `graceMs` queda alguien, SIGKILL al grupo. Idempotente.
 */
export async function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
  graceMs = 5_000,
): Promise<void> {
  const pgid = child.pid;
  if (pgid === undefined) return;
  signalGroup(pgid, signal);
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (groupAlive(pgid)) {
    signalGroup(pgid, "SIGKILL");
    const hard = Date.now() + 5_000;
    while (groupAlive(pgid) && Date.now() < hard) await new Promise((r) => setTimeout(r, 25));
  }
  groups.delete(pgid);
}

/** Mata todos los árboles lanzados con `spawnService` que sigan registrados. */
export async function killAllServices(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  await Promise.all([...groups].map((pgid) => killTree({ pid: pgid } as ChildProcess, signal)));
}
