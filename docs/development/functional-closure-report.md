# Informe del cierre funcional — 2026-10

## Resumen

Revisión, integración y prueba de los cuatro carriles del cierre funcional de S9 AI Arena
(DEV-A bots/build/versionado, DEV-B batallas/ejecución, DEV-C mapas/equipos/rulesets, DEV-D
frontend/visor/replay) sobre la base `0b8c12b`, en la rama `integration/functional-closure`.

Resultado: los conflictos de texto y los ocho conflictos semánticos conocidos se resolvieron con
código y test; la suite completa, el escaneo y los gates pasan con rc real; el **golden path**
(registro → bots con build real → equipo → mapa → batalla real con el código de cada bot → visor en
directo → estadísticas → replay) pasa en Chromium real sin mocks de servicios de S9; las mutaciones
de control se ponen rojas. **Nada se ha desplegado** ni se ha tocado producción.

Veredicto: **FUNCTIONAL_CORE_VERIFIED** en entorno aislado, con una salvedad documentada: el límite
de arranque del sandbox mide tiempo de pared y, con la máquina cargada, rechaza a veces un bot
válido ([TD-034](../roadmap/technical-debt.md#td-034)).

> **Actualización (Production Readiness Closure, 2026-10-18):** TD-034 y TD-004 quedan cerradas y
> TD-045 con el gate activo y calibrado en `integration/production-readiness`, construida sobre el
> HEAD de esta integración. Ver [production-readiness-report.md](production-readiness-report.md).

## Índice

- [Qué es](#qué-es)
- [BASELINE](#baseline)
- [DEV-A](#dev-a)
- [DEV-B](#dev-b)
- [DEV-C](#dev-c)
- [DEV-D](#dev-d)
- [INTEGRATION ORDER](#integration-order)
- [TESTS](#tests)
- [GOLDEN E2E](#golden-e2e)
- [NEGATIVE CONTROLS](#negative-controls)
- [KNOWN LIMITATIONS](#known-limitations)
- [DEBT CLOSED](#debt-closed)
- [DEBT REMAINING](#debt-remaining)
- [PRODUCTION IMPACT](#production-impact)
- [NEXT STEPS](#next-steps)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

El registro de la fase REVIEW del cierre funcional: qué entregó cada carril, qué se encontró al
revisarlo, cómo se integró, qué pruebas lo sostienen (con su rc) y qué deuda queda. Las cifras son
del entorno aislado de la máquina de pruebas: PostgreSQL embebido, Docker rootless local,
`s9-docker-proxy` local del repositorio y Chromium de la imagen oficial de Playwright fijada por
digest.

## BASELINE

| Elemento | Valor |
|---|---|
| Base (`origin/main`) | `0b8c12b9b32fd9ce2761ecaa3c0e3694398f6b03` (no se movió durante el trabajo) |
| DEV-A `fc/dev-a-bots` | `878995c63c09fa14fa4b121cee255cd4d60a3cdf` · merge-base = base |
| DEV-B `fc/dev-b-battles` | `fd4ed5c78f6ea2075d8f0d24403e1a8dfdb6fcdd` · merge-base = base |
| DEV-C `fc/dev-c-maps-teams` | `7b383653e23ce01791bf2aafceb7b3279b2952fb` · merge-base = base |
| DEV-D `fc/dev-d-frontend` | `63054b8b98c7cf31e6818cac7bc096a7512376c3` · merge-base = base |
| Integración | `integration/functional-closure` (sin push, sin PR) |

## DEV-A

**Qué cambia.** Sandbox real del build (`ContainerBuildSandbox`: contenedor por `s9-docker-proxy`,
artefacto `arena-artifact/v1` descargado y verificado por un bootstrap), versionado sobre la BD
(migración de inmutabilidad, versión padre, build validador, diff, clonado, procedencia), API de
versiones y `BotDetailPage`. **Contratos:** `SandboxSpec` (`cmd`, `autoRemove`, `state()`),
5 operaciones nuevas en OpenAPI. **Tests:** sandbox con Docker, pipeline E2E, versionado, web.

**Revisión.** Sin secretos ni topología; `canReadSource` protege source, files y diff (también en
bots públicos con código privado: lo prueba la matriz de seguridad nueva). Hallazgos: no exportaba
`createBattleLaunchHost` (contrato que B esperaba); `docker-sandbox-env.ts` borraba la red
compartida `arena` si la había creado; `BotDetailPage` traga el fallo de `/loadouts`; el artefacto
de un bot público muestra hash/firma aunque el código sea privado ([TD-049](../roadmap/technical-debt.md#td-049)).

**Dictamen: PASS** (con la integración de `createBattleLaunchHost` hecha por REVIEW).

## DEV-B

**Qué cambia.** Autoridad única de ejecución (la API agenda; el worker reserva con lease, ejecuta
con contenedores y cierra exactamente una vez), `battle-result/v1`, CPU real, temporada única,
propiedad/visibilidad de participantes. **Migración** `012_b_battle_claim`. **Tests:** ciclo de
vida, propiedad, temporada, E2E con Docker.

**Revisión.** Hallazgos: su E2E construía una imagen por versión en un registry local (no el
camino de A) e insertaba por SQL un loadout que la API rechaza (`energy_deficit`); `server.ts`
seguía construyendo el launcher HTTP legado; no cableaba `checkBattleContent`; caché `public` en el
historial de rating de un bot privado (corregido); `GET /battles`, detalle y stats muestran
participantes de bots privados (preexistente, [TD-047](../roadmap/technical-debt.md#td-047));
`main.ts` no cableaba el guard de firma (cableado).

**Dictamen: PASS** tras la integración.

## DEV-C

**Qué cambia.** Editor de mapas persistente (borrador mutable, contenido normalizado, `/content`,
propiedad), equipos completos, `GET /rulesets`, `checkBattleContent`, contenido base con un ruleset
por modo y `mvp-arena-02`, clasificación ACTIVE/PARTIAL/FUTURE del equipamiento.
**Contratos:** RULESET, MAP_VERSION, TEAM (sin UUID para anónimos). **Tests:** contenido, web, E2E
provisional en `tests/fc-c-browser`.

**Revisión.** Hallazgos: E2E provisional fuera del directorio canónico (unificado); botón «Ejecutar
batalla real» obsoleto (retirado); alta de miembros por email que revela si la cuenta existe y no
pide consentimiento ([TD-041](../roadmap/technical-debt.md#td-041)); carrera de creación simultánea
del mismo `mapId` (500) y `getVersionRow` que convierte un error de BD en 404 ([TD-049](../roadmap/technical-debt.md#td-049)).
Sacar `map-service` de `production` rompe el contrato de despliegue: no se aplicó ([TD-017](../roadmap/technical-debt.md#td-017)).

**Dictamen: PASS.**

## DEV-D

**Qué cambia.** Timeouts y clasificación única de errores (`describeApiError`, `ErrorState`,
`FormError`), arranque con la API caída, 404, espera real de READY de Phaser, visor que no
reconecta ante rechazos, `/replays` sin 301 a http, resultados `battle-result/v1` en la web, secreto
del ticket en el worker, E2E de navegador canónico (`tests/browser`, `npm run test:browser`).

**Revisión.** Hallazgos: el worker recibe el secreto de sesión raíz para verificar tickets
([TD-043](../roadmap/technical-debt.md#td-043)); el atajo `seed-replay` (sustituido por la batalla
del golden path); comentarios con nombres de máquina reales en ficheros nuevos (limpiados); un 200
con JSON ilegible se trata como éxito ([TD-049](../roadmap/technical-debt.md#td-049)).

**Dictamen: PASS.**

## INTEGRATION ORDER

Orden A → C → B → D, `git merge --no-ff`, un commit por resolución:

| Paso | Resolución |
|---|---|
| A | sin conflicto |
| C | `conformance.test.ts`: 65 + 5 (A) + 7 (C) = **77** operaciones (verificado contra la unión de `operationId` de A, B y C: ninguna perdida) |
| B | migraciones: `012_a_bot_versioning` → `012_bot_versioning` y `012_b_battle_claim` → `013_battle_claim`; `migrations-order.test.ts` exige prefijo `NNN` único, consecutivo, sin letra de carril y en orden de knex (no un «013» a mano en `cpu-ms.test.ts`, que ya revierte las posteriores a 011) |
| D | sin conflicto de texto |

Conflictos semánticos (R4), cada uno con test:

| # | Resolución | Prueba |
|---|---|---|
| 1 | `createBattleLaunchHost` (DEV-A, `bot-launch.ts`): `resolveBotLaunch` + `SandboxHost` + `launchSpecForBot`; el worker lo importa estáticamente y verifica con la clave **pública** (`ARTIFACT_VERIFY_KEY_FILE`); `DbArtifactLaunchGuard` cableado; `AutoRemove`. `server.ts` ya no construye el launcher HTTP legado | `battle-launch-host.test.ts`, `container-battle-e2e.test.ts` (A+B), `server-wiring.test.ts` (AST) |
| 2 | migraciones 012/013 | `migrations-order.test.ts` |
| 3 | 77 operaciones | `conformance.test.ts` |
| 4 | unión de paths A/B/C en `openapi.yaml`; 409 de `POST /battles` documentado | `conformance.test.ts` |
| 5 | `checkBattleContent` en `createPracticeBattle` | `battles-create-content.test.ts` |
| 6 | botón «Ejecutar batalla real» retirado; la página ya no consulta `/system/status` | `battle-new-page.test.tsx` |
| 7 | `#/bots/<id>` y `#/maps/editor?…` conviven con la 404 | `fc-review-routes.test.tsx` |
| 8 | `TeamsPage`, `BattleNewPage` y «Crear bot» usan `ErrorState`/`FormError` | `battle-new-page.test.tsx`, `r16-pages-primitives.test.tsx` |
| 9 | E2E de navegador unificado en `tests/browser` (fase golden); `tests/fc-c-browser` y `seed-replay` retirados | `npm run test:browser` |
| 10 | compose: `tournament-worker` y `bot-build-worker` en `arena` con proxy, host anunciado y `extra_hosts`; clave pública `artifact_verify_key` (la genera `init-secrets.sh`); `COPY runtimes/DIGESTS.lock` en `bot-manager` y `node-service`; `SPECTATE_WS_URL=/ws/spectate`; `map-service` se queda en `production`; TD-A1 aceptada como [TD-033](../roadmap/technical-debt.md#td-033) | tests de compose, `service-env-contract.test.ts`, stack local arrancado |

## TESTS

Suite completa sobre la integración (rc real de cada runner):

| Paso | Resultado | rc |
|---|---|---|
| `npm run lint` · `npm run typecheck` · `npm run format:check` | sin hallazgos | 0 · 0 · 0 |
| Unitarias + integración (`apps packages infrastructure`, como el job `unit`) | 2641 passed, 18 skipped (los E2E con Docker opt-in, ejecutados aparte, y condicionales) | 0 |
| E2E SFTP de backup / restore (jobs propios) | 7/7 · 10/10 | 0 · 0 |
| Contratos SDK (vitest) · SDK Python (pytest) | 49 · 45 | 0 · 0 |
| Regresión de batallas | 291 passed, 3 skipped | 0 |
| `tests/e2e` | 21 | 0 |
| E2E A+B con Docker (`S9_RUN_REAL_DOCKER_E2E=1`) | 3/3 (build real → artefacto firmado → batalla; negativo de artefacto manipulado) | 0 |
| E2E del sandbox de A (`S9_RUN_DOCKER_SANDBOX_E2E=1`) | en la suite: 13/14, rojo por «arranque 7923 ms > 5000 ms» (TD-034); repetido solo: 14/14 | 1 → 0 |
| Escaneo: `npm audit` · compose · Trivy fs (contenedor `aquasec/trivy:0.72.0`) · resumen | CLEAN · CLEAN · CLEAN (0 CRITICAL/HIGH) · `verified` | 0 |
| Gates y sus mutaciones (`compose-canonical`, `deploy-contract`, `scan-status`, `backup-stack`, `tag-override`, `release`, `image-drift`, `running-image`) | todos | 0 |
| Build de imágenes (Docker rootless): gateway, web, api, tournament-worker, replay-service, bot-manager | 6/6; `runtimes/DIGESTS.lock` dentro de las imágenes que lanzan bots | 0 |
| Stack local de compose (proyecto aislado `fcrev`, perfiles `nucleo`+`development`) | 8 servicios `healthy`; migraciones hasta `013_battle_claim`; `bootstrap`; `/keys/artifact-signing` sirve la clave pública; el worker carga clave pública y digests dentro de su imagen y, sin proxy, anuncia «ejecución desactivada» | 0 |
| Navegador (`npm run test:browser`) | golden 1/1, fase 1 14/14, fase 2 2/2, fase 3 1/1, sonda TD-028 (4404/4401) — dos ejecuciones completas | 0 |

Fallos de entorno observados y descartados con evidencia: la primera ejecución completa de la
integración tuvo los dos E2E SFTP en rojo por la red del Docker local; en las dos ejecuciones
siguientes sobre la misma integración pasaron (7/7 y 10/10). Una ejecución de la mutación de Phaser
falló antes de empezar porque otro proceso ocupaba el puerto TLS elegido; se repitió en puertos libres.

## GOLDEN E2E

`tests/browser/specs/golden-path.spec.ts`, fase `@golden` de `npm run test:browser`, Chromium de
`mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479b…`, detrás de TLS y del gateway con su
conf real. Servicios reales: API + PostgreSQL embebido, `bot-build-worker`, `s9-docker-proxy`
local, `tournament-worker` con ejecución en contenedores, `replay-service`, web de `vite build`.

Recorrido: registro → bot «Artillero» (loadout con radar, código pegado) → build REAL →
`validated` → `published` → bot «Pacifista» igual → equipo con el Artillero → mapa importado,
guardado, F5, renombrado, publicado → logout/login (todo recuperado) → nueva batalla en ese mapa
(ruleset `deathmatch-mvp` servido por la API) → 202 → visor en directo (ticket de la ruta real de
la API) que recibe la baja decisiva → `finished` → «gana red» en `#/battles` → stats → replay
listado, abierto y reproducido hasta el final.

| Evidencia (2 ejecuciones) | Ejecución 1 | Ejecución 2 |
|---|---|---|
| `result` | `battle-result/v1`, `agents: container`, `winner: red`, `endReason: completed`, 730 ticks | ídem, 700 ticks |
| Outcome | Artillero `win`, Pacifista `loss` | ídem |
| Disparos (stats) | Artillero 13, Pacifista 0 | Artillero 12, Pacifista 0 |
| Visor | `live` | `live` (marcador `red: 1` visto en directo) |
| Decisiones del proxy | 128 permitidas, 0 denegadas | — |

Que el Pacifista tenga 0 intentos de disparo y el Artillero gane prueba que corrió SU código: con
HunterBot ambos dispararían (control negativo de abajo).

## NEGATIVE CONTROLS

Commit antes de mutar, ejecutar, restaurar con `git checkout`; ninguna mutación commiteada.

| Mutación | Suite | Resultado |
|---|---|---|
| HunterBot disfrazado de `kind: "container"` en `tournament-worker/src/main.ts` | golden (navegador) | **rc=1** (el marcador nunca llega a `red: 1`; la fase 1 de replay también cae) |
| Romper la espera de READY de Phaser en `ReplayPage` | golden + fase 1 | **rc=1** (golden en el paso del replay; 2 rojos en `replay.spec.ts`) |
| El pipeline ignora el sandbox (`build-worker-wiring.ts`) | E2E A+B con Docker | **rc=1** (build `failed`) |
| Cierre de batalla sin condición de estado ni titular | `battle-lifecycle.test.ts` | **rc=1** |
| Permitir un bot privado ajeno en `POST /battles` | `fc-review-security.test.ts` + `battles-create-ownership.test.ts` | **rc=1** (3 rojos) |
| `canReadSource` deja leer a cualquier autenticado | `fc-review-security.test.ts` | **rc=1** (la primera versión de la matriz NO lo veía —sólo usaba bots privados—; se añadió el caso de bot público con código privado y entonces sí) |
| El borrador de mapa no escribe el contenido | `fc-c-content.test.ts` | **rc=1** (6 rojos) |
| Saltar `checkBattleContent` | `battles-create-content.test.ts` | **rc=1** (4 rojos) |
| `server.ts` vuelve a importar el launcher legado | `server-wiring.test.ts` | **rc=1** |
| Quitar `SPECTATE_WS_URL` del compose | `service-env-contract.test.ts` | **rc=1** |
| Migración con letra de carril (`012_b_…`) | `migrations-order.test.ts` | **rc=1** |

## KNOWN LIMITATIONS

- **Arranque del sandbox bajo carga** ([TD-034](../roadmap/technical-debt.md#td-034)): en 2 de las
  ejecuciones con Docker un bot válido quedó `rejected` por «arranque > 5000 ms» con la máquina
  cargada; repetidas solas, pasan. Es un falso negativo no determinista del producto, no del test.
- **Red local**: la red `arena` del Docker rootless no es `internal` (el anfitrión es un proceso
  del host); se probó el aislamiento del contenedor, no el de la red de compose.
- **Stack de compose**: arrancado en local sin `DOCKER_PROXY_URL` (no hay proxy del host
  alcanzable desde el Docker rootless); la ejecución real de batallas se probó con los procesos en
  el host (E2E y navegador), no dentro de los contenedores de compose.
- **Secretos en rootless**: para el stack local los ficheros de secretos se dejaron legibles (0444)
  porque el Docker rootless remapea el propietario; se borraron al terminar. No afecta al repo.
- **E2E con Docker y de navegador fuera de CI** ([TD-045](../roadmap/technical-debt.md#td-045)).
- **Emisión** (`#/broadcast`) con batalla viva sin E2E; el replay no dibuja la geometría del mapa
  importado en la captura (no verificado más allá).

## DEBT CLOSED

| TD | Cómo |
|---|---|
| [TD-002](../roadmap/technical-debt.md#td-002) | autoridad única + artefacto firmado de la versión exacta; golden y mutación HunterBot |
| [TD-003](../roadmap/technical-debt.md#td-003) | rulesets de la API; residual `checkBattleContent` cableado |
| [TD-005](../roadmap/technical-debt.md#td-005) | propiedad/visibilidad de participantes; `rating-history` con `Cache-Control: private` |
| [TD-010](../roadmap/technical-debt.md#td-010), [TD-011](../roadmap/technical-debt.md#td-011) | editor persistente y equipos (DEV-C), en el golden path |
| [TD-014](../roadmap/technical-debt.md#td-014) | `/replays` sin 301 tras TLS |
| [TD-028](../roadmap/technical-debt.md#td-028) | ticket de la ruta real abre la batalla viva por TLS → gateway → worker |
| [TD-029](../roadmap/technical-debt.md#td-029) | temporada única |
| [TD-030](../roadmap/technical-debt.md#td-030) | contrato `process.env` ↔ compose ↔ `.env.example` por servicio |
| [TD-032](../roadmap/technical-debt.md#td-032), [TD-040](../roadmap/technical-debt.md#td-040), [TD-044](../roadmap/technical-debt.md#td-044) | deuda propuesta por los carriles y cerrada en la integración |

PARCIAL: [TD-001](../roadmap/technical-debt.md#td-001) (proxy del host y CI con Docker),
[TD-009](../roadmap/technical-debt.md#td-009) (CI), [TD-013](../roadmap/technical-debt.md#td-013),
[TD-015](../roadmap/technical-debt.md#td-015), [TD-016](../roadmap/technical-debt.md#td-016),
[TD-017](../roadmap/technical-debt.md#td-017), [TD-022](../roadmap/technical-debt.md#td-022) (onboarding).

## DEBT REMAINING

Nueva (ids asignados por REVIEW; equivalencias con las propuestas de los carriles):
[TD-033](../roadmap/technical-debt.md#td-033) (TD-A1), [TD-034](../roadmap/technical-debt.md#td-034) (TD-A2),
[TD-035](../roadmap/technical-debt.md#td-035) (TD-A3), [TD-036](../roadmap/technical-debt.md#td-036) (TD-A4),
[TD-037](../roadmap/technical-debt.md#td-037), [TD-038](../roadmap/technical-debt.md#td-038) y
[TD-039](../roadmap/technical-debt.md#td-039) (DEV-B; TD-039 absorbe TD-NEW-C2),
[TD-041](../roadmap/technical-debt.md#td-041) (TD-NEW-C3), [TD-042](../roadmap/technical-debt.md#td-042) (TD-NEW-C4),
[TD-043](../roadmap/technical-debt.md#td-043) (D1), [TD-045](../roadmap/technical-debt.md#td-045) (D3),
[TD-046](../roadmap/technical-debt.md#td-046) (D4), y de la revisión [TD-047](../roadmap/technical-debt.md#td-047),
[TD-048](../roadmap/technical-debt.md#td-048), [TD-049](../roadmap/technical-debt.md#td-049).
TD-NEW-C1 y el «mapa↔modo» de B se fusionaron en TD-032 (cerrada); D2 es TD-044 (cerrada).

Siguen abiertas de la auditoría, entre otras: [TD-004](../roadmap/technical-debt.md#td-004)
(re-verificada: `GET /replays` anónimo responde 200 por el gateway), TD-006, TD-007, TD-008,
TD-012, TD-019, TD-031.

## PRODUCTION IMPACT

**Ninguno.** Sin SSH a producción, sin `docker compose` contra producción, sin push ni PR. Todo
Docker fue el rootless local, con recursos propios con prefijo `fcrev` (o los de los arneses del
repositorio, que limpian sólo lo suyo); la red compartida `arena` no se borró.

Lo que exigirá el despliegue de la integración (decisión del operador): recrear `api`,
`tournament-worker` y `bot-build-worker`; generar `artifact_verify_key.pem` con `init-secrets.sh`;
aplicar las migraciones `012_bot_versioning` y `013_battle_claim`; operar el `s9-docker-proxy` en
el host y dar `DOCKER_PROXY_URL` al worker.

## NEXT STEPS

1. Revisión humana y fusión de `integration/functional-closure` (coordinador).
2. Job de CI con Docker para el golden path y los E2E de sandbox/batalla ([TD-045](../roadmap/technical-debt.md#td-045)).
3. Estabilizar el límite de arranque ([TD-034](../roadmap/technical-debt.md#td-034)) antes de abrir el build a usuarios.
4. Antes de abrir a terceros: [TD-004](../roadmap/technical-debt.md#td-004), [TD-047](../roadmap/technical-debt.md#td-047), [TD-041](../roadmap/technical-debt.md#td-041), [TD-033](../roadmap/technical-debt.md#td-033), [TD-043](../roadmap/technical-debt.md#td-043).
5. Despliegue con ventana del operador; tras él, actualizar [current-status.md](../roadmap/current-status.md) y el bloque de estado del README.

## Documentación relacionada

- [current-status.md](../roadmap/current-status.md) · [known-issues.md](../roadmap/known-issues.md) · [technical-debt.md](../roadmap/technical-debt.md)
- [battles.md](../technical/battles.md) · [bots.md](../technical/bots.md) · [bot-versioning.md](../technical/bot-versioning.md) · [frontend.md](../technical/frontend.md) · [maps.md](../technical/maps.md)
- [configuration.md](../operations/configuration.md) · [testing.md](testing.md)

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Merge-base de los cuatro carriles = `0b8c12b` | CODE_VERIFIED | `git merge-base <rama> 0b8c12b` |
| Golden path completo | RUNTIME_VERIFIED (aislado) | `tests/browser/specs/golden-path.spec.ts`; `npm run test:browser` rc=0 (2 ejecuciones) |
| El worker lanza el artefacto firmado de la versión exacta | RUNTIME_VERIFIED (aislado) | `apps/tournament-worker/src/container-battle-e2e.test.ts` rc=0; `apps/bot-manager/src/bot-launch.ts` (`createBattleLaunchHost`) |
| Contrato de entorno por servicio | CODE_VERIFIED | `infrastructure/tests/service-env-contract.test.ts` (controles +/−, mutación roja) |
| Matriz de seguridad transversal | CODE_VERIFIED | `apps/api/src/fc-review-security.test.ts` (mutaciones rojas) |
| Compose arranca con las imágenes de la integración | RUNTIME_VERIFIED (local) | stack `fcrev`: 8 servicios `healthy`, migraciones hasta 013 |
| Escaneo limpio | RUNTIME_VERIFIED (local) | `scan-gate.mjs resumir` rc=0: npm-audit, compose y Trivy CLEAN |
| Producción sin cambios | DESIGN_ONLY | ninguna operación contra producción en esta fase |
