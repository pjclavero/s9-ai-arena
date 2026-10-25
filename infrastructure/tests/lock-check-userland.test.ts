// HOTFIX mawk · lock_check (post-RC3). Defecto real: en VM108 (Debian 12) /usr/bin/awk es
// mawk 1.3.4-20200120, que NO soporta intervalos `{n}` en las ERE. `lock_check` validaba la
// 3ª columna de DIGESTS.lock con `…@sha256:[0-9a-f]{64}$`, así que `check-env` e `install`
// rechazaban SIEMPRE una allowlist válida (RC3 P12). La CI (Ubuntu) no lo veía.
//
// Este test ejecuta la función REAL `lock_check` (extraída del instalador, no copiada) y el
// subcomando real `check-env` con el userland de Debian 12 — mawk por defecto — y con gawk,
// dentro de `debian:12` FIJADO POR DIGEST. No vale sólo gawk, ni un mawk moderno (los mawk
// ≥ 20200717 sí soportan intervalos y no reproducen el defecto). Por eso hay CALIBRACIÓN:
//   - ese mawk es el de Debian 12 y NO casa `/^a{3}$/` (si el entorno deja de ser el
//     defectuoso, el test FALLA en vez de aprobar sin probar nada);
//   - el programa ORIGINAL (con {64}) bajo ese mawk rechaza la allowlist válida (el defecto
//     se reproduce) y bajo gawk coincide caso a caso con el nuevo (mismo contrato).
// Sin Docker, sin red para instalar gawk o sin alguno de los dos awk ⇒ el test FALLA:
// skipped ≠ PASS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const REAL_LOCK = join(ROOT, "runtimes", "DIGESTS.lock");
// debian:12 (bookworm) por digest de índice: mawk 1.3.4.20200120-3.1 (dpkg) como awk por defecto.
const DEBIAN12 = "debian:12@sha256:854dd8ab51d62866dbd8f5431d15ce77b12983a2a4a1e1fe43a2395dc7ef9f61";
const DEBIAN12_MAWK = "1.3.4.20200120-3.1";

// Programa awk ORIGINAL de lock_check (4cc7651): define el contrato que el hotfix conserva.
const REFERENCE_AWK = `
{ sub(/#.*/, ""); gsub(/^[ \\t]+|[ \\t]+$/, "") }
$0 == "" { next }
NF != 3 || $3 !~ /^[a-z0-9][a-z0-9._\\/:-]*@sha256:[0-9a-f]{64}$/ { bad++; next }
{ ok++ }
END { exit (bad == 0 && ok >= 1) ? 0 : 1 }
`;

const H = "0123456789abcdef".repeat(4); // 64 hex minúsculas
const B = `python@sha256:${H}`; // 2ª columna válida
const img = (ref: string) => `python ${B} ${ref}\n`;
const RT = "ghcr.io/x/bot-runtime-python";

/** [caso, contenido del lock, válido según el contrato actual] */
const CASES: [string, string, boolean][] = [
  ["valid-real-lock", readFileSync(REAL_LOCK, "utf8"), true],
  ["valid-min", img(`${RT}@sha256:${H}`), true],
  [
    "valid-comments-blanks",
    `# cabecera\n\n   \n\t${img(`${RT}@sha256:${H}`).trim()}   # comentario final\n  node\t${B}\t${RT}-node@sha256:${H}\t\n# fin\n`,
    true,
  ],
  ["valid-tag-and-digest", img(`${RT}:1.0@sha256:${H}`), true],
  ["valid-registry-port", img(`registry.local:5000/a_b/c.d-e@sha256:${H}`), true],
  ["hex-63", img(`${RT}@sha256:${H.slice(1)}`), false],
  ["hex-65", img(`${RT}@sha256:${H}0`), false],
  ["hex-empty", img(`${RT}@sha256:`), false],
  ["hex-nonhex", img(`${RT}@sha256:${H.slice(1)}g`), false],
  ["hex-uppercase", img(`${RT}@sha256:${H.slice(1)}A`), false],
  ["hex-all-uppercase", img(`${RT}@sha256:${H.toUpperCase()}`), false],
  ["hex-non-ascii", img(`${RT}@sha256:${H.slice(1)}é`), false],
  ["no-sha256-prefix", img(`${RT}@${H}`), false],
  ["sha256-without-colon", img(`${RT}@sha256${H}`), false],
  ["sha512", img(`${RT}@sha512:${H}${H}`), false],
  ["uppercase-SHA256", img(`${RT}@SHA256:${H}`), false],
  ["tag-only", img(`${RT}:1.0`), false],
  ["double-digest", img(`${RT}@sha256:${H}@sha256:${H}`), false],
  ["repo-with-at", img(`ghcr.io/x@y@sha256:${H}`), false],
  ["repo-empty", img(`@sha256:${H}`), false],
  ["repo-uppercase", img(`GHCR.io/x/y@sha256:${H}`), false],
  ["repo-leading-dash", img(`-ghcr.io/x@sha256:${H}`), false],
  ["repo-leading-dot", img(`.ghcr.io/x@sha256:${H}`), false],
  ["repo-leading-slash", img(`/ghcr.io/x@sha256:${H}`), false],
  ["crlf", img(`${RT}@sha256:${H}`).replace("\n", "\r\n"), false],
  ["empty-file", "", false],
  ["only-comments-blanks", "# nada\n\n   \n\t# otra\n", false],
  ["nf-2", `python ${RT}@sha256:${H}\n`, false],
  ["nf-4", `python ${B} ${RT}@sha256:${H} extra\n`, false],
  ["nf-1", `${RT}@sha256:${H}\n`, false],
  ["mixed-valid-and-invalid", img(`${RT}@sha256:${H}`) + img(`${RT}@sha256:${H.slice(1)}`), false],
  ["valid-then-garbage", readFileSync(REAL_LOCK, "utf8") + "\nbasura sin tres columnas\n", false],
];

type Row = { lock_check: number; check_env: number; allowlist_err: number; reference: number };
const result: Record<string, Record<string, Row>> = { mawk: {}, gawk: {} };
const meta: Record<string, string> = {};
let raw = "";
const tmp = mkdtempSync(join(tmpdir(), "lock-check-userland-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeAll(() => {
  for (const [name, text] of CASES) writeFileSync(join(tmp, `${name}.lock`), text);
  writeFileSync(join(tmp, "reference.awk"), REFERENCE_AWK);
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (info.status !== 0)
    throw new Error(`Docker no disponible: este test NO se salta (skipped ≠ PASS)\n${info.stderr}`);
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${ROOT}:/repo:ro`,
      "-v",
      `${tmp}:/cases:ro`,
      DEBIAN12,
      "bash",
      "/repo/infrastructure/tests/lock-check-userland/run-in-debian12.sh",
      "/repo",
      "/cases",
    ],
    { encoding: "utf8", timeout: 600_000 },
  );
  raw = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`el arnés de debian:12 falló (rc=${r.status}):\n${raw}`);
  for (const line of r.stdout.split("\n")) {
    const w = line.trim().split(/\s+/);
    if (w[0] === "CASE") {
      const row = Object.fromEntries(
        w
          .slice(3)
          .map((kv) => kv.split("="))
          .map(([k, v]) => [k, Number(v)]),
      );
      result[w[1]][w[2]] = row as Row;
    } else if (w[0] === "PKG") meta[`pkg:${w[1]}`] = w[2];
    else if (w[0] === "INTERVALS") meta[`intervals:${w[1]}`] = w[2];
    else if (w[0] === "AWK") meta[`awk:${w[1]}`] = w[2];
    else if (w[0] === "DEFAULT_AWK") meta.default = w[1];
    else if (w[0] === "DONE") meta[`done:${w[1]}`] = w[2];
  }
}, 600_000);

describe("lock_check · calibración del userland (debian:12 fijado por digest)", () => {
  it("el awk POR DEFECTO es el mawk de Debian 12 y no soporta intervalos {n} (el entorno defectuoso)", () => {
    expect(meta.default, raw).toBe("/usr/bin/mawk");
    expect(meta["pkg:mawk"], raw).toBe(DEBIAN12_MAWK);
    expect(meta["awk:mawk"], raw).toBe("/usr/bin/mawk");
    expect(meta["intervals:mawk"], raw).toBe("no");
  });

  it("gawk se ejecutó de verdad y sí soporta intervalos", () => {
    expect(meta["pkg:gawk"], raw).toMatch(/^1:5\./);
    expect(meta["awk:gawk"], raw).toBe("/usr/bin/gawk");
    expect(meta["intervals:gawk"], raw).toBe("yes");
  });

  it("ambos awk recorrieron TODOS los casos", () => {
    expect(Number(meta["done:mawk"]), raw).toBe(CASES.length);
    expect(Number(meta["done:gawk"]), raw).toBe(CASES.length);
  });

  it("el defecto se REPRODUCE: el programa original rechaza la allowlist real bajo ese mawk", () => {
    expect(result.mawk["valid-real-lock"]?.reference, raw).toBe(1);
  });
});

for (const awk of ["mawk", "gawk"] as const) {
  describe(`lock_check y check-env con ${awk} (Debian 12)`, () => {
    for (const [name, , valid] of CASES) {
      it(`${valid ? "ACEPTA" : "RECHAZA"}: ${name}`, () => {
        const row = result[awk][name];
        expect(row, raw).toBeDefined();
        expect(row.lock_check, `lock_check ${name}`).toBe(valid ? 0 : 1);
        expect(row.check_env, `check-env ${name}`).toBe(valid ? 0 : 1);
        // El rechazo de check-env viene de la allowlist (no de otra regla) y la aceptación no
        // arrastra un error de allowlist.
        expect(row.allowlist_err, `error de allowlist ${name}`).toBe(valid ? 0 : 1);
      });
    }
  });
}

describe("mismo contrato que el programa original (gawk, que sí entiende {64})", () => {
  for (const [name, , valid] of CASES) {
    it(`original = nuevo = esperado: ${name}`, () => {
      expect(result.gawk[name]?.reference, raw).toBe(valid ? 0 : 1);
      expect(result.gawk[name]?.lock_check).toBe(result.gawk[name]?.reference);
    });
  }
});
