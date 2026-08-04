/**
 * B13 · Toda importación a `packages/` tiene que estar DENTRO de la imagen.
 *
 * Defecto real, encontrado el 2026-07-27 y no por casualidad: B8 añadió a
 * `apps/streamer/src/metrics.ts` un `import … from
 * "../../../packages/game-rules/safe-lookup.js"`, pero el Dockerfile del
 * streamer solo copiaba `apps/streamer`. La imagen se construía y arrancaba, y
 * reventaba al cargar el módulo:
 *
 *   Error: Cannot find module '../../../packages/game-rules/safe-lookup.js'
 *
 * Nadie lo vio porque hasta B13 la imagen del streamer NO la construía ninguna
 * CI. Es la octava vez en este proyecto que un cambio correcto en el monorepo
 * rompe la imagen construida (example-bots ausente, apps/bot-manager ausente,
 * python3 ausente, acorn ausente, la SPA construida con el Dockerfile
 * equivocado…).
 *
 * Este test cierra la CLASE, no el caso: para cada servicio con `build:` en el
 * Compose, extrae del CÓDIGO los paquetes que importa de verdad y exige que su
 * Dockerfile los copie. Si mañana alguien añade un import nuevo a un paquete
 * que la imagen no trae, esto se pone rojo antes de llegar a producción.
 *
 * No sustituye a construir la imagen (eso lo hace la matriz `build-images`):
 * es la red que atrapa el caso en segundos, sin demonio Docker.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const COMPOSE = join(REPO, "infrastructure", "docker-compose.yml");

/** Importaciones relativas que salen del app y entran en `packages/<nombre>`. */
const IMPORT_A_PAQUETE = /(?:\.\.\/)+packages\/([a-z0-9-]+)\//g;

function ficherosTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entrada of readdirSync(dir)) {
    // node_modules es un symlink al árbol del monorepo: no es código del app.
    if (entrada === "node_modules" || entrada === "dist") continue;
    const p = join(dir, entrada);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...ficherosTs(p));
    else if (/\.(ts|tsx|mts)$/.test(entrada)) out.push(p);
  }
  return out;
}

/** Paquetes que el código de `appPath` importa de verdad (no los declarados). */
function paquetesImportados(appPath: string): Set<string> {
  const paquetes = new Set<string>();
  for (const f of ficherosTs(join(REPO, appPath, "src"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(IMPORT_A_PAQUETE)) paquetes.add(m[1]);
  }
  return paquetes;
}

/**
 * Rutas de `packages/` que un Dockerfile copia. Se leen las INSTRUCCIONES, no
 * el texto: un `COPY` comentado no copia nada (lección de B7/D1, donde un
 * guard-rail que leía texto crudo se dejaba engañar por un comentario).
 */
function paquetesCopiados(dockerfile: string): Set<string> {
  const copiados = new Set<string>();
  const texto = readFileSync(join(REPO, dockerfile), "utf8");
  let acumulada: string | null = null;
  for (const cruda of texto.split("\n")) {
    const linea = cruda.trimEnd();
    if (acumulada === null && (linea.trim() === "" || linea.trim().startsWith("#"))) continue;
    const continua = linea.endsWith("\\");
    acumulada = (acumulada === null ? "" : acumulada + "\n") + (continua ? linea.slice(0, -1) : linea);
    if (continua) continue;
    const instruccion = acumulada;
    acumulada = null;
    if (!/^COPY\s/i.test(instruccion)) continue;
    // `COPY packages /app/packages` trae el árbol entero.
    if (/\bpackages\s/.test(instruccion) || /\bpackages\/\s/.test(instruccion)) copiados.add("*");
    for (const m of instruccion.matchAll(/\bpackages\/([a-z0-9-]+)/g)) copiados.add(m[1]);
    // `COPY apps ...` / `COPY . ...` traen todo el repo.
    if (/^COPY\s+\.\s/i.test(instruccion)) copiados.add("*");
  }
  return copiados;
}

interface Servicio {
  nombre: string;
  dockerfile: string;
  appPath: string;
}

/** Servicios con `build:` cuyo código vive en `apps/<nombre>`. */
function serviciosConCodigo(): Servicio[] {
  const doc = parse(readFileSync(COMPOSE, "utf8"), { merge: true });
  const out: Servicio[] = [];
  for (const [nombre, def] of Object.entries<any>(doc.services ?? {})) {
    const dockerfile: string | undefined = def.build?.dockerfile;
    if (!dockerfile) continue;
    const appPath = `apps/${nombre}`;
    if (!existsSync(join(REPO, appPath, "src"))) continue;
    out.push({ nombre, dockerfile, appPath });
  }
  return out;
}

describe("B13 · los paquetes que el código importa están DENTRO de la imagen", () => {
  const servicios = serviciosConCodigo();

  it("hay servicios que analizar (si esto falla, el test se ha quedado ciego)", () => {
    expect(servicios.length).toBeGreaterThanOrEqual(5);
  });

  it.each(servicios)("$nombre copia todo packages/ que importa", ({ nombre, dockerfile, appPath }) => {
    const importados = paquetesImportados(appPath);
    const copiados = paquetesCopiados(dockerfile);
    if (copiados.has("*")) return; // copia el árbol entero: nada que comprobar
    const faltan = [...importados].filter((p) => !copiados.has(p));
    expect(
      faltan,
      `${nombre}: ${appPath}/src importa packages/${faltan.join(", packages/")} y ${dockerfile} no los copia. ` +
        `La imagen se construye pero revienta al cargar el módulo (ERR_MODULE_NOT_FOUND).`,
    ).toEqual([]);
  });

  it("el streamer importa game-rules de verdad (el caso que originó este test)", () => {
    // Ancla: si alguien quita ese import, este test deja de proteger nada y
    // hay que enterarse, en vez de quedarse en verde por vacuidad.
    expect(paquetesImportados("apps/streamer")).toContain("game-rules");
  });
});
