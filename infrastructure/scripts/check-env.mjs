#!/usr/bin/env node
/**
 * AUD2-08 · Puerta de etiquetas de imagen del `.env` (falla en CERRADO).
 *
 * `.env.example` ya no trae `TAG=latest`: `latest` no existe en el registro y
 * el `pull` fallaba tarde y con un `manifest unknown` poco claro. Aquí se
 * exige, ANTES de `docker compose pull/up`, una etiqueta publicada:
 *
 *   TAG, BACKUP_TAG   obligatorias; `sha-<7..40 hex>` o `v<semver>`.
 *   <SERVICIO>_TAG    opcionales (override); si traen valor, el mismo formato.
 *
 * Vacía, ausente, `latest` o cualquier otra forma => rc=1 y un mensaje que
 * dice qué variable, qué valor y qué se espera. Fichero ilegible => rc=2
 * (NO COMPROBADO): la ausencia nunca es un aprobado.
 *
 * Como en Compose, una variable ya exportada en el entorno del shell gana a
 * la del fichero; se valida el valor EFECTIVO.
 *
 *   node infrastructure/scripts/check-env.mjs [--file infrastructure/.env]
 *
 * (El flag NO se llama `--env-file`: Node lo interpreta él mismo, también tras el
 * nombre del script, y sale con rc=9 si el fichero no existe.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TAG_VALIDA = /^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/;
export const TAGS_OBLIGATORIAS = ["TAG", "BACKUP_TAG"];

/** Parser mínimo de `.env` (KEY=VALUE, comillas, comentarios `#`). */
export function parseEnv(texto) {
  const env = {};
  for (const linea of texto.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(linea);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'])(.*?)\1/.exec(v);
    v = q ? q[2] : v.replace(/\s+#.*$/, "").trim();
    env[m[1]] = v;
  }
  return env;
}

/** @returns {{ok: boolean, errores: string[]}} */
export function validarEtiquetas(envFichero, envShell = {}) {
  const efectivo = { ...envFichero };
  for (const k of Object.keys(envShell)) if (/_?TAG$/.test(k)) efectivo[k] = envShell[k];
  const errores = [];
  const motivo = (k, v) =>
    v === undefined || v === ""
      ? `${k} está vacía o sin definir`
      : v === "latest"
        ? `${k}=latest no existe en el registro`
        : `${k}=${v} no es una etiqueta publicada`;
  for (const k of TAGS_OBLIGATORIAS) {
    const v = efectivo[k];
    if (v === undefined || !TAG_VALIDA.test(v)) {
      errores.push(`${motivo(k, v)}; se espera sha-<commit> (7-40 hex) o v<X.Y.Z>`);
    }
  }
  for (const [k, v] of Object.entries(efectivo)) {
    if (TAGS_OBLIGATORIAS.includes(k) || !/_TAG$/.test(k) || v === "") continue;
    if (!TAG_VALIDA.test(v)) errores.push(`${motivo(k, v)}; se espera sha-<commit> (7-40 hex) o v<X.Y.Z>`);
  }
  return { ok: errores.length === 0, errores };
}

function main(argv) {
  const i = argv.indexOf("--file");
  const ruta = i >= 0 ? argv[i + 1] : "infrastructure/.env";
  let texto;
  try {
    texto = readFileSync(ruta, "utf8");
  } catch (e) {
    console.error(
      `NO COMPROBADO: no se pudo leer ${ruta} (${e.code ?? e.message}). Copia infrastructure/.env.example y complétalo.`,
    );
    return 2;
  }
  const r = validarEtiquetas(parseEnv(texto), process.env);
  if (!r.ok) {
    console.error(`ETIQUETAS NO VÁLIDAS en ${ruta}:`);
    for (const e of r.errores) console.error(`  - ${e}`);
    console.error(
      "Fija una etiqueta que la CI haya publicado (p. ej. sha-<commit> de main) antes de `docker compose pull`.",
    );
    return 1;
  }
  console.log(`ETIQUETAS OK en ${ruta}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
