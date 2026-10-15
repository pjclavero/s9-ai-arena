# Puesta en marcha (primer arranque)

## Resumen

Lo que hay que hacer **una sola vez** después de [installation.md](installation.md) para que la
instalación sea usable: contenido base en la base de datos, primer administrador, repositorio
de copias inicializado y comprobación de readiness. Incluye los comandos que **no** deben
usarse en producción.

## Índice

- [Orden](#orden)
- [1. Contenido base (`bootstrap`)](#1-contenido-base-bootstrap)
- [2. Primera cuenta](#2-primera-cuenta)
- [3. Primer administrador](#3-primer-administrador)
- [4. Repositorio de copias](#4-repositorio-de-copias)
- [5. Readiness](#5-readiness)
- [6. Opcional: equipos de demostración](#6-opcional-equipos-de-demostración)
- [Comandos prohibidos en producción](#comandos-prohibidos-en-producción)
- [El asistente R17](#el-asistente-r17)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Orden

1. secretos y `.env` (ya hechos en la instalación) → 2. `up -d` → 3. `bootstrap` → 4. registrar la
primera cuenta → 5. promoverla a administrador → 6. `backup.sh --init-repo` → 7. readiness.

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

## 2. Primera cuenta

Registro normal desde la web, o por API:

```bash
curl -s -H 'content-type: application/json' \
  -d '{"email":"<email-del-operador>","password":"<mínimo 12 caracteres>","displayName":"<nombre>"}' \
  http://127.0.0.1:${HTTP_PORT:-80}/api/v1/auth/register
```

Toda cuenta registrada recibe `user` y `developer`. El registro es **abierto** a cualquiera que
alcance la web ([TD-012](../roadmap/technical-debt.md#td-012)).

## 3. Primer administrador

No hay comando ni pantalla para crear el primer administrador
([TD-023](../roadmap/technical-debt.md#td-023)). El único camino que funciona hoy es SQL directo.

> **DANGER** — escritura directa en la tabla de roles de producción.
>
> **PRECONDITION:** la cuenta existe (paso 2) y has comprobado el email exacto; ventana sin otros
> cambios de roles en curso.
>
> **EFFECT:** añade el rol `admin` a esa cuenta (no quita los otros). La cuenta gana acceso total
> al panel de administración.
>
> **ROLLBACK:** `DELETE FROM user_roles WHERE role = 'admin' AND user_id = (SELECT id FROM users WHERE email = '<email>');`

```bash
$DC exec postgres psql -U arena -d arena -v ON_ERROR_STOP=1 -c \
  "INSERT INTO user_roles (user_id, role) SELECT id, 'admin' FROM users WHERE email = lower('<email>') ON CONFLICT DO NOTHING;"
# Comprobar: debe listar admin entre sus roles
$DC exec postgres psql -U arena -d arena -tAc \
  "SELECT role FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = lower('<email>')) ORDER BY role;"
```

Los roles se leen de la base de datos en cada petición autenticada, así que el cambio es
efectivo sin volver a iniciar sesión (basta recargar la web). A partir de ahí el resto de roles
se gestionan desde la web
([../user/administration.md](../user/administration.md)), indicando el identificador del usuario.

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
[readiness.md](readiness.md).

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
| `cli.ts seed` | migra y crea **usuarios de desarrollo con contraseña conocida del repositorio** |
| `cli.ts rollback:all` | revierte todas las migraciones: **destruye el esquema completo** |
| `cli.ts rollback:1` | revierte la última migración; sólo con un plan de vuelta atrás probado |
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

- **FUNCIONA ACTUALMENTE:** `bootstrap`, registro, promoción por SQL, `--init-repo`.
- **PARCIAL:** readiness (CLI, sin `READY` posible).
- **PENDIENTE:** alta de administrador sin SQL; cierre del registro abierto; asistente de primer
  arranque usable ([TD-023](../roadmap/technical-debt.md#td-023),
  [TD-012](../roadmap/technical-debt.md#td-012), [TD-024](../roadmap/technical-debt.md#td-024)).

## Documentación relacionada

[installation.md](installation.md) · [backup.md](backup.md) · [readiness.md](readiness.md) ·
[../technical/database.md](../technical/database.md) · [../technical/security.md](../technical/security.md) ·
[../user/accounts.md](../user/accounts.md) · [../user/administration.md](../user/administration.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `bootstrap` = `migrateToLatest` + `seedContent`, sin usuarios; idempotente | CODE_VERIFIED + RUNTIME_VERIFIED | `apps/api/src/db/cli.ts:56-59`; ejecutado dos veces en el entorno aislado |
| `seed` crea usuarios de desarrollo; `rollback:all` destruye el esquema; `rollback` a secas rechazado | CODE_VERIFIED | `apps/api/src/db/cli.ts:11-19,36-55` |
| Los roles los crean las migraciones | CODE_VERIFIED | `apps/api/src/db/migrations.ts:20,97-105` |
| El registro asigna `user` + `developer` | CODE_VERIFIED | `apps/api/src/routes/auth.ts:167-171` |
| No existe endpoint ni comando para el primer admin; roles por `PUT /users/{id}/roles` | CODE_VERIFIED | `apps/api/src/routes/users.ts:51-53`; `cli.ts` sin comando |
| Promoción por SQL y login posterior | RUNTIME_VERIFIED | entorno aislado (`INSERT … user_roles`) |
| Los roles se leen de BD en cada petición | CODE_VERIFIED | `apps/api/src/middleware/authenticate.ts:30,47-48` |
| El usuario de BD es `arena`; `postgres` no existe | CODE_VERIFIED + RUNTIME_VERIFIED | compose `POSTGRES_USER: arena`; `SELECT rolname FROM pg_roles` en el entorno aislado; auditoría 2026-10-15 en producción |
| `--init-repo` idempotente y no automático | CODE_VERIFIED | `infrastructure/backup/backup.sh:505-517` |
| 13 dominios del asistente, sin interfaz que lo ejecute | CODE_VERIFIED | `packages/first-run/domains.ts`; sin referencias desde `apps/` |
