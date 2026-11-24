#!/usr/bin/env python3
"""ADM-3 · Calibración de los tests de usuarios y recuperación de cuentas.

Cada mutante debe poner en ROJO el test indicado (su nombre aparece en la salida de vitest). En SERIE, nunca en
paralelo, y sobre un árbol COMMITEADO (cada mutante se revierte al terminar). Si PRODGUARD_SCRIPT apunta a la
guardia de carga del entorno, espera a PRODGUARD_OK antes de cada ejecución. Siempre con prioridad baja y 1 worker.

Uso:
  python3 scripts/adm3-mutants.py [M1 M2 ...]   ejecuta (todos o los indicados)
  python3 scripts/adm3-mutants.py --check       valida que cada ancla es única y que el fragmento existe en el test
  python3 scripts/adm3-mutants.py --baseline    ejecuta la línea base de cada (test, filtro): ≥1 test en verde y 0 en rojo

Reglas del harness: (1) BASE: con el árbol sin tocar, el test filtrado por `-t` debe tener ≥1 test EN VERDE
(con vitest 4 un filtro que no casa da verde vacío: eso es un fallo de calibración); (2) MUTANTE: ≥1 test en ROJO y su
nombre contiene el fragmento.
"""
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = "apps/api/src/adm3-users-recovery.test.ts"
T2 = "apps/api/src/adm3-one-admin.test.ts"
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
    (
        'M1 listar usuarios con rol user',
        [
            (OAPI, '      x-min-role: admin\n      parameters:\n        - { name: q, in: query', '      x-min-role: user\n      parameters:\n        - { name: q, in: query'),
        ],
        T, 'SOLO_ADMIN',
    ),
    (
        'M2 bloquear con rol user',
        [
            (OAPI, "      x-min-role: admin\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminUserStatusChange' }", "      x-min-role: user\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminUserStatusChange' }"),
        ],
        T, 'SOLO_ADMIN',
    ),
    (
        'M3 emitir token con rol user',
        [
            (OAPI, "      x-min-role: admin\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminRecoveryTokenRequest' }", "      x-min-role: user\n      x-reauth: true\n      parameters: [{ $ref: '#/components/parameters/UserId' }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: '#/components/schemas/AdminRecoveryTokenRequest' }"),
        ],
        T, 'SOLO_ADMIN',
    ),
    (
        'M4 el listado devuelve el hash de la contraseña',
        [
            (SVC, '      "u.display_name",\n      "u.status",', '      "u.display_name",\n      "u.password_hash",\n      "u.status",'),
            (SVC, '      id: r.id,\n      email: r.email,', '      id: r.id,\n      passwordHash: r.password_hash,\n      email: r.email,'),
        ],
        T, 'LISTA_SIN_SECRETOS',
    ),
    (
        'M5 el listado devuelve el secreto TOTP',
        [
            (SVC, '      "u.display_name",\n      "u.status",', '      "u.display_name",\n      "u.totp_secret",\n      "u.status",'),
            (SVC, '      id: r.id,\n      email: r.email,', '      id: r.id,\n      totpSecret: r.totp_secret,\n      email: r.email,'),
        ],
        T, 'LISTA_SIN_SECRETOS',
    ),
    (
        'M6 la búsqueda no escapa los comodines',
        [
            (SVC, 'const EMAIL_ESCAPE = /[\\\\%_]/g;', 'const EMAIL_ESCAPE = /[\\\\]/g;'),
        ],
        T, 'LISTA_BUSQUEDA',
    ),
    (
        'M7 la búsqueda por nombre distingue mayúsculas',
        [
            (SVC, 'b.whereRaw("lower(u.display_name) LIKE', 'b.whereRaw("u.display_name LIKE'),
        ],
        T, 'LISTA_BUSQUEDA',
    ),
    (
        'M8 sin tope de longitud de la búsqueda',
        [
            (SVC, 'if (q.length > MAX_SEARCH_LENGTH) throw', 'if (false) throw'),
        ],
        T, 'LISTA_BUSQUEDA',
    ),
    (
        'M9 la paginación ignora el cursor',
        [
            (SVC, '  query = applyCursor(query, cursor, "u.created_at", ["u.id"]);\n', ''),
        ],
        T, 'LISTA_PAGINA',
    ),
    (
        'M10 recoveryPending siempre falso',
        [
            (SVC, 'recoveryPending: r.recovery_pending === true,', 'recoveryPending: false,'),
        ],
        T, 'LISTA_ESTADO',
    ),
    (
        'M12 los admins bloqueados cuentan como activos',
        [
            (SVC, '    .where("u.status", "active")\n    .whereNot("u.id", exceptUserId)', '    .whereNot("u.id", exceptUserId)'),
        ],
        T, 'ULTIMO_ADMIN_ROLES',
    ),
    (
        'M13 bloquear al último admin permitido',
        [
            (SVC, 'if (isAdmin && !(await otherActiveAdminExists(t, targetId))) {', 'if (false) {'),
        ],
        T, 'BLOQUEO_ULTIMO_ADMIN',
    ),
    (
        'M15 bloquear no cierra sesiones',
        [
            (SVC, 'sessionsRevoked = await revokeAllSessions(t, targetId);', 'sessionsRevoked = 0;'),
        ],
        T, 'BLOQUEO_EFECTOS',
    ),
    (
        'M17 el bloqueo no se audita con su nombre',
        [
            (SVC, 'action: "admin.user.blocked",', 'action: "admin.user.sin_auditar",'),
        ],
        T, 'BLOQUEO_EFECTOS',
    ),
    (
        'M18 una cuenta bloqueada inicia sesión',
        [
            (AUTH, 'if (user.status === "blocked") {', 'if (false) {'),
        ],
        T, 'BLOQUEO_EFECTOS',
    ),
    (
        'M19 una cuenta bloqueada refresca tokens',
        [
            (AUTH, 'if (!owner || owner.status !== "active") throw unauthorized(', 'if (false) throw unauthorized('),
        ],
        T, 'REFRESH_BLOQUEADO',
    ),
    (
        'M20 bloquear sin reautenticación',
        [
            (RU, 'defineOperation(router, "setUserStatus", async (req, res) => {\n    await reauth(req);', 'defineOperation(router, "setUserStatus", async (req, res) => {'),
        ],
        T, 'BLOQUEO_REAUTH',
    ),
    (
        'M21 emitir token sin reautenticación',
        [
            (RU, 'defineOperation(router, "issueUserRecoveryToken", async (req, res) => {\n    await reauth(req);', 'defineOperation(router, "issueUserRecoveryToken", async (req, res) => {'),
        ],
        T, 'TOKEN_REAUTH',
    ),
    (
        'M22 sin límite de acciones por admin',
        [
            (RU, 'if (!(await deps.actionLimiter.hit(', 'if (false && !(await deps.actionLimiter.hit('),
        ],
        T, 'LIMITE_ACCIONES',
    ),
    (
        'M23 el límite de acciones es global y no por admin',
        [
            (RU, 'admin-users:${req.auth!.userId}', 'admin-users:todos'),
        ],
        T, 'LIMITE_ACCIONES',
    ),
    (
        'M24 el token se guarda en claro',
        [
            (SVC, 'token_hash: hashToken(token),', 'token_hash: token,'),
        ],
        T, 'TOKEN_EMISION',
    ),
    (
        'M25 el token dura un día',
        [
            (SVC, 'export const RECOVERY_TTL_MS = 30 * 60_000;', 'export const RECOVERY_TTL_MS = 24 * 60 * 60_000;'),
        ],
        T, 'TOKEN_EMISION',
    ),
    (
        'M26 emitir no anula los tokens anteriores',
        [
            (SVC, '      const voided = await voidOpenResets(t, targetId);\n      const token = await createPasswordReset', '      const voided = 0;\n      const token = await createPasswordReset'),
        ],
        T, 'TOKEN_REVOCA_ANTERIORES',
    ),
    (
        'M28 se emite token a una cuenta bloqueada',
        [
            (SVC, '      if (user.status !== "active") {\n        throw conflict("account_blocked"', '      if (false) {\n        throw conflict("account_blocked"'),
        ],
        T, 'TOKEN_CASOS',
    ),
    (
        'M29 se emite token para la propia cuenta',
        [
            (SVC, 'if (targetId === ctx.actorId) {\n    throw badRequest(', 'if (false) {\n    throw badRequest('),
        ],
        T, 'TOKEN_CASOS',
    ),
    (
        'M30 el token se puede canjear más de una vez',
        [
            (SVC, '        .where({ token_hash: hash })\n        .whereNull("used_at")', '        .where({ token_hash: hash })'),
        ],
        T, 'TOKEN_UN_SOLO_USO',
    ),
    (
        'M31 el canje ignora la caducidad',
        [
            (SVC, '        .where("expires_at", ">", t.fn.now())\n        .update({ used_at: t.fn.now() })', '        .update({ used_at: t.fn.now() })'),
        ],
        T, 'TOKEN_CADUCA',
    ),
    (
        'M32 el canje no cierra las sesiones',
        [
            (SVC, '      const sessionsRevoked = await revokeAllSessions(t, user.id);\n      const voided = await voidOpenResets(t, user.id);\n      // La recuperación', '      const sessionsRevoked = 0;\n      const voided = await voidOpenResets(t, user.id);\n      // La recuperación'),
        ],
        T, 'CANJE_REVOCA_SESIONES',
    ),
    (
        'M33 el canje no aplica la política de contraseñas',
        [
            (SVC, 'if (violation) throw badRequest(violation);\n  const passwordHash', 'if (false) throw badRequest(violation);\n  const passwordHash'),
        ],
        T, 'POLITICA_CONTRASENAS',
    ),
    (
        'M34 el canje consume el token de una cuenta bloqueada',
        [
            (SVC, 'if (!user || user.status !== "active") throw unauthorized(INVALID_TOKEN);', 'if (!user) throw unauthorized(INVALID_TOKEN);'),
        ],
        T, 'NO_ENUMERACION',
    ),
    (
        'M35 vuelve POST /auth/recover',
        [
            (AUTH, '  return router;\n}\n\n// Compatibilidad', '  defineExtension(\n    router,\n    { operationId: "recoverAccount", method: "post", path: "/auth/recover", minRole: "visitor" },\n    async (_req, res) => {\n      res.status(202).json({ status: "accepted" });\n    },\n  );\n\n  return router;\n}\n\n// Compatibilidad'),
        ],
        T, 'RECOVER_RETIRADO',
    ),
    (
        'M36 el canje sin límite de intentos',
        [
            (AUTH, '    rateLimit(resetLimiter, "reset"),\n  );', '  );'),
        ],
        T, 'RATE_LIMIT_RESET',
    ),
    (
        'M48 la emisión no es atómica con su auditoría',
        [
            (SVC, 'const out = await mapDeadlock(\n    db.transaction(async (trx) => {\n      const t = trx as unknown as Db;\n      const user = await t("users").where({ id: targetId }).forUpdate()', 'const out = await mapDeadlock(\n    (async (trx: Db) => {\n      const t = trx;\n      const user = await t("users").where({ id: targetId }).forUpdate()'),
            (SVC, '      return { token, expiresAt, userId: targetId };\n    }),\n  );\n  return out;', '      return { token, expiresAt, userId: targetId };\n    })(db),\n  );\n  return out;'),
        ],
        T, 'AUDITORIA_ATOMICA',
    ),
    (
        'M50 el down de la 025 deja las columnas de usuario',
        [
            (MIGS, '      ALTER TABLE users DROP COLUMN blocked_by, DROP COLUMN blocked_at, DROP COLUMN status;\n', ''),
        ],
        MIG25, 'MIG025_VUELTA_ATRAS',
    ),
    (
        'M51 el estado de cuenta no es coherente con blocked_at',
        [
            (MIGS, "CHECK ((status = 'blocked') = (blocked_at IS NOT NULL));", 'CHECK (true);'),
        ],
        MIG25, 'MIG025_ESTADO_COHERENTE',
    ),
    (
        'M52 el hash del token no es único',
        [
            (MIGS, 'CREATE UNIQUE INDEX password_resets_token_hash_uq', 'CREATE INDEX password_resets_token_hash_uq'),
        ],
        MIG25, 'MIG025_TOKEN_HASH_UNICO',
    ),
    (
        'M53 la CLI no cierra las sesiones',
        [
            (SVC, '    const sessionsRevoked = await revokeAllSessions(t, user.id);\n    const voided = await voidOpenResets(t, user.id);\n    const admins', '    const sessionsRevoked = 0;\n    const voided = await voidOpenResets(t, user.id);\n    const admins'),
        ],
        T, 'CLI_SERVICIO',
    ),
    (
        'M54 la CLI no aplica la política de contraseñas',
        [
            (SVC, 'if (violation) throw new ResetPasswordCliError("invalid_input", violation);', 'if (false) throw new ResetPasswordCliError("invalid_input", violation);'),
        ],
        T, 'CLI_SERVICIO',
    ),
    (
        'M55 la CLI audita la contraseña',
        [
            (SVC, 'via: "cli",', 'via: "cli",\n        password: input.password,'),
        ],
        T, 'CLI_SERVICIO',
    ),
    (
        'M56 la CLI acepta la contraseña por argv',
        [
            (PWI, '  let file: string | null = null;\n  for (let i = 0; i < argv.length; i++) {\n    const a = argv[i];\n    if (a === "--password-stdin") stdin = true;\n    else if (a === "--password-file") {\n      const v = argv[++i];\n      if (!v) throw new PasswordInputError("--password-file requiere una ruta");\n      file = v;\n    } else if (/^--?password(=|$)/.test(a) || /^-p/.test(a)) {', '  let file: string | null = null;\n  for (let i = 0; i < argv.length; i++) {\n    const a = argv[i];\n    if (a === "--password-stdin") stdin = true;\n    else if (a === "--password-file") {\n      const v = argv[++i];\n      if (!v) throw new PasswordInputError("--password-file requiere una ruta");\n      file = v;\n    } else if (false) {'),
        ],
        T, 'CLI_ARGV',
    ),
    (
        'M57 la CLI no cierra las sesiones (proceso real)',
        [
            (SVC, '    const sessionsRevoked = await revokeAllSessions(t, user.id);\n    const voided = await voidOpenResets(t, user.id);\n    const admins', '    const sessionsRevoked = 0;\n    const voided = await voidOpenResets(t, user.id);\n    const admins'),
        ],
        CLIT, 'CLI_PROCESO',
    ),
    (
        'M58 la web no oculta el token al cerrarlo',
        [
            (PAGE, 'onClick={() => setIssued(null)}', 'onClick={() => undefined}'),
        ],
        WEBT, 'TOKEN_UNA_VEZ',
    ),
    (
        'M61 la web bloquea sin marcar reautenticación',
        [
            (PAGE, '{ status: a.to, ...reauth }, { reauth: true }', '{ status: a.to, ...reauth }'),
        ],
        WEBT, 'BLOQUEAR_CONFIRMA',
    ),
    (
        'M63 «Cargar más» sustituye en vez de añadir',
        [
            (PAGE, 'setItems((cur) => [...cur, ...p.items]);', 'setItems(p.items);'),
        ],
        WEBT, 'CARGAR_MAS',
    ),
    (
        'M68 la búsqueda no envía q',
        [
            (PAGE, 'if (query) qs.set("q", query);', ''),
        ],
        WEBT, 'BUSCA',
    ),
    (
        'M69 una cuenta bloqueada ofrece token de recuperación',
        [
            (PAGE, '{!isMe && u.status === "active" && (', '{!isMe && ('),
        ],
        WEBT, 'DESBLOQUEAR',
    ),
    (
        'M70 la web se traga el error del servidor',
        [
            (PAGE, '<FormError error={actionError} data-testid="users-error" />', ''),
        ],
        WEBT, 'ERROR_DEL_SERVIDOR',
    ),
    (
        'M71 el canje no valida la longitud en la web',
        [
            (RESET, 'if (password.length < RESET_PASSWORD_MIN)\n    return', 'if (false)\n    return'),
        ],
        WEBT, 'RESET_VALIDACION',
    ),
    (
        'M72 el canje no pide repetir la contraseña',
        [
            (RESET, 'if (password !== repeat) return', 'if (false) return'),
        ],
        WEBT, 'RESET_VALIDACION',
    ),
    (
        'M73 el canje envía el token sin recortar',
        [
            (RESET, 'token: token.trim(),', 'token,'),
        ],
        WEBT, 'RESET_ENVIA',
    ),
    (
        'M74 #/reset no es una ruta pública',
        [
            (APP, 'if (/^#\\/reset\\/?(?:\\?.*)?$/.test(route)) return { kind: "reset" };', 'if (false) return { kind: "reset" };'),
        ],
        WEBT, 'RESET_RUTA_PUBLICA',
    ),
    (
        'M77 cambiar roles no anula los tokens abiertos',
        [
            (SVC, '        voided = await voidOpenResets(t, targetId);', '        voided = 0;'),
        ],
        T2, 'ROLES_ANULA_TOKENS',
    ),
    (
        'M82 sin cerrojo del último admin (roles cruzados)',
        [
            (SVC, 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [LAST_ADMIN_LOCK_KEY]);', 'return;'),
        ],
        T2, 'CERROJO_ROLES',
    ),
    (
        'M83 sin cerrojo del último admin (bloqueo cruzado)',
        [
            (SVC, 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [LAST_ADMIN_LOCK_KEY]);', 'return;'),
        ],
        T2, 'CERROJO_BLOQUEO',
    ),
    (
        'M87 la cancelación no distingue al solicitante en la auditoría',
        [
            (SOPS, 'byRequester: row.requested_by === ctx.actorId', 'byRequester: true'),
        ],
        T2, 'CANCELAR_AJENA',
    ),
    (
        'M90 un interbloqueo sale como 500',
        [
            (SVC, 'if ((e as { code?: string }).code === "40P01") {', 'if (false) {'),
        ],
        T2, 'INTERBLOQUEO_409',
    ),
    (
        'M93 el mensaje de política del canje es una copia fija',
        [
            (SVC, 'if (violation) throw badRequest(violation);\n  const passwordHash = await hashPassword(newPassword as string);', 'if (violation) throw badRequest("token y newPassword (≥12) obligatorios");\n  const passwordHash = await hashPassword(newPassword as string);'),
        ],
        T2, 'POLITICA_MENSAJE_DERIVADO',
    ),
    (
        'M94 el down de la 025 no avisa en la auditoría',
        [
            (MIGS, "SELECT 'migration.025.down', 'users',", "SELECT 'migration.025.sin_aviso', 'users',"),
        ],
        MIG25, 'MIG025_VUELTA_ATRAS',
    ),
    (
        'M95 la web no pide TOTP al admin con 2FA',
        [
            (PAGE, '          needsTotp={props.me.twoFactorEnabled}\n', ''),
        ],
        WEBT, 'NEEDS_TOTP',
    ),
    (
        'M111 GET /admin/users/{id} con rol user',
        [
            (OAPI, 'operationId: getAdminUser\n      summary: ADM-3 · Un usuario por id (misma proyección que el listado, con sus roles ACTUALES). Sin secretos.\n      x-min-role: admin', 'operationId: getAdminUser\n      summary: ADM-3 · Un usuario por id (misma proyección que el listado, con sus roles ACTUALES). Sin secretos.\n      x-min-role: user'),
        ],
        T2, 'GET_ADMIN_USER',
    ),
    (
        'N1 conceder o quitar admin sin reautenticación',
        [
            ('apps/api/src/routes/users.ts', '    if (reauthed) {', '    if (false) {'),
        ],
        T2, 'REAUTH_CADA_OPERACION',
    ),
    (
        'N2 auto-bloqueo del último admin permitido',
        [
            (SVC, 'if (isAdmin && !(await otherActiveAdminExists(t, targetId))) {', 'if (false) {'),
        ],
        T2, 'ULTIMO_ADMIN:',
    ),
    (
        'N3 auto-degradación del último admin permitida',
        [
            (SVC, 'if (plan.revokesAdmin && !(await otherActiveAdminExists(t, targetId))) {', 'if (false) {'),
        ],
        T2, 'ULTIMO_ADMIN:',
    ),
    (
        'N4 el cambio de roles no se audita con su nombre',
        [
            (SVC, 'action: "admin.user.roles_set",', 'action: "admin.user.roles_x",'),
        ],
        T2, 'UN_ADMIN_TODO',
    ),
    (
        'N5 el desbloqueo no se audita con su nombre',
        [
            (SVC, 'action: "admin.user.unblocked",', 'action: "admin.user.unblocked_x",'),
        ],
        T2, 'UN_ADMIN_TODO',
    ),
    (
        'N6 el token de recuperación no se audita con su nombre',
        [
            (SVC, 'action: "admin.user.recovery_token_issued",', 'action: "admin.user.recovery_token_x",'),
        ],
        T2, 'UN_ADMIN_TODO',
    ),
    (
        'N7 desbloquear no anula los tokens abiertos',
        [
            (SVC, '        const voided = await voidOpenResets(t, targetId);\n        await audit(t, {\n          actorId: ctx.actorId,\n          action: "admin.user.unblocked",', '        const voided = 0;\n        await audit(t, {\n          actorId: ctx.actorId,\n          action: "admin.user.unblocked",'),
        ],
        T2, 'ESTADO_ANULA_TOKENS',
    ),
    (
        'N8 bloquear no anula los tokens abiertos',
        [
            (SVC, '        const voided = await voidOpenResets(t, targetId);\n        await audit(t, {\n          actorId: ctx.actorId,\n          action: "admin.user.blocked",', '        const voided = 0;\n        await audit(t, {\n          actorId: ctx.actorId,\n          action: "admin.user.blocked",'),
        ],
        T2, 'ESTADO_ANULA_TOKENS',
    ),
    (
        'N9 el token va a la auditoría',
        [
            (SVC, 'detail: { expiresInMinutes: RECOVERY_TTL_MS / 60_000, previousTokensVoided: voided },', 'detail: { expiresInMinutes: RECOVERY_TTL_MS / 60_000, previousTokensVoided: voided, token },'),
        ],
        T, 'TOKEN_EMISION',
    ),
    (
        'N10 la irreversible no lleva token de confirmación',
        [
            (SOPS, 'const token = needsConfirm ? randomBytes(32).toString("base64url") : null;', 'const token = needsConfirm && cls !== "irreversible" ? randomBytes(32).toString("base64url") : null;'),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'UN_ADMIN_IRREVERSIBLE',
    ),
    (
        'N11 confirmar sin token permitido',
        [
            (SOPS, 'if (!confirmToken) throw badRequest("confirmToken es obligatorio");', 'if (false) throw badRequest("confirmToken es obligatorio");'),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'CONFIRMA_SIN_TOKEN_NUNCA',
    ),
    (
        'N12 la irreversible vuelve a exigir un segundo admin al confirmar',
        [
            (SOPS, '    if (phrase.trim() !== row.confirm_phrase) throw badRequest(', '    if (row.requested_by === ctx.actorId) throw forbidden("segundo admin");\n    if (phrase.trim() !== row.confirm_phrase) throw badRequest('),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'UN_ADMIN_IRREVERSIBLE',
    ),
    (
        'N13 la irreversible se confirma sin frase',
        [
            (SOPS, 'if (phrase.trim() !== row.confirm_phrase) throw badRequest("La frase de confirmación no coincide");', 'if (false) throw badRequest("La frase de confirmación no coincide");'),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'IRREVERSIBLE_FRASE_Y_CADUCIDAD',
    ),
    (
        'N14 la API vuelve a anunciar requiresSecondAdmin',
        [
            (SOPS, '    confirmPhrase: r.status === "awaiting_confirmation" ? r.confirm_phrase : null,', '    confirmPhrase: r.status === "awaiting_confirmation" ? r.confirm_phrase : null,\n    requiresSecondAdmin: false,'),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'UN_ADMIN_IRREVERSIBLE',
    ),
    (
        'N15 system.noop también en producción',
        [
            (SOPS, 'if (env.NODE_ENV === "test") kinds', 'if (true) kinds'),
        ],
        'apps/api/src/settings/admin-operations.test.ts', 'NOOP_SOLO_EN_TESTS',
    ),
    (
        'N16 la guarda de la 025 vuelve a exigir segundo admin',
        [
            (MIGS, '          -- (modelo de un administrador: confirma el mismo admin que la pidió)\n', "          IF NEW.confirmed_by IS NOT DISTINCT FROM OLD.requested_by THEN\n            RAISE EXCEPTION 'admin_operations: segundo admin' USING ERRCODE = '23514';\n          END IF;\n"),
        ],
        MIG25, 'MIG025_MISMO_ADMIN_CONFIRMA_EN_BD',
    ),
    (
        'N17 la 025 no elimina la columna requires_second_admin',
        [
            (MIGS, '      ALTER TABLE admin_operations DROP COLUMN requires_second_admin;\n', ''),
        ],
        MIG25, 'MIG025_MISMO_ADMIN_CONFIRMA_EN_BD',
    ),
    (
        'N18 el down de la 025 no restaura la columna',
        [
            (MIGS, '      ALTER TABLE admin_operations ADD COLUMN requires_second_admin boolean NOT NULL DEFAULT false;\n', ''),
        ],
        MIG25, 'MIG025_VUELTA_ATRAS',
    ),
    (
        'N19 cancelar la orden de otro admin sin reautenticación',
        [
            (ROPS, 'if (row && row.requested_by !== req.auth!.userId) {', 'if (false) {'),
        ],
        T2, 'CANCELAR_AJENA',
    ),
    (
        'N20 el auto-bloqueo se prohíbe de nuevo',
        [
            (SVC, '  if (status !== "active" && status !== "blocked") throw badRequest("status debe ser active o blocked");\n', '  if (status !== "active" && status !== "blocked") throw badRequest("status debe ser active o blocked");\n  if (targetId === ctx.actorId) throw forbidden("no a uno mismo");\n'),
        ],
        T, 'AUTOBLOQUEO_PROTEGIDO',
    ),
    (
        'N21 el token de la cuenta de otro admin se rechaza',
        [
            (SVC, '      // Cualquier cuenta (también la de otro admin): lo hace UN admin reautenticado; queda en audit_log.\n', '      if (await t("user_roles").where({ user_id: targetId, role: "admin" }).first("user_id")) throw forbidden("segundo admin");\n'),
        ],
        T2, 'ADMIN_GESTIONA_ADMIN',
    ),
    (
        'N22 gestionar roles de otro admin se rechaza',
        [
            (SVC, '      const changed = !sameSet(before, wanted);\n', '      if (plan.revokesAdmin && targetId !== ctx.actorId) throw forbidden("segundo admin");\n      const changed = !sameSet(before, wanted);\n'),
        ],
        T2, 'ADMIN_GESTIONA_ADMIN',
    ),
    (
        'N23 dar admin a una cuenta nueva exige algo especial',
        [
            (SVC, '      const changed = !sameSet(before, wanted);\n', '      if (plan.grantsAdmin && (await t("user_roles").where({ role: "admin" }).first("user_id"))) throw forbidden("aprobación");\n      const changed = !sameSet(before, wanted);\n'),
        ],
        T2, 'SIN_BOOTSTRAP_NI_LINAJE',
    ),
    (
        'N24 la web usa los roles de la página y no los reales',
        [
            (PAGE, 'const fresh = await api<AdminUser>("GET", `/admin/users/${u.id}`);', 'const fresh = u;'),
        ],
        WEBT, 'ROLES_REALES_POR_ID',
    ),
    (
        'N25 la web concede admin sin reautenticación',
        [
            (PAGE, 'reauth: touchesAdmin });', 'reauth: false });'),
        ],
        WEBT, 'CONCEDER_ADMIN_REAUTH',
    ),
    (
        'N26 la web pide contraseña para roles que no tocan admin',
        [
            (PAGE, 'askPassword: touchesAdmin,', 'askPassword: true,'),
        ],
        WEBT, 'ROLES_REALES_POR_ID',
    ),
    (
        'N27 la web ofrece el token de recuperación sobre uno mismo',
        [
            (PAGE, 'const isMe = u.id === props.me.id;', 'const isMe = false;'),
        ],
        WEBT, 'PROPIA_FILA',
    ),
    (
        'N28 la web oculta el bloqueo a otro admin',
        [
            (PAGE, '                      onClick={() =>\n                        setAction({ kind: "status", user: u, to: u.status === "blocked" ? "active" : "blocked" })\n', '                      onClick={() => u.roles.includes("admin") ? undefined :\n                        setAction({ kind: "status", user: u, to: u.status === "blocked" ? "active" : "blocked" })\n'),
        ],
        WEBT, 'BLOQUEAR_ADMIN_DIRECTO',
    ),
    (
        'N29 la web oculta el token a otro admin',
        [
            (PAGE, '{!isMe && u.status === "active" && (', '{!isMe && u.status === "active" && !u.roles.includes("admin") && ('),
        ],
        WEBT, 'TOKEN_DE_ADMIN_DIRECTO',
    ),
    (
        'N30 la web pide a otro admin al desbloquear (texto)',
        [
            (PAGE, 'Nunca puede quedar 0 administradores activos."', 'Nunca puede quedar 0 administradores activos. Pide a otro administrador."'),
        ],
        WEBT, 'SIN_PEDIR_OTRO_ADMIN',
    ),
    (
        'N31 la guarda de la 025 no exige confirmación al pasar a pending',
        [(MIGS, "          IF OLD.confirmed_by IS NOT NULL OR NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL THEN\n            RAISE EXCEPTION 'admin_operations: awaiting_confirmation -> pending exige la confirmación de un admin' USING ERRCODE = '23514';\n          END IF;\n          -- (modelo", '          -- (modelo')],
        'apps/api/src/settings/admin-operations.test.ts', 'TRANSICIONES_EN_BD:',
    ),
    (
        'N32 la guarda de la 025 sin tabla de transiciones',
        [(MIGS, "        IF NOT (\n             (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('pending','expired','cancelled'))\n          OR (OLD.status = 'pending' AND NEW.status IN ('running','cancelled'))\n          OR (OLD.status = 'running' AND NEW.status IN ('done','failed','pending'))\n        ) THEN\n          RAISE EXCEPTION 'admin_operations: transición de estado no permitida (% -> %)', OLD.status, NEW.status USING ERRCODE = '23514';\n        END IF;\n\n        IF OLD.status = 'awaiting_confirmation' AND NEW.status = 'pending' THEN\n          IF OLD.confirmed_by IS NOT NULL OR NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL THEN\n            RAISE EXCEPTION 'admin_operations: awaiting_confirmation -> pending exige la confirmación de un admin' USING ERRCODE = '23514';\n          END IF;\n          -- (modelo", "        IF OLD.status = 'awaiting_confirmation' AND NEW.status = 'pending' THEN\n          IF OLD.confirmed_by IS NOT NULL OR NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL THEN\n            RAISE EXCEPTION 'admin_operations: awaiting_confirmation -> pending exige la confirmación de un admin' USING ERRCODE = '23514';\n          END IF;\n          -- (modelo")],
        'apps/api/src/settings/admin-operations.test.ts', 'TRANSICIONES_EN_BD_ESTADOS',
    ),
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


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def counts(out):
    """(pasados, fallados) de la línea «Tests» de vitest. Un filtro -t que no casa con nada da (0, 0): VERDE VACÍO."""
    clean = ANSI.sub("", out)
    line = next((l for l in clean.splitlines() if re.match(r"\s*Tests\s", l)), "")
    passed = re.search(r"(\d+) passed", line)
    failed = re.search(r"(\d+) failed", line)
    return (int(passed.group(1)) if passed else 0, int(failed.group(1)) if failed else 0)


def run_filtered(test, frag):
    r = sh(f'timeout 900 nice -n 19 ionice -c3 npx vitest run --maxWorkers=1 {test} -t "{frag}" 2>&1')
    return r.returncode, r.stdout + r.stderr


_base = {}


def baseline(test, frag):
    """La línea base debe tener >=1 test EN VERDE y 0 en rojo con ese filtro; si no, el mutante no demuestra nada."""
    key = (test, frag)
    if key not in _base:
        if not wait_prodguard():
            print("PRODGUARD no llegó a OK; se aborta", flush=True)
            sys.exit(2)
        rc, out = run_filtered(test, frag)
        passed, failed = counts(out)
        _base[key] = (rc == 0 and passed >= 1 and failed == 0, passed, failed, rc)
    return _base[key]


def check_anchors(edits):
    bad = []
    for path, old, _new in edits:
        src = open(os.path.join(ROOT, path)).read()
        if src.count(old) != 1:
            bad.append(f"{path}: ancla no única ({src.count(old)}): {old[:70]!r}")
    return bad


def check_all():
    n = 0
    for name, edits, test, frag in M:
        problems = check_anchors(edits)
        if frag not in open(os.path.join(ROOT, test)).read():
            problems.append(f"el fragmento {frag!r} no aparece en {test}")
        for b in problems:
            print(f"{name}: {b}")
        n += len(problems)
    print(f"COMPROBACION: {len(M)} mutantes, {n} problemas")
    return n


args = sys.argv[1:]
if args == ["--check"]:
    sys.exit(1 if check_all() else 0)

if args == ["--baseline"]:
    bad = 0
    for test, frag in sorted({(m[2], m[3]) for m in M}):
        ok, passed, failed, rc = baseline(test, frag)
        print(f"BASE {'OK ' if ok else 'MAL'} {test} -t {frag}: rc={rc} pasan={passed} fallan={failed}", flush=True)
        bad += not ok
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
    ok, passed, failed, rc = baseline(test, frag)
    if not ok:
        print(f"{name}: BASE NO VÁLIDA (rc={rc}, pasan={passed}, fallan={failed}): sin ≥1 test en verde no hay calibración", flush=True)
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
        rc2, out = run_filtered(test, frag)
        open(f"/tmp/adm3-mut-{tag}.log", "w").write(out)
        p2, f2 = counts(out)
        failed_lines = [l for l in ANSI.sub("", out).splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        red = rc2 != 0 and f2 >= 1
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
        if verdict != "ROJO-OK":
            fails += 1
        print(f"{name}: base pasan={passed} | mutante rc={rc2} fallan={f2} {verdict}", flush=True)
    finally:
        for path, src in originals.items():
            open(os.path.join(ROOT, path), "w").write(src)
d = sh("git status --porcelain --untracked-files=no").stdout.strip()
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN fallos_calibracion={fails}")
sys.exit(1 if fails else 0)
