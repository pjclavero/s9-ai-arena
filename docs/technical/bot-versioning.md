# Versionado de bots

## Resumen

El versionado de bots vive **en la base de datos de la plataforma**, sin Git:
`bots` → `bot_versions` → `builds` → `artifacts`. Cada versión guarda su propio código, el
build que la validó y el artefacto firmado de ese build. Desde la migración `012_bot_versioning`,
una versión que ya no es `draft` **no se puede modificar ni borrar**: lo impide un trigger de
PostgreSQL. La API permite listar versiones y ver el detalle, el código, el artefacto y el diff
entre dos versiones. También permite crear una versión nueva a partir de otra. Una batalla
referencia la versión exacta `(bot_id, version)`, nunca «la última».

Decisión de la auditoría A9 (cierre funcional 2026-10): **`VERSIONING_BACKEND = EXISTING_DB_MODEL`**,
ampliado. No había ningún Git en el proyecto y el modelo existente basta para todos los requisitos.

## Índice

- [Qué es](#qué-es)
- [Decisión de backend](#decisión-de-backend)
- [Modelo](#modelo)
- [Inmutabilidad](#inmutabilidad)
- [API](#api)
- [Diff y clonado](#diff-y-clonado)
- [Relación con las batallas](#relación-con-las-batallas)
- [Permisos](#permisos)
- [Backup](#backup)
- [Uso](#uso)
- [Ejemplo](#ejemplo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

El modelo funcional es `Bot → Versión N → {source, build, artefacto}`. El usuario y la web trabajan
sólo con esos conceptos y no ven ningún detalle del almacenamiento. Las versiones se numeran de
forma correlativa (v1, v2…) por bot. La clave natural es `(bot_id, version)`, y además existe
`bot_versions.id` (uuid).

## Decisión de backend

Lo que se encontró al auditar `0b8c12b`:

| Pieza | ¿Existe? | Qué es |
|---|---|---|
| Gitea / Forgejo / GitLab / bare repos / `git init --bare` | NO | ningún rastro en código, compose, Dockerfiles, scripts ni documentación |
| simple-git / isomorphic-git / nodegit / libgit2 | NO | ninguna dependencia en `package-lock.json` |
| `git` en código de producto | NO | sólo en `infrastructure/scripts/release-gate.mjs` y en tests (CI/operación, no versionado de bots) |
| GHCR (`ghcr.io/pjclavero/s9-ai-arena/*`) | SÍ | registro de **imágenes** Docker: servicios y runtimes de bots fijados por digest |
| `s9-localreg` (`registry:2`) | SÍ, efímero | registro local de **imágenes** que crea `bots/s9-smoke-bot/build.sh --local` para el smoke bot. No guarda código de usuario |
| Volúmenes `arena_bot_sources` y `arena_build_cache` | declarados y montados | **ningún código los usa**: el source vive en `bot_versions.source` (bytea) |

Un Docker Registry no es un repositorio Git: guarda imágenes por digest, no historial de ficheros.
Con un Git nuevo sólo se ganaría branching y merge, y el producto no los pide. Historial, código por
versión, build y artefacto por versión, diff, clonado y reproducción histórica salen del modelo de
BD con una migración pequeña. Por eso no se añade Git.

## Modelo

| Tabla | Columnas relevantes | Papel |
|---|---|---|
| `bots` | `owner_id`, `team_id`, `visibility` | identidad y propiedad |
| `bot_versions` | `version`, `state`, `runtime`, `loadout_revision`, `source` (bytea), `source_filename`, `source_sha256`, `parent_version`, `artifact_hash`, `validated_build_id`, `code_public`, `published_at` | una versión = un código inmutable |
| `builds` | `(bot_id, version)` FK, `status`, `stages` (jsonb con mensajes, logs y métricas), `artifact_hash` | cada intento de pipeline de una versión |
| `artifacts` | `build_id` (UNIQUE), `hash`, `signature`, `bytes`, `size_bytes` | el paquete canónico `arena-artifact/v1` firmado de UN build |
| `participants` | `(bot_id, version)` FK `ON DELETE RESTRICT` | qué versión jugó cada batalla |

Columnas añadidas por `012_bot_versioning`:

- `source_sha256`: la calcula la BD (trigger) con `sha256(source)`.
- `parent_version`: «nueva versión desde X». Tiene una FK a `(bot_id, version)` y un `CHECK parent_version < version`.
- `validated_build_id`: el build que produjo el artefacto de la versión. Se rellena en `completeBuild`.
- `artifacts_build_unique`: un artefacto por build.

La migración rellena las filas antiguas: `source_sha256`, y `validated_build_id` desde el build
`passed` más reciente con el mismo hash.

## Inmutabilidad

El trigger `bot_versions_guard` (BEFORE INSERT/UPDATE/DELETE) aplica estas reglas:

- **Siempre fijos**: `id`, `bot_id`, `version`, `parent_version` y `created_at`.
- **Fijos fuera de `draft`**: `source`, `source_filename`, `runtime` y `loadout_revision`.
- **`artifact_hash` y `validated_build_id`**: sólo cambian cuando la versión está en `validating`, que es el momento en que `completeBuild` la valida.
- **`code_public`**: una vez a `true`, no vuelve a `false` (D9).
- **Borrado**: una versión que no es `draft` no se puede borrar.

Cualquier violación lanza `bot_version_immutable` (SQLSTATE `23000`), venga de la API, de un
script o de SQL directo. Para cambiar el código hay que crear una versión nueva, por ejemplo con la
acción de clonado, y editar esa.

## API

| Operación | Ruta | Quién |
|---|---|---|
| `listBotVersions` | `GET /bots/{id}/versions` | quien ve el bot |
| `getBotVersion` | `GET /bots/{id}/versions/{v}` | quien ve el bot. Devuelve versión, `latestBuild`, `artifact` y `childVersions`. Incluye `sourceSha256` sólo si puedes leer el código |
| `getBotSource` | `GET …/{v}/source` | regla de código ([Permisos](#permisos)) |
| `getBotVersionFiles` | `GET …/{v}/files` | regla de código. Devuelve el paquete decodificado en ficheros |
| `getBotVersionArtifact` | `GET …/{v}/artifact` | quien ve el bot. Devuelve hash, firma, tamaño y build, sin bytes |
| `listBotVersionBuilds` / `getBuild` | `GET …/{v}/builds`, `GET /builds/{id}` | quien ve el bot. Los logs sólo los ven el dueño y el staff |
| `diffBotVersions` | `GET …/{v}/diff?against=N` | regla de código sobre **las dos** versiones |
| `cloneBotVersion` | `POST …/{v}/actions/clone` | dueño (`developer`) |
| `createBotVersion` | `POST /bots/{id}/versions` + `parentVersion` opcional | dueño (`developer`) |

## Diff y clonado

- **Diff** (`services/bot-version-diff.ts`):
  - decodifica los dos paquetes con el mismo `decodePackage` que usa el pipeline;
  - compara fichero a fichero con un LCS de líneas;
  - devuelve, por fichero, `status` (`added|removed|modified|unchanged`), `additions`, `deletions` y un diff unificado con 3 líneas de contexto.
  - Un fichero de más de 4000 líneas se marca como modificado sin hunks.
- **Clonado**: crea la versión siguiente en `draft`. Copia `source`, `source_filename` y `runtime`, y el loadout de origen salvo que se pase otro `loadoutRevision`. Registra `parent_version`. La versión de origen no se toca, y el test lo comprueba comparando la fila entera.
- **Numeración**: si dos peticiones chocan en `UNIQUE(bot_id, version)`, la API reintenta con el número siguiente.

## Relación con las batallas

- `participants.version` guarda la versión que se pidió. La FK impide borrarla.
- Como la versión es inmutable, `(bot_id, version)` identifica de forma unívoca el código, el build y el artefacto que jugaron.
- `battleCodeProvenance(db, battleId)` (`services/bot-provenance.ts`) responde «¿qué código ejecutó este bot en esta batalla?»: `botVersionId`, `sourceSha256`, `artifactHash` y `buildId` de cada participante. No depende de la versión actual ni del último artefacto.
- `resolveBotLaunch(db, botId, version)` (`apps/bot-manager/src/bot-launch.ts`) es lo que usa el worker de batallas para arrancar el bot:
  - exige `published|frozen`;
  - toma el artefacto del build de **esa** versión (`findVersionArtifact`, nunca «el último con ese hash»);
  - verifica sha256 y firma ed25519;
  - devuelve la imagen de runtime fijada por digest y el bootstrap.

## Permisos

Hay una regla única, `canReadSource`, para el código. Pueden leerlo:

- el dueño;
- un miembro del equipo del bot;
- el staff (moderador o admin);
- cualquiera, si la versión está `published` con `code_public=true`.

Además:

- Quien no ve el bot (privado y ajeno) recibe **404** en todo: versiones, detalle, código, ficheros, artefacto, diff y clonado.
- En un bot público con el código privado, un tercero ve los metadatos pero recibe **403** en código, ficheros y diff, y también al intentar clonar.

## Backup

No hay nada nuevo que copiar. El código, los builds y los artefactos están en PostgreSQL y entran en
el `pg_dump` del backup existente ([operación](../operations/backup.md)). El trigger y su función se
restauran con el esquema.

## Uso

Desde la web: **«Mis bots» → «detalle y versiones»** (`#/bots/<id>`) → pestaña **Versions**
([guía de usuario](../user/bots.md)). Por API: las rutas de la tabla anterior.

## Ejemplo

```text
GET  /api/v1/bots/<id>/versions/2/diff?against=1
→ { "from": 1, "to": 2, "files": [ { "path": "src/bot.py", "status": "modified",
     "additions": 1, "deletions": 1, "diff": "@@ -6,7 +6,7 @@\n…\n-  …0.8…\n+  …0.9…" }, … ] }

POST /api/v1/bots/<id>/versions/1/actions/clone   {}
→ 201 { "version": 4, "state": "draft", "parentVersion": 1, … }
```

## Errores / limitaciones

- **Sin ramas ni merge**: el historial es lineal por bot. `parent_version` sólo registra de qué versión se partió.
- **Diff de texto**: es por líneas. Los ficheros binarios no se tratan aparte, porque los bots son texto.
- **Edición del código**: el editor de la web trabaja sobre el fichero de entrada (`src/bot.py`/`src/bot.js`). Un paquete de varios ficheros se edita subiendo un paquete nuevo por API.
- **Sin borrado**: no existe borrar bots ni versiones, ni siquiera borradores, desde la API.

## Estado actual

- **FUNCIONA ACTUALMENTE**:
  - inmutabilidad en BD;
  - historial con código, build y artefacto por versión;
  - diff;
  - clonado;
  - procedencia de batalla;
  - permisos;
  - vista Versions en la web.

  Todo verificado por tests y por mutaciones calibradas.
- **PARCIAL**: el endpoint HTTP de procedencia por batalla. La función existe, pero exponerla en `GET /battles/{id}` corresponde al carril de batallas.

## Documentación relacionada

- [bots.md](bots.md) (pipeline y sandbox) · [battles.md](battles.md) · [database.md](database.md) · [api.md](api.md)
- Usuario: [Bots](../user/bots.md)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001)

## Verificación

Verificado sobre la rama `fc/dev-a-bots` (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| Migración y trigger de inmutabilidad | CODE_VERIFIED | `apps/api/src/db/migrations.ts:693`, `:743`, `:764` |
| La BD rechaza sobrescribir o borrar una versión validada | RUNTIME_VERIFIED (PostgreSQL de test) | `apps/api/src/fc-a-bot-versioning.test.ts` «A9.10». Mutación M3 → rojo |
| `validated_build_id` se fija al validar | CODE_VERIFIED | `apps/api/src/services/bot-manager.ts:113` |
| Artefacto de la versión, no «el último con ese hash» | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/bot-manager/src/launch-verify.ts:34`. Mutación M7 → rojo |
| v1, v2 y v3 con source, build y artefacto propios | RUNTIME_VERIFIED | `fc-a-bot-versioning.test.ts` «A9.17» |
| Batalla con v1 sigue en v1 tras publicar v2 | RUNTIME_VERIFIED | «A9.14/15». Mutaciones M4 y M5 → rojo |
| Regla única de lectura de código y 404/403 a terceros | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/routes/bots.ts:82`. «A9.16». Mutación M6 → rojo |
| Diff y clonado | RUNTIME_VERIFIED | `apps/api/src/services/bot-version-diff.ts:91`; `routes/bots.ts:457`, `:480` |
| No hay Git en el proyecto | CODE_VERIFIED | búsqueda de `gitea\|forgejo\|gitlab\|simple-git\|isomorphic-git\|nodegit\|init --bare` sin resultados en `0b8c12b` |
