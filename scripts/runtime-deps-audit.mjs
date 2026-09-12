/**
 * AUDITORÍA DE DEPENDENCIAS DE RUNTIME.
 *
 * Pregunta que responde: ¿qué paquetes externos alcanza de verdad el código que se
 * ejecuta en producción, y están declarados donde deben?
 *
 * Importa porque hoy la imagen se construye con `npm ci` SIN `--omit=dev`, así que un
 * paquete de runtime declarado en `devDependencies` funciona igual — hasta el día que
 * alguien reduzca la imagen y el servicio deje de arrancar. Cuando se destapó el caso de
 * `multer` (importado desde las rutas de subida y declarado como dev), el recuento real
 * era de DIEZ paquetes en esa situación, `express` y `knex` incluidos.
 *
 * El alcance se calcula siguiendo los imports desde los ENTRYPOINTS que el compose declara
 * (`SERVICE_ENTRY`), no por nombre de carpeta ni por heurística: un paquete sólo cuenta
 * como runtime si un entrypoint productivo llega hasta él.
 *
 * Detalle que hace falta acertar: en ESM + TypeScript un import se escribe `./app.js` y
 * apunta al fuente `./app.ts`. Sin esa reescritura el recorrido muere en el primer salto y
 * la auditoría «no encuentra nada» — un falso negativo que se lee como árbol limpio.
 *
 * Uso:
 *   node scripts/runtime-deps-audit.mjs          # informe legible, sale 1 si hay hallazgos
 *   node scripts/runtime-deps-audit.mjs --json   # el mismo informe en JSON
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

/** Entrypoints productivos: los `SERVICE_ENTRY` por defecto del compose. */
export const ENTRYPOINTS = Object.freeze([
  "apps/api/src/server.ts",
  "apps/arena-engine/src/service.ts",
  "apps/tournament-worker/src/main.ts",
  "apps/bot-manager/src/main.ts",
  "apps/bot-manager/src/build-worker-main.ts",
  "apps/map-service/src/main.ts",
  "apps/replay-service/src/main.ts",
]);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

/** `./app.js` → `./app.ts`; también index y extensión omitida. */
function resolverRelativo(desde, mod) {
  const candidatos = [mod];
  if (mod.endsWith(".js")) candidatos.push(mod.slice(0, -3));
  if (mod.endsWith(".jsx")) candidatos.push(mod.slice(0, -4));
  for (const cand of candidatos) {
    const base = normalize(join(dirname(desde), cand));
    for (const suf of [".ts", ".tsx", "/index.ts", "/index.tsx", ".js", ""]) {
      const p = base + suf;
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return null;
}

/** Nombre de paquete a partir de un especificador (`foo/bar` → `foo`, `@a/b/c` → `@a/b`). */
export function nombrePaquete(mod) {
  return mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0];
}

/** Nombres de los workspaces internos: no son dependencias externas. */
function workspaces(raiz = ".") {
  const nombres = new Set();
  for (const dir of ["packages", "sdks"]) {
    const d = join(raiz, dir);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      const p = join(d, n, "package.json");
      if (!existsSync(p)) continue;
      try {
        nombres.add(JSON.parse(readFileSync(p, "utf8")).name);
      } catch {
        /* un package.json ilegible no convierte un paquete externo en interno */
      }
    }
  }
  return nombres;
}

/** Recorre desde los entrypoints y devuelve {externos: Map<pkg, ficheros[]>, alcanzados, ausentes}. */
export function recorrer(entrypoints = ENTRYPOINTS) {
  const vistos = new Set();
  const externos = new Map();
  const ausentes = entrypoints.filter((e) => !existsSync(e));
  const pila = entrypoints.filter((e) => existsSync(e));
  while (pila.length) {
    const f = pila.pop();
    if (vistos.has(f)) continue;
    vistos.add(f);
    let texto;
    try {
      texto = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(texto)) !== null) {
      const mod = m[1] ?? m[2] ?? m[3];
      if (!mod) continue;
      if (mod.startsWith(".") || mod.startsWith("/")) {
        const r = resolverRelativo(f, mod);
        if (r) pila.push(r);
      } else if (!mod.startsWith("node:")) {
        const pkg = nombrePaquete(mod);
        if (!externos.has(pkg)) externos.set(pkg, new Set());
        externos.get(pkg).add(f);
      }
    }
  }
  return { externos, alcanzados: vistos, ausentes };
}

/** Clasifica lo alcanzado contra el package.json de la raíz. */
export function auditar(raiz = ".") {
  const pkg = JSON.parse(readFileSync(join(raiz, "package.json"), "utf8"));
  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
  const internos = workspaces(raiz);
  const { externos, alcanzados, ausentes } = recorrer();

  const malClasificados = [];
  const sinDeclarar = [];
  const correctos = [];
  for (const [p, ficheros] of [...externos].sort(([a], [b]) => a.localeCompare(b))) {
    if (internos.has(p)) continue;
    const detalle = { paquete: p, ficheros: [...ficheros].sort() };
    if (deps.has(p)) correctos.push(detalle);
    else if (dev.has(p)) malClasificados.push(detalle);
    else sinDeclarar.push(detalle);
  }
  return {
    entrypointsAusentes: ausentes,
    ficherosAlcanzados: alcanzados.size,
    malClasificados,
    sinDeclarar,
    correctos,
  };
}

function main() {
  const r = auditar(".");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`ficheros alcanzados desde ${ENTRYPOINTS.length} entrypoints: ${r.ficherosAlcanzados}`);
    if (r.entrypointsAusentes.length) console.log(`  entrypoints no encontrados: ${r.entrypointsAusentes.join(", ")}`);
    console.log(`\nRUNTIME en devDependencies (${r.malClasificados.length}):`);
    for (const d of r.malClasificados) console.log(`  ${d.paquete}\n      ${d.ficheros.slice(0, 2).join("\n      ")}`);
    console.log(`\nsin declarar (${r.sinDeclarar.length}):`);
    for (const d of r.sinDeclarar) console.log(`  ${d.paquete}  ${d.ficheros[0]}`);
    console.log(`\ncorrectamente en dependencies (${r.correctos.length}):`);
    console.log(`  ${r.correctos.map((d) => d.paquete).join(", ")}`);
  }
  process.exit(r.malClasificados.length + r.sinDeclarar.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
