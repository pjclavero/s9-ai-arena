/**
 * T7.3 · Adaptador REAL hacia el pipeline de E6 (apps/bot-manager, T6.1).
 *
 * Importa BuildPipeline de E6 — NO reimplementa lógica de builds. La API solo:
 *  1) decodifica el paquete subido (JSON de ficheros, o un único archivo "pegado"
 *     que se envuelve en el esqueleto estándar del runtime),
 *  2) construye la BotSubmission de E6 y ejecuta su pipeline,
 *  3) persiste el resultado con completeBuild() (validating → validated|rejected).
 *
 * Reconciliación con E6 (documentada en docs/entrega-E7.md):
 *  - El `agentResolver` (sandbox containerizado con Docker, T6.2) es una DEPENDENCIA
 *    OBLIGATORIA en PRODUCCIÓN. Sin él, E6 NO puede ejecutar el bot en
 *    protocol_test/smoke_battle/resource_limits y FALLA CERRADO (R1.5 · ERR-SEC-03):
 *    el pipeline rechaza la versión como "no verificable" en vez de validarla. Por eso
 *    la app NO cablea por defecto un resolver falso ni la escotilla dev/test: mientras
 *    no exista el runner con Docker, la plataforma RECHAZA en vez de validar sin sandbox.
 *  - E6 y E7 aplican ambos el cap. 17.1 (reconciliado en el issue #13): el pase del
 *    pipeline deja la versión en `validated` (también en el Build de E6) y publicar
 *    es una acción EXPLÍCITA del dueño. Aquí completeBuild persiste passed → validated
 *    y failed → rejected (con motivo).
 */
import { BuildPipeline } from "../../../bot-manager/src/pipeline.js";
import { InMemoryBuildStore } from "../../../bot-manager/src/store.js";
import { withConfig } from "../../../bot-manager/src/config.js";
import { loadServiceKeypair, type ServiceKeypair } from "../../../bot-manager/src/signing.js";
import type { BotSubmission, SourceFile, Runtime, CandidateAgentFactory } from "../../../bot-manager/src/types.js";
import type { BotAgent } from "../../../arena-engine/src/sim/battle.js";
import type { Db } from "../db/connection.js";
import {
  completeBuild,
  type BotManagerClient,
  type BuildRequest,
  type BuildResult,
  PIPELINE_STAGES,
} from "./bot-manager.js";
import { splitVersioned } from "../../../../packages/module-catalog/types.js";
// R2.6 (ERR-SEC-10): la decodificación estricta del paquete vive en source-package.ts.
import { decodePackage, wrapSingleFile, PackageValidationError } from "./source-package.js";

export { decodePackage, wrapSingleFile };

/** Arquetipo de la partida de humo según el chasis del loadout (ARCHETYPES de E3). */
export function archetypeForChassis(chassis: string): BotSubmission["archetype"] {
  const base = splitVersioned(chassis).base;
  if (base === "chassis.light") return "scout";
  if (base === "chassis.heavy") return "heavy";
  return "gunner";
}

export class E6PipelineBotManager implements BotManagerClient {
  private signer: ServiceKeypair;
  private agentResolver?: (submission: BotSubmission) => CandidateAgentFactory | Promise<CandidateAgentFactory>;
  private referenceAgent?: (botId: string) => BotAgent;
  private allowUnverifiedSandbox: boolean;

  constructor(
    private db: Db,
    opts: {
      signer?: ServiceKeypair;
      /**
       * Resolver del sandbox real (contenedor con Docker, T6.2). DEPENDENCIA
       * OBLIGATORIA en PRODUCCIÓN: sin él, las etapas protocol_test/smoke_battle/
       * resource_limits no se ejecutan y el pipeline FALLA CERRADO — rechaza la versión
       * como "no verificable" (R1.5 · ERR-SEC-03). La app NO lo cablea por defecto.
       */
      agentResolver?: (submission: BotSubmission) => CandidateAgentFactory | Promise<CandidateAgentFactory>;
      /** Bot de referencia de E5 para la partida de humo (parte del sandbox real). */
      referenceAgent?: (botId: string) => BotAgent;
      /**
       * Escotilla dev/test EXPLÍCITA. Si es true, un sandbox no ejecutable NO bloquea
       * la validación (el bot puede quedar `validated` sin ejecutarse). NUNCA debe
       * activarse en producción; la app jamás la pone.
       */
      allowUnverifiedSandbox?: boolean;
    } = {},
  ) {
    // R2.5 (ERR-SEC-15): la clave de firma sale del almacén de secretos
    // (ARTIFACT_SIGNING_KEY_FILE / ARTIFACT_SIGNING_KEY), no de un par efímero:
    // una clave por proceso invalidaría la verificación entre servicios y
    // moriría con cada reinicio. Sin clave configurada, loadServiceKeypair
    // FALLA CERRADO (salvo modo dev explícito).
    this.signer = opts.signer ?? loadServiceKeypair();
    this.agentResolver = opts.agentResolver;
    this.referenceAgent = opts.referenceAgent;
    this.allowUnverifiedSandbox = opts.allowUnverifiedSandbox ?? false;
  }

  async enqueueBuild(req: BuildRequest): Promise<void> {
    const version = await this.db("bot_versions").where({ bot_id: req.botId, version: req.version }).first();
    const loadout = await this.db("bot_loadouts")
      .where({ bot_id: req.botId, revision: version.loadout_revision })
      .first();

    // R2.6 (ERR-SEC-10): un paquete inválido (rutas ../, absolutas, control,
    // sin manifiesto en raíz…) se RECHAZA en decodificación — falla cerrado,
    // el build queda failed y la versión rejected, nunca llega al pipeline.
    let files: SourceFile[];
    try {
      files = decodePackage(version.source, req.runtime);
    } catch (err) {
      if (!(err instanceof PackageValidationError)) throw err;
      const failed: BuildResult = {
        status: "failed",
        stages: PIPELINE_STAGES.map((name) => ({
          name,
          status: name === "structure" ? ("failed" as const) : ("skipped" as const),
          ...(name === "structure" ? { message: err.message } : {}),
        })),
        rejectionReason: err.message,
      };
      await completeBuild(this.db, req.buildId, failed);
      return;
    }

    const submission: BotSubmission = {
      botId: req.botId,
      version: req.version,
      ownerUserId: (await this.db("bots").where({ id: req.botId }).first()).owner_id,
      runtime: req.runtime,
      archetype: archetypeForChassis(loadout.chassis),
      files,
    };

    const pipeline = new BuildPipeline({
      store: new InMemoryBuildStore(),
      config: withConfig(),
      signer: this.signer,
      // Sandbox real (T6.2). Si NO se inyecta agentResolver, E6 falla cerrado: las
      // etapas protocol_test/smoke_battle/resource_limits son "no ejecutables" y el
      // build se RECHAZA como "no verificable" (R1.5 · ERR-SEC-03) — nunca `validated`.
      agentResolver: this.agentResolver,
      referenceAgent: this.referenceAgent,
      allowUnverifiedSandbox: this.allowUnverifiedSandbox,
    });
    const result = await pipeline.run(submission);

    const mapped: BuildResult = {
      status: result.status === "passed" ? "passed" : "failed",
      stages: result.stages.map((s) => ({
        name: s.name as (typeof PIPELINE_STAGES)[number],
        status: s.status,
        message: s.message,
        // Los logs de etapa de E6 se guardan con el build; getBuild los expone
        // solo a dueño/moderador/admin (x-private del contrato).
        ...(s.logs.length > 0 ? { logUrl: `build-logs:${req.buildId}/${s.name}` } : {}),
      })),
      artifactHash: result.artifactHash,
      signature: result.signature,
      artifactBytes: result.artifactBytes,
      rejectionReason: result.rejectionReason,
    };
    await completeBuild(this.db, req.buildId, mapped);
  }
}
