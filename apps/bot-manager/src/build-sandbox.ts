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
 *   protocol_test    HELLO dentro del plazo; todo mensaje del bot valida contra
 *                    envelope.schema.json; al menos un COMMAND válido.
 *   smoke_battle     la batalla termina y el candidato NO queda descalificado.
 *   resource_limits  arranque ≤ maxStartupMs, p95 de decisión ≤ maxDecisionMs,
 *                    sin OOM (los límites duros los aplica el cgroup).
 *
 * Fallos de PLATAFORMA (proxy caído, imagen ausente, postura no conforme, motor
 * colgado) lanzan SandboxInfrastructureError: NO son culpa del bot. El pipeline
 * los propaga, el worker reintenta y, agotado, cierra el build fail-closed
 * («build no verificable»), nunca `validated`.
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
   * Margen de PLATAFORMA para el handshake (crear/arrancar el contenedor en la
   * Engine puede tardar segundos bajo carga; no es tiempo del bot). El
   * arranque del BOT se mide desde State.StartedAt y se juzga contra
   * maxStartupMs en resource_limits. Def. 20000 ms.
   */
  platformGraceMs?: number;
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
      handshakeTimeoutMs: cfg.limits.maxStartupMs,
    });
    battle.attachBot("veh_2", this.o.referenceAgent("ref_bot"));
    const offer = host.offerArtifact(artifact.bytes, artifact.hash);

    const logs: string[] = [];
    let container: ContainerHandle | undefined;
    try {
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
      const tLaunch = performance.now();
      try {
        container = await this.o.runner.launch(spec);
      } catch (e) {
        throw new SandboxInfrastructureError(`el sandbox no pudo lanzar el contenedor: ${(e as Error).message}`);
      }
      // El bot puede arrancar mientras la Engine aún responde al `start`: el
      // arranque se mide desde que el contenedor existe, y se informa aparte
      // cuánto tardó la plataforma en crearlo/arrancarlo (no es culpa del bot).
      const t0 = performance.now();
      const launchMs = t0 - tLaunch;
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

      // 1) Handshake: plazo del bot + margen de plataforma (o salida temprana).
      const waitMs = cfg.limits.maxStartupMs + (this.o.platformGraceMs ?? 20_000);
      const connected = await this.waitHandshake(server, container, waitMs);
      if (connected.ok === false) {
        const reason = `el bot no completó el handshake (HELLO) en ${waitMs} ms${this.describeExit(connected.state, offer.reports)}`;
        return {
          protocol: {
            outcome: "failed",
            message: reason,
            logs: [...logs, `descargas del artefacto: ${offer.fetches}`],
          },
          smoke: notRun("no ejecutada: el bot no arrancó"),
          resources: notRun("no ejecutada: el bot no arrancó"),
        };
      }
      // Arranque del BOT = HELLO − arranque del proceso en la Engine
      // (State.StartedAt). Sin StartedAt (contenedor ya inspeccionable no), desde
      // que la Engine devolvió el contenedor arrancado.
      const startedAtMs = (await container.state?.().catch(() => null))?.startedAtMs;
      const startupMs =
        startedAtMs !== undefined && tap.helloWallMs !== null
          ? Math.max(0, tap.helloWallMs - startedAtMs)
          : Math.max(0, (tap.helloAt ?? performance.now()) - t0);
      logs.push(`handshake completado en ${startupMs.toFixed(0)} ms (artefacto descargado ${offer.fetches} vez/veces)`);

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
      const cpuMs = (await container.cpuMs?.().catch(() => null)) ?? null;
      const state = (await container.state?.().catch(() => null)) ?? null;

      // ---- veredictos
      const p95 = percentile(tap.latencies, 95);
      const max = tap.latencies.length ? Math.max(...tap.latencies) : 0;
      const metrics: Record<string, number> = {
        startupMs,
        launchMs,
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
        `arranque ${startupMs.toFixed(0)} ms, decisión p95 ${p95.toFixed(1)} ms (máx ${max.toFixed(1)} ms), CPU ${cpuMs === null ? "no medida" : cpuMs.toFixed(0) + " ms"}`,
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
      } else if (startupMs > cfg.limits.maxStartupMs) {
        resources = {
          outcome: "failed",
          message: `arranque ${startupMs.toFixed(0)} ms > ${cfg.limits.maxStartupMs} ms`,
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

  /** Espera el handshake; deja de esperar si el contenedor muere antes. */
  private async waitHandshake(
    server: ProtocolServer,
    container: ContainerHandle,
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; state: ContainerRunState | null }> {
    let done = false;
    const connected = server.whenAllConnected(timeoutMs).then(
      () => true,
      () => false,
    );
    const exited = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 250));
        if (done) break;
        const st = await container.state?.().catch(() => null);
        if (st && !st.running) return st;
      }
      return null;
    })();
    const first = await Promise.race([
      connected.then((ok) => ({ kind: "conn" as const, ok })),
      exited.then((st) => ({ kind: "exit" as const, st })),
    ]);
    done = true;
    if (first.kind === "conn" && first.ok) return { ok: true };
    const st = first.kind === "exit" ? first.st : ((await container.state?.().catch(() => null)) ?? null);
    // Dar al bootstrap un instante para que su informe llegue.
    await new Promise((r) => setTimeout(r, 300));
    return { ok: false, state: st };
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
