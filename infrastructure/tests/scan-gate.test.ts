/**
 * SEMÁNTICA DEL SCAN · el ejecutor del job `scan` y su cableado en ci.yml.
 *
 * Aquí no se prueba la tabla (eso es scan-status.test.ts) sino el EFECTO: qué
 * outputs publica el job, con qué código sale, y que el workflow que corre de
 * verdad está cableado a este script y no al `npm audit` pelado de antes.
 *
 * El workflow se PARSEA como YAML y se navega la estructura: contar
 * apariciones de una cadena da falsos negativos en cuanto alguien mueve un
 * paso de sitio.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import { ESCANERES_ESPERADOS, clasificarInformeTrivy, resumir } from "../scripts/scan-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(here, "..", "..");
const GATE = join(RAIZ, "infrastructure", "scripts", "scan-gate.mjs");

function correrResumir(lineas: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "scan-gate-"));
  const estados = join(dir, "estados.jsonl");
  const salida = join(dir, "github_output");
  writeFileSync(estados, lineas.map((l) => JSON.stringify(l)).join("\n") + (lineas.length ? "\n" : ""));
  writeFileSync(salida, "");
  let code = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [GATE, "resumir"], {
      encoding: "utf8",
      env: { ...process.env, S9_SCAN_ESTADOS: estados, GITHUB_OUTPUT: salida },
    });
  } catch (e: any) {
    code = e.status;
    stdout = String(e.stdout ?? "");
  }
  const outputs: Record<string, string> = {};
  for (const linea of readFileSync(salida, "utf8").split("\n")) {
    const i = linea.indexOf("=");
    if (i > 0) outputs[linea.slice(0, i)] = linea.slice(i + 1);
  }
  return { code, stdout, outputs };
}

const CLEAN = (h: string) => ({ herramienta: h, estado: "CLEAN", detalle: "ok" });
const TODOS_LIMPIOS = ESCANERES_ESPERADOS.map((h: string) => CLEAN(h));

describe("scan-gate · resumir declara el estado como output del job", () => {
  it("control POSITIVO: los tres escáneres limpios → estado=CLEAN, readiness=verified, exit 0", () => {
    const r = correrResumir(TODOS_LIMPIOS);
    expect(r.outputs.estado).toBe("CLEAN");
    expect(r.outputs.readiness).toBe("verified");
    expect(r.code).toBe(0);
  });

  it("control NEGATIVO: un hallazgo → estado=FINDINGS, clase=hallazgos, exit 1", () => {
    const r = correrResumir([
      CLEAN("npm-audit"),
      CLEAN("compose"),
      { herramienta: "trivy", estado: "FINDINGS", detalle: "1 CRITICAL" },
    ]);
    expect(r.outputs.estado).toBe("FINDINGS");
    expect(r.outputs.readiness).toBe("failed");
    expect(r.outputs.clase).toBe("hallazgos");
    expect(r.outputs.reintentable).toBe("false");
    expect(r.code).toBe(1);
  });

  it("EL INCIDENTE: el endpoint de npm caído → estado=SOURCE_UNAVAILABLE, clase=no-comprobado y REINTENTABLE", () => {
    const r = correrResumir([
      { herramienta: "npm-audit", estado: "SOURCE_UNAVAILABLE", detalle: "audit endpoint returned an error" },
      CLEAN("compose"),
      CLEAN("trivy"),
    ]);
    expect(r.outputs.estado).toBe("SOURCE_UNAVAILABLE");
    expect(r.outputs.readiness).toBe("not_exercised");
    expect(r.outputs.clase).toBe("no-comprobado");
    expect(r.outputs.reintentable).toBe("true");
    // Bloquea igual que un hallazgo, pero NO se llama igual.
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/HALLAZGOS DE SEGURIDAD/);
    expect(r.stdout).toMatch(/NO COMPROBADO/);
  });

  it("DoD: un escáner que no declaró nada (paso saltado o borrado del workflow) → NOT_EXERCISED", () => {
    const r = correrResumir([CLEAN("npm-audit"), CLEAN("compose")]); // falta trivy
    expect(r.outputs.estado).toBe("NOT_EXERCISED");
    expect(r.outputs.readiness).toBe("not_exercised");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/trivy/);
  });

  it("DoD: fichero de estados vacío → NOT_EXERCISED, jamás un verde por silencio", () => {
    const r = correrResumir([]);
    expect(r.outputs.readiness).toBe("not_exercised");
    expect(r.code).toBe(1);
  });

  it("los outputs se escriben SIEMPRE, también cuando el job sale con 1 (el semáforo debe poder nombrarlo)", () => {
    const r = correrResumir([{ herramienta: "npm-audit", estado: "SCAN_ERROR", detalle: "json ilegible" }]);
    expect(r.code).toBe(1);
    expect(r.outputs.estado).toBe("SCAN_ERROR");
    expect(r.outputs.readiness).toBeTruthy();
  });

  it("resumir() como función: el resumen enseña la tabla por escáner", () => {
    const { veredicto, markdown } = resumir(TODOS_LIMPIOS);
    expect(veredicto.readiness).toBe("verified");
    for (const h of ESCANERES_ESPERADOS) expect(markdown).toContain(h);
  });
});

describe("scan-gate · informe de Trivy ausente o degradado", () => {
  const dir = mkdtempSync(join(tmpdir(), "trivy-"));

  it("control POSITIVO: informe con objetivos → CLEAN", () => {
    const f = join(dir, "ok.json");
    writeFileSync(
      f,
      JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "package-lock.json", Vulnerabilities: [] }] }),
    );
    expect(clasificarInformeTrivy({ fichero: f, outcome: "success" }).estado).toBe("CLEAN");
  });

  it("DoD: la acción dice éxito pero NO dejó informe → SCAN_ERROR (no hay prueba de nada)", () => {
    expect(clasificarInformeTrivy({ fichero: join(dir, "no-existe.json"), outcome: "success" }).estado).toBe(
      "SCAN_ERROR",
    );
  });

  it("DoD: la acción falló y no hay informe → SOURCE_UNAVAILABLE (base de datos o red)", () => {
    expect(clasificarInformeTrivy({ fichero: join(dir, "no-existe.json"), outcome: "failure" }).estado).toBe(
      "SOURCE_UNAVAILABLE",
    );
  });

  it("DoD: la acción falló pero el informe dice «limpio» → NO se colapsa a CLEAN", () => {
    const f = join(dir, "raro.json");
    writeFileSync(f, JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "x", Vulnerabilities: [] }] }));
    expect(clasificarInformeTrivy({ fichero: f, outcome: "failure" }).estado).toBe("SCAN_ERROR");
  });

  it("informe vacío (0 bytes) tratado como ausente, no como limpio", () => {
    const f = join(dir, "vacio.json");
    writeFileSync(f, "");
    expect(clasificarInformeTrivy({ fichero: f, outcome: "success" }).estado).toBe("SCAN_ERROR");
  });
});

describe("scan-gate · escáner de Compose ejecutado DE VERDAD (control positivo y negativo)", () => {
  it("el Compose real del repositorio pasa el escáner → CLEAN", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-ok-"));
    const estados = join(dir, "e.jsonl");
    execFileSync(process.execPath, [GATE, "ejecutar", "compose", "infrastructure/docker-compose.yml"], {
      cwd: RAIZ,
      encoding: "utf8",
      env: { ...process.env, S9_SCAN_ESTADOS: estados },
    });
    const [linea] = readFileSync(estados, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(linea.herramienta).toBe("compose");
    expect(linea.estado).toBe("CLEAN");
  });

  it("un Compose con docker.sock → FINDINGS (el escáner puede ponerse rojo de verdad)", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-mal-"));
    const compose = join(dir, "docker-compose.yml");
    writeFileSync(
      compose,
      "services:\n  malo:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );
    const estados = join(dir, "e.jsonl");
    execFileSync(process.execPath, [GATE, "ejecutar", "compose", compose], {
      cwd: RAIZ,
      encoding: "utf8",
      env: { ...process.env, S9_SCAN_ESTADOS: estados },
    });
    const [linea] = readFileSync(estados, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(linea.estado).toBe("FINDINGS");
  });
});

// ── El cableado real del workflow (frontera de confianza) ───────────────────
describe("ci.yml · el job scan está cableado a la semántica de cinco estados", () => {
  const wf = parse(readFileSync(join(RAIZ, ".github", "workflows", "ci.yml"), "utf8"));
  const scan = wf.jobs.scan;
  const pasos: any[] = scan.steps;

  it("el job DECLARA estado y readiness como outputs (si no, el semáforo no tiene qué leer)", () => {
    expect(Object.keys(scan.outputs ?? {})).toEqual(expect.arrayContaining(["estado", "readiness"]));
    for (const clave of ["estado", "readiness"]) {
      expect(String(scan.outputs[clave])).toMatch(/steps\.\w+\.outputs\./);
    }
  });

  it("ningún paso corre `npm audit` a pelo: el veredicto sale del informe, no del código de salida", () => {
    for (const paso of pasos) {
      const run = String(paso.run ?? "");
      if (/npm audit/.test(run)) expect(run).toMatch(/scan-gate\.mjs/);
    }
  });

  it("los tres escáneres esperados tienen paso propio y todos pasan por scan-gate", () => {
    const runs = pasos.map((p) => String(p.run ?? "")).join("\n");
    expect(runs).toMatch(/scan-gate\.mjs ejecutar npm-audit/);
    expect(runs).toMatch(/scan-gate\.mjs ejecutar compose/);
    expect(runs).toMatch(/scan-gate\.mjs clasificar trivy/);
    expect(runs).toMatch(/scan-gate\.mjs resumir/);
  });

  it("la acción de Trivy NO decide por código de salida: exit-code 0 y salida JSON", () => {
    const trivy = pasos.find((p) => String(p.uses ?? "").includes("trivy-action"));
    expect(trivy).toBeTruthy();
    expect(String(trivy.with["exit-code"])).toBe("0");
    expect(trivy.with.format).toBe("json");
    expect(trivy.with.output).toBeTruthy();
    // Su fallo no puede tumbar el job sin clasificarse antes.
    expect(trivy["continue-on-error"]).toBe(true);
  });

  it("los pasos que declaran estado corren aunque uno anterior falle (si no, un ausente sería invisible)", () => {
    const resumen = pasos.find((p) => String(p.run ?? "").includes("resumir"));
    expect(resumen.if).toBe("always()");
    const clasifica = pasos.find((p) => String(p.run ?? "").includes("clasificar trivy"));
    expect(clasifica.if).toBe("always()");
  });

  it("el semáforo sigue teniendo a `scan` entre sus needs", () => {
    expect(wf.jobs.semaforo.needs).toContain("scan");
  });
});

// ── El otro punto del pipeline con la misma confusión (E6 security) ─────────
describe("scripts/scan-runtime-vulns.sh · mismo contrato, sin semáforo detrás", () => {
  const sh = readFileSync(join(RAIZ, "scripts", "scan-runtime-vulns.sh"), "utf8");

  it("no vuelve a usar `--exit-code 1` de Trivy como veredicto", () => {
    expect(sh).not.toMatch(/^\s*trivy image[^\n]*--exit-code 1/m);
    expect(sh).toMatch(/--format json/);
  });

  it("clasifica el informe con scan-gate y exige CLEAN para salir con 0", () => {
    expect(sh).toMatch(/scan-gate\.mjs"? clasificar trivy [^\n]*--exigir/);
    expect(sh).toMatch(/S9_TRIVY_OUTCOME/);
  });
});

describe("scan-gate · modo --exigir (para scripts sin semáforo)", () => {
  const dir = mkdtempSync(join(tmpdir(), "exigir-"));
  function exigir(contenido: string | null, outcome = "success") {
    const f = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    if (contenido !== null) writeFileSync(f, contenido);
    try {
      const stdout = execFileSync(process.execPath, [GATE, "clasificar", "trivy", f, "--exigir"], {
        encoding: "utf8",
        env: { ...process.env, S9_TRIVY_OUTCOME: outcome, S9_SCAN_ESTADOS: join(dir, "no-usado.jsonl") },
      });
      return { code: 0, stdout };
    } catch (e: any) {
      return { code: e.status as number, stdout: String(e.stdout ?? "") };
    }
  }

  it("control POSITIVO: informe limpio con objetivos → exit 0", () => {
    const r = exigir(JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "x", Vulnerabilities: [] }] }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/CLEAN/);
  });

  it("control NEGATIVO: una CRITICAL → exit 1 y se llama HALLAZGOS", () => {
    const r = exigir(
      JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "x", Vulnerabilities: [{ Severity: "CRITICAL" }] }] }),
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FINDINGS/);
  });

  it("DoD: base de datos no descargada (sin informe, outcome failure) → exit 1 como NO COMPROBADO, no como hallazgo", () => {
    const r = exigir(null, "failure");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/SOURCE_UNAVAILABLE/);
    expect(r.stdout).toMatch(/NO COMPROBADO/);
    expect(r.stdout).not.toMatch(/HALLAZGOS/);
  });

  it("DoD: informe sin objetivos con exit 0 → exit 1 (nunca «sin vulnerabilidades críticas»)", () => {
    const r = exigir(JSON.stringify({ SchemaVersion: 2, Results: [] }));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/SCAN_ERROR/);
  });
});

describe("scan-gate · npm audit EJECUTADO de verdad contra un registro inalcanzable", () => {
  // Control positivo REAL del incidente, sin simular la salida de npm: se
  // apunta npm a un puerto muerto y se comprueba que el ejecutor llega a
  // SOURCE_UNAVAILABLE (reintentando) en vez de a FINDINGS o a CLEAN. Es la
  // diferencia entre afirmar que el clasificador sabe y verlo saber.
  it("registro caído → SOURCE_UNAVAILABLE, con reintentos anotados", () => {
    const dir = mkdtempSync(join(tmpdir(), "npm-caido-"));
    const estados = join(dir, "e.jsonl");
    const stdout = execFileSync(process.execPath, [GATE, "ejecutar", "npm-audit"], {
      cwd: RAIZ,
      encoding: "utf8",
      env: {
        ...process.env,
        S9_SCAN_ESTADOS: estados,
        S9_SCAN_REINTENTOS: "2",
        S9_SCAN_ESPERA_MS: "50",
        npm_config_registry: "http://127.0.0.1:9/",
      },
    });
    const [linea] = readFileSync(estados, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(linea.estado).toBe("SOURCE_UNAVAILABLE");
    expect(linea.intentos).toBe(2);
    expect(stdout).toMatch(/::warning::/);
  }, 180000);
});
