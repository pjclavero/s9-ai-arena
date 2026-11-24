// V1 · BLOCK-RUN · el servicio `api` NO recibe el secreto interno de arena-engine.
//
// `POST /run` de arena-engine (vía legada, apagada por defecto) se autentica con
// `arena_engine_internal_secret`. La API ya no usa ese camino (server.ts no
// importa el lanzador HTTP): si además no monta el secreto, una API comprometida
// no puede llamar a `/run` aunque alguien encendiera el interruptor del motor.
// Estático: sólo parsea el compose, no necesita Docker.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const doc = parse(readFileSync(join(here, "..", "docker-compose.yml"), "utf8"), { merge: true });
const services: Record<string, any> = doc.services;
const SECRET = "arena_engine_internal_secret";

function secretNames(svc: any): string[] {
  return (svc.secrets ?? []).map((s: any) => (typeof s === "string" ? s : s.source));
}

describe("V1 · secreto interno de arena-engine fuera de la API", () => {
  it("V1-API-SIN-SECRETO-ENGINE: el servicio api no monta arena_engine_internal_secret", () => {
    expect(secretNames(services.api)).not.toContain(SECRET);
  });

  it("V1-SECRETO-SOLO-ENGINE: el único servicio que lo monta es arena-engine", () => {
    const holders = Object.entries(services)
      .filter(([, svc]) => secretNames(svc).includes(SECRET))
      .map(([name]) => name);
    expect(holders).toEqual(["arena-engine"]);
  });

  it("V1-ENGINE-RUN-APAGADO-EN-COMPOSE: ningún servicio enciende ARENA_ENGINE_RUN_ENABLED", () => {
    for (const [name, svc] of Object.entries(services)) {
      const env = svc.environment ?? {};
      const v = Array.isArray(env)
        ? env.find((e: string) => e.startsWith("ARENA_ENGINE_RUN_ENABLED="))?.split("=")[1]
        : env.ARENA_ENGINE_RUN_ENABLED;
      expect(v === undefined || v === "" || v === "0" || v === "false", `${name}: ${String(v)}`).toBe(true);
    }
  });
});
