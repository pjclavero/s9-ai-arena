/**
 * OLA 2 · G1.4 · Las matrices de mutantes de MC, MD, MB y G1 viven en el repo
 * (scripts/hardening/*-mutants.py) y sus ANCLAS están versionadas con el código: este test
 * las comprueba en cada CI con `--dry-run` (no ejecuta ningún mutante). Si un cambio de código
 * deja un ancla ausente o duplicada (lo que hizo equivalente al M10 de MD tras el merge de MA),
 * se pone rojo aquí y no en la siguiente calibración.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const EXPECTED: Record<string, number> = { mc: 17, md: 22, mb: 13, g1: 44 };

describe("G1.4 · anclas de las matrices de mutantes (scripts/hardening)", () => {
  for (const [matrix, count] of Object.entries(EXPECTED)) {
    it(`${matrix}-mutants.py: ${count} mutantes, cada ancla aparece exactamente una vez`, () => {
      const r = spawnSync(
        "python3",
        ["-I", "-B", join(ROOT, "scripts/hardening", `${matrix}-mutants.py`), ROOT, "/dev/null", "--dry-run"],
        {
          encoding: "utf8",
        },
      );
      expect(r.error, String(r.error)).toBeUndefined();
      const out = JSON.parse(r.stdout);
      expect(out.bad, r.stdout).toEqual({});
      expect(Object.keys(out.anchors)).toHaveLength(count);
      expect(r.status).toBe(0);
    });
  }
});
