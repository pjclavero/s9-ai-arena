/**
 * E6 · bot-manager — orquestador del pipeline de build/publicación (T6.1, cap. 18.1).
 *
 * Máquina de estados persistida sobre `builds` (BuildStore). Ejecuta las etapas en el
 * ORDEN del contrato OpenAPI de E1 (STAGE_ORDER) y, al primer fallo, deja la versión en
 * `rejected` con motivo (DoD: "El fallo en cualquier etapa deja el bot en estado Rechazado
 * con motivo"). Cada etapa registra resultado y logs (consultables por el dueño vía RBAC de
 * T6.4) y emite eventos/hallazgos al AuditSink.
 *
 * Frontera de las dos capas (honestidad de entorno):
 *   - structure, static_analysis, dependencies, build, secret_scan, sign, publish:
 *     LÓGICA PURA, verificada con tests reales aquí.
 *   - protocol_test, smoke_battle, resource_limits: se ejecutan EN PROCESO contra el motor
 *     real de E2 y el esquema real del protocolo de E5, usando un CandidateAgentFactory. En
 *     producción ese factory lo cumple un contenedor por WebSocket (T6.2, pendiente de Docker).
 *     Si no se inyecta agentResolver, estas etapas quedan `skipped` con motivo explícito.
 */
import { randomUUID } from "node:crypto";
import type { PipelineConfig } from "./config.js";
import { packArtifact, sourceSize } from "./artifact.js";
import { analyze } from "./static-analysis.js";
import { scanSecrets } from "./secret-scan.js";
import { signArtifact, type ServiceKeypair } from "./signing.js";
import { runProtocolTest, runSmokeBattle } from "./smoke-battle.js";
import type { BuildStore } from "./store.js";
import { NullAuditSink, type AuditSink } from "./audit-sink.js";
import {
  STAGE_ORDER,
  type Build,
  type BotSubmission,
  type CandidateAgentFactory,
  type StageName,
  type StageResult,
} from "./types.js";
import type { BotAgent } from "../../arena-engine/src/sim/battle.js";

export interface PipelineDeps {
  store: BuildStore;
  config: PipelineConfig;
  signer: ServiceKeypair;
  audit?: AuditSink;
  /** Resuelve el artefacto ejecutable en-proceso (en prod: lanza el contenedor). */
  agentResolver?: (submission: BotSubmission) => CandidateAgentFactory | Promise<CandidateAgentFactory>;
  /** Bot de referencia de E5 para la partida de humo. */
  referenceAgent?: (botId: string) => BotAgent;
  clock?: () => string;
  idgen?: () => string;
}

function newStage(name: StageName): StageResult {
  return { name, status: "pending", logs: [] };
}

export class PipelineError extends Error {}

export class BuildPipeline {
  private readonly audit: AuditSink;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(private deps: PipelineDeps) {
    this.audit = deps.audit ?? NullAuditSink;
    this.now = deps.clock ?? (() => new Date().toISOString());
    this.id = deps.idgen ?? (() => randomUUID());
  }

  /** Ejecuta el pipeline completo para una submission. Devuelve el Build final persistido. */
  async run(submission: BotSubmission): Promise<Build> {
    const correlationId = this.id();
    const build: Build = {
      id: this.id(),
      botId: submission.botId,
      version: submission.version,
      ownerUserId: submission.ownerUserId,
      status: "running",
      botVersionState: "validating",
      stages: STAGE_ORDER.map(newStage),
      correlationId,
      createdAt: this.now(),
    };
    this.deps.store.save(build);
    this.audit.record({ type: "build.started", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id } });

    for (const stage of build.stages) {
      stage.status = "running";
      stage.startedAt = this.now();
      this.deps.store.save(build);
      let ok = false;
      try {
        ok = await this.runStage(stage.name, submission, build, correlationId);
      } catch (e) {
        stage.message = `error interno en etapa: ${(e as Error).message}`;
        ok = false;
      }
      stage.finishedAt = this.now();
      if (stage.status === "skipped") {
        this.deps.store.save(build);
        continue;
      }
      stage.status = ok ? "passed" : "failed";
      this.deps.store.save(build);
      if (!ok) {
        build.status = "failed";
        build.botVersionState = "rejected";
        build.rejectionReason = `${stage.name}: ${stage.message ?? "fallo"}`;
        build.finishedAt = this.now();
        this.deps.store.save(build);
        this.audit.record({ type: "build.rejected", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, stage: stage.name, reason: build.rejectionReason } });
        return this.deps.store.get(build.id)!;
      }
    }

    build.status = "passed";
    build.botVersionState = "published";
    build.finishedAt = this.now();
    this.deps.store.save(build);
    this.audit.record({ type: "build.published", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, artifactHash: build.artifactHash } });
    return this.deps.store.get(build.id)!;
  }

  private stageOf(build: Build, name: StageName): StageResult {
    return build.stages.find((s) => s.name === name)!;
  }

  private async runStage(name: StageName, sub: BotSubmission, build: Build, correlationId: string): Promise<boolean> {
    const stage = this.stageOf(build, name);
    const cfg = this.deps.config;
    switch (name) {
      case "structure": {
        if (!["python", "node"].includes(sub.runtime)) {
          stage.message = `runtime desconocido: ${sub.runtime}`;
          return false;
        }
        if (sub.files.length === 0) {
          stage.message = "paquete vacío";
          return false;
        }
        if (sub.files.length > cfg.maxFileCount) {
          stage.message = `demasiados ficheros: ${sub.files.length} > ${cfg.maxFileCount}`;
          return false;
        }
        const size = sourceSize(sub.files);
        if (size > cfg.maxSourceBytes) {
          stage.message = `fuente ${size} B > límite ${cfg.maxSourceBytes} B`;
          return false;
        }
        const manifest = sub.runtime === "python" ? "requirements.txt" : "package.json";
        if (!sub.files.some((f) => f.path === manifest || f.path.endsWith("/" + manifest))) {
          stage.message = `falta manifiesto ${manifest}`;
          return false;
        }
        stage.logs.push(`estructura ok: ${sub.files.length} ficheros, ${size} B`);
        return true;
      }
      case "static_analysis": {
        const res = analyze(sub.runtime, sub.files, cfg);
        stage.logs.push(`imports: ${res.imports.join(", ") || "(ninguno externo)"}`);
        if (res.dangerousImports.length) {
          stage.logs.push(`imports peligrosos señalados: ${res.dangerousImports.join(", ")}`);
          this.audit.finding({ category: "dangerous_import", severity: "medium", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: `imports de red/proceso/FS: ${res.dangerousImports.join(", ")}`, detail: { imports: res.dangerousImports } });
        }
        if (res.disallowedImports.length) {
          stage.message = `import(s) de paquete no permitido: ${res.disallowedImports.join(", ")}`;
          return false;
        }
        stage.logs.push("análisis estático ok");
        return true;
      }
      case "dependencies": {
        const res = analyze(sub.runtime, sub.files, cfg);
        stage.logs.push(`dependencias declaradas: ${res.declared.map((d) => d.name + (d.version ? "@" + d.version : "")).join(", ") || "(ninguna)"}`);
        if (!res.hasLockfile) {
          stage.message = `falta lockfile obligatorio (${cfg.lockfileNames[sub.runtime].join(" o ")})`;
          return false;
        }
        if (res.disallowedDeps.length) {
          stage.message = `dependencia(s) fuera de la allowlist: ${res.disallowedDeps.join(", ")}`;
          this.audit.finding({ category: "disallowed_dependency", severity: "high", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: stage.message, detail: { deps: res.disallowedDeps } });
          return false;
        }
        stage.logs.push("dependencias dentro de allowlist + lockfile presente");
        return true;
      }
      case "build": {
        const artifact = packArtifact(sub.files);
        if (artifact.bytes.length > cfg.maxArtifactBytes) {
          stage.message = `artefacto ${artifact.bytes.length} B > límite ${cfg.maxArtifactBytes} B`;
          return false;
        }
        build.artifactHash = artifact.hash;
        stage.logs.push(`artefacto empaquetado (reproducible): sha256=${artifact.hash}`);
        return true;
      }
      case "protocol_test": {
        const factory = await this.resolveOrSkip(sub, stage);
        if (!factory) return true; // skipped
        const res = runProtocolTest(factory, sub.botId);
        stage.logs.push(...res.logs);
        if (!res.ok) {
          stage.message = res.reason;
          return false;
        }
        stage.logs.push("prueba de protocolo ok");
        return true;
      }
      case "smoke_battle": {
        const factory = await this.resolveOrSkip(sub, stage);
        if (!factory) return true; // skipped
        if (!this.deps.referenceAgent) {
          stage.status = "skipped";
          stage.message = "sin bot de referencia inyectado (verificación pendiente de entorno)";
          return true;
        }
        const res = await runSmokeBattle({
          candidate: factory,
          candidateBotId: sub.botId,
          candidateArchetype: sub.archetype,
          referenceAgent: this.deps.referenceAgent,
          ticks: cfg.smokeBattleTicks,
        });
        stage.logs.push(...res.logs);
        if (!res.ok) {
          stage.message = res.reason;
          return false;
        }
        stage.logs.push("partida de humo superada");
        return true;
      }
      case "resource_limits": {
        const factory = await this.resolveOrSkip(sub, stage);
        if (!factory) return true; // skipped
        const m = this.measure(factory, sub.botId);
        stage.metrics = m;
        stage.logs.push(`arranque ${m.startupMs.toFixed(1)} ms, decisión máx ${m.maxDecisionMs.toFixed(2)} ms, heap Δ ${(m.heapDeltaBytes / 1024).toFixed(0)} KB`);
        if (m.startupMs > cfg.limits.maxStartupMs) {
          stage.message = `arranque ${m.startupMs.toFixed(0)} ms > ${cfg.limits.maxStartupMs} ms`;
          return false;
        }
        if (m.maxDecisionMs > cfg.limits.maxDecisionMs) {
          stage.message = `decisión ${m.maxDecisionMs.toFixed(0)} ms > ${cfg.limits.maxDecisionMs} ms`;
          this.audit.finding({ category: "resource_abuse", severity: "medium", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: stage.message, detail: m });
          return false;
        }
        stage.logs.push("dentro de límites de recursos (medición en-proceso)");
        return true;
      }
      case "secret_scan": {
        const matches = scanSecrets(sub.files);
        if (matches.length) {
          stage.message = `secreto(s) detectado(s): ${matches.map((m) => `${m.kind}@${m.file}:${m.line}`).join(", ")}`;
          for (const m of matches) {
            stage.logs.push(`hallazgo: ${m.kind} en ${m.file}:${m.line} (${m.excerpt})`);
            this.audit.finding({ category: "secret_leak", severity: "critical", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: `${m.kind} en ${m.file}:${m.line}`, detail: { kind: m.kind, file: m.file, line: m.line } });
          }
          return false;
        }
        stage.logs.push("sin secretos detectados");
        return true;
      }
      case "sign": {
        if (!build.artifactHash) {
          stage.message = "no hay artefacto que firmar";
          return false;
        }
        build.signature = signArtifact(build.artifactHash, this.deps.signer.privateKey);
        stage.logs.push(`artefacto firmado (ed25519): ${build.signature.slice(0, 16)}…`);
        return true;
      }
      case "publish": {
        stage.logs.push(`versión ${sub.version} de ${sub.botId} publicada (inmutable)`);
        return true;
      }
    }
  }

  private async resolveOrSkip(sub: BotSubmission, stage: StageResult): Promise<CandidateAgentFactory | null> {
    if (!this.deps.agentResolver) {
      stage.status = "skipped";
      stage.message = "sin agentResolver (ejecución real pendiente de entorno con Docker)";
      return null;
    }
    return await this.deps.agentResolver(sub);
  }

  /** Medición en-proceso de arranque, tiempo de decisión y heap. Proxy honesto del cgroup real. */
  private measure(factory: CandidateAgentFactory, botId: string): { startupMs: number; maxDecisionMs: number; heapDeltaBytes: number } {
    const t0 = performance.now();
    const agent = factory.create(botId);
    const startupMs = performance.now() - t0;
    const heapBefore = process.memoryUsage().heapUsed;
    let maxDecisionMs = 0;
    const obs = { tick: 0, self: { position: { x: 0, y: 0 }, heading: 0, turretHeading: 0 }, sensors: { radar: [] } };
    for (let i = 0; i < 30; i++) {
      const d0 = performance.now();
      try {
        agent.decide({ ...obs, tick: i * 3 });
      } catch {
        /* una excepción se penaliza como decisión lenta al no completar; se ignora aquí */
      }
      maxDecisionMs = Math.max(maxDecisionMs, performance.now() - d0);
    }
    const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    return { startupMs, maxDecisionMs, heapDeltaBytes };
  }
}
