/**
 * ADR-017 · Contrato de release: calibración del gate.
 *
 * Esta suite no comprueba que el código compile. Comprueba que CADA regla del
 * contrato SABE PONERSE ROJA ante el incidente que la motivó, y que no se pone
 * roja ante el caso legítimo. Una regla que solo se ha visto en verde no es
 * evidencia de nada: fue exactamente un gate tautológico el que dejó pasar
 * cuatro servicios construidos del árbol viejo.
 *
 * Cada `describe` empieza nombrando el incidente real que lo justifica.
 */
import { describe, expect, it } from "vitest";
import {
  NO_SON_EVIDENCIA,
  PREGUNTAS,
  acotarAlProyecto,
  clasificarCambioDeSpec,
  composeCanonicoUnico,
  comprobarInvarianteDeAmbito,
  contarConclusiones,
  evidenciaSuficiente,
  humoPermitido,
  revisarClon,
  revisarInvocacion,
  seguroParaShred,
  // @ts-expect-error — script .mjs sin tipos, se consume desde tests y CI.
} from "../scripts/release-gate.mjs";

const VIEJO = "98f381ec";
const NUEVO = "4d469dc";

// ─────────────────────────────────────────────────────────────────────────────
describe("BUILD y DEPLOY son fases distintas · incidente del árbol viejo etiquetado como nuevo", () => {
  it("MUTACIÓN · un DEPLOY sin --no-build se rechaza, y el motivo nombra el mecanismo", () => {
    // Es la invocación literal del incidente: project-directory de producción
    // sobre un compose cuyo `build.context: ..` resuelve contra ese directorio.
    const fallos: string[] = revisarInvocacion("deploy", [
      "docker",
      "compose",
      "-f",
      "/tmp/arbol-nuevo/infrastructure/docker-compose.yml",
      "--project-directory",
      "/opt/s9-ai-arena/infrastructure",
      "up",
      "-d",
    ]);
    expect(fallos.length).toBeGreaterThan(0);
    expect(fallos.join("\n")).toContain("--no-build");
    expect(fallos.join("\n")).toContain("build.context");
  });

  it("el DEPLOY correcto (project-directory de producción + --no-build) pasa", () => {
    // --project-directory NO se quita: hace falta para que los ficheros de
    // secretos y las rutas relativas resuelvan. Lo que se prohíbe es construir.
    const fallos: string[] = revisarInvocacion("deploy", [
      "docker",
      "compose",
      "-f",
      "/opt/s9-ai-arena/infrastructure/docker-compose.yml",
      "--project-directory",
      "/opt/s9-ai-arena/infrastructure",
      "up",
      "-d",
      "--no-build",
    ]);
    expect(fallos).toEqual([]);
  });

  it("un DEPLOY con --build se rechaza aunque también lleve --no-build mal puesto", () => {
    const fallos: string[] = revisarInvocacion("deploy", [
      "docker",
      "compose",
      "--project-directory",
      "/opt/app",
      "up",
      "-d",
      "--build",
      "--no-build",
    ]);
    expect(fallos.join("\n")).toContain("fase BUILD");
  });

  it("un DEPLOY sin --project-directory también se rechaza (los secretos no resolverían)", () => {
    const fallos: string[] = revisarInvocacion("deploy", ["docker", "compose", "up", "-d", "--no-build"]);
    expect(fallos.join("\n")).toContain("secretos");
  });

  it("MUTACIÓN · BUILD cuyo --project-directory NO es el árbol que dice construir", () => {
    // Reproducción exacta: se cree construir /tmp/arbol-nuevo y el contexto
    // sale de /opt/s9-ai-arena/infrastructure.
    const fallos: string[] = revisarInvocacion(
      "build",
      ["BUILD_COMMIT=" + NUEVO, "docker", "compose", "--project-directory", "/opt/s9-ai-arena/infrastructure", "build"],
      { arbolFuente: "/tmp/arbol-nuevo" },
    );
    expect(fallos.length).toBeGreaterThan(0);
    expect(fallos.join("\n")).toContain("árbol viejo");
  });

  it("el BUILD coherente (project-directory = árbol fuente, con BUILD_COMMIT) pasa", () => {
    const fallos: string[] = revisarInvocacion(
      "build",
      ["BUILD_COMMIT=" + NUEVO, "docker", "compose", "--project-directory", "/tmp/arbol-nuevo", "build"],
      { arbolFuente: "/tmp/arbol-nuevo" },
    );
    expect(fallos).toEqual([]);
  });

  it("MUTACIÓN · BUILD sin BUILD_COMMIT: la imagen quedaría 'unknown' y nada podría verificarse", () => {
    const fallos: string[] = revisarInvocacion("build", ["docker", "compose", "build"]);
    expect(fallos.join("\n")).toContain("BUILD_COMMIT");
  });

  it("MUTACIÓN · construir y desplegar en el mismo comando se rechaza", () => {
    const fallos: string[] = revisarInvocacion("build", ["BUILD_COMMIT=x", "docker", "compose", "up", "--build", "-d"]);
    expect(fallos.join("\n")).toContain("verificar el CONTENIDO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Evidencia · qué código, qué imagen, qué SPEC, qué runtime", () => {
  const completa = {
    codigo: { fuente: "git rev-parse HEAD en el árbol construido", valor: NUEVO },
    imagen: { fuente: "org.opencontainers.image.revision", valor: NUEVO },
    spec: { fuente: "docker compose config (hash)", valor: "sha256:aaa" },
    runtime: { fuente: "GET /version del contenedor en marcha", valor: NUEVO },
  };

  it("las cuatro preguntas respondidas con fuente admisible: conforme", () => {
    expect(evidenciaSuficiente(completa)).toEqual([]);
  });

  for (const pregunta of PREGUNTAS as string[]) {
    it(`MUTACIÓN · si falta "${pregunta}" el despliegue no es afirmable (fail-closed)`, () => {
      const parcial: Record<string, unknown> = { ...completa };
      delete parcial[pregunta];
      const fallos: string[] = evidenciaSuficiente(parcial);
      expect(fallos.join("\n")).toContain(pregunta);
    });
  }

  it("MUTACIÓN · una respuesta con valor vacío tampoco cuenta", () => {
    const fallos: string[] = evidenciaSuficiente({ ...completa, runtime: { fuente: "/version", valor: "   " } });
    expect(fallos.join("\n")).toContain("runtime");
  });

  for (const fuente of ["etiqueta", "compose-rc0", "healthy"]) {
    it(`MUTACIÓN · "${fuente}" como evidencia ÚNICA se rechaza`, () => {
      const fallos: string[] = evidenciaSuficiente({ ...completa, imagen: { fuente, valor: "algo" } });
      expect(fallos.length).toBeGreaterThan(0);
      expect(fallos.join("\n")).toContain(fuente);
    });
  }

  it("las tres señales prohibidas están declaradas, no dispersas por el código", () => {
    for (const s of ["etiqueta", "compose-rc0", "healthy"]) expect(NO_SON_EVIDENCIA.has(s)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("El gate no puede contradecirse · incidente del 'intercambio puro' bajo un cambio de montajes", () => {
  it("MUTACIÓN · con montajes distintos NUNCA se clasifica como intercambio puro", () => {
    const r = clasificarCambioDeSpec(
      { image: "s9arena/api:" + VIEJO, mounts: ["/data:/data"] },
      { image: "s9arena/api:" + NUEVO, mounts: ["/data2:/data"] },
    );
    expect(r.clase).toBe("cambio-de-spec");
    expect(r.camposCambiados).toEqual(["image", "mounts"]);
    // La invariante estructural: el resumen se DERIVA del conjunto de campos.
    expect(r.resumen).toContain("mounts");
    expect(r.resumen).toContain("NO es un intercambio de imagen puro");
  });

  it("invariante · la etiqueta y el conjunto de campos jamás pueden desmentirse", () => {
    // Se recorre un abanico de specs: si alguna vez saliera "puro" con más de
    // un campo cambiado, o "cambio-de-spec" con solo `image`, sería el defecto.
    const campos = ["image", "mounts", "env", "networks", "command", "user"];
    for (const c of campos) {
      const antes: Record<string, string> = {
        image: "a",
        mounts: "m",
        env: "e",
        networks: "n",
        command: "c",
        user: "u",
      };
      const despues = { ...antes, [c]: "OTRO" };
      const r = clasificarCambioDeSpec(antes, despues);
      expect(r.camposCambiados).toEqual([c]);
      expect(r.clase).toBe(c === "image" ? "intercambio-de-imagen-puro" : "cambio-de-spec");
      if (r.clase !== "intercambio-de-imagen-puro") expect(r.resumen).not.toContain("intercambio de imagen puro (");
    }
  });

  it("solo la imagen distinta sí es un intercambio puro", () => {
    const r = clasificarCambioDeSpec({ image: "a", mounts: ["x"] }, { image: "b", mounts: ["x"] });
    expect(r.clase).toBe("intercambio-de-imagen-puro");
  });

  it("sin diferencias, sin cambio", () => {
    expect(clasificarCambioDeSpec({ image: "a" }, { image: "a" }).clase).toBe("sin-cambio");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Ámbito · el invariante es del stack, no del host compartido", () => {
  // Inventario tomado de VM108: 12 contenedores del proyecto "infrastructure"
  // conviviendo con un contenedor efímero de OTRO carril, sin proyecto Compose.
  const host = [
    { nombre: "infrastructure-api-1", proyecto: "infrastructure" },
    { nombre: "infrastructure-gateway-1", proyecto: "infrastructure" },
    { nombre: "infrastructure-postgres-1", proyecto: "infrastructure" },
    { nombre: "efimero-de-otro-carril", proyecto: "" },
  ];

  it("MUTACIÓN · un contenedor efímero ajeno NO puede romper el invariante del stack", () => {
    // El incidente: la medida era del HOST, así que el efímero de otro carril
    // "sobraba" y el invariante daba fallo espurio. Acotado, ni falta ni sobra.
    expect(comprobarInvarianteDeAmbito(host, "infrastructure", ["api", "gateway", "postgres"])).toEqual([]);
    // Y el ajeno sigue siendo visible, no se pierde: se clasifica.
    expect(acotarAlProyecto(host, "infrastructure").ajenos.map((c: { nombre: string }) => c.nombre)).toEqual([
      "efimero-de-otro-carril",
    ]);
  });

  it("un contenedor de más DENTRO del proyecto SÍ rompe el invariante (el otro lado de la regla)", () => {
    const fallos: string[] = comprobarInvarianteDeAmbito(
      [...host, { nombre: "infrastructure-colado-1", proyecto: "infrastructure" }],
      "infrastructure",
      ["api", "gateway", "postgres"],
    );
    expect(fallos.join("\n")).toContain("infrastructure-colado-1");
    expect(fallos.join("\n")).toContain("sobran");
  });

  it("MUTACIÓN · medir sin declarar el proyecto se rechaza (sería medir el host)", () => {
    const fallos: string[] = comprobarInvarianteDeAmbito(host, "", ["api"]);
    expect(fallos.join("\n")).toContain("HOST");
  });

  it("un servicio del stack que falta de verdad SÍ rompe el invariante", () => {
    const fallos: string[] = comprobarInvarianteDeAmbito(host, "infrastructure", ["api", "replay-service"]);
    expect(fallos.join("\n")).toContain("replay-service");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Un solo compose canónico · hallazgo de VM108 (tres orígenes para el mismo stack)", () => {
  it("MUTACIÓN · tres config_files distintos en el mismo proyecto se rechazan", () => {
    const fallos: string[] = composeCanonicoUnico([
      { nombre: "api", configFiles: "/tmp/build-4d469dc/infrastructure/docker-compose.yml" },
      { nombre: "backup", configFiles: "/tmp/deploy-11b36a7/infrastructure/docker-compose.yml" },
      { nombre: "postgres", configFiles: "/opt/s9-ai-arena/infrastructure/docker-compose.yml" },
    ]);
    expect(fallos.length).toBe(1);
    expect(fallos[0]).toContain("3 ficheros compose distintos");
  });

  it("un único origen es conforme", () => {
    const uno = "/opt/s9-ai-arena/infrastructure/docker-compose.yml";
    expect(
      composeCanonicoUnico([
        { nombre: "api", configFiles: uno },
        { nombre: "postgres", configFiles: uno },
      ]),
    ).toEqual([]);
  });

  it("MUTACIÓN · un contenedor sin config_files es origen desconocido, no 'igual que el resto'", () => {
    const fallos: string[] = composeCanonicoUnico([{ nombre: "api", configFiles: "" }]);
    expect(fallos.join("\n")).toContain("origen desconocido");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Humo · nada destructivo contra producción (la sonda de retención borró replays reales)", () => {
  const destructivos = [
    "curl -XDELETE https://…/replays/sweep",
    "restic forget --prune --keep-last 1",
    "psql -c 'TRUNCATE audit_log'",
    "docker system prune -af",
    "rm -rf /var/lib/arena/replays",
  ];

  for (const comando of destructivos) {
    it(`MUTACIÓN · "${comando.slice(0, 32)}…" contra producción se rechaza`, () => {
      const fallos: string[] = humoPermitido({ nombre: "humo", comando, entorno: "produccion" });
      expect(fallos.length).toBe(1);
      expect(fallos[0]).toContain("fixture aislado");
    });

    it(`el MISMO paso en fixture aislado se acepta: "${comando.slice(0, 32)}…"`, () => {
      expect(humoPermitido({ nombre: "humo", comando, entorno: "fixture" })).toEqual([]);
    });
  }

  it("el humo real de producción (lecturas) pasa", () => {
    for (const p of ["/healthz", "/api/healthz", "/", "/replays/healthz"]) {
      expect(humoPermitido({ nombre: p, comando: `curl -fsS https://…${p}`, entorno: "produccion" })).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Entornos temporales · el clon local que vació 384 objetos del repo productivo", () => {
  it("MUTACIÓN · git clone de ruta local sin --no-hardlinks se rechaza", () => {
    const fallos: string[] = revisarClon(["git", "clone", "/opt/s9-ai-arena", "/tmp/trabajo"]);
    expect(fallos.length).toBe(1);
    expect(fallos[0]).toContain("--no-hardlinks");
    expect(fallos[0]).toContain("384");
  });

  it("con --no-hardlinks el clon local se acepta", () => {
    expect(revisarClon(["git", "clone", "--no-hardlinks", "/opt/s9-ai-arena", "/tmp/trabajo"])).toEqual([]);
  });

  it("el remoto (la vía preferida) se acepta en sus tres formas", () => {
    expect(revisarClon(["git", "clone", "https://github.com/pjclavero/s9-ai-arena.git", "/tmp/x"])).toEqual([]);
    expect(revisarClon(["git", "clone", "git@github.com:pjclavero/s9-ai-arena.git", "/tmp/x"])).toEqual([]);
    expect(revisarClon(["git", "clone", "ssh://git@github.com/pjclavero/s9-ai-arena.git", "/tmp/x"])).toEqual([]);
  });

  it("MUTACIÓN · shred sobre un fichero con más de un enlace duro ABORTA", () => {
    const fallos: string[] = seguroParaShred("6293142 2 /tmp/secreto.env");
    expect(fallos.length).toBe(1);
    expect(fallos[0]).toContain("ABORTAR");
  });

  it("shred sobre un inodo con un solo nombre se permite (secreto aislado)", () => {
    expect(seguroParaShred("6293142 1 /tmp/secreto.env")).toEqual([]);
  });

  it("MUTACIÓN · si no se pudo leer el contador de enlaces, se aborta (fail-closed)", () => {
    const fallos: string[] = seguroParaShred("stat: no such file");
    expect(fallos.join("\n")).toContain("ABORTAR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CI · se cuentan las conclusiones de TODOS los checks, no el final de un --watch", () => {
  it("todos success: verde", () => {
    const r = contarConclusiones([
      { name: "unit", conclusion: "success" },
      { name: "image-provenance", conclusion: "success" },
    ]);
    expect(r.verde).toBe(true);
    expect(r.conteo.success).toBe(2);
  });

  for (const conclusion of ["skipped", "neutral", "not_exercised", "stale", "action_required"]) {
    it(`MUTACIÓN · "${conclusion}" NO es éxito`, () => {
      const r = contarConclusiones([
        { name: "unit", conclusion: "success" },
        { name: "image-provenance", conclusion },
      ]);
      expect(r.verde).toBe(false);
      expect(r.conteo.no_exito).toBe(1);
      expect(r.motivos.join("\n")).toContain("image-provenance");
    });
  }

  it("MUTACIÓN · un check todavía en marcha no es verde (es lo que oculta el final de un --watch)", () => {
    const r = contarConclusiones([
      { name: "unit", conclusion: "success" },
      { name: "scan", status: "in_progress", conclusion: null },
    ]);
    expect(r.verde).toBe(false);
    expect(r.conteo.pendientes).toBe(1);
  });

  it("MUTACIÓN · un recuento vacío no es verde (fail-closed: no se leyó nada)", () => {
    expect(contarConclusiones([]).verde).toBe(false);
    expect(contarConclusiones(undefined).verde).toBe(false);
  });

  it("failure, cancelled y timed_out se cuentan como fallo", () => {
    for (const c of ["failure", "cancelled", "timed_out"]) {
      const r = contarConclusiones([{ name: "unit", conclusion: c }]);
      expect(r.verde).toBe(false);
      expect(r.conteo.failure).toBe(1);
    }
  });
});
