#!/usr/bin/env node
/**
 * ADR-016 · Clasificador de drift de imagen sobre un daemon entero.
 *
 * Este script tenía un DEFECTO que lo volvía inútil justo donde importaba:
 * decidía la existencia de la image ID en ejecución mirando si aparecía en
 * `docker images --no-trunc -q`. Ese listado NO incluye las imágenes sin
 * etiqueta de nivel superior. Medido en VM108: `infrastructure-postgres-1`
 * corre la image ID 57c72fd2a128, que existe y que `docker image inspect`
 * resuelve perfectamente, pero que no sale en `docker images -q` porque se
 * quedó con `RepoTags=[]`. Consecuencia doble: DRIFT CRÍTICO falso ("la imagen
 * no existe") y ceguera al drift verdadero (la etiqueta `postgres:16-alpine`
 * se había movido bajo el contenedor vivo).
 *
 * Ahora la existencia se comprueba con `docker image inspect <image-id>`, y las
 * cuatro observaciones se comparan POR SEPARADO (ver lib/image-drift.mjs):
 *   (a) image ID que corre · (b) referencia declarada ·
 *   (c) ID a la que resuelve HOY (b) · (d) digest esperado si hay pin.
 *
 * SOLO LECTURA: `docker ps`, `docker inspect`, `docker image inspect`. Nada más.
 *
 * Uso:
 *   node infrastructure/scripts/check-running-image-id.mjs             # daemon real
 *   node infrastructure/scripts/check-running-image-id.mjs --json
 *   node infrastructure/scripts/check-running-image-id.mjs --self-test # calibración
 *
 * rc=0 todos RUNTIME_MATCH · rc=1 hay al menos un estado de drift.
 */
import { spawnSync } from "node:child_process";
import {
  clasificarDrift,
  lineasInforme,
  corto,
  IMAGE_MISSING,
  TAG_CONTENT_MISMATCH,
  TAG_MOVED,
  RUNTIME_MATCH,
} from "./lib/image-drift.mjs";

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  // rc explícito: en una tubería $? es del último comando, nunca del que importa.
  return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function parseKeyValueList(json) {
  let dato;
  try {
    dato = JSON.parse(json);
  } catch {
    return Object.create(null);
  }
  const out = Object.create(null);
  if (Array.isArray(dato)) {
    for (const linea of dato) {
      if (typeof linea !== "string") continue;
      const i = linea.indexOf("=");
      if (i > 0) out[linea.slice(0, i)] = linea.slice(i + 1);
    }
  } else if (dato && typeof dato === "object") {
    for (const [k, v] of Object.entries(dato)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Observa un contenedor. `run` es inyectable para poder probar sin daemon.
 * La EXISTENCIA sale de `docker image inspect`, NUNCA de `docker images -q`.
 */
export function observarContenedor(id, run = (c, a) => sh(c, a), pines = {}) {
  const vacio = Object.create(null);
  const insp = run("docker", ["inspect", "-f", "{{.Name}}\t{{.Image}}\t{{.Config.Image}}", id]);
  if (insp.rc !== 0) {
    return {
      nombre: id,
      runningImageId: null,
      referencia: null,
      imagenResoluble: false,
      idDeLaReferencia: null,
      envImagen: vacio,
      labelsImagen: vacio,
      reason: `docker inspect ${id}: ${insp.err || "falló"}`,
    };
  }
  const [nombreCrudo, runningImageId, referencia] = insp.out.split("\t").map((s) => (s ?? "").trim());
  const nombre = nombreCrudo.replace(/^\//, "");
  if (!runningImageId || !referencia) {
    return {
      nombre,
      runningImageId: runningImageId || null,
      referencia: referencia || null,
      imagenResoluble: false,
      idDeLaReferencia: null,
      envImagen: vacio,
      labelsImagen: vacio,
      reason: "docker inspect no devolvió identidad de imagen",
    };
  }

  // (a) EXISTENCIA de la image ID en ejecución.
  const meta = run("docker", [
    "image",
    "inspect",
    runningImageId,
    "-f",
    "{{json .Config.Env}}\t{{json .Config.Labels}}",
  ]);
  const imagenResoluble = meta.rc === 0;
  const [envJson, labelsJson] = imagenResoluble ? meta.out.split("\t") : [null, null];

  // (c) ¿A qué imagen resuelve HOY la referencia declarada?
  const porRef = run("docker", ["image", "inspect", referencia, "-f", "{{.Id}}"]);
  const idDeLaReferencia = porRef.rc === 0 && porRef.out.trim() !== "" ? porRef.out.trim() : null;

  return {
    nombre,
    runningImageId,
    referencia,
    imagenResoluble,
    idDeLaReferencia,
    // (d) pin del despliegue, si el operador lo ha declarado para ese servicio.
    digestEsperado: pines[nombre] ?? null,
    envImagen: imagenResoluble ? parseKeyValueList(envJson ?? "[]") : vacio,
    labelsImagen: imagenResoluble ? parseKeyValueList(labelsJson ?? "{}") : vacio,
  };
}

export function clasificarDaemon(run = (c, a) => sh(c, a), pines = {}) {
  const ps = run("docker", ["ps", "-q"]);
  if (ps.rc !== 0) throw new Error(`docker ps: ${ps.err || "falló"}`);
  return ps.out
    .split("\n")
    .filter(Boolean)
    .map((id) => clasificarDrift(observarContenedor(id, run, pines)));
}

// ── Calibración ──────────────────────────────────────────────────────────────
// El detector tiene que poder ponerse ROJO. Se le dan los cuatro estados
// fabricados; si alguno no sale como debe, este script falla AQUÍ y no en
// producción seis meses después.
function autoprueba() {
  const idA = "sha256:" + "a".repeat(64);
  const idB = "sha256:" + "b".repeat(64);
  const casos = [
    [
      RUNTIME_MATCH,
      {
        nombre: "sano",
        runningImageId: idA,
        referencia: "s9arena/api:4d469dc",
        imagenResoluble: true,
        idDeLaReferencia: idA,
      },
    ],
    [
      IMAGE_MISSING,
      {
        nombre: "huerfano",
        runningImageId: idB,
        referencia: "s9arena/replay-service:4d469dc",
        imagenResoluble: false,
        idDeLaReferencia: null,
      },
    ],
    [
      TAG_MOVED,
      {
        nombre: "etiqueta-movida",
        runningImageId: idA,
        referencia: "postgres:16-alpine",
        imagenResoluble: true,
        idDeLaReferencia: idB,
      },
    ],
    [
      TAG_CONTENT_MISMATCH,
      {
        nombre: "etiqueta-mentirosa",
        runningImageId: idA,
        referencia: "s9arena/web:4d469dc",
        imagenResoluble: true,
        idDeLaReferencia: idA,
        envImagen: { BUILD_COMMIT: "98f381ecdeadbeef00000000000000000000cafe" },
        labelsImagen: {},
      },
    ],
  ];

  for (const [esperado, obs] of casos) {
    const c = clasificarDrift(obs);
    if (c.estado !== esperado) {
      console.error(`autoprueba: el caso "${obs.nombre}" salió ${c.estado} y debía salir ${esperado}`);
      return 1;
    }
  }

  // Control específico del defecto corregido: una imagen SIN etiquetas de nivel
  // superior (la que `docker images -q` omite) es resoluble y NO es huérfana.
  const sinRepoTags = clasificarDrift({
    nombre: "postgres-como-en-VM108",
    runningImageId: idA,
    referencia: "postgres:16-alpine",
    imagenResoluble: true, // `docker image inspect` la resuelve
    idDeLaReferencia: idB, // la etiqueta ya apunta a otra
  });
  if (sinRepoTags.runtimeImageExists !== true || sinRepoTags.estado !== TAG_MOVED) {
    console.error(
      "autoprueba: el caso real de VM108 (imagen sin RepoTags, etiqueta movida) no se clasifica como TAG_MOVED " +
        "con la imagen existente — el defecto de `docker images -q` ha vuelto",
    );
    return 1;
  }

  // Y una imagen sin identidad embebida NUNCA se da por verificada.
  if (sinRepoTags.procedencia !== "not_exercised") {
    console.error("autoprueba: una imagen sin identidad embebida se está dando por verificada");
    return 1;
  }

  console.log("autoprueba OK · los cuatro estados se clasifican y el caso sin RepoTags no da falso IMAGE_MISSING");
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return autoprueba();

  const clasificaciones = clasificarDaemon();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(clasificaciones, null, 2));
  }

  const conDrift = clasificaciones.filter((c) => c.estado !== RUNTIME_MATCH);
  for (const c of clasificaciones) {
    const marca = c.estado === RUNTIME_MATCH ? "✓" : "✗";
    console.log(`${marca} ${c.nombre}: ${c.estado ?? "not_exercised"} · ${c.explicacion}`);
  }
  if (conDrift.length === 0) {
    console.log(`OK · los ${clasificaciones.length} contenedores en marcha están en RUNTIME_MATCH`);
    return 0;
  }

  console.error("");
  console.error(`DRIFT · ${conDrift.length} de ${clasificaciones.length} contenedores no están en RUNTIME_MATCH:`);
  for (const c of conDrift) {
    console.error("");
    for (const l of lineasInforme(c)) console.error(`  ${l}`);
  }
  console.error("");
  console.error(
    `Resumen: ${resumen(clasificaciones)}. Este script NO corrige nada: dice qué hay. ` +
      "Anclar un digest o reconstruir es una decisión del operador, con su ventana.",
  );
  return 1;
}

export function resumen(clasificaciones) {
  const cuenta = new Map();
  for (const c of clasificaciones) {
    const k = c.estado ?? "not_exercised";
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
}

export { corto, IMAGE_MISSING, TAG_CONTENT_MISMATCH, TAG_MOVED, RUNTIME_MATCH };

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
