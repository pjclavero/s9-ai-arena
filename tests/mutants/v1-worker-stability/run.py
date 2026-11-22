#!/usr/bin/env python3
"""V1-P0 · mutantes de la estabilidad del tournament-worker.

Cada mutante aplica UNA sustitución exacta a un fichero, ejecuta el test NOMBRADO que debe
cazarlo y exige rc != 0. Antes comprueba la línea base (todo el fichero de tests en verde) y el
árbol limpio; después restaura con `git checkout --` y vuelve a comprobar el árbol. En serie.
Es una tanda PESADA (PG embebida): sólo en el turno de laboratorio, con PRODGUARD_OK y bajo
`nice -n 19 ionice -c3 flock -o /srv/s9-test/heavy.lock`. Uso, desde la raíz del repo:

    python3 -I tests/mutants/v1-worker-stability/run.py [--only M1,M2] [--skip-baseline]
"""
import subprocess, sys

T = "apps/tournament-worker/src/v1-worker-stability.test.ts"
Q = "apps/tournament-worker/src/queue.ts"
O = "apps/tournament-worker/src/orphan-recovery.ts"
R = "apps/tournament-worker/src/battle-reaper.ts"
B = "apps/tournament-worker/src/battle-runner.ts"
C = "infrastructure/docker-compose.yml"
A = "infrastructure/observability/prometheus/alerts.yml"

MUTANTS = [
    ("M1-claim-sin-aparcar", Q,
     "        AND locked_at < :staleBefore\n        AND attempts >= max_attempts\n",
     "        AND locked_at < :staleBefore\n        AND attempts >= max_attempts AND false\n",
     "reintentos agotados"),
    ("M2-aparcar-off-by-one", Q,
     "        AND attempts >= max_attempts\n      ORDER BY created_at, id",
     "        AND attempts > max_attempts\n      ORDER BY created_at, id",
     "un huérfano que ya gastó max_attempts"),
    ("M3-aparcar-sin-cerrar-batalla", Q,
     "      AND b.id = CAST(p.payload->>'battleId' AS uuid)",
     "      AND false AND b.id = CAST(p.payload->>'battleId' AS uuid)",
     "un huérfano que ya gastó max_attempts"),
    ("M4-sin-rastro-audit", Q,
     "'worker.battle_failed_infrastructure', 'battle:' || f.id",
     "'worker.battle_failed_infrastructure', 'battleX:' || f.id",
     "un huérfano que ya gastó max_attempts"),
    ("M5-barrido-off-by-one", O,
     "const exhausted = attempts >= maxAttempts || jobTerminal;",
     "const exhausted = attempts > maxAttempts || jobTerminal;",
     "intentos agotados: terminal"),
    ("M6-barrido-ignora-job-terminal", O,
     "const exhausted = attempts >= maxAttempts || jobTerminal;",
     "const exhausted = attempts >= maxAttempts;",
     "cuyo trabajo ya está en needs_review"),
    ("M7-barrido-pisa-titular-vivo", O,
     "if (job && job.status === \"running\" && job.locked_at && new Date(job.locked_at) >= staleBefore) {",
     "if (false) {",
     "titular posiblemente vivo"),
    ("M8-barrido-sin-reencolar", O,
     "      const released = await trx(\"battles\")",
     "      if (true) return;\n      const released = await trx(\"battles\")",
     "quedan intentos: se reencola UNA vez"),
    ("M9-reaper-ignora-lease-vencido", R,
     "      new Date(row.lease_expires_at).getTime() < now\n    )",
     "      false\n    )",
     "running` con el lease vencido se retiran"),
    ("M10-reaper-toca-lease-vigente", R,
     "      new Date(row.lease_expires_at).getTime() < now\n    )",
     "      new Date(row.lease_expires_at).getTime() < now + 3_600_000\n    )",
     "running` con el lease vencido se retiran"),
    ("M11-arranque-con-gracia", R,
     "  return reapOnce({ ...deps, graceMs: 0 });",
     "  return reapOnce({ ...deps, graceMs: 120_000 });",
     "al arrancar (sin periodo de gracia)"),
    ("M12-reserva-sin-lease", B,
     "        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))\n      )\n      -- #288",
     "        OR status = 'running'\n      )\n      -- #288",
     "cinco reservas simultáneas"),
    ("M13-heap-mayor-que-limite", C,
     "NODE_OPTIONS: \"--max-old-space-size=640\"",
     "NODE_OPTIONS: \"--max-old-space-size=2048\"",
     "--max-old-space-size del worker"),
    ("M14-alerta-renombrada", A,
     "      - alert: WorkerRssHigh\n",
     "      - alert: WorkerRssHighX\n",
     "alertas y scrape existen"),
    ("M16-claim-no-notifica-aparcados", Q,
     "    await opts.onParked?.(parked);",
     "    void 0;",
     "H1 · el worker invoca onExhausted"),
    ("M17-claim-no-cuenta-aparcados", Q,
     "    workerMetrics.inc(\"jobs_parked_total\", parked.length);\n    await opts.onParked",
     "    await opts.onParked",
     "H2 · el claim que aparca cuenta"),
    ("M15-reintento-no-cuenta", Q,
     "  if (job && job.attempts > 1) workerMetrics.inc(\"job_retries_total\");",
     "",
     "con intentos disponibles SÍ se re-reclama"),
]

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, **kw)

PFX = "nice -n 19 npx vitest run --maxWorkers=1"
only = None
if "--only" in sys.argv:
    only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
if sh("git diff --quiet").returncode != 0:
    sys.exit("árbol sucio: commitea antes de calibrar")
if "--skip-baseline" not in sys.argv:
    rc = sh(f"{PFX} {T} > /tmp/v1w-baseline.log 2>&1").returncode
    print(f"BASE\trc={rc}")
    if rc != 0:
        sys.exit("la línea base no está en verde")

results = []
for name, path, old, new, test in MUTANTS:
    if only and name.split("-")[0] not in only:
        continue
    src = open(path, encoding="utf8").read()
    if src.count(old) != 1:
        results.append((name, "NO_APLICA"))
        continue
    open(path, "w", encoding="utf8").write(src.replace(old, new))
    rc = sh(f"{PFX} {T} -t {test!r} > /tmp/v1w-mut-{name}.log 2>&1").returncode
    sh(f"git checkout -- {path}")
    results.append((name, f"ROJO(cazado) rc={rc}" if rc != 0 else "VERDE(NO cazado)"))

if sh("git diff --quiet").returncode != 0:
    sys.exit("el árbol no quedó limpio tras los mutantes")
for n, r in results:
    print(f"{n}\t{r}")
sys.exit(0 if all(r.startswith("ROJO") for _, r in results) else 1)
