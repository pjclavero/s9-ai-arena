#!/usr/bin/env node
/**
 * SEMÁNTICA DEL SCAN · ejecutor y declarador de estado del job `scan`.
 *
 * Antes, el job `scan` era tres `run:` sueltos y el ÚNICO dato que llegaba al
 * semáforo era el `result` del job: `success` o `failure`. Con eso no se puede
 * distinguir «el escáner corrió y no encontró nada» de «el escáner no pudo
 * mirar», ni «hay una vulnerabilidad» de «el endpoint de npm devolvió un
 * error». Este script convierte cada ejecución en uno de los cinco estados de
 * `packages/readiness/scan-status.mjs` y los DECLARA como outputs del job, que
 * es lo que el semáforo lee (mismo patrón de evidencia declarada que ya usa
 * `deploy-staging` con `outputs.resultado`).
 *
 * Subcomandos:
 *   ejecutar npm-audit   corre `npm audit --json`, con reintentos SÓLO mientras
 *                        el estado sea SOURCE_UNAVAILABLE (un hallazgo no se
 *                        reintenta: reintentar un hallazgo es esconderlo).
 *   ejecutar compose     corre el escáner de Compose.
 *   clasificar trivy     clasifica el informe JSON que dejó la acción de Trivy.
 *   resumir              agrega los estados y los publica como outputs del job.
 *
 * Cada subcomando añade una línea JSON al fichero de estados
 * (`$S9_SCAN_ESTADOS`, por defecto `scan-estados.jsonl`). `resumir` sale con 1
 * si el veredicto bloquea —para que el propio job se vea rojo— pero SIEMPRE
 * escribe los outputs antes de salir, de modo que el semáforo pueda nombrar el
 * bloqueo aunque el job esté en `failure`.
 *
 * Tests: infrastructure/tests/scan-gate.test.ts
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ESTADO_SCAN,
  READINESS,
  agregarScans,
  bloquea,
  clasificarNpmAudit,
  clasificarScanCompose,
  clasificarTrivy,
  endpointRetirado,
  motivoDeScan,
  readinessDeScan,
} from "../../packages/readiness/scan-status.mjs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FICHERO_ESTADOS = () => process.env.S9_SCAN_ESTADOS || join(process.cwd(), "scan-estados.jsonl");
const REINTENTOS = Number(process.env.S9_SCAN_REINTENTOS ?? 3);
const ESPERA_MS = Number(process.env.S9_SCAN_ESPERA_MS ?? 15000);

export function registrar(resultado) {
  appendFileSync(FICHERO_ESTADOS(), JSON.stringify(resultado) + "\n");
}

export function leerEstados(fichero = FICHERO_ESTADOS()) {
  if (!existsSync(fichero)) return [];
  return readFileSync(fichero, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function correr(cmd, args, opciones = {}) {
  const r = spawnSync(cmd, args, {
    cwd: RAIZ,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opciones,
  });
  return {
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : ""),
    timedOut: r.signal === "SIGTERM" && r.status === null,
  };
}

/** Duerme sin ocupar CPU. Sólo se usa entre reintentos de una fuente caída. */
function esperar(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `npm audit`. Se piden explícitamente `--json` y `--audit-level`:
 *   - `--json` es lo que permite leer el informe en vez de adivinar por el
 *     código de salida (que vale 1 tanto por vulnerabilidad como por caída).
 *   - `npm audit --json` usa el endpoint BULK de avisos (`/-/npm/v1/security/
 *     advisories/bulk`), no el `quick audit` que npm está retirando; ver
 *     docs/decisiones/ADR-018-semantica-del-scan.md. Si aun así aparece el aviso de
 *     retirada, se anota como warning para que no se descubra el día que deje
 *     de responder.
 */
export function ejecutarNpmAudit({ umbral = "high", reintentos = REINTENTOS, esperaMs = ESPERA_MS } = {}) {
  let ultimo = null;
  for (let intento = 1; intento <= Math.max(1, reintentos); intento += 1) {
    const obs = correr("npm", ["audit", "--json", `--audit-level=${umbral}`]);
    if (endpointRetirado(obs.stdout + obs.stderr)) {
      console.log(
        "::warning::npm sigue anunciando la retirada del endpoint de auditoría (`use the bulk advisory endpoint instead`): revisar ADR-018 antes de que deje de responder.",
      );
    }
    ultimo = clasificarNpmAudit({ ...obs, umbral });
    ultimo.intentos = intento;
    if (ultimo.estado !== ESTADO_SCAN.SOURCE_UNAVAILABLE) return ultimo;
    // Sólo se reintenta la fuente caída, y se dice en voz alta que se está
    // reintentando: un reintento silencioso es otra forma de no comprobar.
    console.log(`::warning::npm audit · fuente no disponible en el intento ${intento}: ${ultimo.detalle}`);
    if (intento < reintentos) esperar(esperaMs);
  }
  return ultimo;
}

export function ejecutarScanCompose(ficheros) {
  const script = join(RAIZ, "infrastructure", "scripts", "scan-compose.mjs");
  if (!existsSync(script)) {
    // El escáner que no está no es un árbol conforme: es un escáner que falta.
    return { estado: ESTADO_SCAN.NOT_EXERCISED, detalle: "no existe infrastructure/scripts/scan-compose.mjs" };
  }
  const obs = correr(process.execPath, [script, ...ficheros]);
  return clasificarScanCompose({ ...obs, ejecutado: true });
}

/**
 * Trivy. La acción de GitHub corre con `exit-code: "0"` y vuelca el informe a
 * un fichero: así el código de salida deja de ser el veredicto y el veredicto
 * sale del informe. Si la acción falló (`outcome=failure`) y no hay informe
 * legible, es la base de datos que no se pudo descargar: SOURCE_UNAVAILABLE,
 * reintentable, y jamás «0 vulnerabilidades».
 */
export function clasificarInformeTrivy({ fichero, outcome = "success", severidades }) {
  const existe = fichero && existsSync(fichero);
  const stdout = existe ? readFileSync(fichero, "utf8") : "";
  if (!existe || stdout.trim() === "") {
    return outcome === "success"
      ? {
          estado: ESTADO_SCAN.SCAN_ERROR,
          detalle: `trivy declaró éxito pero no dejó informe en ${fichero}: no hay prueba de que analizara nada`,
        }
      : { estado: ESTADO_SCAN.SOURCE_UNAVAILABLE, detalle: "trivy falló sin dejar informe (base de datos o red)" };
  }
  const r = clasificarTrivy({ stdout, severidades });
  if (outcome !== "success" && r.estado === ESTADO_SCAN.CLEAN) {
    // La acción falló pero el informe dice «limpio»: no se colapsa a verde.
    return { estado: ESTADO_SCAN.SCAN_ERROR, detalle: "trivy terminó con error pese a un informe sin hallazgos" };
  }
  return r;
}

/**
 * Escáneres que el job DEBE ejecutar. Si uno no declaró estado —porque su paso
 * se saltó al fallar el anterior, o porque alguien lo borró del workflow— el
 * veredicto NO se calcula sólo con los que sí hablaron: el ausente entra como
 * NOT_EXERCISED. Sin esto, borrar un escáner del workflow saldría verde.
 */
export const ESCANERES_ESPERADOS = Object.freeze(["npm-audit", "compose", "trivy"]);

/** Publica el veredicto agregado como outputs del job y como summary. */
export function resumir(estados, esperados = ESCANERES_ESPERADOS) {
  const declarados = new Set((estados ?? []).map((e) => e.herramienta));
  const completos = [
    ...(estados ?? []),
    ...esperados
      .filter((h) => !declarados.has(h))
      .map((h) => ({
        herramienta: h,
        estado: ESTADO_SCAN.NOT_EXERCISED,
        detalle: "el escáner no declaró ningún estado en este run (paso saltado o retirado del workflow)",
      })),
  ];
  const veredicto = agregarScans(completos);
  const motivo = motivoDeScan(veredicto.estado, veredicto.detalle);
  const lineas = [
    `## Escaneo de seguridad: ${veredicto.estado} → readiness \`${veredicto.readiness}\``,
    "",
    motivo.texto,
    "",
    "| Escáner | Estado | Readiness | Detalle |",
    "|---|---|---|---|",
    ...veredicto.partes.map((p) => `| \`${p.herramienta}\` | ${p.estado} | ${p.readiness} | ${p.detalle} |`),
    "",
    "_Un fallo de red, de límite de tasa o de herramienta NUNCA se convierte en «0 vulnerabilidades»: bloquea como NO COMPROBADO._",
  ];
  return { veredicto, motivo, markdown: lineas.join("\n") };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function salidaGitHub(pares) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(pares)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

function main(argv) {
  const [sub, ...resto] = argv;

  if (sub === "ejecutar" && resto[0] === "npm-audit") {
    const r = ejecutarNpmAudit({ umbral: process.env.S9_SCAN_UMBRAL || "high" });
    registrar({ herramienta: "npm-audit", ...r });
    console.log(`npm-audit → ${r.estado}: ${r.detalle}`);
    return 0;
  }
  if (sub === "ejecutar" && resto[0] === "compose") {
    const ficheros = resto.slice(1);
    const r = ejecutarScanCompose(ficheros);
    registrar({ herramienta: "compose", ...r });
    console.log(`compose → ${r.estado}: ${r.detalle}`);
    return 0;
  }
  if (sub === "clasificar" && resto[0] === "trivy") {
    const fichero = resto.find((a, i) => i > 0 && !a.startsWith("--"));
    const exigir = resto.includes("--exigir");
    const r = clasificarInformeTrivy({ fichero, outcome: process.env.S9_TRIVY_OUTCOME || "success" });
    // `--exigir` es para quien NO tiene semáforo detrás (scripts sueltos como
    // scripts/scan-runtime-vulns.sh): ahí el propio código de salida es el
    // veredicto, así que sólo CLEAN sale con 0 y el motivo se imprime con su
    // nombre — «no comprobado» no se disfraza de «sin vulnerabilidades».
    if (exigir) {
      const readiness = readinessDeScan(r.estado, { herramienta: "trivy" });
      console.log(`trivy → ${r.estado} (${readiness}): ${motivoDeScan(r.estado, r.detalle).texto}`);
      return bloquea(readiness) ? 1 : 0;
    }
    registrar({ herramienta: "trivy", ...r });
    console.log(`trivy → ${r.estado}: ${r.detalle}`);
    return 0;
  }
  if (sub === "resumir") {
    const { veredicto, motivo, markdown } = resumir(leerEstados());
    console.log(markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
    salidaGitHub({
      estado: veredicto.estado,
      readiness: veredicto.readiness,
      clase: motivo.clase,
      reintentable: String(motivo.reintentable),
    });
    if (bloquea(veredicto.readiness)) {
      console.log(`::error::scan · ${motivo.texto}`);
      return 1;
    }
    return 0;
  }

  console.error(
    "uso: scan-gate.mjs (ejecutar npm-audit|ejecutar compose <ficheros...>|clasificar trivy <json>|resumir)",
  );
  return 2;
}

// Solo actúa como CLI si se ejecuta directamente (no al importarlo en tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { READINESS };
