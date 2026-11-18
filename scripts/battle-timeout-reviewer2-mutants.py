#!/usr/bin/env python3
# Mutantes del REVISOR, ronda 2 (PR A #298), commiteados por el autor en la ronda 3 con las anclas de
# errors.ts adaptadas al refactor (N2: el 57014 pasa a su propia clase; N12: `hostname` se lee en pointsAtDb).
# Ejecutar en VM111 en el worktree, árbol limpio y commiteado.
import subprocess, sys, os
SUITES = ["apps/tournament-worker/src/battle-timeout-classification.test.ts",
          "apps/tournament-worker/src/battle-retry-classification.test.ts",
          "apps/tournament-worker/src/mf-battle-teardown.test.ts",
          "apps/tournament-worker/src/battle-resources.test.ts"]
E="apps/tournament-worker/src/errors.ts"; Q="apps/tournament-worker/src/queue.ts"
B="apps/tournament-worker/src/battle-resources.ts"; T="packages/game-rules/battle-timing.ts"
M = [
 ("N1 53300 deja de ser transitorio", E, '  "53300", // too_many_connections', '  // "53300", // too_many_connections'),
 ("N2 57014 deja de reconocerse", E, 'const QUERY_TIMEOUT_SQLSTATE = "57014";', 'const QUERY_TIMEOUT_SQLSTATE = "57015";'),
 ("N3 mismo host con CUALQUIER puerto = BD", E, "if (ep.port === undefined || port !== ep.port) return false;", "if (ep.port === undefined) return false;"),
 ("N4 contador por clase no se lee (siempre 0)", Q, "const classFailures = (counts[code] ?? 0) + 1;", "const classFailures = 1;"),
 ("N5 contador por clase no se escribe", Q, "[FAILURE_COUNTS_KEY]: { ...counts, [code]: classFailures }", "[FAILURE_COUNTS_KEY]: counts"),
 ("N6 db_unavailable vuelve a limitarse por max_attempts", Q, "parked = classFailures >= policy.maxFailures;", "parked = classFailures >= policy.maxFailures || job.attempts >= job.max_attempts;"),
 ("N7 classifyEnd vuelve a mirar el mensaje", B, 'if (err.code === "battle_timeout") return "TIMEOUT";', 'if (err.code === "battle_timeout" || /timeout global/.test(String(err.message))) return "TIMEOUT";'),
 ("N8 el recorte del guard vuelve a ser silencioso", T, 'console.error(\n    JSON.stringify({\n      level: "warn",\n      service: "tournament-worker",', 'void (\n    JSON.stringify({\n      level: "warn",\n      service: "tournament-worker",'),
 ("N9 tope de backoff db 120 s -> 600 s", E, "backoffMs: (n) => Math.min(120_000, 5000 * 2 ** n),", "backoffMs: (n) => Math.min(600_000, 5000 * 2 ** n),"),
 ("N10 la pila de pg ya no cuenta", E, "if (typeof e.stack === \"string\" && DB_LIBRARY_STACK.test(e.stack)) return true;", ""),
 ("N11 db_unavailable 8 -> 20 fallos", E, "maxFailures: 8,", "maxFailures: 20,"),
 ("N12 EAI_AGAIN sin hostname deja de leerse", E, "const hostname = str(e.hostname);", "const hostname = undefined;"),
]
def run(out):
    r = subprocess.run("NO_COLOR=1 FORCE_COLOR=0 timeout 900 npx vitest run --reporter=verbose " + " ".join(SUITES), shell=True, capture_output=True, text=True)
    open(out, "w").write(r.stdout + r.stderr); return r.returncode, r.stdout + r.stderr
def clean(): return subprocess.run("git status --porcelain --untracked-files=no", shell=True, capture_output=True, text=True).stdout.strip() == ""
if not clean(): print("ARBOL SUCIO"); sys.exit(2)
rc,_ = run("/tmp/reva2-base.txt"); print("BASE rc=%d" % rc)
if rc: sys.exit(1)
bad = 0
for nombre, f, a, n in M:
    s = open(f).read()
    if s.count(a) != 1: print("ANCLA PERDIDA (%d) · %s" % (s.count(a), nombre)); bad += 1; continue
    open(f, "w").write(s.replace(a, n))
    rc, out = run("/tmp/reva2-m.txt")
    subprocess.run(["git", "checkout", "--", f])
    if rc == 0: print("SOBREVIVE · " + nombre); bad += 1
    else:
        fails = [l.strip()[:170] for l in out.splitlines() if l.strip().startswith("×")][:2]
        print("MUERE · %s · %s" % (nombre, " ;; ".join(fails)))
print("ARBOL_LIMPIO" if clean() else "ARBOL_SUCIO", "mutantes=%d sobreviven_o_fallos=%d" % (len(M), bad))
