#!/usr/bin/env python3
"""FIX-DIRECTOR-DELAY · Calibración de los tests de la línea temporal pública retrasada.

Cada mutante rompe UNA garantía (el director usa el fin real de una batalla o del torneo, el
cambio de batalla o la pantalla final se saltan el retardo, el retardo se ignora en una sola
transición, fuga de resultado, cableado de la página, retardo 0, latido de #282) y debe
poner en ROJO el test indicado (fragmento de su nombre en la salida de vitest). Antes de los
mutantes se ejecuta la línea base (sin mutar): todos los ficheros en VERDE.

En serie, nunca en paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al
terminar; el script comprueba al final que el árbol queda limpio). NUNCA en el orquestador
ni en producción: en el laboratorio.

Uso: python3 scripts/director-delay-mutants.py [--json salida.json] [M1 M2 ...]
"""
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UT = "apps/web/tests/director-delayed-timeline.test.ts"
E2E = "apps/web/tests/director-delayed-timeline.e2e.test.ts"
PG = "apps/web/tests/director-delayed-timeline-page.test.tsx"
DIR = "apps/web/src/broadcast/director.ts"
BP = "apps/web/src/pages/BroadcastPage.tsx"
GW = "apps/api/src/spectate/gateway.ts"

PLAYING = '      case "playing":\n        return "running";'
STATE = '  const state = closed && unresolved.length > 0 ? "running" : i.state;'
CHOOSE = "      screen = applyTournamentState(decideScreen(proj.battles, this.currentBattleId), proj.state);"
FEED = "    const feed = (id: string) => timeline.status(id);"
BATTLE_LIVE = '      else if (b?.status === "running") screen = { kind: "live", battle: b };'
BEAT = (
    "      const beat = () => this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);\n"
    "      beat();\n"
    "      conn.heartbeat = setInterval(beat, this.heartbeatIntervalMs);"
)


def feed_override(cond, phase):
    return ("    const feed = (id: string) => {\n"
            "      const st = timeline.status(id);\n"
            f"      return st && ({cond}) ? {{ ...st, phase: \"{phase}\" as const }} : st;\n"
            "    };")


# (nombre, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
M = [
    # ── Los cinco mutantes obligatorios del plan (A7) ────────────────────────────────
    ("M1 el director usa el fin de batalla en TIEMPO REAL", DIR, PLAYING,
     '      case "playing":\n        return real === "running" ? "running" : delayedEndOf(real);',
     UT, "DELAYED_BATTLE_END"),
    ("M1e fin de batalla en tiempo real ⇒ gateway real", DIR, PLAYING,
     '      case "playing":\n        return real === "running" ? "running" : delayedEndOf(real);',
     E2E, "DELAYED_BATTLE_END"),
    ("M2 el director usa el fin de TORNEO en tiempo real", DIR, STATE,
     "  const state = i.state;",
     UT, "DELAYED_TOURNAMENT_END"),
    ("M2e fin de torneo en tiempo real ⇒ gateway real", DIR, STATE,
     "  const state = i.state;",
     E2E, "DELAYED_TOURNAMENT_END"),
    ("M3 el cambio de batalla se salta el retardo (elige con la lista real)", DIR, CHOOSE,
     "      screen = applyTournamentState(decideScreen(real.battles, this.currentBattleId), proj.state);",
     UT, "DELAYED_BATTLE_TRANSITION"),
    ("M3e cambio de batalla con la lista real ⇒ gateway real", DIR, CHOOSE,
     "      screen = applyTournamentState(decideScreen(real.battles, this.currentBattleId), proj.state);",
     E2E, "DELAYED_BATTLE_TRANSITION"),
    ("M4 la pantalla final se salta el retardo (torneo cerrado en real)", DIR, CHOOSE,
     CHOOSE + '\n      if (real.state === "finished") screen = { kind: "finished", lastBattle: null };',
     UT, "DELAYED_TOURNAMENT_END"),
    ("M4b la pantalla final se salta el retardo (batalla suelta)", DIR, BATTLE_LIVE,
     '      else if (target.status === "finished") screen = { kind: "finished", lastBattle: target };\n' + BATTLE_LIVE,
     UT, "modo batalla suelta"),
    ("M5a retardo ignorado SÓLO en el inicio (primera batalla)", DIR, FEED,
     feed_override('st.phase === "pending" && !this.everLive', "playing"),
     UT, "DELAYED_BATTLE_START"),
    ("M5b retardo ignorado SÓLO en el paso intermedio → siguiente", DIR, FEED,
     feed_override('st.phase === "pending" && this.everLive', "playing"),
     UT, "DELAYED_BATTLE_TRANSITION"),
    ("M5c retardo ignorado SÓLO en el final de la última batalla", DIR, FEED,
     feed_override('st.phase === "playing" && real.kind === "tournament" && real.state === "finished"', "ended"),
     UT, "DELAYED_TOURNAMENT_END"),
    # ── A5 · anti-coaching: el directo retrasado no lleva el resultado real ───────────
    ("L1 la batalla en antena conserva el resultado real", DIR,
     "        result: undefined,\n        participants: b.participants.map(({ outcome: _outcome, ...rest }) => rest),\n",
     "",
     UT, "DIRECTOR_DOES_NOT_LEAK_REALTIME_STATE"),
    # ── Cableado: la página le da la línea temporal al director ─────────────────────
    ("P1 la página no pasa la línea temporal al director", BP,
     "      timeline: tl,\n", "",
     PG, "DELAYED_TOURNAMENT_END"),
    ("P2 LiveScreen ignora el feed del director", BP,
     "    if (!scene || !feed) return;", "    if (!scene || !feed || true) return;",
     PG, "DELAYED_TOURNAMENT_END"),
    # ── Retardo 0 ────────────────────────────────────────────────────────────────────
    ("Z1 con retardo 0 el feed no cuenta (nada sale en directo)", DIR, PLAYING,
     '      case "playing":\n        return feed.delayMs ? "running" : "hidden";',
     UT, "ZERO_DELAY_REGRESSION"),
    ("Z1e con retardo 0 el feed no cuenta ⇒ gateway real", DIR, PLAYING,
     '      case "playing":\n        return feed.delayMs ? "running" : "hidden";',
     E2E, "ZERO_DELAY_REGRESSION"),
    # ── #282 sigue vivo bajo el director nuevo ──────────────────────────────────────
    ("W1 sin latidos del gateway (el defecto de #282) ⇒ el director reconecta en bucle", GW, BEAT, "      void 0;",
     E2E, "WATCHDOG_REGRESSION"),
]


def sh(cmd, timeout=900):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True, timeout=timeout)


def run_test(test):
    r = sh(f"npx vitest run {test} 2>&1")
    return r.returncode, r.stdout + r.stderr


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
needed = sorted({m[4] for m in M if not only or m[0].split()[0] in only})
for test in needed:
    rc, out = run_test(test)
    ok = rc == 0 and re.search(r"\d+ failed", out) is None
    passed = re.search(r"Tests\s+(\d+) passed", out)
    summary["baseline"][test] = {"rc": rc, "green": ok, "passed": int(passed.group(1)) if passed else None}
    print(f"BASE {test}: rc={rc} {'VERDE' if ok else 'ROJO'} passed={passed.group(1) if passed else '?'}", flush=True)
    if not ok:
        fails += 1
        open("/tmp/dirdelay-base.log", "a").write(out)

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
        open(f"/tmp/dirdelay-mut-{tag}.log", "w").write(out)
        red = rc != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE-MUTANTE-VIVO")
        if verdict != "ROJO-OK":
            fails += 1
        # La aserción que lo mata (primer mensaje de error de vitest).
        assertion = next((re.sub(r"\x1b\[[0-9;]*m", "", l).strip() for l in out.splitlines()
                          if "AssertionError" in l or "Error:" in l), "")
        entry.update(rc=rc, verdict=verdict, assertion=assertion[:300],
                     failed=[re.sub(r"\x1b\[[0-9;]*m", "", l).strip() for l in failed_lines][:6])
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
