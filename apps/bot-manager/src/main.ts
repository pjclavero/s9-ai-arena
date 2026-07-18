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
 *
 * POST /internal/containers/run — lanza un contenedor de bot vía ProxyContainerRunner.
 * Única vía autorizada para que el tournament-worker (o el orquestador de batallas)
 * cree contenedores: el tournament-worker NO tiene línea directa al docker-proxy.
 * La request incluye la spec del sandbox; la response devuelve el containerId.
 */
import express, { type Express, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { LaunchAuthority } from "./launch-guard.js";
import { DEFAULT_LIMITS, type ContainerLimits, type SandboxSpec } from "./container-runner.js";
import { ProxyContainerRunner } from "./docker-proxy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Perfil seccomp restrictivo (allowlist de syscalls, R6.1). NUNCA "unconfined". */
const DEFAULT_SECCOMP_PROFILE_PATH = join(__dirname, "..", "security", "seccomp-bot.json");

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
  const runner = new ProxyContainerRunner(dockerProxyUrl);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req: Request, res: Response) =>
    res.json({
      status: "ok",
      service: "bot-manager",
      dockerProxy: dockerProxyUrl,
      launchAuthority: launcher instanceof LaunchAuthority,
      maxSourceBytes: DEFAULT_CONFIG.maxSourceBytes,
    }),
  );

  /**
   * POST /internal/containers/run
   *
   * Lanza un contenedor de bot a través del proxy de Docker (R1.7). Es la única
   * vía autorizada para que el orquestador de batallas (tournament-worker) cree
   * contenedores: el tournament-worker NO tiene línea directa al docker-proxy.
   *
   * Body (JSON):
   *   imageDigest   string  Imagen de runtime por digest (ej. ghcr.io/…@sha256:…)
   *   botId         string  Identificador del bot
   *   version       number  Versión del bot (usada en el nombre del contenedor)
   *   battleId      string  ID de la batalla (usado en el nombre del contenedor)
   *   battleToken   string  Token arena/1 que el bot necesita para el handshake HELLO
   *   arenaWsUrl    string  WebSocket URL del ProtocolServer al que conectará el bot
   *   network       string  Red Docker del sandbox (normalmente "arena")
   *   seccompPath?  string  Ruta al perfil seccomp (default: perfil restrictivo del repo, security/seccomp-bot.json — NUNCA "unconfined")
   *   limits?       object  Override de ContainerLimits
   *
   * Response 201: { containerId: string }
   * Response 400: { error: string }
   * Response 500: { error: string }
   */
  app.post("/internal/containers/run", async (req: Request, res: Response) => {
    const body = req.body as {
      imageDigest?: string;
      botId?: string;
      version?: number;
      battleId?: string;
      battleToken?: string;
      arenaWsUrl?: string;
      network?: string;
      seccompPath?: string;
      limits?: Partial<ContainerLimits>;
    };

    const { imageDigest, botId, version, battleId, battleToken, arenaWsUrl, network } = body;

    if (!imageDigest || !botId || version === undefined || !battleId || !battleToken || !arenaWsUrl || !network) {
      res.status(400).json({
        error: "Faltan campos obligatorios: imageDigest, botId, version, battleId, battleToken, arenaWsUrl, network",
      });
      return;
    }

    const spec: SandboxSpec = {
      imageDigest,
      botId,
      version,
      battleId,
      network,
      engineEndpoint: arenaWsUrl,
      env: {
        ARENA_WS_URL: arenaWsUrl,
        BOT_ID: botId,
        BATTLE_TOKEN: battleToken,
        LOG_FORMAT: "json",
      },
      limits: { ...DEFAULT_LIMITS, ...(body.limits ?? {}) },
      seccompProfilePath: body.seccompPath ?? DEFAULT_SECCOMP_PROFILE_PATH,
    };

    try {
      const handle = await runner.launch(spec);
      log("info", "contenedor lanzado", { containerId: handle.id, botId, battleId });
      res.status(201).json({ containerId: handle.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "fallo al lanzar contenedor", { botId, battleId, error: msg });
      res.status(500).json({ error: msg });
    }
  });

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
