#!/usr/bin/env python3
"""B3 (V1, D-OP-9) · Calibración de los tests de «torneos sin CTF ni control de zona».

Cada mutante reintroduce un defecto concreto y debe poner en ROJO el test indicado (por su etiqueta
B3_* / V1C_* / B3W_*). Primero la línea base (todo verde). En SERIE, nunca en paralelo: cada mutante
reescribe el árbol y lo restaura al terminar. COMMITEAR ANTES de calibrar.

Uso: python3 scripts/v1-b3-tournament-modes-mutants.py [M1 M2 ...]
Sale con 1 si algún mutante sobrevive, si un ancla no es única o si la base no está verde.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_T = ("apps/api/src/v1-b3-tournament-modes.test.ts", "vitest.db.config.ts")
WRK_T = ("apps/tournament-worker/src/v1-tournament-ctf-zone.e2e.test.ts", "vitest.db.config.ts")
WEB_T = ("apps/web/tests/b3-tournament-modes.test.tsx", None)
ROUTES = "apps/api/src/routes/tournaments.ts"
SCHED = "apps/tournament-worker/src/scheduler.ts"
MODES = "apps/tournament-worker/src/tournament-modes.ts"
PAGE = "apps/web/src/pages/TournamentsPage.tsx"
YAML = "apps/api/openapi.yaml"

M = [
    ("M1", "createTournament no rechaza el modo excluido", [(ROUTES,
        "    rejectTournamentMode(mode);\n", "")],
     API_T, ["B3_CTF_FOREIGN_RULESET"]),
    ("M2", "no se mira el modo real del ruleset de plataforma", [(ROUTES,
        "      if (engineMode !== undefined) rejectTournamentMode(engineMode, { rulesetId, engineRulesetId: engineId });\n",
        "")],
     API_T, ["B3_RULESET_CROSS_CTF", "B3_RULESET_CROSS_ZONE"]),
    ("M3", "la fuente única admite CTF", [(MODES,
        'export const TOURNAMENT_ALLOWED_MODES: readonly string[] = ["deathmatch", "team_deathmatch"];',
        'export const TOURNAMENT_ALLOWED_MODES: readonly string[] = ["deathmatch", "team_deathmatch", "capture_the_flag"];')],
     API_T, ["B3_SINGLE_SOURCE", "B3_CTF_CLASSIC"]),
    ("M4", "el código de error deja de ser estable", [(ROUTES,
        "  throw new ApiError(400, TOURNAMENT_MODE_NOT_ALLOWED,", "  throw new ApiError(400, \"bad_request\",")],
     API_T, ["B3_CTF_CLASSIC"]),
    ("M5", "el 400 no lleva la lista de modos permitidos", [(ROUTES,
        "    allowedModes: [...TOURNAMENT_ALLOWED_MODES],\n", "")],
     API_T, ["B3_CTF_CLASSIC"]),
    ("M6", "OpenAPI no documenta el 400 de createTournament", [(YAML,
        "'Datos inválidos · tournament_mode_not_allowed (B3:", "'Datos inválidos · (B3:")],
     API_T, ["B3_OPENAPI"]),
    ("M7", "el scheduler programa torneos antiguos con modo excluido", [(SCHED,
        "  if (!isTournamentModeAllowed(t.mode)) {", "  if (false) {")],
     WRK_T, ["V1C_CTF_historic_not_scheduled", "V1C_ZONE_historic_not_scheduled"]),
    ("M8", "el scheduler sólo bloquea CTF (no zona)", [(SCHED,
        "  if (!isTournamentModeAllowed(t.mode)) {", "  if (t.mode === \"capture_the_flag\") {")],
     WRK_T, ["V1C_ZONE_historic_not_scheduled"]),
    ("M9", "el scheduler bloquea también Deathmatch (control positivo)", [(SCHED,
        "  if (!isTournamentModeAllowed(t.mode)) {", "  if (true) {")],
     WRK_T, ["V1C_DM_still_scheduled"]),
    ("M13", "closeEntries no rechaza el modo excluido (O1)", [(ROUTES,
        "      if (!isTournamentModeAllowed(t.mode)) {\n        throw conflict(", "      if (false) {\n        throw conflict(")],
     API_T, ["B3_CLOSE_ENTRIES_REJECTED"]),
    ("M14", "un `closed` con modo excluido deja de poder cancelarse (O1)", [(ROUTES,
        '      if (t.state === "closed" && !isTournamentModeAllowed(t.mode)) cancellableStates.push("closed");\n', "")],
     API_T, ["B3_CLOSED_EXCLUDED_CANCELLABLE"]),
    ("M15", "cualquier `closed` pasa a ser cancelable (ampliación demasiado amplia)", [(ROUTES,
        '      if (t.state === "closed" && !isTournamentModeAllowed(t.mode)) cancellableStates.push("closed");',
        '      if (t.state === "closed") cancellableStates.push("closed");')],
     API_T, ["B3_CLOSED_ALLOWED_NOT_CANCELLABLE"]),
    ("M16", "el worker deja el trabajo sin acotar (status done)", [(SCHED,
        "    throw new Error(`generate_schedule: ${TOURNAMENT_MODE_NOT_ALLOWED}: ${tournamentModeNotAllowedReason(t.mode)}`);",
        "    return;")],
     WRK_T, ["V1C_CTF_historic_not_scheduled"]),
    ("M17", "la web deja TEAM_TOURNAMENT_MODE fuera de la fuente única", [(PAGE,
        'export const TEAM_TOURNAMENT_MODE = "team_deathmatch";', 'export const TEAM_TOURNAMENT_MODE = "capture_the_flag";')],
     WEB_T, ["B3W_DRIFT"]),
    ("M10", "la web vuelve a ofrecer CTF y zona", [(PAGE,
        'export const TOURNAMENT_CREATE_MODES = ["deathmatch", "team_deathmatch"];',
        'export const TOURNAMENT_CREATE_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];')],
     WEB_T, ["B3W_NO_CTF_ZONE", "B3W_DRIFT"]),
    ("M11", "la web deja de listar torneos antiguos con CTF", [(PAGE,
        "<td>{modeName(t.mode)}</td>", "<td>{TOURNAMENT_CREATE_MODES.includes(t.mode) ? modeName(t.mode) : \"\"}</td>")],
     WEB_T, ["B3W_HISTORIC_LISTED"]),
    ("M12", "la web con «Por equipos» ofrece más de un modo", [(PAGE,
        'const modeOptions = format === "teams" ? [TEAM_TOURNAMENT_MODE] : MODES;',
        'const modeOptions = format === "teams" ? [TEAM_TOURNAMENT_MODE, "capture_the_flag"] : MODES;')],
     WEB_T, ["B3W_NO_CTF_ZONE_TEAMS"]),
]


def run_vitest(test):
    path, cfg = test
    out = tempfile.NamedTemporaryFile(prefix="b3-", suffix=".json", delete=False).name
    c = f"--config {cfg} " if cfg else ""
    r = subprocess.run(
        f"nice -n 19 timeout 1200 npx vitest run {c}{path} --maxWorkers=1 --reporter=json --outputFile={out}",
        cwd=ROOT, shell=True, capture_output=True, text=True)
    failed, n_ok, n_fail = [], None, None
    try:
        data = json.load(open(out))
        for f in data.get("testResults", []):
            for a in f.get("assertionResults", []):
                if a.get("status") == "failed":
                    failed.append(a.get("title", ""))
        n_ok, n_fail = data.get("numPassedTests"), data.get("numFailedTests")
    except Exception:
        pass
    return r.returncode, failed, n_ok, n_fail, r.stdout + r.stderr


def main():
    only = sys.argv[1:]
    fails = 0
    if not only:
        for test in (API_T, WRK_T, WEB_T):
            rc, _, ok, ko, _ = run_vitest(test)
            print(f"BASE {test[0]}: VITEST_RC={rc} passed={ok} failed={ko}")
            if rc != 0:
                fails += 1
        if fails:
            print("BASE ROJA: no se calibra sobre una base que no está verde")
            sys.exit(1)
    for mid, desc, edits, test, must in M:
        if only and mid not in only:
            continue
        originals, valid = {}, True
        for path, old, new in edits:
            p = os.path.join(ROOT, path)
            cur = open(p).read()
            originals.setdefault(p, cur)
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
            open(f"/tmp/b3-mut-{mid}.log", "w").write(log)
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
