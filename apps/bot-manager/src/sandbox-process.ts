/**
 * E6 · bot-manager — runner de proceso con deadline (T6.2, capa verificable sin Docker).
 *
 * El sandbox de PRODUCCIÓN es un contenedor con límites de cgroup (DockerContainerRunner).
 * Sin Docker no podemos aplicar cgroups, PERO sí podemos verificar de verdad la parte del
 * control que NO depende de Docker: el DEADLINE de ejecución. Un bot en bucle infinito no
 * debe colgar al motor; el orquestador lo mata al vencer el deadline y lo descalifica.
 *
 * SandboxProcessRunner lanza el código en un proceso hijo aislado y lo TERMINA (SIGKILL)
 * si supera el deadline. Es un proxy honesto del "timeout de decisión / arranque" de la
 * tabla 18.2; la contención de CPU/RAM por cgroup queda para el entorno con Docker.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  timedOut: boolean;
  killed: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export class SandboxProcessRunner {
  /**
   * Ejecuta `code` (JS) en un `node -e` hijo con un deadline duro. Si lo supera, lo mata.
   * No monta nada, no pasa secretos; hereda un entorno mínimo.
   */
  runWithDeadline(code: string, deadlineMs: number): Promise<RunResult> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const child = spawn(process.execPath, ["-e", code], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" }, // sin secretos del padre
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, deadlineMs);

      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve({
          timedOut,
          killed: timedOut,
          exitCode,
          durationMs: performance.now() - t0,
          stdout,
          stderr,
        });
      });
    });
  }
}
