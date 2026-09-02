#!/usr/bin/env node
/**
 * CARRIL G · RUNTIME DRIFT SCANNER — adquisición de HECHOS, no de veredictos.
 *
 * Principio arquitectónico (no negociable):
 *
 *     DRIFT SCANNER = obtiene HECHOS   ·   R17 = INTERPRETA hechos
 *
 * Este escáner NO dice "listo" ni "no listo". Dice QUÉ HAY: por cada servicio
 * en marcha, qué etiqueta se declaró, sobre qué image ID corre de verdad, si
 * esa image ID todavía existe en el daemon, a qué ID resuelve HOY la etiqueta
 * declarada, qué identidad de build trae embebida (si trae alguna), qué runtime
 * ejecuta y en qué se aparta de la especificación en montajes, secretos y
 * variables de entorno. La decisión de readiness es de R17.
 *
 * ── Defectos reales que este escáner existe para no repetir ─────────────────
 *
 * 1. `docker images -q` NO LISTA LAS IMÁGENES SIN ETIQUETA DE NIVEL SUPERIOR.
 *    En VM108, la imagen de postgres en marcha (`57c72fd2a128`) existe pero se
 *    quedó sin etiquetas cuando `postgres:16-alpine` se movió a otra imagen.
 *    `docker images --no-trunc -q | grep 57c72fd2a128` devuelve 0 coincidencias;
 *    `docker image inspect 57c72fd2a128` la encuentra sin problema. Comprobar
 *    la existencia con el listado produce un FALSO "imagen desaparecida" — y en
 *    otro daemon, con otro orden de borrados, produciría el falso contrario.
 *    Aquí la existencia se comprueba SIEMPRE con `docker image inspect <id>`.
 *
 * 2. COMPARAR MONTAJES POR NOMBRE FÍSICO. Compose prefija el proyecto:
 *    `arena_replays` se materializa como `infrastructure_arena_replays`. Comparar
 *    el nombre físico marca drift donde no lo hay (ruido que se acaba ignorando)
 *    y, peor, empareja por nombre en vez de por DESTINO: un destino correcto
 *    servido por un volumen que no corresponde pasaría inadvertido. Aquí se
 *    compara por destino + origen LÓGICO + rw/ro + tipo, y las ausencias que la
 *    especificación exige se verifican como ausencias de verdad.
 *
 * ── Topología ──────────────────────────────────────────────────────────────
 * La salida es apta para un repositorio público: las rutas de bind se reducen a
 * un origen lógico relativo al despliegue (`repo:infrastructure/...`) o a un
 * opaco `bind:#<hash>`; los valores de entorno NUNCA se emiten (solo nombres);
 * de los secretos solo se emite el nombre lógico del montaje en /run/secrets.
 *
 * ── Dependencia declarada ──────────────────────────────────────────────────
 * El modelo de 4 estados de drift lo define el carril de PROCEDENCIA (ADR-016,
 * `verify-image-provenance.mjs` / `check-running-image-id.mjs`). Este escáner no
 * lo duplica ni lo reimplementa: emite hechos crudos más un `result` propio y
 * ESTABLE (ver ESTADOS) que ese modelo puede mapear. Cuando la evidencia no
 * alcanza —imágenes anteriores a ADR-016, que no llevan identidad embebida— el
 * campo sale como `desconocido` y el resultado como NO_EJERCIDO. Nunca como OK.
 *
 * ── Uso ────────────────────────────────────────────────────────────────────
 *   node infrastructure/scripts/runtime-drift-scan.mjs --collect > hechos.json
 *       Solo adquisición, contra el daemon local (lectura pura).
 *   node infrastructure/scripts/runtime-drift-scan.mjs --facts hechos.json \
 *        [--target infrastructure/drift-target.json] [--json]
 *       Interpretación de hechos ya adquiridos (no necesita Docker).
 *   node infrastructure/scripts/runtime-drift-scan.mjs [--target …] [--json]
 *       Adquisición + informe en una pasada.
 *   node infrastructure/scripts/runtime-drift-scan.mjs --self-test
 *
 * rc=0 si ningún servicio sale con un estado de drift; rc=1 si alguno lo hace;
 * rc=2 error de adquisición. NO_EJERCIDO no es éxito: cuenta como rc=1 salvo
 * con --allow-unknown, que lo deja en rc=0 documentándolo en la salida.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Estados posibles por servicio. Orden = precedencia (el primero que aplique). */
export const ESTADOS = {
  IMAGE_MISSING: "IMAGE_MISSING",
  TAG_MISMATCH: "TAG_MISMATCH",
  TAG_MOVED: "TAG_MOVED",
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
  RUNTIME_DRIFT: "RUNTIME_DRIFT",
  SPEC_DRIFT: "SPEC_DRIFT",
  NOT_EXERCISED: "NOT_EXERCISED",
  OK: "OK",
};

const PRECEDENCIA = [
  ESTADOS.IMAGE_MISSING,
  ESTADOS.TAG_MISMATCH,
  ESTADOS.TAG_MOVED,
  ESTADOS.DIGEST_MISMATCH,
  ESTADOS.RUNTIME_DRIFT,
  ESTADOS.SPEC_DRIFT,
  ESTADOS.NOT_EXERCISED,
  ESTADOS.OK,
];

/** Estados que NO son éxito. NOT_EXERCISED entra aquí a propósito. */
export const ESTADOS_NO_OK = new Set(PRECEDENCIA.filter((e) => e !== ESTADOS.OK));

export const DESCONOCIDO = "desconocido";

// ── Normalización de montajes ────────────────────────────────────────────────

/**
 * Origen LÓGICO de un montaje. Es lo único que se compara y lo único que se
 * emite: nunca el nombre físico del volumen ni la ruta absoluta del anfitrión.
 *
 *  - volumen: nombre físico menos el prefijo del proyecto Compose
 *             (`infrastructure_arena_replays` → `arena_replays`).
 *  - bind   : ruta relativa al árbol desplegado si se reconoce
 *             (`/…/infrastructure/secrets/x` → `repo:infrastructure/secrets/x`),
 *             y si no, un opaco estable `bind:#<sha256[0..11]>`. Un bind opaco
 *             no equivale JAMÁS a un bind esperado: es drift por construcción.
 */
export function origenLogico(montaje, { proyecto = "", anclaRepo = "infrastructure/" } = {}) {
  const tipo = String(montaje?.type ?? montaje?.Type ?? "");
  if (tipo === "volume") {
    const fisico = String(montaje.name ?? montaje.Name ?? "");
    if (!fisico) return `volume:#${hash(String(montaje.source ?? montaje.Source ?? ""))}`;
    const prefijo = proyecto ? `${proyecto}_` : "";
    return prefijo && fisico.startsWith(prefijo) ? fisico.slice(prefijo.length) : fisico;
  }
  const ruta = String(montaje?.source ?? montaje?.Source ?? "");
  const i = ruta.indexOf(`/${anclaRepo}`);
  if (i >= 0) return `repo:${ruta.slice(i + 1)}`;
  if (ruta.startsWith(anclaRepo)) return `repo:${ruta}`;
  return `bind:#${hash(ruta)}`;
}

function hash(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

/** Montaje normalizado y comparable: {tipo, destino, origen, rw}. */
export function normalizarMontaje(m, opciones = {}) {
  return {
    tipo: String(m?.type ?? m?.Type ?? DESCONOCIDO),
    destino: String(m?.destination ?? m?.Destination ?? ""),
    origen: origenLogico(m, opciones),
    rw: Boolean(m?.rw ?? m?.RW ?? false),
  };
}

const clave = (m) => `${m.tipo}|${m.destino}|${m.origen}|${m.rw ? "rw" : "ro"}`;

/**
 * Drift de montajes por DESTINO (nunca por nombre físico).
 *
 * `objetivo.mounts`  — montajes que deben existir, ya en forma lógica.
 * `objetivo.absent`  — destinos que la especificación RETIRA: si siguen
 *                      montados, es drift (la ausencia deliberada se verifica).
 */
export function driftDeMontajes(actuales, objetivo = {}) {
  const esperados = (objetivo.mounts ?? []).map((m) => ({ ...m, rw: Boolean(m.rw) }));
  const ausentes = objetivo.absent ?? [];
  const porDestino = new Map(actuales.map((m) => [m.destino, m]));

  const faltan = [];
  const incorrectos = [];
  for (const e of esperados) {
    const hay = porDestino.get(e.destino);
    if (!hay) {
      faltan.push(e.destino);
      continue;
    }
    if (clave(hay) !== clave(e)) {
      // Destino correcto servido por otra cosa (otro volumen, otro modo, otro
      // tipo). Es FALLO: la ruta existe, pero no la sirve lo que debe.
      incorrectos.push({ destino: e.destino, esperado: clave(e), encontrado: clave(hay) });
    }
  }

  const destinosEsperados = new Set(esperados.map((e) => e.destino));
  const sobran = actuales.map((m) => m.destino).filter((d) => !destinosEsperados.has(d));
  const ausenciasIncumplidas = ausentes.filter((d) => porDestino.has(d));

  return { faltan, sobran, incorrectos, ausenciasIncumplidas };
}

// ── Drift de entorno y secretos (solo nombres; ningún valor sale de aquí) ────

export function driftDeEntorno(nombresActuales, objetivo = {}) {
  const actuales = new Set(nombresActuales ?? []);
  const faltan = (objetivo.required ?? []).filter((n) => !actuales.has(n));
  const prohibidasPresentes = (objetivo.forbidden ?? []).filter((n) => actuales.has(n));
  return { faltan, prohibidasPresentes };
}

export function driftDeSecretos(actuales, esperados = []) {
  const hay = new Set(actuales ?? []);
  const quiere = new Set(esperados);
  return {
    faltan: [...quiere].filter((s) => !hay.has(s)),
    inesperados: [...hay].filter((s) => !quiere.has(s)),
  };
}

// ── Clasificación por servicio ───────────────────────────────────────────────

/**
 * Interpreta los hechos de UN servicio. `hecho` es lo que emite `--collect`;
 * `objetivo` es la especificación (opcional: sin ella, spec_drift no se ejerce).
 */
export function escanearServicio(hecho, objetivo = null) {
  const motivos = [];
  const estados = [];

  const declarada = hecho.declared_ref ?? DESCONOCIDO;
  const idEnMarcha = hecho.running_image_id ?? null;
  // REGLA DURA: la existencia viene de `docker image inspect <id>`, jamás de un
  // listado. El recolector la deja en `running_image_exists`; si el hecho no la
  // trae, no se presume que exista.
  const existe = hecho.running_image_exists;
  const idDeLaEtiqueta = hecho.declared_ref_current_id ?? null;

  if (existe !== true) {
    estados.push(ESTADOS.IMAGE_MISSING);
    motivos.push(
      existe === false
        ? `la image ID en marcha (${corto(idEnMarcha)}) ya NO existe en el daemon: el estado no es reproducible tras un restart`
        : "no consta comprobación de existencia de la image ID en marcha (docker image inspect no ejercido)",
    );
    if (existe === undefined || existe === null) estados.push(ESTADOS.NOT_EXERCISED);
  }

  if (objetivo?.declared_ref && objetivo.declared_ref !== declarada) {
    estados.push(ESTADOS.TAG_MISMATCH);
    motivos.push(`etiqueta incorrecta: corre "${declarada}" y el objetivo manda "${objetivo.declared_ref}"`);
  }

  if (existe === true && idEnMarcha) {
    if (idDeLaEtiqueta === null) {
      estados.push(ESTADOS.TAG_MOVED);
      motivos.push(`la etiqueta declarada "${declarada}" ya no resuelve a ninguna imagen del daemon`);
    } else if (idDeLaEtiqueta !== idEnMarcha) {
      estados.push(ESTADOS.TAG_MOVED);
      const sinTags = (hecho.running_image_repo_tags ?? []).length === 0;
      motivos.push(
        `ETIQUETA MOVIDA: "${declarada}" resuelve hoy a ${corto(idDeLaEtiqueta)} pero el contenedor corre ${corto(idEnMarcha)}` +
          (sinTags ? " (la imagen en marcha se quedó sin etiquetas: un listado por etiquetas no la ve)" : ""),
      );
    }
  }

  const digestEsperado = objetivo?.expected_digest ?? null;
  const digests = hecho.repo_digests ?? [];
  if (digestEsperado) {
    if (digests.length === 0) {
      estados.push(ESTADOS.NOT_EXERCISED);
      motivos.push("no hay digest publicado en la imagen: el digest esperado no se puede verificar");
    } else if (!digests.some((d) => d.endsWith(digestEsperado) || d === digestEsperado)) {
      estados.push(ESTADOS.DIGEST_MISMATCH);
      motivos.push(`digest: ninguno de los publicados coincide con el esperado ${corto(digestEsperado)}`);
    }
  }

  // Identidad de build embebida (ADR-016). Las imágenes de producción son
  // anteriores: no la traen. Eso es DESCONOCIDO / no ejercido, jamás verificado.
  const commit = hecho.build_commit ?? null;
  if (!commit) {
    estados.push(ESTADOS.NOT_EXERCISED);
    motivos.push(
      "identidad de build embebida ausente (imagen anterior a ADR-016): la procedencia NO queda verificada, queda desconocida",
    );
  } else if (objetivo?.expected_build_commit && !commit.startsWith(objetivo.expected_build_commit)) {
    estados.push(ESTADOS.TAG_MISMATCH);
    motivos.push(`identidad embebida ${corto(commit)} ≠ commit objetivo ${corto(objetivo.expected_build_commit)}`);
  }

  // Runtime realmente ejecutado. Si no hay objetivo explícito, el objetivo
  // IMPLÍCITO es el runtime de la imagen a la que la etiqueta declarada resuelve
  // HOY: es lo que un `docker compose up` reproduciría. Así "runtime distinto
  // del objetivo" se detecta sin necesidad de que nadie escriba una spec.
  const runtime = hecho.runtime ?? {};
  const runtimeObjetivo = objetivo?.runtime ?? hecho.declared_ref_runtime ?? null;
  let runtimeTexto = Object.entries(runtime)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (!runtimeTexto) runtimeTexto = DESCONOCIDO;
  if (runtimeObjetivo) {
    for (const [k, v] of Object.entries(runtimeObjetivo)) {
      const real = runtime[k];
      if (real === undefined) {
        estados.push(ESTADOS.NOT_EXERCISED);
        motivos.push(`runtime: no se pudo leer "${k}" (esperado ${v})`);
      } else if (String(real) !== String(v)) {
        estados.push(ESTADOS.RUNTIME_DRIFT);
        motivos.push(`RUNTIME DISTINTO DEL OBJETIVO: ${k}=${real} pero el objetivo es ${v}`);
      }
    }
  }

  // Drift de especificación: montajes + secretos + entorno.
  let specDrift = DESCONOCIDO;
  if (objetivo) {
    const montajes = driftDeMontajes(hecho.mounts ?? [], objetivo.mounts_spec ?? {});
    const entorno = driftDeEntorno(hecho.env_names ?? [], objetivo.env ?? {});
    const secretos = driftDeSecretos(hecho.secrets ?? [], objetivo.secrets ?? []);
    const partes = [];
    if (montajes.faltan.length) partes.push(`montaje ausente: ${montajes.faltan.join(",")}`);
    if (montajes.incorrectos.length)
      partes.push(
        `montaje impostor: ${montajes.incorrectos.map((i) => `${i.destino} (esperado ${i.esperado}, encontrado ${i.encontrado})`).join("; ")}`,
      );
    if (montajes.sobran.length) partes.push(`montaje no declarado: ${montajes.sobran.join(",")}`);
    if (montajes.ausenciasIncumplidas.length)
      partes.push(`ausencia incumplida (debía retirarse y sigue ahí): ${montajes.ausenciasIncumplidas.join(",")}`);
    if (secretos.faltan.length) partes.push(`secreto ausente: ${secretos.faltan.join(",")}`);
    if (secretos.inesperados.length) partes.push(`secreto no declarado: ${secretos.inesperados.join(",")}`);
    if (entorno.faltan.length) partes.push(`env ausente: ${entorno.faltan.join(",")}`);
    if (entorno.prohibidasPresentes.length)
      partes.push(`env prohibida presente: ${entorno.prohibidasPresentes.join(",")}`);

    if (partes.length) {
      specDrift = partes.join(" · ");
      estados.push(ESTADOS.SPEC_DRIFT);
      motivos.push(`spec: ${specDrift}`);
    } else {
      specDrift = "ninguno";
    }
  } else {
    estados.push(ESTADOS.NOT_EXERCISED);
    motivos.push("sin especificación objetivo: el drift de montajes/secretos/entorno NO se ha ejercido");
  }

  const result = PRECEDENCIA.find((e) => estados.includes(e)) ?? ESTADOS.OK;

  return {
    service: hecho.service,
    declared_ref: declarada,
    running_image_id: idEnMarcha ? corto(idEnMarcha) : DESCONOCIDO,
    running_image_exists: existe === true ? "sí" : existe === false ? "NO" : DESCONOCIDO,
    declared_ref_current_id: idDeLaEtiqueta ? corto(idDeLaEtiqueta) : DESCONOCIDO,
    expected_digest: digestEsperado ? corto(digestEsperado) : DESCONOCIDO,
    build_commit: commit ? corto(commit) : DESCONOCIDO,
    runtime_version: runtimeTexto,
    spec_drift: specDrift,
    result,
    estados: [...new Set(estados)],
    motivos,
  };
}

export function escanear(hechos, objetivos = {}) {
  return (hechos.services ?? hechos ?? []).map((h) => escanearServicio(h, objetivos[h.service] ?? null));
}

function corto(x) {
  return (
    String(x ?? "")
      .replace(/^sha256:/, "")
      .slice(0, 12) || DESCONOCIDO
  );
}

// ── Informes ─────────────────────────────────────────────────────────────────

const COLUMNAS = [
  ["service", "service"],
  ["declared_ref", "declared_ref"],
  ["running_image_id", "running_image_id"],
  ["running_image_exists", "exists"],
  ["declared_ref_current_id", "declared_ref_current_id"],
  ["expected_digest", "expected_digest"],
  ["build_commit", "build_commit"],
  ["runtime_version", "runtime_version"],
  ["spec_drift", "spec_drift"],
  ["result", "result"],
];

export function informeTexto(filas) {
  const anchos = COLUMNAS.map(([k, t]) => Math.max(t.length, ...filas.map((f) => String(f[k] ?? "").length)));
  const linea = (celdas) =>
    celdas
      .map((c, i) => String(c).padEnd(anchos[i]))
      .join("  ")
      .trimEnd();
  const out = [
    "RUNTIME DRIFT SCAN · hechos por servicio (la interpretación de readiness es de R17)",
    "",
    linea(COLUMNAS.map(([, t]) => t)),
    linea(anchos.map((a) => "-".repeat(a))),
    ...filas.map((f) => linea(COLUMNAS.map(([k]) => f[k] ?? ""))),
    "",
  ];
  for (const f of filas) {
    if (f.result === ESTADOS.OK) continue;
    out.push(`· ${f.service} → ${f.result}`);
    for (const m of f.motivos) out.push(`    - ${m}`);
  }
  const resumen = {};
  for (const f of filas) resumen[f.result] = (resumen[f.result] ?? 0) + 1;
  out.push(
    "",
    `resumen: ${
      Object.entries(resumen)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "sin servicios"
    }`,
  );
  out.push("nota: NOT_EXERCISED NO es éxito — es evidencia que falta, no evidencia a favor.");
  return out.join("\n");
}

export function informeJson(filas) {
  const resumen = {};
  for (const f of filas) resumen[f.result] = (resumen[f.result] ?? 0) + 1;
  return {
    schema: "s9-ai-arena/runtime-drift-scan/v1",
    generated_by: "infrastructure/scripts/runtime-drift-scan.mjs",
    note: "hechos, no veredicto de readiness; NOT_EXERCISED != OK",
    summary: resumen,
    services: filas,
  };
}

// ── Adquisición contra el daemon (lectura pura) ──────────────────────────────

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  // rc explícito: en una tubería $? es del último comando, nunca del que importa.
  return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** ¿Existe esta image ID? SIEMPRE con `docker image inspect`, nunca con un listado. */
export function imagenExiste(id, ejecutar = sh) {
  return ejecutar("docker", ["image", "inspect", "-f", "{{.Id}}", id]).rc === 0;
}

function resolverRef(ref, ejecutar = sh) {
  const r = ejecutar("docker", ["image", "inspect", "-f", "{{.Id}}", ref]);
  return r.rc === 0 ? r.out.trim() : null;
}

const CLAVES_RUNTIME = ["PG_VERSION", "REDIS_VERSION", "NODE_VERSION", "NGINX_VERSION", "PYTHON_VERSION"];

export function runtimeDesdeEnv(env = []) {
  const out = {};
  for (const e of env) {
    const i = String(e).indexOf("=");
    if (i < 0) continue;
    const k = e.slice(0, i);
    if (CLAVES_RUNTIME.includes(k)) out[k] = e.slice(i + 1);
  }
  return out;
}

/** Nombre de servicio Compose sin exponer el nombre del contenedor real. */
function servicioDe(c) {
  return c?.Config?.Labels?.["com.docker.compose.service"] ?? String(c?.Name ?? "").replace(/^\//, "");
}

/** Convierte el inspect crudo del daemon en HECHOS ya saneados de topología. */
export function hechosDesdeInspect(contenedores, { existe, resolver, runtimeDeRef, anclaRepo = "infrastructure/" }) {
  return contenedores.map((c) => {
    const proyecto = c?.Config?.Labels?.["com.docker.compose.project"] ?? "";
    const montajes = (c.Mounts ?? []).map((m) => normalizarMontaje(m, { proyecto, anclaRepo }));
    const secretos = montajes
      .filter((m) => m.destino.startsWith("/run/secrets/"))
      .map((m) => m.destino.slice("/run/secrets/".length))
      .sort();
    const declarada = c?.Config?.Image ?? DESCONOCIDO;
    const id = c?.Image ?? null;
    const labels = c?.Config?.Labels ?? {};
    const idEtiqueta = resolver(declarada);
    return {
      service: servicioDe(c),
      compose_managed: Boolean(c?.Config?.Labels?.["com.docker.compose.service"]),
      declared_ref: declarada,
      running_image_id: id,
      running_image_exists: id ? existe(id) : false,
      declared_ref_current_id: idEtiqueta,
      declared_ref_runtime: idEtiqueta && runtimeDeRef ? runtimeDeRef(idEtiqueta) : null,
      running_image_repo_tags: c.__repoTags ?? [],
      repo_digests: c.__repoDigests ?? [],
      build_commit: labels["org.opencontainers.image.revision"] ?? null,
      runtime: runtimeDesdeEnv(c?.Config?.Env ?? []),
      mounts: montajes.filter((m) => !m.destino.startsWith("/run/secrets/")),
      secrets: secretos,
      env_names: (c?.Config?.Env ?? []).map((e) => String(e).split("=")[0]).sort(),
    };
  });
}

function recolectar() {
  const ps = sh("docker", ["ps", "-q"]);
  if (ps.rc !== 0) throw new Error(`docker ps: ${ps.err || "falló"}`);
  const ids = ps.out.split("\n").filter(Boolean);
  if (ids.length === 0) return { services: [] };
  const insp = sh("docker", ["inspect", ...ids]);
  if (insp.rc !== 0) throw new Error(`docker inspect: ${insp.err || "falló"}`);
  const contenedores = JSON.parse(insp.out);
  for (const c of contenedores) {
    if (!c.Image) continue;
    const r = sh("docker", ["image", "inspect", "-f", "{{json .RepoTags}}\t{{json .RepoDigests}}", c.Image]);
    if (r.rc === 0) {
      const [tags, digests] = r.out.split("\t");
      c.__repoTags = JSON.parse(tags || "[]") ?? [];
      c.__repoDigests = JSON.parse(digests || "[]") ?? [];
    }
  }
  return {
    schema: "s9-ai-arena/runtime-drift-facts/v1",
    services: hechosDesdeInspect(contenedores, {
      existe: (id) => imagenExiste(id),
      resolver: (r) => resolverRef(r),
      runtimeDeRef: (id) => {
        const r = sh("docker", ["image", "inspect", "-f", "{{json .Config.Env}}", id]);
        return r.rc === 0 ? runtimeDesdeEnv(JSON.parse(r.out || "[]") ?? []) : null;
      },
    }),
  };
}

// ── Objetivo derivado de Compose ─────────────────────────────────────────────

/** Interpola `${VAR}` y `${VAR:-defecto}` con las variables que da el operador. */
export function interpolar(texto, vars = {}) {
  return String(texto).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, v, def) =>
    vars[v] !== undefined ? vars[v] : (def ?? ""),
  );
}

/** Un item de `volumes:` de Compose (cadena corta o forma larga) → montaje lógico. */
export function montajeDesdeCompose(item, { anclaRepo = "infrastructure/", vars = {} } = {}) {
  let source;
  let target;
  let ro = false;
  if (typeof item === "string") {
    const partes = interpolar(item, vars).split(":");
    // "origen:destino[:modo]" — las rutas absolutas del anfitrión no se usan en
    // este stack, así que el reparto es directo.
    source = partes[0];
    target = partes[1];
    ro = (partes[2] ?? "").split(",").includes("ro");
  } else {
    source = interpolar(item.source ?? "", vars);
    target = item.target ?? "";
    ro = Boolean(item.read_only);
  }
  const esRuta = source.startsWith(".") || source.startsWith("/");
  return {
    tipo: esRuta ? "bind" : "volume",
    destino: target,
    origen: esRuta ? `repo:${anclaRepo}${source.replace(/^\.\//, "").replace(/^\//, "")}` : source,
    rw: !ro,
  };
}

/**
 * Especificación objetivo derivada del propio Compose: montajes por destino con
 * su origen LÓGICO (sin prefijo de proyecto, sin ruta de anfitrión) y secretos.
 * Nada aquí se lee del daemon, así que no puede "confirmar" lo que ya hay.
 */
export function objetivosDesdeCompose(doc, { anclaRepo = "infrastructure/", vars = {}, tag = null } = {}) {
  const out = {};
  for (const [nombre, s] of Object.entries(doc?.services ?? {})) {
    const mounts = (s.volumes ?? []).map((v) => montajeDesdeCompose(v, { anclaRepo, vars }));
    const secrets = (s.secrets ?? []).map((x) => (typeof x === "string" ? x : x.source)).sort();
    const objetivo = { mounts_spec: { mounts }, secrets };
    if (tag) objetivo.declared_ref = interpolar(s.image ?? "", { ...vars, TAG: tag });
    out[nombre] = objetivo;
  }
  return out;
}

/** Fusiona el objetivo derivado de Compose con las anulaciones del operador. */
export function fusionarObjetivos(base, anulaciones = {}) {
  const out = { ...base };
  for (const [k, v] of Object.entries(anulaciones)) out[k] = { ...(base[k] ?? {}), ...v };
  return out;
}

// ── Autoprueba de calibración ────────────────────────────────────────────────

function autoprueba() {
  const fallos = [];
  const ok = (cond, msg) => {
    if (!cond) fallos.push(msg);
  };

  // Control positivo: todo coherente → OK.
  const sano = {
    service: "api",
    declared_ref: "s9arena/api:aaa",
    running_image_id: "sha256:" + "1".repeat(64),
    running_image_exists: true,
    declared_ref_current_id: "sha256:" + "1".repeat(64),
    build_commit: "aaa" + "0".repeat(37),
    runtime: { NODE_VERSION: "20.19.0" },
    mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }],
    secrets: ["jwt_secret"],
    env_names: ["PORT"],
  };
  const objetivo = {
    declared_ref: "s9arena/api:aaa",
    runtime: { NODE_VERSION: "20.19.0" },
    mounts_spec: { mounts: [{ tipo: "volume", destino: "/data/replays", origen: "arena_replays", rw: true }] },
    secrets: ["jwt_secret"],
    env: { required: ["PORT"] },
  };
  ok(escanearServicio(sano, objetivo).result === ESTADOS.OK, "control POSITIVO falló: lo coherente no sale OK");

  // Negativo 1 · imagen desaparecida.
  ok(
    escanearServicio({ ...sano, running_image_exists: false }, objetivo).result === ESTADOS.IMAGE_MISSING,
    "control NEGATIVO: imagen desaparecida no dispara IMAGE_MISSING",
  );
  // Negativo 2 · etiqueta movida.
  ok(
    escanearServicio({ ...sano, declared_ref_current_id: "sha256:" + "2".repeat(64) }, objetivo).result ===
      ESTADOS.TAG_MOVED,
    "control NEGATIVO: etiqueta movida no dispara TAG_MOVED",
  );
  // Negativo 3 · etiqueta incorrecta.
  ok(
    escanearServicio({ ...sano, declared_ref: "s9arena/api:otra" }, objetivo).result === ESTADOS.TAG_MISMATCH,
    "control NEGATIVO: etiqueta incorrecta no dispara TAG_MISMATCH",
  );
  // Negativo 4 · runtime distinto.
  ok(
    escanearServicio({ ...sano, runtime: { NODE_VERSION: "18.0.0" } }, objetivo).result === ESTADOS.RUNTIME_DRIFT,
    "control NEGATIVO: runtime distinto no dispara RUNTIME_DRIFT",
  );
  // Negativo 5 · destino correcto servido por otro volumen.
  ok(
    escanearServicio(
      { ...sano, mounts: [{ tipo: "volume", destino: "/data/replays", origen: "otro_volumen", rw: true }] },
      objetivo,
    ).result === ESTADOS.SPEC_DRIFT,
    "control NEGATIVO: volumen impostor en el destino correcto no dispara SPEC_DRIFT",
  );
  // Negativo 6 · sin identidad embebida → NO_EJERCIDO, jamás OK.
  ok(
    escanearServicio({ ...sano, build_commit: null }, objetivo).result === ESTADOS.NOT_EXERCISED,
    "control NEGATIVO: falta de identidad embebida se está dando por buena",
  );
  // Negativo 7 · equivalencia del prefijo Compose (no debe ser drift).
  ok(
    origenLogico({ type: "volume", name: "infrastructure_arena_replays" }, { proyecto: "infrastructure" }) ===
      "arena_replays",
    "el prefijo de proyecto de Compose no se está normalizando",
  );

  if (fallos.length) {
    for (const f of fallos) console.error(`autoprueba: ${f}`);
    return 1;
  }
  console.log("autoprueba OK · el escáner se pone rojo en los 6 controles negativos y verde en el positivo");
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * YAML solo cuando hace falta: el modo `--collect` corre en el anfitrión de
 * Docker, donde no hay node_modules del repo, y no debe depender de nada.
 */
function parseYaml(texto) {
  const require_ = createRequire(import.meta.url);
  return require_("yaml").parse(texto, { merge: true });
}

function arg(argv, nombre) {
  const i = argv.indexOf(nombre);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  if (argv.includes("--self-test")) return autoprueba();

  let hechos;
  const ficheroHechos = arg(argv, "--facts");
  try {
    hechos = ficheroHechos ? JSON.parse(readFileSync(ficheroHechos, "utf8")) : recolectar();
  } catch (e) {
    console.error(`adquisición: ${e.message}`);
    return 2;
  }

  if (argv.includes("--collect")) {
    console.log(JSON.stringify(hechos, null, 2));
    return 0;
  }

  let objetivos = {};
  const compose = arg(argv, "--target-from-compose");
  if (compose) {
    const vars = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "--compose-env") continue;
      const j = String(argv[i + 1] ?? "").indexOf("=");
      if (j > 0) vars[argv[i + 1].slice(0, j)] = argv[i + 1].slice(j + 1);
    }
    objetivos = objetivosDesdeCompose(parseYaml(readFileSync(compose, "utf8")), {
      vars,
      tag: arg(argv, "--tag") ?? null,
    });
  }
  const ficheroObjetivo = arg(argv, "--target");
  if (ficheroObjetivo) {
    const doc = JSON.parse(readFileSync(ficheroObjetivo, "utf8"));
    objetivos = fusionarObjetivos(objetivos, doc.services ?? doc);
  }

  const filas = escanear(hechos, objetivos);
  console.log(argv.includes("--json") ? JSON.stringify(informeJson(filas), null, 2) : informeTexto(filas));

  const conDrift = filas.filter((f) => f.result !== ESTADOS.OK);
  if (conDrift.length === 0) return 0;
  const soloDesconocido = conDrift.every((f) => f.result === ESTADOS.NOT_EXERCISED);
  if (soloDesconocido && argv.includes("--allow-unknown")) return 0;
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
