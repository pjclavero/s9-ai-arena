#!/usr/bin/env python3
"""V1 · TORNEOS POR INVITACIÓN (D-OP-43) · calibración de los tests por mutantes.

Cada mutante reintroduce un defecto concreto y debe poner en ROJO al menos un test NOMBRADO (por su
etiqueta TI_* / TIW_* / M026_*). Reglas, para no dar verdes vacíos:
  * No se usan filtros `-t` (vitest 4 da verde vacío si un filtro con metacaracteres no casa): cada
    mutante ejecuta su fichero ENTERO y el veredicto se lee del informe JSON por título.
  * LÍNEA BASE obligatoria: cada fichero en verde y, por mutante, al menos 1 test de su lista que
    PASA en la base (si no, el mutante es INVÁLIDO).
  * MUERTO sólo si el runner sale con rc≠0 Y al menos 1 test de su lista FALLA en el mutante.
En SERIE, nunca en paralelo: cada mutante reescribe el árbol y lo restaura al terminar.
COMMITEAR ANTES de calibrar (el árbol se comprueba limpio al final).

Uso: python3 scripts/v1-tournament-invitation-mutants.py [M1 M2 ...]
Sale con 1 si algún mutante sobrevive o es inválido, si un ancla no es única o si la base no está verde.
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_T = ("apps/api/src/v1-tournament-invitation.test.ts", "vitest.db.config.ts")
MIG_T = ("apps/api/src/db/migration-026.test.ts", "vitest.db.config.ts")
WEB_T = ("apps/web/tests/v1-tournament-invitation.test.tsx", None)
LOGIN_T = ("apps/web/tests/v1-tournament-invitation-login.test.tsx", None)
ROUTES = "apps/api/src/routes/tournaments.ts"
SVC = "apps/api/src/services/tournament-invitations.ts"
MIGR = "apps/api/src/db/migrations.ts"
YAML = "apps/api/openapi.yaml"
DETAIL = "apps/web/src/pages/TournamentDetailPage.tsx"
TEAM = "apps/web/src/pages/TournamentTeamEntry.tsx"
LIST = "apps/web/src/pages/TournamentsPage.tsx"
LINK = "apps/web/src/tournament-invitation.ts"
APP = "apps/web/src/App.tsx"
PANEL = "apps/web/src/pages/TournamentInvitationPanel.tsx"


def _vitest_bin():
    """El vitest del repo (node_modules/.bin, subiendo directorios: un worktree usa el del checkout)."""
    d = ROOT
    while True:
        cand = os.path.join(d, "node_modules", ".bin", "vitest")
        if os.path.exists(cand):
            return cand
        parent = os.path.dirname(d)
        if parent == d:
            return "npx vitest"
        d = parent


VITEST = _vitest_bin()

M = [
    # ---------------------------------------------------------------- API: inscripción
    ("M1", "la inscripción individual no exige invitación", [(ROUTES,
        "      await assertInvitationForEntry(db, t, invitationToken);\n", "")],
     API_T, ["TI_NOINVITE_INDIVIDUAL", "TI_REVOKE_IMMEDIATE", "TI_REVOKE_REGENERATE"]),
    ("M2", "la inscripción de equipo no exige invitación", [(ROUTES,
        "      const invitationId = await assertInvitationForEntry(trx, t, invitationToken);",
        "      const invitationId = null as string | null;")],
     API_T, ["TI_NOINVITE_TEAM", "TI_REVOKE_TEAM"]),
    ("M3", "cualquier token no vacío vale", [(SVC,
        "  if (!id) {\n    throw new ApiError(", "  if (false) {\n    throw new ApiError(")],
     API_T, ["TI_NOINVITE_INDIVIDUAL", "TI_NOINVITE_TEAM", "TI_REVOKE_IMMEDIATE"]),
    ("M4", "la comparación acepta cualquier token bien formado", [(SVC,
        "  return a.length === b.length && a.length === 32 && timingSafeEqual(a, b);",
        "  return a.length === 32;")],
     API_T, ["TI_NOINVITE_INDIVIDUAL", "TI_REVOKE_IMMEDIATE"]),
    ("M5", "una invitación revocada sigue valiendo", [(SVC,
        '  return (await db("tournament_invitations").where({ tournament_id: tournamentId }).whereNull("revoked_at").first()) as',
        '  return (await db("tournament_invitations").where({ tournament_id: tournamentId }).orderBy("created_at").first()) as')],
     API_T, ["TI_REVOKE_IMMEDIATE", "TI_REVOKE_REGENERATE", "TI_REVOKE_TEAM"]),
    ("M6", "un torneo abierto exige invitación (control positivo)", [(SVC,
        '  if (enrollmentOf(t) !== "invitation") return null;', '  if (false) return null;')],
     API_T, ["TI_OPEN_UNCHANGED", "TI_OPEN_EXISTING"]),
    ("M7", "la comprobación del invitado da por bueno cualquier token", [(ROUTES,
        '      enrollmentOf(t) === "invitation" && (await validInvitationId(db, String(t.id), invitationToken)) !== null;',
        '      enrollmentOf(t) === "invitation";')],
     API_T, ["TI_REVOKE_IMMEDIATE"]),
    # ---------------------------------------------------------------- API: visibilidad y token
    ("M8", "el listado público oculta los torneos por invitación", [(ROUTES,
        '      .select("tournaments.*", db.raw(cursorTsSql("tournaments.created_at")))\n      .orderBy([',
        '      .select("tournaments.*", db.raw(cursorTsSql("tournaments.created_at")))\n      .where("tournaments.enrollment", "open")\n      .orderBy([')],
     API_T, ["TI_LIST_VISIBLE"]),
    ("M9", "la ficha pública filtra la invitación activa (hash)", [(ROUTES,
        "        viewerCanManage: canManageTournament(req.auth, t),\n      });",
        "        viewerCanManage: canManageTournament(req.auth, t),\n        invitation: await activeInvitation(db, String(t.id)),\n      });")],
     API_T, ["TI_LIST_VISIBLE", "TI_TOKEN_PUBLIC_SWEEP"]),
    ("M10", "el token va a audit_log", [(ROUTES,
        "        detail: { invitationId: inv.id, revokedPrevious: revoked },",
        "        detail: { invitationId: inv.id, revokedPrevious: revoked, token },")],
     API_T, ["TI_TOKEN_STORAGE"]),
    ("M11", "token de 64 bits", [(SVC,
        "export const INVITATION_TOKEN_BYTES = 32;", "export const INVITATION_TOKEN_BYTES = 8;")],
     API_T, ["TI_TOKEN_STORAGE"]),
    ("M12", "el 201 con el token se puede cachear", [(ROUTES,
        "    // El token en claro SÓLO aquí, una vez y sólo al organizador: nunca en una caché.\n    res.setHeader(\"Cache-Control\", NO_STORE);\n",
        "")],
     API_T, ["TI_TOKEN_STORAGE"]),
    ("M13", "el contrato no marca el token x-private", [(YAML,
        "          x-private: true\n          description: 'Token del enlace", "          description: 'Token del enlace")],
     API_T, ["TI_TOKEN_OPENAPI"]),
    ("M14", "regenerar no revoca el anterior", [(ROUTES,
        "      const revoked = await revokeActiveInvitation(trx, String(t.id), req.auth!.userId);\n      const token = newInvitationToken();",
        "      const revoked = 0;\n      const token = newInvitationToken();")],
     API_T, ["TI_REVOKE_REGENERATE"]),
    # ---------------------------------------------------------------- API: gestión y modalidad
    ("M15", "cualquier organizador gestiona el enlace de otro", [(ROUTES,
        "    assertCanManageTournament(req.auth, t);\n    return t as Record<string, unknown>;",
        "    return t as Record<string, unknown>;")],
     API_T, ["TI_MANAGE_ONLY"]),
    ("M16", "la modalidad cambia en cualquier estado", [(ROUTES,
        "    if (!(ENROLLMENT_EDITABLE_STATES as readonly string[]).includes(String(t.state))) {",
        "    if (false) {")],
     API_T, ["TI_ENROLL_STATES"]),
    ("M17", "pasar a abierto no revoca el enlace", [(ROUTES,
        '      const revoked = enrollment === "open" ? await revokeActiveInvitation(trx, String(t.id), req.auth!.userId) : 0;',
        "      const revoked = 0;")],
     API_T, ["TI_ENROLL_STATES"]),
    ("M18", "createTournament ignora la modalidad", [(ROUTES,
        '        enrollment: enrollment ?? "open",', '        enrollment: "open",')],
     API_T, ["TI_LIST_VISIBLE", "TI_NOINVITE_INDIVIDUAL"]),
    ("M19", "createTournament admite cualquier modalidad", [(ROUTES,
        "    if (enrollment !== undefined && !isEnrollmentMode(enrollment)) {", "    if (false) {")],
     API_T, ["TI_ENROLL_STATES"]),
    # ---------------------------------------------------------------- migración
    ("M20", "sin índice de una sola invitación activa", [(MIGR,
        "      CREATE UNIQUE INDEX tournament_invitations_one_active\n        ON tournament_invitations (tournament_id) WHERE revoked_at IS NULL;\n",
        "")],
     MIG_T, ["M026_INVARIANTS"]),
    ("M21", "los torneos existentes nacen por invitación", [(MIGR,
        "ADD COLUMN enrollment text NOT NULL DEFAULT 'open'", "ADD COLUMN enrollment text NOT NULL DEFAULT 'invitation'")],
     MIG_T, ["M026_INVARIANTS"]),
    # ---------------------------------------------------------------- web
    ("W1", "la ficha ofrece inscribirse sin invitación", [(DETAIL,
        '  return invite?.status === "valid";\n}', "  return true;\n}")],
     WEB_T, ["TIW_NO_FORM", "TIW_NO_FORM_TEAM", "TIW_INVALID"]),
    ("W2", "la inscripción individual no envía el token", [(DETAIL,
        "        ...(invitationToken ? { invitationToken } : {}),\n      });", "      });")],
     WEB_T, ["TIW_VALID_FORM"]),
    ("W3", "la inscripción de equipo no envía el token", [(TEAM,
        "        ...(props.invitationToken ? { invitationToken: props.invitationToken } : {}),\n", "")],
     WEB_T, ["TIW_TEAM_SUBMIT"]),
    ("W4", "un enlace rechazado por la API no se olvida", [(DETAIL,
        "          clearInvitation(props.id);\n          setInvite({ status: \"invalid\" });",
        "          setInvite({ status: \"invalid\" });")],
     WEB_T, ["TIW_INVALID"]),
    ("W5", "un 403 de invitación al inscribir deja el formulario", [(DETAIL,
        "      onInvitationRejected(err);\n", "")],
     WEB_T, ["TIW_REVOKED_ON_SUBMIT"]),
    ("W6", "el panel del organizador se ve sin gestionar el torneo", [(DETAIL,
        '              {t.viewerCanManage && (t.state === "draft" || t.state === "open") && (',
        '              {(t.state === "draft" || t.state === "open") && (')],
     WEB_T, ["TIW_NO_FORM", "TIW_ADMIN_HIDDEN"]),
    ("W7", "un torneo abierto pasa a exigir invitación en la web (control positivo)", [(DETAIL,
        '  if (t.enrollment !== "invitation") return true;', '  if (t.enrollment === "none") return true;')],
     WEB_T, ["TIW_OPEN_UNCHANGED"]),
    ("W8", "el alta no envía la modalidad", [(LIST,
        '        ...(enrollment === "invitation" ? { enrollment } : {}),\n', "")],
     WEB_T, ["TIW_CREATE"]),
    ("W9", "el alta envía la modalidad siempre (cambia la petición de un torneo abierto)", [(LIST,
        '        ...(enrollment === "invitation" ? { enrollment } : {}),', "        enrollment,")],
     WEB_T, ["TIW_CREATE_DEFAULT"]),
    ("W10", "el enlace lleva el token en la query (viaja al servidor)", [(LINK,
        "  return `${base}#/tournaments/${encodeURIComponent(tournamentId)}/invitation/${token}`;",
        "  return `${base}?invitation=${token}#/tournaments/${encodeURIComponent(tournamentId)}`;")],
     WEB_T, ["TIW_ADMIN_GENERATE"]),
    ("W11", "la captura no quita el token de la barra", [(LINK,
        '  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${clean}`);\n',
        "")],
     WEB_T, ["TIW_CAPTURE"]),
    ("W12", "el organizador no puede revocar desde la web", [(PANEL,
        '      await api("DELETE", `${base}/invitation`);\n', "")],
     WEB_T, ["TIW_ADMIN_REVOKE"]),
    ("W13", "cambiar la modalidad no llama a la API", [(PANEL,
        '      await api("PUT", `${base}/enrollment`, { enrollment });\n', "")],
     WEB_T, ["TIW_ADMIN_ENROLLMENT"]),
    ("W14", "la App no captura el enlace al abrirlo", [(APP,
        '  const [route, setRoute] = useState(() => captureInvitationFromLocation() ?? (window.location.hash || "#/"));',
        '  const [route, setRoute] = useState(window.location.hash || "#/");')],
     LOGIN_T, ["TIW_LOGIN_RETURN", "TIW_LOGIN_REGISTER"]),
    ("W15", "sin aviso de invitación en el acceso", [(APP,
        '        {panelRoute?.kind === "tournament" && pendingInvitation(panelRoute.id) ? (',
        "        {false ? (")],
     LOGIN_T, ["TIW_LOGIN_RETURN", "TIW_LOGIN_REGISTER"]),
]


def run_vitest(test):
    path, cfg = test
    out = tempfile.NamedTemporaryFile(prefix="ti-", suffix=".json", delete=False).name
    c = f"--config {cfg} " if cfg else ""
    r = subprocess.run(
        f"nice -n 19 timeout 900 {VITEST} run {c}{path} --maxWorkers=1 --reporter=json --outputFile={out}",
        cwd=ROOT, shell=True, capture_output=True, text=True)
    passed, failed = [], []
    try:
        data = json.load(open(out))
        for f in data.get("testResults", []):
            for a in f.get("assertionResults", []):
                (failed if a.get("status") == "failed" else passed if a.get("status") == "passed" else []).append(
                    a.get("title", ""))
    except Exception:
        pass
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass
    return r.returncode, passed, failed, r.stdout + r.stderr


def matches(titles, tags):
    return [t for t in titles if any(t.startswith(k + " ") or t == k for k in tags)]


def main():
    only = sys.argv[1:]
    fails = 0
    base = {}
    for test in {m[3] for m in M if not only or m[0] in only}:
        rc, passed, failed, _ = run_vitest(test)
        base[test] = passed
        print(f"BASE {test[0]}: VITEST_RC={rc} passed={len(passed)} failed={len(failed)}")
        if rc != 0 or failed or not passed:
            fails += 1
    if fails:
        print("BASE ROJA O VACÍA: no se calibra sobre una base que no está verde")
        sys.exit(1)
    for mid, desc, edits, test, must in M:
        if only and mid not in only:
            continue
        if not matches(base[test], must):
            print(f"{mid} {desc}: INVÁLIDO (ningún test de {must} pasa en la base)")
            fails += 1
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
            rc, _, failed, log = run_vitest(test)
            open(os.path.join(tempfile.gettempdir(), f"ti-mut-{mid}.log"), "w").write(log)
            killers = matches(failed, must)
            verdict = "MUERTO" if (rc != 0 and killers) else ("ROJO-OTRA-RAZON" if rc != 0 else "VIVO")
            if verdict != "MUERTO":
                fails += 1
            print(f"{mid} {desc}: VITEST_RC={rc} {verdict} esperado={must} "
                  f"matan={sorted(set(t.split(' ')[0] for t in killers))}")
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
