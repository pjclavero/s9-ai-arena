/**
 * R2.5 (ERR-SEC-15) — verificación de firma del artefacto ANTES de cada lanzamiento.
 *
 * DoD T6.1: "La firma del artefacto se verifica antes de cada ejecución en batalla;
 * un artefacto manipulado se rechaza." Este módulo materializa ese candado sobre la
 * BD de la plataforma: dado (botId, version), localiza el artefacto persistido
 * (hash + firma + bytes canónicos, escritos por completeBuild al pasar el pipeline)
 * y lo verifica con la clave PÚBLICA del servicio — la misma que la API publica.
 *
 * Fallar cerrado: sin artefacto, sin firma, sin bytes o con firma inválida, el
 * lanzamiento se RECHAZA con motivo. Nunca se lanza "por si acaso".
 */
import type { Knex } from "knex";
import type { KeyObject } from "node:crypto";
import { verifyArtifact, type VerifyResult } from "./signing.js";

export interface LaunchCheckResult extends VerifyResult {
  botId: string;
  version: number;
}

export interface ArtifactLaunchCheck {
  check(botId: string, version: number): Promise<LaunchCheckResult>;
}

/**
 * A9 · Artefacto DE ESTA versión. Nunca «el último artefacto con ese hash»: eso
 * podía devolver la fila de otro bot u otra versión con el mismo código.
 *  1. Si la versión registra el build que la validó (`validated_build_id`, desde
 *     012_a), el artefacto es el de ese build y su hash debe coincidir.
 *  2. Filas anteriores a 012_a: el artefacto de un build DE ESTA MISMA
 *     (bot_id, version) con ese hash. Nunca uno de otra versión.
 */
export async function findVersionArtifact(
  db: Knex,
  v: { bot_id: string; version: number; artifact_hash: string | null; validated_build_id?: string | null },
): Promise<Record<string, any> | undefined> {
  if (!v.artifact_hash) return undefined;
  if (v.validated_build_id) {
    const art = await db("artifacts").where({ build_id: v.validated_build_id }).first();
    return art && art.hash === v.artifact_hash ? art : undefined;
  }
  return db("artifacts")
    .join("builds", "builds.id", "artifacts.build_id")
    .where({ "builds.bot_id": v.bot_id, "builds.version": v.version, "artifacts.hash": v.artifact_hash })
    .orderBy("artifacts.created_at", "desc")
    .first("artifacts.*");
}

/** Verificador real contra las tablas bot_versions/artifacts de la plataforma. */
export class DbArtifactLaunchGuard implements ArtifactLaunchCheck {
  constructor(
    private db: Knex,
    private publicKey: KeyObject,
  ) {}

  async check(botId: string, version: number): Promise<LaunchCheckResult> {
    const refuse = (reason: string): LaunchCheckResult => ({ ok: false, reason, botId, version });
    const v = await this.db("bot_versions").where({ bot_id: botId, version }).first();
    if (!v) return refuse("versión inexistente");
    if (!v.artifact_hash) return refuse("la versión no tiene artefacto firmado");
    const art = await findVersionArtifact(this.db, v);
    if (!art) return refuse(`artefacto ${v.artifact_hash} no registrado para ${botId} v${version}`);
    if (!art.signature) return refuse("artefacto sin firma registrada");
    if (!art.bytes) return refuse("artefacto sin bytes persistidos: no hay nada que verificar");
    const res = verifyArtifact({
      artifactBytes: Buffer.from(art.bytes),
      signedHash: art.hash,
      signature: art.signature,
      publicKey: this.publicKey,
    });
    return { ...res, botId, version };
  }
}
