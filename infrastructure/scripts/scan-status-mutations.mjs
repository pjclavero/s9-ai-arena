#!/usr/bin/env node
/**
 * SEMÁNTICA DEL SCAN · harness de MUTACIÓN.
 *
 * Una suite que sólo se ha visto en verde no demuestra nada. Este harness
 * estropea el contrato DE VERDAD —edita los ficheros de producción, no
 * simulacros— y exige que las suites se pongan ROJAS con cada estropicio. Una
 * mutación que sobrevive es una garantía que no comprueba nadie.
 *
 * (M1-M30; M13-M30 son los del PR #296 ronda 2.)
 * Las cinco primeras son EXACTAMENTE los fallos que este carril tiene que
 * impedir; las dos últimas cierran los agujeros de alrededor.
 *
 * Uso: node infrastructure/scripts/scan-status-mutations.mjs
 * rc=0 si TODAS mueren; rc=1 si alguna sobrevive o no se pudo aplicar.
 * El original se restaura siempre, también ante SIGINT/SIGTERM.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRATO = join(RAIZ, "packages", "readiness", "scan-status.mjs");
const SEMAFORO = join(RAIZ, "infrastructure", "scripts", "ci-gate.mjs");
const EJECUTOR = join(RAIZ, "infrastructure", "scripts", "scan-gate.mjs");

const SUITES = [
  "infrastructure/tests/scan-status.test.ts",
  "infrastructure/tests/scan-gate.test.ts",
  "infrastructure/tests/ci-gate.test.ts",
];

const MUTACIONES = {
  M1: {
    desc: "SOURCE_UNAVAILABLE tratado como CLEAN (un rate-limit pasaría por «0 vulnerabilidades»)",
    fichero: CONTRATO,
    cambios: [["  SOURCE_UNAVAILABLE: READINESS.NOT_EXERCISED,", "  SOURCE_UNAVAILABLE: READINESS.VERIFIED,"]],
  },
  M2: {
    desc: "SCAN_ERROR tratado como CLEAN (una herramienta rota daría verde)",
    fichero: CONTRATO,
    cambios: [['  SCAN_ERROR: "segun_politica",', "  SCAN_ERROR: READINESS.VERIFIED,"]],
  },
  M3: {
    desc: "una respuesta vacía o degradada del endpoint se lee como «0 vulnerabilidades»",
    fichero: CONTRATO,
    cambios: [
      [
        '  if (informe.auditReportVersion === undefined || recuentos === null || typeof recuentos !== "object") {',
        "  if (false) {",
      ],
      ["  if (conocidas.length === 0) {", "  if (false) {"],
    ],
  },
  M4: {
    desc: "un estado no contemplado cae al camino permisivo en vez de a fail-closed",
    fichero: CONTRATO,
    cambios: [
      [
        "  if (destino !== READINESS.VERIFIED && destino !== READINESS.FAILED && destino !== READINESS.NOT_EXERCISED) {\n    return READINESS.NOT_EXERCISED;\n  }",
        "  if (destino === undefined) {\n    return READINESS.VERIFIED;\n  }",
      ],
    ],
  },
  M5: {
    desc: "el semáforo pierde la distinción entre «hallazgos» y «no comprobado»",
    fichero: SEMAFORO,
    cambios: [
      [
        '  const etiqueta = motivo.clase === "hallazgos" ? "HALLAZGOS DE SEGURIDAD" : "SEGURIDAD NO COMPROBADA";',
        '  const etiqueta = "FALLO DE SEGURIDAD";',
      ],
    ],
  },
  M6: {
    desc: "un escáner que no declaró nada deja de contar (borrar un escáner del workflow saldría verde)",
    fichero: EJECUTOR,
    cambios: [
      [
        "    ...esperados\n      .filter((h) => !declarados.has(h))",
        "    ...[]\n      .filter((h) => !declarados.has(h))",
      ],
    ],
  },
  M7: {
    desc: "un informe de Trivy sin objetivos escaneados se da por árbol limpio",
    fichero: CONTRATO,
    cambios: [["  if (objetivos === null || objetivos.length === 0) {", "  if (objetivos === null) {"]],
  },
  M8: {
    desc: "el semáforo vuelve a deducir el veredicto del código de salida del job (success ⇒ verde)",
    fichero: SEMAFORO,
    cambios: [
      [
        '  if (typeof declarado !== "string" || declarado.trim() === "") {',
        '  if (resultado === "success") {\n    return fila(job.id, resultado, VERDE, "ejecutado y aprobado");\n  }\n  if (typeof declarado !== "string" || declarado.trim() === "") {',
      ],
    ],
  },
  M9: {
    desc: "una excepción exime aunque el paquete haya llegado a producción en el lockfile",
    fichero: CONTRATO,
    cambios: [["    return nodos.every((n) => lockPackages[n]?.dev === true);", "    return true;"]],
  },
  M10: {
    desc: "una excepción caducada sigue eximiendo",
    fichero: CONTRATO,
    cambios: [["    if (e.caduca < fecha) {", "    if (false) {"]],
  },
  M11: {
    desc: "basta con que UN aviso de la cadena esté exceptuado para dar la vulnerabilidad por cubierta",
    fichero: CONTRATO,
    cambios: [
      [
        "    const cubierta = avisos.length > 0 && avisos.every((a) => a !== null && exceptuado(a));",
        "    const cubierta = avisos.some((a) => a !== null && exceptuado(a));",
      ],
    ],
  },
  M12: {
    desc: "un fichero de excepciones mal formado se lee como válido",
    fichero: CONTRATO,
    cambios: [["  if (invalida) return { ...sinNada, error:", "  if (false) return { ...sinNada, error:"]],
  },

  // ── PR #296 ronda 2: mutantes del revisor (R*) y de los hallazgos P2 ──────
  M13: {
    desc: "[R2] la excepción deja de estar atada al GHSA (todo aviso alto del paquete queda exento)",
    fichero: CONTRATO,
    cambios: [
      [
        "vigentes.some((e) => e.ghsa === ghsa && e.paquete === aviso?.name)",
        "vigentes.some((e) => e.paquete === aviso?.name)",
      ],
    ],
  },
  M14: {
    desc: "[R3] scan-gate deja de emitir el ::warning:: cuando hay una excepción aplicada",
    fichero: EJECUTOR,
    cambios: [["if (/excepci[oó]n/.test(ultimo.detalle)) {", "if (false) {"]],
  },
  M15: {
    desc: "[R4] un fichero de excepciones presente pero ilegible se lee como «sin excepciones»",
    fichero: EJECUTOR,
    cambios: [['excepciones = "ilegible";', "excepciones = undefined;"]],
  },
  M16: {
    desc: "[R5] reloj congelado: la excepción nunca caduca en la CI",
    fichero: EJECUTOR,
    cambios: [["hoy: new Date().toISOString().slice(0, 10) }", 'hoy: "2000-01-01" }']],
  },
  M17: {
    desc: "[R16] scan-gate no pasa el contexto de excepciones al clasificador",
    fichero: EJECUTOR,
    cambios: [["clasificarNpmAudit({ ...obs, umbral, ...contexto })", "clasificarNpmAudit({ ...obs, umbral })"]],
  },
  M18: {
    desc: "[R18] el lockfile se lee siempre como `{}` (alcance dev no comprobable pero «aplicado»)",
    fichero: EJECUTOR,
    cambios: [['lockPackages = JSON.parse(readFileSync(lock, "utf8")).packages ?? null;', "lockPackages = {};"]],
  },
  M19: {
    desc: "[R6] un paquete sin nodos en el informe se da por sólo-dev",
    fichero: CONTRATO,
    cambios: [
      [
        "if (!Array.isArray(nodos) || nodos.length === 0) return false;",
        "if (!Array.isArray(nodos) || nodos.length === 0) return true;",
      ],
    ],
  },
  M20: {
    desc: "[R11] una vulnerabilidad sin ningún aviso alto en su cadena se da por cubierta",
    fichero: CONTRATO,
    cambios: [["avisos.length > 0 && avisos.every", "avisos.every"]],
  },
  M21: {
    desc: "[R12] un nombre de la cadena `via` sin entrada se ignora en vez de bloquear",
    fichero: CONTRATO,
    cambios: [["avisos.push(null); // cadena rota", "continue; // cadena rota"]],
  },
  M22: {
    desc: "[R10] el día de caducidad ya no exime (la caducidad deja de ser inclusiva)",
    fichero: CONTRATO,
    cambios: [["if (e.caduca < fecha) {", "if (e.caduca <= fecha) {"]],
  },
  M23: {
    desc: "el fichero de excepciones sólo se valida cuando hay hallazgos (con auditoría limpia pasa roto)",
    fichero: CONTRATO,
    cambios: [
      ["    excepciones: obs?.excepciones,\n", "    excepciones: relevantes > 0 ? obs?.excepciones : undefined,\n"],
    ],
  },
  M24: {
    desc: "un fichero de excepciones `null` se lee como «ninguna excepción»",
    fichero: CONTRATO,
    cambios: [
      [
        "if (excepciones === undefined) return sinNada;",
        "if (excepciones === undefined || excepciones === null) return sinNada;",
      ],
    ],
  },
  M25: {
    desc: "el validador acepta fechas imposibles (2026-99-99)",
    fichero: CONTRATO,
    cambios: [["return d.toISOString().slice(0, 10) === valor ? d.getTime() : null;", "return d.getTime();"]],
  },
  M26: {
    desc: "el validador no acota el horizonte de 31 días desde `alta`",
    fichero: CONTRATO,
    cambios: [["if (caduca - alta > HORIZONTE_MAX_DIAS * 86400000) {", "if (false) {"]],
  },
  M27: {
    desc: "un aviso `via` sin severidad conocida se descarta como «no relevante» en vez de rechazar el informe",
    fichero: CONTRATO,
    cambios: [["if (!SEVERIDADES.includes(via.severity)) {", "if (false) {"]],
  },
  M28: {
    desc: "metadata cuenta más altas de las que el informe lista y aun así se da por bueno",
    fichero: CONTRATO,
    cambios: [["if (listadas < contadas) {", "if (false) {"]],
  },
  M29: {
    desc: "el GHSA se extrae de cualquier parte de la URL (sin anclar el principio)",
    fichero: CONTRATO,
    cambios: [["/^https:\\/\\/github\\.com", "/https:\\/\\/github\\.com"]],
  },
  M30: {
    desc: "el GHSA se extrae aunque la URL tenga cola (sin anclar el final)",
    fichero: CONTRATO,
    cambios: [["[0-9a-z]{4})$/,", "[0-9a-z]{4})/,"]],
  },
};

function correrSuites() {
  const r = spawnSync("npx", ["vitest", "run", ...SUITES], { cwd: RAIZ, encoding: "utf8" });
  return r.status === 0;
}

function main() {
  const objetivos = [...new Set(Object.values(MUTACIONES).map((m) => m.fichero))];
  const respaldos = new Map(objetivos.map((f) => [f, f + ".mutation-backup"]));
  for (const [f, b] of respaldos) copyFileSync(f, b);

  const restaurar = () => {
    for (const [f, b] of respaldos) {
      try {
        copyFileSync(b, f);
        unlinkSync(b);
      } catch {
        /* ya restaurado */
      }
    }
  };
  process.on("SIGINT", () => {
    restaurar();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restaurar();
    process.exit(143);
  });

  let fallos = 0;
  try {
    // Control POSITIVO: sin mutar, las suites tienen que estar VERDES. Si no,
    // cualquier "murió" posterior no probaría nada.
    process.stdout.write("BASE (sin mutar) · ");
    if (!correrSuites()) {
      console.log("ROJA — el harness no puede afirmar nada sobre las mutaciones");
      restaurar();
      return 1;
    }
    console.log("VERDE");

    for (const [id, m] of Object.entries(MUTACIONES)) {
      const original = readFileSync(m.fichero, "utf8");
      let mutado = original;
      let aplicada = true;
      for (const [de, a] of m.cambios) {
        if (!mutado.includes(de)) {
          console.log(`${id} · NO APLICABLE (el texto a mutar ya no está): ${de.slice(0, 70)}…`);
          aplicada = false;
          break;
        }
        mutado = mutado.replace(de, a);
      }
      if (!aplicada) {
        fallos += 1;
        continue;
      }
      writeFileSync(m.fichero, mutado);
      const verde = correrSuites();
      writeFileSync(m.fichero, original);
      if (verde) {
        console.log(`${id} · SOBREVIVE ❌ — ${m.desc}`);
        fallos += 1;
      } else {
        console.log(`${id} · muere (suite ROJA) ✔ — ${m.desc}`);
      }
    }
  } finally {
    restaurar();
  }

  console.log(fallos === 0 ? "\nTodas las mutaciones mueren." : `\n${fallos} mutación(es) sin matar.`);
  return fallos === 0 ? 0 : 1;
}

process.exit(main());
