/**
 * CARRIL COMPOSE CANÓNICO · calibración del comprobador de reproducibilidad.
 *
 * Cada garantía viene con su control POSITIVO (stack coherente → verde) y su
 * control NEGATIVO (stack roto → rojo con el código concreto). Un comprobador
 * que sólo se ha visto en verde no demuestra nada, así que además hay
 * MUTACIONES (`compose-canonical-mutations.mjs`) que estropean el comprobador de
 * verdad y tienen que hacer fallar esta misma suite.
 *
 * Los hechos del fixture son REALES: salieron del daemon de producción de VM108
 * con `--collect` (solo lectura), ya saneados de topología. Las rutas de
 * anfitrión se sustituyeron por marcadores que CONSERVAN la distinción entre las
 * tres procedencias, que es lo que se está probando.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error — script .mjs sin tipos, se consume desde tests y CI.
import {
  CODIGOS,
  comprobar,
  comprobarProcedencia,
  comprobarServicio,
  etiquetaProcedencia,
  healthcheckDesdeCompose,
  informeTexto,
  puertoDesdeCompose,
  specDesdeCompose,
} from "../scripts/compose-canonical-check.mjs";
// @ts-expect-error — script .mjs sin tipos.
import {
  hechosDesdeInspect,
  huella,
  ipLogica,
  procedencia,
  puertosPublicados,
} from "../scripts/runtime-drift-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "drift-facts-vm108.json"), "utf8"));
const COMPOSE = parse(readFileSync(join(REPO, "infrastructure", "docker-compose.yml"), "utf8"), { merge: true });

/** El compose de producción tal y como lo renderiza el despliegue real. */
const VARS_PROD = {
  TAG: "4d469dc",
  IMAGE_PREFIX: "s9arena",
  GATEWAY_CONF: "nginx-behind-proxy.conf",
  HTTP_PORT: "8080",
  HTTPS_PORT: "8443",
};
/**
 * Las procedencias llegan a los hechos ya en forma LOGICA (huella + "vive el
 * compose dentro del directorio de despliegue?"). Aqui se fabrican las dos
 * formas que importan: la del despliegue y la de un arbol ajeno.
 */
const DESPLIEGUE = { compose_config_files_hash: "#aaaaaaaaaaaa", compose_config_en_working_dir: true };
const ARBOL_AJENO = { compose_config_files_hash: "#bbbbbbbbbbbb", compose_config_en_working_dir: false };
const OTRO_ARBOL_AJENO = { compose_config_files_hash: "#cccccccccccc", compose_config_en_working_dir: false };

const specsProd = () => specDesdeCompose(COMPOSE, { vars: VARS_PROD, profile: "production" });

/** Un hecho de servicio coherente con `spec`, para los controles positivos. */
function hechoSano(extra: Record<string, unknown> = {}) {
  return {
    service: "api",
    compose_managed: true,
    ...DESPLIEGUE,
    declared_ref: "s9arena/api:aaa",
    mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: false }],
    secrets: ["jwt_secret"],
    env_names: ["PORT", "LOG_FORMAT"],
    ports: ["8080->80/tcp"],
    command_hash: null,
    entrypoint_hash: huella(["/entrypoint.sh"]),
    healthcheck_test_hash: huella(["CMD-SHELL", "curl -f localhost/healthz"]),
    ...extra,
  };
}
function specSana(extra: Record<string, unknown> = {}) {
  return {
    image: "s9arena/api:aaa",
    mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: false }],
    secrets: ["jwt_secret"],
    env_required: ["LOG_FORMAT", "PORT"],
    ports: ["8080->80/tcp"],
    command: null,
    command_hash: null,
    entrypoint: null,
    entrypoint_hash: null,
    healthcheck_test: null,
    healthcheck_test_hash: null,
    depends_on: [],
    ...extra,
  };
}
const codigos = (h: Array<{ code: string }>) => h.map((x) => x.code);

describe("control POSITIVO · un servicio coherente no produce ningún hallazgo", () => {
  it("no marca nada cuando lo vivo y lo renderizado coinciden", () => {
    expect(comprobarServicio(hechoSano(), specSana())).toEqual([]);
  });

  it("no reprocha command/entrypoint/healthcheck que el compose NO declara", () => {
    // Casi todo el stack los hereda de su imagen. Compararlos contra `null`
    // marcaría drift en todos: sería ruido que se acabaría ignorando.
    const h = hechoSano({
      command_hash: huella(["node", "main.js"]),
      entrypoint_hash: huella(["/x"]),
      healthcheck_test_hash: huella(["CMD", "true"]),
    });
    expect(comprobarServicio(h, specSana())).toEqual([]);
  });

  it("un stack entero con procedencia única y spec coincidente es REPRODUCIBLE", () => {
    const hechos = { services: [hechoSano()] };
    const r = comprobar(hechos, { api: specSana() });
    expect(r.reproducible).toBe(true);
    expect(r.hallazgos).toEqual([]);
    expect(r.recrear).toEqual([]);
  });
});

describe("PROCEDENCIA · la fuente única de verdad", () => {
  it("marca el servicio levantado desde un árbol ajeno al directorio de despliegue", () => {
    // No hace falta que el operador acierte a escribir ninguna ruta: un compose
    // que no vive en el directorio de despliegue no es la fuente de verdad.
    const r = comprobarProcedencia({ services: [hechoSano({ ...ARBOL_AJENO })] });
    expect(codigos(r.hallazgos)).toContain(CODIGOS.CONFIG_FILES_DIVERGENTE);
  });

  it("marca el compose que vive en el despliegue pero NO es el canónico declarado", () => {
    const r = comprobarProcedencia(
      { services: [hechoSano({ compose_config_files_hash: "#zzzzzzzzzzzz", compose_config_en_working_dir: true })] },
      { canonica: "/cualquier/ruta/docker-compose.yml" },
    );
    expect(codigos(r.hallazgos)).toContain(CODIGOS.CONFIG_FILES_DIVERGENTE);
  });

  it("marca el stack con MÁS DE UNA procedencia aunque cada servicio fuese coherente", () => {
    // El incidente literal: dos servicios cuya spec cuadra pero que vinieron de
    // árboles distintos. Cuadrar hoy no es una garantía.
    const r = comprobarProcedencia({
      services: [hechoSano({ service: "api", ...DESPLIEGUE }), hechoSano({ service: "web", ...ARBOL_AJENO })],
    });
    expect(codigos(r.hallazgos)).toContain(CODIGOS.CONFIG_FILES_MULTIPLE);
  });

  it("una sola procedencia NO canónica sigue siendo fallo (no basta con ser uniforme)", () => {
    const r = comprobarProcedencia({ services: [hechoSano({ ...ARBOL_AJENO })] });
    expect(codigos(r.hallazgos)).toContain(CODIGOS.CONFIG_FILES_DIVERGENTE);
    // uniforme => no hay MULTIPLE, pero el veredicto sigue siendo rojo.
    expect(codigos(r.hallazgos)).not.toContain(CODIGOS.CONFIG_FILES_MULTIPLE);
  });

  it("un contenedor sin la etiqueta de procedencia no se da por bueno", () => {
    const r = comprobarProcedencia({
      services: [hechoSano({ compose_config_files_hash: null, compose_config_en_working_dir: null })],
    });
    expect(codigos(r.hallazgos)).toContain(CODIGOS.CONFIG_FILES_AUSENTE);
  });

  it("NUNCA emite una ruta de anfitrión ni una IP", () => {
    const r = comprobar({ services: [hechoSano({ ...ARBOL_AJENO })] }, { api: specSana() });
    const texto = informeTexto(r) + JSON.stringify(r);
    expect(texto).not.toMatch(/\/(opt|root|home|var)\//);
    expect(texto).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(texto).toContain("arbol-ajeno:");
  });

  it("la etiqueta distingue el despliegue de un árbol ajeno y agrupa por huella", () => {
    expect(etiquetaProcedencia(hechoSano())).toBe("despliegue:#aaaaaaaaaaaa");
    expect(etiquetaProcedencia(hechoSano({ ...ARBOL_AJENO }))).toBe("arbol-ajeno:#bbbbbbbbbbbb");
    expect(etiquetaProcedencia(hechoSano({ ...OTRO_ARBOL_AJENO }))).not.toBe(
      etiquetaProcedencia(hechoSano({ ...ARBOL_AJENO })),
    );
  });
});

describe("COBERTURA · el perfil no es un detalle", () => {
  it("sin perfil seleccionado el compose de este stack renderiza CERO servicios", () => {
    // Todos los servicios llevan `profiles:`. Un comprobador que no exigiera el
    // perfil compararía el stack vivo contra el conjunto vacío: falso verde.
    const sinPerfil = specDesdeCompose(COMPOSE, { vars: VARS_PROD, profile: "no-existe-este-perfil" });
    expect(Object.keys(sinPerfil)).toHaveLength(0);
  });

  it("comparar contra el conjunto vacío es ROJO, nunca verde", () => {
    const r = comprobar(FIXTURE, {});
    expect(r.reproducible).toBe(false);
    expect(codigos(r.hallazgos)).toContain(CODIGOS.SERVICIO_NO_RENDERIZADO);
  });

  it("el perfil `production` renderiza exactamente los 12 servicios desplegados", () => {
    const specs = specsProd();
    expect(Object.keys(specs).sort()).toEqual(FIXTURE.services.map((s: any) => s.service).sort());
  });

  it("un servicio renderizado que no está desplegado también es rojo", () => {
    const r = comprobar({ services: [] }, { api: specSana() });
    expect(codigos(r.hallazgos)).toContain(CODIGOS.SERVICIO_NO_DESPLEGADO);
  });
});

describe("SPEC · cada divergencia que provocaría una recreación", () => {
  it("imagen declarada distinta", () => {
    const h = comprobarServicio(hechoSano({ declared_ref: "s9arena/api:otra" }), specSana());
    expect(codigos(h)).toEqual([CODIGOS.IMAGEN_DIVERGENTE]);
  });

  it("montaje que el canónico añade", () => {
    const h = comprobarServicio(hechoSano({ mounts: [] }), specSana());
    expect(codigos(h)).toContain(CODIGOS.MONTAJE_FALTA);
  });

  it("montaje que el canónico retira", () => {
    const h = comprobarServicio(
      hechoSano({
        mounts: [...hechoSano().mounts, { tipo: "volume", destino: "/data/logs", origen: "arena_logs", rw: true }],
      }),
      specSana(),
    );
    expect(codigos(h)).toContain(CODIGOS.MONTAJE_SOBRA);
  });

  it("destino correcto servido por OTRO volumen o en OTRO modo", () => {
    // Comparar por nombre físico dejaría pasar esto; se compara por destino.
    const h = comprobarServicio(
      hechoSano({ mounts: [{ tipo: "volume", destino: "/data/replays", origen: "otro_volumen", rw: true }] }),
      specSana(),
    );
    expect(codigos(h)).toContain(CODIGOS.MONTAJE_INCORRECTO);
  });

  it("secreto añadido y secreto retirado", () => {
    expect(codigos(comprobarServicio(hechoSano({ secrets: [] }), specSana()))).toContain(CODIGOS.SECRETO_FALTA);
    expect(codigos(comprobarServicio(hechoSano({ secrets: ["jwt_secret", "otro"] }), specSana()))).toContain(
      CODIGOS.SECRETO_INESPERADO,
    );
  });

  it("variable de entorno que el canónico define y el contenedor vivo no tiene", () => {
    const h = comprobarServicio(hechoSano({ env_names: ["PORT"] }), specSana());
    expect(codigos(h)).toEqual([CODIGOS.ENV_FALTA]);
  });

  it("puertos publicados divergentes", () => {
    expect(codigos(comprobarServicio(hechoSano({ ports: ["9999->80/tcp"] }), specSana()))).toContain(
      CODIGOS.PUERTOS_DIVERGENTES,
    );
    // Y un puerto que se deja de publicar también.
    expect(codigos(comprobarServicio(hechoSano({ ports: [] }), specSana()))).toContain(CODIGOS.PUERTOS_DIVERGENTES);
  });

  it("command, entrypoint y healthcheck cuando el canónico SÍ los declara", () => {
    const specCon = (k: string, v: unknown) => specSana({ [k]: v, [`${k}_hash`]: huella(v) });
    expect(codigos(comprobarServicio(hechoSano({ command_hash: huella(["a"]) }), specCon("command", ["b"])))).toContain(
      CODIGOS.COMMAND_DIVERGENTE,
    );
    expect(
      codigos(comprobarServicio(hechoSano({ entrypoint_hash: huella(["a"]) }), specCon("entrypoint", ["b"]))),
    ).toContain(CODIGOS.ENTRYPOINT_DIVERGENTE);
    expect(
      codigos(
        comprobarServicio(
          hechoSano({ healthcheck_test_hash: huella(["CMD", "a"]) }),
          specCon("healthcheck_test", ["CMD", "b"]),
        ),
      ),
    ).toContain(CODIGOS.HEALTHCHECK_DIVERGENTE);
    // Y la huella es la MISMA función en las dos caras: iguales no divergen.
    expect(codigos(comprobarServicio(hechoSano({ command_hash: huella(["a"]) }), specCon("command", ["a"])))).toEqual(
      [],
    );
  });
});

describe("TRADUCCIÓN de Compose a la forma del daemon", () => {
  it("puertos: corta, larga, con IP, con protocolo y efímero", () => {
    expect(puertoDesdeCompose("8080:80")).toBe("8080->80/tcp");
    expect(puertoDesdeCompose("${HTTP_PORT:-80}:80", { HTTP_PORT: "8080" })).toBe("8080->80/tcp");
    // Una IP de anfitrión NO sale en claro por ninguna de las dos caras: sale
    // opaca, y las dos caras usan la misma función, así que siguen comparándose.
    const conIp = puertoDesdeCompose("127.0.0.1:8080:80");
    expect(conIp).not.toContain("127.0.0.1");
    expect(conIp).toBe(`${ipLogica("127.0.0.1")}8080->80/tcp`);
    expect(
      puertosPublicados({ HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } } }),
    ).toEqual([conIp]);
    expect(puertoDesdeCompose("5000:5000/udp")).toBe("5000->5000/udp");
    expect(puertoDesdeCompose({ published: "8080", target: 80 })).toBe("8080->80/tcp");
    // Sin puerto de anfitrión no hay nada estable que comparar: se dice.
    expect(puertoDesdeCompose("3000")).toBe("efimero->3000/tcp");
  });

  it("healthcheck: cadena → CMD-SHELL; `disable` → ninguno", () => {
    expect(healthcheckDesdeCompose({ test: "curl -f x" })).toEqual(["CMD-SHELL", "curl -f x"]);
    expect(healthcheckDesdeCompose({ test: ["CMD", "true"] })).toEqual(["CMD", "true"]);
    expect(healthcheckDesdeCompose({ disable: true })).toBeNull();
    expect(healthcheckDesdeCompose(undefined)).toBeNull();
  });

  it("el recolector extrae los puertos PUBLICADOS del inspect (no los expuestos)", () => {
    const c = {
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }], "443/tcp": [{ HostIp: "", HostPort: "8443" }] },
      },
      Config: { ExposedPorts: { "9999/tcp": {} } },
    };
    expect(puertosPublicados(c)).toEqual(["8080->80/tcp", "8443->443/tcp"]);
  });

  it("el recolector emite la procedencia SIN publicar la ruta del anfitrión", () => {
    const labels = {
      "com.docker.compose.service": "api",
      "com.docker.compose.project": "infrastructure",
      "com.docker.compose.project.config_files": "/despliegue/infrastructure/docker-compose.yml",
      "com.docker.compose.project.working_dir": "/despliegue/infrastructure",
    };
    const [hecho] = hechosDesdeInspect(
      [
        {
          Name: "/infrastructure-api-1",
          Image: "sha256:" + "1".repeat(64),
          Mounts: [],
          Config: { Image: "s9arena/api:aaa", Env: [], Labels: labels },
          HostConfig: { PortBindings: {} },
        },
      ],
      { existe: () => true, resolver: () => null, runtimeDeRef: () => null },
    );
    expect(hecho.compose_project).toBe("infrastructure");
    expect(hecho.compose_config_en_working_dir).toBe(true);
    expect(JSON.stringify(hecho)).not.toContain("/despliegue");
  });

  it("la procedencia detecta el árbol ajeno y el override añadido", () => {
    const wd = "/despliegue/infrastructure";
    expect(
      procedencia({
        "com.docker.compose.project.config_files": "/otro-arbol/infrastructure/docker-compose.yml",
        "com.docker.compose.project.working_dir": wd,
      }).compose_config_en_working_dir,
    ).toBe(false);
    // Un override que vive fuera del despliegue también rompe la procedencia,
    // aunque el fichero base sí esté dentro.
    expect(
      procedencia({
        "com.docker.compose.project.config_files": `${wd}/docker-compose.yml,/tmp/override.yml`,
        "com.docker.compose.project.working_dir": wd,
      }).compose_config_en_working_dir,
    ).toBe(false);
    // Y dos árboles distintos no comparten huella.
    expect(
      procedencia({ "com.docker.compose.project.config_files": "/a", "com.docker.compose.project.working_dir": "/a" })
        .compose_config_files_hash,
    ).not.toBe(
      procedencia({ "com.docker.compose.project.config_files": "/b", "com.docker.compose.project.working_dir": "/b" })
        .compose_config_files_hash,
    );
  });
});

describe("HECHOS REALES de VM108 · el incidente que motiva el carril", () => {
  const r = () => comprobar(FIXTURE, specsProd());

  it("el stack de producción NO es reproducible desde el compose de main", () => {
    expect(r().reproducible).toBe(false);
  });

  it("hay TRES procedencias distintas en un mismo proyecto Compose", () => {
    const res = r();
    expect(Object.keys(res.procedencias)).toHaveLength(3);
    expect(codigos(res.hallazgos)).toContain(CODIGOS.CONFIG_FILES_MULTIPLE);
  });

  it("los 12 servicios vivos están todos cubiertos por el perfil `production`", () => {
    const res = r();
    expect(codigos(res.hallazgos)).not.toContain(CODIGOS.SERVICIO_NO_RENDERIZADO);
    expect(codigos(res.hallazgos)).not.toContain(CODIGOS.SERVICIO_NO_DESPLEGADO);
  });

  it("la partición recrear/reetiquetar es exactamente la medida", () => {
    const res = r();
    // Estos tres cambian de SPEC: recrearlos aplica un cambio real.
    expect(res.recrear).toEqual(["api", "backup", "postgres"]);
    // Estos ocho sólo arrastran una procedencia equivocada: su spec ya coincide
    // con el canónico, así que canonizar no les cambia nada.
    expect(res.reetiquetar).toEqual([
      "arena-engine",
      "bot-build-worker",
      "bot-manager",
      "gateway",
      "map-service",
      "replay-service",
      "tournament-worker",
      "web",
    ]);
  });

  it("api sólo diverge en la variable nueva de concurrencia", () => {
    const res = r();
    const api = res.hallazgos.filter((x: any) => x.service === "api" && x.code !== CODIGOS.CONFIG_FILES_DIVERGENTE);
    expect(codigos(api)).toEqual([CODIGOS.ENV_FALTA]);
    expect(api[0].detail).toContain("S9_MAX_CONCURRENT_REAL_BATTLE_RUNS");
  });

  it("backup diverge en imagen, hostname de restic y healthcheck", () => {
    const res = r();
    const b = res.hallazgos.filter((x: any) => x.service === "backup" && x.code !== CODIGOS.CONFIG_FILES_DIVERGENTE);
    expect(codigos(b).sort()).toEqual(
      [CODIGOS.ENV_FALTA, CODIGOS.HEALTHCHECK_DIVERGENTE, CODIGOS.IMAGEN_DIVERGENTE].sort(),
    );
  });

  it("postgres diverge en la referencia de imagen: canonizar lo RECREARÍA", () => {
    // postgres está en DO NOT RESTART. Que el comprobador lo saque en `recrear`
    // es justo lo que hace que el procedimiento de canonización tenga que
    // tratarlo aparte, en vez de descubrirlo durante un `up`.
    const res = r();
    const pg = res.hallazgos.filter((x: any) => x.service === "postgres");
    expect(codigos(pg)).toEqual([CODIGOS.IMAGEN_DIVERGENTE]);
    expect(res.recrear).toContain("postgres");
  });

  it("el fixture no lleva ninguna ruta física del anfitrión ni ninguna IP", () => {
    const crudo = readFileSync(join(here, "fixtures", "drift-facts-vm108.json"), "utf8");
    expect(crudo).not.toMatch(/\/(opt|root|home)\//);
    expect(crudo).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });
});
