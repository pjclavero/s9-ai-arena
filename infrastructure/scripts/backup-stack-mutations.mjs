#!/usr/bin/env node
/**
 * CONTRATO DE LOS DOS BLOQUES · harness de MUTACIÓN.
 *
 * Una suite que sólo se ha visto en verde no demuestra nada. Este harness
 * estropea el gate DE VERDAD —edita `backup-stack-gate.mjs`, no simula— y exige
 * que `infrastructure/tests/backup-stack-gate.test.ts` se ponga ROJA con cada
 * estropicio. Una mutación que sobrevive es una garantía que no comprueba nadie.
 *
 * M2 y M3 son las importantes: son las dos mitades de la garantía que el
 * operador pidió —«que elegir un perfil demasiado amplio no pueda volver a
 * arrancar backup por accidente»—. Si alguna sobreviviera, esa garantía estaría
 * escrita pero no probada.
 *
 * Uso: node infrastructure/scripts/backup-stack-mutations.mjs
 * rc=0 si TODAS mueren; rc=1 si alguna sobrevive o no se pudo aplicar.
 * El original se restaura siempre, también ante SIGINT/SIGTERM.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBJETIVO = join(RAIZ, "infrastructure", "scripts", "backup-stack-gate.mjs");
const SUITE = "infrastructure/tests/backup-stack-gate.test.ts";
const RESPALDO = OBJETIVO + ".mutation-backup";

const MUTACIONES = {
  M1: {
    desc: "el conjunto de APP_STACK se compara por TAMAÑO en vez de por igualdad (11 servicios cualesquiera pasarían)",
    cambios: [["  return A.length === B.length && A.every((x, i) => x === B[i]);", "  return A.length === B.length;"]],
  },
  M2: {
    desc: "deja de mirarse si el perfil de APP_STACK arrastra backup (la contaminación directa)",
    cambios: [["  const solape = bk.filter((s) => app.includes(s));", "  const solape = [];"]],
  },
  M3: {
    desc: "deja de mirarse si OTRO perfil del compose renderiza backup (la regresión futura)",
    cambios: [["    if (perfil === perfilDeRender || rechazados.has(perfil)) continue;", "    if (true) continue;"]],
  },
  M4: {
    desc: "el total esperado ya no tiene que cuadrar con 11+1",
    cambios: [["  if (total !== app.length + bk.length)", "  if (false)"]],
  },
  M5: {
    desc: "un render VACÍO de APP_STACK pasa por bueno (el falso verde del conjunto vacío)",
    cambios: [["  if (obtenidos.length === 0)", "  if (false)"]],
  },
  M6: {
    desc: "--no-build/--no-deps dejan de exigirse (postgres es NO RESTART y build.context resolvería al árbol equivocado)",
    cambios: [["    if (!(bk.flags_obligatorias ?? []).includes(flag))", "    if (false)"]],
  },
  M7: {
    desc: "un contrato SIN `bloques` pasa por aprobado (aprobar por omisión)",
    cambios: [["  if (!contrato?.bloques)", "  if (false)"]],
  },
  M8: {
    desc: "el control POSITIVO del bloque de copia desaparece: un bloque que no renderiza nada se da por bueno",
    cambios: [["    if (!render.includes(svc))", "    if (false)"]],
  },
  M9: {
    desc: "el cardinal declarado (n_esperado) deja de comprobarse en APP_STACK",
    cambios: [["  if (app.n_esperado !== undefined && obtenidos.length !== app.n_esperado)", "  if (false)"]],
  },
  M10: {
    desc: "los bloques pueden solaparse (backup en los dos a la vez)",
    cambios: [
      [
        "  const duplicados = bk.filter((s) => (contrato?.servicios_esperados ?? []).includes(s));",
        "  const duplicados = [];",
      ],
    ],
  },
  M11: {
    desc: "BACKUP_STACK deja de tener que coincidir con `gestionados_aparte` (dos verdades sobre lo mismo)",
    cambios: [["  if (!mismoConjunto(declarados, aparte))", "  if (false)"]],
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
  // rc EXPLÍCITO: en una tubería $? es del último comando, nunca del que importa.
  return { rc: r.status ?? 1, resumen: (salida.match(/^ +Tests +.*$/m) ?? ["(sin resumen)"])[0].trim() };
}

function main() {
  const original = readFileSync(OBJETIVO, "utf8");
  copyFileSync(OBJETIVO, RESPALDO);
  const restaurar = () => writeFileSync(OBJETIVO, original);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (restaurar(), process.exit(1)));

  // Control positivo: sin mutar, la suite tiene que estar VERDE; si no, el rojo
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
        console.error(`${nombre} SOBREVIVE · ${desc} · ${r.resumen}`);
        fallo = 1;
      } else {
        console.log(`${nombre} muere    · ${desc} · ${r.resumen}`);
      }
    }
  } finally {
    restaurar();
    try {
      unlinkSync(RESPALDO);
    } catch {
      /* el respaldo ya no está: el original queda restaurado igualmente */
    }
  }
  console.log(fallo === 0 ? "TODAS las mutaciones mueren" : "ALGUNA mutación sobrevive: garantía no probada");
  return fallo;
}

process.exit(main());
