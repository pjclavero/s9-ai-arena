/**
 * T7.3 · Interfaz con bot-manager (E6/T6.1).
 *
 * ⚠ PENDIENTE DE RECONCILIACIÓN CON E6: el pipeline real de builds lo implementa
 * otro equipo en paralelo. Esta interfaz es el contrato que la plataforma asume
 * (etapas del cap. 18.1, resultado passed/failed con hash de artefacto firmado).
 * La API delega aquí y NUNCA implementa lógica de builds.
 */
import type { Db } from "../db/connection.js";
import { audit } from "../audit.js";

/** Etapas del pipeline del capítulo 18.1, en el orden del contrato de E1. */
export const PIPELINE_STAGES = [
  "structure",
  "static_analysis",
  "dependencies",
  "build",
  "protocol_test",
  "smoke_battle",
  "resource_limits",
  "secret_scan",
  "sign",
  "publish",
] as const;

export interface BuildRequest {
  buildId: string;
  botId: string;
  version: number;
  runtime: "python" | "node";
}

export interface BotManagerClient {
  /** Encola el pipeline de validación de una versión de bot. */
  enqueueBuild(req: BuildRequest): Promise<void>;
}

/**
 * Stub documentado: registra el encolado en `jobs` y deja el build en `queued`.
 * El bot-manager real (E6) consumirá la cola y notificará con completeBuild().
 */
export class StubBotManager implements BotManagerClient {
  constructor(private db: Db) {}
  async enqueueBuild(req: BuildRequest): Promise<void> {
    await this.db("jobs").insert({
      kind: "bot_build",
      payload: JSON.stringify(req),
      status: "queued",
    });
  }
}

export interface BuildResult {
  status: "passed" | "failed";
  stages: { name: (typeof PIPELINE_STAGES)[number]; status: string; message?: string; logUrl?: string }[];
  artifactHash?: string;
  signature?: string;
  rejectionReason?: string;
}

/**
 * Callback de finalización del pipeline (lo invocará el bot-manager real de E6;
 * en tests lo invoca el FakeBotManager). Transiciona validating→validated|rejected.
 */
export async function completeBuild(db: Db, buildId: string, result: BuildResult): Promise<void> {
  await db.transaction(async (trx) => {
    const build = await trx("builds").where({ id: buildId }).first();
    if (!build) throw new Error(`Build desconocido: ${buildId}`);

    await trx("builds")
      .where({ id: buildId })
      .update({
        status: result.status,
        stages: JSON.stringify(result.stages),
        artifact_hash: result.artifactHash ?? null,
        updated_at: trx.fn.now(),
      });

    const version = await trx("bot_versions")
      .where({ bot_id: build.bot_id, version: build.version })
      .first();
    if (version?.state !== "validating") return; // p. ej. suspendida durante el build

    if (result.status === "passed") {
      await trx("bot_versions")
        .where({ id: version.id })
        .update({ state: "validated", artifact_hash: result.artifactHash ?? null, rejection_reason: null });
      if (result.artifactHash) {
        await trx("artifacts").insert({
          build_id: buildId,
          hash: result.artifactHash,
          signature: result.signature ?? null,
          storage_ref: `artifacts/${build.bot_id}/${build.version}/${result.artifactHash}`,
        });
      }
    } else {
      await trx("bot_versions")
        .where({ id: version.id })
        .update({ state: "rejected", rejection_reason: result.rejectionReason ?? "pipeline failed" });
    }
  });
  const build = await db("builds").where({ id: buildId }).first();
  await audit(db, {
    action: `bot.version.${result.status === "passed" ? "validated" : "rejected"}`,
    target: `bot:${build.bot_id}@${build.version}`,
    detail: { buildId, status: result.status },
  });
}

/** Doble de test: valida inmediatamente con resultado configurable. */
export class FakeBotManager implements BotManagerClient {
  constructor(
    private db: Db,
    public nextResult: () => BuildResult = () => ({
      status: "passed",
      stages: PIPELINE_STAGES.map((name) => ({
        name,
        status: "passed",
        logUrl: `https://logs.internal/${name}`,
      })),
      artifactHash: "f".repeat(64),
      signature: "fake-signature",
    }),
  ) {}
  async enqueueBuild(req: BuildRequest): Promise<void> {
    await completeBuild(this.db, req.buildId, this.nextResult());
  }
}
