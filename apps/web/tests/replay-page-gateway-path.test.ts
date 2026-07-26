/**
 * B6 (hallazgo del supervisor, demostrado en vivo) · `ReplayPage.tsx` pedía
 * `/replay-service/replays/:id/index`, pero el gateway (`infrastructure/gateway/
 * nginx.conf` y `nginx-behind-proxy.conf`) SOLO define `location /replays/` →
 * proxy directo a `replay-service:8083`. `/replay-service/` nunca existió en
 * ningún sitio del gateway: esa petición caía en el `location /` genérico y
 * volvía el SPA, nunca el replay-service — el visor no podía leer un replay
 * ingerido por muy bien ingerido que estuviera.
 *
 * Este test no monta el componente (arrastra Phaser/canvas, pesado en jsdom):
 * fija por contrato la constante que usa `httpReplaySource`, y la contrasta
 * contra los ficheros de configuración REALES del gateway (no una copia): si
 * algún día el gateway deja de tener `location /replays/`, o alguien vuelve a
 * escribir `/replay-service` a mano, este test lo detecta sin necesitar Docker.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REPLAY_SERVICE_GATEWAY_BASE } from "../src/pages/ReplayPage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

describe("B6 · REPLAY_SERVICE_GATEWAY_BASE coincide con la ruta REAL del gateway", () => {
  it('es "/replays" (NO "/replay-service", que nunca existió en el gateway)', () => {
    expect(REPLAY_SERVICE_GATEWAY_BASE).toBe("/replays");
  });

  it("el gateway (nginx.conf de producción) define location /replays/ hacia replay-service", () => {
    const conf = readFileSync(join(REPO, "infrastructure/gateway/nginx.conf"), "utf8");
    expect(conf).toContain("location /replays/");
    expect(conf).toContain("replay-service:8083");
    // La ruta que YA NO se usa no debe reaparecer sin que este test se entere.
    expect(conf).not.toContain("/replay-service/");
  });

  it("el gateway detrás de proxy externo (nginx-behind-proxy.conf) también define /replays/", () => {
    const conf = readFileSync(join(REPO, "infrastructure/gateway/nginx-behind-proxy.conf"), "utf8");
    expect(conf).toContain("location /replays/");
    expect(conf).toContain("replay-service:8083");
    expect(conf).not.toContain("/replay-service/");
  });
});
