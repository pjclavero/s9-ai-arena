// R1.7 (ERR-SEC-02) · Aislamiento del nodo de build/ejecución de bots.
//
// El bot-manager procesa código de usuario: si se ve comprometido, NO debe
// tener ruta a PostgreSQL, al backup, a los secretos ni al socket de Docker.
// Se verifica sobre el YAML REAL del stack (parseado con anclas resueltas) y,
// si el CLI de docker compose está disponible (funciona sin daemon), también
// sobre la configuración canónica que emite `docker compose config`.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(here, "..", "docker-compose.yml");
const doc = parse(readFileSync(COMPOSE, "utf8"), { merge: true });
const services = doc.services as Record<string, any>;
const bm = services["bot-manager"];

const vols = (def: any): string[] =>
  (Array.isArray(def?.volumes) ? def.volumes : []).map((v: any) =>
    typeof v === "string" ? v : `${v?.source ?? ""}:${v?.target ?? ""}`,
  );

describe("R1.7 · aislamiento del bot-manager en el Compose", () => {
  it("no monta docker.sock ni ningún bind del host (solo volúmenes con nombre)", () => {
    for (const v of vols(bm)) {
      expect(v).not.toMatch(/docker\.sock/);
      // bind mounts empiezan por / o ./ ; los volúmenes con nombre, no.
      expect(v).not.toMatch(/^\.?\//);
    }
  });

  it("no tiene secretos montados (secrets:) ni variables de BD", () => {
    expect(bm.secrets).toBeUndefined();
    const env = bm.environment ?? {};
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(PGPASSWORD|DATABASE_URL|JWT|RESTIC)/);
    }
  });

  it("no está en la red data (sin ruta a PostgreSQL) ni en public", () => {
    expect(bm.networks).not.toContain("data");
    expect(bm.networks).not.toContain("public");
  });

  it("no comparte ninguna red con postgres ni con backup", () => {
    // Nota: postgres-exporter (solo métricas) sí convive en platform; la BD y
    // el backup — los que custodian datos y credenciales restic — no.
    const bmNets = new Set<string>(bm.networks ?? []);
    for (const svc of ["postgres", "backup"]) {
      const nets: string[] = services[svc]?.networks ?? [];
      for (const n of nets) expect(bmNets.has(n)).toBe(false);
    }
  });

  it("postgres vive SOLO en la red interna data", () => {
    expect(services.postgres.networks).toEqual(["data"]);
    expect(doc.networks.data.internal).toBe(true);
  });

  it("no publica puertos y sus redes son internas (sin Internet)", () => {
    expect(bm.ports).toBeUndefined();
    for (const n of bm.networks) expect(doc.networks[n].internal).toBe(true);
  });

  it("NINGÚN servicio del stack monta docker.sock (sin excepciones)", () => {
    for (const [name, def] of Object.entries(services)) {
      for (const v of vols(def)) {
        expect(v, `servicio ${name}`).not.toMatch(/docker\.sock/);
      }
    }
  });

  // `docker compose config` valida y canoniza el YAML SIN daemon. Si el CLI no
  // está en la máquina, el test se marca omitido (regla de oro: nunca "pasado").
  const composeCli = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!composeCli)("docker compose config (sin daemon) confirma la misma topología", () => {
    const out = execFileSync(
      "docker",
      ["compose", "-f", COMPOSE, "--profile", "production", "config", "--no-interpolate", "--no-path-resolution"],
      { cwd: join(here, ".."), encoding: "utf8", env: { ...process.env } },
    );
    const canon = parse(out, { merge: true });
    const cbm = canon.services["bot-manager"];
    const cVols = (cbm.volumes ?? []).map((v: any) => (typeof v === "string" ? v : String(v.source)));
    expect(cVols.join("\n")).not.toMatch(/docker\.sock/);
    expect(Object.keys(cbm.networks ?? {})).not.toContain("data");
    expect(cbm.secrets).toBeUndefined();
  });
});
