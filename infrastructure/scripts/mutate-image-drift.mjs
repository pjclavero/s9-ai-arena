#!/usr/bin/env node
/**
 * ADR-016 · Calibración por MUTACIÓN del clasificador de drift.
 *
 * Una prueba que sólo se ha visto en verde no es evidencia de nada. Este script
 * aplica, una a una, mutaciones al CÓDIGO DE PRODUCCIÓN (no a los tests), corre
 * la suite y exige que la mutación deje ROJA al menos una prueba. Si una
 * mutación sobrevive, la garantía correspondiente no está probada.
 *
 * La mutación 1 es la que importa más: reintroduce `docker images -q` como
 * prueba de existencia, que es exactamente el defecto que había en producción.
 *
 * Uso: node infrastructure/scripts/mutate-image-drift.mjs
 * rc=0 todas las mutaciones murieron · rc=1 alguna sobrevivió.
 *
 * Restaura SIEMPRE los ficheros (finally), incluso si la suite revienta.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const LIB = "infrastructure/scripts/lib/image-drift.mjs";
const CHECK = "infrastructure/scripts/check-running-image-id.mjs";
const SUITE = ["infrastructure/tests/image-drift-states.test.ts", "infrastructure/tests/image-provenance.test.ts"];

/** @type {{nombre: string, fichero: string, de: string, a: string}[]} */
const MUTACIONES = [
  {
    nombre: "existencia con `docker images -q` (EL defecto corregido)",
    fichero: CHECK,
    de: `  const imagenResoluble = meta.rc === 0;`,
    a:
      `  const listado = run("docker", ["images", "--no-trunc", "-q"]);\n` +
      `  const imagenResoluble = listado.out.split("\\n").filter(Boolean).includes(runningImageId);`,
  },
  {
    nombre: "existencia siempre cierta",
    fichero: LIB,
    de: `  const runtimeImageExists = obs.imagenResoluble === true;`,
    a: `  const runtimeImageExists = true;`,
  },
  {
    nombre: "la etiqueta siempre apunta a lo que corre",
    fichero: LIB,
    de: `  const tagPointsToRuntime = obs.idDeLaReferencia === null ? null : obs.idDeLaReferencia === obs.runningImageId;`,
    a: `  const tagPointsToRuntime = obs.idDeLaReferencia === null ? null : true;`,
  },
  {
    nombre: "el pin nunca discrepa",
    fichero: LIB,
    de: `  const pinMatchesRuntime = pin === null ? null : pin === obs.runningImageId;`,
    a: `  const pinMatchesRuntime = pin === null ? null : true;`,
  },
  {
    nombre: "el contenido siempre coincide con la etiqueta (tautología del incidente 1)",
    fichero: LIB,
    de: `  if (embebido !== null && commitEtiqueta !== null && !mismoCommit(embebido, commitEtiqueta)) {`,
    a: `  if (false) {`,
  },
  {
    nombre: "'unknown' aceptado como identidad embebida",
    fichero: LIB,
    de: `    if (v !== "" && v !== "unknown") return v;`,
    a: `    if (v !== "") return v;`,
  },
  {
    nombre: "procedencia dada por verificada sin identidad embebida",
    fichero: LIB,
    de: `(embebido === null ? "not_exercised" : "verified")`,
    a: `("verified")`,
  },
];

function correrSuite() {
  const r = spawnSync("npx", ["vitest", "run", ...SUITE, "--config", "vitest.pure.config.ts"], {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = salida.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/);
  return { rc: r.status ?? 1, fallidos: m && m[1] ? Number(m[1]) : 0, salida };
}

function main() {
  const base = correrSuite();
  if (base.rc !== 0) {
    console.error("la suite ya está roja SIN mutar: no se puede calibrar nada");
    console.error(base.salida.slice(-3000));
    return 1;
  }
  console.log("línea base: suite verde sin mutar\n");

  let sobrevivientes = 0;
  for (const mut of MUTACIONES) {
    const original = readFileSync(mut.fichero, "utf8");
    if (!original.includes(mut.de)) {
      console.error(`✗ mutación "${mut.nombre}": el anclaje ya no existe en ${mut.fichero} (mutación caduca)`);
      sobrevivientes++;
      continue;
    }
    try {
      writeFileSync(mut.fichero, original.replace(mut.de, mut.a));
      const r = correrSuite();
      if (r.rc === 0) {
        console.error(`✗ SOBREVIVE · "${mut.nombre}": la suite sigue verde. Esa garantía NO está probada.`);
        sobrevivientes++;
      } else {
        console.log(`✓ MUERE · "${mut.nombre}": ${r.fallidos} prueba(s) en rojo`);
      }
    } finally {
      writeFileSync(mut.fichero, original);
    }
  }

  console.log("");
  if (sobrevivientes > 0) {
    console.error(`${sobrevivientes} de ${MUTACIONES.length} mutaciones SOBREVIVEN: la calibración falla`);
    return 1;
  }
  console.log(`calibración OK · las ${MUTACIONES.length} mutaciones mueren`);
  return 0;
}

process.exit(main());
