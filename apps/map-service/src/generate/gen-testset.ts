#!/usr/bin/env -S npx tsx
/**
 * Genera el set de 20 mapas procedurales de prueba (semillas 0–19) en maps/procedural/,
 * para que otros equipos los usen. Reproducible: correrlo dos veces produce los mismos
 * archivos byte a byte (el generador es determinista por semilla).
 *
 * Uso: npx tsx apps/map-service/src/generate/gen-testset.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMap } from "./index.js";
import { validateMap, isPublishable } from "../validate/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "..", "..", "maps", "procedural");

mkdirSync(OUT_DIR, { recursive: true });

let valid = 0;
const summary: string[] = [];
for (let i = 0; i < 20; i++) {
  const seed = `test-${i}`;
  const res = generateMap({ widthM: 120, heightM: 80, mode: "capture_the_flag", wallDensity: 0.5, mapId: `proc-test-${i}` }, seed);
  const ok = isPublishable(validateMap(res.map));
  if (ok) valid++;
  writeFileSync(join(OUT_DIR, `proc-test-${i}.json`), JSON.stringify(res.map, null, 2) + "\n");
  summary.push(`  proc-test-${i}: attempts=${res.attempts} valid=${ok} checksum=${res.map.checksum.slice(0, 22)}…`);
}

console.log(`${valid}/20 mapas procedurales válidos, escritos en ${OUT_DIR}`);
console.log(summary.join("\n"));
