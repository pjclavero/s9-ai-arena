#!/usr/bin/env node
/**
 * Lint de determinismo (T2.1).
 *
 * Prohíbe en src/sim/ cualquier fuente de no-determinismo. No es un consejo de estilo:
 * una sola llamada a Date.now() dentro de la lógica de juego rompe los replays, la
 * auditoría de torneos y la reproducibilidad del balance, y lo hace SILENCIOSAMENTE —
 * la batalla sigue corriendo, solo que ya no se puede volver a ejecutar igual.
 *
 * Por eso falla el build, y no solo avisa.
 *
 * Uso: node scripts/lint-determinism.mjs [--self-test]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SIM_DIR = join(ROOT, "src", "sim");

/** Cada regla explica POR QUÉ, para que quien la vea saltar sepa qué hacer. */
const FORBIDDEN = [
  {
    pattern: /\bMath\s*\.\s*random\s*\(/g,
    name: "Math.random()",
    why: "Usa el Rng con semilla del motor (this.rng / el Rng inyectado). Math.random no es reproducible.",
  },
  {
    pattern: /\bDate\s*\.\s*now\s*\(/g,
    name: "Date.now()",
    why: "El tiempo de juego se mide en TICKS, no en milisegundos de pared. Usa this.tick.",
  },
  {
    pattern: /\bnew\s+Date\s*\(/g,
    name: "new Date()",
    why: "El reloj del sistema no puede influir en la simulación. Usa this.tick.",
  },
  {
    pattern: /\bperformance\s*\.\s*now\s*\(/g,
    name: "performance.now()",
    why: "Solo para benchmarks, jamás dentro de src/sim. Usa this.tick.",
  },
  {
    pattern: /\bprocess\s*\.\s*hrtime\b/g,
    name: "process.hrtime",
    why: "Reloj de alta resolución: no puede entrar en la lógica de juego.",
  },
  {
    pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/g,
    name: "crypto.randomUUID()",
    why: "Los ids de entidad se derivan de un contador determinista (entitySeq), no de UUIDs aleatorios.",
  },
  {
    pattern: /\bcrypto\s*\.\s*getRandomValues\s*\(/g,
    name: "crypto.getRandomValues()",
    why: "Aleatoriedad no reproducible. Usa el Rng con semilla.",
  },
  {
    pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/g,
    name: "setTimeout/setInterval",
    why: "El bucle es de tick fijo y síncrono. La simulación no espera a nada.",
  },
];

/**
 * Un comentario que MENCIONE Date.now no es una violación. Quitamos comentarios y
 * cadenas antes de buscar, o el propio archivo de reglas se acusaría a sí mismo.
 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // bloque
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // línea (sin romper las URLs http://)
    .replace(/`(?:\\.|[^`\\])*`/g, "``")   // plantillas
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function lintFile(file) {
  const raw = readFileSync(file, "utf8");
  const code = stripCommentsAndStrings(raw);
  const violations = [];

  for (const rule of FORBIDDEN) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(code)) !== null) {
      const line = code.slice(0, m.index).split("\n").length;
      violations.push({ file: relative(ROOT, file), line, name: rule.name, why: rule.why });
    }
  }
  return violations;
}

async function main() {
  const selfTest = process.argv.includes("--self-test");

  const files = walk(SIM_DIR);
  const violations = files.flatMap(lintFile);

  if (selfTest) {
    // Demuestra que la regla MUERDE: si no detecta código malo, la regla no vale nada.
    const bad = `export function tick() { const r = Math.random(); const t = Date.now(); return r + t; }`;
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmp = join(SIM_DIR, "__lint_self_test__.ts");
    writeFileSync(tmp, bad);
    const found = lintFile(tmp);
    unlinkSync(tmp);
    if (found.length < 2) {
      console.error("FALLO DE AUTOCOMPROBACIÓN: el lint no detecta violaciones evidentes.");
      process.exit(2);
    }
    console.log(`autocomprobación OK: el lint detecta ${found.length} violaciones en código deliberadamente malo`);
  }

  if (violations.length === 0) {
    console.log(`lint de determinismo OK · ${files.length} archivos de src/sim sin fuentes de no-determinismo`);
    process.exit(0);
  }

  console.error(`\nDETERMINISMO ROTO · ${violations.length} violación(es) en src/sim:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
    console.error(`      ${v.why}\n`);
  }
  console.error("El build falla: la simulación DEBE ser reproducible bit a bit.\n");
  process.exit(1);
}

main();
