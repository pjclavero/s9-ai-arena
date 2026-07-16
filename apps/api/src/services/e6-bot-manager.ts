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
 *  - Sin agentResolver, E6 deja protocol_test/smoke_battle/resource_limits en
 *    `skipped` (su ejecución containerizada exige Docker, T6.2).
 *  - E6 y E7 aplican ambos el cap. 17.1 (reconciliado en el issue #13): el pase del
 *    pipeline deja la versión en `validated` (también en el Build de E6) y publicar
 *    es una acción EXPLÍCITA del dueño. Aquí completeBuild persiste passed → validated.
 */
import { BuildPipeline } from "../../../bot-manager/src/pipeline.js";
import { InMemoryBuildStore } from "../../../bot-manager/src/store.js";
import { withConfig } from "../../../bot-manager/src/config.js";
import { generateServiceKeypair, type ServiceKeypair } from "../../../bot-manager/src/signing.js";
import type { BotSubmission, SourceFile, Runtime } from "../../../bot-manager/src/types.js";
import type { Db } from "../db/connection.js";
import { completeBuild, type BotManagerClient, type BuildRequest, type BuildResult, PIPELINE_STAGES } from "./bot-manager.js";
import { splitVersioned } from "../../../../packages/module-catalog/types.js";

/** Paquete estándar mínimo alrededor de código "pegado" (T7.4: archivo o pegado). */
export function wrapSingleFile(runtime: Runtime, content: string): SourceFile[] {
  if (runtime === "python") {
    return [
      { path: "manifest.json", content: JSON.stringify({ runtime: "python", entry: "src/bot.py" }, null, 2) },
      { path: "requirements.txt", content: "arena-sdk==1.0.0\n" },
      { path: "requirements.lock", content: "arena-sdk==1.0.0\n" },
      { path: "src/bot.py", content },
    ];
  }
  return [
    {
      path: "package.json",
      content: JSON.stringify({ name: "bot", version: "1.0.0", dependencies: { "@arena/sdk": "1.0.0" } }, null, 2),
    },
    { path: "package-lock.json", content: JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2) },
    { path: "src/bot.js", content },
  ];
}

/**
 * Decodifica el paquete subido: o bien un JSON `{"files":[{"path","content"},…]}`
 * (formato de paquete de la plataforma), o bien un único archivo de código.
 */
export function decodePackage(source: Buffer, runtime: Runtime): SourceFile[] {
  const text = source.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files.filter(
        (f: unknown): f is SourceFile =>
          !!f && typeof (f as SourceFile).path === "string" && typeof (f as SourceFile).content === "string",
      );
    }
  } catch {
    // no era JSON: código pegado / archivo único
  }
  return wrapSingleFile(runtime, text);
}

/** Arquetipo de la partida de humo según el chasis del loadout (ARCHETYPES de E3). */
export function archetypeForChassis(chassis: string): BotSubmission["archetype"] {
  const base = splitVersioned(chassis).base;
  if (base === "chassis.light") return "scout";
  if (base === "chassis.heavy") return "heavy";
  return "gunner";
}

export class E6PipelineBotManager implements BotManagerClient {
  private signer: ServiceKeypair;

  constructor(
    private db: Db,
    opts: { signer?: ServiceKeypair } = {},
  ) {
    this.signer = opts.signer ?? generateServiceKeypair();
  }

  async enqueueBuild(req: BuildRequest): Promise<void> {
    const version = await this.db("bot_versions").where({ bot_id: req.botId, version: req.version }).first();
    const loadout = await this.db("bot_loadouts")
      .where({ bot_id: req.botId, revision: version.loadout_revision })
      .first();

    const submission: BotSubmission = {
      botId: req.botId,
      version: req.version,
      ownerUserId: (await this.db("bots").where({ id: req.botId }).first()).owner_id,
      runtime: req.runtime,
      archetype: archetypeForChassis(loadout.chassis),
      files: decodePackage(version.source, req.runtime),
    };

    const pipeline = new BuildPipeline({
      store: new InMemoryBuildStore(),
      config: withConfig(),
      signer: this.signer,
      // Sin agentResolver: protocol_test/smoke_battle/resource_limits quedan
      // `skipped` (E6/T6.2 exige contenedores; pendiente de reconciliación).
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
      rejectionReason: result.rejectionReason,
    };
    await completeBuild(this.db, req.buildId, mapped);
  }
}
