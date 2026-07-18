// Verificación estructural del stack Compose único (DoD T10.2/T10.3, dosier cap. 6).
// Sin daemon de Docker no se puede levantar el stack; lo que SÍ se verifica aquí
// con ejecuciones reales: parseo, servicios de la tabla 6.2, perfiles del 6.1,
// las 5 redes del 6.4 con sus reglas, los 6 volúmenes del 6.3, healthchecks y
// depends_on condicionado, límites de recursos, secretos por archivo y la
// desactivación de postgres con DATABASE_URL externo (perfil external-db).
// Si el CLI de docker compose está disponible (funciona sin daemon), también se
// valida la resolución completa de la configuración por perfil.
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

const CORE = [
  "gateway",
  "web",
  "api",
  "arena-engine",
  "tournament-worker",
  "bot-manager",
  "map-service",
  "replay-service",
  "queue",
];
const TABLE_6_2 = [...CORE, "postgres", "streamer", "bot-runtime-template"];
// Operación (T10.4): cron de backup dentro del stack.
// R-DEPLOY · R2: bot-build-worker (ejecuta el pipeline de builds, separado del
// bot-manager API/control). No es de la tabla 6.2 original: se lista aparte.
const OPERATION = ["backup", "bot-build-worker"];
const OBSERVABILITY = [
  "prometheus",
  "alertmanager",
  "grafana",
  "loki",
  "promtail",
  "cadvisor",
  "node-exporter",
  "postgres-exporter",
];

function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function configServices(profiles: string[]): string[] {
  const args = ["compose", "-f", COMPOSE_PATH];
  for (const p of profiles) args.push("--profile", p);
  args.push("config", "--services");
  return execFileSync("docker", args, { encoding: "utf8" }).trim().split("\n");
}

describe("tabla 6.2 · los doce servicios", () => {
  it("existen los doce servicios del dosier (más el perfil observability)", () => {
    for (const s of TABLE_6_2) expect(services, `falta ${s}`).toHaveProperty(s);
    expect(Object.keys(services).sort()).toEqual([...TABLE_6_2, ...OPERATION, ...OBSERVABILITY].sort());
  });

  it("todo lo que no está en la tabla 6.2 es del perfil opcional observability", () => {
    for (const s of OBSERVABILITY) {
      expect(services[s].profiles, `${s}`).toEqual(["observability"]);
    }
  });

  it("solo el gateway publica puertos al exterior", () => {
    for (const [name, def] of Object.entries(services)) {
      if (name === "gateway") expect(def.ports?.length).toBeGreaterThan(0);
      else expect(def.ports, `${name} no debe publicar puertos`).toBeUndefined();
    }
  });
});

describe("6.1 · perfiles", () => {
  it("todos los servicios declaran perfiles y cubren development/production/bots/streaming", () => {
    const all = new Set<string>();
    for (const def of Object.values(services)) {
      expect(def.profiles?.length).toBeGreaterThan(0);
      for (const p of def.profiles) all.add(p);
    }
    for (const p of ["development", "production", "bots", "streaming", "external-db"]) {
      expect(all, `perfil ${p}`).toContain(p);
    }
  });

  it("streamer solo en streaming; bot-runtime-template solo en bots", () => {
    expect(services.streamer.profiles).toEqual(["streaming"]);
    expect(services["bot-runtime-template"].profiles).toEqual(["bots"]);
  });

  it("postgres NO pertenece al perfil external-db (DATABASE_URL externo, nota del 6.2)", () => {
    expect(services.postgres.profiles).not.toContain("external-db");
    // Todos los servicios core sí funcionan con BD externa.
    for (const name of CORE) {
      expect(services[name].profiles, `${name} debe estar en external-db`).toContain("external-db");
    }
  });
});

describe("6.4 · las cinco redes y sus reglas", () => {
  it("existen public, platform, arena, build y data; solo public tiene salida", () => {
    expect(Object.keys(doc.networks).sort()).toEqual(["arena", "build", "data", "platform", "public"]);
    expect(doc.networks.public.internal).toBeUndefined();
    for (const n of ["platform", "arena", "build", "data"]) {
      expect(doc.networks[n].internal, `${n} debe ser internal`).toBe(true);
    }
  });

  it("en public solo gateway (puertos) y las salidas documentadas sin puertos (streamer RTMPS, alertmanager webhook)", () => {
    for (const [name, def] of Object.entries(services)) {
      if (def.networks?.includes("public")) {
        expect(["gateway", "streamer", "alertmanager", "backup"], `${name} no pinta nada en public`).toContain(name);
      }
    }
    expect(services.streamer.ports).toBeUndefined();
    expect(services.alertmanager.ports).toBeUndefined();
    expect(services.backup.ports).toBeUndefined();
  });

  it("los bots solo están en arena: sin ruta a postgres, redis ni api", () => {
    expect(services["bot-runtime-template"].networks).toEqual(["arena"]);
    // Nadie más que el motor comparte la red arena con los bots.
    for (const [name, def] of Object.entries(services)) {
      if (def.networks?.includes("arena")) {
        expect(["arena-engine", "bot-runtime-template"]).toContain(name);
      }
    }
  });

  it("builders sin acceso a datos: bot-manager no está en la red data", () => {
    expect(services["bot-manager"].networks).not.toContain("data");
    expect(services["bot-manager"].networks).toContain("build");
  });

  it("postgres solo en la red data", () => {
    expect(services.postgres.networks).toEqual(["data"]);
  });
});

describe("6.3 · volúmenes persistentes", () => {
  it("existen los seis volúmenes del dosier", () => {
    for (const v of [
      "arena_maps",
      "arena_replays",
      "arena_bot_sources",
      "arena_build_cache",
      "arena_assets",
      "arena_logs",
    ]) {
      expect(doc.volumes, `falta el volumen ${v}`).toHaveProperty(v);
    }
  });
});

describe("healthchecks, arranque ordenado y límites (E10.M)", () => {
  it("todos los servicios tienen healthcheck", () => {
    for (const [name, def] of Object.entries(services)) {
      expect(def.healthcheck?.test, `${name} sin healthcheck`).toBeDefined();
    }
  });

  it("todo depends_on está condicionado (service_healthy)", () => {
    for (const [name, def] of Object.entries(services)) {
      if (!def.depends_on) continue;
      expect(Array.isArray(def.depends_on), `${name}: depends_on debe ser el formato largo`).toBe(false);
      for (const [dep, cond] of Object.entries<any>(def.depends_on)) {
        expect(cond.condition, `${name} → ${dep}`).toBe("service_healthy");
      }
    }
  });

  it("las dependencias de postgres son required:false (para el perfil external-db)", () => {
    for (const [name, def] of Object.entries(services)) {
      const dep = def.depends_on?.postgres;
      if (dep) expect(dep.required, `${name} → postgres debe ser required:false`).toBe(false);
    }
  });

  it("todos los servicios tienen límites de CPU y memoria", () => {
    for (const [name, def] of Object.entries(services)) {
      const limits = def.deploy?.resources?.limits;
      expect(limits?.cpus, `${name} sin límite de CPU`).toBeDefined();
      expect(limits?.memory, `${name} sin límite de memoria`).toBeDefined();
    }
  });

  it("ningún servicio corre sin no-new-privileges", () => {
    for (const [name, def] of Object.entries(services)) {
      expect(def.security_opt, `${name}`).toContain("no-new-privileges:true");
    }
  });
});

describe("secretos por archivo (nunca en claro)", () => {
  it("los secretos top-level son de tipo file y viven en infrastructure/secrets/", () => {
    for (const [name, def] of Object.entries<any>(doc.secrets)) {
      expect(def.file, `secreto ${name}`).toMatch(/^\.\/secrets\//);
    }
  });

  it("ninguna variable de entorno lleva una clave en claro (las sensibles acaban en _FILE)", () => {
    for (const [name, def] of Object.entries(services)) {
      for (const [key, value] of Object.entries<any>(def.environment ?? {})) {
        if (/PASSWORD|SECRET|TOKEN|KEY$/i.test(key) && !/_FILE$/.test(key)) {
          throw new Error(`${name}.${key} parece un secreto en claro: usar secrets + ${key}_FILE`);
        }
        if (/_FILE$/.test(key)) {
          expect(String(value), `${name}.${key}`).toMatch(/^\/run\/secrets\//);
        }
      }
    }
  });
});

describe("resolución completa con docker compose config (si hay CLI; no requiere daemon)", () => {
  it.skipIf(!hasCompose())("production incluye postgres y los nueve core", () => {
    const list = configServices(["production"]);
    for (const s of [...CORE, "postgres"]) expect(list).toContain(s);
    expect(list).not.toContain("streamer");
    expect(list).not.toContain("bot-runtime-template");
  });

  it.skipIf(!hasCompose())(
    "external-db NO incluye postgres (DoD: con DATABASE_URL externo, postgres no arranca)",
    () => {
      const list = configServices(["external-db"]);
      expect(list).not.toContain("postgres");
      for (const s of CORE) expect(list).toContain(s);
    },
  );

  it.skipIf(!hasCompose())("development+bots+streaming resuelve la tabla 6.2 más el bot-build-worker (R2)", () => {
    const list = configServices(["development", "bots", "streaming"]);
    expect(list.sort()).toEqual([...TABLE_6_2, "bot-build-worker"].sort());
  });

  it.skipIf(!hasCompose())(
    "el perfil observability es opcional: production no lo incluye y production+observability sí (DoD T10.3)",
    () => {
      const prod = configServices(["production"]);
      for (const s of OBSERVABILITY) expect(prod).not.toContain(s);
      const both = configServices(["production", "observability"]);
      for (const s of OBSERVABILITY) expect(both).toContain(s);
    },
  );
});
