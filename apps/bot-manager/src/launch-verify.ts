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
    const art = await this.db("artifacts").where({ hash: v.artifact_hash }).orderBy("created_at", "desc").first();
    if (!art) return refuse(`artefacto ${v.artifact_hash} no registrado`);
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
