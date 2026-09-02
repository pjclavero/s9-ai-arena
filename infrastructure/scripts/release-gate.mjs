#!/usr/bin/env node
/**
 * ADR-017 · Gate del contrato de release: separa BUILD de DEPLOY y exige
 * EVIDENCIA, no señales.
 *
 * Este script no comprueba "buenas prácticas". Cada función existe porque un
 * incidente concreto y verificado de este proyecto la habría evitado, y cada
 * una tiene su control negativo en infrastructure/tests/release-gate.test.ts:
 * una garantía que nunca se ha visto roja no es una garantía.
 *
 * Reparto con los carriles hermanos (aquí no se reimplementa nada de ellos):
 *   - la coherencia etiqueta/LABEL//version de UNA imagen es de
 *     infrastructure/scripts/verify-image-provenance.mjs (ADR-016);
 *   - la existencia de la image ID en ejecución, el commit embebido y el estado
 *     de "la etiqueta se movió" son de packages/readiness/probes-docker.ts
 *     (`interpretarVersionDesplegada`, `observarImagen`, PR #125);
 *   - AQUÍ vive lo que nadie más mira: la FASE (build frente a deploy), la
 *     forma de la invocación, el ámbito de los invariantes, la coherencia de la
 *     clasificación del cambio, qué cuenta como evidencia y qué cuenta como CI
 *     verde.
 *
 * Uso:
 *   node infrastructure/scripts/release-gate.mjs --self-test
 *   node infrastructure/scripts/release-gate.mjs --evidencia <fichero.json>
 *   node infrastructure/scripts/release-gate.mjs --invocacion deploy -- docker compose …
 *
 * rc=0 conforme · rc=1 el contrato lo rechaza · rc=2 uso incorrecto.
 */
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// 1. FASE · la invocación de construcción y la de despliegue no son la misma
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Incidente real: se construyó con `docker compose --project-directory <dir de
 * producción>` sobre un compose cuyo `build.context: ..` se resuelve CONTRA ESE
 * DIRECTORIO. Se compiló el árbol viejo (98f381ec) y se etiquetó con el commit
 * nuevo (4d469dc); cuatro servicios "pasaron" el gate desplegando código viejo,
 * porque el gate comparaba "imagen declarada == imagen desplegada", que es una
 * tautología cuando la etiqueta miente.
 *
 * `--project-directory` no controla UNA cosa, controla TRES a la vez:
 *   (a) el contexto de construcción de todo `build.context` relativo,
 *   (b) la resolución de rutas relativas (volúmenes, env_file, confs),
 *   (c) la resolución de los ficheros de secretos.
 * Por eso no basta con "quitarlo para construir y ponerlo para desplegar":
 *   BUILD   project-directory = el ÁRBOL FUENTE que se quiere construir.
 *   DEPLOY  project-directory = el de PRODUCCIÓN (para que (b) y (c) resuelvan)
 *           + `--no-build` OBLIGATORIO, para que (a) no pueda construir nada.
 *
 * @param {"build"|"deploy"} fase
 * @param {string[]} argv  la invocación completa, ya troceada
 * @param {{arbolFuente?: string}} ctx  árbol que se dice estar construyendo
 * @returns {string[]} motivos de rechazo; vacío = conforme
 */
export function revisarInvocacion(fase, argv, ctx = {}) {
  const fallos = [];
  const args = (argv ?? []).map(String);
  const projectDir = valorDeOpcion(args, "--project-directory");
  const construye = args.includes("build") || args.includes("--build");
  const despliega = args.includes("up") || args.includes("create");
  const noBuild = args.includes("--no-build");

  if (fase === "deploy") {
    // El corazón del contrato: en despliegue no se construye. Punto.
    if (!noBuild) {
      fallos.push(
        "DEPLOY sin `--no-build`: la fase de despliegue no puede construir. Sin él, `build.context` " +
          "se resuelve contra el project-directory de producción y se reconstruye el árbol equivocado " +
          "con la etiqueta correcta (incidente real: 98f381ec etiquetado como 4d469dc).",
      );
    }
    if (construye) {
      fallos.push("DEPLOY invoca `build`/`--build`: eso es la fase BUILD, no esta.");
    }
    if (!projectDir) {
      fallos.push(
        "DEPLOY sin `--project-directory`: los ficheros de secretos y las rutas relativas se " +
          "resolverían contra el directorio del compose, no contra el de producción.",
      );
    }
    if (!despliega) {
      fallos.push("DEPLOY no contiene `up`/`create`: esta invocación no despliega nada.");
    }
  }

  if (fase === "build") {
    if (!construye) {
      fallos.push("BUILD no contiene `build`: esta invocación no construye nada.");
    }
    if (despliega) {
      fallos.push(
        "BUILD invoca `up`/`create`: construir y desplegar en el mismo comando impide verificar el " +
          "CONTENIDO de la imagen antes de que corra.",
      );
    }
    // La regla que faltó: si se declara un árbol fuente, el project-directory
    // TIENE que ser ese árbol. Uno distinto es exactamente el incidente.
    if (ctx.arbolFuente && projectDir && normalizarRuta(projectDir) !== normalizarRuta(ctx.arbolFuente)) {
      fallos.push(
        `BUILD con --project-directory=${projectDir} mientras se dice construir ${ctx.arbolFuente}: ` +
          "un `build.context` relativo se resolvería contra el primero. Es el incidente del árbol viejo " +
          "etiquetado con el commit nuevo.",
      );
    }
    // Sin identidad de build embebida no hay nada que verificar después (ADR-016).
    if (!args.some((a) => /^BUILD_COMMIT=/.test(a) || a === "BUILD_COMMIT")) {
      fallos.push(
        "BUILD sin `BUILD_COMMIT`: la imagen quedaría marcada `unknown` y no habría forma de contrastar " +
          "su contenido con su etiqueta (ADR-016).",
      );
    }
  }

  return fallos;
}

function valorDeOpcion(args, nombre) {
  const i = args.indexOf(nombre);
  if (i >= 0) return args[i + 1];
  const pegado = args.find((a) => a.startsWith(`${nombre}=`));
  return pegado ? pegado.slice(nombre.length + 1) : undefined;
}

function normalizarRuta(p) {
  return String(p).replace(/\/+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EVIDENCIA · qué código, qué imagen, qué SPEC, qué runtime
// ─────────────────────────────────────────────────────────────────────────────
/** Las cuatro preguntas que un despliegue tiene que poder responder. */
export const PREGUNTAS = ["codigo", "imagen", "spec", "runtime"];

/**
 * Señales que NO son evidencia por sí solas. Cada una dejó pasar un defecto:
 *   - `etiqueta`: la etiqueta mintió y el gate la bendijo (tautología).
 *   - `compose-rc0`: `docker compose` salió 0 construyendo el árbol viejo.
 *   - `healthy`: un contenedor healthy corría sobre una image ID ya borrada del
 *     daemon; y hoy mismo, en VM108, `infrastructure-postgres-1` lleva 10 días
 *     `healthy` sobre una imagen que ya no tiene etiqueta que la nombre.
 */
export const NO_SON_EVIDENCIA = new Set(["etiqueta", "tag", "compose-rc0", "rc0", "healthy", "healthcheck"]);

/**
 * @param {Record<string, {fuente?: string, valor?: string}>} evidencia
 * @returns {string[]} motivos de rechazo; vacío = el despliegue puede afirmarse
 */
export function evidenciaSuficiente(evidencia) {
  const fallos = [];
  for (const pregunta of PREGUNTAS) {
    const e = evidencia?.[pregunta];
    if (!e || !e.fuente || !String(e.valor ?? "").trim()) {
      // Fail-closed: una pregunta sin responder no se aprueba por omisión.
      fallos.push(`falta la evidencia de "${pregunta}": sin ella el despliegue no es afirmable`);
      continue;
    }
    if (NO_SON_EVIDENCIA.has(String(e.fuente).toLowerCase())) {
      fallos.push(
        `"${pregunta}" se apoya solo en "${e.fuente}", que el contrato prohíbe como evidencia única ` +
          "(la etiqueta puede mentir, un rc=0 puede haber construido el árbol equivocado y un contenedor " +
          "healthy puede correr sobre una imagen que ya no se puede reproducir)",
      );
    }
  }
  return fallos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLASIFICACIÓN DEL CAMBIO · un gate no puede contradecirse a sí mismo
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Incidente real: el gate imprimió "intercambio de imagen puro" JUSTO DEBAJO de
 * haber clasificado un cambio de montajes. El texto y el diff decían cosas
 * distintas porque se calculaban por separado.
 *
 * Aquí el veredicto SE DERIVA del conjunto de claves que cambian: no existe
 * ningún camino que imprima "puro" con ese conjunto conteniendo algo que no sea
 * `image`, porque la etiqueta es una función del conjunto.
 *
 * @returns {{clase: "sin-cambio"|"intercambio-de-imagen-puro"|"cambio-de-spec",
 *            camposCambiados: string[], resumen: string}}
 */
export function clasificarCambioDeSpec(antes, despues) {
  const claves = [...new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})])].sort();
  const camposCambiados = claves.filter((k) => !igual(antes?.[k], despues?.[k]));

  const soloImagen = camposCambiados.length === 1 && camposCambiados[0] === "image";
  const clase =
    camposCambiados.length === 0 ? "sin-cambio" : soloImagen ? "intercambio-de-imagen-puro" : "cambio-de-spec";

  // El resumen se construye DESDE camposCambiados: no puede desmentirlo.
  const resumen =
    clase === "sin-cambio"
      ? "sin cambio de spec"
      : clase === "intercambio-de-imagen-puro"
        ? "intercambio de imagen puro (único campo distinto: image)"
        : `cambio de spec en: ${camposCambiados.join(", ")} — NO es un intercambio de imagen puro`;

  return { clase, camposCambiados, resumen };
}

function igual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ÁMBITO · un invariante medido sobre un host compartido no mide el stack
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Incidente real: un recuento de contenedores DEL HOST dio fallo espurio porque
 * otro carril tenía corriendo un contenedor efímero. El invariante era del
 * stack; la medida, del host. Sigue ocurriendo: en VM108 convive con el stack
 * un contenedor sin proyecto Compose levantado por otro carril.
 *
 * @param {{nombre: string, proyecto?: string}[]} contenedores  todo lo del host
 * @param {string} proyecto  valor de com.docker.compose.project del stack
 */
export function acotarAlProyecto(contenedores, proyecto) {
  const dentro = (contenedores ?? []).filter((c) => c.proyecto === proyecto);
  const ajenos = (contenedores ?? []).filter((c) => c.proyecto !== proyecto);
  return { dentro, ajenos };
}

/**
 * Invariante de composición del stack: se comprueba que estén TODOS los
 * servicios esperados y que NO haya ninguno de más DENTRO del proyecto.
 *
 * Los dos lados importan, y el segundo es el que reprodujo el incidente: el
 * "sobra un contenedor" es precisamente lo que dispara un fallo espurio si la
 * medida se toma sobre el host en vez de sobre el proyecto. Por eso la lista de
 * sobrantes se calcula SIEMPRE sobre el conjunto ya acotado: un contenedor
 * efímero de otro carril no puede aparecer aquí.
 *
 * @returns {string[]} motivos de rechazo; vacío = conforme
 */
export function comprobarInvarianteDeAmbito(contenedores, proyecto, esperados) {
  const fallos = [];
  if (!proyecto) {
    fallos.push(
      "invariante sin ámbito: no se declaró el proyecto Compose, así que se estaría midiendo el HOST " +
        "y un contenedor efímero de otro carril lo rompería (fallo espurio real)",
    );
    return fallos;
  }
  const { dentro } = acotarAlProyecto(contenedores, proyecto);
  const nombres = dentro.map((c) => c.nombre);
  const lista = esperados ?? [];

  const faltan = lista.filter((s) => !nombres.some((n) => n.includes(s)));
  if (faltan.length > 0) fallos.push(`faltan servicios del proyecto "${proyecto}": ${faltan.join(", ")}`);

  const sobran = nombres.filter((n) => !lista.some((s) => n.includes(s)));
  if (sobran.length > 0) {
    fallos.push(
      `sobran contenedores DENTRO del proyecto "${proyecto}": ${sobran.join(", ")} — ` +
        "si esto salta por algo ajeno al stack, la medida se tomó sobre el host y no sobre el proyecto",
    );
  }
  return fallos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UN SOLO COMPOSE CANÓNICO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Hallazgo de VM108: los contenedores del MISMO proyecto declaran TRES
 * `com.docker.compose.project.config_files` distintos (dos árboles de build
 * temporales y el directorio de producción). Eso no es un stack desplegado: son
 * tres despliegues parciales solapados, y ningún `docker compose` posterior
 * reproduce el conjunto.
 *
 * @param {{nombre: string, configFiles?: string}[]} contenedores  ya acotados al proyecto
 */
export function composeCanonicoUnico(contenedores) {
  const fallos = [];
  const porFichero = new Map();
  for (const c of contenedores ?? []) {
    const f = String(c.configFiles ?? "").trim();
    if (!f) {
      fallos.push(`"${c.nombre}" no declara com.docker.compose.project.config_files: origen desconocido`);
      continue;
    }
    if (!porFichero.has(f)) porFichero.set(f, []);
    porFichero.get(f).push(c.nombre);
  }
  if (porFichero.size > 1) {
    const detalle = [...porFichero.entries()].map(([f, cs]) => `${f} → ${cs.join(", ")}`).join(" | ");
    fallos.push(
      `el stack corre desde ${porFichero.size} ficheros compose distintos: ${detalle}. ` +
        "No hay un compose canónico, así que ningún comando reproduce el conjunto desplegado.",
    );
  }
  return fallos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HUMO · nada destructivo contra producción
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Motivo real: una sonda de retención SIN AUTENTICACIÓN borró replays de
 * producción. La "prueba" de la garantía la demostró destruyendo el dato.
 * Si una garantía destructiva ha de probarse, va en fixture aislado.
 */
const DESTRUCTIVO =
  /\b(delete|drop|truncate|prune|forget|purge|sweep|barrido|retention[-_ ]?run|rm\s+-rf|shred|flushall|reset\s+--hard)\b/i;

/**
 * @param {{nombre: string, comando: string, entorno: "produccion"|"fixture"}} paso
 * @returns {string[]}
 */
export function humoPermitido(paso) {
  const fallos = [];
  const comando = String(paso?.comando ?? "");
  const m = comando.match(DESTRUCTIVO);
  if (m && paso?.entorno === "produccion") {
    fallos.push(
      `paso de humo "${paso.nombre}" ejecuta una operación destructiva ("${m[0]}") contra PRODUCCIÓN. ` +
        "Prohibido: una sonda de retención sin autenticación ya borró replays reales. " +
        "Si la garantía destructiva debe probarse, va en un fixture aislado.",
    );
  }
  return fallos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ENTORNOS TEMPORALES · hardlinks y borrado
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Incidente real: `git clone` de una RUTA LOCAL hardlinkea `.git/objects`; un
 * borrado destructivo posterior sobre el clon vació 384 objetos del repositorio
 * PRODUCTIVO. El clon no era una copia: era el mismo inodo.
 */
export function revisarClon(argv) {
  const fallos = [];
  const args = (argv ?? []).map(String);
  const iClone = args.indexOf("clone");
  if (iClone < 0) return fallos;
  const fuente = args.slice(iClone + 1).find((a) => !a.startsWith("-"));
  if (!fuente) return fallos;
  const esLocal = !/^(https?|ssh|git|file):\/\//.test(fuente) && !/^[^/\s]+@[^:\s]+:/.test(fuente);
  if (esLocal && !args.includes("--no-hardlinks")) {
    fallos.push(
      `git clone de ruta local "${fuente}" sin --no-hardlinks: .git/objects quedaría hardlinkeado al ` +
        "original y un borrado destructivo del clon vaciaría el repositorio de origen (ocurrió: 384 objetos). " +
        "Preferir el remoto; si ha de ser local, --no-hardlinks.",
    );
  }
  return fallos;
}

/**
 * Antes de un `shred` —que SOLO se usa sobre secretos aislados, nunca para
 * limpiar un árbol: para eso está `rm -rf`— hay que mirar el contador de
 * enlaces. `stat -c '%i %h %n'` → si %h > 1 hay otro nombre apuntando al mismo
 * inodo y el shred lo destruye también.
 *
 * @param {string} lineaStat  salida de `stat -c '%i %h %n' <fichero>`
 */
export function seguroParaShred(lineaStat) {
  const fallos = [];
  const m = String(lineaStat ?? "")
    .trim()
    .match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!m) {
    fallos.push(`no se pudo leer el contador de enlaces de "${lineaStat}" — ABORTAR (fail-closed)`);
    return fallos;
  }
  const enlaces = Number(m[2]);
  if (enlaces > 1) {
    fallos.push(
      `"${m[3]}" tiene ${enlaces} enlaces duros al inodo ${m[1]}: un shred destruiría también el otro ` +
        "nombre (el original). ABORTAR.",
    );
  }
  return fallos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. CI · recuento de conclusiones, jamás el final de un `--watch`
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regla: se cuentan las CONCLUSIONES de TODOS los checks. `skipped`, `neutral`
 * y `not_exercised` NO son éxito; un check todavía en marcha tampoco. El final
 * de `gh run watch` no es un recuento: informa del último job que terminó, no
 * del estado del conjunto.
 *
 * @param {{name: string, status?: string, conclusion?: string|null}[]} checks
 */
export function contarConclusiones(checks) {
  const conteo = { success: 0, failure: 0, no_exito: 0, pendientes: 0 };
  const motivos = [];
  const lista = checks ?? [];
  if (lista.length === 0) {
    return { verde: false, conteo, motivos: ["no se leyó ningún check: un recuento vacío no es verde (fail-closed)"] };
  }
  for (const c of lista) {
    const estado = String(c.status ?? "completed");
    const conc = c.conclusion == null ? null : String(c.conclusion);
    if (estado !== "completed" || conc === null) {
      conteo.pendientes++;
      motivos.push(`"${c.name}" sigue en ${estado}: aún no hay conclusión que contar`);
      continue;
    }
    if (conc === "success") {
      conteo.success++;
    } else if (conc === "failure" || conc === "cancelled" || conc === "timed_out") {
      conteo.failure++;
      motivos.push(`"${c.name}" concluyó ${conc}`);
    } else {
      // skipped, neutral, action_required, stale, not_exercised…
      conteo.no_exito++;
      motivos.push(`"${c.name}" concluyó "${conc}", que NO es éxito (no se cuenta como verde)`);
    }
  }
  return { verde: motivos.length === 0, conteo, motivos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calibración: todas las garantías tienen que poder ponerse rojas
// ─────────────────────────────────────────────────────────────────────────────
function autoprueba() {
  const casos = [
    [
      "DEPLOY sin --no-build se rechaza",
      () =>
        revisarInvocacion("deploy", ["docker", "compose", "--project-directory", "/srv/app", "up", "-d"]).length > 0,
    ],
    [
      "DEPLOY bien formado se acepta",
      () =>
        revisarInvocacion("deploy", ["docker", "compose", "--project-directory", "/srv/app", "up", "-d", "--no-build"])
          .length === 0,
    ],
    [
      "BUILD con project-directory ajeno al árbol fuente se rechaza",
      () =>
        revisarInvocacion(
          "build",
          ["BUILD_COMMIT=abc", "docker", "compose", "--project-directory", "/srv/app", "build"],
          { arbolFuente: "/tmp/arbol-nuevo" },
        ).length > 0,
    ],
    [
      "BUILD coherente se acepta",
      () =>
        revisarInvocacion(
          "build",
          ["BUILD_COMMIT=abc", "docker", "compose", "--project-directory", "/tmp/arbol-nuevo", "build"],
          { arbolFuente: "/tmp/arbol-nuevo" },
        ).length === 0,
    ],
    [
      "evidencia incompleta se rechaza",
      () => evidenciaSuficiente({ codigo: { fuente: "git", valor: "abc" } }).length > 0,
    ],
    [
      "evidencia que solo es la etiqueta se rechaza",
      () =>
        evidenciaSuficiente({
          codigo: { fuente: "git rev-parse", valor: "abc" },
          imagen: { fuente: "etiqueta", valor: "sha-abc" },
          spec: { fuente: "compose config", valor: "hash" },
          runtime: { fuente: "/version", valor: "abc" },
        }).length > 0,
    ],
    [
      "la clasificación no puede contradecirse",
      () => {
        const r = clasificarCambioDeSpec({ image: "a", mounts: ["x"] }, { image: "b", mounts: ["y"] });
        return r.clase === "cambio-de-spec" && !r.resumen.includes("puro (");
      },
    ],
    [
      "invariante sin ámbito se rechaza",
      () => comprobarInvarianteDeAmbito([{ nombre: "efimero", proyecto: "otro" }], "", ["api"]).length > 0,
    ],
    [
      "invariante acotado ignora al vecino",
      () =>
        comprobarInvarianteDeAmbito(
          [
            { nombre: "infrastructure-api-1", proyecto: "infrastructure" },
            { nombre: "efimero-de-otro-carril", proyecto: "" },
          ],
          "infrastructure",
          ["api"],
        ).length === 0,
    ],
    [
      "sobrante ajeno NO se cuenta como sobrante del proyecto",
      () =>
        comprobarInvarianteDeAmbito(
          [
            { nombre: "infrastructure-api-1", proyecto: "infrastructure" },
            { nombre: "carril-efimero", proyecto: "" },
          ],
          "infrastructure",
          ["api"],
        ).length === 0,
    ],
    [
      "sobrante DENTRO del proyecto sí se detecta",
      () =>
        comprobarInvarianteDeAmbito(
          [
            { nombre: "infrastructure-api-1", proyecto: "infrastructure" },
            { nombre: "infrastructure-colado-1", proyecto: "infrastructure" },
          ],
          "infrastructure",
          ["api"],
        ).length > 0,
    ],
    ["shred con stat ilegible aborta (fail-closed)", () => seguroParaShred("stat: no existe").length > 0],
    [
      "tres ficheros compose distintos se rechazan",
      () =>
        composeCanonicoUnico([
          { nombre: "api", configFiles: "/tmp/build-X/infrastructure/docker-compose.yml" },
          { nombre: "backup", configFiles: "/tmp/deploy-Y/infrastructure/docker-compose.yml" },
        ]).length > 0,
    ],
    [
      "humo destructivo contra producción se rechaza",
      () =>
        humoPermitido({ nombre: "retención", comando: "curl -XDELETE /replays/sweep", entorno: "produccion" }).length >
        0,
    ],
    [
      "el mismo humo en fixture se acepta",
      () =>
        humoPermitido({ nombre: "retención", comando: "curl -XDELETE /replays/sweep", entorno: "fixture" }).length ===
        0,
    ],
    ["clon local sin --no-hardlinks se rechaza", () => revisarClon(["git", "clone", "/srv/repo", "/tmp/x"]).length > 0],
    [
      "clon remoto se acepta",
      () => revisarClon(["git", "clone", "https://github.com/pjclavero/s9-ai-arena.git", "/tmp/x"]).length === 0,
    ],
    ["shred sobre inodo compartido se rechaza", () => seguroParaShred("12345 2 /tmp/secreto").length > 0],
    ["shred sobre inodo único se acepta", () => seguroParaShred("12345 1 /tmp/secreto").length === 0],
    ["skipped no es verde", () => contarConclusiones([{ name: "x", conclusion: "skipped" }]).verde === false],
    ["neutral no es verde", () => contarConclusiones([{ name: "x", conclusion: "neutral" }]).verde === false],
    [
      "un check pendiente no es verde",
      () => contarConclusiones([{ name: "x", status: "in_progress" }]).verde === false,
    ],
    ["un recuento vacío no es verde", () => contarConclusiones([]).verde === false],
    ["todo success sí es verde", () => contarConclusiones([{ name: "x", conclusion: "success" }]).verde === true],
  ];

  let malos = 0;
  for (const [nombre, fn] of casos) {
    let ok = false;
    try {
      ok = fn() === true;
    } catch (e) {
      console.error(`  ✗ ${nombre}: lanzó ${e.message}`);
    }
    if (!ok) {
      malos++;
      console.error(`  ✗ calibración fallida: ${nombre}`);
    }
  }
  if (malos > 0) {
    console.error(`autoprueba del gate de release: ${malos}/${casos.length} garantías NO se comportan como deben`);
    return 1;
  }
  console.log(`autoprueba OK · ${casos.length} garantías del contrato de release calibradas (positivo y negativo)`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
/** Un cambio de spec presentado como intercambio de imagen es un rechazo. */
function avisoDeSpec(r) {
  return r.clase === "cambio-de-spec" ? [`el despliegue se declaró como intercambio de imagen pero ${r.resumen}`] : [];
}

function main(argv) {
  if (argv.includes("--self-test")) return autoprueba();

  const iEv = argv.indexOf("--evidencia");
  if (iEv >= 0) {
    const ruta = argv[iEv + 1];
    if (!ruta) {
      console.error("uso: --evidencia <fichero.json>");
      return 2;
    }
    let doc;
    try {
      doc = JSON.parse(readFileSync(ruta, "utf8"));
    } catch (e) {
      console.error(`no se pudo leer la evidencia (${e.message}) — el despliegue NO se aprueba por omisión`);
      return 1;
    }
    const fallos = [
      ...evidenciaSuficiente(doc.evidencia ?? {}),
      ...(doc.humo ?? []).flatMap(humoPermitido),
      ...(doc.spec ? avisoDeSpec(clasificarCambioDeSpec(doc.spec.antes, doc.spec.despues)) : []),
    ];
    if (fallos.length > 0) {
      console.error("RELEASE RECHAZADO · el contrato ADR-017 no se cumple:");
      for (const f of fallos) console.error(`  ✗ ${f}`);
      return 1;
    }
    console.log("OK · evidencia completa: código, imagen, SPEC y runtime respondidos con fuente admisible");
    return 0;
  }

  const iInv = argv.indexOf("--invocacion");
  if (iInv >= 0) {
    const fase = argv[iInv + 1];
    const sep = argv.indexOf("--");
    if (!["build", "deploy"].includes(fase) || sep < 0) {
      console.error("uso: --invocacion <build|deploy> [--arbol-fuente <ruta>] -- <comando…>");
      return 2;
    }
    const arbolFuente = valorDeOpcion(argv.slice(0, sep), "--arbol-fuente");
    const fallos = revisarInvocacion(fase, argv.slice(sep + 1), { arbolFuente });
    if (fallos.length > 0) {
      console.error(`INVOCACIÓN RECHAZADA · fase ${fase.toUpperCase()}:`);
      for (const f of fallos) console.error(`  ✗ ${f}`);
      return 1;
    }
    console.log(`OK · la invocación es una fase ${fase.toUpperCase()} bien formada`);
    return 0;
  }

  console.error("uso: --self-test | --evidencia <json> | --invocacion <build|deploy> -- <comando…>");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
