#!/usr/bin/env python3
"""FIX-DELAY · Calibración de los tests del espectador con retardo anti-coaching.

Cada mutante rompe UNA garantía (latidos sin retardo, latido sin estado, watchdog
coherente, reanudación desde el buffer, rótulo de espera…) y debe poner en ROJO
el test indicado (fragmento de su nombre en la salida de vitest). Antes de los
mutantes se ejecuta la línea base (sin mutar): todos los ficheros en VERDE.

En serie, nunca en paralelo, y sobre un árbol COMMITEADO (cada mutante se
revierte al terminar; el script comprueba al final que el árbol queda limpio).
NUNCA en el orquestador ni en producción: en el laboratorio.

Uso: python3 scripts/fix-delay-mutants.py [--json salida.json] [G1 C3 P1 ...]
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
BEAT_LINE = "      const beat = () => this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);"
HB_SEND = "this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true)"

# ── Constantes de REVIEW-282-DELTA3 (rev282d3-own.py), copiadas byte a byte ──────────
REV_S = "this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true)"
REV_A = "      const beat = () => " + REV_S + ";"
REV_BEAT = REV_A + "\n      beat();\n      conn.heartbeat = setInterval(beat, this.heartbeatIntervalMs);"
REV_SEND = "      const send = () => " + REV_S + ";\n"
REV_FR = "(feed.finished && conn.timers.size > 0)"
REV_FIN = "      feed.finished = true;\n"
REV_PAY = "    const payload = JSON.stringify({ v: 1, id: randomUUID(), ...msg });"


def rev_chain(cond, extra):
    return ("      const beat = () => " + REV_S + ";\n"
            "      const loop = () => { beat(); conn.heartbeat = setTimeout(loop, this.heartbeatIntervalMs + (" + cond + " ? " + str(extra) + " : 0)) as any; };\n"
            "      loop();")


# id v4 con Math.random cuya variante codifica si hay retenidos (I4 del revisor).
REV_I4_ID = ("(n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(\"\")")

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
    # ── Canales laterales del latido (P2-1 de REVIEW-282; mutantes P1-P4 del revisor)
    # El sobre de sendTo es {v, id: randomUUID(), ...msg}: un `id` en el mensaje lo pisa.
    ("P1 el id del latido = cuántos mensajes hay retenidos", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: conn.timers.size }, /*immediate*/ true);",
     GWT, "NO_STATE_LEAK_IN_HEARTBEAT"),
    ("P2 sin latido si no hay nada retenido (batalla ociosa)", GW,
     "      const beat = () => this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);",
     "      const beat = () => conn.timers.size > 0 && this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("P3 el latido se apaga al terminar la batalla real (socket abierto)", GW,
     '      this.broadcast(feed, { type: "result", result: battle.getResult() });',
     '      this.broadcast(feed, { type: "result", result: battle.getResult() });\n'
     "      for (const c of feed.clients) {\n"
     "        if (c.heartbeat) clearInterval(c.heartbeat);\n"
     "        c.heartbeat = null;\n"
     "      }",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("P4 el id del latido es un número derivado de timers.size", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: 1_000_000 + conn.timers.size * 7919 }, /*immediate*/ true);",
     GWT, "NO_STATE_LEAK_IN_HEARTBEAT"),
    ("P4b el id tiene forma de UUID v4 pero deriva de timers.size", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: `00000000-0000-4000-8000-${String(conn.timers.size).padStart(12, \"0\")}` }, /*immediate*/ true);",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    # ── Residuo de REVIEW-282-DELTA (P2-2 cadencia, P3-1 id); mutantes R1-R5 del revisor
    ("R1 con retenidos se omite 1 de cada 3 latidos (cadencia ~150 ms)", GW, BEAT_LINE,
     "      let n = 0;\n"
     "      const beat = () => { if (conn.timers.size > 0 && ++n % 3 === 0) return; "
     "this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true); };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("R5 con retenidos, 1 latido extra cada 3 (cadencia ~75 ms)", GW, BEAT_LINE,
     "      let n = 0;\n"
     "      const beat = () => { this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true); "
     "if (conn.timers.size > 0 && ++n % 3 === 0) this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true); };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("R3 id UUID v4 aleatorio cuyos 12 últimos hex codifican timers.size", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: randomUUID().slice(0, 24) + "
     "conn.timers.size.toString(16).padStart(12, \"0\") }, /*immediate*/ true);",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("R4 id UUID v4 determinista por conexión (contador)", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: `00000000-0000-4000-8000-${((conn as any).hbn = "
     "((conn as any).hbn ?? 0) + 1).toString(16).padStart(12, \"0\")}` }, /*immediate*/ true);",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    # ── Residuo de REVIEW-282-DELTA2 (P2-3 tramo fin real no entregado, P3-3 desfase de
    # fase, P3-4 bits del id); mutantes S1-S5 e I1-I3 del revisor (rev282d2-own.py)
    ("S1 extra cada 5 con retenidos (N>3, control de la banda)", GW, BEAT_LINE,
     "      let n = 0;\n      const beat = () => { " + HB_SEND
     + "; if (conn.timers.size > 0 && ++n % 5 === 0) " + HB_SEND + "; };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("S2 desfase de fase de 30 ms solo con retenidos", GW, BEAT_LINE,
     "      const beat = () => { if (conn.timers.size > 0) setTimeout(() => " + HB_SEND
     + ", 30); else " + HB_SEND + "; };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("S3 tras finished, el latido se retrasa 30 ms", GW, BEAT_LINE,
     "      const beat = () => { if (feed.finished) setTimeout(() => " + HB_SEND
     + ", 30); else " + HB_SEND + "; };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("S4 ventana fin-real..entrega (finished && retenidos): cadencia doble", GW, BEAT_LINE,
     "      const beat = () => { " + HB_SEND
     + "; if (feed.finished && conn.timers.size > 0) setTimeout(() => " + HB_SEND + ", 50); };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("S5 ventana fin-real..entrega (finished && retenidos): se omite 1 de cada 2", GW, BEAT_LINE,
     "      let n = 0;\n      const beat = () => { if (feed.finished && conn.timers.size > 0 && ++n % 2 === 0) return; "
     + HB_SEND + "; };",
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("I1 id: grupo intermedio (2.o, 16 bits) = timers.size", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: ((u) => u.slice(0, 9) + (conn.timers.size & 0xffff)"
     ".toString(16).padStart(4, \"0\") + u.slice(13))(randomUUID()) }, /*immediate*/ true);",
     GWT, "HEARTBEAT_ID_STRUCTURE"),
    ("I2 id: nibble de variante codifica feed.finished (8 vivo / b terminado)", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: ((u) => u.slice(0, 19) + (feed.finished ? \"b\" : \"8\")"
     " + u.slice(20))(randomUUID()) }, /*immediate*/ true);",
     GWT, "HEARTBEAT_ID_STRUCTURE"),
    ("I3 id: prefijo aleatorio + contador por conexion en el ultimo grupo (unico)", GW, HB_CALL,
     "{ ...heartbeatMessage(conn.delayMs), id: randomUUID().slice(0, 24) + ((conn as any).hbn = "
     "((conn as any).hbn ?? 0) + 1).toString(16).padStart(12, \"0\") }, /*immediate*/ true);",
     GWT, "HEARTBEAT_ID_STRUCTURE"),
    # ── Residuo de REVIEW-282-DELTA3 (P2-4 periodo en el tramo oculto, P2-5 msg
    # reasignado en sendTo); mutantes del revisor (rev282d3-own.py), byte a byte.
    # Una entrada con lista de (ancla, sustituto) aplica todas las sustituciones.
    ("S2u S2 sin duplicar la llamada (desfase 30 ms con retenidos)", GW,
     [(REV_A, REV_SEND + "      const beat = () => { if (conn.timers.size > 0) setTimeout(send, 30); else send(); };")], None,
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("S4u S4 sin duplicar la llamada (cadencia doble en fin-real-no-entregado)", GW,
     [(REV_A, REV_SEND + "      const beat = () => { send(); if " + REV_FR + " setTimeout(send, 50); };")], None,
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("K5 periodo +15% (115 ms) solo en fin-real-no-entregado", GW,
     [(REV_BEAT, rev_chain(REV_FR, 15))], None,
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("K6 periodo +15% (115 ms) mientras haya retenidos", GW,
     [(REV_BEAT, rev_chain("conn.timers.size > 0", 15))], None,
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("K7 al ver el fin real se reinicia el intervalo del latido (sin latido extra)", GW, [
        (REV_BEAT, REV_A + "\n      beat();\n      conn.heartbeat = setInterval(beat, this.heartbeatIntervalMs);\n      (conn as any).restartHb = () => { if (conn.heartbeat) clearInterval(conn.heartbeat); conn.heartbeat = setInterval(beat, this.heartbeatIntervalMs); };"),
        (REV_FIN, REV_FIN + "      for (const c of feed.clients) (c as any).restartHb?.();\n")], None,
     GWT, "HEARTBEAT_SIDE_CHANNELS"),
    ("I4 sendTo reasigna msg del latido con id v4 propio (Math.random) cuya variante codifica retenidos", GW,
     [(REV_PAY,
       "    if (msg.type === \"heartbeat\") { const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(\"\"); msg = { ...msg, id: h(8) + \"-\" + h(4) + \"-4\" + h(3) + \"-\" + (conn.timers.size > 0 ? \"b\" : \"8\") + h(3) + \"-\" + h(12) }; }\n" + REV_PAY)], None,
     GWT, "HEARTBEAT_PATH_STRUCTURE"),
    # ── Propios de FIX-DELAY-P2d: misma clase, intentan eludir HEARTBEAT_PATH_STRUCTURE
    ("X1 un solo setInterval cuyo periodo sale de una variable que cambia con el estado (115 ms en el tramo oculto)", GW,
     [(BEAT,
       "      const beat = () => this.sendTo(conn, heartbeatMessage(conn.delayMs), /*immediate*/ true);\n"
       "      beat();\n"
       "      let hbMs = this.heartbeatIntervalMs;\n"
       "      const arm = () => {\n"
       "        conn.heartbeat = setInterval(() => {\n"
       "          beat();\n"
       "          const want = feed.finished && conn.timers.size > 0 ? this.heartbeatIntervalMs + 15 : this.heartbeatIntervalMs;\n"
       "          if (want !== hbMs) { hbMs = want; if (conn.heartbeat) clearInterval(conn.heartbeat); arm(); }\n"
       "        }, hbMs);\n"
       "      };\n"
       "      arm();")], None,
     GWT, "HEARTBEAT_PATH_STRUCTURE"),
    ("X2 sendTo copia msg a otra variable y muta su id (variante = hay retenidos; sin el literal heartbeat)", GW,
     [(REV_PAY,
       "    const m = msg;\n"
       "    if (\"delayMs\" in m) { const h = " + REV_I4_ID + "; m.id = h(8) + \"-\" + h(4) + \"-4\" + h(3) + \"-\" + (conn.timers.size > 0 ? \"b\" : \"8\") + h(3) + \"-\" + h(12); }\n"
       + REV_PAY)], None,
     GWT, "HEARTBEAT_PATH_STRUCTURE"),
    ("X3 sendTo muta el id del latido por arguments[1] (sin nombrar msg ni el literal heartbeat)", GW,
     [(REV_PAY,
       "    if (\"delayMs\" in arguments[1]) { const h = " + REV_I4_ID + "; arguments[1].id = h(8) + \"-\" + h(4) + \"-4\" + h(3) + \"-\" + (conn.timers.size > 0 ? \"b\" : \"8\") + h(3) + \"-\" + h(12); }\n"
       + REV_PAY)], None,
     GWT, "HEARTBEAT_PATH_STRUCTURE"),
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
     "      setDelayWait(delayedWaitText(msg.spectator, hasSnapshot));",
     "      setDelayWait(null);",
     UIT, "sin snapshot"),
    ("U2 el rótulo no se quita con el primer snapshot", BP,
     "          hasSnapshot = true;\n          setDelayWait(null);",
     "          hasSnapshot = true;",
     UIT, "sin snapshot"),
    ("U3 rótulo aunque el init ya traiga estado", BP,
     "      if (msg.snapshot) hasSnapshot = true;\n",
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
    subs = old if isinstance(old, list) else [(old, new)]
    mutated, bad = src, None
    for o, n in subs:
        if mutated.count(o) != 1:
            bad = mutated.count(o)
            break
        mutated = mutated.replace(o, n)
    if bad is not None:
        entry.update(verdict="ANCLA_NO_UNICA", count=bad)
        print(f"{name}: ANCLA NO ÚNICA ({bad}) -> MUTANTE INVÁLIDO", flush=True)
        fails += 1
        summary["mutants"].append(entry)
        continue
    open(p, "w").write(mutated)
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
