#!/usr/bin/env node
/**
 * Lint de determinismo (T2.1, endurecido en R2.7 / ERR-ENG-02).
 *
 * Prohíbe cualquier fuente de no-determinismo en el código del motor. No es un consejo
 * de estilo: una sola llamada a Date.now() dentro de la lógica de juego rompe los
 * replays, la auditoría de torneos y la reproducibilidad del balance, y lo hace
 * SILENCIOSAMENTE — la batalla sigue corriendo, solo que ya no se puede volver a
 * ejecutar igual.
 *
 * CARGA INVERTIDA (ERR-ENG-02): antes se vigilaba solo src/sim/ y quedaban fuera
 * rng.ts, replay.ts, stubs.ts y fixtures.ts — un Math.random() en el PROPIO RNG
 * pasaba la CI en verde. Ahora se vigila TODO src/ y lo exento está en una lista de
 * exclusión explícita y comentada: un fichero nuevo queda vigilado por defecto.
 *
 * Por eso falla el build, y no solo avisa.
 *
 * Uso: node scripts/lint-determinism.mjs [--self-test] [--dir <ruta>]
 *   --dir apunta el lint a otro directorio (lo usan los tests para probar que muerde).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const dirFlag = process.argv.indexOf("--dir");
const SRC_DIR = dirFlag >= 0 && process.argv[dirFlag + 1] ? process.argv[dirFlag + 1] : join(ROOT, "src");

/**
 * LISTA DE EXCLUSIÓN. Cada entrada existe por un motivo concreto y auditado; añadir
 * una nueva exige justificarla aquí mismo. Todo lo que NO esté en esta lista —incluido
 * cualquier fichero futuro— se vigila.
 */
const EXCLUDED_FILES = new Set([
  // Servidor WebSocket: timeouts de RED (deadline de decisión, grace de desconexión).
  // Mide el tiempo de la infraestructura, no el de la simulación: el juego avanza en ticks.
  "protocol-server.ts",
  // Entrypoint de proceso (CLI): reloj de pared para nombres de archivo y logging.
  "cli.ts",
  // Única fuente sancionada de reloj de pared para METADATOS (recordedAt del replay,
  // ids locales). Nada de lo que exporta puede entrar en la lógica de tick.
  "wall-clock.ts",
]);

/** Los tests dentro de src/ (p. ej. protocol-server.test.ts) usan timers legítimamente. */
const EXCLUDED_PATTERNS = [/\.test\.(ts|js|mjs)$/];

function isExcluded(file) {
  const name = basename(file);
  return EXCLUDED_FILES.has(name) || EXCLUDED_PATTERNS.some((p) => p.test(name));
}

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
    why: "El tiempo de juego se mide en TICKS, no en milisegundos de pared. Usa this.tick (o wall-clock.ts si es un metadato).",
  },
  {
    pattern: /\bnew\s+Date\s*\(/g,
    name: "new Date()",
    why: "El reloj del sistema no puede influir en la simulación. Usa this.tick (o wall-clock.ts si es un metadato).",
  },
  {
    pattern: /\bperformance\s*\.\s*now\s*\(/g,
    name: "performance.now()",
    why: "Solo para benchmarks, jamás dentro de src/. Usa this.tick.",
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
    .replace(/\/\*[\s\S]*?\*\//g, " ") // bloque
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ") // línea (sin romper las URLs http://)
    .replace(/`(?:\\.|[^`\\])*`/g, "``") // plantillas
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

  const all = walk(SRC_DIR);
  const files = all.filter((f) => !isExcluded(f));
  const violations = files.flatMap(lintFile);

  if (selfTest) {
    // Demuestra que la regla MUERDE: si no detecta código malo, la regla no vale nada.
    const bad = `export function tick() { const r = Math.random(); const t = Date.now(); return r + t; }`;
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmp = join(SRC_DIR, "__lint_self_test__.ts");
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
    const excluded = all.length - files.length;
    console.log(
      `lint de determinismo OK · ${files.length} archivos de src/ sin fuentes de no-determinismo ` +
        `(${excluded} excluidos por lista explícita)`,
    );
    process.exit(0);
  }

  console.error(`\nDETERMINISMO ROTO · ${violations.length} violación(es) en src/:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
    console.error(`      ${v.why}\n`);
  }
  console.error("El build falla: la simulación DEBE ser reproducible bit a bit.\n");
  process.exit(1);
}

main();
