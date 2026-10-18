/**
 * DEV-B · Driver de agentes de PRODUCCIÓN: el CÓDIGO REAL de cada bot, en su
 * contenedor del sandbox, conduce su vehículo (TD-002).
 *
 * Mismo esquema que `runContainerBattle` (bot-manager/container-battle.ts, R6.2),
 * pero sobre la batalla que ya preparó el engine-executor del worker (mapa REAL de
 * la BD, ruleset resuelto, loadout CONGELADO de cada bot, catálogo del torneo) en
 * vez de arquetipos y mapas-fixture:
 *
 *   1. `provider.openBattle()` abre el "host" de la batalla (contrato con DEV-A,
 *      `BattleLaunchHost`): opcionalmente un WebSocketServer propio que sirve
 *      también el artefacto firmado; si no, el ProtocolServer abre el suyo.
 *   2. Por cada vehículo: `host.plan()` dice QUÉ lanzar (imagen fijada por
 *      digest, env y cmd extra) y se lanza por el `ContainerRunner` inyectado
 *      (ProxyContainerRunner → s9-docker-proxy; nunca docker.sock).
 *   3. Se espera el handshake de TODOS y sólo entonces arranca el bucle (los
 *      agentes enganchados desde el tick 0, requisito del replay).
 *   4. Se comprueba la postura de cada contenedor con `complianceViolations`
 *      (tabla 18.2): una postura no conforme aborta la batalla (fail closed).
 *   5. Al terminar: CPU de cada contenedor (cgroup) ANTES de pararlo, replay del
 *      ProtocolServer y limpieza incondicional de contenedores y sockets.
 *
 * Clasificación de fallos (19.2), con los DOS relojes de TD-034
 * (apps/bot-manager/src/startup-clock.ts) por bot:
 *  - no se pudo lanzar un contenedor, o la plataforma no lo dejó `ready` en
 *    SANDBOX_STARTUP_TIMEOUT_MS (Docker lento, runtime/SDK ausente, artefacto no
 *    descargable) → infraestructura (`container_unavailable`, se reintenta);
 *  - el código del bot falla tras `ready` (excepción al importar, salida) →
 *    `SportingFailure(bot_crash)`; no llega al HELLO en BOT_EXECUTION_TIMEOUT_MS
 *    desde `ready` → `SportingFailure(bot_timeout)`;
 *  - sin señales del bootstrap (proveedor sin artefacto): ningún bot conectó →
 *    infraestructura; unos sí y otro no → `bot_crash` del ausente (como antes);
 *  - timeout global o pérdida de la reserva (signal) → se aborta y se limpia.
 */
import { randomUUID } from "node:crypto";
import type { WebSocketServer } from "ws";
import { CONTAINER_BATTLE_GRACE_MS, DEFAULT_TICK_INTERVAL_MS } from "../../../packages/game-rules/index.js";
import { protocolBotHandle } from "../../../packages/protocol/bot-handle.js";
import { ProtocolServer, type ExpectedBot } from "../../arena-engine/src/protocol-server.js";
import { DEFAULT_SECCOMP_PROFILE } from "../../bot-manager/src/container-battle.js";
import {
  DEFAULT_LIMITS,
  complianceViolations,
  type ContainerHandle,
  type ContainerLimits,
  type ContainerRunner,
  type SandboxSpec,
} from "../../bot-manager/src/container-runner.js";
import {
  DEFAULT_STARTUP_TIMEOUTS,
  SandboxLaunchError,
  awaitAgentReady,
  launchWithinStartup,
  type BootstrapSignals,
  type StartupResult,
  type StartupTimeouts,
} from "../../bot-manager/src/startup-clock.js";
import type { AgentDriver, AgentDriverInput, AgentDriverOutput } from "./engine-executor.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";

/** Qué arrancar para UN bot (lo decide el proveedor; contrato con DEV-A). */
export interface BotLaunchPlan {
  /** Imagen FIJADA POR DIGEST (`name@sha256:<64hex>`): runtime de DIGESTS.lock o imagen por versión. */
  imageDigest: string;
  /** Variables extra (p. ej. ARTIFACT_URL/ARTIFACT_TOKEN/ARTIFACT_SHA256). Nunca secretos de plataforma. */
  env?: Record<string, string>;
  /** Cmd del contenedor (bootstrap del runtime), si el runner lo soporta. */
  cmd?: string[];
  /** Borrar el contenedor al pararse (HostConfig.AutoRemove): el proxy no tiene DELETE. */
  autoRemove?: boolean;
  /**
   * TD-034 · señales del bootstrap de ESTE bot (descarga, `ready`, informes de
   * fallo). Con ellas se aplican los dos relojes; sin ellas, el plazo único
   * `connectTimeoutMs` y la clasificación anterior.
   */
  startup?: BootstrapSignals;
}

/** Lo que el host de una batalla sabe hacer (contrato B↔A, ver COORD.md). */
export interface BattleLaunchHost {
  /** WebSocketServer compartido (HTTP del artefacto + WS del protocolo en el mismo puerto). */
  wss?: WebSocketServer;
  /** Puerto de `wss` (obligatorio si hay `wss`). */
  port?: number;
  plan(bot: {
    botId: string;
    version: number;
    vehicleId: string;
    /** Identificador del cable (HELLO) que usará el contenedor (`BOT_ID`). */
    wireBotId: string;
    battleToken: string;
    /** `ws://<engineHost>:<port>` que recibirá el contenedor como WS_URL. */
    wsUrl: string;
  }): Promise<BotLaunchPlan>;
  close(): Promise<void> | void;
}

export interface BotLaunchProvider {
  openBattle(battleId: string): Promise<BattleLaunchHost>;
}

export interface ContainerAgentsOptions {
  runner: ContainerRunner;
  provider: BotLaunchProvider;
  /** Red de los bots (compliance exige literalmente "arena"). */
  network: string;
  /** Host de ESTE proceso alcanzable desde `network` (p. ej. el nombre del servicio). */
  engineHost: string;
  limits?: ContainerLimits;
  seccompProfilePath?: string;
  /** ms reales por tick; por defecto el ritmo real del motor (~34 ms). */
  tickIntervalMs?: number;
  /**
   * TD-034 · los dos relojes del arranque por bot (startupTimeoutsFromEnv en
   * main.ts). Def. DEFAULT_STARTUP_TIMEOUTS (30000 / 5000 ms).
   */
  timeouts?: StartupTimeouts;
  /**
   * Plazo ÚNICO del handshake, SÓLO para proveedores sin señales del bootstrap
   * (`plan.startup` ausente). Def. sandboxStartupMs + botExecutionMs. Con
   * señales (producción) no se usa: mandan `timeouts`.
   */
  connectTimeoutMs?: number;
  /** Margen del guard global sobre la duración teórica. Def. 15 s. */
  graceMs?: number;
  /** Cada cuánto se muestrea la CPU de los contenedores durante la batalla. Def. 500 ms. */
  cpuSampleMs?: number;
}

export function containerAgents(opts: ContainerAgentsOptions): AgentDriver {
  return {
    kind: "container",
    async run(input: AgentDriverInput): Promise<AgentDriverOutput> {
      const { engine, vehicles, signal } = input;
      if (signal?.aborted) throw new Error(`batalla abortada antes de lanzar: ${String(signal.reason)}`);
      const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
      const timeouts = opts.timeouts ?? DEFAULT_STARTUP_TIMEOUTS;

      let host: BattleLaunchHost;
      try {
        host = await opts.provider.openBattle(input.battleId);
      } catch (err) {
        throw new InfrastructureFailure(
          "container_unavailable",
          `no se pudo abrir el host de la batalla: ${String(err)}`,
        );
      }

      const wire = vehicles.map((_v, i) => protocolBotHandle(i));
      const expected: ExpectedBot[] = vehicles.map((v, i) => ({
        botId: wire[i],
        vehicleId: v.vehicleId,
        battleToken: randomUUID(),
      }));
      const server = new ProtocolServer({
        battle: engine,
        catalogVersion: input.catalogVersion,
        expected,
        ...(host.wss ? { wss: host.wss } : { port: 0 }),
        tickIntervalMs,
        decisionDeadlineMs: Math.max(80, tickIntervalMs * 6),
        // Conexión → HELLO: tramo del bot (TD-034).
        handshakeTimeoutMs: timeouts.botExecutionMs,
      });
      const port = host.wss ? host.port : server.port;
      if (!port) {
        server.stop();
        await host.close();
        throw new InfrastructureFailure("container_unavailable", "el host de la batalla no declaró puerto");
      }
      const wsUrl = `ws://${opts.engineHost}:${port}`;
      const handles: (ContainerHandle | null)[] = vehicles.map(() => null);
      const plans: (BotLaunchPlan | null)[] = vehicles.map(() => null);
      const launchRequestedAt: number[] = vehicles.map(() => 0);
      const launchedAt: number[] = vehicles.map(() => 0);
      let guard: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let cpuSampler: ReturnType<typeof setInterval> | undefined;

      try {
        for (let i = 0; i < vehicles.length; i++) {
          const v = vehicles[i];
          let plan: BotLaunchPlan;
          try {
            plan = await host.plan({
              botId: v.botId,
              version: v.version,
              vehicleId: v.vehicleId,
              wireBotId: wire[i],
              battleToken: expected[i].battleToken,
              wsUrl,
            });
          } catch (err) {
            throw new InfrastructureFailure(
              "artifact_unavailable",
              `bot ${v.botId} v${v.version}: no se pudo resolver qué lanzar: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          plans[i] = plan;
          const spec: SandboxSpec = {
            imageDigest: plan.imageDigest,
            botId: v.botId,
            version: v.version,
            battleId: input.battleId,
            network: opts.network,
            engineEndpoint: wsUrl,
            env: { ...(plan.env ?? {}), WS_URL: wsUrl, BATTLE_TOKEN: expected[i].battleToken, BOT_ID: wire[i] },
            limits: opts.limits ?? DEFAULT_LIMITS,
            seccompProfilePath: opts.seccompProfilePath ?? DEFAULT_SECCOMP_PROFILE,
            ...(plan.cmd ? { cmd: plan.cmd } : {}),
            ...(plan.autoRemove ? { autoRemove: true } : {}),
          };
          // Reloj de PLATAFORMA de este bot: arranca al PEDIR su contenedor.
          launchRequestedAt[i] = performance.now();
          try {
            handles[i] = await launchWithinStartup(opts.runner, spec, timeouts, launchRequestedAt[i]);
          } catch (err) {
            const reason = err instanceof SandboxLaunchError ? err.reason : "sandbox_start_failed";
            throw new InfrastructureFailure(
              "container_unavailable",
              `[${reason}] no se pudo lanzar el contenedor de ${v.botId} v${v.version}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          launchedAt[i] = performance.now();
        }

        // Postura de seguridad REAL de cada contenedor (tabla 18.2): fail closed.
        for (let i = 0; i < handles.length; i++) {
          const posture = await handles[i]!.posture().catch((err: unknown) => {
            throw new InfrastructureFailure(
              "container_unavailable",
              `no se pudo inspeccionar el contenedor: ${String(err)}`,
            );
          });
          const violations = complianceViolations(posture);
          if (violations.length > 0) {
            throw new InfrastructureFailure(
              "container_unavailable",
              `postura de seguridad NO conforme del contenedor de ${vehicles[i].botId}: ${violations.join("; ")}`,
            );
          }
        }

        if (plans.every((p) => p?.startup)) {
          // TD-034 · dos relojes POR BOT, en paralelo, con señales reales.
          const results: StartupResult[] = await Promise.all(
            vehicles.map((v, i) => {
              const h = handles[i]!;
              return awaitAgentReady({
                timeouts,
                launchRequestedAt: launchRequestedAt[i],
                launchedAt: launchedAt[i],
                signals: plans[i]!.startup!,
                helloAt: () => server.helloAt(v.vehicleId),
                onHello: (cb) => server.onHello((vid) => vid === v.vehicleId && cb()),
                ...(h.state ? { containerState: () => h.state!() } : {}),
              });
            }),
          );
          // La plataforma manda: si algún arranque falló por infraestructura, nadie
          // pierde por ello (se reintenta la batalla entera).
          const infra = results.findIndex((r) => r.ok === false && r.fault === "infrastructure");
          if (infra >= 0) {
            const r = results[infra] as Extract<StartupResult, { ok: false }>;
            throw new InfrastructureFailure(
              "container_unavailable",
              `[${r.reason}] ${vehicles[infra].botId} v${vehicles[infra].version}: ${r.detail}`,
            );
          }
          const culprit = results.findIndex((r) => r.ok === false);
          if (culprit >= 0) {
            const r = results[culprit] as Extract<StartupResult, { ok: false }>;
            throw new SportingFailure(
              r.reason === "bot_execution_timeout" ? "bot_timeout" : "bot_crash",
              vehicles[culprit].botId,
              `[${r.reason}] ${r.detail}`,
              "container",
            );
          }
        } else {
          try {
            await server.whenAllConnected(opts.connectTimeoutMs ?? timeouts.sandboxStartupMs + timeouts.botExecutionMs);
          } catch (err) {
            const connected = new Set(server.connectedVehicleIds());
            if (connected.size === 0) {
              throw new InfrastructureFailure(
                "container_unavailable",
                `ningún bot completó el handshake (¿red/host del motor?): ${String(err)}`,
              );
            }
            const absent = vehicles.find((v) => !connected.has(v.vehicleId))!;
            throw new SportingFailure(
              "bot_crash",
              absent.botId,
              "su contenedor arrancó pero no completó el handshake del protocolo",
              "container",
            );
          }
        }

        // CPU: el contador del cgroup es ACUMULADO y monótono, pero Docker lo
        // devuelve a cero en cuanto el contenedor termina — y el bot termina solo
        // al recibir SHUTDOWN, justo cuando la batalla acaba (medido en el E2E: la
        // lectura final llegaba siempre tarde, null). Se muestrea durante la
        // batalla y se guarda la última lectura positiva: es la CPU consumida
        // hasta esa muestra (cota inferior, nunca una estimación inventada).
        const lastCpu: (number | null)[] = handles.map(() => null);
        const sampleCpu = async () => {
          await Promise.all(
            handles.map(async (h, i) => {
              try {
                const v = (await h?.cpuMs?.()) ?? null;
                if (typeof v === "number" && v > 0 && (lastCpu[i] === null || v > lastCpu[i]!)) lastCpu[i] = v;
              } catch {
                /* muestra perdida: se queda la anterior */
              }
            }),
          );
        };
        cpuSampler = setInterval(() => void sampleCpu(), opts.cpuSampleMs ?? 500);
        cpuSampler.unref?.();

        server.start();
        const overallMs =
          engine.config.ruleset.timeLimitTicks * tickIntervalMs + (opts.graceMs ?? CONTAINER_BATTLE_GRACE_MS);
        const result = await Promise.race([
          server.waitForResult(),
          new Promise<never>((_r, reject) => {
            guard = setTimeout(() => reject(new Error(`timeout global de la batalla tras ${overallMs} ms`)), overallMs);
          }),
          new Promise<never>((_r, reject) => {
            onAbort = () => reject(new Error(`batalla abortada: ${String(signal?.reason)}`));
            signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
        const replay = server.getReplay();

        // Última muestra (por si el contenedor aún vive) y se fija la medida.
        clearInterval(cpuSampler);
        cpuSampler = undefined;
        await sampleCpu();
        const cpuMsByBot = new Map<string, number | null>();
        for (let i = 0; i < handles.length; i++) cpuMsByBot.set(vehicles[i].botId, lastCpu[i]);
        return { result, replay, cpuMsByBot: Object.fromEntries(cpuMsByBot) };
      } finally {
        if (guard) clearTimeout(guard);
        if (cpuSampler) clearInterval(cpuSampler);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        await Promise.allSettled(handles.filter((h): h is ContainerHandle => h !== null).map((h) => h.stop()));
        server.stop();
        await Promise.resolve(host.close()).catch(() => undefined);
      }
    },
  };
}
