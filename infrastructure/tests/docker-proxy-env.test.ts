// Contrato de red de los runners (bug real de VM108): `ARENA_NETWORK` del proxy DEBE
// ser `arena` — el nombre EXACTO que exige compliance.mjs (fuente de verdad, compartida
// con el escáner del Compose). El Compose declara la red con `name: arena` para que NO
// se prefije con el proyecto (evita `infrastructure_arena`, que el proxy rechazaría).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(here, "..", "systemd", "docker-proxy.env.example");
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

describe("docker-proxy.env.example · ARENA_NETWORK", () => {
  const env = readEnv();
  const compose = parse(readFileSync(COMPOSE_PATH, "utf8"), { merge: true });

  it("el compose define una red `arena`", () => {
    expect(Object.keys(compose.networks ?? {})).toContain("arena");
  });

  it("la red `arena` fija `name: arena` (no se prefija con el proyecto)", () => {
    expect(compose.networks?.arena?.name).toBe("arena");
  });

  it("ARENA_NETWORK es exactamente `arena`", () => {
    expect(env.ARENA_NETWORK).toBe("arena");
  });

  it("NO usa nombres prefijados ni erróneos", () => {
    expect(env.ARENA_NETWORK).not.toBe("infrastructure_arena");
    expect(env.ARENA_NETWORK).not.toBe("s9-ai-arena_arena");
  });
});
