#!/usr/bin/env python3
"""INTB-FIX · mutantes del mínimo de participantes / cerrojo consultivo / privacidad de advancedBotId (Z1-Z12).
Uso: python3 scripts/tournament-min-mutants.py ROOT [ids]. En serie; base verde primero; árbol limpio al final.
Cada mutante no equivalente debe morir por un test NOMBRADO (columna `must`: subcadena del nombre del test
que falla). Los equivalentes (Z1b, Z3b, Z5c, Z10) deben sobrevivir. Sale con 0 sólo si todo se cumple.
Commitea antes de lanzarlo: el harness restaura los ficheros mutados."""
import json, os, subprocess, sys, tempfile
ROOT = os.path.abspath(sys.argv[1]); only = sys.argv[2:]
R = "apps/api/src/routes/tournaments.ts"
RES = "apps/tournament-worker/src/results.ts"
T = "apps/api/src/team-enrollment.test.ts"
C = "apps/api/src/tournament-cancel.test.ts"
O = "apps/api/src/tournament-action-ownership.test.ts"
P = "apps/api/src/public-api.test.ts"
U = "apps/api/src/uxf-tournament-access.test.ts"
F = "apps/api/src/frozen-reuse.test.ts"
L = "apps/tournament-worker/src/tournament-lifecycle-failed.test.ts"
W = "apps/tournament-worker/src/tournament-cancel-worker.test.ts"
ALL = [T, C, O, P, F, L, W, U]
GATE = "      await entryCompetitionGate(db, t, entries);\n"
MINC = "      // B · mínimo de participantes, tras el gate (cuenta sólo lo que compite) y antes de cualquier efecto.\n"
MIN = "      await assertMinimumParticipants(db, t, entries);\n"
LOCKSEL = '      const t = await db("tournaments")\n        .where({ id: pathParam(req, "tournamentId") })\n        .forUpdate()\n        .first()\n        .catch(() => null);\n      if (!t) throw notFound();\n'
AUTH = "      assertCanManageTournament(req.auth, t); // #291 · dueño del torneo o staff (tras el cerrojo, antes de tocar nada)\n" + "      if (t.state !== \"open\") {\n        throw conflict(\"illegal_transition\""
STATE = '      if (t.state !== "open") {\n        throw conflict("illegal_transition"'
FREEZE = '      await db("entries").where({ tournament_id: t.id }).update({ frozen: true });\n'
LOCKFN = 'await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tournament-settle:${tournamentId}`]);'
FIN = '.where({ id: tournamentId, state: "running" })'
PRE = ('      {\n        const t00 = await db("tournaments").where({ id: pathParam(req, "tournamentId") }).first().catch(() => null);\n'
       '        if (t00 && t00.state === "open") await assertMinimumParticipants(db, t00, (await db("entries").where({ tournament_id: t00.id })) as Record<string, unknown>[]);\n      }\n')
E0 = '      const e0 = (await db("entries").where({ tournament_id: t.id })) as Record<string, unknown>[];\n      await assertMinimumParticipants(db, t, e0);\n'
M = [
 ("Z1","mínimo ANTES del gate",[(R,MINC+MIN,""),(R,GATE,MIN+GATE)],[T,C,O,P,F,L],["B_MIN_AFTER_GATE"]),
 ("Z1b","mínimo antes de los cerrojos de bots/versiones (equiv. probable: el torneo ya está bloqueado)",[(R,MINC+MIN,""),(R,"      if (entries.length > 0) {\n        await db(\"bots\")","      await assertMinimumParticipants(db, t, entries);\n      if (entries.length > 0) {\n        await db(\"bots\")")],[T,L],["(equiv?)"]),
 ("Z2","mínimo FUERA del cerrojo del torneo (TOCTOU: lectura previa sin FOR UPDATE)",[(R,MINC+MIN,""),(R,LOCKSEL+AUTH,PRE+LOCKSEL+AUTH)],[T,C,O,P,F,L],["B_MIN_CONCURRENT"]),
 ("Z3","teams: cuenta inscripciones, no equipos",[(R,"    count = teams.size;","    count = entries.length;")],[T,L],["[R5]"]),
 ("Z3b","teams: equipo efectivo = sólo el del bot (ignora entries.team_id) (equiv. probable: el gate lo cubre)",[(R,"(e.team_id as string | null) ?? teamOfBot.get(String(e.bot_id)) ?? null","teamOfBot.get(String(e.bot_id)) ?? null")],[T,L],["(equiv?)"]),
 ("Z4","settleBattle: cerrojo consultivo tras leer el contexto",[(RES,"    await lockTournament(trx, battle.tournament_id);\n    const mctx = await buildMaterializeContext(trx, battle.tournament_id);","    const mctx = await buildMaterializeContext(trx, battle.tournament_id);\n    await lockTournament(trx, battle.tournament_id);")],[L,W],["[R1]"]),
 ("Z4b","sin cerrojo consultivo (rescate y cierre)",[(RES,LOCKFN,"void trx; void tournamentId;")],[L,W],["[R1]"]),
 ("Z4c","sólo el rescate sin cerrojo (cierre normal conserva)",[(RES,"    await db.transaction(async (trx) => {\n      await lockTournament(trx, id);","    await db.transaction(async (trx) => {")],[L,W],["(rescate)"]),
 ("Z5","finishTournamentIfDone acepta cancelled",[(RES,FIN,'.where({ id: tournamentId }).whereIn("state", ["running", "cancelled"])')],[L,W],["[R2]"]),
 ("Z5b","rescate selecciona y procesa torneos cancelled + cierre los acepta",[(RES,FIN,'.where({ id: tournamentId }).whereIn("state", ["running", "cancelled"])'),(RES,'    .where({ state: "running" })\n    .whereNotExists(','    .whereIn("state", ["running", "cancelled"])\n    .whereNotExists('),(RES,'if (!t || t.state !== "running") return; // otro trabajo ya lo resolvió','if (!t) return;')],[L,W],["no toca torneos"]),
 ("Z5c","guarda #289 original (whereNot cancelled) en lugar de state=running (equivalencia)",[(RES,FIN,'.where({ id: tournamentId }).whereNot({ state: "cancelled" })')],[L,W],["(equiv?)"]),
 ("Z6","advancedBotId también en matches finished",[(R,'...(m.state === "failed" && !winnerHidden ?','...(!winnerHidden ?')],[L,P],["[S4]"]),
 ("Z7","advancedBotId se filtra aunque el bot esté oculto (winnerHidden)",[(R,'...(m.state === "failed" && !winnerHidden ?','...(m.state === "failed" ?')],[L,P,T],["(privacidad advancedBotId)"]),
 ("Z7b","match failed expone el ganador (advancedBotId con ganador en winnerBotId)",[(R,'winnerBotId: winnerHidden || m.state === "failed" ? null','winnerBotId: winnerHidden ? null')],[L,P],["[S4]"]),
 ("Z8","mínimo 1 en vez de 2",[(R,"  if (count < 2) {","  if (count < 1) {")],[T,L],["[M3]"]),
 ("Z9","mínimo antes del 409 illegal_transition",[(R,MINC+MIN,""),(R,STATE,E0+STATE)],[T,C,O,P,F,L],["(orden illegal_transition)"]),
 ("Z10","mínimo después del freeze de entradas (equiv.: todo en la misma transacción)",[(R,MINC+MIN,""),(R,FREEZE,FREEZE+MIN)],[T,L],["(equiv?)"]),
 ("Z11","mínimo antes de assertCanManageTournament (filtra 409 a quien no gestiona)",[(R,MINC+MIN,""),(R,AUTH,E0+AUTH)],[T,C,O,P,F,L],["TAO-"]),
 ("Z12","mínimo no se cuenta en closeEntries (sin llamada)",[(R,MINC+MIN,"")],[T,C,O,P,F,L],["[M3]"]),
]
# id -> (ficheros de test, subcadena del test que DEBE fallar | None si es equivalente y debe sobrevivir)
OVR = {
 "Z1": ([T], "B_MIN_ORDER_GATE"), "Z1b": ([T, L], None), "Z2": ([T], "B_MIN_UNDER_LOCK"),
 "Z3": ([T, L], "[R5]"), "Z3b": ([T, L], None), "Z4": ([L], "[R1b]"), "Z4b": ([L], "[R1"), "Z4c": ([L], "[R1b]"),
 "Z5": ([L, W], "[R2]"), "Z5b": ([L, W], "[R2]"), "Z5c": ([L, W], None),
 "Z6": ([L, P], "[S4]"), "Z7": ([U], "advancedBotId"), "Z7b": ([L, P], "[S4]"),
 "Z8": ([T, L], "[M3]"), "Z9": ([T], "B_MIN_ORDER_STATE"), "Z10": ([T, L], None),
 "Z11": ([T], "B_MIN_ORDER_AUTH"), "Z12": ([T, L], "[M3]"),
}
M = [(mid, desc, edits, OVR[mid][0], [OVR[mid][1] or "(equivalente)"]) for (mid, desc, edits, _t, _m) in M]
def vt(files):
    out=tempfile.NamedTemporaryFile(prefix="rib-",suffix=".json",delete=False).name
    r=subprocess.run(f"timeout 1700 npx vitest run --maxWorkers=2 --hookTimeout=300000 --testTimeout=120000 {' '.join(files)} --reporter=json --outputFile={out}",cwd=ROOT,shell=True,capture_output=True,text=True)
    failed=[];ok=ko=None
    try:
        d=json.load(open(out)); ok=d.get("numPassedTests"); ko=d.get("numFailedTests")
        for f in d.get("testResults",[]):
            if f.get("status")=="failed" and not f.get("assertionResults"): failed.append("<suite:"+os.path.basename(f.get("name",""))+">")
            for a in f.get("assertionResults",[]):
                if a.get("status")=="failed": failed.append(a.get("fullName") or a.get("title",""))
    except Exception: pass
    return r.returncode,failed,ok,ko
if not only:
    rc,_,ok,ko=vt(ALL); print(f"BASE VITEST_RC={rc} passed={ok} failed={ko}",flush=True)
    if rc: print("BASE ROJA"); sys.exit(1)
bad=[]
for mid,desc,edits,tests,must in M:
    if only and mid not in only: continue
    orig={}; valid=True
    for p,old,new in edits:
        fp=os.path.join(ROOT,p); cur=open(fp).read(); orig.setdefault(fp,cur)
        cur=open(fp).read()
        if cur.count(old)!=1: print(f"{mid} ANCLA NO UNICA ({cur.count(old)}) en {p}: {desc}",flush=True); valid=False; bad.append(mid); break
        open(fp,"w").write(cur.replace(old,new))
    try:
        if valid:
            rc,failed,ok,ko=vt(tests)
            tag = OVR[mid][1]
            if tag is None: ok_ = (rc == 0)            # equivalente: debe sobrevivir
            else: ok_ = rc != 0 and any(tag in x for x in failed)   # debe morir por el test nombrado
            st = ("MUERTO" if rc else "VIVO") + (" OK" if ok_ else " ERROR")
            if not ok_: bad.append(mid)
            print(f"{mid} {st} rc={rc} fail={len(failed)} esperado={tag} {desc} :: "+" | ".join(x[:110] for x in failed[:5]),flush=True)
    finally:
        for fp,cur in orig.items(): open(fp,"w").write(cur)
st=subprocess.run("git status --porcelain --untracked-files=no",cwd=ROOT,shell=True,capture_output=True,text=True).stdout.strip()
print("ARBOL_LIMPIO=",st=="",flush=True)
print("MUTANTES_MAL=",bad,flush=True)
sys.exit(0 if (st=="" and not bad) else 1)
