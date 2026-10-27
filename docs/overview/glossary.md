# Glosario

## Resumen

Términos tal y como los usa **el código** de S9 AI Arena (`27f70bb`): tablas, estados y variables
reales. Cuando el uso habitual y el del código difieren, se indica.

## Índice

[A](#a) · [B](#b) · [C](#c) · [D](#d) · [E](#e) · [F](#f) · [G](#g) · [J](#j) · [L](#l) · [M](#m) · [P](#p) · [R](#r) · [S](#s) · [T](#t) · [V](#v) · [W](#w)

## A

- **anon (ticket).** Marca `anon: true` de un ticket de espectador emitido a un visitante sin sesión. El gateway de espectador lo rechaza si `S9_PUBLIC_SPECTATE_ENABLED` está apagada. Es el Carril J. Ver [security.md](../technical/security.md).
- **agentResolver.** Función que dice cómo se ejecuta el comportamiento de un bot.
  - En el **build**, lanza el bot candidato en el sandbox real y lo enfrenta al bot de referencia en la partida de humo ([TD-001](../roadmap/technical-debt.md#td-001)).
  - En el **worker**, el `AgentDriver` es obligatorio: lanza en contenedores el artefacto firmado de cada versión; no hay stub implícito.
- **arquetipo.** Vehículo predefinido (`scout`, `heavy`, `gunner`). La partida de humo del build traduce el chasis del loadout a uno de estos 3 arquetipos; en batalla se usa el loadout real (`resolveVehicle`). Ver [TD-016](../roadmap/technical-debt.md#td-016).
- **artifact (artefacto).** Resultado firmado de un build aprobado. Fila de la tabla `artifacts`: `hash`, `signature`, `storage_ref`, `bytes`. Es lo que se ejecuta en batalla.
- **audit_log.** Tabla de eventos auditados (por ejemplo `bot.version.submit` o `bot.version.rejected`).

## B

- **backup (servicio).** Contenedor con cron que hace `pg_dump`, copia los volúmenes de datos y los sube con restic por SFTP. Su healthcheck mira la última copia. Se versiona con `BACKUP_TAG`, aparte del resto.
- **battle (batalla).** Una simulación entre participantes en un mapa y con un ruleset. Es una fila de `battles`, con `status` ∈ {`scheduled`, `running`, `finished`, `failed`} y `failure_kind` ∈ {`none`, `bot_timeout`, `bot_crash`, `infrastructure`}. `official=false` en las de práctica: no afectan al rating. Ver [battles.md](../technical/battles.md).
- **bootstrap.** `apps/api/src/db/cli.ts bootstrap`: aplica las migraciones y siembra **sólo el contenido base** (catálogo, ruleset `mvp-default`, mapa). No crea usuarios. Es distinto de `seed`, que crea usuarios de desarrollo con contraseña conocida y **nunca** debe usarse en producción.
- **bot.** Programa de un usuario que controla un vehículo. Fila de `bots`, con `visibility` ∈ {`private`, `team`, `public`} y `team_id` opcional.
- **BUILD_COMMIT.** Commit del que se construyó una imagen. Viaja como `ARG` → `ENV` + label OCI y se sirve en `/version` (ADR-016). Si no se pasa, vale `unknown` y el gate de despliegue rechaza la imagen. En el runtime actual, 9 de 12 servicios no lo tienen.
- **build.** Ejecución del pipeline de validación de una versión de bot (tabla `builds`, `status` ∈ {`queued`, `running`, `passed`, `failed`}). Lo ejecuta el `bot-build-worker`.

## C

- **Carril I / Carril J.** Gates de activación documentados.
  - **I:** ejecución real de batallas. Incluye la reserva atómica `scheduled→running`, un techo de concurrencia y auditoría.
  - **J:** espectador público, con el ticket anónimo marcado.

  Están en `main`, pero no en el runtime desplegado.
- **catálogo.** Definición en datos de los módulos disponibles (tablas `catalog_versions` y `module_definitions`; paquete `packages/module-catalog`). En el contenido base hay 31 módulos.
- **chasis.** Módulo base del vehículo, que fija la masa, las ranuras y el blindaje. Hay 5 en el catálogo.

## D

- **demo-teams.** `cli.ts demo-teams <email>`: crea equipos de demostración con bots para un usuario que ya existe.
- **determinismo.** La misma semilla, mapa, ruleset y código producen el mismo `final_state_hash`. Se verifica al re-simular un replay.
- **docker proxy (`s9-docker-proxy`).** Servicio systemd del **host** que expone la API de Docker con allowlist (crear, arrancar, parar, inspeccionar). Ningún contenedor monta `docker.sock`.

## E

- **entry.** Inscripción de un bot (versión) en un torneo (tabla `entries`).
- **equipment / módulo.** Pieza del catálogo que se monta en un loadout: chasis, movimiento, energía, armas, munición, blindaje, sensores, radio, utilidades. Cada una tiene un coste en créditos.

## F

- **fail-closed (falla cerrado).** Ante la falta de una pieza o de una configuración, el sistema rechaza en lugar de aceptar. Por ejemplo: un build sin sandbox se rechaza; un ticket sin secreto se rechaza.
- **frozen.** Estado de una versión de bot tras participar en un torneo. Ya no puede inscribirse en otro.

## G

- **gateway.** El nginx del stack, único servicio con puertos publicados. Hay dos configuraciones:
  - `nginx.conf`: TLS en el propio gateway.
  - `nginx-behind-proxy.conf`: detrás de un proxy inverso externo que termina TLS.

  Se elige con `GATEWAY_CONF`. Ver [gateway.md](../technical/gateway.md).

## J

- **job (trabajo).** Fila de la tabla `jobs`: la cola durable. Tipos: `run_battle`, `generate_schedule`, `process_result`, `update_standings` y `tournament_dry_run` (los ejecuta el tournament-worker), y `bot_build` (lo ejecuta el bot-build-worker). Estados: `queued`, `running`, `done`, `failed`, `needs_review`. Ver [queue.md](../technical/queue.md).

## L

- **loadout.** Configuración de módulos de un bot, con su revisión (tablas `bot_loadouts` y `loadout_modules`). Se valida contra el catálogo y el presupuesto del ruleset al guardarlo.

## M

- **map / map_version.** `maps` es la identidad de un mapa. `map_versions` es cada versión inmutable, con `state` ∈ {`draft`, `validated`, `published`} y `content` (JSON del mapa). Sólo se usan en batalla las versiones `published`. Los escribe la **API**, no el map-service.
- **match.** Emparejamiento de un torneo (tabla `matches`); puede tener varias batallas.
- **modo (mode).** `deathmatch`, `team_deathmatch`, `capture_the_flag` o `zone_control`.

## P

- **participant.** Bot (versión) inscrito en una batalla, con su `team`, su `outcome` (∈ {`win`, `loss`, `draw`, `disqualified`}) y su `cpu_ms`.
- **perfil compose.** Conjunto de servicios que se arranca con `--profile`. Perfiles reales: `development`, `production`, `external-db`, `bots`, `streaming` y `observability`. Algunos servicios declaran también un perfil `nucleo` heredado, pero **no** es el perfil de producción: el despliegue corre `production`, con 12 servicios.
- **published.** Estado de una versión de bot que puede jugar. Sólo se alcanza desde `validated`. Estados posibles: `draft`, `validating`, `rejected`, `validated`, `published`, `frozen`, `suspended`, `retired`.

## R

- **rating / rating_events.** Elo por bot, temporada y modo (`ratings`), y libro mayor de cambios por batalla oficial (`rating_events`).
- **readiness.** Comprobación de que una instalación está lista para operar. Paquetes `packages/readiness` y `packages/first-run` (CLI, R17). No es un endpoint `/readyz`. Ver [docs/operations/readiness.md](../operations/readiness.md).
- **replay.** Grabación de una batalla (índice + segmentos) que permite reproducirla y re-simularla. Vive **en disco** (volumen `arena_replays`); la BD sólo guarda `battles.replay_ref` y `replay_hash`. Ver [replays.md](../technical/replays.md).
- **ruleset.** Reglas de una batalla: presupuesto de créditos, categorías prohibidas y configuración (tabla `rulesets`). En la BD el ruleset base es `mvp-default`. El motor tiene sus propios rulesets por modo (`dm_practice@1`, …); esa doble numeración es el origen de [TD-003](../roadmap/technical-debt.md#td-003).
- **runtime drift (deriva de runtime).** Diferencia entre lo que declara el despliegue (compose, contrato, árbol) y lo que corre (imagen e identidad de cada contenedor). La detecta `infrastructure/scripts/runtime-drift-scan.mjs`.

## S

- **seed.** Ver *bootstrap*. Sólo para desarrollo.
- **spectator (espectador).** Cliente que sigue una batalla **en directo** por WebSocket (`/ws/spectate/<battleId>`), con un ticket de un solo uso enviado como subprotocolo. El gateway de espectador vive en el tournament-worker. *Viewer* es la página web que lo muestra.
- **standings.** Clasificación de un torneo (tabla `standings`).
- **stub (HunterBot).** Bot determinista de referencia del motor (`apps/arena-engine/src/stubs.ts`). Sólo se usa en tests y como rival de la partida de humo del build; en producción no juega batallas: las juega el código del usuario ([TD-002](../roadmap/technical-debt.md#td-002), cerrada).

## T

- **team (equipo).** Grupo de usuarios (`teams`, `team_members` con rol `captain` o `member`). Un bot pertenece a un equipo por `bots.team_id`.
- **ticket (de espectador).** JWT de corta duración, con `battleId` y `jti` de un solo uso, que emite la API (`getSpectateTicket`) y verifica el gateway de espectador. Ver [TD-028](../roadmap/technical-debt.md#td-028).
- **tournament.** Torneo (tabla `tournaments`). Formatos: `league`, `round_robin`, `single_elimination`, `double_elimination`, `swiss`, `teams`. Estados: `draft`, `open`, `closed`, `running`, `finished`, `cancelled`.

## V

- **version (versión de bot).** Instantánea numerada del código de un bot (`bot_versions`), con runtime `python` o `node`.
- **viewer (visor).** Página web (`#/viewer/<id>`) que pinta una batalla en directo con Phaser. El reproductor de replays es `#/replay/<id>`.

## W

- **worker.** Proceso sin HTTP que reclama trabajos de la tabla `jobs`. Hay dos:
  - `tournament-worker`: batallas, torneos y espectador.
  - `bot-build-worker`: builds.

  Su healthcheck es un fichero de latido (`/tmp/heartbeat`, menos de 120 s). Ver [workers.md](../technical/workers.md).

## Documentación relacionada

- [project.md](project.md) · [architecture.md](architecture.md) · [docs/technical/database.md](../technical/database.md)

## Verificación

| Término | Estado | Fuente |
|---|---|---|
| Estados de batalla y failure_kind | CODE_VERIFIED | `apps/api/src/db/migrations.ts:323,334` |
| Estados de versión de bot | CODE_VERIFIED | `apps/api/src/db/migrations.ts:23-32` |
| Estados de build | CODE_VERIFIED | `migrations.ts:246` |
| Estados de map_version | CODE_VERIFIED | `migrations.ts:158` |
| Formatos y estados de torneo | CODE_VERIFIED | `migrations.ts:279,290` |
| Tipos y estados de job | CODE_VERIFIED | `apps/tournament-worker/src/queue.ts:26,40`; `apps/bot-manager/src/build-worker.ts:17` |
| Arquetipos | CODE_VERIFIED | `apps/api/src/services/battle-run-http-launcher.ts:141` |
| bootstrap / seed / demo-teams | CODE_VERIFIED | `apps/api/src/db/cli.ts:2-69` |
| Perfiles compose | CODE_VERIFIED | cabecera y `profiles:` de `infrastructure/docker-compose.yml` |
| Ticket como subprotocolo | CODE_VERIFIED | `apps/api/src/spectate/gateway.ts:32-44,179-183` |
| Visibilidad de bots | CODE_VERIFIED | `migrations.ts:189` |
