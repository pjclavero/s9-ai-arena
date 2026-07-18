#!/usr/bin/env node
/**
 * T5.3 · Genera sdks/shared-contract-tests/cases/*.json a partir de la ÚNICA fuente
 * de verdad: packages/protocol/examples/{valid,invalid} de E1. No se escriben casos
 * a mano aquí para evitar que la suite compartida diverja del corpus real de E1 (la
 * misma razón por la que los tipos TS "no se escriben a mano", cap. de README de E1).
 *
 * Cada caso queda como { name, kind: "valid"|"invalid", why?, envelope }. Ambos SDKs
 * (Python y JS) leen estos MISMOS archivos — no hay una copia por lenguaje.
 *
 * Uso: node generate-cases.mjs   (regenera cases/ desde examples/, determinista)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..", "..", "packages", "protocol", "examples");
const OUT_DIR = join(__dirname, "cases");

mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (const kind of ["valid", "invalid"]) {
  const dir = join(EXAMPLES_DIR, kind);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const { _why, ...envelope } = doc;
    const name = file.replace(/\.json$/, "");
    const caseDoc = { name, kind, ...(kind === "invalid" ? { why: _why } : {}), envelope };
    writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(caseDoc, null, 2) + "\n");
    count++;
  }
}
console.log(`${count} casos escritos en ${OUT_DIR}`);
