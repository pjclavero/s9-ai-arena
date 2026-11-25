# Último recurso (break-glass): recuperar el acceso de administración

## Resumen

S9 AI Arena se administra **entera desde la web** con una sola cuenta de administrador (D-OP-44).
La consola del host sólo se usa en dos casos: la instalación técnica inicial y este documento, el
**último recurso** cuando **no queda ningún administrador capaz de autenticarse**. Antes de llegar
aquí, agota las vías web de la tabla siguiente.

## Índice

- [Antes de abrir la consola: las vías web](#antes-de-abrir-la-consola-las-vías-web)
- [El kit de recuperación](#el-kit-de-recuperación)
- [Cuándo sí hace falta la consola](#cuándo-sí-hace-falta-la-consola)
- [Procedimiento](#procedimiento)
- [Lo que NO hace el último recurso](#lo-que-no-hace-el-último-recurso)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Antes de abrir la consola: las vías web

| Situación | Vía web |
|---|---|
| Instalación nueva, sin ningún administrador | Asistente de primer arranque `#/setup` con el token de instalación ([first-run.md](first-run.md#3-primer-administrador)) |
| Admin que olvidó su contraseña y guardó su **kit de recuperación** | `#/recover-kit`: email + kit + contraseña nueva ([abajo](#el-kit-de-recuperación)) |
| Ídem, con verificación en dos pasos | `#/recover-kit` con el kit **y** un código TOTP o un código de recuperación de la 2FA |
| Perdió el móvil del TOTP pero conserva códigos de recuperación de la 2FA | El login acepta un código de recuperación en lugar del TOTP |
| Hay más de un admin y uno perdió el acceso | Otro admin lo recupera desde la web (flujo de recuperación de cuentas de ADM-3, #347) |
| Tiene sesión abierta y recuerda la contraseña | Mi cuenta → cambiar la contraseña; Administración → Kit de recuperación → generar uno nuevo |

## El kit de recuperación

- **Qué es.** Un código de un solo uso (`S9RK-` + 32 símbolos, 160 bits aleatorios). La base de datos
  sólo guarda su hash Argon2id (`admin_recovery_kits`, migración 027); nadie puede leerlo después.
- **Cuándo se ve.** Una sola vez: al crear el primer administrador en el asistente y cada vez que se
  regenera en **Administración → Kit de recuperación** (exige la contraseña actual y, con 2FA, un
  código). Regenerar invalida el anterior. `create-admin` por consola no lo emite.
- **Canje** (`POST /auth/recovery-kit/redeem`, pantalla `#/recover-kit`): email + kit + contraseña
  nueva (misma política que el registro). Fija la contraseña, revoca **todas** las sesiones de la
  cuenta y consume el kit; la web ofrece generar otro al volver a entrar.
- **2FA.** El kit **no** desactiva ni resetea la verificación en dos pasos. Con 2FA activa hace falta
  además un TOTP o un código de recuperación de la 2FA: dos posesiones distintas, así un kit robado
  solo no basta. Si se perdieron a la vez el TOTP y todos sus códigos, el kit no alcanza y queda la
  consola.
- **Sólo administradores.** Decisión del carril ADM-SETUP: el kit cubre el único caso que nadie más
  puede cubrir (el admin sin nadie por encima). Un usuario normal lo recupera un admin desde la web.
  Abrirlo a todas las cuentas añadiría un canal público de cambio de contraseña para miles de
  cuentas sin necesidad. Si una cuenta deja de ser admin, su kit deja de valer.
- **Sin oráculo.** Email inexistente, cuenta sin kit, cuenta que no es admin y kit erróneo responden
  igual (`401`) y con el mismo coste. Límite: 10 intentos cada 15 min por IP y 60 por hora en total.
  Todo queda auditado: `auth.recovery_kit.generated`, `auth.recovery_kit.redeemed` y
  `auth.recovery_kit.rejected` (sin el kit ni la contraseña).

## Cuándo sí hace falta la consola

Sólo cuando **no queda ningún administrador capaz de autenticarse** y ninguna vía web sirve. Por
ejemplo: el único admin perdió la contraseña **y** el kit; o perdió el TOTP **y** todos sus códigos
de recuperación; y no hay otro admin.

Por qué no hay vía web: sin un canal fuera de banda (la plataforma no envía correo) no hay forma de
distinguir al dueño legítimo de un atacante. El acceso al host **es** esa prueba de titularidad.

## Procedimiento

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
```

**DANGER:** crea una cuenta con rol `admin`.
**PRECONDITION:** acceso al host; ninguna vía web de la tabla anterior sirve.
**EFFECT:** un administrador nuevo, auditado (`admin.create_cli`, `additional: true`).
**ROLLBACK:** quitarle el rol desde la web con otra cuenta admin.

1. Crea un administrador nuevo por consola (la contraseña por prompt sin eco, nunca en argv):

   ```bash
   $DC exec -w /app api npx tsx apps/api/src/db/cli.ts create-admin <email-nuevo> "<nombre visible>" \
     --password-stdin --allow-additional-admin
   ```

   Detalle del comando, códigos de salida y alternativas en
   [first-run.md](first-run.md#último-recurso-create-admin-por-consola). Si #347 está integrado,
   `cli.ts reset-password` permite además fijar la contraseña de la cuenta existente.
2. Entra en la web con esa cuenta y genera su kit en **Administración → Kit de recuperación**.
3. Desde la web, recupera o retira la cuenta antigua (roles, bloqueo, recuperación de ADM-3).

Tras esto, todo vuelve a la web.

## Lo que NO hace el último recurso

- **No reabre el asistente de primer arranque.** Una vez completada la instalación, `install_state`
  la mantiene cerrada para siempre, aunque se borren todos los administradores. `create-admin`
  también la cierra (`via='cli'`) si se usa antes del asistente.
- No pasa la contraseña por argv ni la escribe en el log.
- No usa SQL a mano ni `seed`.

## Estado actual

- **IMPLEMENTADO (rama `feat/v1-web-setup`, sin integrar ni desplegar):** kit de recuperación del
  administrador (emisión en el asistente, regeneración con reautenticación, canje sin oráculo y con
  segundo factor), cierre para siempre del asistente.
- **FUNCIONA ACTUALMENTE (main):** `create-admin --allow-additional-admin`.
- **PENDIENTE:** `cli.ts reset-password` (llega con #347); pantalla de 2FA y regeneración de códigos
  de recuperación de la 2FA (ACC-2FA).

## Documentación relacionada

[first-run.md](first-run.md) · [installation.md](installation.md) ·
[../user/accounts.md](../user/accounts.md) · [../user/administration.md](../user/administration.md) ·
[../technical/security.md](../technical/security.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| El kit es de un solo uso, se guarda hasheado (Argon2id) y sólo vale para admins | TEST (PostgreSQL real) | `apps/api/src/recovery-kit.test.ts` (K1, K2, K6); `apps/api/src/db/migration-027.test.ts` |
| Sin oráculo de existencia de cuenta | TEST | `apps/api/src/recovery-kit.test.ts` (K3) |
| Con 2FA exige TOTP o código de recuperación y no desactiva la 2FA | TEST | `apps/api/src/recovery-kit.test.ts` (K4) |
| Regenerar exige reautenticación y sustituye al kit anterior | TEST | `apps/api/src/recovery-kit.test.ts` (K5) |
| El asistente no se reabre al quitar todos los admins; `create-admin` lo cierra | TEST | `apps/api/src/setup-web.test.ts` (T5, T8) |
