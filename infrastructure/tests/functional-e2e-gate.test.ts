// PRC DEV-CI · TD-045 — el golden path funcional es un gate REAL de CI.
//
// Garantías (cada una con su control negativo):
//   G1 ci.yml tiene el job `functional-e2e` (reusable functional-e2e.yml) en todo PR
//      y push a main, sin `if:` ni continue-on-error, y el semáforo lo espera.
//   G2 el semáforo pone ROJO un functional-e2e skipped / cancelled / ausente / failure.
//   G3 functional-e2e.yml ejecuta el E2E COMPLETO (npm run test:browser, sin
//      S9_E2E_SKIP_GOLDEN) y los E2E Docker con el opt-in ACTIVADO; también como
//      workflow_dispatch (gate de release); evidencia y limpieza con if: always().
//   G4 el veredicto independiente (scripts/ci/assert-functional-e2e.mjs) no acepta
//      skipped, 0 tests, batalla sin contenedores ni bots que no corrieron su código.
//   G5 la evidencia no sube secretos: secrets/ y certs/ fuera, y una fuga del
//      contenido de un secreto a un log ⇒ rc 1 y fichero retirado.
//   G6 (PRC REVIEW, TD-034) el gate corre con los MISMOS relojes de arranque que
//      producción: run.sh los fija explícitamente con los defectos del compose y
//      del código, y el workflow no los sobrescribe.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error módulo .mjs sin tipos
import { evaluarSemaforo, JOBS_CI } from "../scripts/ci-gate.mjs";
import { DEFAULT_STARTUP_TIMEOUTS } from "../../apps/bot-manager/src/startup-clock.js";
// @ts-expect-error módulo .mjs sin tipos
import { evaluarE2E, evaluarVitest, FASES } from "../../scripts/ci/assert-functional-e2e.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const CI = parse(readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8"));
const FE = parse(readFileSync(join(REPO, ".github/workflows/functional-e2e.yml"), "utf8"));
const ASSERT = join(REPO, "scripts/ci/assert-functional-e2e.mjs");
const COLLECT = join(REPO, "scripts/ci/collect-functional-evidence.sh");

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: unknown;
  with?: Record<string, unknown>;
};
const steps = (job: string): Step[] => FE.jobs[job].steps as Step[];

describe("G1 · ci.yml: functional-e2e es un job obligatorio del semáforo", () => {
  it("se dispara en pull_request y push a main", () => {
    expect(CI.on).toHaveProperty("pull_request");
    expect(CI.on.push.branches).toContain("main");
  });

  it("el job llama al reusable, sin if: ni continue-on-error", () => {
    const job = CI.jobs["functional-e2e"];
    expect(job, "falta el job functional-e2e en ci.yml").toBeDefined();
    expect(job.uses).toBe("./.github/workflows/functional-e2e.yml");
    expect(job.if, "un if: lo convertiría en opt-in").toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
  });

  it("semaforo corre siempre y necesita TODOS los jobs del catálogo (functional-e2e incluido)", () => {
    const sem = CI.jobs.semaforo;
    expect(sem.if).toBe("always()");
    const ids = JOBS_CI.map((j: { id: string }) => j.id);
    expect(ids).toContain("functional-e2e");
    for (const id of ids) expect(sem.needs, `semaforo.needs sin ${id}`).toContain(id);
    expect(JOBS_CI.find((j: { id: string }) => j.id === "functional-e2e").clase).toBe("obligatorio");
  });
});

describe("G2 · semáforo: functional-e2e skipped NO es verde", () => {
  const base = () => {
    const n: Record<string, { result: string; outputs: Record<string, string> }> = {};
    for (const j of JOBS_CI) n[j.id] = { result: "success", outputs: {} };
    n.scan = { result: "success", outputs: { estado: "CLEAN" } };
    n["deploy-staging"] = { result: "skipped", outputs: {} };
    n["smoke-and-promote"] = { result: "skipped", outputs: {} };
    return n;
  };

  it("control positivo: functional-e2e success en PR → VERDE", () => {
    expect(evaluarSemaforo(base(), { mainRun: false }).color).toBe("verde");
  });

  for (const result of ["skipped", "cancelled", "failure"]) {
    for (const mainRun of [false, true]) {
      it(`functional-e2e ${result} (${mainRun ? "main" : "PR"}) → ROJO`, () => {
        const n = base();
        n["functional-e2e"] = { result, outputs: {} };
        const v = evaluarSemaforo(n, { mainRun });
        expect(v.color).toBe("rojo");
        expect(v.filas.find((f: { id: string }) => f.id === "functional-e2e").color).toBe("rojo");
      });
    }
  }

  it("functional-e2e ausente de needs → ROJO (fail-closed)", () => {
    const n = base();
    delete (n as Record<string, unknown>)["functional-e2e"];
    expect(evaluarSemaforo(n, { mainRun: false }).color).toBe("rojo");
  });
});

describe("G3 · functional-e2e.yml ejecuta el E2E completo y activa el opt-in", () => {
  it("disparadores: workflow_call (ci.yml) y workflow_dispatch (gate de release)", () => {
    expect(FE.on).toHaveProperty("workflow_call");
    expect(FE.on).toHaveProperty("workflow_dispatch");
  });

  it("jobs golden y docker-e2e, sin if: ni continue-on-error, con timeout propio", () => {
    for (const id of ["golden", "docker-e2e"]) {
      const job = FE.jobs[id];
      expect(job, id).toBeDefined();
      expect(job.if).toBeUndefined();
      expect(job["continue-on-error"]).toBeUndefined();
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      for (const s of job.steps as Step[]) expect(s["continue-on-error"], `${id}/${s.name}`).toBeUndefined();
    }
  });

  it("golden ejecuta npm run test:browser sin S9_E2E_SKIP_GOLDEN y con imágenes fijadas", () => {
    const run = steps("golden").find((s) => s.run?.includes("npm run test:browser"));
    expect(run, "falta el paso npm run test:browser").toBeDefined();
    expect(run!.if).toBeUndefined();
    expect(run!["timeout-minutes" as keyof Step]).toBeGreaterThan(0);
    expect(JSON.stringify(FE)).not.toContain("S9_E2E_SKIP_GOLDEN");
    expect(FE.env.S9_E2E_NGINX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(FE.env.PW_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(FE.env.NODE_VERSION).toMatch(/^22\.15\.\d+$/);
    for (const svc of Object.values(FE.jobs.golden.services) as { image: string }[])
      expect(svc.image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("el veredicto independiente, la evidencia y la limpieza corren SIEMPRE", () => {
    const g = steps("golden");
    const assertStep = g.find((s) => s.run?.includes("assert-functional-e2e.mjs browser"));
    const collect = g.find((s) => s.run?.includes("collect-functional-evidence.sh"));
    const upload = g.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    const clean = g.find((s) => s.run?.includes("cleanup-functional-e2e.sh"));
    for (const s of [assertStep, collect, upload, clean]) {
      expect(s).toBeDefined();
      expect(s!.if).toBe("always()");
    }
    const d = steps("docker-e2e");
    expect(d.find((s) => s.run?.includes("assert-functional-e2e.mjs vitest"))!.if).toBe("always()");
  });

  it("docker-e2e activa los opt-in (sandbox, Docker real y gateway TD-004) y exige sus 7 ficheros", () => {
    const env = FE.jobs["docker-e2e"].env;
    expect(env.S9_RUN_DOCKER_SANDBOX_E2E).toBe("1");
    expect(env.S9_RUN_REAL_DOCKER_E2E).toBe("1");
    // PRC REVIEW · el test del bypass /replays* sobre el nginx REAL (TD-004) es
    // opt-in: sin esta variable el fichero se salta y el veredicto lo rechaza.
    expect(env.S9_RUN_GATEWAY_SECURITY_E2E).toBe("1");
    // La imagen nginx del test del gateway es la MISMA fijada por digest que la del golden.
    expect(env.S9_GATEWAY_TEST_NGINX_IMAGE).toBe(FE.env.S9_E2E_NGINX_IMAGE);
    const files = [
      "apps/bot-manager/tests/build-sandbox-docker.test.ts",
      // PRC REVIEW · TD-034: dos relojes con contenedores reales (SAN-5/6/7/9/10).
      "apps/bot-manager/tests/build-sandbox-timing-docker.test.ts",
      // RC2 DEV-PROXY · proxy endurecido contra Docker real (allowlist, propiedad, cliente).
      "apps/bot-manager/tests/docker-proxy-docker.test.ts",
      // RC2 · el perfil seccomp del bot resuelve por nombre (hallazgo de container-proxy-e2e).
      "apps/bot-manager/tests/seccomp-bot-dns.test.ts",
      "apps/api/src/fc-a-bot-pipeline-e2e.test.ts",
      "apps/tournament-worker/src/container-battle-e2e.test.ts",
      // PRC REVIEW · TD-004: bypass del gateway sobre las confs reales.
      "infrastructure/gateway/tests/replay-gateway.test.ts",
    ];
    const run = steps("docker-e2e").find((s) => s.run?.includes("npx vitest run"))!.run!;
    const check = steps("docker-e2e").find((s) => s.run?.includes("assert-functional-e2e.mjs vitest"))!.run!;
    for (const f of files) {
      expect(existsSync(join(REPO, f)), f).toBe(true);
      expect(run).toContain(f);
      expect(check).toContain(f);
    }
  });
});

// ── G4 · veredicto independiente ────────────────────────────────────────────
function fixtureOut(mut: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fe2e-"));
  writeFileSync(join(dir, "summary.txt"), "[run.sh] BROWSER_E2E_RC=0 (golden=0 fase1=0 fase2=0 fase3=0 sonda=0)\n");
  for (const f of FASES) {
    mkdirSync(join(dir, f), { recursive: true });
    writeFileSync(
      join(dir, f, "report.json"),
      JSON.stringify({ stats: { expected: f === "fase1" ? 14 : 1, unexpected: 0, flaky: 0, skipped: 0 } }),
    );
  }
  writeFileSync(
    join(dir, "golden", "evidence.json"),
    JSON.stringify({
      battleId: "b-1",
      result: { schema: "battle-result/v1", agents: "container", winner: "red" },
      stats: { red: 11, blue: 0 },
      replayPath: { apiIndex200: 1, apiSegment200: 3, gatewayReplays: 0 },
    }),
  );
  writeFileSync(
    join(dir, "ticket-probe.json"),
    JSON.stringify({ sharedSecret: { code: 4404 }, foreignSecret: { code: 4401 } }),
  );
  mut(dir);
  return dir;
}
const rep = (dir: string, fase: string, stats: Record<string, number>) =>
  writeFileSync(join(dir, fase, "report.json"), JSON.stringify({ stats }));
const ev = (dir: string, patch: Record<string, unknown>) => {
  const p = join(dir, "golden", "evidence.json");
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }));
};

describe("G4 · assert-functional-e2e (browser): skipped no es verde", () => {
  it("control positivo: todo ejecutado y la batalla real → PASS (CLI rc 0)", () => {
    const dir = fixtureOut();
    expect(evaluarE2E(dir).ok).toBe(true);
    const r = spawnSync(process.execPath, [ASSERT, "browser", dir], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    expect(r.status).toBe(0);
  });

  const casos: [string, (d: string) => void][] = [
    ["golden con el test skipped", (d) => rep(d, "golden", { expected: 0, unexpected: 0, flaky: 0, skipped: 1 })],
    [
      "golden con 0 tests (grep sin casar)",
      (d) => rep(d, "golden", { expected: 0, unexpected: 0, flaky: 0, skipped: 0 }),
    ],
    [
      "fase1 con 1 skipped además de los pasados",
      (d) => rep(d, "fase1", { expected: 13, unexpected: 0, flaky: 0, skipped: 1 }),
    ],
    ["fase2 flaky", (d) => rep(d, "fase2", { expected: 1, unexpected: 0, flaky: 1, skipped: 0 })],
    ["fase3 sin report.json (no llegó a correr)", (d) => writeFileSync(join(d, "fase3", "report.json"), "{")],
    ["summary con rc≠0", (d) => writeFileSync(join(d, "summary.txt"), "BROWSER_E2E_RC=1 (golden=1)\n")],
    ["summary sin rc (el E2E murió antes)", (d) => writeFileSync(join(d, "summary.txt"), "vite build…\n")],
    [
      "batalla sin contenedores (agents=builtin)",
      (d) => ev(d, { result: { schema: "battle-result/v1", agents: "builtin", winner: "red" } }),
    ],
    ["el Pacifista disparó (no corrió SU código)", (d) => ev(d, { stats: { red: 3, blue: 2 } })],
    ["el Artillero no disparó", (d) => ev(d, { stats: { red: 0, blue: 0 } })],
    ["sin evidence.json del golden", (d) => writeFileSync(join(d, "golden", "evidence.json"), "")],
    // PRC REVIEW (TD-004): el reproductor debe leer por la API autorizada.
    ["golden sin evidencia de la ruta del replay", (d) => ev(d, { replayPath: undefined })],
    [
      "replay leído por /replays* del gateway (bypass reabierto)",
      (d) => ev(d, { replayPath: { apiIndex200: 1, apiSegment200: 3, gatewayReplays: 2 } }),
    ],
    [
      "replay sin índice 200 por /api/v1/replays",
      (d) => ev(d, { replayPath: { apiIndex200: 0, apiSegment200: 3, gatewayReplays: 0 } }),
    ],
    [
      "sonda TD-028 aceptando un secreto ajeno",
      (d) =>
        writeFileSync(
          join(d, "ticket-probe.json"),
          JSON.stringify({ sharedSecret: { code: 4404 }, foreignSecret: { code: 4404 } }),
        ),
    ],
  ];
  for (const [nombre, mut] of casos) {
    it(`${nombre} → FAIL (CLI rc 1)`, () => {
      const dir = fixtureOut(mut);
      expect(evaluarE2E(dir).ok).toBe(false);
      const r = spawnSync(process.execPath, [ASSERT, "browser", dir], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("::error::");
    });
  }

  it("directorio inexistente → FAIL", () => {
    expect(evaluarE2E(join(tmpdir(), "no-existe-fe2e")).ok).toBe(false);
  });
});

describe("G4 · assert-functional-e2e (vitest): un describe.skipIf sin opt-in FALLA", () => {
  const F = ["a/one.test.ts", "b/two.test.ts"];
  const report = (over: Record<string, unknown> = {}, results?: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "fe2e-v-"));
    const p = join(dir, "vitest.json");
    writeFileSync(
      p,
      JSON.stringify({
        success: true,
        numPassedTests: 3,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: results ?? [
          {
            name: "/r/a/one.test.ts",
            status: "passed",
            assertionResults: [{ status: "passed" }, { status: "passed" }],
          },
          { name: "/r/b/two.test.ts", status: "passed", assertionResults: [{ status: "passed" }] },
        ],
        ...over,
      }),
    );
    return p;
  };

  it("control positivo → PASS", () => expect(evaluarVitest(report(), F).ok).toBe(true));
  it("fichero entero skipped (opt-in ausente) → FAIL", () => {
    const p = report({ numPendingTests: 1, numPassedTests: 2 }, [
      { name: "/r/a/one.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] },
      { name: "/r/b/two.test.ts", status: "skipped", assertionResults: [{ status: "skipped" }] },
    ]);
    expect(evaluarVitest(p, F).ok).toBe(false);
  });
  it("un test pending dentro de un fichero passed → FAIL", () => {
    const p = report({ numPendingTests: 1 }, [
      { name: "/r/a/one.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "pending" }] },
      { name: "/r/b/two.test.ts", status: "passed", assertionResults: [{ status: "passed" }] },
    ]);
    expect(evaluarVitest(p, F).ok).toBe(false);
  });
  it("fichero exigido ausente del informe → FAIL", () => {
    const p = report({}, [{ name: "/r/a/one.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }]);
    expect(evaluarVitest(p, F).ok).toBe(false);
  });
  it("fallo de un test → FAIL", () =>
    expect(evaluarVitest(report({ success: false, numFailedTests: 1 }), F).ok).toBe(false));
  it("sin ficheros exigidos → FAIL", () => expect(evaluarVitest(report(), []).ok).toBe(false));
});

// ── G5 · evidencia sin secretos ─────────────────────────────────────────────
describe("G5 · collect-functional-evidence.sh no sube secretos", () => {
  function state() {
    const s = mkdtempSync(join(tmpdir(), "fe2e-state-"));
    for (const d of ["logs", "out/golden", "secrets", "certs"]) mkdirSync(join(s, d), { recursive: true });
    writeFileSync(join(s, "secrets", "jwt_secret"), "c2VjcmV0by1lZmltZXJvLWRlLXBydWViYS0xMjM0NTY3OA==\n");
    writeFileSync(
      join(s, "certs", "tls.key"),
      "-----BEGIN PRIVATE KEY-----\nTUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFD\n-----END PRIVATE KEY-----\n",
    );
    writeFileSync(join(s, "pw.env"), "S9_E2E_DEV_PASSWORD=x\n");
    writeFileSync(join(s, "db.url"), "postgres://postgres@127.0.0.1:1/x\n");
    writeFileSync(join(s, "logs", "api.log"), '{"msg":"api-env ready"}\n');
    writeFileSync(join(s, "out", "summary.txt"), "BROWSER_E2E_RC=0\n");
    return s;
  }
  const run = (s: string, dest: string) => spawnSync("bash", [COLLECT, s, dest], { encoding: "utf8" });

  it("control positivo: copia logs/ y out/, nunca secrets/, certs/, pw.env ni db.url (rc 0)", () => {
    const s = state();
    const dest = join(s, "..", `${s.split("/").pop()}-ev`);
    const r = run(s, dest);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(dest, "logs", "api.log"))).toBe(true);
    expect(existsSync(join(dest, "out", "summary.txt"))).toBe(true);
    for (const x of ["secrets", "certs", "pw.env", "db.url"]) expect(existsSync(join(dest, x)), x).toBe(false);
  });

  it("negativo: el JWT efímero filtrado a un log ⇒ rc 1 y el fichero se retira", () => {
    const s = state();
    appendFileSync(join(s, "logs", "worker.log"), `token ${readFileSync(join(s, "secrets", "jwt_secret"), "utf8")}`);
    const dest = join(s, "..", `${s.split("/").pop()}-ev`);
    const r = run(s, dest);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("logs/worker.log");
    expect(existsSync(join(dest, "logs", "worker.log"))).toBe(false);
    expect(existsSync(join(dest, "logs", "api.log"))).toBe(true);
  });

  it("negativo: material de la clave TLS en la salida de una fase ⇒ rc 1", () => {
    const s = state();
    writeFileSync(
      join(s, "out", "golden", "playwright.log"),
      "TUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFD\n",
    );
    const r = run(s, join(s, "..", `${s.split("/").pop()}-ev`));
    expect(r.status).toBe(1);
  });

  it("sin estado (el E2E no arrancó) ⇒ deja constancia y rc 0 (el job ya falla por el E2E)", () => {
    const dest = mkdtempSync(join(tmpdir(), "fe2e-nostate-"));
    const r = run(join(tmpdir(), "fe2e-no-existe"), dest);
    expect(r.status).toBe(0);
    expect(execFileSync("ls", [dest], { encoding: "utf8" })).toContain("NO-STATE.txt");
  });
});

// ── G6 · relojes de producción en el gate (PRC REVIEW, TD-034) ──────────────
describe("G6 · el gate usa los relojes de arranque de producción", () => {
  const RUN_SH = readFileSync(join(REPO, "tests/browser/run.sh"), "utf8");
  const COMPOSE = readFileSync(join(REPO, "infrastructure/docker-compose.yml"), "utf8");
  const want = {
    SANDBOX_STARTUP_TIMEOUT_MS: DEFAULT_STARTUP_TIMEOUTS.sandboxStartupMs,
    BOT_EXECUTION_TIMEOUT_MS: DEFAULT_STARTUP_TIMEOUTS.botExecutionMs,
  };

  it("run.sh fija SANDBOX_STARTUP_TIMEOUT_MS y BOT_EXECUTION_TIMEOUT_MS con los defectos del código", () => {
    const line = RUN_SH.split("\n").find((l) => l.startsWith("SANDBOX_CLOCKS=("));
    expect(line, "falta SANDBOX_CLOCKS en run.sh").toBeDefined();
    for (const [k, v] of Object.entries(want)) expect(line).toContain(`${k}=${v}`);
  });

  it("el tournament-worker y el bot-build-worker de run.sh reciben esos relojes", () => {
    for (const svc of ["worker", "build-worker"]) {
      const start = RUN_SH.split("\n").find((l) => l.includes(`start ${svc} env`));
      expect(start, `no se arranca ${svc}`).toBeDefined();
      expect(start).toContain('"${SANDBOX_CLOCKS[@]}"');
    }
  });

  it("el compose de producción usa los mismos defectos (tournament-worker y bot-build-worker)", () => {
    for (const [k, v] of Object.entries(want)) {
      const n = COMPOSE.split(`${k}: \${${k}:-${v}}`).length - 1;
      expect(n, `${k} con defecto ${v} en el compose`).toBe(2);
    }
  });

  it("functional-e2e.yml no sobrescribe los relojes", () => {
    const raw = readFileSync(join(REPO, ".github/workflows/functional-e2e.yml"), "utf8");
    for (const k of Object.keys(want)) expect(raw).not.toContain(k);
  });
});
