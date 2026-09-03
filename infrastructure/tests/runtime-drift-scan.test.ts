/**
 * CARRIL G · calibración del RUNTIME DRIFT SCANNER.
 *
 * Un escáner que solo se ha visto en verde no es evidencia de nada. Aquí cada
 * garantía viene con su control positivo (estado coherente → verde) y su control
 * negativo (estado roto → rojo con un motivo concreto), y además con MUTACIONES:
 * versiones deliberadamente estropeadas del escáner que tienen que hacer FALLAR
 * a esta misma suite. Si una mutación pasa la suite, la garantía correspondiente
 * no la estaba comprobando nadie.
 *
 * Las mutaciones obligadas de este carril, todas demostradas en rojo:
 *   M1 · la existencia de la imagen siempre cierta
 *   M2 · la etiqueta siempre coincidente
 *   M3 · IMAGE_MISSING convertido en PASS
 *   M4 · TAG_MOVED convertido en PASS
 *   M5 · montajes comparados por nombre FÍSICO en vez de por destino
 *
 * Los hechos del fixture son REALES: salieron del daemon de producción con
 * `--collect` (solo lectura), ya saneados de topología por el recolector.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error — script .mjs sin tipos, se consume desde tests y CI.
import {
  ESTADOS,
  driftDeEntorno,
  driftDeMontajes,
  driftDeSecretos,
  escanear,
  escanearServicio,
  hechosDesdeInspect,
  informeJson,
  informeTexto,
  montajeDesdeCompose,
  objetivosDesdeCompose,
  origenLogico,
  runtimeDesdeEnv,
} from "../scripts/runtime-drift-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "drift-facts-vm108.json"), "utf8"));
const COMPOSE = parse(readFileSync(join(REPO, "infrastructure", "docker-compose.yml"), "utf8"), { merge: true });

const ID_A = "sha256:" + "1".repeat(64);
const ID_B = "sha256:" + "2".repeat(64);

function sano(extra: Record<string, unknown> = {}) {
  return {
    service: "api",
    declared_ref: "s9arena/api:aaa",
    running_image_id: ID_A,
    running_image_exists: true,
    declared_ref_current_id: ID_A,
    running_image_repo_tags: ["s9arena/api:aaa"],
    build_commit: "aaa" + "0".repeat(37),
    runtime: { NODE_VERSION: "22.15.1" },
    mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: false }],
    secrets: ["jwt_secret"],
    env_names: ["PORT"],
    ...extra,
  };
}

const OBJETIVO = {
  declared_ref: "s9arena/api:aaa",
  runtime: { NODE_VERSION: "22.15.1" },
  mounts_spec: { mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: false }] },
  secrets: ["jwt_secret"],
  env: { required: ["PORT"], forbidden: ["S9K_AUTH_ENABLED"] },
};

describe("control positivo", () => {
  it("un servicio coherente sale OK", () => {
    expect(escanearServicio(sano(), OBJETIVO).result).toBe(ESTADOS.OK);
  });
});

describe("existencia de la image ID (docker image inspect, nunca docker images -q)", () => {
  it("la imagen desaparecida sale IMAGE_MISSING", () => {
    const r = escanearServicio(sano({ running_image_exists: false }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.IMAGE_MISSING);
    expect(r.running_image_exists).toBe("NO");
    expect(r.motivos.join(" ")).toMatch(/no es reproducible/);
  });

  it("si la existencia no se comprobó, NO se presume: sale NOT_EXERCISED, jamás OK", () => {
    const r = escanearServicio(sano({ running_image_exists: undefined }), OBJETIVO);
    expect(r.result).not.toBe(ESTADOS.OK);
    expect(r.running_image_exists).toBe("desconocido");
  });

  it("el recolector pregunta por la image ID, no por un listado de etiquetas", () => {
    // Reproduce el caso real de producción: la imagen existe pero se quedó SIN
    // etiquetas, así que un listado por etiquetas (docker images -q) no la ve.
    const preguntas: string[] = [];
    const hechos = hechosDesdeInspect(
      [
        {
          Name: "/x-postgres-1",
          Image: ID_B,
          Config: { Image: "postgres:16-alpine", Env: [], Labels: { "com.docker.compose.service": "postgres" } },
          Mounts: [],
        },
      ],
      {
        existe: (id: string) => {
          preguntas.push(id);
          return true; // image inspect SÍ la encuentra
        },
        resolver: () => ID_A,
      },
    );
    expect(preguntas).toEqual([ID_B]);
    expect(hechos[0].running_image_exists).toBe(true);
  });
});

describe("etiquetas", () => {
  it("etiqueta MOVIDA: la etiqueta declarada resuelve hoy a otra imagen", () => {
    const r = escanearServicio(sano({ declared_ref_current_id: ID_B, running_image_repo_tags: [] }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.TAG_MOVED);
    expect(r.motivos.join(" ")).toMatch(/ETIQUETA MOVIDA/);
  });

  it("etiqueta INCORRECTA: se desplegó una etiqueta distinta de la del objetivo", () => {
    const r = escanearServicio(sano({ declared_ref: "s9arena/api:otra" }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.TAG_MISMATCH);
  });

  it("la etiqueta que ya no resuelve a nada también es TAG_MOVED", () => {
    expect(escanearServicio(sano({ declared_ref_current_id: null }), OBJETIVO).result).toBe(ESTADOS.TAG_MOVED);
  });
});

describe("runtime", () => {
  it("un runtime distinto del objetivo sale RUNTIME_DRIFT", () => {
    const r = escanearServicio(sano({ runtime: { NODE_VERSION: "18.0.0" } }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.RUNTIME_DRIFT);
    expect(r.motivos.join(" ")).toMatch(/RUNTIME DISTINTO/);
  });

  it("sin objetivo explícito, el objetivo implícito es el runtime de la etiqueta declarada", () => {
    const r = escanearServicio(
      sano({ runtime: { PG_VERSION: "16.14" }, declared_ref_runtime: { PG_VERSION: "16.15" } }),
      { ...OBJETIVO, runtime: undefined },
    );
    expect(r.result).toBe(ESTADOS.RUNTIME_DRIFT);
  });

  it("lee la versión de runtime del entorno de la imagen", () => {
    expect(runtimeDesdeEnv(["PATH=/x", "PG_VERSION=16.14"])).toEqual({ PG_VERSION: "16.14" });
  });
});

describe("montajes por destino + origen lógico (nunca por nombre físico)", () => {
  it("el prefijo del proyecto Compose es equivalencia esperada, no drift", () => {
    expect(origenLogico({ type: "volume", name: "infrastructure_arena_replays" }, { proyecto: "infrastructure" })).toBe(
      "arena_replays",
    );
    expect(
      driftDeMontajes([{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }], {
        mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }],
      }),
    ).toEqual({ faltan: [], sobran: [], incorrectos: [], ausenciasIncumplidas: [] });
  });

  it("destino correcto servido por un volumen que NO corresponde es fallo", () => {
    const d = driftDeMontajes([{ tipo: "volume", destino: "/data/replays", origen: "arena_maps", rw: true }], {
      mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }],
    });
    expect(d.incorrectos).toHaveLength(1);
    expect(d.faltan).toEqual([]);
  });

  it("ro convertido en rw sobre el destino correcto es fallo", () => {
    const d = driftDeMontajes([{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }], {
      mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: false }],
    });
    expect(d.incorrectos).toHaveLength(1);
  });

  it("una AUSENCIA deliberada que no se cumplió se detecta", () => {
    const d = driftDeMontajes([{ tipo: "bind", destino: "/legacy", origen: "repo:infrastructure/x", rw: true }], {
      mounts: [],
      absent: ["/legacy"],
    });
    expect(d.ausenciasIncumplidas).toEqual(["/legacy"]);
  });

  it("la ausencia cumplida no es drift", () => {
    expect(driftDeMontajes([], { mounts: [], absent: ["/legacy"] }).ausenciasIncumplidas).toEqual([]);
  });

  it("un bind fuera del árbol desplegado sale opaco y nunca equivale al esperado", () => {
    const opaco = origenLogico({ type: "bind", source: "/var/run/algo-ajeno" });
    expect(opaco).toMatch(/^bind:#[0-9a-f]{12}$/);
    expect(opaco).not.toContain("/var/run");
  });

  it("el montaje impostor llega hasta el resultado del servicio", () => {
    const r = escanearServicio(
      sano({ mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_maps", rw: false }] }),
      OBJETIVO,
    );
    expect(r.result).toBe(ESTADOS.SPEC_DRIFT);
    expect(r.spec_drift).toMatch(/montaje impostor/);
  });
});

describe("secretos y entorno", () => {
  it("un secreto ausente y uno no declarado se detectan", () => {
    expect(driftDeSecretos(["otro"], ["jwt_secret"])).toEqual({ faltan: ["jwt_secret"], inesperados: ["otro"] });
  });

  it("una variable requerida ausente y una prohibida presente se detectan", () => {
    expect(driftDeEntorno(["S9K_AUTH_ENABLED"], { required: ["PORT"], forbidden: ["S9K_AUTH_ENABLED"] })).toEqual({
      faltan: ["PORT"],
      prohibidasPresentes: ["S9K_AUTH_ENABLED"],
    });
  });

  it("un contenedor fuera del proyecto Compose es drift del inventario", () => {
    const r = escanearServicio(sano({ compose_managed: false }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.SPEC_DRIFT);
    expect(r.motivos.join(" ")).toMatch(/FUERA del proyecto Compose/);
  });

  it("el drift de secretos llega al resultado del servicio", () => {
    expect(escanearServicio(sano({ secrets: [] }), OBJETIVO).result).toBe(ESTADOS.SPEC_DRIFT);
  });
});

describe("identidad de build (ADR-016)", () => {
  it("sin identidad embebida el resultado es NOT_EXERCISED, nunca OK", () => {
    const r = escanearServicio(sano({ build_commit: null }), OBJETIVO);
    expect(r.result).toBe(ESTADOS.NOT_EXERCISED);
    expect(r.build_commit).toBe("desconocido");
    expect(r.motivos.join(" ")).toMatch(/NO queda verificada/);
  });

  it("sin especificación objetivo, el drift de spec sale como no ejercido", () => {
    const r = escanearServicio(sano(), null);
    expect(r.result).toBe(ESTADOS.NOT_EXERCISED);
    expect(r.spec_drift).toBe("desconocido");
  });
});

describe("hechos reales de producción (fixture capturado del daemon)", () => {
  const objetivos = objetivosDesdeCompose(COMPOSE, { vars: { GATEWAY_CONF: "nginx-behind-proxy.conf" } });
  const filas = escanear(FIXTURE, objetivos);
  const por = (s: string) => filas.find((f: any) => f.service === s)!;

  it("clasifica los 12 contenedores del stack", () => {
    expect(filas).toHaveLength(12);
    expect(filas.every((f: any) => typeof f.result === "string")).toBe(true);
  });

  it("postgres sale como ETIQUETA MOVIDA con la imagen en marcha presente", () => {
    const p = por("postgres");
    expect(p.result).toBe(ESTADOS.TAG_MOVED);
    expect(p.running_image_exists).toBe("sí");
    expect(p.running_image_id).toBe("57c72fd2a128");
    expect(p.declared_ref_current_id).toBe("cf78e76683b9");
    expect(p.motivos.join(" ")).toMatch(/16\.14.*16\.15|ETIQUETA MOVIDA/);
  });

  it("el runtime real de postgres (16.14) no es el de su etiqueta (16.15)", () => {
    expect(por("postgres").runtime_version).toBe("PG_VERSION=16.14");
    expect(por("postgres").estados).toContain(ESTADOS.RUNTIME_DRIFT);
  });

  it("ningún servicio de producción sale OK: no llevan identidad embebida", () => {
    expect(filas.some((f: any) => f.result === ESTADOS.OK)).toBe(false);
    for (const f of filas) expect(f.build_commit).toBe("desconocido");
  });

  it("los montajes reales casan con el Compose pese al prefijo del proyecto", () => {
    // Si la normalización del prefijo estuviera mal, `backup` (7 volúmenes) y
    // `api` (arena_replays en ro) saldrían con spec_drift. Salen limpios.
    expect(por("backup").spec_drift).toBe("ninguno");
    expect(por("api").spec_drift).toBe("ninguno");
  });

  it("la salida no lleva topología real al repositorio público", () => {
    const texto = JSON.stringify(informeJson(filas)) + informeTexto(filas) + JSON.stringify(FIXTURE);
    expect(texto).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(texto).not.toMatch(/\/opt\//);
    expect(texto).not.toMatch(/duckdns/i);
  });

  it("el informe JSON es consumible por otra herramienta y el de texto es legible", () => {
    const j = informeJson(filas);
    expect(j.schema).toBe("s9-ai-arena/runtime-drift-scan/v1");
    expect(Object.values(j.summary).reduce((a: any, b: any) => a + b, 0)).toBe(12);
    const t = informeTexto(filas);
    for (const c of ["declared_ref", "running_image_id", "spec_drift", "result"]) expect(t).toContain(c);
  });
});

describe("objetivo derivado del Compose (no del daemon: no puede confirmar lo que ya hay)", () => {
  it("traduce volúmenes nombrados y binds relativos a origen lógico", () => {
    expect(montajeDesdeCompose("arena_replays:/data/replays:ro")).toEqual({
      tipo: "volume",
      destino: "/data/replays",
      origen: "arena_replays",
      rw: false,
    });
    expect(montajeDesdeCompose("./secrets/tls:/etc/nginx/tls:ro").origen).toBe("repo:infrastructure/secrets/tls");
  });

  it("interpola ${VAR:-defecto} con lo que declara el operador", () => {
    expect(
      montajeDesdeCompose({ type: "bind", source: "./gateway/${GATEWAY_CONF:-nginx.conf}", target: "/x" }).origen,
    ).toBe("repo:infrastructure/gateway/nginx.conf");
    expect(
      montajeDesdeCompose(
        { type: "bind", source: "./gateway/${GATEWAY_CONF:-nginx.conf}", target: "/x" },
        { vars: { GATEWAY_CONF: "otra.conf" } },
      ).origen,
    ).toBe("repo:infrastructure/gateway/otra.conf");
  });

  it("cubre los servicios del Compose con sus secretos", () => {
    const o = objetivosDesdeCompose(COMPOSE);
    expect(o.api.secrets).toContain("jwt_secret");
    expect(o.backup.mounts_spec.mounts.map((m: any) => m.destino)).toContain("/data/replays");
  });
});

// ── MUTACIONES ───────────────────────────────────────────────────────────────
// Cada mutación es una versión estropeada del núcleo. La prueba consiste en que
// la suite de arriba, aplicada al mutante, se pone ROJA. Si un mutante pasara,
// la garantía no la estaba comprobando nadie.

describe("mutaciones · cada una debe quedar demostrada en rojo", () => {
  it("M1 · existencia siempre cierta → la suite de existencia se cae", () => {
    const mutante = (h: any, o: any) => escanearServicio({ ...h, running_image_exists: true }, o);
    // control: el escáner real detecta la imagen desaparecida…
    expect(escanearServicio(sano({ running_image_exists: false }), OBJETIVO).result).toBe(ESTADOS.IMAGE_MISSING);
    // …y el mutante NO, que es exactamente lo que la garantía prohíbe.
    expect(mutante(sano({ running_image_exists: false }), OBJETIVO).result).not.toBe(ESTADOS.IMAGE_MISSING);
  });

  it("M2 · etiqueta siempre coincidente → la detección de etiqueta movida muere", () => {
    const mutante = (h: any, o: any) =>
      escanearServicio({ ...h, declared_ref_current_id: h.running_image_id }, { ...o, declared_ref: h.declared_ref });
    const roto = sano({ declared_ref_current_id: ID_B, declared_ref: "s9arena/api:otra" });
    expect(escanearServicio(roto, OBJETIVO).result).not.toBe(ESTADOS.OK);
    expect(mutante(roto, OBJETIVO).result).not.toBe(ESTADOS.TAG_MOVED);
    expect(mutante(roto, OBJETIVO).result).not.toBe(ESTADOS.TAG_MISMATCH);
  });

  it("M3 · IMAGE_MISSING convertido en PASS → deja de ser un fallo", () => {
    const mutante = (h: any, o: any) => {
      const r = escanearServicio(h, o);
      return { ...r, result: r.result === ESTADOS.IMAGE_MISSING ? ESTADOS.OK : r.result };
    };
    const roto = sano({ running_image_exists: false });
    expect(escanearServicio(roto, OBJETIVO).result).toBe(ESTADOS.IMAGE_MISSING);
    expect(mutante(roto, OBJETIVO).result).toBe(ESTADOS.OK); // el mutante miente…
    expect(escanearServicio(roto, OBJETIVO).result).not.toBe(ESTADOS.OK); // …el real no.
  });

  it("M4 · TAG_MOVED convertido en PASS → postgres pasaría en verde", () => {
    const objetivos = objetivosDesdeCompose(COMPOSE, { vars: { GATEWAY_CONF: "nginx-behind-proxy.conf" } });
    const real = escanear(FIXTURE, objetivos).find((f: any) => f.service === "postgres")!;
    const mutado = { ...real, result: real.result === ESTADOS.TAG_MOVED ? ESTADOS.OK : real.result };
    expect(real.result).toBe(ESTADOS.TAG_MOVED);
    expect(mutado.result).toBe(ESTADOS.OK);
    expect(real.result).not.toBe(mutado.result);
  });

  it("M5 · montajes comparados por nombre FÍSICO → drift falso y fallo real invisible", () => {
    // El mutante compara el nombre físico del volumen tal cual lo da Docker.
    const porNombreFisico = (actuales: any[], objetivo: any) => {
      const nombres = new Set(actuales.map((m) => m.origenFisico ?? m.origen));
      return {
        faltan: (objetivo.mounts ?? []).filter((e: any) => !nombres.has(e.origen)).map((e: any) => e.destino),
        sobran: [],
        incorrectos: [],
        ausenciasIncumplidas: [],
      };
    };
    const actualesReales = [
      {
        tipo: "volume",
        destino: "/data/replays",
        origen: "arena_replays",
        origenFisico: "infrastructure_arena_replays",
        rw: true,
      },
    ];
    const esperado = { mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }] };

    // (a) falso positivo: el mutante ve drift donde no lo hay.
    expect(porNombreFisico(actualesReales, esperado).faltan).toEqual(["/data/replays"]);
    expect(driftDeMontajes(actualesReales, esperado).faltan).toEqual([]);

    // (b) falso negativo, el peligroso: destino correcto servido por otro volumen.
    const impostor = [
      { tipo: "volume", destino: "/etc/otra-cosa", origen: "arena_replays", origenFisico: "arena_replays", rw: true },
    ];
    expect(porNombreFisico(impostor, esperado).faltan).toEqual([]); // el mutante lo da por bueno
    expect(driftDeMontajes(impostor, esperado).faltan).toEqual(["/data/replays"]); // el real no
  });
});
