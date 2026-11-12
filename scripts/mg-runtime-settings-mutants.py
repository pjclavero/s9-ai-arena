#!/usr/bin/env python3
"""MG · Calibración de los tests de ajustes de runtime: cada mutante debe poner en ROJO
el test indicado (fragmento de su nombre en la salida de vitest). En serie, nunca en
paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al terminar).

Uso: python3 scripts/mg-runtime-settings-mutants.py [M1 M2 ...]
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "apps/api/src/mg-runtime-settings.test.ts"
RBAC = "apps/api/src/rbac-matrix.test.ts"
UI = "apps/web/tests/mg-public-access-settings.test.tsx"
SPAGE = "apps/web/tests/eq5b-streaming-page.test.tsx"

# (nombre, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
M = [
    ("M1 PATCH con rol user (RBAC)", "apps/api/openapi.yaml",
     "en ≤ `propagationMaxMs`.\n      x-min-role: admin\n      requestBody:",
     "en ≤ `propagationMaxMs`.\n      x-min-role: user\n      requestBody:",
     API, "anónimo ⇒ 401 y usuario normal ⇒ 403"),
    ("M2 booleanos no estrictos", "apps/api/src/runtime-settings.ts",
     'if (typeof o[k] !== "boolean") errors.push',
     'if (o[k] === undefined) errors.push',
     API, "cuerpo no estricto"),
    ("M3 sin auditoría", "apps/api/src/runtime-settings.ts",
     "        await audit(trx as unknown as Db, {",
     "        if (false) await audit(trx as unknown as Db, {",
     API, "queda auditado"),
    ("M4 flags congelados al arrancar (sin caliente)", "apps/api/src/app.ts",
     "  const visibility = runtimeSettings.getter;",
     "  const frozen = runtimeSettings.publicVisibility();\n  const visibility = () => frozen;",
     API, "PUBLIC_SPECTATE_TOGGLE"),
    ("M5 replays desde el entorno", "apps/api/src/routes/battles.ts",
     "  const replaysOn = flagSource(publicReplaysEnabled, () => publicReplaysEnabledFromEnv());",
     "  const replaysOn = () => publicReplaysEnabledFromEnv();",
     API, "PUBLIC_REPLAYS_TOGGLE"),
    ("M6 estado efectivo sin flags (copia optimista)", "apps/api/src/broadcast-effective.ts",
     "  const readable = await anonymousCanReadBattle(db, battleId, vis);",
     "  const readable = await anonymousCanReadBattle(db, battleId, { publicSpectate: true, publicReplays: true });",
     API, "SPECTATE=false ⇒ broadcastAvailable=false"),
    ("M7 publicBroadcastable vuelve a ser alias", "apps/api/src/services/streaming.ts",
     "      publicBroadcastable: eff.broadcastAvailable,",
     "      publicBroadcastable: pub,",
     API, "SPECTATE=false ⇒ broadcastAvailable=false"),
    ("M8 sin streamer no se avisa", "apps/api/src/routes/streaming.ts",
     "    if (deps.streamer.configured || !x.broadcastAvailable) return x;",
     "    return x;",
     API, "streaming_not_configured aunque"),
    ("M9 torneo siempre disponible", "apps/api/src/broadcast-effective.ts",
     '  return vis.publicSpectate ? out(true, null) : out(false, "public_spectate_disabled");\n}',
     '  return out(true, null);\n}',
     API, "torneo: en curso exige"),
    ("M10 el entorno pisa lo guardado al arrancar", "apps/api/src/runtime-settings.ts",
     '      .onConflict("id")\n      .ignore();',
     '      .onConflict("id")\n      .merge();',
     API, "persistencia tras reinicio"),
    ("M11 sin relectura periódica", "apps/api/src/runtime-settings.ts",
     "      this.timer = setInterval(() => void this.refresh(), this.refreshMs);",
     "      this.timer = setInterval(() => undefined, this.refreshMs);",
     API, "OTRO proceso"),
    ("M12 el worker crea la fila con su entorno", "apps/api/src/runtime-settings.ts",
     "      if (!row && this.bootstrap) {",
     "      if (!row) {",
     API, "el entorno es el bootstrap"),
    ("M13 gateway evalúa el flag una sola vez", "apps/api/src/spectate/gateway.ts",
     '    this.publicSpectateEnabled = typeof ps === "function" ? ps : () => ps;',
     '    const once = typeof ps === "function" ? ps() : ps;\n    this.publicSpectateEnabled = () => once;',
     API, "gateway del worker"),
    ("M14 la clave sale en logs", "apps/api/src/routes/streaming.ts",
     '  defineOperation(router, "setStreamingCredential", async (req, res) => {',
     '  defineOperation(router, "setStreamingCredential", async (req, res) => {\n    console.info(JSON.stringify(req.body));',
     API, "ni respuestas de la API"),
    ("M15 UI pinta lo pedido, no lo guardado", "apps/web/src/pages/PublicAccessSettings.tsx",
     '      setView(await api<PublicAccessSettingsView>("PATCH", "/admin/settings/public-access", { [key]: value }));',
     '      await api<PublicAccessSettingsView>("PATCH", "/admin/settings/public-access", { [key]: value });\n      setView((v) => (v ? { ...v, [key]: value } : v));',
     UI, "lo GUARDADO"),
    ("M16 UI siempre «disponible»", "apps/web/src/pages/PublicAccessSettings.tsx",
     "  const live = view?.effective.broadcastLiveAvailable ?? false;",
     "  const live = true;",
     UI, "espectador apagado"),
    ("M17 Streaming ignora el estado efectivo", "apps/web/src/pages/StreamingPage.tsx",
     '  return d.broadcastAvailable || d.reason === "battle_not_started";',
     "  return true;",
     SPAGE, "MG · autorizada pero /broadcast no puede leerla"),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


only = sys.argv[1:]
fails = 0
for name, path, old, new, test, frag in M:
    tag = name.split()[0]
    if only and tag not in only:
        continue
    p = os.path.join(ROOT, path)
    src = open(p).read()
    if src.count(old) != 1:
        print(f"{name}: ANCLA NO ÚNICA ({src.count(old)}) -> MUTANTE INVÁLIDO", flush=True)
        fails += 1
        continue
    open(p, "w").write(src.replace(old, new))
    try:
        r = sh(f"timeout 900 npx vitest run {test} 2>&1")
        out = r.stdout + r.stderr
        open(f"/tmp/mg-mut-{tag}.log", "w").write(out)
        red = r.returncode != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
        if verdict != "ROJO-OK":
            fails += 1
        print(f"{name}: rc={r.returncode} {verdict}", flush=True)
    finally:
        open(p, "w").write(src)
d = sh("git status --porcelain --untracked-files=no").stdout.strip()
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN fallos_calibracion={fails}")
sys.exit(1 if fails else 0)
