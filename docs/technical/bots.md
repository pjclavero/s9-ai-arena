# Bots: código, versiones, build y ejecución

## Resumen

Un **bot** es un registro con dueño y nombre. Su código y su equipamiento se versionan por separado:

- el código en `bot_versions`, con estado y runtime `python` o `node`;
- el equipamiento en `bot_loadouts`, con revisiones.

Para jugar, una versión tiene que pasar por tres pasos:

1. el **pipeline de build** (10 etapas), que la deja `validated`;
2. la **publicación**, que el dueño hace a mano y la deja `published`;
3. la ejecución en una batalla.

**Estado actual: el pipeline rechaza toda versión por construcción** (`rejected`, «sandbox no verificado»). El worker de builds no inyecta el `agentResolver` que ejecuta el bot en un sandbox ([TD-001](../roadmap/technical-debt.md#td-001)). Sin `validated` no hay `published`, y sin `published` no hay batallas ni torneos. Y aun con una versión publicada (por ejemplo, forzada en una BD de pruebas), las batallas de plataforma no ejecutan su código: las conduce `HunterBot` ([TD-002](../roadmap/technical-debt.md#td-002)).

## Índice

- [Qué es](#qué-es)
- [Componentes](#componentes)
- [Estados de versión](#estados-de-versión)
- [Subida del código](#subida-del-código)
- [Pipeline de build](#pipeline-de-build)
- [Artefacto y firma](#artefacto-y-firma)
- [Sandbox y ejecución real](#sandbox-y-ejecución-real)
- [Persistencia](#persistencia)
- [Seguridad](#seguridad)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

- **Bot** (`bots`): `name` (≤48, único por dueño), `owner_id`, `team_id` opcional y `visibility` (`private|team|public`, por defecto `private`).
- **Revisión de loadout** (`bot_loadouts`): `revision`, `catalog_version`, `chassis`, `modules` (jsonb) y `summary`. Se valida en servidor con el validador del catálogo ([equipment.md](equipment.md)).
- **Versión** (`bot_versions`): `version` correlativa, `state`, `runtime`, `loadout_revision` (FK), `source` (bytea), `artifact_hash`, `code_public`, `rejection_reason` y `suspend_reason`.
- **Build** (`builds`): `status` (`queued|running|passed|failed`) y `stages` (jsonb, 10 etapas).
- **Artefacto** (`artifacts`): `hash`, `signature` (ed25519) y `bytes`.

El bot «habla» el protocolo `arena/1` a 10 Hz de decisión: recibe una observación y devuelve un comando. Ver `packages/protocol/README.md` y los SDK `sdks/python`, `sdks/javascript` (con ejemplos en `example-bots/`). La forma de la observación y del comando está en [engine.md](engine.md#observaciones-y-comandos).

## Componentes

| Pieza | Código | Papel |
|---|---|---|
| API de bots | `apps/api/src/routes/bots.ts`, `services/bots.ts` | CRUD, loadouts, versiones, transiciones |
| Encolador | `apps/api/src/services/bot-manager.ts` (`QueueBotManager`) | `submit` → `builds` en `queued` + `jobs.kind='bot_build'` |
| Worker de builds | `apps/bot-manager/src/build-worker-main.ts`, `build-worker.ts` | Reclama `bot_build` y ejecuta el pipeline |
| Adaptador | `apps/api/src/services/e6-bot-manager.ts` (`E6PipelineBotManager`) | Decodifica el paquete, ejecuta `BuildPipeline` y persiste con `completeBuild` |
| Pipeline | `apps/bot-manager/src/pipeline.ts`, `static-analysis.ts`, `secret-scan.ts`, `signing.ts`, `smoke-battle.ts` | Las 10 etapas |
| Sandbox | `apps/bot-manager/src/container-runner.ts`, `docker-proxy*.ts`, `container-battle.ts`, `runtimes/{python,node}/Dockerfile` | Ejecución aislada (sólo en el camino real) |
| Ejecutor de plataforma | `apps/tournament-worker/src/engine-executor.ts` | Batallas con `HunterBot` ([battles.md](battles.md)) |

## Estados de versión

Estados: `draft, validating, rejected, validated, published, frozen, suspended, retired` (`BOT_STATES`, `migrations.ts:23-32`). Las transiciones son explícitas y fuera de ellas la API responde `409 illegal_transition` con `allowedTransitions` (`services/bots.ts:63-96`):

| Acción | Desde | Hacia | Quién |
|---|---|---|---|
| `submit` | draft, rejected | validating | dueño (`developer`); limpia `rejection_reason` |
| `validate` / `reject` | validating | validated / rejected | worker de builds (`completeBuild`) |
| `publish` | validated | published | dueño |
| `freeze` | published | frozen | cierre de inscripciones de torneo |
| `retire` | published | retired | dueño |
| `suspend` | draft…frozen | suspended | `moderator` |

Una versión `frozen` puede jugar batallas de práctica (`POST /battles` acepta `published|frozen`), pero **no puede inscribirse en otro torneo** (exige `published`).

## Subida del código

`POST /bots/{botId}/versions`:

- **Formato**: multipart con `source` (archivo, ≤10 MB, si no `413 source_too_large`), `runtime` (`python|node`) y `loadoutRevision` (debe existir). Crea la versión en `draft`.
- **Rol mínimo**: `developer`. El registro abierto ya lo concede.
- **Límite de ritmo**: 60 por hora.

El contenido se interpreta en `decodePackage` (`services/source-package.ts`):

- **Paquete JSON** `{"files":[{path,content}]}`: se valida con un esquema estricto. Las rutas tienen que ser relativas, normalizadas y sin `..`.
- **Cualquier otro texto** (código pegado): se envuelve en el esqueleto estándar del runtime.
  - Python: `manifest.json`, `requirements.txt`, `requirements.lock` (`arena-sdk==1.0.0`) y `src/bot.py`.
  - Node: `package.json`, `package-lock.json` y `src/bot.js`.

La web sólo ofrece pegar texto (no hay selector de archivo), lo envía como `bot.py`/`bot.js` y por tanto siempre usa el esqueleto ([frontend.md](frontend.md)).

## Pipeline de build

`submit` (`202`) crea `builds` en `queued` con las 10 etapas `pending` y encola `jobs.kind='bot_build'` (`dedupe_key=bot_build:<buildId>`, `max_attempts=3`). El worker ejecuta `BuildPipeline.run` con este orden (`STAGE_ORDER`):

| # | Etapa | Qué comprueba | Ejecución |
|---|---|---|---|
| 1 | `structure` | Runtime conocido, ≥1 fichero, ≤500 ficheros, ≤10 MB, manifiesto (`requirements.txt` o `package.json`) | Lógica pura |
| 2 | `static_analysis` | AST: imports fuera de la allowlist, construcciones dinámicas (`eval`, `__import__`, `require(var)`…), builtins peligrosos (bloqueo por defecto) | Lógica pura |
| 3 | `dependencies` | Lockfile obligatorio (`requirements.lock`/`poetry.lock`, `package-lock.json`/`pnpm-lock.yaml`) y dependencias en la allowlist (`runtimes/*/ALLOWED-PACKAGES.md`) | Lógica pura |
| 4 | `build` | Empaqueta un artefacto reproducible (≤200 MB) y calcula su sha256 | Lógica pura |
| 5 | `protocol_test` | Handshake y comandos válidos | **Necesita `agentResolver`** |
| 6 | `smoke_battle` | Partida de humo (600 ticks) contra un bot de referencia | **Necesita `agentResolver` + `referenceAgent`** |
| 7 | `resource_limits` | Arranque ≤5000 ms, decisión ≤100 ms | **Necesita `agentResolver`** |
| 8 | `secret_scan` | Secretos en el código | Lógica pura |
| 9 | `sign` | Firma ed25519 del hash | Lógica pura (clave del servicio) |
| 10 | `publish` | Marca el artefacto como inmutable (la versión queda `validated`, no `published`) | Lógica pura |

Comportamiento ante un fallo:

- **Fallo en una etapa**: el build queda `failed` y la versión `rejected` con `"<etapa>: <mensaje>"`.
- **Etapa sin entorno de ejecución**: queda `skipped` y bloquea. Al final el build queda `failed` y la versión `rejected` con: «sandbox no verificado: etapa(s) de ejecución no ejecutable(s) [protocol_test, smoke_battle, resource_limits]. Se requiere un entorno con Docker (agentResolver)…».

**Por qué siempre se rechaza hoy**: `build-worker-main.ts:31` construye `new E6PipelineBotManager(db, { signer })` sin `agentResolver` ni `referenceAgent`. Ningún código de producción los construye. La escotilla `allowUnverifiedSandbox` existe sólo para pruebas y la app no la activa. Tener o no Docker no cambia el resultado: el worker no lo usa.

## Artefacto y firma

Con un build `passed`, `completeBuild` pone la versión en `validated` con `artifact_hash` e inserta `artifacts` (`hash`, `signature`, `bytes`, `storage_ref=artifacts/<bot>/<v>/<hash>`). Hoy esto no ocurre en producción. La clave de firma la carga `loadServiceKeypair()` desde el almacén de secretos; sin clave, el worker no arranca. La clave pública se publica en `GET /api/v1/keys/artifact-signing` (extensión).

## Sandbox y ejecución real

Las piezas de ejecución aislada existen y se ejercitan en el arnés operativo `scripts/e2e-real-battle-smoke.ts`:

- `DockerContainerRunner` con los flags de aislamiento de la tabla 18.2 del dosier;
- `s9-docker-proxy` como única vía a Docker;
- imágenes de runtime con digest fijado (`runtimes/DIGESTS.lock`);
- `container-battle.ts`.

En la plataforma sólo las usaría el camino `POST /battles/{id}/run` → arena-engine `POST /run`, que hoy está **apagado** (ver [battles.md](battles.md#los-dos-caminos-de-ejecución)). El pipeline de build no las usa.

Antes de lanzar, el camino real comprueba que cada bot está `published|frozen` y tiene digest firmado (`409 bot_not_ready` / `bot_not_signed`). El worker de plataforma tiene una guarda de firma (`artifactGuard`) que **no está cableada** ([TD-015](../roadmap/technical-debt.md#td-015)).

## Persistencia

Tablas `bots`, `bot_loadouts`, `loadout_modules`, `bot_versions`, `builds`, `artifacts` y `jobs` (detalle de esquema en [database.md](database.md)). La versión guarda el código **en la BD** (`bot_versions.source`, bytea).

## Seguridad

- **Visibilidad**: `canSeeBot` muestra un bot si es público, si eres su dueño o staff, o si es de visibilidad `team` y eres miembro. Lo demás responde 404, sin revelar que existe.
- **Acciones de dueño**: metadatos, loadouts, versiones, `submit`, `publish` y `retire` requieren ser el dueño (`assertOwner`). Si no, `403 Solo el dueño del bot puede hacer esto`.
- **Código fuente**: `GET …/versions/{v}/source` lo devuelve al dueño, a sus compañeros de equipo, a staff, o a cualquiera si la versión es `published` con `code_public=true`. La web siempre publica con `codePublic:false`.
- **Huecos conocidos** ([TD-005](../roadmap/technical-debt.md#td-005)):
  - cualquier usuario puede usar bots privados ajenos como participantes de una batalla de práctica;
  - `GET /bots/{id}/rating-history` es legible para bots privados ajenos.

## Errores / limitaciones

- Ninguna versión llega a `validated` ([TD-001](../roadmap/technical-debt.md#td-001)). El botón «Reenviar» de la web no sirve: el rechazo es de la plataforma, no del código.
- El código subido nunca se ejecuta en batallas de plataforma ([TD-002](../roadmap/technical-debt.md#td-002)).
- Bot↔equipo: sólo se asigna con `teamId` al crear el bot por API. `PATCH /bots/{id}` sólo acepta `name` y `visibility` ([TD-011](../roadmap/technical-debt.md#td-011)).
- No existe borrado de bots ni de versiones.
- Doble clic en «Crear bot»: la carrera con `UNIQUE(owner_id,name)` puede dar `500` ([TD-013](../roadmap/technical-debt.md#td-013)).

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear bot, guardar y recuperar loadouts (validación 422 con violaciones legibles), subir versiones, encolar y ejecutar el pipeline, y rechazos con motivo visible.
- **PARCIAL**: visibilidad y edición sólo por API; código fuente sólo por API.
- **PENDIENTE**: `agentResolver` real en el build, ejecución del código del bot en batallas, asignación de bot a equipo y borrado.

## Documentación relacionada

- Usuario: [Bots](../user/bots.md), [Equipamiento](../user/equipment.md)
- Técnica: [equipment.md](equipment.md), [battles.md](battles.md), [engine.md](engine.md), [api.md](api.md), [frontend.md](frontend.md)
- Arquitectura (A): [workers.md](workers.md), [queue.md](queue.md), [security.md](security.md)
- Operación (C): [docker-proxy.md](../operations/docker-proxy.md), [configuration.md](../operations/configuration.md)
- Histórico absorbido: B11 (panel de versiones), paridad de SDK (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| El worker de builds no inyecta `agentResolver` | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:31` |
| Sin `agentResolver`, las etapas 5-7 quedan `skipped` y la versión `rejected` | CODE_VERIFIED | `apps/bot-manager/src/pipeline.ts:116-194,457-463` |
| Rechazo determinista en navegador real (main y runtime de producción) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1c |
| En producción, las 12 versiones `rejected` y los 22 builds `failed` | RUNTIME_VERIFIED | Auditoría 2026-10-15, A pasada 1 (lectura de BD) |
| Orden de las 10 etapas | CODE_VERIFIED | `apps/bot-manager/src/types.ts:19-30`; `apps/api/src/services/bot-manager.ts:13-24` |
| Límites: 10 MB, 500 ficheros, 200 MB, 100 ms, 5000 ms, 600 ticks | CODE_VERIFIED | `apps/bot-manager/src/config.ts:138-162` |
| Código pegado se envuelve en esqueleto con lockfile | CODE_VERIFIED | `apps/api/src/services/source-package.ts:94-134` |
| Transiciones de estado y 409 | CODE_VERIFIED | `apps/api/src/services/bots.ts:63-96` |
| `completeBuild` → `validated` + `artifacts` | CODE_VERIFIED | `apps/api/src/services/bot-manager.ts:79-124` |
| Reglas de visibilidad y de acceso al código | CODE_VERIFIED | `apps/api/src/services/bots.ts:29-55`; `routes/bots.ts:303-325` |
| `PATCH /bots` ignora `teamId` | CODE_VERIFIED | `apps/api/src/routes/bots.ts:170-187` |
| Bots privados ajenos usables en batalla | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/battles.ts:411-419`; auditoría B p2 §5 |
| El sandbox real se ejercita en el arnés de smoke | DESIGN_ONLY en esta consolidación (no re-ejecutado) | `scripts/e2e-real-battle-smoke.ts`; `apps/bot-manager/src/container-runner.ts` |
