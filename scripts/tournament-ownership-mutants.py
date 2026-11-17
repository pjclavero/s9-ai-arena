#!/usr/bin/env python3
"""#291 · Calibración de TOURNAMENT_ACTION_OWNERSHIP: cada mutante quita (o debilita) UNA
comprobación de propiedad y debe poner en ROJO el test indicado, por la razón esperada.

Uso: python3 scripts/tournament-ownership-mutants.py [M1 M2 ...]
Serie, nunca en paralelo sobre el mismo árbol. Commitea antes: el script restaura cada
fichero tras su mutante, pero no protege cambios ajenos sin commitear.
Exige PostgreSQL de test (embedded-postgres o DATABASE_URL), como `npm run test:db`.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTES = "apps/api/src/routes/tournaments.ts"
ELIG = "apps/api/src/services/version-eligibility.ts"
ACCESS = "apps/api/src/services/tournament-access.ts"
DETAIL = "apps/web/src/pages/TournamentDetailPage.tsx"
API_T = "apps/api/src/tournament-action-ownership.test.ts"
WEB_T = "apps/web/tests/tournament-action-ownership.test.tsx"

GUARD = "    assertCanManageTournament(req.auth, t); // #291 · dueño del torneo o staff\n"

# (id y descripción, fichero, ancla, sustitución, test, prefijo del test que debe caer, razón)
M = [
    ("M1 closeEntries sin guarda de propiedad", ROUTES,
     GUARD + '    if (t.state !== "open") {\n      throw conflict("illegal_transition"',
     '    if (t.state !== "open") {\n      throw conflict("illegal_transition"',
     API_T, "TAO-C3", r"expected 200 to be 403"),
    ("M2 dryRunTournament sin guarda de propiedad", ROUTES,
     GUARD + "    // Simulacro con bots de ejemplo",
     "    // Simulacro con bots de ejemplo",
     API_T, "TAO-D3", r"expected 202 to be 403"),
    ("M3 exclude: vía de organizador sin propiedad del torneo", ELIG,
     "const byManager = actor.rank >= ROLE_RANK.organizer && canManageTournament(actor, t);",
     "const byManager = actor.rank >= ROLE_RANK.organizer;",
     API_T, "TAO-X3", r"expected 200 to be 403"),
    ("M4 exclude: vía de organizador sin suelo de rol", ELIG,
     "const byManager = actor.rank >= ROLE_RANK.organizer && canManageTournament(actor, t);",
     "const byManager = canManageTournament(actor, t);",
     API_T, "TAO-X7", r"expected 200 to be 403"),
    ("M5 predicado sin la rama de staff", ACCESS,
     "return !!auth && (auth.userId === t.created_by || isStaff(auth as Auth));",
     "return !!auth && auth.userId === t.created_by;",
     API_T, "TAO-C2", r"expected 403 to be 200"),
    ("M6 predicado sin la rama de dueño", ACCESS,
     "return !!auth && (auth.userId === t.created_by || isStaff(auth as Auth));",
     "return !!auth && isStaff(auth as Auth);",
     API_T, "TAO-C1", r"expected 403 to be 200"),
    ("M7 predicado: cualquier autenticado gestiona", ACCESS,
     "return !!auth && (auth.userId === t.created_by || isStaff(auth as Auth));",
     "return !!auth;",
     API_T, "TAO-C3", r"expected 200 to be 403"),
    ("M8 viewerCanManage para cualquiera", ROUTES,
     "        viewerCanManage: canManageTournament(req.auth, t),",
     "        viewerCanManage: true,",
     API_T, "TAO-V1", r"expected true to be false"),
    ("M9 detalle cacheable (sin no-store)", ROUTES,
     '      res.setHeader("Cache-Control", NO_STORE);\n      res.json({\n        ...tournamentToJson(t),',
     '      res.json({\n        ...tournamentToJson(t),',
     API_T, "TAO-V1", r"private, no-store"),
    ("M10 web: Cerrar inscripciones para todos", DETAIL,
     "                  {t.viewerCanManage && (\n                    <button type=\"button\" onClick={onCloseEntries}",
     "                  {true && (\n                    <button type=\"button\" onClick={onCloseEntries}",
     WEB_T, "TW-291-2", r"expected .* to be null|toBeNull"),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def main():
    only = sys.argv[1:]
    fails = 0
    for name, path, old, new, test, filt, why in M:
        mid = name.split()[0]
        if only and mid not in only:
            continue
        p = os.path.join(ROOT, path)
        src = open(p).read()
        if src.count(old) != 1:
            print(f"{name}: ANCLA NO ÚNICA ({src.count(old)}) -> MUTANTE INVÁLIDO")
            fails += 1
            continue
        open(p, "w").write(src.replace(old, new))
        try:
            r = sh(f"timeout 900 npx vitest run {test} 2>&1")
            out = r.stdout + r.stderr
            open(f"/tmp/t291-mut-{mid}.log", "w").write(out)
            red = r.returncode != 0 and re.search(r"\d+ failed", out) is not None
            failed = sorted(set(re.findall(r"(?:×|✗|FAIL)\s.*?((?:TAO|TW-291)-[A-Z]*\d+)", out)))
            reason = re.search(why, out) is not None and any(f.startswith(filt) for f in failed)
            verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
            if verdict != "ROJO-OK":
                fails += 1
            print(f"{name}: rc={r.returncode} {verdict} fallan={failed}")
        finally:
            open(p, "w").write(src)
    d = sh("git status --porcelain --untracked-files=no").stdout.strip()
    print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
    print(f"RESUMEN fallos_calibracion={fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
