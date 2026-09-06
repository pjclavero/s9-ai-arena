#!/usr/bin/env node
/**
 * OVERRIDE SELECTIVO · harness de MUTACIÓN.
 *
 * Una suite que sólo se ha visto en verde no demuestra nada. Este harness
 * estropea el gate DE VERDAD —edita `tag-override-gate.mjs` y `lib/interpolar.mjs`,
 * no simula— y exige que `infrastructure/tests/tag-override-gate.test.ts` se
 * ponga ROJA con cada estropicio. Una mutación que sobrevive es una garantía que
 * no comprueba nadie.
 *
 * Las cinco que el encargo exige ver en rojo, y dónde están:
 *   M1  override que arrastra a otro servicio          → M_ARRASTRE
 *   M2  override invisible para el verificador         → M_INVISIBLE
 *   M3  changed_specs_other_than_image sin comprobar   → M_SPEC_SIN_MIRAR
 *   M4  comparar imágenes por NOMBRE y no por efecto   → M_POR_NOMBRE
 *   M5  romper la separación backup / aplicación       → M_SEPARACION
 *
 * M_POR_NOMBRE merece una nota: no basta con desactivar una comprobación, hay
 * que sustituir el MÉTODO por el equivocado. Se hace deshabilitando la
 * interpolación, que es exactamente lo que convierte un render en una
 * comparación de cadenas del YAML. Si la suite sobreviviera a eso, el "por
 * efecto" del que presume el gate no lo estaría comprobando nadie.
 *
 * Uso: node infrastructure/scripts/tag-override-mutations.mjs
 * rc=0 si TODAS mueren; rc=1 si alguna sobrevive o no se pudo aplicar.
 * Los originales se restauran siempre, también ante SIGINT/SIGTERM.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(RAIZ, "infrastructure", "scripts", "tag-override-gate.mjs");
const INTERP = join(RAIZ, "infrastructure", "scripts", "lib", "interpolar.mjs");
const SUITE = "infrastructure/tests/tag-override-gate.test.ts";

const MUTACIONES = {
  M_ARRASTRE: {
    fichero: GATE,
    desc: "M1 · un override puede arrastrar a OTRO servicio (deja de mirarse el aislamiento)",
    cambios: [["      if (esperados.has(cambio.service)) continue;", "      if (true) continue;"]],
  },
  M_INVISIBLE: {
    fichero: GATE,
    desc: "M2 · un override con efecto y SIN declarar pasa por bueno (estado invisible)",
    cambios: [["    if (!decl) {", "    if (false) {"]],
  },
  M_SPEC_SIN_MIRAR: {
    fichero: GATE,
    desc: "M3 · changed_specs_other_than_image deja de comprobarse (sólo se mira la imagen)",
    cambios: [["    if (ja !== jb) specs.push({ service: s, de: ja, a: jb });", "    if (false) specs.push();"]],
  },
  M_SPEC_GATE: {
    fichero: GATE,
    desc: "M3b · el GATE deja de parar ante un cambio de spec que no es la imagen",
    cambios: [["  for (const c of d.specs)", "  for (const c of [])"]],
  },
  M_POR_NOMBRE: {
    fichero: INTERP,
    desc: "M4 · comparar por NOMBRE del YAML en vez de por EFECTO del render (interpolación anulada)",
    cambios: [
      [
        "export function interpolar(texto, vars = {}, profundidad = 0) {",
        "export function interpolar(texto, vars = {}, profundidad = 0) {\n  return String(texto);",
      ],
    ],
  },
  M_POR_NOMBRE_ANIDADO: {
    fichero: INTERP,
    desc: "M4b · vuelve la regex de UNA pasada: el defecto anidado deja llaves sin resolver",
    cambios: [
      [
        "export function interpolar(texto, vars = {}, profundidad = 0) {",
        'export function interpolar(texto, vars = {}, profundidad = 0) {\n  return String(texto).replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\\}/g, (_, n, d) => {\n    const v = vars[n];\n    return v === undefined || v === "" ? (d ?? "") : v;\n  });',
      ],
    ],
  },
  M_SEPARACION: {
    fichero: GATE,
    desc: "M5 · se rompe la separación semántica: `backup` puede pasar a seguir a TAG sin que nadie lo note",
    cambios: [['    if (f.codigo !== "TAG_GLOBAL_ARRASTRA_BACKUP") continue;', "    continue;"]],
  },
  M_SEPARACION_SIMETRICA: {
    fichero: GATE,
    desc: "M5b · BACKUP_TAG puede arrastrar a los de aplicación (la dirección simétrica deja de mirarse)",
    cambios: [
      [
        "  for (const cambio of d.imagenes)\n    fallos.push({\n      codigo: CODIGOS.BACKUP_TAG_ARRASTRA_APP,",
        "  for (const cambio of [])\n    fallos.push({\n      codigo: CODIGOS.BACKUP_TAG_ARRASTRA_APP,",
      ],
    ],
  },
  M_SIGUE_A_TAG: {
    fichero: GATE,
    desc: "M6 · un servicio de aplicación puede dejar de seguir al TAG global",
    cambios: [["    if (etiquetaDe(conGlobal[svc].imagen) !== CENTINELA_GLOBAL)", "    if (false)"]],
  },
  M_DECLARACION_MUERTA: {
    fichero: GATE,
    desc: "M7 · un override declarado SIN efecto pasa por bueno (declaración muerta)",
    cambios: [["    if (!overrides[svc])", "    if (false)"]],
  },
  M_CARDINAL: {
    fichero: GATE,
    desc: "M8 · el gate deja de comprobar cuántas imágenes cambian",
    cambios: [["  if (d.changed_images !== esperados.size)", "  if (false)"]],
  },
  M_AUSENCIA: {
    fichero: GATE,
    desc: "M9 · un contrato ausente deja de ser rc=2 y pasa por aprobado",
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
  const originales = new Map([
    [GATE, readFileSync(GATE, "utf8")],
    [INTERP, readFileSync(INTERP, "utf8")],
  ]);
  const restaurar = () => {
    for (const [f, t] of originales) writeFileSync(f, t);
  };
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
    for (const [nombre, { fichero, desc, cambios }] of Object.entries(MUTACIONES)) {
      const mutado = aplicar(cambios, originales.get(fichero));
      if (mutado === null) {
        console.error(`${nombre} NO APLICADA (el ancla ya no existe): ${desc}`);
        fallo = 1;
        continue;
      }
      writeFileSync(fichero, mutado);
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
  }
  console.log(fallo === 0 ? "TODAS las mutaciones mueren" : "ALGUNA mutación sobrevive: garantía no probada");
  return fallo;
}

process.exit(main());
