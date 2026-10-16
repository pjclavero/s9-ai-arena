/**
 * TESTS E2E · Proveedor de lanzamiento por IMAGEN POR VERSIÓN.
 *
 * Cada (bot, versión) se ha construido como imagen `FROM <runtime fijado en
 * runtimes/DIGESTS.lock>` + el código del bot, publicada en un registry local y
 * referenciada por su REPO DIGEST (el docker-proxy sólo admite `@sha256:`). Es el
 * camino que usa el E2E de DEV-B mientras el proveedor de producción de DEV-A
 * (artefacto firmado servido al runtime, bot-launch.ts) no está integrado: el
 * código que se ejecuta es el del usuario, en el runtime real; nunca un stub.
 */
import type { BattleLaunchHost, BotLaunchProvider } from "../container-agents.js";

export function registryImageProvider(images: Map<string, string>): BotLaunchProvider {
  return {
    async openBattle(): Promise<BattleLaunchHost> {
      return {
        async plan({ botId, version }) {
          const imageDigest = images.get(`${botId}@${version}`);
          if (!imageDigest) throw new Error(`sin imagen para ${botId} v${version}`);
          return { imageDigest };
        },
        close() {},
      };
    },
  };
}
