/**
 * B1 · Entrypoint de SERVICIO de arena-engine (E2/E9).
 *
 * `SERVICE_ENTRY` en infrastructure/docker-compose.yml apuntaba al CLI
 * (`cli.ts`): corre UNA batalla y termina — por eso el contenedor quedaba en
 * `Restarting (0)` en producción y nadie servía `GET /healthz` (el healthcheck
 * del Compose apunta a `http://127.0.0.1:8081/healthz`). Este fichero es el
 * servidor HTTP que sí se queda vivo: sirve `/healthz` y expone `POST /run`,
 * que delega en `runContainerBattle()` (apps/bot-manager/src/container-battle.ts,
 * R6.2), ya probado y reutilizado sin cambios.
 *
 * El `ContainerRunner` se INYECTA (`ArenaEngineServiceConfig.runner`). Por
 * defecto NO hay ninguno: `POST /run` responde 503 `runner_unavailable`.
 *
 * B2 (este bloque) cablea `ProxyContainerRunner` (apps/bot-manager/src/docker-proxy.ts,
 * habla con `s9-docker-proxy`, nunca con docker.sock) GATEADO por entorno
 * (`serviceConfigFromEnv`/`DOCKER_PROXY_URL`): sin configurar, sigue en 503.
 * También añade la autenticación interna de `/run` (ver `RunBattleRequestBody`
 * más abajo) que el propio B1 dejó anotada como requisito previo a cablear el
 * runner real.
 *
 * Igual que `apps/api/src/app.ts`/`server.ts`: `createArenaEngineService()` (la
 * app Express, testeable con supertest sin abrir ningún puerto) está separada
 * de `listen()` (infraestructura, solo se ejecuta como script real).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  runContainerBattle,
  type ContainerBattleConfig,
  type ContainerBattleOutcome,
} from "../../bot-manager/src/container-battle.js";
import type { ContainerRunner } from "../../bot-manager/src/container-runner.js";
import { ProxyContainerRunner } from "../../bot-manager/src/docker-proxy.js";

export interface ArenaEngineServiceConfig {
  /**
   * Runner containerizado inyectado. Sin él (valor por defecto), `POST /run`
   * responde 503 `runner_unavailable` — el servicio NUNCA llama a Docker por
   * sí mismo. En producción (B2/VM108) se inyecta `ProxyContainerRunner`; en
   * tests, un runner fake.
   */
  runner?: ContainerRunner;
  /** Red interna de las batallas (def. "arena"). SIEMPRE de la config del
   *  servicio: B2 dejó de aceptarla del cuerpo de la petición (ver más abajo). */
  network?: string;
  /** Host del ProtocolServer alcanzable por los contenedores (def. "arena-engine").
   *  SIEMPRE de la config del servicio, nunca del request (idem `network`). */
  engineHost?: string;
  /**
   * B2 · Secreto interno compartido para autenticar `POST /run` (cabecera
   * `x-arena-engine-auth`, comparación en tiempo constante). Sin él configurado,
   * NINGUNA petición a `/run` se acepta (401): no hay modo "abierto" por defecto.
   * Nunca se loguea ni se devuelve en respuestas.
   */
  internalSecret?: string;
}

/** Cuerpo aceptado por `POST /run`: la config de la batalla, SIN las piezas de
 *  infraestructura (`runner`/`network`/`engineHost`) que aporta el propio servicio.
 *
 *  B2 · CIERRE DE SEGURIDAD: `network`/`engineHost` YA NO se aceptan del cuerpo
 *  de la petición (B1 los dejaba pasar porque, sin runner, eran inocuos). Con el
 *  runner real cableado, un caller con acceso a `POST /run` podría si no forzar
 *  una `network` arbitraria (pivotar a otra red Docker) o un `engineHost` propio
 *  (para que los bots contenedor hablen con un ProtocolServer ajeno). Ahora
 *  SIEMPRE salen de `cfg` (config del servicio, resuelta del entorno), nunca del
 *  request — y además `/run` exige autenticación interna (`cfg.internalSecret`). */
export type RunBattleRequestBody = Omit<ContainerBattleConfig, "runner" | "network" | "engineHost">;

function isRunBattleRequestBody(body: unknown): body is RunBattleRequestBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.battleId === "string" &&
    b.battleId.length > 0 &&
    typeof b.seed === "string" &&
    typeof b.rulesetId === "string" &&
    typeof b.ticks === "number" &&
    Array.isArray(b.bots) &&
    b.bots.length >= 2
  );
}

/**
 * Compara dos secretos en tiempo constante. `undefined`/vacío SIEMPRE es
 * inválido (fail closed: sin `configured`, ninguna petición se acepta).
 * Cuando las longitudes difieren igualmente se hace un `timingSafeEqual`
 * (contra sí mismo) para no filtrar por timing si el secreto es más largo o
 * más corto que el proporcionado.
 */
function isValidInternalSecret(configured: string | undefined, provided: string | undefined): boolean {
  if (!configured || !provided) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Crea la app Express del servicio. Testeable sin abrir ningún puerto (supertest). */
export function createArenaEngineService(cfg: ArenaEngineServiceConfig = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    // Mínimo, sin secretos ni versiones de dependencias (solo lo que exige el
    // healthcheck del Compose: 200 = el proceso está vivo y sirve HTTP).
    res.status(200).json({ status: "ok", service: "arena-engine" });
  });

  app.post("/run", async (req: Request, res: Response) => {
    // B2 · autenticación interna PRIMERO: sin credencial válida, ni siquiera se
    // revela si hay runner cableado o no (misma respuesta 401 en ambos casos).
    const provided = req.header("x-arena-engine-auth");
    if (!isValidInternalSecret(cfg.internalSecret, provided)) {
      res.status(401).json({
        error: "unauthorized",
        message: "credencial interna ausente o inválida (cabecera x-arena-engine-auth)",
      });
      return;
    }
    if (!cfg.runner) {
      res.status(503).json({
        error: "runner_unavailable",
        message: "arena-engine: no hay ContainerRunner cableado en este servicio (DOCKER_PROXY_URL sin configurar).",
      });
      return;
    }
    if (!isRunBattleRequestBody(req.body)) {
      res.status(400).json({
        error: "bad_request",
        message: "cuerpo de /run inválido: se requieren battleId, seed, rulesetId, ticks y >=2 bots",
      });
      return;
    }
    // B2 · `network`/`engineHost` SIEMPRE de la config del servicio (nunca del
    // cuerpo de la petición): ver la nota de seguridad en `RunBattleRequestBody`.
    const battleConfig: ContainerBattleConfig = {
      ...req.body,
      network: cfg.network ?? "arena",
      engineHost: cfg.engineHost ?? "arena-engine",
      runner: cfg.runner,
    };
    try {
      const outcome: ContainerBattleOutcome = await runContainerBattle(battleConfig);
      res.status(200).json(outcome);
    } catch (err) {
      res.status(502).json({
        error: "battle_failed",
        message: err instanceof Error ? err.message : String(err),
        battleId: battleConfig.battleId,
      });
    }
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", message: "Ruta no encontrada" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[arena-engine]", err);
    res.status(500).json({ error: "internal", message: "Error interno" });
  });

  return app;
}

/** ID de batalla por defecto para peticiones que no lo fijan explícitamente
 *  (los llamadores reales, p. ej. el bot-manager, siempre deberían pasar el suyo). */
export function newBattleId(): string {
  return `arena_${randomUUID()}`;
}

/**
 * Lee un secreto de un fichero (patrón Docker secrets, `*_FILE`) con
 * precedencia sobre la variable en claro. Fichero declarado pero
 * ilegible/vacío → sin secreto (fail closed: `/run` rechaza todo con 401,
 * nunca se degrada a "sin autenticación").
 */
function resolveInternalSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.ARENA_ENGINE_INTERNAL_SECRET_FILE;
  if (file) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }
  const plain = env.ARENA_ENGINE_INTERNAL_SECRET;
  return plain && plain.length > 0 ? plain : undefined;
}

/** `true` si `value` parsea como URL http(s) (el único transporte que habla
 *  `ProxyContainerRunner`/`fetch`; cualquier otra cosa —vacío, ruta suelta,
 *  `ftp://`, JSON roto, etc.— NO es una configuración válida del proxy). */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * B2 · Resuelve la config del servicio desde el entorno.
 *
 * El runner (`ProxyContainerRunner`, habla con `s9-docker-proxy`, NUNCA con
 * docker.sock) SOLO se instancia si `DOCKER_PROXY_URL` está presente y es una
 * URL http(s) bien formada; si no lo es (ausente, vacía, o mal formada), se
 * trata como NO CONFIGURADO — nunca se instancia el runner con un valor
 * inválido que solo fallaría en tiempo de ejecución (al primer `launch()`,
 * ya en medio de una batalla). El motivo se registra SIN volcar el valor
 * íntegro (podría llevar userinfo/credenciales embebidas en la URL). El
 * secreto interno (`ARENA_ENGINE_INTERNAL_SECRET[_FILE]`) se resuelve igual
 * esté o no el runner cableado: sin secreto configurado, `/run` rechaza TODO
 * con 401 (no hay modo "sin autenticación" por omisión, ni siquiera en
 * desarrollo).
 */
export function serviceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArenaEngineServiceConfig {
  const proxyUrl = env.DOCKER_PROXY_URL;
  let runner: ContainerRunner | undefined;
  if (proxyUrl) {
    if (isHttpUrl(proxyUrl)) {
      runner = new ProxyContainerRunner(proxyUrl);
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          service: "arena-engine",
          msg: "DOCKER_PROXY_URL configurado pero no es una URL http(s) válida: se trata como NO configurado (runner no cableado, /run seguirá en 503).",
        }),
      );
    }
  }
  return {
    network: env.ARENA_NETWORK || undefined,
    engineHost: env.ARENA_ENGINE_HOST || undefined,
    internalSecret: resolveInternalSecretFromEnv(env),
    runner,
  };
}

/**
 * Arranca el servicio escuchando en PORT (def. 8081). El runner es SIEMPRE el
 * que pase el llamador — nunca se resuelve aquí un runner "por defecto real",
 * para que quede explícito y auditable en el punto donde se cablea (B2,
 * `serviceConfigFromEnv`, usado por la guarda de entrypoint más abajo).
 */
export function listen(cfg: ArenaEngineServiceConfig = {}, port = Number(process.env.PORT ?? 8081)): void {
  const app = createArenaEngineService(cfg);
  app.listen(port, () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "arena-engine",
        msg: `arena-engine escuchando en :${port} (runner ${cfg.runner ? "cableado" : "NO cableado — /run → 503"})`,
      }),
    );
  });
}

// Guarda de entrypoint (mismo patrón que cli.ts): solo arranca el servidor
// cuando el archivo se ejecuta como script real, NUNCA al importarse desde
// tests. B2: la config real (runner/secreto/red) se resuelve del entorno aquí,
// gateada por la presencia de DOCKER_PROXY_URL — sin configurar, sigue en 503.
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  listen(serviceConfigFromEnv());
}
