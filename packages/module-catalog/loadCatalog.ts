/**
 * Carga el catálogo de datos de packages/module-catalog/data/*.json.
 *
 * Uso exclusivo de tests, scripts de balance y del script de validación de E1
 * (validate-catalog.js) — NUNCA del validador de ensamblaje (validator/index.ts),
 * que debe seguir siendo puro y recibir el catálogo ya cargado como parámetro.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ModuleDefinition } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "data");

export function loadCatalog(dir: string = DATA_DIR): ModuleDefinition[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ModuleDefinition)
    .sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
}

/** catalogVersion congelado para el MVP (cap. 10.4): id de temporada, no de módulo. */
export const CATALOG_VERSION = "mvp@1";
