#!/usr/bin/env node
/**
 * CARRIL G · harness de MUTACIÓN del runtime drift scanner.
 *
 * Una suite que solo se ha visto en verde no demuestra nada. Este harness
 * estropea el escáner de verdad —edita el fichero, no simula nada— y exige que
 * `infrastructure/tests/runtime-drift-scan.test.ts` se ponga ROJA con cada
 * estropicio. Una mutación que sobrevive es una garantía que no comprueba nadie.
 *
 * Mutaciones (las cinco obligatorias del encargo):
 *   M1 · la existencia de la imagen siempre cierta
 *   M2 · la etiqueta siempre coincidente
 *   M3 · IMAGE_MISSING convertido en PASS
 *   M4 · TAG_MOVED convertido en PASS
 *   M5 · montajes comparados por nombre físico en vez de por destino
 *
 * Uso: node infrastructure/scripts/runtime-drift-mutations.mjs
 * rc=0 si TODAS se ponen rojas; rc=1 si alguna sobrevive (o no se pudo aplicar).
 *
 * El fichero original se restaura siempre, incluso si el proceso se interrumpe.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBJETIVO = join(RAIZ, "infrastructure", "scripts", "runtime-drift-scan.mjs");
const SUITE = "infrastructure/tests/runtime-drift-scan.test.ts";
const RESPALDO = OBJETIVO + ".mutation-backup";

/** Cada mutación es una lista de sustituciones ancladas al texto real. */
const MUTACIONES = {
  M1: {
    desc: "la existencia de la imagen siempre cierta",
    cambios: [["  const existe = hecho.running_image_exists;", "  const existe = true;"]],
  },
  M2: {
    desc: "la etiqueta siempre coincidente",
    cambios: [
      [
        "  const idDeLaEtiqueta = hecho.declared_ref_current_id ?? null;",
        "  const idDeLaEtiqueta = hecho.running_image_id ?? null;",
      ],
    ],
  },
  M3: {
    desc: "IMAGE_MISSING convertido en PASS",
    cambios: [["    estados.push(ESTADOS.IMAGE_MISSING);", "    estados.push(ESTADOS.OK);"]],
  },
  M4: {
    desc: "TAG_MOVED convertido en PASS",
    cambios: [
      [
        "      estados.push(ESTADOS.TAG_MOVED);\n      const sinTags",
        "      estados.push(ESTADOS.OK);\n      const sinTags",
      ],
    ],
  },
  M5: {
    desc: "montajes comparados por nombre físico en vez de por destino",
    cambios: [
      [
        "  const porDestino = new Map(actuales.map((m) => [m.destino, m]));",
        "  const porDestino = new Map(actuales.map((m) => [m.origen, m]));",
      ],
      ["    const hay = porDestino.get(e.destino);", "    const hay = porDestino.get(e.origen);"],
    ],
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

  // Control positivo: sin mutar, la suite tiene que estar VERDE. Si no lo está,
  // el rojo de las mutaciones no probaría nada.
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
      spawnSync("rm", ["-f", RESPALDO]);
    } catch {
      /* el respaldo es auxiliar; el original ya está restaurado */
    }
  }
  return fallo;
}

process.exit(main());
