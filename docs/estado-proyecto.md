# Estado del proyecto S9 AI Arena

> Última actualización: 2026-07-16, verificado ejecutando las suites reales en ia-server (VM 102).
> Este documento existe para entender de un vistazo qué hay hecho DE VERDAD (verificado con
> ejecuciones reales) y qué falta, siguiendo el dosier `docs/Dosier_tareas_S9_AI_Arena.md`.

> **Corrección 2026-07-17 (auditoría consolidada).** La auditoría de
> [`auditoria-consolidada-2026-07-16.md`](auditoria-consolidada-2026-07-16.md) matiza tres
> cifras de este documento con verificación en código: **(1)** `tsc --noEmit` no da "2 errores"
> sino **268** (≈230 son un fallo de configuración del tsconfig raíz con `apps/web`, y **38 son
> genuinos**, varios introducidos por los fixes de H6; H7 **no** está cerrado). **(2)** Hay **dos
> errores CRÍTICOS FUNCIONALES** que los tests no cogen: la munición del loadout **no se propaga**
> al motor (los bots reales disparan `no_ammo`, issue #15) y el **sensor acústico está muerto**
> (un test vacuo lo enmascara). **(3)** Persisten tres críticos de seguridad para abrir la
> plataforma (secreto JWT degradado, sandbox que nunca se ejecuta, `docker.sock`). El plan de
> corrección por equipos está en la **Ronda 2** del dosier. Lo demás de este documento sigue vigente.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Dosier de tareas (12 equipos E1–E12) | `docs/Dosier_tareas_S9_AI_Arena.md` |
| Contratos (esquemas protocolo, módulos, mapas, OpenAPI) | `packages/protocol/`, `packages/module-catalog/`, `packages/map-schema/`, `apps/api/openapi.yaml` |
| Motor de simulación | `apps/arena-engine/` |
| Catálogo de módulos y validador de loadouts | `packages/module-catalog/` |
| Mapas (pipeline Tiled, validador, servicio, procedural) | `apps/map-service/`, `maps/`, `tests/maps-broken/` |
| Protocolo servidor + SDKs | `apps/arena-engine/src/protocol-server.ts`, `sdks/python/`, `sdks/javascript/`, `example-bots/` |
| Seguridad/ejecución de bots (E6) | `apps/bot-manager/`, `runtimes/`, `tests/sandbox-escape/` |
| Plataforma web y API (E7) | `apps/api/` (Express + Knex/PostgreSQL), `apps/web/` (React+Vite) |
| DevOps: stack Compose, CI, observabilidad, backups (E10) | `infrastructure/`, `.github/workflows/`, `docs/despliegue.md`, `docs/recuperacion.md` |
| Entregas por equipo | `docs/entrega-E1.md` … `docs/entrega-E7.md`, `docs/entrega-E10.md` |
| Copia local de trabajo | `~/s9-ai-arena` en ia-server (VM 102, 192.168.1.157) |
| Repo remoto | `github.com/pjclavero/s9-ai-arena` (público) |

## Estado de despliegue (2026-07-16)

**Del trabajo del dosier no hay nada desplegado.** Lo único desplegado es la PRIMERA
versión (prototipo): los 4 contenedores del `docker-compose.yml` de la raíz
(arena-server:8081 WS, arena-viewer:3000, bot-red, bot-blue) corriendo en **VM108**,
con acceso web público vía el proxy Nginx de VM104 (confirmado por el usuario 2026-07-16;
ficha en el repo `s9-server`, `servicios/s9-ai-arena.md`).

El stack v2 del capítulo 6 ya existe en `infrastructure/` (E10) pero **no está desplegado**.
Requisito de diseño: debe poder desplegarse autocontenido en UNA SOLA máquina, con el
acceso web público dado por el Nginx de VM104 como proxy inverso — `docs/despliegue.md`
documenta ambos modos (standalone con TLS propio y detrás del proxy de VM104).

**Limitación de entorno relevante:** en ia-server el usuario `ia02` no pertenece al grupo
`docker` y no hay `sudo`, así que no se puede construir ni lanzar contenedores desde esta
sesión. Afecta a la verificación real de E6 (sandbox) y E10 (Compose/CI). El Node local es
v20.19.2 (ver nota de zstd más abajo).

## Estado por equipo (verificado con ejecuciones reales, no con lo que dicen los docs)

| Equipo | Tareas del dosier | Código presente | Tests ejecutados | Resultado real | Notas |
|---|---|---|---|---|---|
| E1 Contratos | T1.1–T1.4 | `packages/protocol`, `packages/module-catalog`, `packages/map-schema`, `apps/api/openapi.yaml` | `node packages/protocol/scripts/validate.js` y `node packages/module-catalog/scripts/validate-catalog.js` | **Ambos "TODO CORRECTO"** (19+22 y 6+11+casos de mapa) | Fusión E1+E2 documentada en `FUSION.md` |
| E2 Motor | T2.1–T2.6 | `apps/arena-engine/` | Incluido en `npm test` | **Verde** (determinismo, física, golden, replays) | 1 test de tamaño de replay falla por ENTORNO: `zstdCompressSync` no existe en Node 20 (requiere ≥22.15). No es un bug del código. |
| E3 Módulos | T3.1–T3.4 | `packages/module-catalog/` (datos, validador, resolver, bench) | Incluido en `npm test` + validador CLI | **Verde** | fixtures.ts del motor cableado al catálogo real |
| E4 Mapas | T4.1–T4.4 | `apps/map-service/`, `maps/`, `tests/maps-broken/` | Incluido en `npm test` | **Verde** | Import Tiled, validador, servicio, procedural |
| E5 Protocolo+SDKs | T5.1–T5.4 | protocol-server + `sdks/python` + `sdks/javascript` + `example-bots/` | `npm test` + `pytest` en `sdks/python` | **Verde**: SDK Python 45/45 (60 s); JS/protocolo en vitest | El test flaky de T5.1 (comparaba 2 ejecuciones en vivo) se reescribió como autoconsistencia vía replay — ver `docs/entrega-E5.md` |
| E6 Seguridad | T6.1–T6.4 | `apps/bot-manager/`, `runtimes/`, `tests/sandbox-escape/`, `scripts/scan-compose.ts`, `scripts/verify-runtime-digests.ts` | Incluido en `npm test` (66 tests E6) | **Verde en la capa verificable** (pipeline, firma, análisis, prueba de protocolo + partida de humo en proceso, secret-scan, audit_log RBAC, suspensión, escáner de Compose, digests) | Capa Docker (lanzar contenedores, suite de escape viva, `docker inspect`, Trivy) **implementada pero pendiente de entorno con Docker** — ia02 sin grupo docker ni sudo. Ver `docs/entrega-E6.md` |
| E7 Plataforma | T7.1–T7.5 | `apps/api/` (26 tablas cap. 23, migraciones Knex, auth Argon2id+TOTP, RBAC desde OpenAPI, bots 17.1, API espectador, cuotas), `apps/web/` (React+Vite, editor con validador E3) | Incluido en `npm test` (60 tests E7 contra **PostgreSQL 18.4 real embebido**) + `vite build` | **Verde en la capa verificable**: 52/53 operaciones del OpenAPI implementadas y conformes | Integra el `BuildPipeline` REAL de E6 (no reimplementado). Pendiente: `verifyReplay` (E8), jobs (E9), etapas containerizadas del pipeline sin Docker. Ver `docs/entrega-E7.md` |
| E8 Visor/Replays | T8.1–T8.4 | `apps/replay-service/` (formato zstd/gzip+sha256+keyframes, retención 23.1, CLI verify), `apps/api/src/spectate/`, `apps/web/src/viewer/` (Phaser, reproductor 0,5×–8×), pipeline de stats | Incluido en `npm test` (52 tests E8) + `vite build` | **Verde en la capa verificable**: completa las **53/53 operaciones** del OpenAPI (`verifyReplay`) | Cifras: replay 5 min 2,23→0,06 MB (37×); verify 390 ms; stats 313 ms; 50/50 batallas de regresión. Pendiente: E2E con navegador real y rama zstd (Node ≥22). Ver `docs/entrega-E8.md` |
| E9 Torneos | T9.1–T9.4 | `apps/tournament-worker/` (cola durable sobre `jobs` de E7, SKIP LOCKED, clasificación 19.2), 6 formatos de torneo, Elo con libro mayor `rating_events`, commit-reveal + auditoría E2E con `verify()` | Incluido en `npm test` (48 tests E9) | **Verde en la capa verificable**: torneo E2E de 8 bots con 7 batallas reales del motor en ~0,9 s | budgetCredits congelado por torneo (ADR-000/D7). Redis solo probado contra stub RESP (cola es PostgreSQL-primero, ADR-E9-001). Ver `docs/entrega-E9.md` |
| E10 DevOps | T10.1–T10.4 | `infrastructure/` (Compose 12 servicios, perfiles, 5 redes, secretos, observabilidad Prometheus+Grafana+Loki, backups pg_dump+restic), `.github/workflows/` (CI 8 etapas + nightly), `docs/despliegue.md`, `docs/recuperacion.md` | Incluido en `npm test` (56 tests E10: `docker compose config` sin daemon, escáner, backups dry-run) | **Verde en la capa verificable** | Sin Docker no se pudo levantar el stack ni ejecutar CI real (ia02 sin grupo docker). CI fija Node 22. Ver `docs/entrega-E10.md` |
| E11 Streaming | T11.1–T11.2 | `apps/web/src/broadcast/` (vista 1080p sobre el visor E8, BroadcastDirector, branding por query), `apps/streamer/` + `infrastructure/docker/streamer/` (Xvfb+Chromium+FFmpeg, supervisor con reintentos, API interna, métricas), `docs/streaming-runbook.md` | Incluido en `npm test` (35 tests E11) + `vite build` | **Verde en la capa verificable** (clave RTMPS solo por archivo, redacción verificada en tests) | El streaming no toca el motor: consume el canal de espectador. [PENDIENTE]: emisión real de 30 min a YouTube y Chromium/FFmpeg vivos (requiere Docker; runbook §7). Ver `docs/entrega-E11.md` |
| E12 QA | T12.1–T12.3 | `tests/e2e/` (criterio 26.1: 6 pasos + 6 sabotajes), `acceptance/` (pipeline cap. 28: 10 criterios + informe), `tests/gamedays/` + `docs/gamedays/` (7 guiones de caos, game day M3 6/6) | Incluido en `npm test` (19 tests E12) + pipeline de aceptación 10/10 VERDE | **Verde en la capa verificable** | Detectó los hallazgos H1–H7 (abajo). GD-5 y ejecución containerizada [PENDIENTE de staging]. Ver `docs/entrega-E12.md` |

### Cifras de la última verificación completa (2026-07-16, ia-server, Node v20.19.2)

- `npm test` (línea base al clonar): **309 pasan, 2 fallan, 3 skipped** (314). Los 2 fallos:
  1. Flaky de E5 (`protocol-server.test.ts:306`) — **resuelto**: el test estaba mal planteado,
     comparaba los hashes de dos ejecuciones EN VIVO de la misma semilla, cosa que el jitter
     real de red/SO no garantiza (un comando llega a tiempo en una ejecución y tarde en otra,
     y eso es comportamiento correcto). Se reescribió para verificar AUTOCONSISTENCIA: una
     sola ejecución en vivo con fuzzing debe reproducirse exactamente en replay con
     `verify()` de `replay.ts` (mecanismo de E2 reutilizado, no reimplementado).
  2. `replay-golden.test.ts` tamaño de replay — fallo de ENTORNO (Node 20 sin
     `zstdCompressSync`); pasa en Node ≥ 22.15.
- Validadores E1: ambos "TODO CORRECTO".
- SDK Python: `pytest` 45/45 en 60,8 s (necesita `pip install -e ".[dev]"` en `sdks/python`).
- Tras E6 (2026-07-16): `npm test --maxWorkers=2` → **376 pasan, 1 falla, 3 skipped** (380).
  El único fallo sigue siendo el zstd de entorno (E2/T2.6, Node 20). E6 añadió +66 tests
  sin regresiones. Pipeline completo de un bot Python: ~321 ms (umbral 3 min).
- **Tras integrar E6+E7+E10 en main (2026-07-16): `npm test --maxWorkers=2` →
  492 pasan, 1 falla, 3 skipped (496).** El único fallo sigue siendo el zstd de entorno,
  reverificado ejecutando `replay-golden.test.ts` en aislado. Desglose de lo añadido:
  +60 tests E7 (contra PostgreSQL 18.4 embebido real) y +56 tests E10. E7 y E10 se
  desarrollaron en ramas (`e7-plataforma`, `e10-devops`) mergeadas a main con `--no-ff`;
  conflictos resueltos: unión de devDependencies en `package.json`, unión de patrones
  include en `vitest.config.ts`, lockfile regenerado con `npm install`.
- **Tras integrar E8+E9 en main (2026-07-16, tarde): `npm test --maxWorkers=2` →
  592 pasan, 1 falla, 3 skipped (596).** El único fallo sigue siendo el zstd de entorno,
  reverificado en aislado. +52 tests E8 y +48 tests E9; los merges de `e8-visor` y
  `e9-torneos` entraron sin conflictos.
- **Verificación con Docker real en VM108 (2026-07-16, autorizada por el operador):**
  suite E6 66/66 y E10 51/51 (ejecutables) verdes dentro de un contenedor `node:22`;
  `docker compose config` real de todos los perfiles correcto (10/11/19 servicios);
  escáner de Compose 0 infracciones. La v1 en producción quedó intacta y el entorno de
  prueba se limpió. **No se pudo levantar el stack v2 ni construir runtimes**: VM108 no
  tiene salida a internet para Docker (ver deudas). Addenda en `entrega-E6.md` y
  `entrega-E10.md`.

### Hallazgos de integración de E12 (priorizados, detalle en `docs/entrega-E12.md`)

- **H1 (E6, P1):** los builtins peligrosos de stdlib (`socket`, `subprocess`…) solo generan
  hallazgo de auditoría, no bloquean `static_analysis`; sin el sandbox containerizado, un
  bot hostil de solo-stdlib llega a `validated`. Mitigación real = sandbox Docker (pendiente
  de entorno).
- **H2 (E9→E8, P2):** el tournament-worker aún no cablea `attachBattle()` (espectador en
  vivo) ni `runStatsJob()` (stats ricas) — reconciliación declarada por ambos equipos.
- **H3 (E8/E9, P2):** `battle_stats` se escribe con dos formas según el camino; unificar al
  cerrar H2.
- **H4 (E10, P2):** la CI construye imágenes de solo 2 de 8 servicios.
- **H5–H7 (P3):** `cpuMs` null (runner E6/E9), rutas de rating/standings por equipos, 7
  errores de `tsc --noEmit` preexistentes (typecheck no bloqueante en CI).

## Hallazgos / deudas conocidas

- **Node 20 vs 22**: el repo asume Node ≥ 22.15 para el test de compresión zstd de replays.
  Decidir: subir Node en ia-server o declarar `engines` en package.json.
- **Docker inaccesible para `ia02`**: añadir el usuario al grupo `docker` (o dar acceso
  equivalente) antes de E6/E10 si se quiere verificación real y no solo por inspección.
- **VM108 sin salida a internet para Docker** (detectado 2026-07-16): no puede hacer pull
  de docker.io/ghcr.io, lo que bloquea builds y `compose up` allí. Llamativo porque la v1
  se desplegó en esa VM en su día — probable cambio posterior de DNS/firewall/router.
  Diagnóstico pendiente (operador o s9-sysadmin). Alternativa: GitHub Actions (la CI de
  E10 ya lo cubre con Node 22 + Docker).
- **Documentación alineada (revisión 2026-07-16):** ADR-000 pasado a Aceptado con firmas
  verificadas por implementación; `ROADMAP.md` marcado como histórico del prototipo v1
  (la fuente de verdad es el dosier + este documento).
