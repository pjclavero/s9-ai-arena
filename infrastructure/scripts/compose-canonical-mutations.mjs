#!/usr/bin/env node
/**
 * CARRIL COMPOSE CANÓNICO · calibración por MUTACIÓN del comprobador.
 *
 * Una suite que sólo se ha visto en verde no demuestra nada. Este harness
 * estropea el comprobador DE VERDAD —edita el fichero, no simula nada— y exige
 * que `infrastructure/tests/compose-canonical-check.test.ts` se ponga ROJA con
 * cada estropicio. Una mutación que sobrevive es una garantía que no comprueba
 * nadie, y hay que darla por no probada.
 *
 * Las mutaciones, todas atadas a un modo de fallo real de este carril:
 *   M1 · la procedencia siempre se da por buena (el incidente literal de VM108:
 *        nadie miraba `config_files`, y por eso el stack quedó irreproducible)
 *   M2 · varias procedencias en un mismo proyecto dejan de ser un hallazgo
 *        (cada servicio "cuadra", el conjunto no se puede rehacer)
 *   M3 · el filtro por perfil se ignora y no renderiza nada: comparar contra el
 *        conjunto vacío daría verde a cualquier stack (el peor falso negativo)
 *   M4 · un servicio vivo que el compose no renderiza deja de ser un hallazgo
 *   M5 · los montajes se comparan por nombre FÍSICO en vez de por destino
 *   M6 · la partición recrear/reetiquetar mete en "recrear" a los servicios que
 *        sólo arrastran una procedencia equivocada (haría recrear postgres, que
 *        está en DO NOT RESTART, sin ninguna necesidad)
 *   M7 · el healthcheck deja de compararse (la deriva del backup pasaría)
 *   M8 · los puertos publicados dejan de compararse
 *
 * Uso: node infrastructure/scripts/compose-canonical-mutations.mjs
 * rc=0 si TODAS se ponen rojas; rc=1 si alguna sobrevive o no se pudo aplicar.
 *
 * El fichero original se restaura SIEMPRE, incluso si el proceso se interrumpe.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OBJETIVO = join(RAIZ, "infrastructure", "scripts", "compose-canonical-check.mjs");
const SUITE = "infrastructure/tests/compose-canonical-check.test.ts";
const RESPALDO = OBJETIVO + ".mutation-backup";

/** Cada mutación es una lista de sustituciones ancladas al texto real. */
const MUTACIONES = {
  M1: {
    desc: "la procedencia siempre se da por buena",
    cambios: [["    if (h.compose_config_en_working_dir === false) {", "    if (false) {"]],
  },
  M2: {
    desc: "varias procedencias dejan de ser un hallazgo",
    cambios: [["  if (origenes.length > 1) {", "  if (false) {"]],
  },
  M3: {
    desc: "el filtro por perfil descarta TODO (comparación contra el conjunto vacío)",
    cambios: [
      [
        "    if (profile !== null && perfiles.length > 0 && !perfiles.includes(profile)) continue;",
        "    if (profile !== null) continue;",
      ],
    ],
  },
  M4: {
    desc: "un servicio vivo sin spec deja de ser un hallazgo",
    cambios: [["    if (!specs[nombre]) {", "    if (false) {"]],
  },
  M5: {
    desc: "los montajes se comparan por nombre físico en vez de por destino",
    cambios: [
      [
        "  const m = driftDeMontajes(hecho.mounts ?? [], { mounts: spec.mounts ?? [] });",
        "  const m = { faltan: [], sobran: [], incorrectos: [], ausenciasIncumplidas: [] };",
      ],
    ],
  },
  M6: {
    desc: "recrear incluye a los servicios que sólo arrastran la procedencia",
    cambios: [
      [
        '      .filter((s) => s !== "(stack)" && hallazgos.some((x) => x.service === s && !ES_SOLO_PROCEDENCIA.has(x.code)))',
        '      .filter((s) => s !== "(stack)")',
      ],
    ],
  },
  M7: {
    desc: "el healthcheck deja de compararse",
    cambios: [
      [
        "  if (spec.healthcheck_test_hash && spec.healthcheck_test_hash !== hecho.healthcheck_test_hash) {",
        "  if (false) {",
      ],
    ],
  },
  M8: {
    desc: "los puertos publicados dejan de compararse",
    cambios: [
      ["  if (!igual((hecho.ports ?? []).slice().sort(), (spec.ports ?? []).slice().sort())) {", "  if (false) {"],
    ],
  },
};

function suiteVerde() {
  const r = spawnSync("npx", ["vitest", "run", SUITE, "--maxWorkers=1"], { cwd: RAIZ, encoding: "utf8" });
  return r.status === 0;
}

function restaurar() {
  try {
    copyFileSync(RESPALDO, OBJETIVO);
    unlinkSync(RESPALDO);
  } catch {
    /* ya restaurado */
  }
}

function main() {
  copyFileSync(OBJETIVO, RESPALDO);
  for (const s of ["SIGINT", "SIGTERM", "exit"]) process.on(s, restaurar);
  const original = readFileSync(OBJETIVO, "utf8");

  // Control POSITIVO: sin mutar, la suite tiene que estar VERDE. Si no lo está,
  // no se puede concluir nada de las mutaciones y se para aquí.
  process.stdout.write("control · suite sin mutar … ");
  if (!suiteVerde()) {
    console.log("ROJA");
    console.error("la suite no está verde de partida: las mutaciones no probarían nada");
    restaurar();
    return 1;
  }
  console.log("verde");

  const sobreviven = [];
  for (const [id, m] of Object.entries(MUTACIONES)) {
    let mutado = original;
    let aplicada = true;
    for (const [de, a] of m.cambios) {
      if (!mutado.includes(de)) {
        console.error(`${id} · NO SE PUDO APLICAR: el anclaje ya no existe → ${de.trim().slice(0, 60)}`);
        aplicada = false;
        break;
      }
      mutado = mutado.replace(de, a);
    }
    if (!aplicada) {
      sobreviven.push(`${id} (no aplicable)`);
      continue;
    }
    writeFileSync(OBJETIVO, mutado);
    process.stdout.write(`${id} · ${m.desc} … `);
    const verde = suiteVerde();
    console.log(verde ? "SOBREVIVE (la suite sigue verde)" : "muere (la suite se pone roja)");
    if (verde) sobreviven.push(`${id} · ${m.desc}`);
    writeFileSync(OBJETIVO, original);
  }

  restaurar();
  if (sobreviven.length) {
    console.error(`\n${sobreviven.length} mutación(es) SOBREVIVEN — esas garantías no las comprueba nadie:`);
    for (const s of sobreviven) console.error(`  · ${s}`);
    return 1;
  }
  console.log(`\nlas ${Object.keys(MUTACIONES).length} mutaciones mueren: cada garantía sabe ponerse roja`);
  return 0;
}

process.exit(main());
