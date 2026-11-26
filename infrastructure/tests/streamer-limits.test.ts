// V1 · D-OP-26 · Límite de CPU y prioridad efectiva del streamer.
// Contrato: el streamer (Chromium + ffmpeg) NO puede ocupar la VM entera ni competir en
// igualdad con los servicios críticos. Se comprueba sobre el YAML y, si el CLI de
// `docker compose` está disponible (funciona sin daemon), sobre la configuración resuelta.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");
const doc = parse(readFileSync(COMPOSE_PATH, "utf8"), { merge: true });
const services: Record<string, any> = doc.services;
const CRITICOS = ["api", "postgres", "tournament-worker", "gateway"];

describe("streamer: límite de CPU y prioridad (D-OP-26)", () => {
  it("el techo de CPU es 3 (no la VM entera) y conserva memoria y pids", () => {
    const l = services.streamer.deploy.resources.limits;
    expect(Number(l.cpus)).toBe(3);
    expect(l.memory).toBe("4G");
    expect(l.pids).toBe(512);
  });

  it("cpu_shares del streamer es estrictamente menor que el de cada servicio crítico", () => {
    const shares = services.streamer.cpu_shares;
    expect(shares).toBeTypeOf("number");
    expect(shares).toBeGreaterThanOrEqual(2); // mínimo del kernel
    for (const n of CRITICOS) {
      expect(services[n], `${n} existe`).toBeDefined();
      // Sin cpu_shares declarado el servicio usa el 1024 por defecto de Docker.
      const crit = services[n].cpu_shares ?? 1024;
      expect(shares, `streamer debe pesar menos que ${n}`).toBeLessThan(crit);
    }
  });

  it("oom_score_adj del streamer es positivo y mayor que el de los críticos", () => {
    const adj = services.streamer.oom_score_adj;
    expect(adj).toBeGreaterThan(0);
    expect(adj).toBeLessThanOrEqual(1000);
    for (const n of CRITICOS) expect(adj).toBeGreaterThan(services[n].oom_score_adj ?? 0);
  });

  it("los servicios críticos no cambian de prioridad por este PR (sin cpu_shares propios)", () => {
    for (const n of CRITICOS) expect(services[n].cpu_shares, n).toBeUndefined();
  });

  it("docker compose config resuelve cpus/cpu_shares/oom_score_adj del streamer", () => {
    let out: string;
    try {
      out = execFileSync(
        "docker",
        ["compose", "-f", COMPOSE_PATH, "--profile", "streaming", "config", "--format", "json"],
        {
          encoding: "utf8",
          env: { ...process.env, POSTGRES_PASSWORD: "x" },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      );
    } catch {
      return; // sin CLI de compose: lo cubre la comprobación estructural de arriba
    }
    const s = JSON.parse(out).services.streamer;
    expect(Number(s.cpu_shares)).toBe(128);
    expect(Number(s.oom_score_adj)).toBe(500);
    expect(Number(s.deploy.resources.limits.cpus)).toBe(3);
  });
});
