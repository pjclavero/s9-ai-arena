#!/usr/bin/env node
/**
 * V1 ADM-SETUP · REV352-01 · Preflight de despliegue: ¿existen todos los ficheros de secreto que declara
 * el compose? (`secrets: <nombre>: file: ./secrets/…`). Compose no arranca un servicio cuyo secreto no
 * existe; esto lo dice ANTES del `up`, con el nombre del fichero y qué hacer.
 *
 * NO lee el contenido de ningún secreto: sólo `lstat` (tipo regular y existencia). Un enlace simbólico
 * cuenta como fallo (init-secrets.sh nunca los crea). Un fichero vacío es válido (p. ej. `stream_key.txt`
 * sin streaming, o `setup_token.txt` vaciado a propósito para cerrar el asistente).
 *
 *   node infrastructure/scripts/check-secrets.mjs [--compose infrastructure/docker-compose.yml]
 *
 * rc 0 = todos presentes · rc 1 = falta alguno (los lista) · rc 2 = compose ilegible (NO COMPROBADO).
 */
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** Ficheros de secreto declarados en el compose, resueltos contra su directorio. */
export function secretFiles(composePath) {
  const doc = parse(readFileSync(composePath, "utf8"));
  const base = dirname(resolve(composePath));
  return Object.entries(doc?.secrets ?? {})
    .filter(([, v]) => v && typeof v.file === "string")
    .map(([name, v]) => ({ name, path: resolve(base, v.file) }));
}

/** @returns {{ok: boolean, missing: {name: string, path: string, why: string}[]}} */
export function checkSecrets(composePath) {
  const missing = [];
  for (const s of secretFiles(composePath)) {
    let st;
    try {
      st = lstatSync(s.path);
    } catch {
      missing.push({ ...s, why: "no existe" });
      continue;
    }
    if (st.isSymbolicLink()) missing.push({ ...s, why: "es un enlace simbólico" });
    else if (!st.isFile()) missing.push({ ...s, why: "no es un fichero regular" });
  }
  return { ok: missing.length === 0, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--compose");
  const here = dirname(fileURLToPath(import.meta.url));
  const compose = i > 0 ? process.argv[i + 1] : resolve(here, "../docker-compose.yml");
  let r;
  try {
    r = checkSecrets(compose);
  } catch (e) {
    console.error(`check-secrets: NO COMPROBADO, no se pudo leer ${compose} (${e?.code ?? e?.name ?? "error"})`);
    process.exit(2);
  }
  if (r.ok) {
    console.log("check-secrets: OK, todos los ficheros de secreto del compose existen");
    process.exit(0);
  }
  for (const m of r.missing) console.error(`check-secrets: FALTA ${m.name} → ${m.path} (${m.why})`);
  console.error("check-secrets: ejecuta infrastructure/scripts/init-secrets.sh (idempotente) antes de desplegar");
  process.exit(1);
}
