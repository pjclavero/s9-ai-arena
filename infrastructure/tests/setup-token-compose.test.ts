/**
 * V1 ADM-SETUP (D-OP-44) · El token del asistente de primer arranque es un secreto Docker montado
 * SÓLO en `api`, nunca una variable de entorno con el valor. Se comprueba sobre el YAML parseado
 * (estructura, no texto). Mutante: `M-SETUP-token-en-otro-servicio` (scripts/v1-web-setup-mutants.mjs).
 *
 * Techo declarado: `backup` monta el directorio `./secrets` entero en sólo lectura (copia los
 * secretos de la instalación); eso es previo a este carril y no es un montaje del secreto Docker.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const REPO = resolve(__dirname, "../..");
const compose = parse(readFileSync(join(REPO, "infrastructure/docker-compose.yml"), "utf8")) as {
  services: Record<string, { secrets?: (string | { source: string })[]; environment?: Record<string, unknown> }>;
  secrets: Record<string, { file?: string }>;
};

const mounts = (svc: { secrets?: (string | { source: string })[] }) =>
  (svc.secrets ?? []).map((s) => (typeof s === "string" ? s : s.source));

describe("V1 ADM-SETUP · secreto setup_token en el compose", () => {
  it("[INFRA-setup-token-solo-api] está declarado como fichero y lo monta únicamente `api`", () => {
    expect(compose.secrets.setup_token?.file).toBe("./secrets/setup_token.txt");
    const con = Object.entries(compose.services)
      .filter(([, svc]) => mounts(svc).includes("setup_token"))
      .map(([name]) => name);
    expect(con).toEqual(["api"]);
    expect(compose.services.api.environment?.SETUP_TOKEN_FILE).toBe("/run/secrets/setup_token");
  });

  it("ningún servicio recibe el token por entorno (sólo la RUTA del fichero)", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const [k, v] of Object.entries(svc.environment ?? {})) {
        if (/SETUP_TOKEN/.test(k)) {
          expect(name).toBe("api");
          expect(k).toBe("SETUP_TOKEN_FILE");
          expect(String(v)).toMatch(/^\/run\/secrets\//);
        }
      }
    }
  });
});
