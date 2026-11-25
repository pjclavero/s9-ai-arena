# Puesta en marcha (primer arranque)

## Resumen

Lo que hay que hacer **una sola vez** después de [installation.md](installation.md) para que la
instalación sea usable: contenido base en la base de datos, primer administrador **desde el
navegador**, repositorio de copias inicializado y comprobación de readiness. Incluye los comandos
que **no** deben usarse en producción.

El recorrido es: instalar → abrir el navegador → crear el primer administrador en el asistente con
el token de instalación del host → gestionar todo desde la web con esa cuenta (D-OP-44). La consola
queda para la instalación técnica y como **último recurso** ([break-glass.md](break-glass.md)).

## Índice

- [Orden](#orden)
- [1. Contenido base (`bootstrap`)](#1-contenido-base-bootstrap)
- [2. Cuentas normales](#2-cuentas-normales)
- [3. Primer administrador](#3-primer-administrador)
  - [Asistente web (vía normal)](#asistente-web-vía-normal)
  - [Kit de recuperación](#kit-de-recuperación)
  - [Último recurso: `create-admin` por consola](#último-recurso-create-admin-por-consola)
- [4. Repositorio de copias](#4-repositorio-de-copias)
- [5. Readiness](#5-readiness)
- [6. Opcional: equipos de demostración](#6-opcional-equipos-de-demostración)
- [Comandos prohibidos en producción](#comandos-prohibidos-en-producción)
- [El asistente R17](#el-asistente-r17)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Orden

1. secretos (`init-secrets.sh`, que genera también `setup_token.txt`) y `.env` (ya hechos en la
instalación) → 2. `up -d` → 3. `bootstrap` → 4. abrir el navegador en `#/setup` y crear el primer
administrador con el token de instalación → 5. `backup.sh --init-repo` → 6. readiness.

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
```

## 1. Contenido base (`bootstrap`)

```bash
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts bootstrap
```

- Aplica todas las migraciones pendientes y siembra el contenido base: el ruleset `mvp-default`,
  el catálogo de módulos y el mapa base. **No crea usuarios.**
- Es idempotente: repetirlo no duplica nada.
- La lista de roles (`visitor`, `user`, `developer`, `team_captain`, `organizer`, `moderator`,
  `admin`) la crean las migraciones; sin ella el registro falla.

Comprobación de lectura:

```bash
$DC exec postgres psql -U arena -d arena -tAc "SELECT id FROM rulesets;"
```

> El usuario de base de datos es **`arena`** (`POSTGRES_USER` del compose). El rol `postgres`
> no existe en esta instalación: cualquier comando con `-U postgres` falla.

Limitación conocida: la web crea batallas con identificadores de modo que no son el
`mvp-default` sembrado, y la creación devuelve `400 rulesetId desconocido`
([TD-003](../roadmap/technical-debt.md#td-003)).

## 2. Cuentas normales

El primer administrador se crea en el paso 3 (asistente web). Las demás cuentas se registran desde la
web, o por API:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"email":"<email-del-operador>","password":"<mínimo 12 caracteres>","displayName":"<nombre>"}' \
  http://127.0.0.1:${HTTP_PORT:-80}/api/v1/auth/register
```

Toda cuenta registrada recibe `user` y `developer`. El registro es **abierto** a cualquiera que
alcance la web ([TD-012](../roadmap/technical-debt.md#td-012)).

## 3. Primer administrador

### Asistente web (vía normal)

Con una instalación recién hecha (0 administradores) la API abre un **asistente de primer arranque**
en el navegador. Está abierto sólo si se cumplen las tres condiciones: no hay ningún administrador,
la instalación no está completada (`install_state`, migración 027) y el token de instalación está
presente. Si falta cualquiera, está cerrado.

1. Al arrancar con el asistente abierto, el log de la API lo anuncia con la **huella** del token
   (nunca el token):

   ```bash
   $DC logs api | grep '\[setup\]'
   # [setup] Abre la web de la plataforma, ruta #/setup y pega el contenido de secrets/setup_token.txt (huella sha256:…)
   ```

2. Abre la web (`https://<host-arena>/#/setup`; la pantalla de acceso también avisa con un enlace).
3. Pega el contenido de `infrastructure/secrets/setup_token.txt` del host (lo genera
   `init-secrets.sh`, 40 caracteres, `0400`, montado **sólo** en `api` como secreto Docker). Es la
   prueba de que quien crea el administrador controla la máquina.
4. Escribe email, nombre visible y la contraseña dos veces. La política es la única de la plataforma
   (`passwordPolicyViolation`, validada en el servidor; con #348, 12-128 caracteres y lista de
   contraseñas comunes).
5. Al pulsar «Crear administrador» la cuenta nace con `user`, `developer` y `admin`, la sesión queda
   iniciada y se muestra **una sola vez** el [kit de recuperación](#kit-de-recuperación). Guárdalo
   antes de seguir.

Garantías (tests en `apps/api/src/setup-web.test.ts`; mutantes en `scripts/v1-web-setup-mutants.mjs`):

- el token se compara en tiempo constante; cada token erróneo responde 401 y queda auditado
  (`setup.token_rejected`) sin su valor; límite de 5 intentos cada 15 min por IP y 20 por hora en total;
- el alta reutiliza `createAdmin` (transacción + cerrojo consultivo): dos envíos simultáneos crean
  **un** administrador; queda auditada (`admin.create_web_setup`, con IP, user-agent y huella del
  token, sin contraseña ni token);
- al completarse, la instalación queda cerrada **para siempre**: `GET /setup/status` dice
  `{"open":false}` y `POST /setup/admin` responde `410 setup_closed`, aunque después se borren todos
  los administradores (el cierre lo marca `install_state`, no el recuento);
- una instalación que ya tenía administrador al migrar a la 027 nace completada (`via='migration'`):
  nunca abre el asistente.

Tras el alta el fichero `setup_token.txt` ya no tiene efecto. **No lo borres**: Compose exige que el
fichero del secreto exista para arrancar. Vaciarlo (`: > infrastructure/secrets/setup_token.txt`)
cierra el asistente aunque no se haya usado. Ojo: `init-secrets.sh` vuelve a rellenar un fichero
vacío. Con la instalación **ya completada** eso no reabre nada; **antes** de crear el primer
administrador, el token nuevo vuelve a abrir el asistente (con otra huella).

Comprobación desde la web: entra con la cuenta; la barra muestra los roles de la sesión
(`user, developer, admin`) y aparece **Administración**. Los roles se leen de la base de datos en cada
petición autenticada, así que el login es efectivo de inmediato. No hace falta `psql`.

### Kit de recuperación

Código de un solo uso (`S9RK-XXXX-…`, 160 bits), guardado sólo como hash Argon2id. Sirve para que un
administrador que olvida su contraseña la recupere **desde la web** (`#/recover-kit`) sin consola:
email + kit + contraseña nueva. Si la cuenta tiene verificación en dos pasos, exige además un código
TOTP o uno de sus códigos de recuperación: el kit **no** desactiva la 2FA. Al canjearlo se revocan
todas las sesiones y el kit queda consumido; después se genera otro en **Administración → Kit de
recuperación** (con reautenticación). Detalle y límites en [break-glass.md](break-glass.md).

### Último recurso: `create-admin` por consola

`create-admin` sigue existiendo, pero **no** es el paso normal: es la instalación técnica sin
navegador o la recuperación cuando no queda ningún administrador capaz de autenticarse
([break-glass.md](break-glass.md)). Crear el admin por consola **también cierra el asistente** para
siempre (`install_state` con `via='cli'`). Crea el administrador **sin SQL**
([TD-023](../roadmap/technical-debt.md#td-023)); si el email ya existe, se niega y no lo promueve.

Forma recomendada: **prompt sin eco** (con terminal, sin `-T`). Pide la contraseña dos veces y no la
escribe en pantalla ni en el historial:

```bash
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts create-admin <email> "<nombre visible>" --password-stdin
```

Alternativas no interactivas:

```bash
# Fichero 0600 (recomendada en scripts): dentro del contenedor, créalo con el mismo usuario que
# ejecuta el comando y con umask 077 (un `docker cp` lo dejaría como root y el CLI lo rechaza).
# Escribir la contraseña aquí exige una fuente que no deje rastro (p. ej. un gestor de secretos).
$DC exec -T api sh -c 'umask 077; cat > /tmp/s9-admin.pw' < <fichero-0600-del-host>
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts create-admin <email> "<nombre visible>" \
  --password-file /tmp/s9-admin.pw
$DC exec -T api rm -f /tmp/s9-admin.pw

# Tubería: sólo si el valor NO se teclea en un shell interactivo. Un `printf '%s' "<clave>" | …`
# escrito a mano SÍ queda en `~/.bash_history` (aunque no en `ps`, porque `printf` es interno
# del shell); usa `read -rs P` y `printf '%s' "$P" | …`, o un espacio inicial con
# `HISTCONTROL=ignorespace`.
printf '%s' "$P" | $DC exec -T -w /app api \
  npx tsx apps/api/src/db/cli.ts create-admin <email> "<nombre visible>" --password-stdin
```

(El procedimiento del fichero dentro del contenedor no se ha ejercitado con el stack Compose
completo; la lectura del fichero sí está probada. Si `/tmp` del contenedor no es escribible,
usa el prompt.)

- La contraseña **nunca** va en argv (`--password=…`, `-p…` y similares se rechazan con rc 2, sin
  repetir el valor). El fichero se abre sin seguir enlaces simbólicos y se valida sobre el
  descriptor abierto: debe ser regular, del mismo usuario y sin permisos de grupo/otros (`0600`).
- Aplica la misma política que el registro. Roles resultantes: `user`, `developer` y `admin`.
- **Códigos de salida:** `0` creado · `1` ya existe un administrador · `2` uso o entrada inválidos
  (argumentos, fichero de contraseña inexistente, con permisos/propietario/tipo inválidos o enlace
  simbólico, política de contraseñas, contraseñas del prompt distintas) · `3` precondición de
  estado (el email ya existe, o faltan los roles base: ejecuta antes `bootstrap`) · `4` error
  inesperado (sin traza). Para añadir otro administrador por esta vía: `--allow-additional-admin`; queda auditado
  (`admin.create_cli`, con `additional: true`, sin la contraseña). Lo normal es gestionar roles
  desde la web ([../user/administration.md](../user/administration.md)).
- No usa `seed` ni credenciales del repositorio, y no emite kit de recuperación (genéralo después en
  la web).
- Alta y recuento van en una transacción con cerrojo: dos ejecuciones simultáneas no producen dos
  «primeros» administradores.

## 4. Repositorio de copias

Un repositorio restic no existe hasta que se crea, y `backup.sh` **no** lo crea por su cuenta (una
errata en `RESTIC_REPOSITORY` crearía en silencio un repositorio vacío). Una sola vez:

```bash
$DC exec backup /usr/local/bin/backup.sh --init-repo
```

Es idempotente. Después, lanza una copia manual para no esperar al cron y comprobar el camino
completo:

```bash
$DC exec backup /usr/local/bin/backup.sh
```

Detalle y comprobación diaria en [backup.md](backup.md).

## 5. Readiness

```bash
npx tsx scripts/readiness.ts
```

Requiere Node ≥ 22.15 y `npm ci` en el clon. Hoy el veredicto **nunca** es `READY`: varias
comprobaciones obligatorias no se pueden ejercer desde el CLI. Qué mide y qué no en
[readiness.md](readiness.md). El CLI **no consulta** si existe un administrador: compruébalo en la
web, como indica el paso 3 (el sondeo `admin.bootstrap_identity` de `packages/first-run` no está cableado
al CLI; [TD-024](../roadmap/technical-debt.md#td-024)).

## 6. Opcional: equipos de demostración

```bash
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts demo-teams <email-de-un-usuario-existente> [equipo...]
```

Crea equipos de tres bots para un usuario **que ya existe**, con el código de los bots de ejemplo.
Las versiones quedan en `draft`. Es la única forma de que un bot quede asociado a un equipo fuera
de la creación por API ([TD-011](../roadmap/technical-debt.md#td-011)).

## Comandos prohibidos en producción

| Comando | Por qué |
|---|---|
| `cli.ts seed` | (usa `create-admin`, no `seed`) migra y crea **usuarios de desarrollo con contraseña conocida del repositorio** |
| `cli.ts rollback:all` | revierte todas las migraciones: **destruye el esquema completo** |
| `cli.ts rollback:1` | revierte la última migración; sólo con un plan de vuelta atrás probado |
| `cli.ts rollback:name <NNN_tema>` | revierte esa migración concreta, esté donde esté; mismo requisito |
| `cli.ts rollback` | no existe (el CLI lo rechaza con código 2, para no confundir los dos anteriores) |
| `psql -U postgres …` / `pg_dumpall -U postgres` | el rol no existe; usar `-U arena` |

## El asistente R17

`packages/first-run/` modela el primer arranque en 13 dominios (`sistema`, `administrador`,
`base-de-datos`, `almacenamiento`, `almacenamiento-bots`, `almacenamiento-replays`, `copias`,
`restauracion`, `seguridad`, `ejecucion`, `spectator`, `preflight`, `readiness`). Es una librería
con tests y mutantes (`scripts/r17-first-run-mutants.mjs`); **no hay interfaz que la ejecute** en
la instalación. El diseño original está archivado en
[../history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md](../history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md).

## Estado actual

- **IMPLEMENTADO (rama `feat/v1-web-setup`, sin integrar ni desplegar):** asistente web de primer
  arranque con token de instalación (`#/setup`), cierre para siempre (`install_state`, migración 027)
  y kit de recuperación del administrador (`#/recover-kit`, Administración → Kit de recuperación).
- **FUNCIONA ACTUALMENTE:** `bootstrap`, registro, `create-admin` (último recurso, sin SQL), `--init-repo`.
- **PARCIAL:** readiness (CLI, sin `READY` posible).
- **PENDIENTE:** cierre del registro abierto; readiness desplegado
  ([TD-012](../roadmap/technical-debt.md#td-012), [TD-024](../roadmap/technical-debt.md#td-024)).

## Documentación relacionada

[installation.md](installation.md) · [backup.md](backup.md) · [readiness.md](readiness.md) ·
[../technical/database.md](../technical/database.md) · [../technical/security.md](../technical/security.md) ·
[../user/accounts.md](../user/accounts.md) · [../user/administration.md](../user/administration.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `bootstrap` = `migrateToLatest` + `seedContent`, sin usuarios; idempotente | CODE_VERIFIED + RUNTIME_VERIFIED | `apps/api/src/db/cli.ts:56-59`; ejecutado dos veces en el entorno aislado |
| `seed` crea usuarios de desarrollo; `rollback:all` destruye el esquema; `rollback` a secas rechazado; `rollback:name` revierte una migración concreta | CODE_VERIFIED | `apps/api/src/db/cli.ts:12-22,37-67` |
| Los roles los crean las migraciones | CODE_VERIFIED | `apps/api/src/db/migrations.ts:20,97-105` |
| El registro asigna `user` + `developer` | CODE_VERIFIED | `apps/api/src/routes/auth.ts` (`register`) |
| `create-admin`: sin SQL, contraseña por stdin/fichero 0600 (nunca argv), política ≥12, se niega con admin existente, auditado | TEST (PostgreSQL real, proceso real) | `apps/api/src/db/create-admin.test.ts`; mutantes `scripts/v1-first-admin-mutants.mjs` |
| Asistente web: abierto sólo con 0 admins + instalación sin completar + token; token en tiempo constante, con límite y auditado sin valor; una sola alta ante carreras; cierre para siempre; el CLI también cierra; el log sólo lleva la huella | TEST (PostgreSQL real) | `apps/api/src/setup-web.test.ts`; `apps/api/src/db/migration-027.test.ts`; mutantes `scripts/v1-web-setup-mutants.mjs` |
| Kit de recuperación: un solo uso, hash Argon2id, sólo admins, sin oráculo, exige el segundo factor con 2FA, regenerar con reautenticación | TEST (PostgreSQL real) | `apps/api/src/recovery-kit.test.ts`; mutantes `scripts/v1-web-setup-mutants.mjs` |
| Roles de otros usuarios: `PUT /users/{id}/roles` (exige admin) | CODE_VERIFIED | `apps/api/src/routes/users.ts:51-53` |
| Los roles se leen de BD en cada petición | CODE_VERIFIED | `apps/api/src/middleware/authenticate.ts:30,47-48` |
| El usuario de BD es `arena`; `postgres` no existe | CODE_VERIFIED + RUNTIME_VERIFIED | compose `POSTGRES_USER: arena`; `SELECT rolname FROM pg_roles` en el entorno aislado; auditoría 2026-10-15 en producción |
| `--init-repo` idempotente y no automático | CODE_VERIFIED | `infrastructure/backup/backup.sh:505-517` |
| 13 dominios del asistente, sin interfaz que lo ejecute | CODE_VERIFIED | `packages/first-run/domains.ts`; sin referencias desde `apps/` |
