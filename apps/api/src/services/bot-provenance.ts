/**
 * DEV-A · A9.15 — «¿qué código ejecutó este bot en esta batalla?».
 *
 * La respuesta sale de la versión EXACTA guardada en `participants.version`
 * (FK a bot_versions), nunca de la última versión ni del último artefacto. Como
 * desde 012_a la fila de una versión no-draft es inmutable en BD, su source,
 * su build validador y su artefacto son los mismos que había al jugar.
 */
import type { Db } from "../db/connection.js";
import { findVersionArtifact } from "../../../bot-manager/src/launch-verify.js";

export interface ParticipantCodeProvenance {
  botId: string;
  version: number;
  botVersionId: string;
  runtime: string;
  sourceSha256: string | null;
  artifactHash: string | null;
  buildId: string | null;
  team: string;
}

export async function battleCodeProvenance(db: Db, battleId: string): Promise<ParticipantCodeProvenance[]> {
  const rows = await db("participants")
    .join("bot_versions", function () {
      this.on("bot_versions.bot_id", "participants.bot_id").andOn("bot_versions.version", "participants.version");
    })
    .where("participants.battle_id", battleId)
    .orderBy("participants.team")
    .select("participants.team", "bot_versions.*");
  const out: ParticipantCodeProvenance[] = [];
  for (const v of rows) {
    const art = await findVersionArtifact(db, v);
    out.push({
      botId: v.bot_id,
      version: v.version,
      botVersionId: v.id,
      runtime: v.runtime,
      sourceSha256: v.source_sha256 ?? null,
      artifactHash: art?.hash ?? null,
      buildId: art?.build_id ?? null,
      team: v.team,
    });
  }
  return out;
}
