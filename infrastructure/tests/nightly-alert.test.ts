// V1-OPS · AUD2-01 / D-OP-13: el aviso del nightly. El guion `nightly-alert.sh` se ejecuta de verdad
// con un `gh` falso que registra cada llamada; el workflow se parsea como YAML (no con regex).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "nightly-alert.sh");
const WORKFLOW = join(ROOT, ".github", "workflows", "nightly.yml");

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nightly-alert-"));
  log = join(dir, "gh.log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `gh` falso: `issue list` devuelve FAKE_OPEN (número o vacío) o falla con FAKE_LIST_FAIL. */
function fakeGh() {
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1 $2" = "issue list" ]; then
  [ -n "\${FAKE_LIST_FAIL:-}" ] && { echo "HTTP 502" >&2; exit 1; }
  echo "\${FAKE_OPEN:-}"
fi
exit 0
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
}

function run(env: Record<string, string>) {
  fakeGh();
  try {
    const out = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUN_URL: "https://x/run/1", SHA: "abc123", ...env },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
  }
}
const calls = () => readFileSync(log, "utf8").trim().split("\n");

describe("nightly-alert.sh", () => {
  it("fallo sin issue abierto: crea el issue (y la etiqueta)", () => {
    const r = run({ RESULT: "failure" });
    expect(r.code).toBe(0);
    expect(calls().some((c) => c.startsWith("issue create --title Nightly en rojo --label nightly-fallido"))).toBe(true);
    expect(calls().some((c) => c.startsWith("label create nightly-fallido"))).toBe(true);
  });

  it("fallo con issue abierto: lo ACTUALIZA con un comentario, no abre otro", () => {
    const r = run({ RESULT: "failure", FAKE_OPEN: "42" });
    expect(r.code).toBe(0);
    expect(calls().some((c) => c.startsWith("issue comment 42"))).toBe(true);
    expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
  });

  it("verde con issue abierto: comenta y CIERRA", () => {
    const r = run({ RESULT: "success", FAKE_OPEN: "42" });
    expect(r.code).toBe(0);
    expect(calls().some((c) => c.startsWith("issue comment 42"))).toBe(true);
    expect(calls().some((c) => c === "issue close 42")).toBe(true);
  });

  it("verde sin issue abierto: no escribe nada", () => {
    const r = run({ RESULT: "success" });
    expect(r.code).toBe(0);
    expect(calls().some((c) => /^issue (create|comment|close)/.test(c))).toBe(false);
  });

  it("un error de la API al listar NO se toma por «no hay issue»: falla y no crea duplicados", () => {
    const r = run({ RESULT: "failure", FAKE_LIST_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(calls().some((c) => c.startsWith("issue create"))).toBe(false);
  });

  it("RESULT ausente o raro: rc=2 y no toca nada", () => {
    expect(run({ RESULT: "" }).code).toBe(2);
    expect(run({ RESULT: "cancelled" }).code).toBe(2);
  });

  it("el título y la etiqueta de prueba usan un issue aparte", () => {
    run({ RESULT: "failure", TITLE: "[PRUEBA] Nightly en rojo", LABEL: "nightly-prueba" });
    expect(calls().some((c) => c.includes("--label nightly-prueba"))).toBe(true);
  });
});

describe("nightly.yml · el job de aviso", () => {
  const wf: any = parse(readFileSync(WORKFLOW, "utf8"));
  const aviso = wf.jobs.aviso;
  const paso = () => String(aviso.steps.find((s: any) => s.run)?.run);

  it("depende de TODOS los jobs de pruebas y corre siempre (aunque fallen)", () => {
    const pruebas = Object.keys(wf.jobs).filter((j) => j !== "aviso");
    expect(pruebas.length).toBeGreaterThanOrEqual(2);
    expect([...aviso.needs].sort()).toEqual([...pruebas].sort());
    expect(String(aviso.if)).toContain("always()");
  });

  it("permisos mínimos: sólo issues:write (más lectura de contenido) y lectura por defecto", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(aviso.permissions).toEqual({ contents: "read", issues: "write" });
    for (const [n, j] of Object.entries<any>(wf.jobs)) if (n !== "aviso") expect(j.permissions, n).toBeUndefined();
  });

  it("sólo usa GITHUB_TOKEN: ningún secreto ni servicio externo", () => {
    const texto = readFileSync(WORKFLOW, "utf8");
    expect(texto).not.toMatch(/secrets\./);
    expect(texto).not.toMatch(/(slack|discord|webhook|smtp)/i);
  });

  it("un job cancelado, saltado o con tiempo agotado cuenta como rojo (verde = ambos success)", () => {
    expect(paso()).toContain('[ "$R_DET" = success ] && [ "$R_SLOW" = success ]');
  });

  it("el modo de prueba salta las suites pesadas y usa un issue aparte", () => {
    expect(paso()).toContain("[PRUEBA]");
    expect(paso()).toContain("nightly-prueba");
    for (const j of ["determinism-1000", "slow-suites"]) expect(String(wf.jobs[j].if)).toContain("prueba_aviso");
  });
});
