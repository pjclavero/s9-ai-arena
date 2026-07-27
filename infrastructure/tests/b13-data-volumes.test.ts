/**
 * B13 · Volúmenes de datos: quién escribe de verdad, quién está protegido y
 * quién no debería estar montado.
 *
 * Contexto (defecto real de VM108, 2026-07-17 → 2026-07-27): `arena_replays`
 * llevaba diez días vacío porque el servicio no podía escribir en él y nadie se
 * enteró — /healthz no toca el disco. B7 blindó replay-service y
 * tournament-worker. B13 cierra los dos huecos que quedaban y una superficie
 * inútil:
 *
 *   1. `streamer` escribe en /data/replays/video (modo record, E11.M) y no
 *      tenía ni preflight ni ARENA_DATA_DIRS: mismo fallo silencioso, pero con
 *      vídeo. Ahora comparte el MISMO entrypoint que la imagen genérica
 *      (parametrizado por ARENA_SERVICE_USER) y hace preflight al arrancar.
 *   2. `map-service` monta arena_maps en rw pero su almacén es EN MEMORIA
 *      (apps/map-service/src/service.ts): no escribe un solo byte en /data. No
 *      se le pone protección — se le pone un CENTINELA: si algún día escribe,
 *      este test se pone rojo y obliga a protegerlo.
 *   3. `arena-engine` montaba tres volúmenes y no abre /data en ningún archivo.
 *      Montajes retirados; centinela equivalente aquí.
 *
 * Los centinelas no son comparaciones de cadenas decorativas: barren el código
 * fuente real de cada servicio y fallan si aparece una escritura a /data que no
 * esté cubierta por el mecanismo.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildFfmpegArgs } from "../../apps/streamer/src/ffmpeg.js";
import { loadConfig } from "../../apps/streamer/src/config.js";
import { instruccionesDockerfile, instruccionesRun } from "./fixtures/dockerfile-instrucciones.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const COMPOSE_PATH = join(here, "..", "docker-compose.yml");
const ENTRYPOINT = join(here, "..", "docker", "node-service", "entrypoint.sh");
const NS_HARNESS = join(here, "fixtures", "entrypoint-ns-harness.sh");

type Svc = Record<string, any>;
const doc = parse(readFileSync(COMPOSE_PATH, "utf8"), { merge: true });
const services: Record<string, Svc> = doc.services;

interface Montaje {
  source: string;
  target: string;
  readOnly: boolean;
}

function montajes(def: Svc): Montaje[] {
  return (def.volumes ?? []).map((v: any) => {
    if (typeof v === "string") {
      const [source, target, ...flags] = v.split(":");
      return { source, target, readOnly: flags.includes("ro") };
    }
    return { source: String(v.source ?? ""), target: String(v.target ?? ""), readOnly: v.read_only === true };
  });
}

/** Todos los archivos .ts/.js de un directorio, recursivo, sin tests. */
function fuentes(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      out.push(...fuentes(p));
    } else if (/\.(ts|tsx|js|mjs)$/.test(e) && !/\.test\./.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/** Archivos de un servicio que mencionan una ruta absoluta bajo /data/. */
function fuentesQueTocanData(appDir: string): string[] {
  return fuentes(join(REPO, appDir)).filter((f) => /["'`]\/data\//.test(readFileSync(f, "utf8")));
}

const DF_STREAMER = readFileSync(join(here, "..", "docker", "streamer", "Dockerfile"), "utf8");

/**
 * O2 · ¿La imagen del streamer EJECUTA su prueba viva dentro del build?
 *
 * Mismo guard-rail que D1 puso para node-service, por el mismo motivo: aquí no
 * hay demonio de Docker, así que la única verificación viva del entrypoint
 * encadenado y del preflight es un `RUN` del Dockerfile — y D1 demostró que un
 * `RUN` comentado deja esa verificación muerta EN SILENCIO y en verde. Se leen
 * instrucciones reales (fixtures/dockerfile-instrucciones.ts), no texto.
 */
export function elDockerfileDelStreamerEjecutaSuPrueba(df: string): boolean {
  const run = instruccionesRun(df);
  return (
    /test "\$\(id -un\)" = streamer/.test(run) && // baja al usuario correcto
    /mkdir -p \/data\/replays\/video/.test(run) && // se crea el subdirectorio SIN privilegios
    /stat -c %u:%g \/data\/replays\/video/.test(run) && // y nace con uid:gid 1000
    /tsx \/app\/apps\/streamer\/src\/main\.ts/.test(run) && // el preflight se ejecuta de verdad
    /ERR_MODULE_NOT_FOUND/.test(run) // y se comprueba que el import resuelve
  );
}

// ─────────────────── 1 · streamer: protegido de verdad ───────────────────

describe("B13 · streamer (escribe vídeo en /data/replays/video)", () => {
  const streamer = services.streamer;

  /** Entorno del Compose forzado a modo grabación (el que escribe en disco). */
  const entornoRecord = (extra: Record<string, string> = {}) =>
    ({ ...streamer.environment, STREAM_MODE: "record", ...extra }) as Record<string, string>;

  it("monta arena_replays en escritura y declara ARENA_DATA_DIRS sobre ese montaje", () => {
    const m = montajes(streamer).find((x) => x.source === "arena_replays");
    expect(m, "el modo record escribe en el volumen: debe montarlo").toBeDefined();
    expect(m!.readOnly, "el streamer escribe: no puede ser :ro").toBe(false);
    expect(streamer.environment.ARENA_DATA_DIRS).toBe(m!.target);
  });

  it("con el entorno REAL del Compose, ffmpeg escribiría dentro del directorio protegido", () => {
    // Comportamiento, no cadenas: se carga la configuración con el entorno tal
    // cual lo declara el Compose y se llama al CONSTRUCTOR REAL de argumentos de
    // ffmpeg. El último argumento es el fichero que abre el proceso en
    // producción; si cayera fuera del directorio cuya propiedad garantiza el
    // entrypoint, el mecanismo no serviría de nada.
    const destino = buildFfmpegArgs(loadConfig(entornoRecord()), null).args.at(-1)!;
    const protegido = String(streamer.environment.ARENA_DATA_DIRS);
    expect(destino.startsWith(`${protegido}/`), `ffmpeg escribiría en ${destino}, fuera de ${protegido}`).toBe(true);
    expect(destino.endsWith(".mp4")).toBe(true);
  });

  it("y ese destino está bajo RECORD_DIR, el subdirectorio que el servicio se crea solo", () => {
    const destino = buildFfmpegArgs(loadConfig(entornoRecord()), null).args.at(-1)!;
    expect(destino.startsWith(`${streamer.environment.RECORD_DIR}/`)).toBe(true);
  });

  it("el test anterior no es vacuo: con otro RECORD_DIR el destino se sale del volumen", () => {
    const destino = buildFfmpegArgs(loadConfig(entornoRecord({ RECORD_DIR: "/tmp/otro-sitio" })), null).args.at(-1)!;
    expect(destino.startsWith("/tmp/otro-sitio/")).toBe(true);
    expect(destino.startsWith(`${streamer.environment.ARENA_DATA_DIRS}/`)).toBe(false);
  });

  it("su imagen usa el MISMO entrypoint de datos que la genérica, no uno paralelo", () => {
    // Se leen INSTRUCCIONES, no texto (lección D1): un COPY comentado no vale.
    const vivas = instruccionesDockerfile(DF_STREAMER).join("\n");
    expect(vivas, "el streamer debe copiar el entrypoint compartido").toContain(
      "COPY infrastructure/docker/node-service/entrypoint.sh /data-dir-entrypoint.sh",
    );
    expect(vivas).toContain('ENTRYPOINT ["/data-dir-entrypoint.sh", "/entrypoint.sh"]');
    expect(vivas, "sin su-exec el entrypoint no puede bajar de root").toMatch(/apk add[^\n]*su-exec/);
    expect(vivas, "el preflight vive en packages/data-dir y DEBE entrar en la imagen").toContain(
      "COPY packages/data-dir /app/packages/data-dir",
    );
  });

  it("el preflight del streamer es el compartido de B7, no una copia", () => {
    const main = readFileSync(join(REPO, "apps", "streamer", "src", "main.ts"), "utf8");
    expect(main).toContain('from "../../../packages/data-dir/index.js"');
    expect(main).toMatch(/requireWritableDataDir\("streamer", config\.recordDir\)/);
  });
});

// ───────── O2 · la prueba viva de la imagen del streamer no puede morir sola ─────────

describe("B13/O2 · guard-rail de la prueba viva del streamer (mismo criterio que D1)", () => {
  it("el Dockerfile del streamer EJECUTA su prueba dentro de la imagen", () => {
    // Aquí no hay demonio Docker: esta es una comprobación de COBERTURA (¿lo
    // prueba alguien?). El comportamiento lo prueba el build de la etapa 5.
    expect(
      elDockerfileDelStreamerEjecutaSuPrueba(DF_STREAMER),
      "sin ese RUN, el entrypoint encadenado y el preflight del streamer no los verifica NADIE",
    ).toBe(true);
  });

  it("un Dockerfile comentado NO puede dar la prueba por hecha", () => {
    const comentado = DF_STREAMER.split("\n")
      .map((l) => (l.trim() === "" ? l : `# ${l}`))
      .join("\n");
    // El texto crudo sigue conteniendo todo: así se dejaría engañar una
    // comprobación sobre el fichero en bruto (el defecto que destapó D1).
    expect(/tsx \/app\/apps\/streamer\/src\/main\.ts/.test(comentado)).toBe(true);
    // Leyendo instrucciones reales, no queda nada vivo.
    expect(elDockerfileDelStreamerEjecutaSuPrueba(comentado)).toBe(false);
  });

  it("borrar solo el RUN de la prueba (dejando el resto) también se detecta", () => {
    const sinPrueba = DF_STREAMER.replace(
      /RUN ARENA_DATA_DIRS=\/data\/replays \/data-dir-entrypoint\.sh[\s\S]*?\n\n/,
      "",
    );
    expect(sinPrueba).not.toBe(DF_STREAMER);
    expect(elDockerfileDelStreamerEjecutaSuPrueba(sinPrueba)).toBe(false);
  });
});

// ─────── BL-2 · la invariante de rutas profundas, fijada por un test ───────

describe("B13/BL-2 · ARENA_DATA_DIRS nunca declara rutas profundas", () => {
  // Decisión consciente (ver cabecera de infrastructure/docker/node-service/
  // entrypoint.sh): entre validar un componente y hacerle mkdir/chown hay una
  // ventana; con rutas de más de un componente dentro de un volumen compartido,
  // el componente intermedio es escribible por otro contenedor y `chown -h` no
  // lo cubre. El Supervisor no consiguió explotarla (600 intentos, 0 ganados),
  // pero eso es ausencia de prueba, no prueba de ausencia: en vez de documentar
  // la ventana, se cierra. El subdirectorio lo crea el servicio sin privilegios.
  const declaraciones = Object.entries(services).flatMap(([name, def]) =>
    String(def.environment?.ARENA_DATA_DIRS ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((d) => [name, d] as const),
  );

  it("hay declaraciones que comprobar (si no, este bloque no probaría nada)", () => {
    expect(declaraciones.length).toBeGreaterThan(0);
  });

  it("toda ruta declarada es /data/<un-solo-componente>", () => {
    for (const [name, d] of declaraciones) {
      const componentes = d.split("/").filter(Boolean);
      expect(componentes[0], `${name}: ${d}`).toBe("data");
      expect(
        componentes.length,
        `${name} declara la ruta profunda ${d}: cierra antes la ventana de la carrera (ver INVARIANTE en entrypoint.sh) o que el servicio se cree el subdirectorio él mismo`,
      ).toBe(2);
    }
  });

  it("el streamer escribe MÁS PROFUNDO de lo que declara, y esa diferencia es deliberada", () => {
    // Es el caso que motiva la invariante: RECORD_DIR es de dos componentes y
    // ARENA_DATA_DIRS de uno. Quien iguale los dos valores rompe este test.
    const streamer = services.streamer;
    expect(String(streamer.environment.RECORD_DIR).split("/").filter(Boolean).length).toBe(3);
    expect(String(streamer.environment.ARENA_DATA_DIRS).split("/").filter(Boolean).length).toBe(2);
    expect(String(streamer.environment.RECORD_DIR).startsWith(`${streamer.environment.ARENA_DATA_DIRS}/`)).toBe(true);
  });
});

// ─────────── 2 · map-service y arena-engine: centinelas de escritura ───────────

describe("B13 · centinelas: si un servicio empieza a escribir en /data, hay que protegerlo", () => {
  it("map-service NO escribe en /data (almacén en memoria) y por eso no lleva preflight", () => {
    expect(fuentesQueTocanData("apps/map-service")).toEqual([]);
    expect(
      services["map-service"].environment.ARENA_DATA_DIRS,
      "si map-service empieza a escribir en /data/maps, declara ARENA_DATA_DIRS y añade el preflight",
    ).toBeUndefined();
  });

  it("arena-engine NO toca /data en ningún archivo (por eso se le retiraron los montajes)", () => {
    expect(fuentesQueTocanData("apps/arena-engine")).toEqual([]);
  });

  it("arena-engine no monta ningún volumen de datos", () => {
    expect(montajes(services["arena-engine"])).toEqual([]);
  });

  it("el centinela detecta de verdad una escritura nueva (no aprueba por construcción)", () => {
    // Mutación: el barrido se ejecuta sobre un servicio que SÍ escribe en /data.
    // Si el barrido fuese vacuo, esto saldría vacío también.
    expect(fuentesQueTocanData("apps/replay-service").length).toBeGreaterThan(0);
    expect(fuentesQueTocanData("apps/streamer").length).toBeGreaterThan(0);
  });

  it("todo servicio con ARENA_DATA_DIRS monta de verdad ese directorio en escritura", () => {
    for (const [name, def] of Object.entries(services)) {
      const dirs = String(def.environment?.ARENA_DATA_DIRS ?? "")
        .split(/\s+/)
        .filter(Boolean);
      for (const d of dirs) {
        const m = montajes(def).find((x) => d === x.target || d.startsWith(`${x.target}/`));
        expect(m, `${name}: declara ARENA_DATA_DIRS=${d} sin montar nada ahí`).toBeDefined();
        expect(m!.readOnly, `${name}: ${d} está montado en solo lectura`).toBe(false);
      }
    }
  });

  it("ningún servicio fija ARENA_SERVICE_USER desde el Compose (es propiedad de la imagen)", () => {
    for (const [name, def] of Object.entries(services)) {
      expect(def.environment?.ARENA_SERVICE_USER, `${name} no debe elegir el usuario del servicio`).toBeUndefined();
    }
  });
});

// ────────── 3 · el entrypoint compartido, ejecutado de verdad como uid 0 ──────────
//
// Mismo banco de pruebas que B7 (unshare -rm + chroot: uid 0 dentro de un
// espacio de nombres, cero privilegios fuera), ahora también con el usuario del
// streamer.

interface EjecucionNs {
  disponible: boolean;
  rc: number;
  chowns: string[];
  suexec: string[];
  ejecutado: boolean;
  salida: string;
}

function correrEnNamespace(dirs: string, escenario: "normal" | "symlink" | "ancestro", usuario: string): EjecucionNs {
  const r = spawnSync("/bin/sh", [NS_HARNESS, ENTRYPOINT, dirs, escenario, usuario], { encoding: "utf8" });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 99) return { disponible: false, rc: -1, chowns: [], suexec: [], ejecutado: false, salida };
  const lineas = (r.stdout ?? "").split("\n");
  const rcLinea = lineas.filter((l) => l.startsWith("rc=")).pop();
  return {
    disponible: true,
    rc: rcLinea ? Number(rcLinea.slice(3)) : -1,
    chowns: lineas.filter((l) => l.startsWith("CHOWN ")),
    suexec: lineas.filter((l) => l.startsWith("SU-EXEC ")),
    ejecutado: lineas.includes("SERVICIO-EJECUTADO"),
    salida,
  };
}

const nsDisponible = correrEnNamespace("/data/replays", "normal", "node").disponible;

describe("B13 · el entrypoint compartido baja al usuario correcto de CADA imagen", () => {
  it("en CI los espacios de nombres sin privilegios DEBEN estar disponibles", () => {
    if (process.env.CI) expect(nsDisponible, "unshare -rm no funciona en este runner").toBe(true);
    else expect(typeof nsDisponible).toBe("boolean");
  });

  it.runIf(nsDisponible)("con ARENA_SERVICE_USER=streamer chownea el volumen y baja a streamer", () => {
    const r = correrEnNamespace("/data/replays", "normal", "streamer");
    expect(r.rc, r.salida).toBe(0);
    expect(r.chowns).toEqual(["CHOWN /data/replays -> /data/replays"]);
    expect(r.suexec, "el proceso del streamer NO puede acabar corriendo como node ni como root").toEqual([
      "SU-EXEC streamer:streamer",
    ]);
    expect(r.ejecutado).toBe(true);
  });

  it.runIf(nsDisponible)("sin ARENA_SERVICE_USER sigue bajando a node (comportamiento de B7 intacto)", () => {
    const r = correrEnNamespace("/data/replays", "normal", "node");
    expect(r.rc, r.salida).toBe(0);
    expect(r.suexec).toEqual(["SU-EXEC node:node"]);
    expect(r.ejecutado).toBe(true);
  });

  it.runIf(nsDisponible)("ARENA_SERVICE_USER=root aborta el arranque sin tocar nada", () => {
    const r = correrEnNamespace("/data/replays", "normal", "root");
    expect(r.rc, r.salida).toBe(1);
    expect(r.chowns).toEqual([]);
    expect(r.suexec).toEqual([]);
    expect(r.ejecutado, "un servicio corriendo como root es exactamente lo que no queremos").toBe(false);
    expect(r.salida).toMatch(/NO puede correr como root/);
  });

  it.runIf(nsDisponible)("un ARENA_SERVICE_USER con metacaracteres se rechaza en vez de interpretarse", () => {
    const r = correrEnNamespace("/data/replays", "normal", "no;rm -rf /");
    expect(r.rc, r.salida).toBe(1);
    expect(r.chowns).toEqual([]);
    expect(r.ejecutado).toBe(false);
    expect(r.salida).toMatch(/no es un nombre de usuario valido/);
  });

  it.runIf(nsDisponible)("BL-2 · una ruta profunda se RECHAZA (la invariante es ejecutable, no un párrafo)", () => {
    // /data/replays/video existe y no es ningún enlace: se rechaza SOLO por ser
    // profunda. Es el valor que este bloque estuvo a punto de declarar.
    const r = correrEnNamespace("/data/replays/video", "normal", "streamer");
    expect(r.rc, r.salida).toBe(1);
    expect(r.chowns, "no se toca nada").toEqual([]);
    expect(r.ejecutado).toBe(false);
    expect(r.salida).toMatch(/ruta profunda/);
  });

  it.runIf(nsDisponible)("BL-2 · y la ruta de un componente que sí se declara sigue aceptándose", () => {
    const r = correrEnNamespace("/data/replays", "normal", "streamer");
    expect(r.rc, r.salida).toBe(0);
    expect(r.chowns).toEqual(["CHOWN /data/replays -> /data/replays"]);
  });

  it.runIf(nsDisponible)("el guard de rutas sigue vivo con el usuario del streamer (no se relajó nada)", () => {
    const r = correrEnNamespace("/data/replays", "symlink", "streamer");
    expect(r.rc, r.salida).toBe(1);
    expect(r.chowns, "el chown habría actuado fuera de /data").toEqual([]);
    expect(r.ejecutado).toBe(false);
  });
});
