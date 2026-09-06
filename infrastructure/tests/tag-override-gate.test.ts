// OVERRIDE SELECTIVO POR SERVICIO · suite del gate (#143).
//
// Cada garantía con control POSITIVO y NEGATIVO, y todo POR EFECTO del render:
// nunca leyendo del YAML que pone `${API_TAG:-${TAG:-latest}}`. La razón no es
// de estilo — es el defecto que este carril tuvo que arreglar: la interpolación
// del repositorio era de una sola pasada y sobre un defecto ANIDADO devolvía la
// cadena literal `${TAG:-latest}` como si fuera una etiqueta. Un gate que
// comparase nombres habría estado verde mientras Compose desplegaba otra cosa.
//
// La calibración contra la autoridad real (`docker compose config`, v5.3.0 en
// el anfitrión de despliegue) vive en `CASOS_CALIBRACION` y se ejerce aquí.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import {
  CODIGOS,
  compararRenders,
  etiquetaDe,
  gateRecreacion,
  informe,
  invocacion,
  overridesConEfecto,
  renderizarSpecs,
  varsBaseline,
  varsEfectivas,
  verificar,
  verificarAislamiento,
  verificarObjetivo,
  verificarPatron,
  verificarSeparacion,
  verificarVisibilidad,
} from "../scripts/tag-override-gate.mjs";
// @ts-expect-error módulo .mjs sin tipos
import { CASOS_CALIBRACION, interpolar, interpolarProfundo } from "../scripts/lib/interpolar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contrato = JSON.parse(readFileSync(join(here, "..", "deploy-contract.json"), "utf8"));
const doc = parse(readFileSync(join(here, "..", "docker-compose.yml"), "utf8"), { merge: true });

const clon = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("interpolación anidada · calibrada contra `docker compose config`", () => {
  for (const c of CASOS_CALIBRACION) {
    it(`${c.texto} con ${JSON.stringify(c.vars)} → ${c.esperado}`, () => {
      expect(interpolar(c.texto, c.vars)).toBe(c.esperado);
    });
  }

  // El defecto EXACTO que tenía el repositorio, como test de regresión: si
  // alguien reintrodujera la regex de una sola pasada, esto se pone rojo.
  it("NO deja llaves sin resolver en un defecto anidado (la regresión de la regex de una pasada)", () => {
    const r = interpolar("s9arena/api:${API_TAG:-${TAG:-latest}}", { TAG: "4d469dc" });
    expect(r).not.toContain("${");
    expect(r).toBe("s9arena/api:4d469dc");
  });

  it("la interpolación PROFUNDA alcanza a toda la spec, no sólo a `image`", () => {
    const r = interpolarProfundo({ a: "${X}", b: ["${X}", { c: "${X}" }], n: 7 }, { X: "v" });
    expect(r).toEqual({ a: "v", b: ["v", { c: "v" }], n: 7 });
  });
});

describe("el compose real · el patrón está en TODOS los servicios de aplicación", () => {
  const mapa: Record<string, string> = contrato.overrides_de_version.variables_por_servicio;

  it("los servicios declarados son exactamente los de aplicación del contrato (sin postgres ni queue)", () => {
    // postgres y queue están anclados POR DIGEST: no llevan etiqueta que mover,
    // y darles una variable de override sería ofrecer una palanca que rompería
    // el anclaje. Que no estén es una decisión, y aquí se afirma como tal.
    const esperados = contrato.servicios_esperados.filter((s: string) => !["postgres", "queue"].includes(s)).sort();
    expect(Object.keys(mapa).sort()).toEqual(esperados);
  });

  it("`bot-manager` y `bot-build-worker` COMPARTEN variable (son dos roles del mismo artefacto)", () => {
    expect(mapa["bot-build-worker"]).toBe(mapa["bot-manager"]);
    // Y está DECLARADO como compartido: sin la declaración, el gate de
    // aislamiento trataría el arrastre como un defecto, que es lo correcto.
    expect(contrato.overrides_de_version.variables_compartidas[mapa["bot-manager"]]).toBeTruthy();
    // La misma imagen para los dos: si divergieran, dos etiquetas para un
    // artefacto.
    expect(contrato.imagenes_esperadas["bot-build-worker"]).toBe(contrato.imagenes_esperadas["bot-manager"]);
  });

  it("G1 · el compose real pasa el patrón uniforme", () => {
    expect(verificarPatron(contrato, doc).fallos).toEqual([]);
  });

  it("G1 NEGATIVO · un servicio cableado a ${TAG} (sin su variable) se caza", () => {
    const d = clon(doc);
    d.services.api.image = "s9arena/api:${TAG:-latest}";
    const f = verificarPatron(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.NO_OBEDECE_A_SU_VARIABLE);
  });

  it("G1 NEGATIVO · un servicio que deja de seguir a TAG (unificado hacia `backup`) se caza", () => {
    const d = clon(doc);
    d.services.api.image = "s9arena/api:${API_TAG:-latest}";
    const f = verificarPatron(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.NO_SIGUE_A_TAG);
  });
});

describe("G2/G3 · el override es SELECTIVO y sólo toca la imagen", () => {
  it("POSITIVO · el compose real aísla", () => {
    expect(verificarAislamiento(contrato, doc).fallos).toEqual([]);
  });

  it("NEGATIVO · un override que arrastra a otro servicio", () => {
    const d = clon(doc);
    d.services.api.image = "s9arena/api:${TOURNAMENT_WORKER_TAG:-${TAG:-latest}}";
    const f = verificarAislamiento(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.ARRASTRA_A_OTRO_SERVICIO);
  });

  it("NEGATIVO · un override que se cuela en algo que NO es la imagen", () => {
    const d = clon(doc);
    d.services.api.environment = { ...(d.services.api.environment ?? {}), X: "${API_TAG:-nada}" };
    const f = verificarAislamiento(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.CAMBIA_SPEC_NO_IMAGEN);
  });

  it("comparar por EFECTO no es comparar por nombre: el YAML crudo lleva llaves y el render no", () => {
    const crudo = Object.values(doc.services).map((s: any) => s.image);
    expect(crudo.some((s: any) => String(s).includes("${"))).toBe(true);
    const render = renderizarSpecs(doc, { perfiles: contrato.perfiles, vars: varsEfectivas(contrato) });
    for (const s of Object.values(render) as any[]) expect(String(s.imagen)).not.toContain("${");
  });
});

describe("G4 · el override es VISIBLE, nunca estado invisible", () => {
  it("POSITIVO · el override activo del contrato tiene efecto y está declarado", () => {
    expect(verificarVisibilidad(contrato, doc).fallos).toEqual([]);
    const { overrides } = overridesConEfecto(contrato, doc);
    expect(Object.keys(overrides)).toEqual(["tournament-worker"]);
    expect(overrides["tournament-worker"].tag).toBe("82c74a8");
  });

  it("NEGATIVO · un override con efecto y sin declarar («el .env dice X pero el runtime es otra cosa»)", () => {
    const c = clon(contrato);
    c.entorno.API_TAG = "sorpresa";
    c.imagenes_esperadas.api = "s9arena/api:sorpresa";
    const f = verificarVisibilidad(c, doc).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.OVERRIDE_NO_DECLARADO);
  });

  it("NEGATIVO · un override declarado que NO tiene efecto (declaración muerta)", () => {
    const c = clon(contrato);
    c.overrides_de_version.activos.api = { variable: "API_TAG", tag: "loquesea" };
    const f = verificarVisibilidad(c, doc).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.OVERRIDE_DECLARADO_SIN_EFECTO);
  });

  it("NEGATIVO · declarado con una etiqueta y desplegando otra", () => {
    const c = clon(contrato);
    c.overrides_de_version.activos["tournament-worker"].tag = "otra";
    const f = verificarVisibilidad(c, doc).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.OVERRIDE_TAG_DISTINTO);
  });

  it("el informe imprime GLOBAL TAG, OVERRIDES y EFFECTIVE con la forma pedida", () => {
    const txt: string = informe(contrato, doc);
    expect(txt).toMatch(/^GLOBAL TAG\s+4d469dc$/m);
    expect(txt).toMatch(/^OVERRIDES:$/m);
    expect(txt).toMatch(/^ {2}tournament-worker\s+82c74a8$/m);
    expect(txt).toMatch(/^EFFECTIVE:$/m);
    // EFFECTIVE lista TODOS, no sólo las excepciones: un listado de excepciones
    // obligaría a deducir el resto, y deducir es donde se cuela el estado
    // invisible.
    for (const s of Object.keys(contrato.overrides_de_version.variables_por_servicio)) {
      expect(txt).toMatch(new RegExp(`^ {2}${s}\\s+\\S+$`, "m"));
    }
    expect(txt).toMatch(/^ {2}map-service\s+4d469dc$/m);
  });
});

describe("G5 · la separación con `backup` NO se unifica", () => {
  it("POSITIVO · el compose real mantiene las dos semánticas", () => {
    expect(verificarSeparacion(contrato, doc).fallos).toEqual([]);
  });

  it("mover el TAG global mueve a los de aplicación y NO a `backup` (por efecto)", () => {
    const perfiles = ["production"];
    const base = renderizarSpecs(doc, { perfiles, vars: varsEfectivas(contrato) });
    const cent = renderizarSpecs(doc, { perfiles, vars: { ...varsEfectivas(contrato), TAG: "CENTINELA" } });
    expect(cent.api.imagen).toContain(":CENTINELA");
    expect(cent.backup.imagen).toBe(base.backup.imagen);
  });

  it("NEGATIVO · `backup` anidado como los de aplicación se caza", () => {
    const d = clon(doc);
    d.services.backup.image = "s9arena/backup:${BACKUP_TAG:-${TAG:-latest}}";
    const f = verificarSeparacion(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.BACKUP_SIGUE_A_TAG);
  });

  it("NEGATIVO · la dirección simétrica: BACKUP_TAG arrastrando a un servicio de aplicación", () => {
    const d = clon(doc);
    d.services.api.image = "s9arena/api:${BACKUP_TAG:-${TAG:-latest}}";
    const f = verificarSeparacion(contrato, d).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.BACKUP_TAG_ARRASTRA_APP);
  });
});

describe("G6 · el objetivo declarado es el que sale del render", () => {
  it("POSITIVO", () => {
    expect(verificarObjetivo(contrato, doc).fallos).toEqual([]);
  });

  it("NEGATIVO · el contrato declara una imagen que el render no produce", () => {
    const c = clon(contrato);
    c.imagenes_esperadas.web = "s9arena/web:inventada";
    const f = verificarObjetivo(c, doc).fallos.map((x: any) => x.codigo);
    expect(f).toContain(CODIGOS.IMAGEN_OBJETIVO_DISTINTA);
  });
});

describe("GATE de recreación · el criterio de parada", () => {
  it("con TAG=4d469dc y TOURNAMENT_WORKER_TAG=82c74a8: 1 imagen, 0 specs", () => {
    const g = gateRecreacion(contrato, doc);
    expect(g.diff.changed_images).toBe(1);
    expect(g.diff.imagenes[0].service).toBe("tournament-worker");
    expect(g.diff.imagenes[0].de).toBe("s9arena/tournament-worker:4d469dc");
    expect(g.diff.imagenes[0].a).toBe("s9arena/tournament-worker:82c74a8");
    expect(g.diff.changed_specs_other_than_image).toBe(0);
    expect(g.ok).toBe(true);
  });

  it("STOP si cambia cualquier otro servicio", () => {
    const d = clon(doc);
    d.services.web.image = "s9arena/web:${TOURNAMENT_WORKER_TAG:-${TAG:-latest}}";
    const g = gateRecreacion(contrato, d);
    expect(g.ok).toBe(false);
    expect(g.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.GATE_SERVICIO_INESPERADO);
  });

  it("STOP si cambia algo de la spec que no sea la imagen", () => {
    const d = clon(doc);
    d.services["tournament-worker"].environment = {
      ...(d.services["tournament-worker"].environment ?? {}),
      X: "${TOURNAMENT_WORKER_TAG:-nada}",
    };
    const g = gateRecreacion(contrato, d);
    expect(g.ok).toBe(false);
    expect(g.fallos.map((f: any) => f.codigo)).toContain(CODIGOS.GATE_SPEC_NO_IMAGEN);
  });

  it("el número esperado NO está cableado: sale del contrato", () => {
    // Si mañana se adelanta `bot-manager`, el gate espera DOS imágenes (el
    // trabajador de construcción comparte artefacto) y sigue siendo verde. Un
    // "== 1" cableado habría parado un despliegue correcto o, peor, habría
    // dejado pasar uno con dos overrides contando sólo hasta uno.
    const c = clon(contrato);
    c.entorno.BOT_MANAGER_TAG = "82c74a8";
    c.imagenes_esperadas["bot-manager"] = "s9arena/bot-manager:82c74a8";
    c.imagenes_esperadas["bot-build-worker"] = "s9arena/bot-manager:82c74a8";
    c.overrides_de_version.activos["bot-manager"] = { variable: "BOT_MANAGER_TAG", tag: "82c74a8" };
    const g = gateRecreacion(c, doc);
    expect(g.diff.changed_images).toBe(3);
    expect(g.esperados).toEqual(["bot-build-worker", "bot-manager", "tournament-worker"]);
    expect(g.ok).toBe(true);
  });

  it("un override NO declarado hace fallar el gate por cardinal", () => {
    const c = clon(contrato);
    c.entorno.WEB_TAG = "colada";
    const g = gateRecreacion(c, doc);
    expect(g.ok).toBe(false);
    const cods = g.fallos.map((f: any) => f.codigo);
    expect(cods).toContain(CODIGOS.GATE_SERVICIO_INESPERADO);
    expect(cods).toContain(CODIGOS.GATE_IMAGENES_CAMBIADAS);
  });
});

describe("verificación completa y ausencias", () => {
  it("el repositorio real está VERDE", () => {
    const r = verificar(contrato, doc);
    expect(r.fallos).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("un contrato sin `overrides_de_version` NO se aprueba por omisión", () => {
    const c = clon(contrato);
    delete c.overrides_de_version;
    const r = verificar(c, doc);
    expect(r.ok).toBe(false);
    expect(r.fallos[0].codigo).toBe(CODIGOS.OVERRIDES_NO_DECLARADOS);
  });

  it("varsBaseline retira TODAS las variables de override y varsEfectivas no", () => {
    expect(varsBaseline(contrato).TOURNAMENT_WORKER_TAG).toBeUndefined();
    expect(varsBaseline(contrato).TAG).toBe("4d469dc");
    expect(varsEfectivas(contrato).TOURNAMENT_WORKER_TAG).toBe("82c74a8");
  });

  it("etiquetaDe no confunde el puerto de un registro con una etiqueta", () => {
    expect(etiquetaDe("registro.interno:5000/x/y")).toBe("");
    expect(etiquetaDe("s9arena/api:4d469dc")).toBe("4d469dc");
  });

  it("compararRenders separa los dos ejes y no los colapsa", () => {
    const a = { s: { imagen: "i:1", resto: { x: 1 } } };
    const b = { s: { imagen: "i:2", resto: { x: 1 } } };
    const c = { s: { imagen: "i:1", resto: { x: 2 } } };
    expect(compararRenders(a, b)).toMatchObject({ changed_images: 1, changed_specs_other_than_image: 0 });
    expect(compararRenders(a, c)).toMatchObject({ changed_images: 0, changed_specs_other_than_image: 1 });
  });
});

describe("CLI · la ausencia no es aprobado", () => {
  // Se ejecuta el binario DE VERDAD: el código de salida es lo que la CI mira,
  // y una comprobación en memoria no lo prueba.
  const GATE = join(here, "..", "scripts", "tag-override-gate.mjs");

  it("sin contrato sale con rc=2 (NO COMPROBADO), nunca 0", () => {
    const r = spawnSync(process.execPath, [GATE, "--contrato", "/no/existe.json"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("NO COMPROBADO");
  });

  it("sin compose también sale con rc=2", () => {
    const r = spawnSync(process.execPath, [GATE, "--compose", "/no/existe.yml"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("sobre el repositorio real, `--gate` sale con rc=0 y emite las dos cifras", () => {
    const r = spawnSync(process.execPath, [GATE, "--gate"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("changed_images                  1");
    expect(r.stdout).toContain("changed_specs_other_than_image  0");
  });
});

describe("invocación de recreación", () => {
  const cmd: string = invocacion(contrato, { directorioProyecto: "<directorio-de-despliegue>" });

  it("nombra SÓLO el servicio adelantado", () => {
    expect(cmd.trim().endsWith(" tournament-worker")).toBe(true);
    for (const s of ["api", "web", "gateway", "postgres", "queue", "backup"]) {
      expect(cmd).not.toMatch(new RegExp(`\\s${s}(\\s|$)`));
    }
  });

  it("lleva --no-build y --no-deps (árbol equivocado / postgres NO RESTART)", () => {
    expect(cmd).toContain("--no-build");
    expect(cmd).toContain("--no-deps");
  });

  it("lleva el entorno con TAG y el override, y NO BACKUP_TAG", () => {
    expect(cmd).toContain("TAG=4d469dc");
    expect(cmd).toContain("TOURNAMENT_WORKER_TAG=82c74a8");
    expect(cmd).not.toContain("BACKUP_TAG");
  });

  it("no emite topología real", () => {
    expect(cmd).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });
});
