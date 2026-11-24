# Recuperación de cuentas y operación de usuarios

## Resumen

Cómo recupera el operador una cuenta cuya contraseña se ha olvidado y qué garantías da el mecanismo. Para el uso desde la web (administrador del juego) ver [Administración → Usuarios](../user/administration.md#usuarios); para el usuario final, [Cuentas](../user/accounts.md#si-olvidas-la-contraseña).

La plataforma **no envía correo**. Hay dos vías, según cuántos administradores activos existan:

| Situación | Vía |
|---|---|
| Hay **otro administrador** activo (o el afectado no es admin) | **Token de recuperación** emitido desde la web ([abajo](#vía-1-token-de-recuperación-desde-la-web)) |
| Sólo hay **un administrador** activo y es el afectado | **CLI local** privilegiada ([abajo](#vía-2-cli-local-de-emergencia)) |

`POST /auth/recover` **se retiró** (contrato 0.27.0): creaba el token y lo descartaba, así que nadie podía usar `POST /auth/reset`. Ya no existe ninguna ruta que cree tokens sin un administrador autenticado delante.

## Vía 1: token de recuperación desde la web

Garantías (cada una tiene su test en `apps/api/src/adm3-users-recovery.test.ts`):

- El token es **aleatorio de 192 bits**, de **un solo uso** (consumo atómico: dos canjes simultáneos, uno solo gana) y **caduca a los 30 minutos**.
- En base de datos **sólo se guarda su hash SHA-256** (`password_resets.token_hash`). No va a la auditoría, ni a los logs, ni se vuelve a poder leer: se muestra **una vez** al administrador (`Cache-Control: no-store`).
- Emitir uno nuevo **anula los anteriores** del mismo usuario; bloquear la cuenta, también.
- El administrador **no conoce la contraseña**: la elige el usuario al canjear el token. La política es la única de la plataforma (`passwordPolicyViolation`, hoy mínimo 12 caracteres).
- El canje **cierra todas las sesiones** del usuario y **no toca el 2FA** (el siguiente acceso sigue pidiendo su código).
- **Sin enumeración**: `POST /auth/reset` no recibe ningún email; un token inexistente, usado, caducado, anulado o de una cuenta bloqueada da exactamente la misma respuesta (401). Límite de **10 intentos por IP cada 5 min** (429).
- Emitirlo exige **reautenticación fuerte** del administrador (contraseña y, si tiene 2FA, TOTP) y tiene límite de **20 acciones cada 5 min por admin**.
- Auditoría (`audit_log`): `admin.user.recovery_token_issued` (quién, a quién, si hubo segundo admin; **sin** el token) y `auth.password.reset` (sesiones cerradas, quién lo emitió; **sin** la contraseña).

### Cuenta de administrador: segundo administrador

Si el objetivo es una **cuenta admin** el token sólo se emite con la aprobación de **otro administrador activo**, con el mecanismo de órdenes de ADM-1 (`admin_operations`, tipo `user.recovery_admin`, clase irreversible):

1. El solicitante crea la orden (`POST /admin/operations`, `{"kind":"user.recovery_admin","params":{"userId":"…"}}`). Si sólo hay un admin activo: **409 `second_admin_unavailable`** ⇒ usa la CLI local.
2. **Otro** administrador la confirma (`POST /admin/operations/{id}/confirm`) con la **frase literal** del servidor y su contraseña (y TOTP). El solicitante no puede aprobarla (403).
3. El solicitante emite el token (`POST /admin/users/{userId}/recovery-token` con `operationId`). La aprobación **se consume una sola vez**, sólo vale para esa cuenta y para quien la solicitó, y **caduca a los 10 minutos** de la aprobación (una aprobación sin usar se cancela sola al pedir otra).

Sólo cuentan los administradores **activos** (no bloqueados). Puede haber **una** solicitud activa **por cuenta objetivo** y tipo (no una global): dos recuperaciones de cuentas distintas conviven, y una segunda solicitud sobre la misma cuenta da 409 `operation_in_progress`.

El **canje revalida el rol**: si la cuenta es admin al canjear y el token no se emitió con una aprobación de segundo admin, se rechaza con la respuesta uniforme (cierra «degradar, emitir, re-promover, canjear» y «emitir y promover»). Cualquier cambio de roles de una cuenta **anula sus tokens abiertos**. Quitar el rol admin a OTRA cuenta exige reautenticación y una aprobación `user.revoke_admin` de un admin distinto del solicitante; la unicidad de estas órdenes es **por cuenta objetivo**, y crearlas o cancelarlas exige reautenticación y tiene límite por admin. El segundo admin se busca entre los admins activos distintos del solicitante y del objetivo.

### Defensa frente al admin «títere» (revisión de #347, ronda 2)

Para que un solo administrador no se fabrique un «segundo admin»:

- **Conceder `admin` a otra cuenta** exige reautenticación y, si existe **cualquier otro admin** (activo o bloqueado) además de quien lo hace, la aprobación de otro admin activo (orden `user.grant_admin`). **Sólo si no existe NINGÚN otro admin** basta la reautenticación (bootstrap del segundo admin de una instalación nueva); queda auditado como `bootstrap`. Un admin bloqueado no abre la puerta al bootstrap.
- **Bloquear a otra cuenta admin** exige la aprobación de otro admin activo (orden `user.block_admin`); sin nadie que pueda aprobar, 409 `second_admin_unavailable`. Así un admin no puede quedarse solo a la fuerza.
- **La cuenta objetivo nunca aprueba** una orden `user.*` sobre sí misma.
- **Linaje de promoción.** Se recuerda quién concedió cada rol admin (`users.admin_granted_by`, no se borra al quitar el rol). Una orden `user.*` de X **no la puede aprobar nadie de su linaje**: ni sus ANCESTROS (quien lo promovió, quien promovió a éste…) ni sus DESCENDIENTES (a quién promovió, y a quién promovieron ésos…), a cualquier profundidad (cierre transitivo con una consulta recursiva). Se aplica al confirmar, al consumir la aprobación y al decidir si hay aprobador disponible. Así ni A aprueba lo de su títere X ni el nieto Y lo de A.
- **Desbloquear a otra cuenta admin** exige la aprobación de otro admin activo (`user.unblock_admin`), igual que bloquearla.
- **Consecuencia operativa:** tras el bootstrap, A y X no pueden aprobarse entre sí ni a sus descendientes: **el tercer admin entra por consola** (`create-admin --allow-additional-admin`). Con dos admins ninguno puede bloquear, desbloquear ni degradar al otro: consola o SQL.
- **Quitar `admin` a otra cuenta** (`user.revoke_admin`) sólo admite como resultado «los roles actuales menos `admin`» (400 si no). La web lee los roles reales de la cuenta por id (`GET /admin/users/{userId}`) al aplicarla.
- **Límite irreductible:** DOS personas reales que se pongan de acuerdo siempre pueden saltarse el doble control (cada una es admin legítimo sin relación de promoción entre ellas). Tampoco se cubren las cuentas «títere» creadas antes de esta regla. El diseño sólo garantiza que UNA persona no pueda fabricarse al segundo admin con el flujo de la web.

### Salvaguardas de administración

- Bajar la migración 025 **desbloquea todas las cuentas bloqueadas** (se pierde `users.status`): queda un aviso en la auditoría (`migration.025.down`) y el runbook de rollback debe volver a bloquearlas si procede.
- No se puede **bloquear** (ni quitar el rol `admin` a) el **último administrador activo** (409 `last_admin`), ni uno a sí mismo bloquearse.
- Una cuenta **bloqueada** no inicia sesión (403 `account_blocked` tras acertar la contraseña), no refresca tokens y no puede recibir un token de recuperación.

## Vía 2: CLI local de emergencia

Para cuando **sólo hay un administrador** (o ninguno puede aprobar). Requiere acceso privilegiado al host y a la base de datos, como `create-admin` ([primer arranque](first-run.md)). **La contraseña nunca va por argv**: por stdin o por un fichero `0600` del propio usuario.

```
# desde el contenedor de la API (mismo patrón que create-admin)
printf '%s' "$NUEVA_CLAVE" | $DC exec -T -w /app api \
  npx tsx apps/api/src/db/cli.ts reset-password <email> --password-stdin

# o con fichero 0600
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts reset-password <email> --password-file /ruta/clave
```

(En una terminal interactiva `--password-stdin` pide la contraseña sin eco y la repite.) Efecto: fija la contraseña (política única), **cierra todas las sesiones** de la cuenta, **anula sus tokens de recuperación** y lo registra en la auditoría como `admin.reset_password_cli` **sin la contraseña**. No cambia el 2FA ni el bloqueo (si la cuenta está bloqueada lo avisa: desbloquéala desde la web con otro admin).

Códigos de salida: `0` hecho · `2` uso o entrada inválidos (incluida una contraseña que no cumple la política, o `--password=…` en argv) · `3` no existe esa cuenta · `4` error inesperado.

Comunica la contraseña provisional al usuario fuera de banda y pídele que la cambie desde **«Mi cuenta»**.

## Verificación

| Afirmación | Tipo | Evidencia |
|---|---|---|
| Token de un solo uso, 30 min, sólo hash, canje atómico y revocación de sesiones | TEST (PostgreSQL real) | `apps/api/src/adm3-users-recovery.test.ts` (`TOKEN_*`, `CANJE_*`) |
| Cuenta admin exige segundo admin y la aprobación se gasta una vez | TEST | `ADMIN_*` del mismo fichero |
| Sin enumeración, límite de canje, política de contraseñas | TEST | `NO_ENUMERACION`, `RATE_LIMIT_RESET`, `POLITICA_CONTRASENAS` |
| Bloqueo, último admin, listado sin secretos | TEST | `BLOQUEO_*`, `LISTA_*`, `ULTIMO_ADMIN_ROLES` |
| CLI sin secretos por argv | TEST | `CLI_SERVICIO`, `CLI_ARGV` |
| Migración 025 y su vuelta atrás | TEST | `apps/api/src/db/migration-025.test.ts` |
| Mutantes de calibración | SCRIPT | `scripts/adm3-mutants.py` |
| Probado en laboratorio, navegador real, desplegado | **NO** | pendiente (la validación de este PR fue ligera) |
