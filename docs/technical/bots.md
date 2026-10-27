# Bots: código, versiones, build y ejecución

## Resumen

Un **bot** es un registro con dueño y nombre. Su código y su equipamiento se versionan por separado:

- el código en `bot_versions`, con estado y runtime `python` o `node`;
- el equipamiento en `bot_loadouts`, con revisiones.

Para jugar, una versión tiene que pasar por tres pasos:

1. el **pipeline de build** (10 etapas), que la deja `validated`;
2. la **publicación**, que el dueño hace a mano y la deja `published`;
3. la ejecución en una batalla.

**Estado actual (integración `integration/functional-closure`):**

- **Pipeline.** El código del usuario se ejecuta de verdad en un **contenedor** durante el build. Tres etapas lo hacen: `protocol_test`, `smoke_battle` y `resource_limits` (`ContainerBuildSandbox`).
  - Un bot válido llega a `validated` y, publicado por su dueño, a `published`.
  - Lo demuestra un E2E con Docker, sin tocar la BD.
  - El worker cablea el sandbox desde `DOCKER_PROXY_URL` y `BUILD_SANDBOX_HOST`. Sin ellos sigue fallando cerrado, como antes.
  - En el despliegue hacen falta cambios de compose ([Errores / limitaciones](#errores--limitaciones)).
- **Batallas.** Siguen sin ejecutar el código del usuario hasta que el carril de batallas consuma `resolveBotLaunch` ([TD-002](../roadmap/technical-debt.md#td-002)).
- **Versionado.** Ver [bot-versioning.md](bot-versioning.md).

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
| Cableado del worker | `apps/bot-manager/src/build-worker-wiring.ts` | Construye el executor con el sandbox real a partir del entorno. Lo comparten `build-worker-main.ts` y el E2E |
| Sandbox del build | `apps/bot-manager/src/build-sandbox.ts` (`ContainerBuildSandbox`) | Una sesión de contenedor por build alimenta las etapas 5 a 7 |
| Anfitrión del sandbox | `apps/bot-manager/src/sandbox-host.ts` (`SandboxHost`) | HTTP y WebSocket en un mismo puerto: sirve el artefacto con token y aloja el ProtocolServer |
| Arranque del código | `apps/bot-manager/src/bot-launch.ts`, `sandbox-bootstrap/bootstrap.{py,mjs}` | Imagen de runtime (DIGESTS.lock), bootstrap, `launchSpecForBot` y `resolveBotLaunch` (batallas) |
| Runner y proxy | `apps/bot-manager/src/container-runner.ts`, `docker-proxy*.ts`, `container-battle.ts`, `runtimes/{python,node}/Dockerfile` | Ejecución aislada; única vía hacia Docker |
| Ejecutor de plataforma | `apps/tournament-worker/src/engine-executor.ts` | Batallas con el código de cada bot (`containerAgents`) y su loadout ([battles.md](battles.md)) |

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
| 7 | `resource_limits` | Decisión ≤100 ms, sin OOM, métricas de arranque (TD-034) | **Necesita `agentResolver`** |
| 8 | `secret_scan` | Secretos en el código | Lógica pura |
| 9 | `sign` | Firma ed25519 del hash | Lógica pura (clave del servicio) |
| 10 | `publish` | Marca el artefacto como inmutable (la versión queda `validated`, no `published`) | Lógica pura |

Comportamiento ante un fallo:

- **Fallo en una etapa**: el build queda `failed` y la versión `rejected` con `"<etapa>: <mensaje>"`.
- **Etapa sin entorno de ejecución** (worker sin sandbox configurado): queda `skipped` y bloquea. Al final el build queda `failed` y la versión `rejected` con «sandbox no verificado: …».
- **Fallo de la plataforma del sandbox** (`SandboxInfrastructureError`: proxy caído, imagen ausente, postura no conforme, motor colgado, arranque de la plataforma por encima de `SANDBOX_STARTUP_TIMEOUT_MS`, artefacto no descargable o con sha256 distinto): **no es culpa del bot**. Cuando falla el arranque, el mensaje lleva la etiqueta `[sandbox_start_timeout]` o `[sandbox_start_failed]`.
  - El pipeline lo propaga y el worker reintenta con backoff, hasta 3 intentos.
  - Agotados los intentos, el trabajo queda `needs_review` y la versión `rejected` con «build no verificable: …». Nunca queda `validated`.
- **Progreso**: mientras corre, el build está `running`. Al terminar, cada etapa guarda en `builds.stages` lo siguiente:
  - `message`, `startedAt` y `finishedAt`;
  - `logs`, privados para el dueño y el staff;
  - `metrics`.

### Etapas de ejecución en el sandbox

Una sola sesión por build (`ContainerBuildSandbox.verify`):

1. **Anfitrión.** Se abre un `SandboxHost` en un puerto libre. Se ofrece el artefacto empaquetado en la etapa `build` (los bytes canónicos `arena-artifact/v1`) con un token aleatorio.
2. **Contenedor.** Se lanza con `ProxyContainerRunner` a través de `s9-docker-proxy`, con esta configuración:
   - imagen de runtime `python|node` fijada por digest en `runtimes/DIGESTS.lock`;
   - usuario 10001, `cap-drop ALL` y `no-new-privileges`;
   - seccomp `security/seccomp-bot.json` (permite `sendmmsg`, que glibc usa al resolver el nombre anunciado del worker; [TD-061](../roadmap/technical-debt.md#td-061));
   - rootfs de solo lectura y `/tmp` tmpfs de 32 MiB (`noexec`);
   - red `arena` sin DNS;
   - 0,5 CPU, 256 MiB sin swap y 64 PIDs;
   - `AutoRemove`.

   El proxy (RC2) lo hace cumplir, no sólo lo admite: la imagen debe ser **exactamente** una de la 3.ª
   columna de `DIGESTS.lock` (otra imagen, la base o un tag → 403), los límites son obligatorios y con
   techo, y el contenedor sale con las labels `s9.managed=true` y `s9.proxy.instance`, que el proxy
   exige después para `start`/`stop`/`json`/`stats` (por Id completo). Un bot o un servicio no puede
   operar contenedores que no haya creado el proxy. Detalle en
   [docker-proxy.md](../operations/docker-proxy.md#política-rc2).
3. **Bootstrap.** Corre como `Cmd` tras el `ENTRYPOINT` del runtime:
   - descarga el artefacto con el token y verifica el sha256;
   - lo materializa en `/tmp/bot`;
   - carga el SDK (`arena_sdk` / `@arena/sdk`) de la imagen de runtime;
   - envía la señal **`ready`** (`POST ARTIFACT_URL/ready`, con el token) y espera la respuesta: a partir de aquí todo lo que se ejecuta es código del usuario ([TD-034](#arranque-dos-relojes-td-034));
   - carga el fichero de entrada: `manifest.entry` o `src/bot.py` en Python; `package.json main` o `src/bot.js` en Node;
   - instancia la subclase de `ArenaBot` (en Python, `Bot` o la única definida; en Node, `export default`, `Bot` o la única exportada);
   - **comprueba el hook (UX-04)**: la clase (o un ancestro distinto de `ArenaBot`) debe sobrescribir `on_observation` / `onObservation` o el despachador interno (`_handle_observation` / `handleObservation`: desde UX-F cuenta en los dos runtimes); si no, falla con `kind: "hook"` y sugiere el nombre propio más parecido («¿Quisiste decir «on_observaton»?»). Antes una clase con el hook mal escrito heredaba el `{}` de `ArenaBot` y pasaba las 10 etapas sin hacer nada. En **batalla** la comprobación no rechaza: ver [Política del hook para versiones ya publicadas](#política-del-hook-para-versiones-ya-publicadas-def-r4);
   - llama a `run(WS_URL, BATTLE_TOKEN)`.

   Si algo falla, informa a `ARTIFACT_URL/report` (`kind` + traza) y sale con un código distinto de 0. `apps/bot-manager/src/user-error.ts` resume la traza como «fichero, línea: error» con la ruta DENTRO del paquete (`src/bot.py, línea 7: NameError…`), sin las rutas del sandbox; la web la muestra en el diagnóstico del build (fase, fichero y línea, que la versión no está publicada y qué hacer). Antes de `ready`, los `kind` de plataforma (`config`, `fetch`, `integrity`, `materialize`, `sdk`) son infraestructura y los del paquete (`manifest`, `entry`) son del bot. Después de `ready`, **cualquier** informe es del bot: su código ve `ARTIFACT_URL`/`ARTIFACT_TOKEN` y podría falsear un `kind` de plataforma. Los del bot llegan al motivo de rechazo.
4. **Postura.** Se inspecciona la postura real del contenedor con `complianceViolations`. Si no es conforme, es un fallo de plataforma.
5. **Readiness.** `awaitAgentReady` (`startup-clock.ts`) espera la señal `ready` y el HELLO aceptado por el ProtocolServer con los dos relojes de abajo; despierta con cada señal y sondea el estado real del contenedor (salida temprana). Nunca duerme a ciegas.
6. **Partida de humo.** El candidato hace el handshake y juega en el motor real (`dm_practice@1`, `emptyArena`, `smokeBattleTicks` ticks) contra el bot de referencia `HunterBot` (E5). El vehículo del candidato es el **loadout de la versión** (`smoke-vehicle.ts`, UX-01), el mismo que juega en batalla; el arquetipo del chasis sólo es reserva si el loadout falta o es de otra versión de catálogo, y se dice en el log de la etapa.

Veredictos:

| Etapa | Pasa si | Falla con |
|---|---|---|
| `protocol_test` (hook) | la clase implementa el hook | «tu clase Bot no implementa on_observation(self, observation): sin él el bot no hace nada en la batalla.» + sugerencia |
| `protocol_test` | la plataforma deja el agente `ready` en `SANDBOX_STARTUP_TIMEOUT_MS` (si no, infraestructura), el código del bot hace HELLO en `BOT_EXECUTION_TIMEOUT_MS` desde `ready`, todo mensaje valida contra `envelope.schema.json` y hay ≥1 `COMMAND` válido | «el bot no completó el handshake (HELLO): … [timeout_reason=bot_execution_timeout\|bot_crash]», «mensaje(s) fuera de protocolo…», «ningún COMMAND válido…» más la traza del bootstrap |
| `smoke_battle` | la batalla termina y el candidato no está descalificado | «candidato descalificado en la partida de humo…» |
| `resource_limits` | p95 de decisión ≤ `maxDecisionMs` (100 ms) y sin OOM | «decisión p95 …», «OOM» |

Los límites duros de CPU, memoria y PIDs los impone el cgroup. Las métricas quedan en la etapa `resource_limits` (y, si el bot no arrancó, en `protocol_test`):

| Métrica | Qué mide | Reloj |
|---|---|---|
| `launchMs` | create + start en la Engine (petición → contenedor devuelto) | plataforma |
| `artifactFetchMs` | petición de lanzamiento → primera descarga servida del artefacto | plataforma |
| `startupMs` | petición de lanzamiento → señal `ready` | plataforma (`SANDBOX_STARTUP_TIMEOUT_MS`) |
| `botReadyToHelloMs` | `ready` → HELLO aceptado | bot (`BOT_EXECUTION_TIMEOUT_MS`) |
| `executionMs` | HELLO → fin de la partida de humo | ejecución (decisiones con `maxDecisionMs`) |
| `startedAtToHelloMs` | `State.StartedAt` → HELLO; informativo, es el tramo que juzgaba el código anterior | mezcla |
| `sandboxStartupTimeoutMs`, `botExecutionTimeoutMs` | plazos **efectivos** aplicados en esa sesión | — |
| `p95DecisionMs`, `maxDecisionMs`, `validCommands`, `cpuMs`… | como antes | ejecución |

### Arranque: dos relojes (TD-034)

Antes, `resource_limits` exigía ≤ 5000 ms desde `State.StartedAt` hasta el HELLO. Ese tramo incluye trabajo de la plataforma (init del intérprete, descarga y verificación del artefacto, carga del SDK), así que bajo carga del host un bot válido quedaba `rejected`. Ahora (`apps/bot-manager/src/startup-clock.ts`, compartido con el worker de batallas):

| Reloj | Variable (def.) | Desde → hasta | Si se agota |
|---|---|---|---|
| Plataforma | `SANDBOX_STARTUP_TIMEOUT_MS` (30000) | petición de lanzamiento → señal `ready` del bootstrap (incluye create/start de la Engine) | **infraestructura**: `SandboxInfrastructureError [sandbox_start_timeout]` → reintento → «build no verificable». Nunca rechazo del bot |
| Bot | `BOT_EXECUTION_TIMEOUT_MS` (5000) | `ready` → HELLO (import del código del usuario, constructor, conexión) | **bot**: `protocol_test` falla con `timeout_reason=bot_execution_timeout` |

Clasificación de fallos de arranque:

- **Infraestructura** (`[sandbox_start_failed]`): la Engine no crea o arranca el contenedor (p. ej. imagen de runtime ausente), el contenedor muere antes de `ready` sin informe, o el bootstrap informa `config`/`fetch`/`integrity`/`materialize`/`sdk`.
- **Bot** (`timeout_reason=bot_crash`): informe `manifest`/`entry` antes de `ready`, o cualquier informe o salida del proceso después de `ready` (incluido un `fetch` falseado por el código del usuario).
- Si la señal `ready` se pierde pero el HELLO llega a tiempo, el bot pasa (el HELLO prueba la readiness); el tramo del bot no se mide aparte y lo dice el log.

Los plazos se parsean una vez (`startupTimeoutsFromEnv`); un valor que no sea un entero de 1 a 600000 ms hace fallar el arranque del servicio. El `handshakeTimeoutMs` del ProtocolServer (conexión → HELLO) usa `BOT_EXECUTION_TIMEOUT_MS`. `maxStartupMs` de `PipelineConfig` sólo se usa en la medición en proceso (sin sandbox).

### Política del hook para versiones ya publicadas (DEF-R4)

El bootstrap es el mismo en el build y en la batalla, así que la comprobación del hook de UX-04 se aplicaba también al **lanzar en batalla** versiones publicadas antes de que existiera. Una de esas versiones (p. ej. con `on_observaton`) jugaba hasta entonces quieta, devolviendo `{}`; con la comprobación pasaba a perder por «No arrancó: el proceso del bot falló al arrancar», porque el worker reducía el informe `hook` a `bot_crash`.

Decisión (criterio conservador: no romper bots que hoy juegan; no hubo recuento de producción disponible):

| Dónde | `S9_HOOK_POLICY` | Clase sin hook |
|---|---|---|
| Build (`build-sandbox.ts`, por defecto en `launchSpecForBot`) | `reject` | **se rechaza** con `kind: "hook"`: ninguna versión NUEVA se publica sin hook |
| Batalla (`createBattleLaunchHost`) | `warn` | **juega** como antes (quieta, COMMAND vacíos); el bootstrap envía el aviso `hook_missing` |

- El aviso no es un fallo de arranque (`WARNING_REPORT_KINDS` en `startup-clock.ts`; `SandboxHost` lo expone en `signals.warnings()`, no en `failure()`).
- El diagnóstico del dueño (`participants.diagnostics`) lleva `startup: { ok: true, warning: "hook_missing" }` y la web dice: «Tu versión publicada vN no implementa on_observation (Python) / onObservation (JavaScript): tu código no decide nada y el bot jugó quieto. Implementa el hook y publica una versión nueva.» Sólo lo ven el dueño y el staff (TD-047).
- Si un bootstrap sí rechaza por el hook (`kind: "hook"`), el motivo propagado es `hook_missing` (`SportingFailure.startupReason`), nunca `bot_crash` a secas.
- Por qué no rechazar en batalla: una derrota por «no arrancó» de una versión que ayer jugaba cambia resultados y ranking de bots ya inscritos (torneos congelados) sin que su dueño pueda hacer nada dentro de la competición. Por qué no tolerar en el build: el falso verde de UX-04.

## Artefacto y firma

Con un build `passed`, `completeBuild` hace dos cosas:

- pone la versión en `validated` con `artifact_hash` y `validated_build_id`;
- inserta `artifacts`: `hash`, `signature`, `bytes` y `storage_ref=artifacts/<bot>/<v>/<hash>`. Es único por `build_id`.

El artefacto es el paquete canónico `arena-artifact/v1`, cuyo sha256 se firma. **No es un digest de imagen Docker.** La clave de firma la carga `loadServiceKeypair()` desde el almacén de secretos; sin clave, el worker no arranca. La clave pública se publica en `GET /api/v1/keys/artifact-signing` (extensión).

## Sandbox y ejecución real

El sandbox lo usa el **pipeline de build** ([Etapas de ejecución](#etapas-de-ejecución-en-el-sandbox)).

Para las **batallas**, el contrato para arrancar una versión publicada es `resolveBotLaunch(db, botId, version)` más `launchSpecForBot(...)` en `bot-launch.ts`. Devuelve:

- la imagen de runtime;
- el bootstrap;
- el artefacto firmado y verificado.

El proceso que aloja el ProtocolServer ofrece el artefacto con `SandboxHost` y pasa su `wss` al ProtocolServer. Hasta que el carril de batallas lo consuma, el camino de batallas sigue como describe [battles.md](battles.md#autoridad-única-de-ejecución). Ojo: `battle-run-http-launcher.ts` usa `artifact_hash` como `imageDigest`, y eso no arranca nada.

Antes de lanzar, el camino real comprueba que cada bot está `published|frozen` y tiene digest firmado (`409 bot_not_ready` / `bot_not_signed`). El worker de plataforma tiene una guarda de firma (`artifactGuard`) que **no está cableada** ([TD-015](../roadmap/technical-debt.md#td-015)).

## Persistencia

Tablas `bots`, `bot_loadouts`, `loadout_modules`, `bot_versions`, `builds`, `artifacts` y `jobs` (detalle de esquema en [database.md](database.md)). La versión guarda el código **en la BD** (`bot_versions.source`, bytea). Desde `012_bot_versioning`, la BD impide modificarla fuera de `draft`. Historial, diff y clonado: [bot-versioning.md](bot-versioning.md).

## Seguridad

- **Visibilidad**: `canSeeBot` muestra un bot si es público, si eres su dueño o staff, o si es de visibilidad `team` y eres miembro. Lo demás responde 404, sin revelar que existe.
- **Acciones de dueño**: metadatos, loadouts, versiones, `submit`, `publish` y `retire` requieren ser el dueño (`assertOwner`). Si no, `403 Solo el dueño del bot puede hacer esto`.
- **Código fuente**: `GET …/versions/{v}/source` lo devuelve al dueño, a sus compañeros de equipo, a staff, o a cualquiera si la versión es `published` con `code_public=true`. La web siempre publica con `codePublic:false`.
- **Cerrado en la integración** ([TD-005](../roadmap/technical-debt.md#td-005)): un bot privado ajeno ya no entra en una batalla (`404`) y su `rating-history` da `404` (con `Cache-Control: private` para el dueño). Lo prueba `apps/api/src/fc-review-security.test.ts`.
- **Hueco conocido** ([TD-047](../roadmap/technical-debt.md#td-047)): `GET /battles`, `/battles/{id}` y sus stats muestran `botId` y versión de los participantes aunque el bot sea privado.

## Errores / limitaciones

- **Despliegue pendiente** ([TD-001](../roadmap/technical-debt.md#td-001)). Integrado por REVIEW: el compose ya da al `bot-build-worker` la red `arena`, `DOCKER_PROXY_URL`, `extra_hosts` y `BUILD_SANDBOX_HOST`, y las imágenes copian `runtimes/DIGESTS.lock`. Falta desplegarlo (recrear el servicio) con el `s9-docker-proxy` corriendo en el host. Sin proxy, el worker arranca y lo anuncia («sin sandbox: todo build se rechazará»).
- **Lanzamiento en batalla**: `createBattleLaunchHost` (`apps/bot-manager/src/bot-launch.ts`) es el contrato con el tournament-worker: verifica con la clave PÚBLICA (`ARTIFACT_VERIFY_KEY_FILE`) y sirve el artefacto firmado de la versión exacta. Ver [battles.md](battles.md#7-worker-motor-y-agentes).
- **Superficie nueva** ([TD-033](../roadmap/technical-debt.md#td-033)): el worker de builds (y el de batallas) escucha, en la red `arena`, un puerto efímero con token mientras dura cada sesión, y ese mismo proceso tiene credenciales de BD (red `data`). Deuda aceptada.
- **Arranque** ([TD-034](../roadmap/technical-debt.md#td-034), cerrado en la integración `integration/production-readiness`, verificado por REVIEW y en CI real; sin desplegar): dos relojes separados por la señal `ready` del bootstrap ([detalle](#arranque-dos-relojes-td-034)). Límite que queda: el reloj del bot sigue siendo de pared, así que un bot cuyo import consume mucha CPU puede acercarse a los 5 s con 0,5 CPU y el host saturado (en la prueba de saturación, `botReadyToHelloMs` máx. 619 ms).
- **Red del E2E local**: la red `arena` del Docker rootless no es `internal`, porque el worker es el proceso de test en el host. En compose sí lo es.
- El código subido se ejecuta en batallas de plataforma (integración REVIEW, [TD-002](../roadmap/technical-debt.md#td-002)) en entorno aislado; en producción, al desplegar.
- Bot↔equipo: sólo se asigna con `teamId` al crear el bot por API. `PATCH /bots/{id}` sólo acepta `name` y `visibility` ([TD-011](../roadmap/technical-debt.md#td-011)).
- No existe borrado de bots ni de versiones.
- Doble clic en «Crear bot»: la carrera con `UNIQUE(owner_id,name)` puede dar `500` ([TD-013](../roadmap/technical-debt.md#td-013)).

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear bot, guardar y recuperar loadouts (validación 422 con violaciones legibles), subir versiones, encolar y ejecutar el pipeline, y rechazos con motivo visible.
- **PARCIAL**: visibilidad y edición sólo por API; código fuente sólo por API.
- **FUNCIONA ACTUALMENTE (integración `integration/functional-closure`, verificado con Docker rootless local)**:
  - sandbox real en el build;
  - E2E crear → código → build → artefacto → `validated` → `published`;
  - controles negativos: source inválido, timeout de arranque, protocolo, crash, artefacto alterado, proxy caído y sin sandbox;
  - TD-034: plataforma lenta (7 s reales antes de `ready`) → `validated`; bot lento o infinito tras `ready` → `rejected`; plataforma que no llega o runtime ausente → infraestructura; saturación acotada sin rechazos (`apps/bot-manager/tests/build-sandbox-timing-docker.test.ts`, opt-in).
- **PARCIAL**: el despliegue necesita los cambios de compose e imagen citados.
- **PENDIENTE**: ejecución del código del bot en batallas (carril de batallas con `resolveBotLaunch`), asignación de bot a equipo y borrado.

## Documentación relacionada

- Usuario: [Bots](../user/bots.md), [Equipamiento](../user/equipment.md)
- Técnica: [equipment.md](equipment.md), [battles.md](battles.md), [engine.md](engine.md), [api.md](api.md), [frontend.md](frontend.md)
- Arquitectura (A): [workers.md](workers.md), [queue.md](queue.md), [security.md](security.md)
- Operación (C): [docker-proxy.md](../operations/docker-proxy.md), [configuration.md](../operations/configuration.md)
- Histórico absorbido: B11 (panel de versiones), paridad de SDK (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`; filas del sandbox y del versionado, contra la integración del cierre funcional (`integration/functional-closure`) (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| El worker cablea el sandbox real desde el entorno | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:33`; `build-worker-wiring.ts:35,55` |
| Las etapas 5-7 se ejecutan en el contenedor | CODE_VERIFIED / RUNTIME_VERIFIED (Docker rootless local) | `apps/bot-manager/src/pipeline.ts:396,409,435`; `build-sandbox.ts:177`; `apps/bot-manager/tests/build-sandbox-docker.test.ts` (9/9) |
| E2E API → cola → worker → contenedor → `published` | RUNTIME_VERIFIED (Docker rootless local) | `apps/api/src/fc-a-bot-pipeline-e2e.test.ts` (5/5). Mutación M1 (quitar el sandbox del cableado) → 3 rojos |
| Postura real del contenedor conforme | RUNTIME_VERIFIED | `build-sandbox.ts:259` (log «postura del contenedor conforme») |
| El bootstrap rechaza un artefacto alterado | RUNTIME_VERIFIED | `sandbox-bootstrap/bootstrap.py:94`. Mutación M8 → rojo |
| Fallo de plataforma ⇒ reintento ⇒ «no verificable» | RUNTIME_VERIFIED | `pipeline.ts:139`; E2E «proxy caído» |
| Sin sandbox configurado sigue fallando cerrado | RUNTIME_VERIFIED | E2E «SIN sandbox» |
| seccomp permite `mkdir`/`mkdirat` (para materializar en el tmpfs) | CODE_VERIFIED | `apps/bot-manager/security/seccomp-bot.json:150` |
| Rechazo determinista antes del cambio (main y producción) | RUNTIME_VERIFIED (histórico) | Auditoría 2026-10-15, B pasada 2 §1c |
| Rechazo determinista en navegador real (main y runtime de producción) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1c |
| En producción, las 12 versiones `rejected` y los 22 builds `failed` | RUNTIME_VERIFIED | Auditoría 2026-10-15, A pasada 1 (lectura de BD) |
| UX-R · hook obligatorio (Python y Node), con sugerencia | CODE_VERIFIED + test | `apps/bot-manager/src/sandbox-bootstrap/bootstrap.{py,mjs}`; `apps/bot-manager/tests/bootstrap-hook.test.ts` (rc=0, ronda UX-R) |
| UX-F (DEF-R4) · batalla con versión publicada sin hook: juega con aviso; build: rechazo | CODE_VERIFIED + test | `bootstrap.{py,mjs}` (`S9_HOOK_POLICY`); `apps/bot-manager/tests/uxf-hook-policy.test.ts`; `apps/tournament-worker/src/battle-diagnostics.test.ts` (rojo sin el fix) |
| UX-R · humo con el loadout de la versión | CODE_VERIFIED + test | `apps/bot-manager/src/smoke-vehicle.ts`; `apps/bot-manager/tests/smoke-vehicle.test.ts` (rc=0, ronda UX-R) |
| Orden de las 10 etapas | CODE_VERIFIED | `apps/bot-manager/src/types.ts:19-30`; `apps/api/src/services/bot-manager.ts:13-24` |
| Límites: 10 MB, 500 ficheros, 200 MB, 100 ms, 5000 ms, 600 ticks | CODE_VERIFIED | `apps/bot-manager/src/config.ts:138-162` |
| TD-034 · dos relojes: plataforma (`SANDBOX_STARTUP_TIMEOUT_MS`) hasta `ready`, bot (`BOT_EXECUTION_TIMEOUT_MS`) desde `ready` | RUNTIME_VERIFIED (Docker rootless local y GitHub Actions, `integration/production-readiness`) | `apps/bot-manager/src/startup-clock.ts`; `apps/bot-manager/tests/build-sandbox-timing-docker.test.ts` (7/7); `startup-clock.test.ts` (20/20). Mutación «reloj del bot desde el lanzamiento» → rojo (también con Docker) |
| TD-034 · plataforma lenta ⇒ infraestructura; código del bot ⇒ rechazo | RUNTIME_VERIFIED (Docker rootless local y GitHub Actions, `integration/production-readiness`) | SAN-9 del test con Docker (plataforma que no llega, runtime ausente); mutaciones de clasificación → rojo |
| Código pegado se envuelve en esqueleto con lockfile | CODE_VERIFIED | `apps/api/src/services/source-package.ts:94-134` |
| Transiciones de estado y 409 | CODE_VERIFIED | `apps/api/src/services/bots.ts:63-96` |
| `completeBuild` → `validated` + `artifacts` | CODE_VERIFIED | `apps/api/src/services/bot-manager.ts:79-124` |
| Reglas de visibilidad y de acceso al código | CODE_VERIFIED | `apps/api/src/services/bots.ts:29-55`; `routes/bots.ts:303-325` |
| `PATCH /bots` ignora `teamId` | CODE_VERIFIED | `apps/api/src/routes/bots.ts:170-187` |
| Bots privados ajenos usables en batalla | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/battles.ts:411-419`; auditoría B p2 §5 |
| El sandbox real se ejercita en el arnés de smoke | DESIGN_ONLY en esta consolidación (no re-ejecutado) | `scripts/e2e-real-battle-smoke.ts`; `apps/bot-manager/src/container-runner.ts` |
