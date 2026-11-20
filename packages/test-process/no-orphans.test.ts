/**
 * EQ1 · Robustez · los tests que lanzan servicios NO dejan procesos huérfanos.
 *
 * Defecto observado en el host de desarrollo (2026-11-02): >100 procesos `node … tsx … main.ts` de
 * replay-service y streamer vivos con ppid=1 durante días. Causa: los tests lanzaban
 * `node tsx/cli main.ts` y al acabar mataban sólo el ENVOLTORIO de tsx con SIGKILL; el
 * nieto (el servicio de verdad, `node --require tsx/preflight --import loader main.ts`)
 * sobrevivía, quedaba colgado de init y retenía memoria (y a veces un puerto).
 *
 * Esta prueba ejecuta los ficheros de test que lanzan servicios en un `vitest` HIJO
 * marcado con una variable de entorno única. Cuando ese vitest termina, ningún proceso
 * del sistema puede conservar la marca en su entorno: si alguno la tiene, es un
 * descendiente que la suite dejó vivo. Los que encuentre se matan aquí (para que la
 * propia prueba no deje basura) y la prueba falla con su lista.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARK_VAR = "S9_TEST_PROCESS_MARK";

/** Ficheros de test que arrancan servicios reales como procesos aparte. */
const SUITES = [
  "apps/replay-service/tests/service-bootstrap.test.ts",
  "apps/streamer/tests/record-dir.test.ts",
  "apps/bot-manager/tests/docker-proxy.test.ts",
];

/** PIDs (de este usuario) cuyo entorno contiene la marca exacta. */
function marked(mark: string): { pid: number; cmd: string }[] {
  const needle = Buffer.from(`${MARK_VAR}=${mark}\0`);
  const out: { pid: number; cmd: string }[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`);
      if (!env.includes(needle)) continue;
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) continue; // zombi: ya muerto
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      out.push({ pid: Number(d), cmd });
    } catch {
      // proceso ya terminado o ajeno: no cuenta
    }
  }
  return out;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

describe.skipIf(process.platform !== "linux")("los tests que lanzan servicios no dejan huérfanos", () => {
  it("tras ejecutar las suites de servicios, ningún proceso conserva su marca", () => {
    const mark = randomUUID();
    const r = spawnSync(process.execPath, [join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", ...SUITES], {
      cwd: REPO,
      env: { ...process.env, [MARK_VAR]: mark },
      encoding: "utf8",
      timeout: 600_000,
    });
    // Margen para que un árbol que se está cerrando con normalidad termine de salir.
    let left = marked(mark);
    for (let i = 0; i < 20 && left.length > 0; i++) {
      sleepSync(250);
      left = marked(mark);
    }
    for (const p of left) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        /* ya no existe */
      }
    }
    expect(r.status, `el vitest hijo falló:\n${(r.stdout ?? "").slice(-3000)}\n${(r.stderr ?? "").slice(-2000)}`).toBe(
      0,
    );
    expect(
      left.map((p) => `${p.pid} ${p.cmd.slice(0, 160)}`),
      "procesos descendientes de la suite que siguen vivos",
    ).toEqual([]);
  }, 660_000);
});
