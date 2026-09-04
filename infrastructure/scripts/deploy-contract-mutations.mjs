#!/usr/bin/env node
/**
 * CONTRATO DE DESPLIEGUE · harness de MUTACIÓN.
 *
 * Una suite que sólo se ha visto en verde no demuestra nada. Este harness
 * estropea el gate DE VERDAD —edita el fichero de producción, no simula— y
 * exige que `infrastructure/tests/deploy-contract-gate.test.ts` se ponga ROJA
 * con cada estropicio. Una mutación que sobrevive es una garantía que no
 * comprueba nadie.
 *
 * Uso: node infrastructure/scripts/deploy-contract-mutations.mjs
 * rc=0 si TODAS mueren; rc=1 si alguna sobrevive o no se pudo aplicar.
 * El original se restaura siempre, también ante SIGINT/SIGTERM.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBJETIVO = join(RAIZ, "infrastructure", "scripts", "deploy-contract-gate.mjs");
const SUITE = "infrastructure/tests/deploy-contract-gate.test.ts";
const RESPALDO = OBJETIVO + ".mutation-backup";

const MUTACIONES = {
  M1: {
    desc: "el almacén LOCAL vuelve a valer como autoridad del nivel 2 (el error real)",
    cambios: [
      ['  return respuesta?.fuente === "registro";', "  return respuesta !== undefined && respuesta !== null;"],
    ],
  },
  M2: {
    desc: "la coherencia etiqueta↔digest deja de comprobarse (el defecto de main)",
    cambios: [["    if (porEtiqueta.error || porEtiqueta.digest !== porDigest.digest)", "    if (false)"]],
  },
  M3: {
    desc: "el nivel 3 aprueba cualquier versión (un digest de 16.15 pasaría por 16.14)",
    cambios: [["    if (visto !== valor)", "    if (false)"]],
  },
  M4: {
    desc: "el nivel 1 acepta cualquier cadena tras @sha256:",
    cambios: [["const RE_DIGEST = /^sha256:[0-9a-f]{64}$/;", "const RE_DIGEST = /^sha256:.*$/;"]],
  },
  M5: {
    desc: "el gate de TAG pasa a prohibir la palabra «local» en vez de comparar el EFECTO",
    cambios: [["    else if (real !== esperada)", '    else if (String(real).includes(":local"))']],
  },
  M6: {
    desc: "el gate de PERFIL compara TAMAÑOS de conjunto en vez de igualdad de conjuntos",
    cambios: [["  return A.length === B.length && A.every((x, i) => x === B[i]);", "  return A.length === B.length;"]],
  },
  M7: {
    desc: "el renderizador selecciona servicios sin perfil activo (sin perfil renderizaría todo)",
    cambios: [
      [
        "    const seleccionado = suyos.length === 0 ? true : suyos.some((p) => activos.has(p));",
        "    const seleccionado = true;",
      ],
    ],
  },
  M8: {
    desc: "queue sale de la clase STATEFUL_SERVICES (vuelve a ser «infraestructura inocua»)",
    cambios: [
      [
        'export const STATEFUL_SERVICES = Object.freeze(["postgres", "queue"]);',
        'export const STATEFUL_SERVICES = Object.freeze(["postgres"]);',
      ],
    ],
  },
  M9: {
    desc: "una política de recreación vacía se da por buena (basta con que el campo exista)",
    cambios: [['      if (!d[campo] || String(d[campo]).trim() === "")', "      if (d[campo] === undefined)"]],
  },
  M10: {
    desc: "la deuda no declarada deja de exigirse (aprobar por omisión)",
    cambios: [["    if (d.copia_verificada !== true && !d.deuda)", "    if (false)"]],
  },
  M11: {
    desc: "sin --registro el gate aprueba igual (NO_EJERCIDO tratado como éxito)",
    cambios: [
      [
        "    informe.imagenes.some((r) => !r.ok || r.no_ejercido)",
        "    informe.imagenes.some((r) => !r.ok && !r.no_ejercido)",
      ],
    ],
  },
  M13: {
    desc: "un registro inaccesible (429) se confunde con «el digest no existe»",
    cambios: [["  if (registroInaccesible(porDigest.error))", "  if (false)"]],
  },
  M14: {
    desc: "la herramienta ausente (ENOENT) vuelve a leerse como «el digest no existe» (el defecto medido)",
    cambios: [["|ENOENT|command not found|no such file or directory", ""]],
  },
  M12: {
    desc: "un contrato ausente deja de ser rc=2 y pasa por aprobado",
    cambios: [["    return e.rc ?? 2;", "    return 0;"]],
  },
};

function aplicar(cambios, texto) {
  let out = texto;
  for (const [viejo, nuevo] of cambios) {
    if (!out.includes(viejo)) return null; // el ancla se movió: mutación NO aplicada
    out = out.replace(viejo, nuevo);
  }
  return out;
}

function correrSuite() {
  const r = spawnSync("npx", ["vitest", "run", SUITE], { cwd: RAIZ, encoding: "utf8" });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // rc explícito: nunca el $? implícito de una tubería.
  return { rc: r.status ?? 1, resumen: (salida.match(/^ +Tests +.*$/m) ?? ["(sin resumen)"])[0].trim() };
}

function main() {
  const original = readFileSync(OBJETIVO, "utf8");
  copyFileSync(OBJETIVO, RESPALDO);
  const restaurar = () => writeFileSync(OBJETIVO, original);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (restaurar(), process.exit(1)));

  // Control positivo: sin mutar la suite tiene que estar VERDE; si no, el rojo
  // de las mutaciones no probaría nada.
  const base = correrSuite();
  console.log(`BASE  ${base.rc === 0 ? "VERDE" : "ROJA (¡el control positivo falla!)"} · ${base.resumen}`);
  if (base.rc !== 0) {
    restaurar();
    return 1;
  }

  let fallo = 0;
  try {
    for (const [nombre, { desc, cambios }] of Object.entries(MUTACIONES)) {
      const mutado = aplicar(cambios, original);
      if (mutado === null) {
        console.error(`${nombre} NO APLICADA (el ancla ya no existe): ${desc}`);
        fallo = 1;
        continue;
      }
      writeFileSync(OBJETIVO, mutado);
      const r = correrSuite();
      restaurar();
      if (r.rc === 0) {
        console.error(`${nombre} SOBREVIVE · ${desc} — esa garantía no la comprueba nadie · ${r.resumen}`);
        fallo = 1;
      } else {
        console.log(`${nombre} ROJO (como debe) · ${desc} · ${r.resumen}`);
      }
    }
  } finally {
    restaurar();
    try {
      unlinkSync(RESPALDO);
    } catch {
      /* el respaldo es auxiliar; el original ya está restaurado */
    }
  }
  return fallo;
}

process.exit(main());
