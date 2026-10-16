/**
 * DEV-B · Proveedor de lanzamiento de PRODUCCIÓN: adaptador al contrato de DEV-A.
 *
 * DEV-A (bots/sandbox) publica en apps/bot-manager/src/bot-launch.ts la forma de
 * arrancar el código de una versión publicada: `resolveBotLaunch` (verifica estado,
 * firma ed25519 y sha256 del artefacto, falla cerrado) + `SandboxHost` (sirve el
 * artefacto al bootstrap del runtime fijado). Ver COORD.md.
 *
 * Contrato que este worker consume (B ↔ A):
 *
 *   export function createBattleLaunchHost(
 *     db: Knex, opts: { engineHost: string; battleId: string },
 *   ): Promise<BattleLaunchHost>      // interfaz de container-agents.ts
 *
 * Mientras ese módulo no esté integrado en la rama, la importación falla y el
 * worker NO ejecuta batallas (no reclama `run_battle`): nunca cae a un stub.
 * La importación es dinámica a propósito: el fichero vive en la rama de DEV-A.
 */
import type { Knex } from "knex";
import type { BattleLaunchHost, BotLaunchProvider } from "./container-agents.js";

const BOT_LAUNCH_MODULE = "../../bot-manager/src/bot-launch.js";

export async function loadArtifactLaunchProvider(
  db: Knex,
  engineHost: string,
  modulePath: string = BOT_LAUNCH_MODULE,
): Promise<BotLaunchProvider> {
  const mod = (await import(new URL(modulePath, import.meta.url).href)) as {
    createBattleLaunchHost?: (db: Knex, o: { engineHost: string; battleId: string }) => Promise<BattleLaunchHost>;
  };
  if (typeof mod.createBattleLaunchHost !== "function") {
    throw new Error(`${modulePath} no exporta createBattleLaunchHost (contrato B↔A, COORD.md)`);
  }
  const create = mod.createBattleLaunchHost;
  return { openBattle: (battleId) => create(db, { engineHost, battleId }) };
}
