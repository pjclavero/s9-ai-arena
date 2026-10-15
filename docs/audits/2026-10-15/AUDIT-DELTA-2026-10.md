# Delta de la auditoría 2026-10-15

## Resumen

Este documento coteja cada hallazgo de la auditoría del 2026-10-15 con el estado verificado
durante la consolidación documental del mismo día. La auditoría se hizo sobre `origin/main = 27f70bb`
y desde entonces hay **0 commits**, así que todo hallazgo de código, tests o git **conserva su estado**.
El único cambio observado está en el runtime: el backup programado volvió a ejecutarse con éxito.

| Estado actual | Nº | Hallazgos |
|---|---|---|
| CLOSED | 0 | — |
| IMPROVED | 2 | P0-7 y el área BACKUP |
| UNCHANGED | 38 | 7 P0, 7 P1, 14 áreas funcionales y 10 transversales |
| SUPERSEDED | 2 | P1-4 «sin límite de intentos» (se reformula); RECOVERY «`restore.sh` sólo `latest`» (corrección) |
| REGRESSED | 0 | — |
| UNKNOWN | 1 | exposición del espectador anónimo en producción (no medible sin POST) |

Además, la verificación encontró un hallazgo **nuevo**, registrado como [TD-028](../../roadmap/technical-debt.md#td-028).

## Índice

- [Método](#método)
- [Hallazgos P0](#hallazgos-p0)
- [Hallazgos P1](#hallazgos-p1)
- [Áreas de la auditoría funcional](#áreas-de-la-auditoría-funcional)
- [Hallazgos transversales](#hallazgos-transversales)
- [Hallazgo nuevo](#hallazgo-nuevo)
- [Verificación](#verificación)

## Método

- **Base:** `27f70bb` es tanto la base de la auditoría como el `main` actual. `git fetch --all --prune` del 2026-10-15 por la tarde: 0 commits y 0 ficheros cambiados.
- **Regla:** PRESERVE AUDIT STATUS. No se re-audita. Sólo se re-verifica lo que pudo cambiar (el runtime de backup) y las afirmaciones que esta documentación cita (ruta:línea en `27f70bb`).
- **Runtime:** sólo lecturas, como `docker inspect` (estado de salud y **nombres** de variables, nunca valores) y `docker logs` del contenedor de backup. No se hizo ningún cambio en producción.
- **Evidencia completa:** es interna (auditoría privada). Aquí sólo se cita código del repositorio y resultados de runtime saneados.

Estados posibles:

| Estado | Significado |
|---|---|
| CLOSED | resuelto |
| IMPROVED | mejora parcial |
| UNCHANGED | igual que en la auditoría |
| REGRESSED | peor que en la auditoría |
| SUPERSEDED | sustituido por un hallazgo reformulado o corregido |
| UNKNOWN | no verificable |

## Hallazgos P0

| AUDIT ID | ESTADO 2026-10-15 | CAMBIOS POSTERIORES | EVIDENCIA | ESTADO ACTUAL | TD |
|---|---|---|---|---|---|
| P0-1 Build sin sandbox (`agentResolver`) | BLOCKED: 0 bots publicados | 0 commits | `apps/bot-manager/src/build-worker-main.ts:31` | UNCHANGED | [TD-001](../../roadmap/technical-debt.md#td-001) |
| P0-2 Stub HunterBot y doble ejecución | Abierto | 0 commits | `engine-executor.ts:51`; `battle-runner.ts:142`; `battles.ts:441` | UNCHANGED | [TD-002](../../roadmap/technical-debt.md#td-002) |
| P0-3 Costura `rulesetId` | 400 en los 4 modos | 0 commits | `BattleNewPage.tsx:17-21`; `battles.ts:400-401` | UNCHANGED | [TD-003](../../roadmap/technical-debt.md#td-003) |
| P0-4 `/replays/*` anónimo | Abierto; ningún test lo cubre | 0 commits | `infrastructure/gateway/*.conf` (`location /replays/`) | UNCHANGED | [TD-004](../../roadmap/technical-debt.md#td-004) |
| P0-5 Autorización de participantes | Abierto | 0 commits | `battles.ts:411-419` | UNCHANGED | [TD-005](../../roadmap/technical-debt.md#td-005) |
| P0-6 Runtime mezclado sin identidad | 3 commits en runtime; 9/12 sin `/version` | 0 commits; imágenes idénticas por image ID (dato del supervisor) | baseline del supervisor | UNCHANGED | [TD-006](../../roadmap/technical-debt.md#td-006) |
| P0-7 Backup / snapshots / apagado | Última copia 2026-09-13; healthcheck rojo; sin alertas; sin snapshots | **runtime: backup SUCCESS 2026-10-15 04:15 UTC; `restic check` sin errores; healthcheck `healthy`** | `docker inspect` / `docker logs` del servicio backup (2026-10-15 21:01 UTC) | **IMPROVED**: la copia existe; siguen abiertos las alertas, los snapshots de VM (sigue sin ninguno) y el apagado limpio | [TD-007](../../roadmap/technical-debt.md#td-007) |
| P0-8 Topología en el repo público | Abierto | 0 commits en `main`; esta consolidación sanea los documentos que toca, en una rama sin integrar | recuento interno por parseo | UNCHANGED en `main` (pasará a IMPROVED al integrar la consolidación; no a CLOSED, porque quedan código, tests y config) | [TD-008](../../roadmap/technical-debt.md#td-008) |

## Hallazgos P1

| AUDIT ID | ESTADO 2026-10-15 | CAMBIOS POSTERIORES | EVIDENCIA | ESTADO ACTUAL | TD |
|---|---|---|---|---|---|
| P1-1 Phaser `getScene` antes de `ready` | Replay y visor rotos en navegador | 0 commits | `ReplayPage.tsx:75`; `ViewerPage.tsx:38`; `BroadcastPage.tsx:228` | UNCHANGED | [TD-009](../../roadmap/technical-debt.md#td-009) |
| P1-2 Editor de mapas | Import del export = 500; sin guardado | 0 commits | `MapEditorPage.tsx:14-16`; `saveMapDraft` existe sin uso en la web | UNCHANGED | [TD-010](../../roadmap/technical-debt.md#td-010) |
| P1-3 Equipos | Parcial; `/teams` anónimo con UUID | 0 commits | `routes/bots.ts:148-164`; `openapi.yaml:239` | UNCHANGED | [TD-011](../../roadmap/technical-debt.md#td-011) |
| P1-4 Auth: registro abierto, `TRUST_PROXY_HOPS`, password | Abierto | 0 commits | `routes/auth.ts:147-175`; compose `:191` | UNCHANGED (registro, saltos de proxy, cambio y recuperación de contraseña) | [TD-012](../../roadmap/technical-debt.md#td-012) |
| P1-4 (parte) «sin límite de intentos de login» | 12 fallos sin 429 | 0 commits | `shared-rate-limit.ts:118-119`: bloqueo tras **20** fallos; limitador de 60/min | **SUPERSEDED**: la prueba (12 < 20) no demuestra que falte el límite. Se reformula como «la clave del límite colapsa a la IP del proxy» | [TD-012](../../roadmap/technical-debt.md#td-012) |
| P1-5 Carreras de doble envío / `frozen` | 500 en carreras | 0 commits | auditoría (entorno aislado) | UNCHANGED | [TD-013](../../roadmap/technical-debt.md#td-013) |
| P1-6 301 a http en `/replays` | Contenido mixto en producción | 0 commits | `ReplaysPage.tsx:28` | UNCHANGED | [TD-014](../../roadmap/technical-debt.md#td-014) |
| P1-7 Torneos: `mapPool`, `failed`, guardas | Abierto | 0 commits | `results.ts:341,371`; `battle-runner.ts:122-139`; `main.ts:80` | UNCHANGED | [TD-015](../../roadmap/technical-debt.md#td-015) |

## Áreas de la auditoría funcional

| ÁREA | ESTADO 2026-10-15 | CAMBIOS POSTERIORES | EVIDENCIA | ESTADO ACTUAL | TD |
|---|---|---|---|---|---|
| USERS | PARTIAL | 0 commits | `routes/auth.ts` | UNCHANGED | TD-012 |
| BOTS | BLOCKED | 0 commits | `build-worker-main.ts:31` | UNCHANGED | TD-001 |
| EQUIPMENT | PARTIAL | 0 commits | `battle-run-http-launcher.ts:141-146`; `combat.ts:198` | UNCHANGED | TD-016 |
| TEAMS | PARTIAL | 0 commits | `routes/bots.ts:148-164` | UNCHANGED | TD-011 |
| MAPS | PARTIAL (editor roto) | 0 commits | `MapEditorPage.tsx:14-16` | UNCHANGED | TD-010, TD-017 |
| BATTLES | BLOCKED | 0 commits | `battles.ts:400-441` | UNCHANGED | TD-002, TD-003, TD-005 |
| TOURNAMENTS | PARTIAL (con stub) | 0 commits | `results.ts:341,371` | UNCHANGED | TD-015 |
| VIEWER | PARTIAL (roto) | 0 commits | `ViewerPage.tsx:38` | UNCHANGED; se agrava con el hallazgo nuevo TD-028 (el worker no puede verificar tickets) | TD-009, TD-028 |
| REPLAYS | PARTIAL + gobernanza violada | 0 commits | `ReplayPage.tsx:75`; gateway | UNCHANGED | TD-004, TD-009, TD-014 |
| RANKING | PARTIAL (vacío) | 0 commits | sin batallas | UNCHANGED | TD-001, TD-002 |
| STATISTICS | CODE_ONLY en producción | 0 commits | `apps/replay-service/src/stats.ts` | UNCHANGED | TD-002, TD-022 |
| ADMIN | PARTIAL | 0 commits | páginas de admin | UNCHANGED | TD-023 |
| INSTALLATION/R17 | PARTIAL | 0 commits | compose `TAG:-latest` | UNCHANGED | TD-024 |
| BACKUP | NOT OPERATING | **runtime: copia correcta 2026-10-15** | logs y salud del contenedor | **IMPROVED** (opera; sin alertas) | TD-007 |
| RECOVERY | PARTIAL | 0 commits | drill de agosto; nightly de restore rojo | UNCHANGED (sin ensayo reciente) | TD-025 |
| RECOVERY (parte) «`restore.sh` sólo `latest`» | — | 0 commits | `infrastructure/backup/restore.sh:5` admite `--snapshot <id>`, también en la imagen de backup desplegada | **SUPERSEDED** (corrección de verificación) | TD-025 |

## Hallazgos transversales

| AUDIT ID | ESTADO 2026-10-15 | CAMBIOS POSTERIORES | EVIDENCIA | ESTADO ACTUAL | TD |
|---|---|---|---|---|---|
| map-service muerto | Contenedor en memoria sin consumidores | 0 commits | `apps/map-service/src/main.ts:20-42` | UNCHANGED | [TD-017](../../roadmap/technical-debt.md#td-017) |
| Carril J anulado por mezcla de versiones | Latente | 0 commits | baseline del supervisor (imágenes iguales) | UNCHANGED | TD-006 |
| Ticket de espectador anónimo en producción | UNKNOWN (exige POST) | — | no medido (prohibido escribir) | UNKNOWN | TD-006 |
| Parche `multer`/`js-yaml` no desplegado | Abierto | 0 commits; imágenes idénticas | baseline | UNCHANGED | TD-006 |
| Tests tautológicos (M1a, M3) y sin E2E de navegador | Abierto | 0 commits | `rbac-matrix.test.ts` (generado desde OpenAPI) | UNCHANGED | [TD-018](../../roadmap/technical-debt.md#td-018) |
| Nightly 40/40 rojo; deploy-staging falso verde | Abierto | 0 commits | `ci.yml:945-947` | UNCHANGED | [TD-019](../../roadmap/technical-debt.md#td-019) |
| `/api/healthz` sirve la SPA; `/system/status` `unknown` | Abierto | 0 commits | `routes/system.ts:51` | UNCHANGED | [TD-020](../../roadmap/technical-debt.md#td-020) |
| Código muerto (`radioReaches`, `revertBattleRating`) | Abierto | 0 commits | `sensors.ts:227`; `ratings.ts:162` | UNCHANGED | [TD-021](../../roadmap/technical-debt.md#td-021) |
| UX de errores y estados | Abierto | 0 commits | `BotsPage.tsx:374-384` | UNCHANGED | [TD-022](../../roadmap/technical-debt.md#td-022) |
| Documentación obsoleta o contradictoria | 2 «fuentes de verdad» contradictorias; runbooks peligrosos | consolidación en curso, sin integrar | — | UNCHANGED en `main`; la sustituye [current-status.md](../../roadmap/current-status.md) al integrar | — |
| Artefactos de despliegue en el host | Inventario interno | sin re-medir | interno | UNCHANGED | [TD-027](../../roadmap/technical-debt.md#td-027) |

## Hallazgo nuevo

| ID | Descripción | Evidencia | Estado | TD |
|---|---|---|---|---|
| NEW-1 | El `tournament-worker` aloja el gateway WebSocket de espectador, pero no recibe el secreto con el que se verifican los tickets. Todo ticket se rechaza (falla cerrado). | `apps/api/src/auth/tokens.ts:73-97,165-177`; compose (`tournament-worker` sólo monta `postgres_password`); nombres de variables del contenedor leídos el 2026-10-15 | ABIERTO | [TD-028](../../roadmap/technical-debt.md#td-028) |
| NEW-2 | El aviso Redis del worker no tiene productor: la cola avanza por polling (~1 s). | `redis-signal.ts:207-215`; `notify(` sólo aparece en tests | ABIERTO (bajo) | [TD-026](../../roadmap/technical-debt.md#td-026) |

## Documentación relacionada

- [README.md](README.md): resumen público de la auditoría.
- [technical-debt.md](../../roadmap/technical-debt.md): registro de deuda.
- [current-status.md](../../roadmap/current-status.md): estado actual.

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| 0 commits desde la auditoría | CODE_VERIFIED | `git rev-parse HEAD` = `27f70bb` = `origin/main` (baseline del supervisor) |
| Backup `healthy` y SUCCESS a las 04:15 UTC | RUNTIME_VERIFIED | `docker inspect` del estado de salud del servicio backup: «BACKUP OK … snapshot creado»; log `backup SUCCESS en 10s`; `restic check`: «no errors were found» (2026-10-15 21:01 UTC) |
| Sin snapshots de VM | RUNTIME_VERIFIED (por el supervisor) | baseline del supervisor (sólo `current`) |
| Umbral de 20 fallos de login | CODE_VERIFIED | `apps/api/src/middleware/shared-rate-limit.ts:118-119` |
| `restore.sh --snapshot` | CODE_VERIFIED | `infrastructure/backup/restore.sh:5`; commit `2c72ff3` es ancestro de `ad0a42b` |
| Worker sin secreto de ticket | CODE_VERIFIED + RUNTIME_VERIFIED (sólo nombres) | compose; `docker inspect` de nombres de variables del worker |
| Resto de rutas citadas | CODE_VERIFIED | ficheros de `27f70bb` en las líneas indicadas |
