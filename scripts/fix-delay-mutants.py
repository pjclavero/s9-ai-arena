#!/usr/bin/env python3
"""FIX-DELAY · Calibración de los tests del espectador con retardo anti-coaching.

Cada mutante rompe UNA garantía (latidos sin retardo, latido sin estado, watchdog
coherente, reanudación desde el buffer, rótulo de espera…) y debe poner en ROJO
el test indicado (fragmento de su nombre en la salida de vitest). Antes de los
mutantes se ejecuta la línea base (sin mutar): todos los ficheros en VERDE.

En serie, nunca en paralelo, y sobre un árbol COMMITEADO (cada mutante se
revierte al terminar; el script comprueba al final que el árbol queda limpio).
NUNCA en el orquestador ni en producción: en el laboratorio.

Uso: python3 scripts/fix-delay-mutants.py [--json salida.json] [G1 C3 ...]
"""
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GWT = "apps/api/src/spectate/fix-delay-heartbeat.test.ts"
DIT = "apps/api/src/spectate/delay-init.test.ts"
CLT = "apps/web/tests/fix-delay-watchdog.test.ts"
UIT = "apps/web/tests/fix-delay-broadcast.test.tsx"
E2E = "apps/web/tests/spectator.e2e.test.ts"
GW = "apps/api/src/spectate/gateway.ts"
CL = "apps/web/src/viewer/spectator-client.ts"
DW = "apps/web/src/viewer/delay-wait.ts"
BP = "apps/web/src/pages/BroadcastPage.tsx"

E30 = "apps/web/tests/fix-delay-30s.test.ts"

BEAT = (
    "      const beat = () => this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);\n"
    "      beat();\n"
    "      conn.heartbeat = setInterval(beat, this.heartbeatIntervalMs);"
)
HB_CALL = "heartbeatMessage(conn.delayMs), /*immediate*/ true);"

# (nombre, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
# Los dos mutantes OBLIGATORIOS del encargo: G1 (quitar el latido ⇒ reconexiones
# periódicas y sin primer snapshot) y G7 (snapshots antes de tiempo ⇒ el gate
# ANTI_COACHING_NOT_BYPASSED en rojo).
M = [
    # ── Gateway ──────────────────────────────────────────────────────────────────
    ("G1 sin latidos (el defecto de producción, escala 30 s)", GW, BEAT, "      void 0;",
     E30, "SPECTATOR_DELAY_HEARTBEAT"),
    ("G1w sin latidos ⇒ ws real", GW, BEAT, "      void 0;",
     GWT, "SPECTATOR_DELAY_HEARTBEAT"),
    ("G1e sin latidos ⇒ el E2E (API+BD+motor) reconecta", GW, BEAT, "      void 0;",
     E2E, "SPECTATOR_DELAY_HEARTBEAT"),
    ("G2 latidos diferidos como el stream", GW, HB_CALL,
     "heartbeatMessage(conn.delayMs), /*immediate*/ false);",
     E30, "SPECTATOR_DELAY_HEARTBEAT"),
    ("G3 el latido lleva el tick vivo (fuga)", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), tick: feed.battle.snapshots.at(-1)?.tick }, /*immediate*/ true);",
     GWT, "NO_STATE_LEAK_IN_HEARTBEAT"),
    ("G3b el latido lleva una marca de tiempo (canal lateral)", GW,
     '  return { type: "heartbeat", delayMs };',
     '  return { type: "heartbeat", delayMs, serverTimeMs: Date.now() };',
     GWT, "NO_STATE_LEAK_IN_HEARTBEAT"),
    ("G3c el latido revela cuánto hay retenido", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), pending: conn.timers.size }, /*immediate*/ true);",
     GWT, "NO_STATE_LEAK_IN_HEARTBEAT"),
    ("G4 latidos también sin retardo", GW,
     "    if (conn.delayMs > 0) {\n      const beat",
     "    if (true) {\n      const beat",
     E30, "DELAY_ZERO_REGRESSION"),
    ("G5 el init no anuncia delayMs", GW,
     "{ delayMs: conn.delayMs, heartbeatIntervalMs: this.heartbeatIntervalMs }",
     "{ heartbeatIntervalMs: this.heartbeatIntervalMs }",
     E30, "SPECTATOR_DELAY_HEARTBEAT"),
    ("G5b el init cambia también sin retardo", GW,
     "...(conn.delayMs > 0 ? { delayMs",
     "...(true ? { delayMs",
     E30, "DELAY_ZERO_REGRESSION"),
    ("G6 la reconexión reinicia el retardo (sin backlog del feed)", GW,
     "      backlog = [...feed.history];",
     "      backlog = [];",
     GWT, "reconectar NO reinicia"),
    ("G7 snapshots antes de tiempo (anti-coaching saltado)", GW,
     "    if (conn.delayMs > 0 && !immediate) {",
     "    if (false && conn.delayMs > 0 && !immediate) {",
     E30, "ANTI_COACHING_NOT_BYPASSED"),
    ("G7b snapshots con la mitad del retardo", GW,
     "      }, delayOverrideMs ?? conn.delayMs);",
     "      }, (delayOverrideMs ?? conn.delayMs) / 2);",
     E30, "ANTI_COACHING_NOT_BYPASSED"),
    ("G8 el latido no se apaga al cerrar", GW,
     "    if (conn.heartbeat) clearInterval(conn.heartbeat);\n    conn.heartbeat = null;",
     "",
     GWT, "se apaga su latido"),
    # ── Cliente (watchdog) ───────────────────────────────────────────────────────
    ("C1 los latidos no cuentan como actividad", CL,
     "      ws.onmessage = (ev: MessageEvent) => {\n        this.lastMessageAt = Date.now();",
     "      ws.onmessage = (ev: MessageEvent) => {\n        if (!String(ev.data).includes('\"type\":\"heartbeat\"')) this.lastMessageAt = Date.now();",
     E30, "WATCHDOG_WITH_DELAY"),
    ("C2 watchdog = retardo + margen (40 s)", CL,
     "        if (Date.now() - this.lastMessageAt > timeout) {",
     "        if (Date.now() - this.lastMessageAt > Math.max(timeout, (this.state.spectator?.delaySeconds ?? 0) * 1000 + 10_000)) {",
     E30, "gateway sin respuesta"),
    ("C3 watchdog ciego (nunca corta)", CL,
     "        if (Date.now() - this.lastMessageAt > timeout) {",
     "        if (false) {",
     CLT, "zombi real"),
    ("C4 el latido pisa serverTimeMs", CL,
     ' && msg.type !== "heartbeat") this.state.serverTimeMs = msg.serverTimeMs;',
     ") this.state.serverTimeMs = msg.serverTimeMs;",
     CLT, "no toca serverTimeMs"),
    # ── Pantallas ────────────────────────────────────────────────────────────────
    ("U1 sin rótulo de espera", BP,
     "          setDelayWait(delayedWaitText(msg.spectator, hasSnapshot));",
     "          setDelayWait(null);",
     UIT, "sin snapshot"),
    ("U2 el rótulo no se quita con el primer snapshot", BP,
     "            hasSnapshot = true;\n            setDelayWait(null);",
     "            hasSnapshot = true;",
     UIT, "sin snapshot"),
    ("U3 rótulo aunque el init ya traiga estado", BP,
     "          if (msg.snapshot) hasSnapshot = true;\n",
     "",
     UIT, "YA trae estado"),
    ("U4 rótulo también sin retardo", DW,
     "  if (ms <= 0) return null;\n  const s = Math.round",
     "  const s = Math.round",
     UIT, "sin retardo"),
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
needed = sorted({m[4] for m in M if not only or m[0].split()[0] in only} | {DIT})
for test in needed:
    rc, out = run_test(test)
    ok = rc == 0 and re.search(r"\d+ failed", out) is None
    summary["baseline"][test] = {"rc": rc, "green": ok}
    print(f"BASE {test}: rc={rc} {'VERDE' if ok else 'ROJO'}", flush=True)
    if not ok:
        fails += 1
        open("/tmp/fixdelay-base.log", "a").write(out)

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
        open(f"/tmp/fixdelay-mut-{tag}.log", "w").write(out)
        red = rc != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE-MUTANTE-VIVO")
        if verdict != "ROJO-OK":
            fails += 1
        entry.update(rc=rc, verdict=verdict,
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
