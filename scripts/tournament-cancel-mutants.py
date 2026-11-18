#!/usr/bin/env python3
"""#288 · Calibración de los tests de cancelación de torneos.

Cada mutante reintroduce un defecto concreto y debe poner en ROJO el test indicado
(por su id: TC-xx de la API, TW-n del worker, TW-Cn/TW-Dn de la web). Primero se
comprueba la línea base (sin mutar, todo verde). En SERIE, nunca en paralelo: cada
mutante reescribe el árbol y lo restaura al terminar. Commitear antes de calibrar.

Uso: python3 scripts/tournament-cancel-mutants.py [M1 M2 ...]
Sale con 1 si algún mutante sobrevive, si un ancla no es única o si la base no está verde.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "apps/api/src/tournament-cancel.test.ts"
WRK = "apps/tournament-worker/src/tournament-cancel-worker.test.ts"
WEB = "apps/web/tests/tournament-cancel.test.tsx"
ROUTES = "apps/api/src/routes/tournaments.ts"
SCHED = "apps/tournament-worker/src/scheduler.ts"
RUNNER = "apps/tournament-worker/src/battle-runner.ts"
RESULTS = "apps/tournament-worker/src/results.ts"
NEWPAGE = "apps/web/src/pages/TournamentsPage.tsx"
DETAIL = "apps/web/src/pages/TournamentDetailPage.tsx"
YAML = "apps/api/openapi.yaml"

# (id, descripción, [(fichero, ancla, sustitución)], test, ids que DEBEN fallar (alguno))
M = [
    ("M1", "cancelar borra entries", [(ROUTES,
        '      const entries = await trx("entries").where({ tournament_id: t.id }).count("* as n").first();',
        '      await trx("entries").where({ tournament_id: t.id }).del();\n'
        '      const entries = await trx("entries").where({ tournament_id: t.id }).count("* as n").first();')],
     API, ["TC-D1"]),
    ("M2", "se permite cancelar un torneo finished", [(ROUTES,
        'export const CANCELLABLE_TOURNAMENT_STATES = ["draft", "open"] as const;',
        'export const CANCELLABLE_TOURNAMENT_STATES = ["draft", "open", "finished"] as const;')],
     API, ["TC-S4"]),
    ("M3", "el scheduler ignora cancelled (genera calendario)", [
        (SCHED, '  if (t.state === "cancelled") return;\n', ''),
        (SCHED, '  if (t.state !== "closed") throw', '  if (t.state !== "closed" && t.state !== "cancelled") throw'),
        (SCHED, '  if (await isTournamentCancelled(db, t.id)) return [];\n', '')],
     WRK, ["TW-1"]),
    ("M3b", "materializeBattles ignora cancelled (cuadros/suizo)", [
        (SCHED, '  if (await isTournamentCancelled(db, t.id)) return [];\n', '')],
     WRK, ["TW-3"]),
    ("M3c", "run_battle ejecuta batallas de un torneo cancelado", [
        (RUNNER, "      AND NOT EXISTS (\n        SELECT 1 FROM tournaments tc WHERE tc.id = battles.tournament_id AND tc.state = 'cancelled'\n      )\n", ""),
        (RUNNER, "      if (await isTournamentCancelled(db, battle.tournament_id)) return;\n", "")],
     WRK, ["TW-2"]),
    ("M4", "carrera sin bloqueo en close-entries", [
        (ROUTES, 'await db("tournaments")\n        .where({ id: pathParam(req, "tournamentId") })\n        .forUpdate()\n',
                 'await db("tournaments")\n        .where({ id: pathParam(req, "tournamentId") })\n'),
        (ROUTES, '.where({ id: t.id, state: "open" })', '.where({ id: t.id })')],
     API, ["TC-R1"]),
    ("M4b", "carrera sin bloqueo en cancel", [
        (ROUTES, 'await trx("tournaments")\n        .where({ id: pathParam(req, "tournamentId") })\n        .forUpdate()\n',
                 'await trx("tournaments")\n        .where({ id: pathParam(req, "tournamentId") })\n'),
        (ROUTES, '        .whereIn("state", [...CANCELLABLE_TOURNAMENT_STATES])\n', '')],
     API, ["TC-R1"]),
    ("M5", "cancelar sin auditoría", [(ROUTES,
        '      await audit(trx, {\n        actorId: req.auth!.userId,\n        action: "tournament.cancelled",',
        '      void ({\n        actorId: req.auth!.userId,\n        action: "tournament.cancelled",')],
     API, ["TC-A1"]),
    ("M6", "cancelar sin comprobación de permisos", [(ROUTES,
        '      assertCanManageTournament(req.auth, t); // #291 · predicado único (dueño del torneo o staff)\n      if (t.state === "cancelled")',
        '      if (t.state === "cancelled")')],
     API, ["TC-P1"]),
    ("M7", "el Cancelar de la creación hace POST", [(NEWPAGE,
        '  function onCancelCreate() {\n    setName("");',
        '  function onCancelCreate() {\n    void api("POST", "/tournaments", { name, format, mode, rulesetId, broadcast });\n    setName("");')],
     WEB, ["TW-C1"]),
    ("M8", "Cancelar torneo sin confirmación", [(DETAIL,
        '    if (!window.confirm(CANCEL_CONFIRM_TEXT)) return;\n', '')],
     WEB, ["TW-D1"]),
    ("M9", "process_result pisa cancelled con finished", [(RESULTS,
        '      .whereNot({ state: "cancelled" })\n', '')],
     WRK, ["TW-4"]),
    # INT290 · tras integrar #290 hay DOS barreras contra el doble freeze (el bloqueo FOR NO KEY UPDATE de
    # las versiones y el UPDATE condicional): quitar sólo una es equivalente, así que M11/M11b quitan ambas.
    ("M11", "freeze sin condición de estado y sin bloqueo de versiones (H-1, ronda 2)", [(ROUTES,
        '          .orderBy("id")\n          .forNoKeyUpdate();', '          .orderBy("id");'), (ROUTES,
        '          .where({ id: v.id, state: "published" })', '          .where({ id: v.id })')],
     API, ["TC-F1"]),
    ("M11b", "auditoría de freeze aunque no transicione, sin bloqueo de versiones (H-1, ronda 2)", [(ROUTES,
        '          .orderBy("id")\n          .forNoKeyUpdate();', '          .orderBy("id");'), (ROUTES,
        '        if (frozen) {\n          await audit(db, {', '        if (true) {\n          await audit(db, {')],
     API, ["TC-F1"]),
    ("M10", "viewerCanManage para cualquiera", [(ROUTES,
        '        viewerCanManage: canManageTournament(req.auth, t),', '        viewerCanManage: true,')],
     API, ["TC-V1"]),
    ("M12", "contrato: cancelTournament baja su rol mínimo a user (INT289 P2-2)", [(YAML,
        "        calendario ni ejecuta batallas del torneo.\n      x-min-role: organizer",
        "        calendario ni ejecuta batallas del torneo.\n      x-min-role: user")],
     API, ["TC-P5"]),
    ("M13", "contrato: se renombra el 409 de cancelTournament en el yaml (INT289 P2-1)", [(YAML,
        "        '409': { description: 'tournament_not_cancellable",
        "        'x409': { description: 'tournament_not_cancellable")],
     API, ["TC-K1"]),
    ("M13b", "contrato: se quita el código tournament_not_cancellable del 409 documentado", [(YAML,
        "'409': { description: 'tournament_not_cancellable (currentState",
        "'409': { description: 'conflicto (currentState")],
     API, ["TC-K1"]),
    ("M13c", "contrato: se renombra el 409 de closeEntries en el yaml", [(YAML,
        "        '409': { description: 'illegal_transition (currentState, allowedTransitions; también",
        "        'x409': { description: 'illegal_transition (currentState, allowedTransitions; también")],
     API, ["TC-K2"]),
]


def run_vitest(test):
    out = tempfile.NamedTemporaryFile(prefix="tc288-", suffix=".json", delete=False).name
    r = subprocess.run(
        f"timeout 1200 npx vitest run {test} --reporter=json --outputFile={out}",
        cwd=ROOT, shell=True, capture_output=True, text=True)
    failed = []
    try:
        data = json.load(open(out))
        for f in data.get("testResults", []):
            for a in f.get("assertionResults", []):
                if a.get("status") == "failed":
                    failed.append(a.get("title", ""))
        n_ok = data.get("numPassedTests")
        n_fail = data.get("numFailedTests")
    except Exception:
        n_ok = n_fail = None
    return r.returncode, failed, n_ok, n_fail, r.stdout + r.stderr


def main():
    only = sys.argv[1:]
    fails = 0
    if not only:
        for test in (API, WRK, WEB):
            rc, failed, ok, ko, _ = run_vitest(test)
            print(f"BASE {test}: VITEST_RC={rc} passed={ok} failed={ko}")
            if rc != 0:
                fails += 1
        if fails:
            print("BASE ROJA: no se calibra sobre una base que no está verde")
            sys.exit(1)
    for mid, desc, edits, test, must in M:
        if only and mid not in only:
            continue
        originals = {}
        valid = True
        for path, old, new in edits:
            p = os.path.join(ROOT, path)
            src = originals.get(p) or open(p).read()
            originals.setdefault(p, src)
            cur = open(p).read()
            if cur.count(old) != 1:
                print(f"{mid} {desc}: ANCLA NO ÚNICA ({cur.count(old)}) en {path} -> MUTANTE INVÁLIDO")
                valid = False
                break
            open(p, "w").write(cur.replace(old, new))
        try:
            if not valid:
                fails += 1
                continue
            rc, failed, ok, ko, log = run_vitest(test)
            open(f"/tmp/tc288-mut-{mid}.log", "w").write(log)
            killers = [t for t in failed if any(t.startswith(k) for k in must)]
            verdict = "MUERTO" if (rc != 0 and killers) else ("ROJO-OTRA-RAZON" if rc != 0 else "VIVO")
            if verdict != "MUERTO":
                fails += 1
            print(f"{mid} {desc}: VITEST_RC={rc} {verdict} esperado={must} fallan={sorted(set(t.split(' ')[0] for t in failed))}")
        finally:
            for p, src in originals.items():
                open(p, "w").write(src)
    d = subprocess.run("git status --porcelain --untracked-files=no", cwd=ROOT, shell=True,
                       capture_output=True, text=True).stdout.strip()
    print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
    print(f"RESUMEN fallos_calibracion={fails}")
    sys.exit(1 if fails or d else 0)


if __name__ == "__main__":
    main()
