// RC2 · DEV-SECOPS — scripts/ops/pull-runtime-images.sh (P1-2: runtimes por digest).
//
// Se sustituye `docker` por un doble (variable DOCKER) que registra cada llamada y simula
// qué imágenes quedan en el host. Así se prueba el EFECTO que importa:
//   - sólo se descarga la 3ª columna del lock (imagen de runtime), nunca la base;
//   - nunca por tag;
//   - un `pull` con rc=0 que no deja la imagen con ese digest ⇒ FALLA (se verifica con
//     `docker image inspect`, no con el mensaje del pull);
//   - lock vacío / malformado / con tag ⇒ rc=2 y ninguna descarga.
// La ejecución contra Docker real (rootless y el host productivo en --check-only) está en el informe RC2.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "pull-runtime-images.sh");
const REAL_LOCK = join(ROOT, "runtimes", "DIGESTS.lock");

const tmp = mkdtempSync(join(tmpdir(), "rc2so-pull-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Doble de docker: `pull <ref>` añade <ref> a la «store» salvo FAKE_PULL_NOOP=1 (pull que
// dice rc=0 pero no deja nada) o FAKE_PULL_FAIL=1 (rc=1). `image inspect` responde según la
// store. Cada invocación queda en el log.
const FAKE = join(tmp, "docker");
writeFileSync(
  FAKE,
  `#!/bin/sh
echo "$*" >>"$FAKE_LOG"
case "$1" in
  pull)
    ref=""; for a in "$@"; do ref="$a"; done
    [ "\${FAKE_PULL_FAIL:-0}" = 1 ] && exit 1
    [ "\${FAKE_PULL_NOOP:-0}" = 1 ] || echo "$ref" >>"$FAKE_STORE"
    exit 0 ;;
  image)
    ref=""; for a in "$@"; do ref="$a"; done
    grep -qxF -- "$ref" "$FAKE_STORE" 2>/dev/null || exit 1
    case "$*" in
      *RepoDigests*) echo "$ref" ;;
      *) echo "sha256:fake" ;;
    esac
    exit 0 ;;
esac
exit 99
`,
);
chmodSync(FAKE, 0o755);

let n = 0;
function run(args: string[], env: Record<string, string> = {}) {
  n += 1;
  const log = join(tmp, `log-${n}`);
  const store = join(tmp, `store-${n}`);
  writeFileSync(log, "");
  writeFileSync(store, env.PRESTORE ?? "");
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, DOCKER: FAKE, FAKE_LOG: log, FAKE_STORE: store, ...env },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { rc: r.status, out: r.stdout, err: r.stderr, calls };
}

function lockRefs(): { runtime: string; base: string; ref: string }[] {
  return readFileSync(REAL_LOCK, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [runtime, base, ref] = l.split(/\s+/);
      return { runtime, base, ref };
    });
}

function lockFile(body: string): string {
  n += 1;
  const p = join(tmp, `lock-${n}`);
  writeFileSync(p, body);
  return p;
}

const HEX = "a".repeat(64);

describe("pull-runtime-images.sh · lock real", () => {
  const entries = lockRefs();

  it("el lock real declara exactamente los runtimes python y node, por digest", () => {
    expect(entries.map((e) => e.runtime).sort()).toEqual(["node", "python"]);
    for (const e of entries) expect(e.ref).toMatch(/^ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/);
  });

  it("descarga SÓLO la 3ª columna (runtime), por digest, y verifica cada una", () => {
    const r = run([]);
    expect(r.rc).toBe(0);
    const pulls = r.calls.filter((c) => c.startsWith("pull "));
    expect(pulls.map((c) => c.split(" ").pop()).sort()).toEqual(entries.map((e) => e.ref).sort());
    for (const e of entries) {
      expect(r.calls.some((c) => c.includes(e.base))).toBe(false); // nunca la base
      expect(r.calls.some((c) => c.startsWith("image inspect") && c.endsWith(e.ref))).toBe(true);
    }
    for (const c of pulls) expect(c).toMatch(/@sha256:[0-9a-f]{64}$/); // nunca por tag
    expect(r.out).toContain("RUNTIME_IMAGES_READY=YES");
  });

  it("pull con rc=0 que NO deja la imagen ⇒ rc=1 (se comprueba el efecto, no el mensaje)", () => {
    const r = run([], { FAKE_PULL_NOOP: "1" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("ABSENT");
    expect(r.out).toContain("RUNTIME_IMAGES_READY=NO");
  });

  it("pull fallido ⇒ rc=1 y PULL_FAILED", () => {
    const r = run([], { FAKE_PULL_FAIL: "1" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("PULL_FAILED");
  });

  it("--check-only no descarga nada; sin imágenes ⇒ rc=1, con ellas ⇒ rc=0", () => {
    const empty = run(["--check-only"]);
    expect(empty.rc).toBe(1);
    expect(empty.calls.some((c) => c.startsWith("pull"))).toBe(false);

    const full = run(["--check-only"], { PRESTORE: entries.map((e) => e.ref).join("\n") + "\n" });
    expect(full.rc).toBe(0);
    expect(full.calls.some((c) => c.startsWith("pull"))).toBe(false);
  });

  it("una sola imagen ausente basta para rc=1", () => {
    const r = run(["--check-only"], { PRESTORE: entries[0].ref + "\n" });
    expect(r.rc).toBe(1);
    expect(r.out).toMatch(/^OK /m);
    expect(r.out).toMatch(/^ABSENT /m);
  });
});

describe("pull-runtime-images.sh · lock inválido ⇒ rc=2 y ninguna descarga", () => {
  const cases: [string, string][] = [
    ["vacío", "# sólo comentarios\n\n"],
    ["runtime por tag", `python python@sha256:${HEX} ghcr.io/x/bot-runtime-python:1.0\n`],
    ["runtime sin digest", `python python@sha256:${HEX} ghcr.io/x/bot-runtime-python\n`],
    ["digest truncado", `python python@sha256:${HEX} ghcr.io/x/bot-runtime-python@sha256:deadbeef\n`],
    ["tag y digest", `python python@sha256:${HEX} ghcr.io/x/bot-runtime-python:latest@sha256:${HEX}\n`],
    ["dos columnas", `python ghcr.io/x/bot-runtime-python@sha256:${HEX}\n`],
    ["duplicado", `python b@sha256:${HEX} ghcr.io/x/r@sha256:${HEX}\nnode b@sha256:${HEX} ghcr.io/x/r@sha256:${HEX}\n`],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      const r = run(["--lock", lockFile(body)]);
      expect(r.rc).toBe(2);
      expect(r.calls.some((c) => c.startsWith("pull"))).toBe(false);
    });
  }

  it("lock inexistente ⇒ rc=2", () => {
    expect(run(["--lock", join(tmp, "no-existe")]).rc).toBe(2);
  });
});
