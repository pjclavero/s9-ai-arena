/**
 * R2.3 (ERR-GES-04) · Detección de los tests que exigen PostgreSQL.
 *
 * El criterio es el MISMO por el que fallan en Windows: usar `startTestDb`
 * (apps/api/src/testing/test-db.ts), que arranca embedded-postgres (pg_ctl).
 * Se detecta por contenido, no por lista manual: un test nuevo que llame a
 * `startTestDb` queda etiquetado como test de BD automáticamente, sin tocar
 * ninguna configuración. Falla cerrado: si el escaneo no encuentra ninguno,
 * `vitest.db.config.ts` lanza en vez de dar verde en vacío.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Mismas raíces que el `include` de vitest.config.ts.
const ROOTS = ["apps", "packages", "sdks", "example-bots", "infrastructure", "tests"];
const MARKER = "startTestDb";

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Devuelve las rutas (relativas a la raíz del repo, con separador POSIX)
 * de todos los ficheros de test que usan `startTestDb`.
 */
export function listDbTests(rootDir = new URL("..", import.meta.url).pathname) {
  const files = [];
  for (const root of ROOTS) walk(join(rootDir, root), files);
  return files
    .filter((f) => readFileSync(f, "utf8").includes(MARKER))
    .map((f) => relative(rootDir, f).split(sep).join("/"))
    .sort();
}
