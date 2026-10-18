/**
 * DEV-B · Proveedor de lanzamiento de PRODUCCIÓN: adaptador al contrato de DEV-A.
 *
 * REVIEW (cierre funcional, R4.1): integrado con `createBattleLaunchHost` de
 * apps/bot-manager/src/bot-launch.ts. Cada participante arranca el ARTEFACTO
 * FIRMADO de su versión exacta (bot_id, version): `resolveBotLaunch` verifica
 * estado published|frozen, artefacto de su build, sha256 y firma ed25519 (falla
 * cerrado) y el bootstrap del runtime fijado por digest lo descarga del host de
 * la batalla y vuelve a comprobar el sha256 antes de ejecutarlo.
 *
 * La importación es ESTÁTICA (antes era dinámica porque el módulo vivía en la
 * rama de DEV-A): un contrato roto es ahora un error de compilación, no un
 * worker que arranca sin ejecutar batallas.
 *
 * La clave de verificación y los digests de runtime se cargan AL CREAR el
 * proveedor (arranque del worker): si faltan, `buildExecutor` de main.ts lo
 * anuncia y el worker no reclama `run_battle`; nunca cae a un stub.
 */
import type { Knex } from "knex";
import type { KeyObject } from "node:crypto";
import {
  createBattleLaunchHost,
  loadArtifactVerifyKey,
  loadRuntimeImages,
  type RuntimeImages,
} from "../../bot-manager/src/bot-launch.js";
import type { BotLaunchProvider } from "./container-agents.js";

export interface ArtifactLaunchProviderOptions {
  publicKey?: KeyObject;
  runtimeImages?: RuntimeImages;
  env?: NodeJS.ProcessEnv;
  bindHost?: string;
}

export function artifactLaunchProvider(
  db: Knex,
  engineHost: string,
  opts: ArtifactLaunchProviderOptions = {},
): BotLaunchProvider {
  const env = opts.env ?? process.env;
  const publicKey = opts.publicKey ?? loadArtifactVerifyKey(env);
  const runtimeImages = opts.runtimeImages ?? loadRuntimeImages(env);
  return {
    openBattle: (battleId) =>
      createBattleLaunchHost(db, { engineHost, battleId, publicKey, runtimeImages, env, bindHost: opts.bindHost }),
  };
}

/** Compatibilidad con el nombre que usaba main.ts (antes asíncrono por la importación dinámica). */
export async function loadArtifactLaunchProvider(db: Knex, engineHost: string): Promise<BotLaunchProvider> {
  return artifactLaunchProvider(db, engineHost);
}
