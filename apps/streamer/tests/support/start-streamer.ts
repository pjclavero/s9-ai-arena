/**
 * Apoyo de test · arrancar el `main.ts` REAL del streamer y esperar a que ESTE proceso escuche.
 *
 * Flaky de CI (eq6c «CIERRE P2-3 … inexistente/vacio: expected false to be true», main e69eb0f7 y
 * #344): el patrón antiguo elegía `20000 + random·20000` SIN reservarlo y daba el proceso por
 * «up» si CUALQUIER cosa contestaba en `/healthz` antes de 15 s, con stdout/stderr ignorados.
 *  - El rango [32768, 40000) se solapa con los puertos efímeros de Linux, que en el job `unit`
 *    usan a la vez cientos de servidores `listen(0)` y clientes salientes de otros ficheros de test.
 *    Si el puerto sorteado está tomado, `server.listen` del streamer (sin manejador de `error`,
 *    en `::` doble pila) tumba el proceso con `listen EADDRINUSE` en milisegundos; el test sondea
 *    15 s un puerto que nunca será suyo y falla con «expected false to be true», sin diagnóstico.
 *  - Si el ocupante es otro servidor HTTP, el patrón antiguo daba «up» y medía al proceso EQUIVOCADO.
 *
 * Aquí: puerto asignado por el SO (`freePort`), espera al EVENTO «API de control escuchando» del
 * propio hijo (que sólo se emite tras un `listen` con éxito en todas las direcciones, así que el
 * puerto es suyo) y relanzamiento ÚNICAMENTE si el hijo ya murió con `listen EADDRINUSE` (hueco
 * TOCTOU entre cerrar el sondeo y el `listen` del hijo). Mismo mecanismo calibrado que el
 * docker-proxy (`apps/bot-manager/tests/support/spawn-main.ts`, mutantes en
 * `scripts/mutants-spawn-main.sh`); no hay timeout subido ni reintento ciego.
 */
import { killTree } from "../../../../packages/test-process/index.js";
import { startMain, type MainProcess } from "../../../bot-manager/tests/support/spawn-main.js";

export const STREAMER_READY = /API de control escuchando/;

export interface StreamerProcess {
  p: MainProcess;
  base: string;
  port: number;
  attempts: number;
  /** Mata el grupo de procesos del hijo y espera a que salga. */
  stop: () => Promise<void>;
}

export async function startStreamer(
  env: Record<string, string>,
  o: { pickPort?: () => Promise<number>; maxAttempts?: number } = {},
): Promise<StreamerProcess> {
  const { p, port, attempts } = await startMain(
    (port) => ({
      STREAMER_CONTROL_PORT: String(port),
      FFMPEG_BIN: "/nonexistent-ffmpeg",
      CHROMIUM_BIN: "/nonexistent-chromium",
      ...env,
    }),
    {
      command: process.execPath,
      args: ["--import", "tsx", "apps/streamer/src/main.ts"],
      untilLog: STREAMER_READY,
      ...(o.pickPort ? { pickPort: o.pickPort } : {}),
      ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
    },
  );
  return {
    p,
    port,
    attempts,
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      await killTree(p.child, "SIGKILL");
      await p.exited;
    },
  };
}
