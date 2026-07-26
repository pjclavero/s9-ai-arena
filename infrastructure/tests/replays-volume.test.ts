/**
 * B7 · El volumen `arena_replays`: quién lo monta, con qué permiso, y quién
 * garantiza su propiedad.
 *
 * Dos defectos REALES de producción (VM108, verificados el 2026-07-27):
 *
 *  1. El volumen se creaba `root:root` y el replay-service corre como `node`
 *     (uid 1000): toda ingesta moría con EACCES. El directorio llevaba diez
 *     días vacío — el servicio NUNCA guardó un replay — y nadie se enteró
 *     porque /healthz no toca el disco. Se desbloqueó a mano con un `chown`,
 *     un parche que se pierde al recrear el volumen.
 *
 *  2. `arena_replays` NO estaba montado ni en `api` ni en `tournament-worker`,
 *     que son justamente el CONSUMIDOR y el PRODUCTOR de los replays de torneo
 *     (evidencia en el código: battle-runner.ts llama a `ingestReplay` y deja
 *     la ruta en battles.replay_ref; routes/battles.ts hace
 *     `readFile(battle.replay_ref)`). La ruta de replays de torneo no podía
 *     funcionar.
 *
 * Aquí se prueban (a) el invariante de cableado productor/consumidor sobre el
 * Compose real —resuelto por el propio `docker compose config` cuando el CLI
 * está disponible— y (b) el COMPORTAMIENTO REAL del entrypoint que ajusta la
 * propiedad: se ejecuta el script de verdad con `sh`, con dobles para las
 * llamadas privilegiadas (`id`, `mkdir`, `chown`, `su-exec`), y se comprueba
 * qué hace y qué NO hace.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");
const ENTRYPOINT = join(here, "..", "docker", "node-service", "entrypoint.sh");
const NODE_SERVICE_DOCKERFILE = "infrastructure/docker/node-service/Dockerfile";
const MOUNT = "/data/replays";

type Svc = Record<string, any>;
const doc = parse(readFileSync(COMPOSE_PATH, "utf8"), { merge: true });
const services: Record<string, Svc> = doc.services;

interface Montaje {
  source: string;
  target: string;
  readOnly: boolean;
}

function montajes(def: Svc): Montaje[] {
  const out: Montaje[] = [];
  for (const v of def.volumes ?? []) {
    if (typeof v === "string") {
      const [source, target, ...flags] = v.split(":");
      out.push({ source, target, readOnly: flags.includes("ro") });
    } else if (v && typeof v === "object") {
      out.push({ source: String(v.source ?? ""), target: String(v.target ?? ""), readOnly: v.read_only === true });
    }
  }
  return out;
}

function replaysMount(def: Svc): Montaje | undefined {
  return montajes(def).find((m) => m.source === "arena_replays");
}

// ─────────────────────────── cableado del volumen ───────────────────────────

describe("B7 · productor y consumidor de replays comparten el volumen", () => {
  it("tournament-worker (PRODUCTOR: ingestReplay) monta arena_replays en escritura", () => {
    const m = replaysMount(services["tournament-worker"]);
    expect(m, "tournament-worker escribe replays con ingestReplay y DEBE montar arena_replays").toBeDefined();
    expect(m!.target).toBe(MOUNT);
    expect(m!.readOnly, "el worker escribe: no puede ser :ro").toBe(false);
  });

  it("api (CONSUMIDOR: readFile(replay_ref)) monta arena_replays en SOLO lectura", () => {
    const m = replaysMount(services.api);
    expect(m, "getReplay/verifyReplay leen el archivo por replay_ref y DEBEN montar arena_replays").toBeDefined();
    expect(m!.target).toBe(MOUNT);
    expect(m!.readOnly, "la API solo lee replays (la ingesta va por HTTP al replay-service)").toBe(true);
  });

  it("replay-service, api y tournament-worker montan el volumen en EL MISMO punto", () => {
    // battles.replay_ref guarda una ruta ABSOLUTA generada por el productor. Si
    // el consumidor montara el volumen en otra ruta, esa referencia no
    // resolvería aunque el volumen fuese el mismo.
    const puntos = ["replay-service", "tournament-worker", "api"].map((s) => replaysMount(services[s])?.target);
    expect(puntos).toEqual([MOUNT, MOUNT, MOUNT]);
  });

  it("la ruta que el código escribe (REPLAYS_DIR) es exactamente la ruta montada", () => {
    for (const [name, def] of Object.entries(services)) {
      const dir = def.environment?.REPLAYS_DIR;
      if (dir === undefined) continue;
      const m = replaysMount(def);
      expect(m, `${name} declara REPLAYS_DIR=${dir} pero no monta arena_replays`).toBeDefined();
      expect(m!.target, `${name}: REPLAYS_DIR y el punto de montaje divergen`).toBe(dir);
    }
    // Y el servicio que escribe declara REPLAYS_DIR de verdad (no depende del
    // valor por defecto del código, que podría cambiar sin tocar el Compose).
    expect(services["tournament-worker"].environment.REPLAYS_DIR).toBe(MOUNT);
    expect(services["replay-service"].environment.REPLAYS_DIR).toBe(MOUNT);
  });
});

describe("B7 · la propiedad del volumen está garantizada sin manos", () => {
  it("todo servicio que monta arena_replays en ESCRITURA con la imagen genérica declara ARENA_DATA_DIRS", () => {
    for (const [name, def] of Object.entries(services)) {
      const m = replaysMount(def);
      if (!m || m.readOnly) continue;
      if (def.build?.dockerfile !== NODE_SERVICE_DOCKERFILE) continue;
      const dirs = String(def.environment?.ARENA_DATA_DIRS ?? "")
        .split(/\s+/)
        .filter(Boolean);
      expect(dirs, `${name} escribe en ${m.target} pero no declara ARENA_DATA_DIRS`).toContain(m.target);
    }
  });

  it("ARENA_DATA_DIRS nunca apunta fuera de /data (el entrypoint lo rechazaría al arrancar)", () => {
    for (const [name, def] of Object.entries(services)) {
      for (const d of String(def.environment?.ARENA_DATA_DIRS ?? "")
        .split(/\s+/)
        .filter(Boolean)) {
        expect(d.startsWith("/data/"), `${name}: ARENA_DATA_DIRS=${d}`).toBe(true);
        expect(d).not.toContain("..");
      }
    }
  });

  it("ningún servicio se salta el mecanismo con privilegios (ni privileged, ni user root, ni docker.sock)", () => {
    for (const [name, def] of Object.entries(services)) {
      expect(def.privileged, name).not.toBe(true);
      expect(String(def.user ?? ""), `${name} no debe forzar un usuario en el Compose`).not.toMatch(/^(0|root)\b/);
      expect(def.network_mode, name).not.toBe("host");
      for (const m of montajes(def)) expect(m.source, name).not.toContain("docker.sock");
    }
  });

  it("ningún servicio de la imagen genérica pisa el entrypoint (lo dejaría corriendo como root)", () => {
    // El drop a `node` ya no vive en una instrucción USER del Dockerfile sino
    // en el entrypoint: sobrescribirlo desde el Compose dejaría el proceso del
    // servicio con uid 0. `command:` sí puede sobrescribirse (llega como
    // argumentos al entrypoint); `entrypoint:` no.
    for (const [name, def] of Object.entries(services)) {
      if (def.build?.dockerfile !== NODE_SERVICE_DOCKERFILE) continue;
      expect(def.entrypoint, `${name} sobrescribe el entrypoint de la imagen genérica`).toBeUndefined();
    }
  });

  it("la imagen genérica siembra /data/replays con la propiedad correcta y se lo prueba a sí misma", () => {
    // Lección del proyecto: lo que importa es la IMAGEN, no el monorepo. Esta
    // comprobación es estructural (aquí no hay demonio de Docker), pero el
    // Dockerfile lleva un RUN que EJECUTA el entrypoint dentro de la imagen y
    // falla el build si el drop a `node` o el chown no funcionan: la
    // verificación viva la hace la etapa 5 de la CI en cada build.
    const df = readFileSync(join(here, "..", "docker", "node-service", "Dockerfile"), "utf8");
    expect(df).toMatch(/mkdir -p \/data\/replays && chown node:node/);
    expect(df).toMatch(/ENTRYPOINT \["\/entrypoint\.sh"\]/);
    expect(df, "el build debe probar el drop a node DENTRO de la imagen").toMatch(
      /ARENA_DATA_DIRS=\/data\/replays \/entrypoint\.sh/,
    );
  });
});

// ─────────────────── comportamiento REAL del entrypoint ─────────────────────

interface Ejecucion {
  status: number;
  llamadas: string[];
  ejecutado: boolean;
  stderr: string;
}

/**
 * Ejecuta el entrypoint REAL con dobles para las cuatro llamadas privilegiadas
 * (`id`, `mkdir`, `chown`, `su-exec`), que registran sus argumentos. Todo lo
 * demás del script —el bucle, los `case` de validación, los `exec`— es el
 * código de producción tal cual.
 */
function correrEntrypoint(env: Record<string, string>, uid = "0"): Ejecucion {
  const bin = mkdtempSync(join(tmpdir(), "b7-bin-"));
  const log = join(bin, "llamadas.log");
  const marca = join(bin, "ejecutado");
  const doble = (nombre: string, cuerpo: string) => {
    const p = join(bin, nombre);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${nombre} $*" >> "${log}"\n${cuerpo}\n`);
    chmodSync(p, 0o755);
  };
  writeFileSync(log, "");
  doble("id", `printf '%s\\n' "${uid}"`);
  doble("mkdir", "exit 0");
  doble("chown", "exit 0");
  // su-exec <usuario> <cmd...>: descarta el usuario y ejecuta el resto.
  doble("su-exec", 'shift\nexec "$@"');

  const r = spawnSync("/bin/sh", [ENTRYPOINT, "/bin/sh", "-c", `: > "${marca}"`], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
  });
  return {
    status: r.status ?? -1,
    llamadas: readFileSync(log, "utf8").split("\n").filter(Boolean),
    ejecutado: existsSync(marca),
    stderr: r.stderr ?? "",
  };
}

describe("B7 · entrypoint: ajusta la propiedad y baja de root SIEMPRE", () => {
  it("como root con ARENA_DATA_DIRS: crea el directorio, lo chownea y ejecuta el servicio como node", () => {
    const r = correrEntrypoint({ ARENA_DATA_DIRS: "/data/replays" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.llamadas).toContain("mkdir -p /data/replays");
    expect(r.llamadas).toContain("chown node:node /data/replays");
    expect(
      r.llamadas.some((l) => l.startsWith("su-exec node:node")),
      "debe bajar a node",
    ).toBe(true);
    expect(r.ejecutado, "y ejecutar el comando del servicio").toBe(true);
  });

  it("el chown NO es recursivo (un volumen de meses no se recorre entero en cada arranque)", () => {
    const r = correrEntrypoint({ ARENA_DATA_DIRS: "/data/replays" });
    for (const l of r.llamadas.filter((l) => l.startsWith("chown"))) {
      expect(l).not.toMatch(/\s-R\b|--recursive/);
    }
  });

  it("admite varios directorios de datos y chownea exactamente esos", () => {
    const r = correrEntrypoint({ ARENA_DATA_DIRS: "/data/replays /data/logs" });
    expect(r.status, r.stderr).toBe(0);
    const chowns = r.llamadas.filter((l) => l.startsWith("chown"));
    expect(chowns).toEqual(["chown node:node /data/replays", "chown node:node /data/logs"]);
  });

  it("sin ARENA_DATA_DIRS no toca NADA, pero sigue bajando a node (api, web, map-service…)", () => {
    const r = correrEntrypoint({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.llamadas.filter((l) => l.startsWith("chown"))).toEqual([]);
    expect(r.llamadas.filter((l) => l.startsWith("mkdir"))).toEqual([]);
    expect(r.llamadas.some((l) => l.startsWith("su-exec node:node"))).toBe(true);
    expect(r.ejecutado).toBe(true);
  });

  it("si ya arranca sin privilegios, ni chownea ni intenta bajar de usuario: solo ejecuta", () => {
    const r = correrEntrypoint({ ARENA_DATA_DIRS: "/data/replays" }, "1000");
    expect(r.status, r.stderr).toBe(0);
    expect(r.llamadas.filter((l) => !l.startsWith("id"))).toEqual([]);
    expect(r.ejecutado).toBe(true);
  });
});

describe("B7 · entrypoint: el paso privilegiado está acotado (fail-closed)", () => {
  for (const malo of ["/etc", "/", "/var/run/docker.sock", "data/replays", "/dataX/replays"]) {
    it(`rechaza ARENA_DATA_DIRS=${malo} y NO arranca el servicio`, () => {
      const r = correrEntrypoint({ ARENA_DATA_DIRS: malo });
      expect(r.status, `debía abortar con ${malo}`).not.toBe(0);
      expect(r.llamadas.filter((l) => l.startsWith("chown"))).toEqual([]);
      expect(r.ejecutado, "no debe ejecutar el servicio tras rechazar la configuración").toBe(false);
      expect(r.stderr).toMatch(/ARENA_DATA_DIRS/);
    });
  }

  for (const escape of ["/data/../etc", "/data/replays/../../etc"]) {
    it(`rechaza el escape por '..' (${escape})`, () => {
      const r = correrEntrypoint({ ARENA_DATA_DIRS: escape });
      expect(r.status).not.toBe(0);
      expect(r.llamadas.filter((l) => l.startsWith("chown"))).toEqual([]);
      expect(r.ejecutado).toBe(false);
    });
  }

  it("un solo directorio inválido en la lista aborta TODO el arranque", () => {
    const r = correrEntrypoint({ ARENA_DATA_DIRS: "/data/replays /etc" });
    expect(r.status).not.toBe(0);
    expect(r.ejecutado).toBe(false);
  });
});

describe("B7 · el Compose real sigue resolviendo (docker compose config)", () => {
  const hayCompose = (() => {
    try {
      execFileSync("docker", ["compose", "version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(hayCompose)("el resolvedor de Docker ve arena_replays en api (ro) y tournament-worker (rw)", () => {
    const raw = execFileSync("docker", ["compose", "-f", COMPOSE_PATH, "--profile", "production", "config"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const resuelto = parse(raw);
    const api = (resuelto.services.api.volumes ?? []).find((v: any) => v.source === "arena_replays");
    const worker = (resuelto.services["tournament-worker"].volumes ?? []).find(
      (v: any) => v.source === "arena_replays",
    );
    expect(api, "api sin arena_replays tras resolver").toBeDefined();
    expect(api.target).toBe(MOUNT);
    expect(api.read_only).toBe(true);
    expect(worker, "tournament-worker sin arena_replays tras resolver").toBeDefined();
    expect(worker.target).toBe(MOUNT);
    expect(worker.read_only ?? false).toBe(false);
    expect(resuelto.services["tournament-worker"].environment.ARENA_DATA_DIRS).toBe(MOUNT);
  });
});
