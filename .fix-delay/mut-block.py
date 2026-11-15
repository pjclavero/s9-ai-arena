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
     "          delayMs: conn.delayMs,\n",
     "",
     E30, "SPECTATOR_DELAY_HEARTBEAT"),
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


