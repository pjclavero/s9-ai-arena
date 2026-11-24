# Recuperación de cuentas y operación de usuarios

## Resumen

Cómo recupera una cuenta cuya contraseña se ha olvidado y qué garantías da el mecanismo. Para el uso desde la web (administrador del juego) ver [Administración → Usuarios](../user/administration.md#usuarios); para el usuario final, [Cuentas](../user/accounts.md#si-olvidas-la-contraseña).

**Modelo de UN administrador.** Un solo administrador puede gestionar TODA la plataforma desde la web. Puede haber 1 o N admins, todos con permisos idénticos, y **ninguna operación exige un segundo admin**: no hay aprobaciones cruzadas, ni jerarquías, ni «linajes». Cada operación sensible la hace un admin con **reautenticación** (contraseña y, si tiene 2FA, TOTP), **confirmación explícita** en la web (frase literal) y queda en `audit_log`. **La consola es sólo el último recurso** (instalación inicial o cuando no queda ningún admin que pueda entrar).

La plataforma **no envía correo**: el administrador emite un token y se lo entrega al usuario fuera de banda. `POST /auth/recover` **se retiró** (contrato 0.27.0): creaba el token y lo descartaba, así que nadie podía usar `POST /auth/reset`.

## Recuperar una cuenta desde la web (cualquier cuenta, también la de otro admin)

Garantías (cada una tiene su test en `apps/api/src/adm3-users-recovery.test.ts` y `adm3-one-admin.test.ts`):

- El token es **aleatorio de 192 bits**, de **un solo uso** (consumo atómico: dos canjes simultáneos, uno solo gana) y **caduca a los 30 minutos**.
- En base de datos **sólo se guarda su hash SHA-256** (`password_resets.token_hash`). No va a la auditoría ni a los logs ni se vuelve a poder leer: se muestra **una vez** (`Cache-Control: no-store`).
- Emitir uno nuevo **anula los anteriores** del usuario. También los anulan **bloquear o desbloquear** la cuenta y **cualquier cambio de sus roles**.
- El administrador **no conoce la contraseña**: la elige el usuario al canjear el token. La política es la única de la plataforma (`passwordPolicyViolation`); el mensaje del canje sale de esa función.
- El canje **revalida el estado** de la cuenta (una cuenta bloqueada no se recupera y el token no se consume), **cierra todas las sesiones** y **no toca el 2FA por defecto** (el siguiente acceso sigue pidiendo su código). Si la persona perdió el móvil y los códigos, el admin marca **«Restablecer también la 2FA»** al emitir el token (D-OP-44): emitir no cambia nada; **al canjear** se fija la contraseña, se borran el secreto TOTP y los códigos de recuperación y se audita (`auth.two_factor.reset_by_recovery`). Vale también para la cuenta de otro admin (sigue siendo admin: no aplica la guarda del último admin). Un token anulado nunca toca la 2FA.
- **Sin enumeración**: `POST /auth/reset` no recibe ningún email; un token inexistente, usado, caducado, anulado o de una cuenta bloqueada da exactamente la misma respuesta (401), con el mismo coste (sin oráculo de tiempo). Límite de **10 intentos por IP cada 5 min** (429).
- Emitirlo exige **reautenticación fuerte** del admin y tiene límite de **20 acciones cada 5 min por admin** (429). No se emite para la propia cuenta (400: usar «Mi cuenta»).
- Auditoría (`audit_log`): `admin.user.recovery_token_issued` (quién, a quién; **sin** el token) y `auth.password.reset` (sesiones cerradas, quién lo emitió; **sin** la contraseña).

## Roles y bloqueo (un solo admin, sin aprobaciones)

- **Conceder o quitar `admin`** (a otra cuenta o a uno mismo) exige reautenticación y lo hace UN admin. Cualquier otro cambio de roles no pide contraseña. Todo cambio queda en `admin.user.roles_set`.
- **Bloquear o desbloquear** a cualquier cuenta (también a otro admin y a uno mismo) exige reautenticación y lo hace UN admin. Una cuenta bloqueada no inicia sesión (403 `account_blocked` tras acertar la contraseña), no refresca tokens y no puede recibir un token de recuperación; bloquear cierra sus sesiones.
- **Anti-bloqueo (nunca 0 admins activos).** Bloquear o quitar el rol al **último admin activo**, incluido uno mismo, da **409 `last_admin`**, bajo un **cerrojo consultivo** de PostgreSQL y sin carreras: dos admins que se bloquean o se degradan a la vez terminan siempre con 200/409 y un admin activo.
- Cancelar la orden de ADM-1 de **otro** admin exige reautenticación y se audita con quién la canceló; la propia, no.
- ADM-1: las órdenes **irreversibles** ya no exigen un segundo admin: las confirma el mismo admin con **token de un solo uso + frase literal + reautenticación + auditoría** (`requiresSecondAdmin` desaparece de la API; la columna `admin_operations.requires_second_admin` queda siempre a `false` con un CHECK de la 025).

## Consola: último recurso

Sólo para la instalación inicial o cuando **ningún admin puede entrar** (por ejemplo, el único admin olvidó su contraseña y no tiene sesión). Requiere acceso local privilegiado al host y a la base de datos. **La contraseña nunca va por argv**: por stdin o por un fichero `0600` del propio usuario.

```
# primer admin (instalación)
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts create-admin <email> "<nombre>" --password-stdin
# recuperar una cuenta sin sesión de admin
printf '%s' "$NUEVA_CLAVE" | $DC exec -T -w /app api \
  npx tsx apps/api/src/db/cli.ts reset-password <email> --password-stdin
# o con fichero 0600
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts reset-password <email> --password-file /ruta/clave
```

`reset-password`: fija la contraseña (política única), **cierra todas las sesiones**, **anula sus tokens de recuperación** y lo audita como `admin.reset_password_cli` **sin la contraseña**. No cambia el 2FA ni el bloqueo (si la cuenta está bloqueada lo avisa: desbloquéala desde la web). Códigos de salida: `0` hecho · `2` uso o entrada inválidos (incluida una contraseña que no cumple la política, o `--password=…` en argv) · `3` no existe esa cuenta · `4` error inesperado. Comunica la contraseña provisional fuera de banda y pide que se cambie en «Mi cuenta».

## Cambios de contrato respecto a las rondas de revisión

El PR #347 llegó a incluir un doble control (segundo admin para lo irreversible, linaje de promoción). **El operador lo derogó**: el contrato definitivo es «un solo admin, ninguna aprobación cruzada». Se retiraron las órdenes `user.*` de aprobación, la tabla `admin_grant_edges`, el bootstrap especial y todo `second_admin_*`. Los tokens de un solo uso con hash, la anulación por cambio de rol o de estado, los cerrojos, los límites de intentos y `GET /admin/users/{userId}` se conservan. Bajar la migración 025 **desbloquea todas las cuentas bloqueadas** (se pierde `users.status`): queda un aviso en la auditoría (`migration.025.down`) y el runbook de rollback debe volver a bloquearlas si procede.

## Verificación

| Afirmación | Tipo | Evidencia |
|---|---|---|
| Un solo admin hace cada operación sensible de principio a fin, auditada | TEST (PostgreSQL real) | `UN_ADMIN_TODO`, `ADMIN_GESTIONA_ADMIN`, `SIN_BOOTSTRAP_NI_LINAJE` en `adm3-one-admin.test.ts` |
| Reautenticación obligatoria (401 sin ella; con 2FA, también TOTP) | TEST | `REAUTH_CADA_OPERACION`, `REAUTH_CON_2FA` |
| Último admin protegido (incluido el auto-bloqueo y la auto-degradación), bajo cerrojo y sin carreras | TEST | `ULTIMO_ADMIN*`, `CARRERA_*`, `CERROJO_*` |
| Token de un solo uso, 30 min, sólo hash, anulado por rol/estado | TEST | `TOKEN_*`, `ROLES_ANULA_TOKENS`, `ESTADO_ANULA_TOKENS`, `CANJE_REVALIDA_ESTADO` |
| Sin enumeración, límite de canje, política de contraseñas | TEST | `NO_ENUMERACION`, `RATE_LIMIT_RESET`, `POLITICA_*` |
| ADM-1: la irreversible la confirma el mismo admin | TEST | `UN_ADMIN_IRREVERSIBLE`, `ADMIN_UNICO_IRREVERSIBLE` en `settings/admin-operations.test.ts` |
| CLI sin secretos por argv | TEST | `CLI_SERVICIO`, `CLI_ARGV`, `reset-password-cli.test.ts` |
| Migración 025 y su vuelta atrás | TEST | `apps/api/src/db/migration-025.test.ts` |
| Mutantes de calibración | SCRIPT | `scripts/adm3-mutants.py` |
| Probado en laboratorio, navegador real, desplegado | **NO** | pendiente |
