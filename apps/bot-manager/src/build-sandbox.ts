/**
 * DEV-A · TD-001 — sandbox REAL de las etapas de ejecución del pipeline.
 *
 * Sustituye, en producción, al `agentResolver` en proceso de T6.1: el código del
 * usuario se ejecuta en un CONTENEDOR (imagen de runtime fijada por digest,
 * lanzada por el ContainerRunner → s9-docker-proxy) que descarga su artefacto,
 * conecta por WebSocket (arena/1) al ProtocolServer real y juega una partida de
 * humo en el motor real contra el bot de referencia. Una sola sesión alimenta
 * las tres etapas:
 *
 *   protocol_test    HELLO dentro del reloj del bot; todo mensaje del bot valida
 *                    contra envelope.schema.json; al menos un COMMAND válido.
 *   smoke_battle     la batalla termina y el candidato NO queda descalificado.
 *   resource_limits  p95 de decisión ≤ maxDecisionMs, sin OOM (los límites
 *                    duros los aplica el cgroup); métricas de arranque.
 *
 * TD-034 · DOS relojes (startup-clock.ts): SANDBOX_STARTUP_TIMEOUT_MS para la
 * plataforma (lanzamiento → señal `ready` del bootstrap) y
 * BOT_EXECUTION_TIMEOUT_MS para el código del bot (`ready` → HELLO). La carga del
 * host o una Engine lenta sólo pueden agotar el primero, que es infraestructura.
 *
 * Fallos de PLATAFORMA (proxy caído, imagen ausente, postura no conforme, motor
 * colgado, arranque lento, artefacto no descargable o corrupto) lanzan
 * SandboxInfrastructureError: NO son culpa del bot. El pipeline los propaga, el
 * worker reintenta y, agotado, cierra el build fail-closed («build no
 * verificable»), nunca `validated`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { WebSocket } from "ws";
import { loadRuleset, safeLookup, DECISION_EVERY_N_TICKS } from "../../../packages/game-rules/index.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { protocolBotHandle } from "../../../packages/protocol/bot-handle.js";
import { Battle, type BattleResult, type BotAgent, type Participant } from "../../arena-engine/src/sim/battle.js";
import { emptyArena } from "../../arena-engine/src/fixtures.js";
import { ProtocolServer } from "../../arena-engine/src/protocol-server.js";
import type { PipelineConfig } from "./config.js";
import type { BotSubmission } from "./types.js";
import {
  DEFAULT_LIMITS,
  complianceViolations,
  type ContainerHandle,
  type ContainerLimits,
  type ContainerRunState,
  type ContainerRunner,
} from "./container-runner.js";
import { SandboxHost } from "./sandbox-host.js";
import { launchSpecForBot, type RuntimeImages } from "./bot-launch.js";
import {
  DEFAULT_STARTUP_TIMEOUTS,
  SandboxLaunchError,
  awaitAgentReady,
  launchWithinStartup,
  startupMetrics,
  type StartupTimeline,
  type StartupTimeouts,
} from "./startup-clock.js";
import type { Runtime } from "./types.js";

export class SandboxInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxInfrastructureError";
  }
}

export interface StageVerdict {
  outcome: "passed" | "failed";
  message?: string;
  logs: string[];
  metrics?: Record<string, number>;
}

export interface SandboxVerification {
  protocol: StageVerdict;
  smoke: StageVerdict;
  resources: StageVerdict;
}

/** Lo que el pipeline necesita del sandbox: una verificación por build. */
export interface BuildSandbox {
  verify(
    sub: BotSubmission,
    artifact: { bytes: Buffer; hash: string },
    cfg: PipelineConfig,
  ): Promise<SandboxVerification>;
}

export interface ContainerBuildSandboxOptions {
  runner: ContainerRunner;
  /** Red de los contenedores de bot (compliance exige `arena`). */
  network: string;
  /** Cómo alcanzan los contenedores a este proceso (hostname en la red arena). */
  advertiseHost: string;
  bindHost?: string;
  runtimeImages: RuntimeImages;
  /** Bot de referencia (E5) contra el que se juega la partida de humo. */
  referenceAgent: (botId: string) => BotAgent;
  limits?: ContainerLimits;
  seccompProfilePath?: string;
  /** ms reales por tick (por defecto el del motor). */
  tickIntervalMs?: number;
  /**
   * TD-034 · los dos relojes del arranque (startupTimeoutsFromEnv en el
   * cableado). Def. DEFAULT_STARTUP_TIMEOUTS (30000 / 5000 ms).
   */
  timeouts?: StartupTimeouts;
  /**
   * Sólo tests: argumentos del ENTRYPOINT del runtime (el bootstrap). Permite un
   * «runtime de prueba» que retrasa de verdad la plataforma antes de `ready`.
   * Producción usa siempre el bootstrap del repo.
   */
  bootstrapCmd?: (runtime: Runtime) => string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "..", "..", "packages", "protocol", "schemas");
let envelopeValidatorCache: ReturnType<Ajv2020["getSchema"]> | null = null;
function envelopeValidator() {
  if (envelopeValidatorCache) return envelopeValidatorCache;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith(".json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
  }
  envelopeValidatorCache = ajv.getSchema("envelope.schema.json")!;
  return envelopeValidatorCache;
}

/** Lo que el sandbox observa del tráfico del candidato (sin tocar el ProtocolServer). */
class WireTap {
  helloAt: number | null = null;
  /** Reloj de pared del HELLO (comparable con State.StartedAt del contenedor). */
  helloWallMs: number | null = null;
  validCommands = 0;
  invalid: string[] = [];
  observationsSent = 0;
  latencies: number[] = [];
  private sentAt = new Map<number, number>();

  attach(ws: WebSocket): void {
    const send = ws.send.bind(ws);
    (ws as unknown as { send: (d: unknown, ...r: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg?.type === "OBSERVATION" && typeof msg.tick === "number") {
          this.observationsSent++;
          this.sentAt.set(msg.tick, performance.now());
        }
      } catch {
        /* no es JSON: no es asunto del tap */
      }
      return (send as (...a: unknown[]) => void)(data, ...rest);
    };
    ws.on("message", (raw) => this.onMessage(String(raw)));
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.invalid.push("mensaje que no es JSON");
      return;
    }
    const validate = envelopeValidator();
    if (!validate(msg)) {
      const detail = (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "(raíz)"} ${e.message}`);
      this.invalid.push(`${String(msg?.type ?? "?")} no cumple el esquema arena/1: ${detail.join("; ")}`);
      return;
    }
    if (msg.type === "HELLO" && this.helloAt === null) {
      this.helloAt = performance.now();
      this.helloWallMs = Date.now();
    }
    if (msg.type === "COMMAND") {
      this.validCommands++;
      const t = this.sentAt.get(msg.payload.forTick - DECISION_EVERY_N_TICKS);
      if (t !== undefined) this.latencies.push(performance.now() - t);
    }
  }
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const notRun = (why: string): StageVerdict => ({ outcome: "failed", message: why, logs: [] });

export class ContainerBuildSandbox implements BuildSandbox {
  constructor(private readonly o: ContainerBuildSandboxOptions) {}

  /** Plazos EFECTIVOS que aplica esta instancia (declarada = efectiva, SAN-4). */
  get timeouts(): StartupTimeouts {
    return this.o.timeouts ?? DEFAULT_STARTUP_TIMEOUTS;
  }

  async verify(
    sub: BotSubmission,
    artifact: { bytes: Buffer; hash: string },
    cfg: PipelineConfig,
  ): Promise<SandboxVerification> {
    const limits = this.o.limits ?? DEFAULT_LIMITS;
    const image = safeLookup(this.o.runtimeImages, sub.runtime);
    if (!image) throw new SandboxInfrastructureError(`sin imagen de runtime para ${sub.runtime}`);

    let host: SandboxHost;
    try {
      host = await SandboxHost.start({ advertiseHost: this.o.advertiseHost, bindHost: this.o.bindHost, port: 0 });
    } catch (e) {
      throw new SandboxInfrastructureError(`no se pudo abrir el anfitrión del sandbox: ${(e as Error).message}`);
    }

    const catalog = loadCatalog();
    const candLoadout = safeLookup(ARCHETYPES, sub.archetype);
    const refLoadout = safeLookup(ARCHETYPES, "gunner");
    if (!candLoadout || !refLoadout) throw new SandboxInfrastructureError(`arquetipo desconocido: ${sub.archetype}`);
    const handle0 = protocolBotHandle(0);
    const participants: Participant[] = [
      { id: "veh_1", botId: handle0, team: "red", spec: resolveVehicle(candLoadout, catalog) },
      { id: "veh_2", botId: "ref_bot", team: "blue", spec: resolveVehicle(refLoadout, catalog) },
    ];
    const sessionId = `build-${randomUUID().slice(0, 8)}`;
    const battle = await Battle.create({
      battleId: sessionId,
      seed: "build-smoke",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: cfg.smokeBattleTicks }),
      map: emptyArena(),
      participants,
    });
    const battleToken = randomUUID();
    const tap = new WireTap();
    host.wss.on("connection", (ws) => tap.attach(ws));
    const server = new ProtocolServer({
      battle,
      catalogVersion: CATALOG_VERSION,
      expected: [{ botId: handle0, vehicleId: "veh_1", battleToken }],
      wss: host.wss,
      ...(this.o.tickIntervalMs !== undefined ? { tickIntervalMs: this.o.tickIntervalMs } : {}),
      // Conexión → HELLO: tramo del bot, mismo plazo que su reloj.
      handshakeTimeoutMs: this.timeouts.botExecutionMs,
    });
    battle.attachBot("veh_2", this.o.referenceAgent("ref_bot"));
    const offer = host.offerArtifact(artifact.bytes, artifact.hash);

    const logs: string[] = [];
    let container: ContainerHandle | undefined;
    try {
      const timeouts = this.timeouts;
      const spec = launchSpecForBot({
        runtime: sub.runtime,
        imageDigest: image,
        botId: sub.botId,
        version: sub.version,
        sessionId,
        network: this.o.network,
        wsUrl: host.wsUrl,
        battleToken,
        botHandle: handle0,
        offer,
        limits,
        seccompProfilePath: this.o.seccompProfilePath,
      });
      if (this.o.bootstrapCmd) spec.cmd = this.o.bootstrapCmd(sub.runtime);
      // Reloj de PLATAFORMA: arranca al PEDIR el contenedor.
      const timeline: StartupTimeline = { launchRequestedAt: performance.now() };
      try {
        container = await launchWithinStartup(this.o.runner, spec, timeouts, timeline.launchRequestedAt);
      } catch (e) {
        const reason = e instanceof SandboxLaunchError ? e.reason : "sandbox_start_failed";
        throw new SandboxInfrastructureError(
          `el sandbox no pudo lanzar el contenedor: ${(e as Error).message} [${reason}]`,
        );
      }
      timeline.launchedAt = performance.now();
      const launchMs = timeline.launchedAt - timeline.launchRequestedAt;
      logs.push(
        `contenedor ${container.id.slice(0, 12)} lanzado en ${launchMs.toFixed(0)} ms (${image.split("@")[0]})`,
      );

      // Defensa en profundidad: la postura REAL del contenedor (inspect) debe
      // cumplir la tabla 18.2. Si el contenedor ya desapareció (salió al
      // instante), sólo consta la validación previa del proxy.
      try {
        const posture = await container.posture();
        const v = complianceViolations(posture);
        if (v.length) throw new SandboxInfrastructureError(`postura del sandbox NO conforme: ${v.join("; ")}`);
        logs.push("postura del contenedor conforme (no root, cap-drop ALL, rootfs ro, seccomp, red arena)");
      } catch (e) {
        if (e instanceof SandboxInfrastructureError) throw e;
        const st = await container.state?.();
        if (!st?.gone)
          throw new SandboxInfrastructureError(`no se pudo inspeccionar el sandbox: ${(e as Error).message}`);
        logs.push("contenedor ya terminado antes de inspeccionarlo (la postura la validó el proxy al crearlo)");
      }

      // 1) Readiness con DOS relojes (TD-034): plataforma hasta `ready`, bot
      //    desde `ready` hasta su HELLO. Señales reales, nunca un sleep.
      const handle = container;
      const startup = await awaitAgentReady({
        timeouts,
        launchRequestedAt: timeline.launchRequestedAt,
        launchedAt: timeline.launchedAt,
        signals: offer.signals,
        helloAt: () => server.helloAt("veh_1"),
        onHello: (cb) => server.onHello(() => cb()),
        ...(handle.state ? { containerState: () => handle.state!() } : {}),
      });
      Object.assign(timeline, startup.timeline);
      if (startup.ok === false) {
        const exit = this.describeExit(startup.state, []);
        const metrics = startupMetrics(timeline, timeouts);
        if (startup.fault === "infrastructure") {
          throw new SandboxInfrastructureError(
            `[${startup.reason}] ${startup.detail}${exit}; descargas del artefacto: ${offer.fetches} (${formatTimeline(timeline)})`,
          );
        }
        return {
          protocol: {
            outcome: "failed",
            message: `el bot no completó el handshake (HELLO): ${startup.detail}${exit} [timeout_reason=${startup.reason}]`,
            logs: [...logs, `descargas del artefacto: ${offer.fetches}`, formatTimeline(timeline)],
            metrics,
          },
          smoke: notRun("no ejecutada: el bot no arrancó"),
          resources: notRun("no ejecutada: el bot no arrancó"),
        };
      }
      // Informativo: el tramo que juzgaba el código anterior (StartedAt → HELLO,
      // reloj de pared de la Engine frente al del anfitrión).
      const startedAtMs = (await container.state?.().catch(() => null))?.startedAtMs;
      const startedAtToHelloMs =
        startedAtMs !== undefined && tap.helloWallMs !== null ? Math.max(0, tap.helloWallMs - startedAtMs) : undefined;
      const sm = startupMetrics(timeline, timeouts);
      logs.push(
        `agente listo en ${(sm.startupMs ?? 0).toFixed(0)} ms (plataforma, ≤ ${timeouts.sandboxStartupMs} ms); HELLO ` +
          (startup.readyLost
            ? "sin señal ready (tramo del bot no medible aparte)"
            : `${(sm.botReadyToHelloMs ?? 0).toFixed(0)} ms después (bot, ≤ ${timeouts.botExecutionMs} ms)`) +
          `; artefacto descargado ${offer.fetches} vez/veces`,
      );
      logs.push(formatTimeline(timeline));
      const tExec = performance.now();

      // 2) Partida de humo real (bucle de ticks del ProtocolServer).
      server.start();
      const overallMs = cfg.smokeBattleTicks * (this.o.tickIntervalMs ?? 1000 / 30) * 2 + 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: BattleResult;
      try {
        result = await Promise.race([
          server.waitForResult(),
          new Promise<BattleResult>((_r, reject) => {
            timer = setTimeout(
              () => reject(new SandboxInfrastructureError(`la partida de humo no terminó en ${overallMs} ms`)),
              overallMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const executionMs = performance.now() - tExec;
      const cpuMs = (await container.cpuMs?.().catch(() => null)) ?? null;
      const state = (await container.state?.().catch(() => null)) ?? null;

      // ---- veredictos
      const p95 = percentile(tap.latencies, 95);
      const max = tap.latencies.length ? Math.max(...tap.latencies) : 0;
      const metrics: Record<string, number> = {
        ...sm,
        executionMs,
        ...(startedAtToHelloMs !== undefined ? { startedAtToHelloMs } : {}),
        p95DecisionMs: p95,
        maxDecisionMs: max,
        decisions: tap.latencies.length,
        observations: tap.observationsSent,
        validCommands: tap.validCommands,
        ...(cpuMs !== null ? { cpuMs } : {}),
        memoryLimitBytes: limits.memoryBytes,
        cpuLimit: limits.cpus,
        pidsLimit: limits.pids,
      };

      let protocol: StageVerdict;
      if (tap.invalid.length > 0) {
        protocol = {
          outcome: "failed",
          message: `mensaje(s) fuera de protocolo (${tap.invalid.length}): ${tap.invalid[0]}`,
          logs: [...logs, ...tap.invalid.slice(0, 5)],
        };
      } else if (tap.validCommands === 0) {
        protocol = {
          outcome: "failed",
          message: `ningún COMMAND válido en ${tap.observationsSent} observaciones${this.describeExit(state, offer.reports)}`,
          logs: [...logs],
        };
      } else {
        protocol = { outcome: "passed", logs: [...logs, `${tap.validCommands} COMMAND válidos, 0 mensajes inválidos`] };
      }

      const dq = result.disqualified ?? [];
      const smokeLogs = [`batalla terminada en ${result.ticks} ticks; ganador ${result.winner}`];
      const smoke: StageVerdict =
        dq.includes("veh_1") || dq.includes(handle0)
          ? {
              outcome: "failed",
              message: `candidato descalificado en la partida de humo (respondió ${tap.latencies.length}/${tap.observationsSent} observaciones)${this.describeExit(state, offer.reports)}`,
              logs: smokeLogs,
            }
          : { outcome: "passed", logs: smokeLogs };

      const resLogs = [
        `arranque: plataforma ${(sm.startupMs ?? 0).toFixed(0)} ms, bot ${(sm.botReadyToHelloMs ?? 0).toFixed(0)} ms; ejecución ${executionMs.toFixed(0)} ms; decisión p95 ${p95.toFixed(1)} ms (máx ${max.toFixed(1)} ms), CPU ${cpuMs === null ? "no medida" : cpuMs.toFixed(0) + " ms"}`,
        `límites del contenedor: ${limits.cpus} CPU, ${Math.round(limits.memoryBytes / 1048576)} MiB, ${limits.pids} PIDs`,
      ];
      let resources: StageVerdict = { outcome: "passed", logs: resLogs, metrics };
      if (state?.oomKilled) {
        resources = {
          outcome: "failed",
          message: "el contenedor superó su límite de memoria (OOM)",
          logs: resLogs,
          metrics,
        };
      } else if (p95 > cfg.limits.maxDecisionMs) {
        resources = {
          outcome: "failed",
          message: `decisión p95 ${p95.toFixed(0)} ms > ${cfg.limits.maxDecisionMs} ms`,
          logs: resLogs,
          metrics,
        };
      }
      return { protocol, smoke, resources };
    } finally {
      offer.revoke();
      if (container) await container.stop().catch(() => undefined);
      server.stop();
      battle.free();
      await host.close().catch(() => undefined);
    }
  }

  private describeExit(state: ContainerRunState | null, reports: { kind: string; detail: string }[]): string {
    const parts: string[] = [];
    if (state && !state.running && state.exitCode !== null) parts.push(`el proceso salió con código ${state.exitCode}`);
    if (state?.gone) parts.push("el contenedor terminó");
    if (state?.oomKilled) parts.push("OOM");
    if (reports.length) {
      const r = reports[0];
      const lastLine = r.detail.trim().split("\n").slice(-3).join(" | ");
      parts.push(`${r.kind}: ${lastLine}`);
    }
    return parts.length ? ` (${parts.join("; ")})` : "";
  }
}

function formatTimeline(tl: StartupTimeline): string {
  const rel = (t: number | undefined) => (t === undefined ? "—" : `+${(t - tl.launchRequestedAt).toFixed(0)} ms`);
  return (
    `cronología: lanzamiento pedido +0 · contenedor arrancado ${rel(tl.launchedAt)} · artefacto servido ${rel(tl.artifactFetchedAt)}` +
    ` · ready ${rel(tl.readyAt)} · HELLO ${rel(tl.helloAt)}`
  );
}
