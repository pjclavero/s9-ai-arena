#!/usr/bin/env python3
"""ADM-3 · Calibración de los tests de usuarios y recuperación de cuentas.

Cada mutante debe poner en ROJO el test indicado (su nombre aparece en la salida de vitest). En SERIE, nunca en
paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al terminar). Si PRODGUARD_SCRIPT apunta a la
guardia de carga del entorno, espera a PRODGUARD_OK antes de cada ejecución. Siempre con prioridad baja y 1 worker.

Uso:
  python3 scripts/adm3-mutants.py [M1 M2 ...]   ejecuta (todos o los indicados)
  python3 scripts/adm3-mutants.py --check       sólo valida que cada ancla es única (no ejecuta nada)
  python3 scripts/adm3-mutants.py --baseline    ejecuta la línea base de cada fichero de test (debe estar en verde)
"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = "apps/api/src/adm3-users-recovery.test.ts"
T2 = "apps/api/src/adm3-review-fixes.test.ts"
ROPS = "apps/api/src/routes/admin-operations.ts"
MIG25 = "apps/api/src/db/migration-025.test.ts"
CLIT = "apps/api/src/db/reset-password-cli.test.ts"
WEBT = "apps/web/tests/adm3-users-page.test.tsx"
SVC = "apps/api/src/services/account-recovery.ts"
RU = "apps/api/src/routes/admin-users.ts"
AUTH = "apps/api/src/routes/auth.ts"
USERS = "apps/api/src/routes/users.ts"
SOPS = "apps/api/src/settings/admin-operations.ts"
OAPI = "apps/api/openapi.yaml"
MIGS = "apps/api/src/db/migrations.ts"
PWI = "apps/api/src/db/password-input.ts"
PAGE = "apps/web/src/pages/admin/UsersPage.tsx"
RESET = "apps/web/src/pages/ResetPasswordPage.tsx"
APP = "apps/web/src/App.tsx"
CONF = "apps/web/src/pages/admin/ConfirmDestructive.tsx"

# (nombre, [(fichero, ancla, sustituto), ...], test, fragmento del test que debe fallar)
M = [
    ("M1 listar usuarios con rol user",
     [(OAPI, "      x-min-role: admin\n      parameters:\n        - { name: q, in: query", "      x-min-role: user\n      parameters:\n        - { name: q, in: query")],
     T, "SOLO_ADMIN"),
    ("M2 bloquear con rol user",
     [(OAPI, "      x-min-role: admin\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminUserStatusChange' }",
      "      x-min-role: user\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminUserStatusChange' }")],
     T, "SOLO_ADMIN"),
    ("M3 emitir token con rol user",
     [(OAPI, "      x-min-role: admin\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminRecoveryTokenRequest' }",
      "      x-min-role: user\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminRecoveryTokenRequest' }")],
     T, "SOLO_ADMIN"),
    ("M4 el listado devuelve el hash de la contraseña",
     [(SVC, '      "u.display_name",\n      "u.status",', '      "u.display_name",\n      "u.password_hash",\n      "u.status",'),
      (SVC, "      id: r.id,\n      email: r.email,", "      id: r.id,\n      passwordHash: r.password_hash,\n      email: r.email,")],
     T, "LISTA_SIN_SECRETOS"),
    ("M5 el listado devuelve el secreto TOTP",
     [(SVC, '      "u.display_name",\n      "u.status",', '      "u.display_name",\n      "u.totp_secret",\n      "u.status",'),
      (SVC, "      id: r.id,\n      email: r.email,", "      id: r.id,\n      totpSecret: r.totp_secret,\n      email: r.email,")],
     T, "LISTA_SIN_SECRETOS"),
    ("M6 la búsqueda no escapa los comodines",
     [(SVC, "const EMAIL_ESCAPE = /[\\\\%_]/g;", "const EMAIL_ESCAPE = /[\\\\]/g;")],
     T, "LISTA_BUSQUEDA"),
    ("M7 la búsqueda por nombre distingue mayúsculas",
     [(SVC, 'b.whereRaw("lower(u.display_name) LIKE', 'b.whereRaw("u.display_name LIKE')],
     T, "LISTA_BUSQUEDA"),
    ("M8 sin tope de longitud de la búsqueda",
     [(SVC, "if (q.length > MAX_SEARCH_LENGTH) throw", "if (false) throw")],
     T, "LISTA_BUSQUEDA"),
    ("M9 la paginación ignora el cursor",
     [(SVC, '  query = applyCursor(query, cursor, "u.created_at", ["u.id"]);\n', "")],
     T, "LISTA_PAGINA"),
    ("M10 recoveryPending siempre falso",
     [(SVC, "recoveryPending: r.recovery_pending === true,", "recoveryPending: false,")],
     T, "LISTA_ESTADO"),
    ("M12 los admins bloqueados cuentan como activos",
     [(SVC, '    .where("u.status", "active")\n    .whereNot("u.id", exceptUserId)', '    .whereNot("u.id", exceptUserId)')],
     T, "ULTIMO_ADMIN_ROLES"),
    ("M13 bloquear al último admin permitido",
     [(SVC, "if (isAdmin && !(await otherActiveAdminExists(t, targetId))) {", "if (false) {")],
     T, "BLOQUEO_ULTIMO_ADMIN"),
    ("M14 un admin puede bloquearse a sí mismo",
     [(SVC, "if (targetId === ctx.actorId) {\n    throw forbidden(", "if (false) {\n    throw forbidden(")],
     T, "BLOQUEO_NO_A_UNO_MISMO"),
    ("M15 bloquear no cierra sesiones",
     [(SVC, "sessionsRevoked = await revokeAllSessions(t, targetId);", "sessionsRevoked = 0;")],
     T, "BLOQUEO_EFECTOS"),
    ("M16 bloquear no anula los tokens abiertos",
     [(SVC, "        const voided = await voidOpenResets(t, targetId);\n        await audit(t, {", "        const voided = 0;\n        await audit(t, {")],
     T, "BLOQUEO_EFECTOS"),
    ("M17 el bloqueo no se audita con su nombre",
     [(SVC, 'action: "admin.user.blocked",', 'action: "admin.user.sin_auditar",')],
     T, "BLOQUEO_EFECTOS"),
    ("M18 una cuenta bloqueada inicia sesión",
     [(AUTH, 'if (user.status === "blocked") {', "if (false) {")],
     T, "BLOQUEO_EFECTOS"),
    ("M19 una cuenta bloqueada refresca tokens",
     [(AUTH, 'if (!owner || owner.status !== "active") throw unauthorized(', "if (false) throw unauthorized(")],
     T, "REFRESH_BLOQUEADO"),
    ("M20 bloquear sin reautenticación",
     [(RU, 'defineOperation(router, "setUserStatus", async (req, res) => {\n    await reauth(req);', 'defineOperation(router, "setUserStatus", async (req, res) => {')],
     T, "BLOQUEO_REAUTH"),
    ("M21 emitir token sin reautenticación",
     [(RU, 'defineOperation(router, "issueUserRecoveryToken", async (req, res) => {\n    await reauth(req);', 'defineOperation(router, "issueUserRecoveryToken", async (req, res) => {')],
     T, "TOKEN_REAUTH"),
    ("M22 sin límite de acciones por admin",
     [(RU, "if (!(await deps.actionLimiter.hit(", "if (false && !(await deps.actionLimiter.hit(")],
     T, "LIMITE_ACCIONES"),
    ("M23 el límite de acciones es global y no por admin",
     [(RU, "admin-users:${req.auth!.userId}", "admin-users:todos")],
     T, "LIMITE_ACCIONES"),
    ("M24 el token se guarda en claro",
     [(SVC, "token_hash: hashToken(token),", "token_hash: token,")],
     T, "TOKEN_EMISION"),
    ("M25 el token dura un día",
     [(SVC, "export const RECOVERY_TTL_MS = 30 * 60_000;", "export const RECOVERY_TTL_MS = 24 * 60 * 60_000;")],
     T, "TOKEN_EMISION"),
    ("M26 emitir no anula los tokens anteriores",
     [(SVC, "      const voided = await voidOpenResets(t, targetId);\n      const token = await createPasswordReset", "      const voided = 0;\n      const token = await createPasswordReset")],
     T, "TOKEN_REVOCA_ANTERIORES"),
    ("M27 el token va a la auditoría",
     [(SVC, "          secondAdminOperation: operationId,\n        },", "          secondAdminOperation: operationId,\n          token,\n        },")],
     T, "TOKEN_EMISION"),
    ("M28 se emite token a una cuenta bloqueada",
     [(SVC, '      if (user.status !== "active") {\n        throw conflict("account_blocked"', '      if (false) {\n        throw conflict("account_blocked"')],
     T, "TOKEN_CASOS"),
    ("M29 se emite token para la propia cuenta",
     [(SVC, "if (targetId === ctx.actorId) {\n    throw badRequest(", "if (false) {\n    throw badRequest(")],
     T, "TOKEN_CASOS"),
    ("M30 el token se puede canjear más de una vez",
     [(SVC, '        .where({ token_hash: hash })\n        .whereNull("used_at")', "        .where({ token_hash: hash })")],
     T, "TOKEN_UN_SOLO_USO"),
    ("M31 el canje ignora la caducidad",
     [(SVC, '        .where("expires_at", ">", t.fn.now())\n        .update({ used_at: t.fn.now() })', "        .update({ used_at: t.fn.now() })")],
     T, "TOKEN_CADUCA"),
    ("M32 el canje no cierra las sesiones",
     [(SVC, "      const sessionsRevoked = await revokeAllSessions(t, user.id);\n      const voided = await voidOpenResets(t, user.id);\n      // La recuperación", "      const sessionsRevoked = 0;\n      const voided = await voidOpenResets(t, user.id);\n      // La recuperación")],
     T, "CANJE_REVOCA_SESIONES"),
    ("M33 el canje no aplica la política de contraseñas",
     [(SVC, "if (violation) throw badRequest(violation);\n  const passwordHash", "if (false) throw badRequest(violation);\n  const passwordHash")],
     T, "POLITICA_CONTRASENAS"),
    ("M34 el canje consume el token de una cuenta bloqueada",
     [(SVC, 'if (!user || user.status !== "active") throw unauthorized(INVALID_TOKEN);', "if (!user) throw unauthorized(INVALID_TOKEN);")],
     T, "NO_ENUMERACION"),
    ("M35 vuelve POST /auth/recover",
     [(AUTH, "  return router;\n}\n\n// Compatibilidad",
       '  defineExtension(\n    router,\n    { operationId: "recoverAccount", method: "post", path: "/auth/recover", minRole: "visitor" },\n    async (_req, res) => {\n      res.status(202).json({ status: "accepted" });\n    },\n  );\n\n  return router;\n}\n\n// Compatibilidad')],
     T, "RECOVER_RETIRADO"),
    ("M36 el canje sin límite de intentos",
     [(AUTH, '    rateLimit(resetLimiter, "reset"),\n  );', "  );")],
     T, "RATE_LIMIT_RESET"),
    ("M37 la cuenta admin no exige segundo admin",
     [(SVC, "      if (targetIsAdmin)\n        operationId", "      if (false)\n        operationId")],
     T, "ADMIN_EXIGE_SEGUNDO"),
    ("M38 la aprobación del segundo admin no se gasta",
     [(SVC, '  await trx("admin_operations")\n    .where({ id: op.id, status: "pending" })\n    .update({', '  await trx("admin_operations")\n    .where({ id: op.id, status: "pending" })\n    .whereRaw("false")\n    .update({')],
     T, "ADMIN_SEGUNDO_FLUJO"),
    ("M39 la aprobación sirve a quien no la solicitó",
     [(SVC, "if (op.requested_by !== ctx.actorId) throw invalid(", "if (false) throw invalid(")],
     T, "ADMIN_SEGUNDO_FLUJO"),
    ("M40 la aprobación sirve para otra cuenta",
     [(SVC, "if (params.userId !== targetId) throw invalid(", "if (false) throw invalid(")],
     T, "ADMIN_APROBACION_ATADA"),
    ("M41 la aprobación no caduca",
     [(SVC, "if (!op.confirmed_at || Date.now() - new Date(op.confirmed_at).getTime() > RECOVERY_APPROVAL_WINDOW_MS) {", "if (!op.confirmed_at) {")],
     T, "ADMIN_APROBACION_ATADA"),
    ("M42 una orden ya consumida vuelve a valer",
     [(SVC, '.where({ id: operationId, kind, status: "pending" })', '.where({ id: operationId, kind })')],
     T, "ADMIN_SEGUNDO_FLUJO"),
    ("M43 la recuperación admin no es irreversible",
     [(SOPS, 'classify: () => "irreversible",', 'classify: () => "destructive",')],
     T, "ADMIN_UNICO"),
    ("M44 la orden acepta una cuenta que no es admin",
     [(SOPS, "if (!admin) {\n      throw badRequest(", "if (false) {\n      throw badRequest(")],
     T, "OP_SOLO_CUENTAS_ADMIN"),
    ("M45 la orden admite parámetros extra",
     [(SOPS, 'for (const k of Object.keys(raw)) if (k !== "userId") return', "for (const k of Object.keys(raw)) if (false) return")],
     T, "OP_SOLO_CUENTAS_ADMIN"),
    ("M46 los admins bloqueados cuentan como segundo admin",
     [(SVC, '.where({ "r.role": "admin", "u.status": "active" })\n    .whereNotIn("u.id", [...excluded, ...lineage])', '.where({ "r.role": "admin" })\n    .whereNotIn("u.id", [...excluded, ...lineage])')],
     T2, "APROBADOR_BLOQUEADO_NO_CUENTA"),
    ("M47 la aprobación caducada ocupa el hueco para siempre",
     [(SOPS, "if (def.pendingTtlMs !== undefined) {", "if (false) {")],
     T, "ADMIN_APROBACION_CADUCADA_LIBERA"),
    ("M48 la emisión no es atómica con su auditoría",
     [(SVC, 'const out = await mapDeadlock(\n    db.transaction(async (trx) => {\n      const t = trx as unknown as Db;\n      const user = await t("users").where({ id: targetId }).forUpdate()',
       'const out = await mapDeadlock(\n    (async (trx: Db) => {\n      const t = trx;\n      const user = await t("users").where({ id: targetId }).forUpdate()'),
      (SVC, "      return { token, expiresAt, userId: targetId };\n    }),\n  );\n  return out;", "      return { token, expiresAt, userId: targetId };\n    })(db),\n  );\n  return out;")],
     T, "AUDITORIA_ATOMICA"),
    ("M49 la migración no admite el tipo nuevo",
     [(MIGS, "CHECK (kind IN ('system.noop','user.recovery_admin','user.revoke_admin','user.grant_admin','user.block_admin','user.unblock_admin'));\n      DROP INDEX admin_operations_one_active_per_kind;", "CHECK (kind IN ('system.noop','user.revoke_admin','user.grant_admin','user.block_admin','user.unblock_admin'));\n      DROP INDEX admin_operations_one_active_per_kind;")],
     MIG25, "MIG025_KIND_NUEVO"),
    ("M50 el down de la 025 deja las columnas de usuario",
     [(MIGS, "      ALTER TABLE users DROP COLUMN blocked_by, DROP COLUMN blocked_at, DROP COLUMN status;\n", "")],
     MIG25, "MIG025_VUELTA_ATRAS"),
    ("M51 el estado de cuenta no es coherente con blocked_at",
     [(MIGS, "CHECK ((status = 'blocked') = (blocked_at IS NOT NULL));", "CHECK (true);")],
     MIG25, "MIG025_ESTADO_COHERENTE"),
    ("M52 el hash del token no es único",
     [(MIGS, "CREATE UNIQUE INDEX password_resets_token_hash_uq", "CREATE INDEX password_resets_token_hash_uq")],
     MIG25, "MIG025_TOKEN_HASH_UNICO"),
    ("M53 la CLI no cierra las sesiones",
     [(SVC, "    const sessionsRevoked = await revokeAllSessions(t, user.id);\n    const voided = await voidOpenResets(t, user.id);\n    const admins", "    const sessionsRevoked = 0;\n    const voided = await voidOpenResets(t, user.id);\n    const admins")],
     T, "CLI_SERVICIO"),
    ("M54 la CLI no aplica la política de contraseñas",
     [(SVC, 'if (violation) throw new ResetPasswordCliError("invalid_input", violation);', 'if (false) throw new ResetPasswordCliError("invalid_input", violation);')],
     T, "CLI_SERVICIO"),
    ("M55 la CLI audita la contraseña",
     [(SVC, 'via: "cli",', 'via: "cli",\n        password: input.password,')],
     T, "CLI_SERVICIO"),
    ("M56 la CLI acepta la contraseña por argv",
     [(PWI, '  let file: string | null = null;\n  for (let i = 0; i < argv.length; i++) {\n    const a = argv[i];\n    if (a === "--password-stdin") stdin = true;\n    else if (a === "--password-file") {\n      const v = argv[++i];\n      if (!v) throw new PasswordInputError("--password-file requiere una ruta");\n      file = v;\n    } else if (/^--?password(=|$)/.test(a) || /^-p/.test(a)) {',
       '  let file: string | null = null;\n  for (let i = 0; i < argv.length; i++) {\n    const a = argv[i];\n    if (a === "--password-stdin") stdin = true;\n    else if (a === "--password-file") {\n      const v = argv[++i];\n      if (!v) throw new PasswordInputError("--password-file requiere una ruta");\n      file = v;\n    } else if (false) {')],
     T, "CLI_ARGV"),
    ("M57 la CLI no cierra las sesiones (proceso real)",
     [(SVC, "    const sessionsRevoked = await revokeAllSessions(t, user.id);\n    const voided = await voidOpenResets(t, user.id);\n    const admins", "    const sessionsRevoked = 0;\n    const voided = await voidOpenResets(t, user.id);\n    const admins")],
     CLIT, "CLI_PROCESO"),
    ("M58 la web no oculta el token al cerrarlo",
     [(PAGE, 'onClick={() => setIssued(null)}', "onClick={() => undefined}")],
     WEBT, "TOKEN_UNA_VEZ"),
    ("M59 la web ofrece acciones sobre uno mismo",
     [(PAGE, "const isMe = u.id === props.me.id;", "const isMe = false;")],
     WEBT, "SIN_ACCIONES_SOBRE_UNO_MISMO"),
    ("M60 la web emite el token de un admin sin segundo admin",
     [(PAGE, "setAction(isAdmin ? { kind: \"requestRecovery\", user: u } : { kind: \"token\", user: u })", "setAction({ kind: \"token\", user: u })")],
     WEBT, "ADMIN_PIDE_SEGUNDO"),
    ("M61 la web bloquea sin marcar reautenticación",
     [(PAGE, "{ status: a.to, ...reauth }, { reauth: true }", "{ status: a.to, ...reauth }")],
     WEBT, "BLOQUEAR_CONFIRMA"),
    ("M62 la web pide contraseña para los roles",
     [(PAGE, "askPassword: action.reauth,", "askPassword: true,")],
     WEBT, "ROLES_SIN_CONTRASENA"),
    ("M63 «Cargar más» sustituye en vez de añadir",
     [(PAGE, "setItems((cur) => [...cur, ...p.items]);", "setItems(p.items);")],
     WEBT, "CARGAR_MAS"),
    ("M64 la web ignora la frase del servidor al aprobar",
     [(PAGE, 'phrase: action.op.confirmPhrase ?? "",', 'phrase: "APROBAR",')],
     WEBT, "APROBAR"),
    ("M65 el solicitante ve «Aprobar» en su propia solicitud",
     [(PAGE, 'o.status === "awaiting_confirmation" && !mine && (', 'o.status === "awaiting_confirmation" && (')],
     WEBT, "APROBAR"),
    ("M66 la web emite sin operationId",
     [(PAGE, "{ ...reauth, operationId: a.op.id },", "{ ...reauth },")],
     WEBT, "EMITIR_ADMIN"),
    ("M67 la web no explica la vía local con un solo admin",
     [(PAGE, 'if (errorCode(e) !== "second_admin_unavailable") throw e;', "if (true) throw e;")],
     WEBT, "ADMIN_UNICO_CLI"),
    ("M68 la búsqueda no envía q",
     [(PAGE, 'if (query) qs.set("q", query);', "")],
     WEBT, "BUSCA"),
    ("M69 una cuenta bloqueada ofrece token de recuperación",
     [(PAGE, "{!isMe && u.status === \"active\" && (", "{!isMe && (")],
     WEBT, "DESBLOQUEAR"),
    ("M70 la web se traga el error del servidor",
     [(PAGE, '<FormError error={actionError} data-testid="users-error" />', "")],
     WEBT, "ERROR_DEL_SERVIDOR"),
    ("M71 el canje no valida la longitud en la web",
     [(RESET, "if (password.length < RESET_PASSWORD_MIN)\n    return", "if (false)\n    return")],
     WEBT, "RESET_VALIDACION"),
    ("M72 el canje no pide repetir la contraseña",
     [(RESET, "if (password !== repeat) return", "if (false) return")],
     WEBT, "RESET_VALIDACION"),
    ("M73 el canje envía el token sin recortar",
     [(RESET, "token: token.trim(),", "token,")],
     WEBT, "RESET_ENVIA"),
    ("M74 #/reset no es una ruta pública",
     [(APP, 'if (/^#\\/reset\\/?(?:\\?.*)?$/.test(route)) return { kind: "reset" };', 'if (false) return { kind: "reset" };')],
     WEBT, "RESET_RUTA_PUBLICA"),
    ("M75 la confirmación pide siempre contraseña (askPassword ignorado)",
     [(CONF, "const askPassword = props.askPassword !== false;", "const askPassword = true;")],
     WEBT, "ROLES_SIN_CONTRASENA"),
    # ---- Ronda 1 (revisión de #347)
    ("M76 el canje no revalida el rol de la cuenta",
     [(SVC, "if (isAdminNow && !reset.issued_via_operation) throw unauthorized(INVALID_TOKEN);", "if (false) throw unauthorized(INVALID_TOKEN);")],
     T2, "CANJE_REVALIDA_ROL"),
    ("M77 cambiar roles no anula los tokens abiertos",
     [(SVC, "        voided = await voidOpenResets(t, targetId);", "        voided = 0;")],
     T2, "ROLES_ANULA_TOKENS"),
    ("M79 quitar admin a otra cuenta sin segundo admin",
     [(SVC, "        if (targetId !== ctx.actorId) {\n          operationId = await requireSecondAdmin(\n            t,\n            ctx,\n            \"user.revoke_admin\"", "        if (false) {\n          operationId = await requireSecondAdmin(\n            t,\n            ctx,\n            \"user.revoke_admin\"")],
     T2, "BYPASS_DEGRADAR"),
    ("M80 conceder o quitar admin sin reautenticación",
     [("apps/api/src/routes/users.ts", "    if (reauthed) {", "    if (false) {")],
     T2, "ROLES_REAUTENTICACION"),
    ("M81 quitarse admin siendo el último permitido",
     [(SVC, "      if (plan.revokesAdmin) {\n        if (!(await otherActiveAdminExists(t, targetId))) {", "      if (plan.revokesAdmin) {\n        if (false) {")],
     T, "ULTIMO_ADMIN_ROLES"),
    ("M82 sin cerrojo del último admin (roles cruzados)",
     [(SVC, 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [LAST_ADMIN_LOCK_KEY]);', "return;")],
     T2, "CERROJO_ROLES"),
    ("M83 sin cerrojo del último admin (bloqueo cruzado)",
     [(SVC, 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [LAST_ADMIN_LOCK_KEY]);', "return;")],
     T2, "CERROJO_BLOQUEO"),
    ("M84 crear órdenes user.* sin reautenticación",
     [(ROPS, 'rest.kind.startsWith("user.")) await reauth(req, { password, totp });', 'rest.kind.startsWith("user.")) void 0;')],
     T2, "OP_USER_REAUTH"),
    ("M85 sin límite de acciones sobre órdenes user.*",
     [(ROPS, "if (!(await deps.actionLimiter.hit(", "if (false && !(await deps.actionLimiter.hit(")],
     T2, "OP_USER_LIMITE"),
    ("M86 cancelar órdenes ajenas sin reautenticación",
     [(ROPS, 'if (row && (String(row.kind).startsWith("user.") || row.requested_by !== req.auth!.userId)) {', "if (false) {")],
     T2, "CANCELAR_AJENA"),
    ("M87 la cancelación no distingue al solicitante en la auditoría",
     [(SOPS, "byRequester: row.requested_by === ctx.actorId", "byRequester: true")],
     T2, "CANCELAR_AJENA"),
    ("M88 una sola orden user.* activa por tipo (no por cuenta)",
     [(MIGS, "ON admin_operations (kind, (params->>'userId'))", "ON admin_operations (kind)")],
     T2, "UNICIDAD_POR_CUENTA"),
    ("M89 la migración no da unicidad por cuenta",
     [(MIGS, "ON admin_operations (kind, (params->>'userId'))", "ON admin_operations (kind)")],
     MIG25, "MIG025_UNICIDAD_POR_CUENTA"),
    ("M90 un interbloqueo sale como 500",
     [(SVC, 'if ((e as { code?: string }).code === "40P01") {', "if (false) {")],
     T2, "INTERBLOQUEO_409"),
    ("M91 la aprobación no revalida a quien aprobó",
     [(SVC, "if (!approver) throw invalid(", "if (false) throw invalid(")],
     T2, "APROBADOR_SIGUE_ADMIN"),
    ("M92 el objetivo cuenta como segundo admin",
     [(SOPS, "approverExcludes: (p) => [String(p.userId)],", "approverExcludes: () => [],")],
     T2, "OBJETIVO_NO_ES_SEGUNDO_ADMIN"),
    ("M93 el mensaje de política del canje es una copia fija",
     [(SVC, "if (violation) throw badRequest(violation);\n  const passwordHash = await hashPassword(newPassword as string);", 'if (violation) throw badRequest("token y newPassword (≥12) obligatorios");\n  const passwordHash = await hashPassword(newPassword as string);')],
     T2, "POLITICA_MENSAJE_DERIVADO"),
    ("M94 el down de la 025 no avisa en la auditoría",
     [(MIGS, "SELECT 'migration.025.down', 'users',", "SELECT 'migration.025.sin_aviso', 'users',")],
     MIG25, "MIG025_VUELTA_ATRAS"),
    ("M95 la web no pide TOTP al admin con 2FA",
     [(PAGE, "          needsTotp={props.me.twoFactorEnabled}\n", "")],
     WEBT, "NEEDS_TOTP"),
    ("M96 la web concede admin sin reautenticación",
     [(PAGE, "reauth: grants || revokes", "reauth: false")],
     WEBT, "CONCEDER_ADMIN_REAUTH"),
    ("M97 la web quita admin a otra cuenta directamente",
     [(PAGE, "revokes && !isMe", "false")],
     WEBT, "QUITAR_ADMIN_A_OTRO_PIDE_APROBACION"),
    ("M98 la web aplica el cambio sin operationId",
     [(PAGE, "{ roles, ...reauth, operationId: a.op.id }", "{ roles, ...reauth }")],
     WEBT, "APLICAR_QUITAR_ADMIN"),
    ("M99 la web cancela sin reautenticación",
     [(PAGE, "`/admin/operations/${a.op.id}/cancel`, reauth, { reauth: true }", "`/admin/operations/${a.op.id}/cancel`")],
     WEBT, "CANCELAR_CON_REAUTH"),
    ("M100 la web solicita órdenes user.* sin reautenticación",
     [(PAGE, "{ kind, params: { userId: user.id }, ...reauth }", "{ kind, params: { userId: user.id } }")],
     WEBT, "ADMIN_PIDE_SEGUNDO"),
    # ---- Ronda 2 (delta de la revisión de #347: admin títere)
    ("M101 conceder admin a otra cuenta sin aprobación aunque haya otro admin",
     [(SVC, 'if (await otherAdminExists(t, ctx.actorId ?? "")) {', "if (false) {")],
     T2, "TITERE_RECUPERACION"),
    ("M102 el bootstrap del segundo admin no queda auditado como tal",
     [(SVC, "          bootstrap = true;", "          bootstrap = false;")],
     T2, "GRANT_BOOTSTRAP"),
    ("M103 bloquear a otra cuenta admin sin aprobación",
     [(SVC, "        if (isAdmin) {\n          approval = await requireSecondAdmin(", "        if (false) {\n          approval = await requireSecondAdmin(")],
     T2, "CADENA_BLOQUEO"),
    ("M104 el objetivo aprueba su propia orden (confirmación)",
     [(SOPS, "if ((row.params as { userId?: string }).userId === ctx.actorId) {", "if (false) {")],
     T2, "OBJETIVO_NO_APRUEBA"),
    ("M107 el consumo admite al objetivo como aprobador",
     [(SVC, "if (approver.id === targetId) throw invalid(", "if (false) throw invalid(")],
     T2, "OBJETIVO_NO_CONSUME"),
    ("M109 no se recuerda quién concedió el rol admin",
     [(SVC, 'await t("admin_grant_edges").insert({ grantee: targetId, grantor: ctx.actorId }).onConflict().ignore();', "void 0;")],
     T2, "GRANT_BOOTSTRAP"),
    ("M110 user.revoke_admin autoriza cualquier conjunto de roles",
     [(SVC, "            !sameSet(\n              wanted,", "            false && !sameSet(\n              wanted,")],
     T2, "REVOCA_SOLO_QUITA_ADMIN"),
    ("M111 GET /admin/users/{id} con rol user",
     [(OAPI, "operationId: getAdminUser\n      summary: ADM-3 · Un usuario por id (misma proyección que el listado, con sus roles ACTUALES). Sin secretos.\n      x-min-role: admin", "operationId: getAdminUser\n      summary: ADM-3 · Un usuario por id (misma proyección que el listado, con sus roles ACTUALES). Sin secretos.\n      x-min-role: user")],
     T2, "GET_ADMIN_USER"),
    ("M112 el estado ignora el operationId de la aprobación",
     [(RU, "res.json(await setUserStatus(db, ctx(req), id, status, { operationId }));", "res.json(await setUserStatus(db, ctx(req), id, status));")],
     T2, "CADENA_BLOQUEO"),
    ("M113 la migración no admite el tipo user.block_admin",
     [(MIGS, "'user.grant_admin','user.block_admin','user.unblock_admin'));", "'user.grant_admin','user.unblock_admin'));")],
     MIG25, "MIG025_KIND_NUEVO"),
    ("M114 la web usa los roles de la página y no los reales del objetivo",
     [(PAGE, 'const fresh = await api<AdminUser>("GET", `/admin/users/${userId}`);', "const fresh = items.find((x) => x.id === userId) ?? { roles: [] as string[] };")],
     WEBT, "APLICAR_QUITAR_ADMIN"),
    ("M115 la web no solicita user.grant_admin cuando el servidor lo exige",
     [(PAGE, 'if (!(grantsOther && errorCode(e) === "second_admin_required")) throw e;', "throw e;")],
     WEBT, "CONCEDER_ADMIN_PIDE_APROBACION"),
    ("M116 la web no solicita user.block_admin cuando el servidor lo exige",
     [(PAGE, 'if (errorCode(e) !== "second_admin_required") throw e;', "throw e;")],
     WEBT, "BLOQUEAR_ADMIN_PIDE_APROBACION"),
    ("M117 la web bloquea al admin sin operationId",
     [(PAGE, 'operationId: a.op.id },\n            { reauth: true },\n          );\n          setNotice(`Cuenta', '},\n            { reauth: true },\n          );\n          setNotice(`Cuenta')],
     WEBT, "APLICAR_BLOQUEAR_ADMIN"),
    ("M118 la web no añade admin al conceder",
     [(PAGE, '? [...new Set([...fresh.roles, "admin"])]', "? fresh.roles")],
     WEBT, "APLICAR_CONCEDER_ADMIN"),
    # ---- Ronda 3 (delta 2: linaje de promoción, bootstrap, desbloqueo)
    ("M119 el linaje no incluye a los ancestros",
     [(SVC, "SELECT grantor FROM admin_grant_edges WHERE grantee = ?", "SELECT grantor FROM admin_grant_edges WHERE grantee = ? AND false")],
     T2, "LINAJE_CADENA_X_Y"),
    ("M120 el linaje no incluye a los descendientes",
     [(SVC, "SELECT grantee FROM admin_grant_edges WHERE grantor = ?\n", "SELECT grantee FROM admin_grant_edges WHERE grantor = ? AND false\n")],
     T2, "LINAJE_CADENA_X_Y"),
    ("M121 el linaje de ancestros no es transitivo",
     [(SVC, "SELECT e.grantor FROM admin_grant_edges e JOIN up ON e.grantee = up.id", "SELECT e.grantor FROM admin_grant_edges e JOIN up ON e.grantee = up.id WHERE false")],
     T2, "LINAJE_CADENA_X_Y"),
    ("M122 el linaje de descendientes no es transitivo",
     [(SVC, "SELECT e.grantee FROM admin_grant_edges e JOIN down d ON e.grantor = d.id", "SELECT e.grantee FROM admin_grant_edges e JOIN down d ON e.grantor = d.id WHERE false")],
     T2, "LINAJE_CADENA_X_Y"),
    ("M123 la confirmación no mira el linaje",
     [(SOPS, "if (row.requested_by && (await lineageIds(t, row.requested_by)).includes(ctx.actorId as string)) {", "if (false) {")],
     T2, "LINAJE_CADENA_X_Y"),
    ("M124 el consumo no mira el linaje",
     [(SVC, "if ((await lineageIds(trx, op.requested_by as string)).includes(approver.id as string)) {", "if (false) {")],
     T2, "LINAJE_NO_CONSUME"),
    ("M125 los aprobadores disponibles ignoran el linaje",
     [(SVC, "const lineage = requesterId ? await lineageIds(db, requesterId) : [];", "const lineage: string[] = [];")],
     T2, "LINAJE_SIN_APROBADOR"),
    ("M126 el bootstrap sólo cuenta los admins activos",
     [(SVC, 'if (await otherAdminExists(t, ctx.actorId ?? "")) {', 'if (await otherActiveAdminExists(t, ctx.actorId ?? "")) {')],
     T2, "BOOTSTRAP_SIN_OTROS_ADMINS"),
    ("M127 desbloquear a una cuenta admin sin aprobación",
     [(SVC, "        if (wasAdmin) {\n          approval = await requireSecondAdmin(", "        if (false) {\n          approval = await requireSecondAdmin(")],
     T2, "DESBLOQUEO_ADMIN"),
    ("M128 las aristas del linaje se pueden modificar o borrar (sin trigger)",
     [(MIGS, "      CREATE TRIGGER admin_grant_edges_append_only BEFORE UPDATE OR DELETE ON admin_grant_edges\n        FOR EACH ROW EXECUTE FUNCTION admin_grant_edges_append_only();\n", "")],
     T2, "ARISTAS_SOLO_INSERCION"),
    ("M132 una concesión posterior no añade su arista (el linaje se «blanquea»)",
     [(SVC, "if (plan.grantsAdmin && ctx.actorId) {", 'if (plan.grantsAdmin && ctx.actorId && !(await t("admin_grant_edges").where({ grantee: targetId }).first())) {')],
     T2, "LINAJE_ACUMULATIVO"),
    ("M133 sin índice del linaje por promotor",
     [(MIGS, "      CREATE INDEX admin_grant_edges_grantor_idx ON admin_grant_edges (grantor);\n", "")],
     MIG25, "MIG025_INDICE_LINAJE"),
    ("M129 la migración no admite user.unblock_admin",
     [(MIGS, "'user.block_admin','user.unblock_admin'));", "'user.block_admin'));")],
     MIG25, "MIG025_KIND_NUEVO"),
    ("M130 la web solicita bloquear al intentar desbloquear",
     [(PAGE, 'a.to === "blocked" ? BLOCK_KIND : UNBLOCK_KIND', "BLOCK_KIND")],
     WEBT, "DESBLOQUEAR_ADMIN_PIDE_APROBACION"),
    ("M131 la web aplica el desbloqueo como bloqueo",
     [(PAGE, 'status: a.op.kind === BLOCK_KIND ? "blocked" : "active"', 'status: "blocked"')],
     WEBT, "APLICAR_DESBLOQUEAR_ADMIN"),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def wait_prodguard():
    guard = os.environ.get("PRODGUARD_SCRIPT")
    if not guard:
        return True
    for _ in range(120):  # hasta 1 h
        if "PRODGUARD_OK" in sh(f"bash {guard}").stdout:
            return True
        time.sleep(30)
    return False


def check_anchors(edits):
    bad = []
    for path, old, _new in edits:
        src = open(os.path.join(ROOT, path)).read()
        if src.count(old) != 1:
            bad.append(f"{path}: ancla no única ({src.count(old)}): {old[:70]!r}")
    return bad


args = sys.argv[1:]
if args == ["--check"]:
    n = 0
    for name, edits, test, frag in M:
        bad = check_anchors(edits)
        for b in bad:
            print(f"{name}: {b}")
        n += len(bad)
    print(f"ANCLAS: {len(M)} mutantes, {n} anclas inválidas")
    sys.exit(1 if n else 0)

if args == ["--baseline"]:
    bad = 0
    for test in sorted({m[2] for m in M}):
        if not wait_prodguard():
            print("PRODGUARD no llegó a OK; se aborta")
            sys.exit(2)
        r = sh(f"timeout 900 nice -n 19 ionice -c3 npx vitest run --maxWorkers=1 {test} 2>&1")
        print(f"BASE {test}: rc={r.returncode}", flush=True)
        bad += r.returncode != 0
    sys.exit(1 if bad else 0)

only = args
fails = 0
for name, edits, test, frag in M:
    tag = name.split()[0]
    if only and tag not in only:
        continue
    bad = check_anchors(edits)
    if bad:
        print(f"{name}: MUTANTE INVÁLIDO {bad}", flush=True)
        fails += 1
        continue
    if not wait_prodguard():
        print(f"{name}: PRODGUARD no llegó a OK; se aborta", flush=True)
        sys.exit(2)
    originals = {}
    for path, _o, _n in edits:
        originals.setdefault(path, open(os.path.join(ROOT, path)).read())
    try:
        cur = dict(originals)
        for path, old, new in edits:
            cur[path] = cur[path].replace(old, new, 1)
        for path, src in cur.items():
            open(os.path.join(ROOT, path), "w").write(src)
        r = sh(f'timeout 900 nice -n 19 ionice -c3 npx vitest run --maxWorkers=1 {test} -t "{frag}" 2>&1')
        out = r.stdout + r.stderr
        open(f"/tmp/adm3-mut-{tag}.log", "w").write(out)
        red = r.returncode != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
        if verdict != "ROJO-OK":
            fails += 1
        print(f"{name}: rc={r.returncode} {verdict}", flush=True)
    finally:
        for path, src in originals.items():
            open(os.path.join(ROOT, path), "w").write(src)
d = sh("git status --porcelain --untracked-files=no").stdout.strip()
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN fallos_calibracion={fails}")
sys.exit(1 if fails else 0)
