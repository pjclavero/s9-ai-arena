#!/usr/bin/env node
/**
 * ADR-016 · Verificador de procedencia de imagen.
 *
 * Comprueba las TRES coherencias que el gate anterior no comprobaba, sobre una
 * imagen concreta y el commit que se dice que contiene:
 *
 *   1. ETIQUETA  — el tag de la imagen nombra ese commit.
 *   2. METADATA  — org.opencontainers.image.revision (LABEL OCI) = ese commit,
 *                  y org.opencontainers.image.title = ese servicio.
 *   3. RUNTIME   — GET /version del contenedor en marcha = ese commit.
 *
 * Por qué las tres: el gate viejo comparaba "imagen declarada == imagen
 * desplegada", que es una tautología cuando la ETIQUETA MIENTE (un build del
 * árbol viejo etiquetado con el commit nuevo pasó cuatro servicios en verde).
 * (2) rompe la tautología sin arrancar nada; (3) prueba que lo que corre es esa
 * imagen y no otra cosa que se le parece.
 *
 * Uso:
 *   node infrastructure/scripts/verify-image-provenance.mjs \
 *     --image ghcr.io/…/replay-service:sha-abc123 \
 *     --commit abc123 --service replay-service [--port 8083] [--no-runtime]
 *
 * Sale con 0 solo si TODAS las comprobaciones aplicables pasan. Cualquier fallo
 * es exit 1 con el motivo en una línea (no hay "amarillo" aquí: o la imagen es
 * la que dice ser o no lo es).
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Etiquetas OCI que este contrato exige. */
export const LABEL_REVISION = "org.opencontainers.image.revision";
export const LABEL_TITULO = "org.opencontainers.image.title";

/**
 * Núcleo puro de la verificación: ninguna E/S, así se puede probar (y MUTAR) en
 * la suite sin Docker. Devuelve la lista de fallos; vacía = coherente.
 *
 * `tag` es la parte de la referencia de imagen tras el último ':'.
 */
export function comprobarCoherencia({ tag, labels, runtime, commit, service }) {
  const fallos = [];
  const esperado = String(commit ?? "").trim();
  if (!esperado || esperado === "unknown") {
    fallos.push("commit esperado vacío o 'unknown': no hay nada que verificar (y eso ya es el defecto)");
    return fallos;
  }

  if (!tag || !esperado.startsWith(normalizar(tag))) {
    fallos.push(`etiqueta: el tag "${tag}" no nombra el commit ${corto(esperado)}`);
  }

  const revision = String(labels?.[LABEL_REVISION] ?? "").trim();
  if (!revision) {
    fallos.push(`metadata: la imagen no trae ${LABEL_REVISION} (se construyó sin identidad de build)`);
  } else if (revision !== esperado) {
    fallos.push(
      `metadata: ${LABEL_REVISION}=${corto(revision)} pero se esperaba ${corto(esperado)} — ` +
        "la ETIQUETA y el CONTENIDO no coinciden (es el incidente del árbol viejo etiquetado como nuevo)",
    );
  }

  const titulo = String(labels?.[LABEL_TITULO] ?? "").trim();
  if (service && titulo !== service) {
    fallos.push(`metadata: ${LABEL_TITULO}="${titulo}" pero se esperaba "${service}"`);
  }

  if (runtime !== undefined && runtime !== null) {
    const rc = String(runtime.commit ?? "").trim();
    if (rc !== esperado) {
      fallos.push(`runtime: /version dice commit=${corto(rc) || "(vacío)"} pero se esperaba ${corto(esperado)}`);
    }
    if (service && String(runtime.service ?? "") !== service) {
      fallos.push(`runtime: /version dice service="${runtime.service}" pero se esperaba "${service}"`);
    }
    for (const prohibido of ["hostname", "host", "ip", "path", "env", "secret", "token", "password"]) {
      if (Object.keys(runtime).some((k) => k.toLowerCase().includes(prohibido))) {
        fallos.push(`runtime: /version expone el campo "${prohibido}" — el contrato prohíbe cualquier dato de entorno`);
      }
    }
  }

  return fallos;
}

function normalizar(tag) {
  // Los tags del proyecto son "<commit corto>" o "sha-<commit completo>".
  return String(tag).replace(/^sha-/, "");
}

function corto(c) {
  return String(c ?? "").slice(0, 12);
}

// ── Ejecución real (Docker) ──────────────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  // Nunca se confía en el $? implícito de una tubería: se captura y se mira.
  return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function labelsDeImagen(image) {
  const r = sh("docker", ["image", "inspect", "-f", "{{json .Config.Labels}}", image]);
  if (r.rc !== 0) throw new Error(`docker image inspect ${image}: ${r.err || "falló"}`);
  return JSON.parse(r.out || "{}") ?? {};
}

/** Arranca la imagen, lee /version y la para SIEMPRE (finally). */
export function runtimeDeImagen(image, puerto, env = []) {
  const nombre = `provenance-${randomUUID().slice(0, 8)}`;
  const entorno = env.flatMap((e) => ["-e", e]);
  // Sin --rm: si el proceso muere al arrancar (una conf que no valida, un
  // SERVICE_ENTRY ausente…) queremos poder LEER SUS LOGS. El borrado va en el
  // finally, que se ejecuta pase lo que pase.
  const arranque = sh("docker", ["run", "-d", "--name", nombre, ...entorno, image]);
  if (arranque.rc !== 0) throw new Error(`docker run ${image}: ${arranque.err || "falló"}`);
  try {
    for (let intento = 1; intento <= 30; intento++) {
      const r = sh("docker", [
        "exec",
        nombre,
        "sh",
        "-c",
        `wget -qO- http://127.0.0.1:${puerto}/version 2>/dev/null || true`,
      ]);
      if (r.rc === 0 && r.out.startsWith("{")) return JSON.parse(r.out);
      // Si el contenedor ya no está vivo, esperar 60 s no lo va a resucitar: se
      // corta con los logs a la vista (fallo rápido, no un cuelgue opaco).
      const vivo = sh("docker", ["inspect", "-f", "{{.State.Running}}", nombre]);
      if (vivo.out !== "true") {
        const logs = sh("docker", ["logs", "--tail", "30", nombre]);
        throw new Error(`${image}: el contenedor murió al arrancar. Logs:\n${logs.out}\n${logs.err}`);
      }
      // Progreso observable: si esto acaba agotándose, el log dice por dónde iba.
      process.stderr.write(`  · esperando /version en ${image} (intento ${intento}/30)\n`);
      sh("sh", ["-c", "sleep 2"]);
    }
    const logs = sh("docker", ["logs", "--tail", "20", nombre]);
    throw new Error(`${image}: /version no respondió en 60 s. Últimas líneas:\n${logs.out}\n${logs.err}`);
  } finally {
    sh("docker", ["rm", "-f", nombre]);
  }
}

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const image = arg("image");
  const commit = arg("commit");
  const service = arg("service");
  const puerto = arg("port");
  const sinRuntime = argv.includes("--no-runtime");
  // --env KEY=VAL, repetible: algunas imágenes necesitan su SERVICE_ENTRY para
  // arrancar sueltas (fuera del Compose). Nunca se pasan secretos por aquí.
  const env = argv.flatMap((a, i) => (a === "--env" ? [argv[i + 1]] : []));
  if (!image || !commit || !service) {
    console.error("uso: --image <ref> --commit <sha> --service <nombre> [--port <n>] [--env K=V]… [--no-runtime]");
    return 2;
  }

  const tag = image.slice(image.lastIndexOf(":") + 1);
  const labels = labelsDeImagen(image);
  const runtime = sinRuntime ? undefined : runtimeDeImagen(image, puerto ?? "8080", env);

  const fallos = comprobarCoherencia({ tag, labels, runtime, commit, service });
  if (fallos.length > 0) {
    console.error(`DRIFT · ${image} no es coherente con ${corto(commit)}:`);
    for (const f of fallos) console.error(`  ✗ ${f}`);
    return 1;
  }
  console.log(
    `OK · ${service}: tag=${tag}, ${LABEL_REVISION}=${corto(labels[LABEL_REVISION])}` +
      (runtime ? `, /version=${corto(runtime.commit)}` : ", runtime no comprobado (--no-runtime)"),
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
