#!/usr/bin/env python3
"""ADM-1 · Calibración de los tests de ajustes del sistema y órdenes administrativas.

Cada mutante debe poner en ROJO el test indicado (fragmento de su nombre en la salida de
vitest). En SERIE, nunca en paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al
terminar). Si PRODGUARD_SCRIPT apunta a la guardia de carga del entorno, espera a PRODGUARD_OK antes de cada
ejecución. Siempre con prioridad baja y 1 worker.

Uso: python3 scripts/adm1-mutants.py [M1 M2 ...]
"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PURE = "packages/system-settings/registry.test.ts"
SET = "apps/api/src/settings/system-settings.test.ts"
OPS = "apps/api/src/settings/admin-operations.test.ts"
MIG = "apps/api/src/db/migration-023.test.ts"
WEB = "apps/web/tests/adm1-settings-page.test.tsx"
REG = "packages/system-settings/registry.ts"
RDR = "packages/system-settings/reader.ts"
SSET = "apps/api/src/settings/system-settings.ts"
SOPS = "apps/api/src/settings/admin-operations.ts"
CONS = "apps/api/src/settings/operations-consumer.ts"
ROUTE = "apps/api/src/routes/admin-operations.ts"
OAPI = "apps/api/openapi.yaml"
MIGS = "apps/api/src/db/migrations.ts"
PAGE = "apps/web/src/pages/admin/SettingsPage.tsx"
CONF = "apps/web/src/pages/admin/ConfirmDestructive.tsx"

# (nombre, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
M = [
    ("M1 lectura de ajustes con rol user", OAPI,
     "si el cambio `requiresRestart` del consumidor. Sin secretos.\n      x-min-role: admin",
     "si el cambio `requiresRestart` del consumidor. Sin secretos.\n      x-min-role: user",
     SET, "SOLO_ADMIN"),
    ("M2 crear órdenes con rol organizer", OAPI,
     "La API no ejecuta nada: la consume el servicio que posee el privilegio.\n      x-min-role: admin",
     "La API no ejecuta nada: la consume el servicio que posee el privilegio.\n      x-min-role: organizer",
     OPS, "NO_ADMIN_NO_CREA"),
    ("M3 sin validación de rango", REG,
     "      if (v < d.min! || v > d.max!) return",
     "      if (false) return",
     PURE, "RANGO_ENTERO"),
    ("M4 techo del entorno ignorado al escribir", REG,
     "  if (!r.ok) return r;\n  const ceil = envCeiling(d, env);\n  if (ceil !== null && typeof r.value === \"number\" && r.value > ceil) {\n    return { ok: false",
     "  if (!r.ok) return r;\n  const ceil = envCeiling(d, env);\n  if (false) {\n    return { ok: false",
     PURE, "TECHO_ENTORNO"),
    ("M5 tipo con coerción (acepta cadenas numéricas)", REG,
     'if (typeof v !== "number" || !Number.isFinite(v)) return',
     'if (typeof v === "string") v = Number(v) as never;\n      if (typeof v !== "number" || !Number.isFinite(v)) return',
     PURE, "TIPO_ESTRICTO"),
    ("M6 sin auditoría de ajustes", SSET,
     "      await audit(t, {\n        actorId: ctx.actorId,\n        action: SETTINGS_AUDIT_ACTION,",
     "      if (false) await audit(t, {\n        actorId: ctx.actorId,\n        action: SETTINGS_AUDIT_ACTION,",
     SET, "AUDITORIA"),
    ("M7 auditoría FUERA de la transacción", SSET,
     "      await audit(t, {\n        actorId: ctx.actorId,\n        action: SETTINGS_AUDIT_ACTION,",
     "      await audit(db, {\n        actorId: ctx.actorId,\n        action: SETTINGS_AUDIT_ACTION,",
     SET, "ATOMICO_BD"),
    ("M8 sin concurrencia optimista", SSET,
     "      if (currentVersion !== item.expectedVersion) {",
     "      if (false) {",
     SET, "VERSION_OPTIMISTA"),
    ("M9 clave no registrada aceptada", SSET,
     "    if (!d) {\n      errors.push",
     "    if (false) {\n      errors.push",
     SET, "RANGOS"),
    ("M10 campos extra del PATCH aceptados", SSET,
     'if (k !== "key" && k !== "value" && k !== "expectedVersion")\n        throw',
     "if (false)\n        throw",
     SET, "RANGOS"),
    ("M11 sin aviso de reinicio", SSET,
     "    pendingRestart: changed.filter((c) => c.requiresRestart).map((c) => c.key),",
     "    pendingRestart: [],",
     SET, "AVISO_REINICIO"),
    ("M12 lector sin ventana de staleness", RDR,
     "return this.lastGoodAt !== null && this.now() - this.lastGoodAt <= this.staleMs;",
     "return this.lastGoodAt !== null;",
     SET, "FAIL_CLOSED"),
    ("M13 lector sin sondeo periódico", RDR,
     "      this.timer = setInterval(() => void this.refresh(), this.refreshMs);",
     "      this.timer = setInterval(() => undefined, this.refreshMs);",
     SET, "SONDEO_PERIODICO"),
    ("M14 lector toma filas inválidas tal cual", REG,
     "  if (!r.ok) return { ...fallback(), invalid: true };",
     "  if (!r.ok) return { value: dbValue as never, source: \"database\", invalid: false };",
     SET, "FILA_INVALIDA"),
    ("M15 lector sin techo del entorno", REG,
     "  if (ceil !== null && typeof r.value === \"number\" && r.value > ceil) {\n    return { value: ceil, source: \"environment\", invalid: false };",
     "  if (false) {\n    return { value: ceil, source: \"environment\", invalid: false };",
     SET, "TECHO_EN_LECTOR"),
    ("M17 tipo de orden abierto", SOPS,
     'if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(OPERATION_KINDS, kind)) {',
     'if (typeof kind !== "string") {',
     OPS, "KIND_CERRADO"),
    ("M18 parámetros extra admitidos", SOPS,
     'for (const k of Object.keys(o)) if (k !== "impactClass") return',
     "for (const k of Object.keys(o)) if (false) return",
     OPS, "PARAMS_CERRADOS"),
    ("M19 CHECK de kind eliminado en BD", MIGS,
     "kind                text NOT NULL CHECK (kind IN ('system.noop')),",
     "kind                text NOT NULL,",
     OPS, "KIND_CHECK_EN_BD"),
    ("M20 sin límite de una activa por tipo", MIGS,
     "CREATE UNIQUE INDEX admin_operations_one_active_per_kind",
     "CREATE INDEX admin_operations_one_active_per_kind",
     OPS, "UNA_ACTIVA_POR_TIPO"),
    ("M21 destructiva sin confirmación", SOPS,
     'const needsConfirm = cls !== "none";',
     "const needsConfirm = false;",
     OPS, "IMPACTO_DEL_SERVIDOR"),
    ("M22 dryRun crea la orden", SOPS,
     "  if (b.dryRun === true) {",
     "  if (false) {",
     OPS, "IMPACTO_DEL_SERVIDOR"),
    ("M23 el token se confirma sin gastarse (reutilizable)", SOPS,
     '        status: "pending",\n        confirmed_by: ctx.actorId,\n        confirmed_at: t.fn.now(),\n        confirm_token_hash: null,\n        confirm_expires_at: null,',
     '        status: "awaiting_confirmation",\n        confirmed_by: ctx.actorId,\n        confirmed_at: t.fn.now(),',
     OPS, "TOKEN_UN_SOLO_USO"),
    ("M24 caducidad ignorada al confirmar", SOPS,
     "    if (!live) {",
     "    if (false) {",
     OPS, "TOKEN_CADUCADO"),
    ("M25 la caducada sigue ocupando el hueco", SOPS,
     '        .where("confirm_expires_at", "<=", t.fn.now())',
     "        .where(t.raw(\"false\"))",
     OPS, "CADUCADA_LIBERA_HUECO"),
    ("M26 frase literal no comprobada", SOPS,
     "    if (phrase.trim() !== row.confirm_phrase) throw",
     "    if (false) throw",
     OPS, "FRASE_LITERAL"),
    ("M27 sin reautenticación", ROUTE,
     "    await requireStrongReauth(db, user, { password: body.password, totp: body.totp });",
     "    void user;",
     OPS, "REAUTENTICACION"),
    ("M28 sin segundo admin", SOPS,
     "    if (row.requires_second_admin && row.requested_by === ctx.actorId) {",
     "    if (false) {",
     OPS, "SEGUNDO_ADMIN"),
    ("M29 irreversible aceptada con un solo admin", SOPS,
     "  if (requiresSecondAdmin && (await countAdmins(db)) < 2) {",
     "  if (false) {",
     OPS, "SEGUNDO_ADMIN_AUSENTE"),
    ("M30 el hash del token sale en la vista", SOPS,
     "    impact: r.impact,\n    confirmPhrase:",
     "    impact: r.impact,\n    confirmTokenHash: (r as unknown as { confirm_token_hash: string }).confirm_token_hash,\n    confirmPhrase:",
     OPS, "TOKEN_NO_FILTRADO"),
    ("M31 sin auditoría de la solicitud", SOPS,
     '      await audit(t, {\n        actorId: ctx.actorId,\n        action: OP_AUDIT("requested"),',
     '      if (false) await audit(t, {\n        actorId: ctx.actorId,\n        action: OP_AUDIT("requested"),',
     OPS, "ADMIN_CREA_Y_AUDITA"),
    ("M32 ejecutor completa sin ser dueño del lease", CONS,
     '    .where({ id, status: "running", lease_owner: owner })\n    .update({\n      status: "done"',
     '    .where({ id, status: "running" })\n    .update({\n      status: "done"',
     OPS, "LEASE_AJENO"),
    ("M33 el reaper recoge leases vivos", CONS,
     '    .where("lease_expires_at", "<=", db.fn.now())\n    .where("attempts", "<", opts.maxAttempts)',
     '    .where("attempts", "<", opts.maxAttempts)',
     OPS, "LEASE_VIGENTE_NO_SE_RECOGE"),
    ("M34 el reaper nunca da por fallida", CONS,
     '    .where("attempts", ">=", opts.maxAttempts)',
     '    .where("attempts", ">=", 9999)',
     OPS, "LEASE_CADUCADO"),
    ("M35 ejecutor sin tipos declarados", CONS,
     "  if (kinds.length === 0) throw new Error(",
     "  if (false) throw new Error(",
     OPS, "SOLO_SUS_TIPOS"),
    ("M36 resultado sin acotar", CONS,
     "return text.length > MAX_RESULT_BYTES ?",
     "return false ?",
     OPS, "RESULTADO_ACOTADO"),
    ("M37 rollback 023 deja la tabla de órdenes", MIGS,
     "DROP TABLE admin_operations; DROP TABLE system_settings;",
     "DROP TABLE system_settings;",
     MIG, "rollback por nombre"),
    ("M38 UI no distingue reinicio", PAGE,
     "          {s.requiresRestart ? (",
     "          {false ? (",
     WEB, "AVISA_REINICIO"),
    ("M39 UI guarda con versión fija", PAGE,
     "expectedVersion: s.version }],",
     "expectedVersion: 0 }],",
     WEB, "GUARDA_CON_VERSION"),
    ("M40 UI no avisa tras guardar", PAGE,
     "      {pendingRestart.length > 0 && (",
     "      {false && (",
     WEB, "AVISO_PENDIENTE_REINICIO"),
    ("M41 confirmación sin frase literal", CONF,
     "    phraseMatches(typed, props.phrase) && password.length > 0",
     "    password.length > 0",
     WEB, "FRASE_EXACTA_Y_CONTRASEÑA"),
    ("M42 confirmación sin contraseña", CONF,
     "    phraseMatches(typed, props.phrase) && password.length > 0 &&",
     "    phraseMatches(typed, props.phrase) && true &&",
     WEB, "FRASE_EXACTA_Y_CONTRASEÑA"),
    ("M43 confirmación sin TOTP exigido", CONF,
     "(!props.needsTotp || totp.trim().length > 0)",
     "true",
     WEB, "TOTP"),
    ("M44 confirmación sin aviso de segundo admin", CONF,
     "      {props.requiresSecondAdmin && (",
     "      {false && (",
     WEB, "SEGUNDO_ADMIN"),
    ("M45 frase sin distinguir mayúsculas", CONF,
     "return phrase.length > 0 && typed.trim() === phrase;",
     "return phrase.length > 0 && typed.trim().toLowerCase() === phrase.toLowerCase();",
     WEB, "phraseMatches"),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def wait_prodguard():
    guard = os.environ.get("PRODGUARD_SCRIPT")  # guardia de carga del entorno (opcional)
    if not guard:
        return True
    for _ in range(120):  # hasta 1 h
        if "PRODGUARD_OK" in sh(f"bash {guard}").stdout:
            return True
        time.sleep(30)
    return False


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
    if not wait_prodguard():
        print(f"{name}: PRODGUARD no llegó a OK; se aborta", flush=True)
        sys.exit(2)
    open(p, "w").write(src.replace(old, new))
    try:
        r = sh(f"timeout 900 nice -n 19 ionice -c3 npx vitest run --maxWorkers=1 {test} 2>&1")
        out = r.stdout + r.stderr
        open(f"/tmp/adm1-mut-{tag}.log", "w").write(out)
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
