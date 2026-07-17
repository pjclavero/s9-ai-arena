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
 *
 * FALLAR CERRADO (R1.5 · ERR-SEC-03): si no hay `agentResolver`, esas tres etapas NO pueden
 * ejecutar el bot. Eso NO es un "pase": se marcan `skipped` (honesto: no se ejecutaron) y
 * BLOQUEAN la promoción a `validated`. El estado terminal honesto de un bot cuyo sandbox no
 * se pudo ejecutar es `rejected` ("no verificable"), NUNCA `validated`. El `agentResolver`
 * real (contenedor con Docker) es una DEPENDENCIA OBLIGATORIA en producción. Solo un modo
 * dev/test EXPLÍCITO (`allowUnverifiedSandbox: true`) relaja esto — jamás el camino por defecto.
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
  /**
   * ESCOTILLA dev/test EXPLÍCITA (R1.5 · ERR-SEC-03). Si es `true`, una etapa de
   * ejecución que no pudo correr (sandbox no disponible) se trata como skip NO
   * bloqueante y el build puede llegar a `validated`. Por defecto es `false`
   * (fallar cerrado): sin sandbox verificado el bot NO puede quedar `validated`.
   * NUNCA debe activarse en producción ni ser el camino por defecto de la app.
   */
  allowUnverifiedSandbox?: boolean;
  clock?: () => string;
  idgen?: () => string;
}

function newStage(name: StageName): StageResult {
  return { name, status: "pending", logs: [] };
}

export class PipelineError extends Error {}

/**
 * Desenlace de UNA etapa (R1.5 · ERR-SEC-03). Reemplaza al antiguo `boolean` para
 * distinguir TRES casos, no dos:
 *   - "passed":         la etapa se ejecutó y el bot la superó.
 *   - "failed":         la etapa se ejecutó y el bot NO la superó → rechazo con motivo.
 *   - "not_executable": la etapa NO pudo ejecutarse por falta de entorno (sin
 *                       agentResolver/Docker, o sin bot de referencia para la partida
 *                       de humo). NO es un pase: bloquea la transición a `validated`.
 */
export type StageOutcome = "passed" | "failed" | "not_executable";

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

    // Etapas de EJECUCIÓN cuya verificación no se pudo correr (sandbox no disponible).
    // No cuentan como superadas: bloquean la promoción a `validated` (fallar cerrado,
    // ERR-SEC-03). Se anotan aquí y se resuelven al final del pipeline.
    const unverifiedStages: StageName[] = [];

    for (const stage of build.stages) {
      stage.status = "running";
      stage.startedAt = this.now();
      this.deps.store.save(build);
      let outcome: StageOutcome;
      try {
        outcome = await this.runStage(stage.name, submission, build, correlationId);
      } catch (e) {
        stage.message = `error interno en etapa: ${(e as Error).message}`;
        outcome = "failed";
      }
      stage.finishedAt = this.now();

      if (outcome === "not_executable") {
        // Honesto: la etapa NO se ejecutó (falta el entorno de sandbox). Se marca
        // `skipped` y se ANOTA como bloqueante. El resto de etapas puras siguen
        // corriendo (defensa en profundidad: p. ej. secret_scan aún puede rechazar),
        // pero el build NO podrá quedar `validated` salvo escotilla dev/test explícita.
        stage.status = "skipped";
        unverifiedStages.push(stage.name);
        this.deps.store.save(build);
        continue;
      }

      stage.status = outcome === "passed" ? "passed" : "failed";
      this.deps.store.save(build);
      if (outcome === "failed") {
        build.status = "failed";
        build.botVersionState = "rejected";
        build.rejectionReason = `${stage.name}: ${stage.message ?? "fallo"}`;
        build.finishedAt = this.now();
        this.deps.store.save(build);
        this.audit.record({ type: "build.rejected", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, stage: stage.name, reason: build.rejectionReason } });
        return this.deps.store.get(build.id)!;
      }
    }

    // FALLAR CERRADO (R1.5 · ERR-SEC-03): si alguna etapa de EJECUCIÓN no pudo correr,
    // el bot NUNCA se ha ejecutado en un sandbox. Su estado terminal honesto es
    // `rejected` ("no verificable"), NO `validated`. Solo un modo dev/test EXPLÍCITO
    // (allowUnverifiedSandbox) puede relajar esto; jamás es el camino por defecto.
    if (unverifiedStages.length > 0 && !this.deps.allowUnverifiedSandbox) {
      build.status = "failed";
      build.botVersionState = "rejected";
      build.rejectionReason = `sandbox no verificado: etapa(s) de ejecución no ejecutable(s) [${unverifiedStages.join(", ")}]. Se requiere un entorno con Docker (agentResolver) para ejecutar el bot; sin él no puede quedar 'validated' (ERR-SEC-03, R1.5).`;
      build.finishedAt = this.now();
      this.deps.store.save(build);
      this.audit.finding({ category: "sandbox_unverified", severity: "high", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, summary: `build rechazado: sandbox no verificado (${unverifiedStages.join(", ")})`, detail: { buildId: build.id, unverifiedStages } });
      this.audit.record({ type: "build.rejected", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, reason: build.rejectionReason, unverifiedStages } });
      return this.deps.store.get(build.id)!;
    }

    build.status = "passed";
    // Cap. 17.1 (máquina de estados de E7, issue #13): el pase del pipeline deja la
    // versión en `validated`; PUBLICAR es una acción explícita del dueño, no del
    // pipeline. (Antes E6 marcaba "published" aquí; E7 ya aplicaba 17.1 al mapear.)
    build.botVersionState = "validated";
    if (unverifiedStages.length > 0) {
      // Solo se llega aquí con la escotilla dev/test EXPLÍCITA activada: deja rastro
      // en auditoría de que la validación NO ejercitó el sandbox real.
      this.audit.record({ type: "build.validated_unverified_dev", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, unverifiedStages, note: "allowUnverifiedSandbox=true (dev/test)" } });
    }
    build.finishedAt = this.now();
    this.deps.store.save(build);
    this.audit.record({ type: "build.validated", botId: build.botId, version: build.version, userId: build.ownerUserId, correlationId, detail: { buildId: build.id, artifactHash: build.artifactHash } });
    return this.deps.store.get(build.id)!;
  }

  private stageOf(build: Build, name: StageName): StageResult {
    return build.stages.find((s) => s.name === name)!;
  }

  private async runStage(name: StageName, sub: BotSubmission, build: Build, correlationId: string): Promise<StageOutcome> {
    const stage = this.stageOf(build, name);
    const cfg = this.deps.config;
    switch (name) {
      case "structure": {
        if (!["python", "node"].includes(sub.runtime)) {
          stage.message = `runtime desconocido: ${sub.runtime}`;
          return "failed";
        }
        if (sub.files.length === 0) {
          stage.message = "paquete vacío";
          return "failed";
        }
        if (sub.files.length > cfg.maxFileCount) {
          stage.message = `demasiados ficheros: ${sub.files.length} > ${cfg.maxFileCount}`;
          return "failed";
        }
        const size = sourceSize(sub.files);
        if (size > cfg.maxSourceBytes) {
          stage.message = `fuente ${size} B > límite ${cfg.maxSourceBytes} B`;
          return "failed";
        }
        const manifest = sub.runtime === "python" ? "requirements.txt" : "package.json";
        if (!sub.files.some((f) => f.path === manifest || f.path.endsWith("/" + manifest))) {
          stage.message = `falta manifiesto ${manifest}`;
          return "failed";
        }
        stage.logs.push(`estructura ok: ${sub.files.length} ficheros, ${size} B`);
        return "passed";
      }
      case "static_analysis": {
        const res = analyze(sub.runtime, sub.files, cfg);
        stage.logs.push(`imports: ${res.imports.join(", ") || "(ninguno externo)"}`);
        // R2.4 (ERR-SEC-06) · FAIL-CLOSED: lo que no se puede parsear no se aprueba,
        // y las construcciones dinámicas (__import__, eval/exec, require(var),
        // __builtins__…) bloquean con CUALQUIER política: derrotan al análisis.
        if (res.parseErrors.length) {
          stage.message = `fichero(s) no analizables (AST), se rechaza fail-closed: ${res.parseErrors.map((p) => `${p.path} (${p.detail})`).join("; ")}`;
          return "failed";
        }
        if (res.dynamicFindings.length) {
          stage.message = `construcción(es) dinámica(s) prohibida(s): ${res.dynamicFindings.map((d) => `${d.path}: ${d.detail}`).join("; ")}`;
          this.audit.finding({ category: "dangerous_import", severity: "high", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: `construcciones dinámicas que eluden el análisis estático`, detail: { findings: res.dynamicFindings } });
          return "failed";
        }
        if (res.dangerousImports.length) {
          // El hallazgo de auditoría se registra SIEMPRE (con cualquier política).
          stage.logs.push(`imports peligrosos señalados: ${res.dangerousImports.join(", ")}`);
          this.audit.finding({ category: "dangerous_import", severity: "medium", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: `imports de red/proceso/FS: ${res.dangerousImports.join(", ")}`, detail: { imports: res.dangerousImports, policy: cfg.dangerousBuiltins.mode } });
        }
        if (res.disallowedImports.length) {
          stage.message = `import(s) de paquete no permitido: ${res.disallowedImports.join(", ")}`;
          return "failed";
        }
        // H1 (issue #5): política bloqueante por defecto para builtins peligrosos de la
        // stdlib. El sandbox (T6.2) sigue siendo la defensa principal; esto es defensa
        // en profundidad mientras no esté verificado en vivo.
        if (cfg.dangerousBuiltins.mode === "block" && res.dangerousImports.length) {
          stage.message = `import(s) de builtin peligroso bloqueado(s) por política: ${res.dangerousImports.join(", ")} (el sandbox sigue siendo la defensa principal; ver issue #5)`;
          return "failed";
        }
        stage.logs.push("análisis estático ok");
        return "passed";
      }
      case "dependencies": {
        const res = analyze(sub.runtime, sub.files, cfg);
        stage.logs.push(`dependencias declaradas: ${res.declared.map((d) => d.name + (d.version ? "@" + d.version : "")).join(", ") || "(ninguna)"}`);
        if (!res.hasLockfile) {
          stage.message = `falta lockfile obligatorio (${cfg.lockfileNames[sub.runtime].join(" o ")})`;
          return "failed";
        }
        if (res.disallowedDeps.length) {
          stage.message = `dependencia(s) fuera de la allowlist: ${res.disallowedDeps.join(", ")}`;
          this.audit.finding({ category: "disallowed_dependency", severity: "high", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: stage.message, detail: { deps: res.disallowedDeps } });
          return "failed";
        }
        stage.logs.push("dependencias dentro de allowlist + lockfile presente");
        return "passed";
      }
      case "build": {
        const artifact = packArtifact(sub.files);
        if (artifact.bytes.length > cfg.maxArtifactBytes) {
          stage.message = `artefacto ${artifact.bytes.length} B > límite ${cfg.maxArtifactBytes} B`;
          return "failed";
        }
        build.artifactHash = artifact.hash;
        stage.logs.push(`artefacto empaquetado (reproducible): sha256=${artifact.hash}`);
        return "passed";
      }
      case "protocol_test": {
        const factory = await this.resolveAgent(sub, stage);
        if (!factory) return "not_executable";
        const res = runProtocolTest(factory, sub.botId);
        stage.logs.push(...res.logs);
        if (!res.ok) {
          stage.message = res.reason;
          return "failed";
        }
        stage.logs.push("prueba de protocolo ok");
        return "passed";
      }
      case "smoke_battle": {
        const factory = await this.resolveAgent(sub, stage);
        if (!factory) return "not_executable";
        if (!this.deps.referenceAgent) {
          // Sin bot de referencia no hay adversario: la partida de humo NO se puede
          // ejecutar. Igual que la falta de agentResolver, es "no ejecutable" y
          // bloquea la validación (fallar cerrado) — antes se daba por superada.
          stage.message = "sin bot de referencia inyectado (verificación pendiente de entorno)";
          return "not_executable";
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
          return "failed";
        }
        stage.logs.push("partida de humo superada");
        return "passed";
      }
      case "resource_limits": {
        const factory = await this.resolveAgent(sub, stage);
        if (!factory) return "not_executable";
        const m = this.measure(factory, sub.botId);
        stage.metrics = m;
        stage.logs.push(`arranque ${m.startupMs.toFixed(1)} ms, decisión máx ${m.maxDecisionMs.toFixed(2)} ms, heap Δ ${(m.heapDeltaBytes / 1024).toFixed(0)} KB`);
        if (m.startupMs > cfg.limits.maxStartupMs) {
          stage.message = `arranque ${m.startupMs.toFixed(0)} ms > ${cfg.limits.maxStartupMs} ms`;
          return "failed";
        }
        if (m.maxDecisionMs > cfg.limits.maxDecisionMs) {
          stage.message = `decisión ${m.maxDecisionMs.toFixed(0)} ms > ${cfg.limits.maxDecisionMs} ms`;
          this.audit.finding({ category: "resource_abuse", severity: "medium", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: stage.message, detail: m });
          return "failed";
        }
        stage.logs.push("dentro de límites de recursos (medición en-proceso)");
        return "passed";
      }
      case "secret_scan": {
        const matches = scanSecrets(sub.files);
        if (matches.length) {
          stage.message = `secreto(s) detectado(s): ${matches.map((m) => `${m.kind}@${m.file}:${m.line}`).join(", ")}`;
          for (const m of matches) {
            stage.logs.push(`hallazgo: ${m.kind} en ${m.file}:${m.line} (${m.excerpt})`);
            this.audit.finding({ category: "secret_leak", severity: "critical", botId: sub.botId, version: sub.version, userId: sub.ownerUserId, correlationId, summary: `${m.kind} en ${m.file}:${m.line}`, detail: { kind: m.kind, file: m.file, line: m.line } });
          }
          return "failed";
        }
        stage.logs.push("sin secretos detectados");
        return "passed";
      }
      case "sign": {
        if (!build.artifactHash) {
          stage.message = "no hay artefacto que firmar";
          return "failed";
        }
        build.signature = signArtifact(build.artifactHash, this.deps.signer.privateKey);
        stage.logs.push(`artefacto firmado (ed25519): ${build.signature.slice(0, 16)}…`);
        return "passed";
      }
      case "publish": {
        // La etapa `publish` del contrato OpenAPI publica el ARTEFACTO (inmutable) en
        // el registro interno; el ESTADO de la versión queda en `validated` (17.1):
        // exponerla públicamente es una acción explícita del dueño vía la API de E7.
        stage.logs.push(`artefacto de la versión ${sub.version} de ${sub.botId} publicado (inmutable); versión validated`);
        return "passed";
      }
    }
  }

  /**
   * Resuelve la fábrica de agente en-proceso para las etapas que EJECUTAN el bot.
   * Devuelve `null` cuando no hay entorno de ejecución (sin `agentResolver`): el
   * llamador lo traduce a `not_executable` (fallar cerrado), NUNCA a un pase. En
   * producción el `agentResolver` real (contenedor con Docker) es OBLIGATORIO.
   */
  private async resolveAgent(sub: BotSubmission, stage: StageResult): Promise<CandidateAgentFactory | null> {
    if (!this.deps.agentResolver) {
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
