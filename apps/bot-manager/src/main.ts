/**
 * R-DEPLOY · R1 — entrypoint de servicio del bot-manager (API/control, E6).
 *
 * El Compose declaraba `apps/bot-manager/src/main.ts` como SERVICE_ENTRY pero el
 * archivo no existía: el contenedor abortaba en el arranque (node-service/
 * Dockerfile). Este entrypoint NO añade lógica de negocio: cablea las piezas ya
 * existentes (LaunchAuthority, DEFAULT_CONFIG) y expone la señal de
 * infraestructura /healthz. La construcción/validación/firma de bots la ejecuta
 * el proceso aparte `build-worker-main.ts` (R2); el lanzamiento de contenedores
 * va SIEMPRE por el proxy de Docker del host (docker-proxy-main.ts, R1.7).
 *
 * Falla CERRADO en el arranque: sin DOCKER_PROXY_URL no hay vía autorizada hacia
 * Docker (el socket ya no se monta, R1.7 · ERR-SEC-02), así que arrancar sin esa
 * URL sería un servicio que no puede lanzar nada y ocultaría el fallo.
 */
import express, { type Express } from "express";
import { DEFAULT_CONFIG } from "./config.js";
import { LaunchAuthority } from "./launch-guard.js";

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, service: "bot-manager", msg, ...extra }));
}

/**
 * Construye la app de control. `dockerProxyUrl` es obligatorio: es la única vía
 * autorizada hacia Docker (R1.7). Lanza si falta (fallo cerrado, verificable).
 */
export function createBotManagerApp(dockerProxyUrl: string | undefined): Express {
  if (!dockerProxyUrl) {
    throw new Error(
      "Falta DOCKER_PROXY_URL: el bot-manager lanza contenedores SOLO a través del proxy de Docker del host " +
        "(R1.7). Defínelo (p. ej. http://docker-proxy.internal:2375) o el servicio no puede operar.",
    );
  }
  // Puerta única de lanzamiento (T6.2/T6.4) y límites del pipeline (E6.M): se
  // instancian como prueba de readiness; el orquestador de batallas los usa.
  const launcher = new LaunchAuthority();

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) =>
    res.json({
      status: "ok",
      service: "bot-manager",
      dockerProxy: dockerProxyUrl,
      launchAuthority: launcher instanceof LaunchAuthority,
      maxSourceBytes: DEFAULT_CONFIG.maxSourceBytes,
    }),
  );
  return app;
}

// Arranque real solo cuando se ejecuta como entrypoint (no al importarlo en tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bot-manager/src/main.ts")) {
  const port = Number(process.env.PORT ?? 8084);
  let app: Express;
  try {
    app = createBotManagerApp(process.env.DOCKER_PROXY_URL);
  } catch (e) {
    log("error", (e as Error).message);
    process.exit(1);
  }
  const server = app.listen(port, () => log("info", `bot-manager (control) escuchando en :${port}`));
  const shutdown = (sig: string): void => {
    log("info", `${sig}: parando`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
