#!/usr/bin/env node
/**
 * V1-OPS · harness de MUTACIÓN del aviso del nightly (AUD2-01 / D-OP-13).
 *
 * Estropea `nightly-alert.sh` o `nightly.yml` DE VERDAD y exige que un test concreto y nombrado de
 * `infrastructure/tests/nightly-alert.test.ts` se ponga ROJO. Línea base en verde primero; los originales
 * se restauran siempre. Commitea antes de lanzarlo.
 *
 * Uso: node infrastructure/scripts/nightly-alert-mutations.mjs   (rc=0 si TODAS mueren)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SH = join(RAIZ, ".github", "scripts", "nightly-alert.sh");
const YML = join(RAIZ, ".github", "workflows", "nightly.yml");
const SUITE = "infrastructure/tests/nightly-alert.test.ts";

const MUTACIONES = {
  M1: {
    f: SH,
    desc: "un error de la API al listar se toma por «no hay issue» (duplicados)",
    muere: "un error de la API al listar NO se toma por",
    de: '  echo "gh issue list falló: no se puede decidir; abortando" >&2\n  exit 1',
    a: '  lista=""',
  },
  M2: {
    f: SH,
    desc: "el verde deja de cerrar el issue",
    muere: "verde con issue abierto: comenta y CIERRA",
    de: '    gh issue close "$numero" || exit 1',
    a: "    :",
  },
  M3: {
    f: SH,
    desc: "un fallo con issue abierto crea otro en vez de actualizar",
    muere: "lo ACTUALIZA con un comentario, no abre otro",
    de: '  if [ -n "$numero" ]; then\n    gh issue comment "$numero" --body "$cuerpo"',
    a: '  if false; then\n    gh issue comment "$numero" --body "$cuerpo"',
  },
  M4: {
    f: SH,
    desc: "un RESULT desconocido se acepta",
    muere: "RESULT ausente o raro: rc=2",
    de: "  failure | success) ;;\n  *)",
    a: "  failure | success | cancelled | '') ;;\n  *)",
  },
  M5: {
    f: YML,
    desc: "el job de aviso sólo corre si lo anterior fue bien (if always() fuera)",
    muere: "depende de TODOS los jobs de pruebas y corre siempre",
    de: "    if: ${{ always() }}",
    a: "    if: ${{ success() }}",
  },
  M6: {
    f: YML,
    desc: "permisos de escritura amplios (contents: write)",
    muere: "permisos mínimos",
    de: "      contents: read\n      issues: write",
    a: "      contents: write\n      issues: write",
  },
  M7: {
    f: YML,
    desc: "el verde sólo exige uno de los dos jobs",
    muere: "un job cancelado, saltado o con tiempo agotado cuenta como rojo",
    de: '[ "$R_DET" = success ] && [ "$R_SLOW" = success ]',
    a: '[ "$R_DET" = success ]',
  },
  M8: {
    f: YML,
    desc: "el aviso deja de depender de slow-suites",
    muere: "depende de TODOS los jobs de pruebas",
    de: "needs: [determinism-1000, slow-suites]",
    a: "needs: [determinism-1000]",
  },
};

function vitest() {
  return spawnSync("npx", ["vitest", "run", SUITE, "--maxWorkers=1", "--reporter=verbose"], {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const originales = { [SH]: readFileSync(SH, "utf8"), [YML]: readFileSync(YML, "utf8") };
const restaurar = () => {
  for (const [f, c] of Object.entries(originales)) writeFileSync(f, c);
};
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    restaurar();
    process.exit(130);
  });

let fallo = false;
try {
  const base = vitest();
  console.log(`BASE rc=${base.status}`);
  if (base.status !== 0) {
    console.log((base.stdout + base.stderr).slice(-2000));
    fallo = true;
  } else {
    for (const [id, m] of Object.entries(MUTACIONES)) {
      const orig = originales[m.f];
      if (!orig.includes(m.de)) {
        console.log(`${id}: NO SE PUDO APLICAR (${m.desc})`);
        fallo = true;
        continue;
      }
      writeFileSync(m.f, orig.replace(m.de, m.a));
      const r = vitest();
      const salida = r.stdout + r.stderr;
      const rojos = salida.split("\n").filter((l) => /^\s*(×|✗)\s/.test(l) || /\sFAIL\s/.test(l));
      const murio = r.status !== 0 && rojos.some((l) => l.includes(m.muere));
      console.log(`${id}: ${murio ? "MUERTO" : "SOBREVIVE"} rc=${r.status} por «${m.muere}» (${m.desc})`);
      if (!murio) fallo = true;
      writeFileSync(m.f, orig);
    }
  }
} finally {
  restaurar();
}
const limpio = Object.entries(originales).every(([f, c]) => readFileSync(f, "utf8") === c);
console.log(`ARBOL_RESTAURADO=${limpio}`);
process.exit(fallo || !limpio ? 1 : 0);
