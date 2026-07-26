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
 * Cablear el runner real (`ProxyContainerRunner`, apps/bot-manager/src/docker-proxy.ts,
 * habla con `s9-docker-proxy`, nunca con docker.sock) es el bloque B2 — NO este.
 *
 * Igual que `apps/api/src/app.ts`/`server.ts`: `createArenaEngineService()` (la
 * app Express, testeable con supertest sin abrir ningún puerto) está separada
 * de `listen()` (infraestructura, solo se ejecuta como script real).
 */
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  runContainerBattle,
  type ContainerBattleConfig,
  type ContainerBattleOutcome,
} from "../../bot-manager/src/container-battle.js";
import type { ContainerRunner } from "../../bot-manager/src/container-runner.js";

export interface ArenaEngineServiceConfig {
  /**
   * Runner containerizado inyectado. Sin él (valor por defecto), `POST /run`
   * responde 503 `runner_unavailable` — el servicio NUNCA llama a Docker por
   * sí mismo. En producción (B2/VM108) se inyecta `ProxyContainerRunner`; en
   * tests, un runner fake.
   */
  runner?: ContainerRunner;
  /** Red interna por defecto de las batallas que no la especifiquen (def. "arena"). */
  network?: string;
  /** Host del ProtocolServer alcanzable por los contenedores (def. "arena-engine"). */
  engineHost?: string;
}

/** Cuerpo aceptado por `POST /run`: la config de la batalla, sin las piezas de infraestructura
 *  (`runner`/`network`/`engineHost`) que aporta el propio servicio; `network`/`engineHost` se
 *  pueden sobreescribir por request si hiciera falta, pero nunca `runner`.
 *
 *  ATENCIÓN B2: hoy que `network`/`engineHost` se acepten del body es inocuo
 *  porque sin runner cableado (503 siempre) nunca se usan. En cuanto B2
 *  cablee `ProxyContainerRunner` aquí, un caller con acceso de red a
 *  `POST /run` podría forzar una `network` arbitraria (pivotar a otra red
 *  Docker) o un `engineHost` propio (para que los bots contenedor hablen con
 *  un ProtocolServer que no es este). Antes de cablear el runner real hace
 *  falta: (a) autenticación interna en `/run` (hoy no hay ninguna — el
 *  handler solo valida forma del body), y/o (b) dejar de aceptar
 *  `network`/`engineHost` del cuerpo y resolverlos siempre desde `cfg`
 *  (config del propio servicio, no del request). No tocar esto en B1. */
export type RunBattleRequestBody = Omit<ContainerBattleConfig, "runner" | "network" | "engineHost"> &
  Partial<Pick<ContainerBattleConfig, "network" | "engineHost">>;

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
    if (!cfg.runner) {
      res.status(503).json({
        error: "runner_unavailable",
        message:
          "arena-engine: no hay ContainerRunner cableado en este servicio (pendiente del bloque B2/VM108, " +
          "ProxyContainerRunner vía s9-docker-proxy).",
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
    const battleConfig: ContainerBattleConfig = {
      ...req.body,
      network: req.body.network ?? cfg.network ?? "arena",
      engineHost: req.body.engineHost ?? cfg.engineHost ?? "arena-engine",
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
 * Arranca el servicio escuchando en PORT (def. 8081). El runner es SIEMPRE el
 * que pase el llamador — nunca se resuelve aquí un runner "por defecto real",
 * para que quede explícito y auditable en el punto donde se cablea (B2).
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
// tests. Sin runner inyectado por defecto: B2 es quien decide cablear
// ProxyContainerRunner aquí (o en un wrapper que importe `listen`).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  listen();
}
