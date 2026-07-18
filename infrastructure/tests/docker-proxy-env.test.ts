// Evita una regresión real (R6.2/VM108): `ARENA_NETWORK` del proxy DEBE coincidir con
// la red `arena` del stack tal como Compose la nombra. El despliegue de VM108 usa el
// proyecto `infrastructure`, así que la red real es `infrastructure_arena`. Un valor
// erróneo (`s9-ai-arena_arena`) hace que el docker-proxy rechace/aísle mal los bots.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(here, "..", "systemd", "docker-proxy.env.example");
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");

/** Proyecto Compose del despliegue de VM108 = nombre del directorio del compose. */
const COMPOSE_PROJECT = "infrastructure";

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

  it("ARENA_NETWORK está definido", () => {
    expect(env.ARENA_NETWORK).toBeTruthy();
  });

  it("NO usa el nombre erróneo s9-ai-arena_arena", () => {
    expect(env.ARENA_NETWORK).not.toBe("s9-ai-arena_arena");
  });

  it("coincide con <proyecto>_arena del despliegue (infrastructure_arena)", () => {
    // La red `arena` no fija `name:` en el compose, así que Compose la prefija con el
    // nombre del proyecto. Si algún día se fija un `name:` externo, actualizar aquí.
    const arenaNet = compose.networks?.arena ?? {};
    expect(arenaNet.name).toBeUndefined();
    expect(env.ARENA_NETWORK).toBe(`${COMPOSE_PROJECT}_arena`);
  });
});
