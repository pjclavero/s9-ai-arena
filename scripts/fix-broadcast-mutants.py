#!/usr/bin/env python3
"""FIX-BROADCAST · Calibración de los tests de «destino válido y estados terminales».

Cada mutante rompe UNA garantía y debe poner en ROJO el test indicado (fragmento de su
nombre en la salida de vitest), por la razón esperada. Antes de los mutantes se ejecuta
la línea base (sin mutar): los tres ficheros tienen que estar en VERDE.

En serie, nunca en paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al
terminar; el script comprueba al final que el árbol queda limpio).

Uso: python3 scripts/fix-broadcast-mutants.py [--json salida.json] [A1 D3 ...]
"""
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "apps/api/src/fix-broadcast-target.test.ts"
DIR = "apps/web/tests/fix-broadcast-director.test.ts"
ADM = "apps/web/tests/fix-broadcast-admin.test.tsx"
EFF = "apps/api/src/broadcast-effective.ts"
ROUTES = "apps/api/src/routes/streaming.ts"
DIRECTOR = "apps/web/src/broadcast/director.ts"
SPAGE = "apps/web/src/pages/StreamingPage.tsx"
BPAGE = "apps/web/src/pages/BroadcastPage.tsx"

# (nombre, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
M = [
    # ── API: start exige broadcastAvailable y rechaza con motivo estable ─────────────
    ("A1 start sólo mira broadcastable", ROUTES,
     "    if (!info.broadcastAvailable) {",
     "    if (false) {",
     API, "el incidente"),
    ("A2 torneo terminado sin contenido aceptado", EFF,
     '  if (finished && readable === 0) return out(false, "tournament_no_content");',
     "",
     API, "SIN ninguna batalla emitible"),
    ("A3 batalla revertida aceptada", EFF,
     '  if (b.reverted_at) return out(false, "battle_not_available");',
     "",
     API, "REVERTIDA"),
    ("A4 torneo en borrador aceptado", EFF,
     '  if (t.state === "draft") return out(false, "tournament_not_started");',
     "",
     API, "borrador"),
    ("A5 destino inexistente vuelve a 404", ROUTES,
     '    if (!info) throw conflict("target_not_found", targetRejectMessage("target_not_found"));',
     '    if (!info) throw notFound("Destino no encontrado");',
     API, "destino inexistente"),
    ("A6 espera legítima de torneo rechazada", EFF,
     '  if (finished && readable === 0) return out(false, "tournament_no_content");',
     '  if (readable === 0) return out(false, "tournament_no_content");',
     API, "batallas programadas"),
    ("A7 replays públicos ignorados en el torneo terminado", EFF,
     "  if (finished ? !vis.publicReplays : !vis.publicSpectate) {",
     "  if (!finished && !vis.publicSpectate) {",
     API, "el incidente"),
    ("A8 batalla de torneo presentada como suelta", EFF,
     '      targetType: b.tournament_id ? "tournament_battle" : "standalone_battle",',
     '      targetType: "standalone_battle",',
     API, "batalla de torneo ⇒ tournament_battle"),
    ("A9 recuento sin programadas", EFF,
     '    .where("tournament_id", tournamentId)\n    .groupBy("status")',
     '    .where("tournament_id", tournamentId)\n    .whereNot("status", "scheduled")\n    .groupBy("status")',
     API, "batallas programadas"),
    ("A10 fase de torneo terminado como espera", EFF,
     '    : tr.state === "finished"\n      ? "TARGET_FINISHED"',
     '    : tr.state === "never"\n      ? "TARGET_FINISHED"',
     API, "control positivo"),
    # ── R2: batalla programada y reinicio ────────────────────────────────────────────
    ("A11 batalla programada rechazada (battle_not_started)", EFF,
     "    if (!show.showable) return out(false, show.reason ?? \"other\");\n    return out(true, null);",
     "    if (!show.showable) return out(false, show.reason ?? \"other\");\n    return out(false, \"battle_not_started\");",
     API, "programada con bots públicos"),
    ("A12 programada ignora la visibilidad de sus bots", EFF,
     "    if (!show.showable) return out(false, show.reason ?? \"other\");\n    return out(true, null);",
     "    return out(true, null);",
     API, "programada con bot privado"),
    ("A13 programada ignora el espectador público", EFF,
     "    if (!vis.publicSpectate) return out(false, \"public_spectate_disabled\");\n    const show = await publicShowabilityOf(db, battleId);",
     "    const show = await publicShowabilityOf(db, battleId);",
     API, "espectador público apagado ⇒ rechazada"),
    ("A14 URL del streamer sin wait=scheduled", "apps/api/src/services/streaming.ts",
     '  if (opts.waitScheduled && t.kind === "battle") u.searchParams.set("wait", "scheduled");',
     "",
     API, "programada con bots públicos"),
    ("A15 el reinicio no revalida el destino", ROUTES,
     "    const info = await emittableTarget(t);\n    const body = {",
     "    const info = { kind: t.kind, status: \"running\" };\n    const body = {",
     API, "RESTART_REVALIDATES"),
    ("D11 programada no visible ⇒ error (sin espera)", DIRECTOR,
     "          !this.lastSeenBattle &&\n          this.opts.waitScheduled &&",
     "          false &&\n          this.opts.waitScheduled &&",
     DIR, "programada aún no visible"),
    ("D12 espera de programada sin tope", DIRECTOR,
     "(this.opts.maxScheduledWaitMs ?? 30 * 60_000)",
     "Infinity",
     DIR, "la espera tiene tope"),
    ("D13 la marca de espera vale para cualquier destino", "apps/web/src/broadcast/config.ts",
     '  const waitScheduled = target?.kind === "battle" && q.get("wait") === "scheduled";',
     '  const waitScheduled = q.get("wait") === "scheduled";',
     DIR, "sólo cuenta para una batalla"),
    # ── Director: estados terminales y SOURCE_ERROR ──────────────────────────────────
    ("D1 torneo cerrado + lista vacía ⇒ espera (bug original)", DIRECTOR,
     '  if (closed && screen.kind !== "live") {',
     "  if (false) {",
     DIR, "lista vacía (replays públicos apagados)"),
    ("D2 cancelado como terminado", DIRECTOR,
     '    return state === "cancelled"\n      ? { kind: "cancelled", lastBattle, progress }',
     '    return false\n      ? { kind: "cancelled", lastBattle, progress }',
     DIR, "torneo cancelado"),
    ("D3 catch vacío (se traga todos los fallos)", DIRECTOR,
     "      if (!c.permanent && this.failures < (this.opts.maxTransientFailures ?? 3)) return;",
     "      return;",
     DIR, "N fallos transitorios"),
    ("D4 sin reintentos: todo fallo es error inmediato", DIRECTOR,
     "      if (!c.permanent && this.failures < (this.opts.maxTransientFailures ?? 3)) return;",
     "",
     DIR, "fallo transitorio seguido de éxito"),
    ("D5 el éxito no reinicia el contador", DIRECTOR,
     "      screen = await this.computeScreen();\n      this.failures = 0;",
     "      screen = await this.computeScreen();",
     DIR, "fallo transitorio seguido de éxito"),
    ("D6 JSON inválido tratado como transitorio", DIRECTOR,
     '    if (e.kind === "invalid_json") return { permanent: true, reason: "invalid_json", detail };',
     '    if (e.kind === "invalid_json") return { permanent: false, reason: "unreachable", detail };',
     DIR, "JSON inválido"),
    ("D7 sin validación de forma", DIRECTOR,
     '      if (!validBattle(b)) throw invalidPayload("/battles/{id}");',
     "",
     DIR, "JSON con otra forma"),
    ("D8 404 del destino tratado como transitorio", DIRECTOR,
     '      if (e.status === 404) return { permanent: true, reason: "target_not_found", detail };',
     '      if (e.status === 404) return { permanent: false, reason: "unreachable", detail };',
     DIR, "404 del destino"),
    ("D9 torneo abierto tomado por cerrado", DIRECTOR,
     "  const closed = state !== null && CLOSED_TOURNAMENT_STATES.has(state);",
     '  const closed = state !== "running";',
     DIR, "WAITING_VALID"),
    ("D10 batalla que deja de ser legible ⇒ error", DIRECTOR,
     "        if (this.lastSeenBattle && e instanceof PublicApiError && e.kind === \"http\" && e.status === 404) {",
     "        if (false) {",
     DIR, "deja de ser legible"),
    # ── Admin y página pública ───────────────────────────────────────────────────────
    ("W1 INICIAR se fía del listado y no del destino", SPAGE,
     "    dest && destInfo && destInfo.broadcastAvailable !== undefined",
     "    false && dest && destInfo && destInfo.broadcastAvailable !== undefined",
     ADM, "torneo terminado sin replays públicos"),
    ("W2 motivo crudo en vez de humano", SPAGE,
     '          {broadcastReasonText(t.reason) || "La página pública no puede mostrar este destino."}',
     "          {t.reason}",
     ADM, "torneo terminado sin replays públicos"),
    ("W3 batalla suelta sin decirlo", SPAGE,
     '  if (t.targetType === "standalone_battle") return `Batalla suelta ${t.label} (${st}; no pertenece a ningún torneo)`;',
     "",
     ADM, "batalla suelta"),
    ("W4 en directo no dice qué se emite", SPAGE,
     '      {targetInfo && <TargetSummary target={targetInfo} prefix="Emitiendo: " testId="live-target" />}',
     "",
     ADM, "sesión sobre el torneo"),
    ("W5 humanReason con códigos crudos", SPAGE,
     "    case \"target_not_found\":\n      return broadcastReasonText(code);",
     "    case \"target_not_found\":\n      return `HTTP 409 ${code}`;",
     ADM, "lenguaje humano"),
    ("W6 estado del director no reportable", BPAGE,
     "      data-director-state={config.target ? directorStateOf(screen) : undefined}",
     "      data-director-state={undefined}",
     ADM, "Torneo terminado"),
    ("W7 error de la fuente pintado como espera", BPAGE,
     '      ) : screen === null || screen.kind === "waiting" ? (',
     '      ) : screen === null || screen.kind === "waiting" || screen.kind === "error" ? (',
     ADM, "index.html"),
]


def sh(cmd, timeout=900):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True, timeout=timeout)


def run_test(test):
    r = sh(f"npx vitest run {test} 2>&1")
    out = r.stdout + r.stderr
    m = re.search(r"Tests\s+(?:\x1b\[[0-9;]*m)*\s*(.*)", out)
    return r.returncode, out


args = sys.argv[1:]
json_out = None
if "--json" in args:
    i = args.index("--json")
    json_out = args[i + 1]
    args = args[:i] + args[i + 2:]
only = args

if sh("git status --porcelain --untracked-files=no").stdout.strip():
    print("ÁRBOL SUCIO: commitea antes de calibrar (los mutantes reescriben ficheros)")
    sys.exit(2)

summary = {
    "head": sh("git rev-parse HEAD").stdout.strip(),
    "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "baseline": {},
    "mutants": [],
}
fails = 0
for test in (API, DIR, ADM):
    rc, out = run_test(test)
    ok = rc == 0 and re.search(r"\d+ failed", out) is None
    summary["baseline"][test] = {"rc": rc, "green": ok}
    print(f"BASE {test}: rc={rc} {'VERDE' if ok else 'ROJO'}", flush=True)
    if not ok:
        fails += 1

for name, path, old, new, test, frag in M:
    tag = name.split()[0]
    if only and tag not in only:
        continue
    p = os.path.join(ROOT, path)
    src = open(p).read()
    entry = {"id": tag, "name": name, "file": path, "test": test, "expect": frag}
    if src.count(old) != 1:
        entry.update(verdict="ANCLA_NO_UNICA", count=src.count(old))
        print(f"{name}: ANCLA NO ÚNICA ({src.count(old)}) -> MUTANTE INVÁLIDO", flush=True)
        fails += 1
        summary["mutants"].append(entry)
        continue
    open(p, "w").write(src.replace(old, new))
    try:
        rc, out = run_test(test)
        open(f"/tmp/fixbc-mut-{tag}.log", "w").write(out)
        red = rc != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE-MUTANTE-VIVO")
        if verdict != "ROJO-OK":
            fails += 1
        entry.update(rc=rc, verdict=verdict, failed=[re.sub(r"\x1b\[[0-9;]*m", "", l).strip() for l in failed_lines][:6])
        print(f"{name}: rc={rc} {verdict}", flush=True)
    finally:
        open(p, "w").write(src)
    summary["mutants"].append(entry)

d = sh("git status --porcelain --untracked-files=no").stdout.strip()
summary["tree_clean_after"] = not d
summary["calibration_failures"] = fails
summary["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN mutantes={len(summary['mutants'])} fallos_calibracion={fails}")
if json_out:
    with open(json_out, "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
sys.exit(1 if fails or d else 0)
