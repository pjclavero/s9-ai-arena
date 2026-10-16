# Estructura del repositorio

## Resumen

Mapa del monorepo tal como está en `27f70bb`: qué contiene cada carpeta, qué es código de la
plataforma v2 (lo que se despliega), qué es contrato compartido y qué es resto del prototipo v1.
La arquitectura funcional (cómo se hablan los servicios) está en
[../technical/architecture.md](../technical/architecture.md) y [../technical/services.md](../technical/services.md).

## Índice

- [Vista general](#vista-general)
- [`apps/`](#apps)
- [`packages/`](#packages)
- [`sdks/`, `runtimes/`, `example-bots/`, `bots/`](#sdks-runtimes-example-bots-bots)
- [`infrastructure/`](#infrastructure)
- [`tests/`, `acceptance/`](#tests-acceptance)
- [`scripts/`](#scripts)
- [Datos y otros](#datos-y-otros)
- [Cómo se importa el código](#cómo-se-importa-el-código)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Vista general

```
apps/            servicios desplegables (v2) + 2 piezas del prototipo v1
packages/        librerías compartidas y contratos (TypeScript)
sdks/            SDKs para autores de bots (JS, Python) + tests de contrato compartidos
runtimes/        imágenes de runtime de bots (node, python) y sus digests fijados
example-bots/    bots de ejemplo (JS, Python) usados también como tests
bots/            bot de humo (s9-smoke-bot) y bots del prototipo v1
infrastructure/  compose, Dockerfiles, gateway, backup, scripts de gates, systemd, tests de infra
tests/           E2E, aceptación, game days, goldens, mapas rotos, perf, sandbox-escape
acceptance/      criterios de aceptación ejecutables y aceptación visual (Playwright)
scripts/         utilidades de repositorio (readiness, node, digests, smoke, mutantes)
maps/            mapas de referencia (JSON, Tiled)
docs/            documentación (ver docs/README.md)
```

## `apps/`

| App | Qué es | Entrypoint | Despliegue |
|---|---|---|---|
| `api` | API REST de la plataforma (Express 5, Knex/PostgreSQL), contrato `openapi.yaml` | `src/server.ts`; CLI de BD `src/db/cli.ts` | servicio `api` |
| `arena-engine` | motor de simulación 2D (Rapier), servicio `/run` y servidor de protocolo para bots | `src/service.ts`; CLI `src/cli.ts` | servicio `arena-engine` |
| `tournament-worker` | ejecuta batallas y torneos desde la cola (PostgreSQL + aviso Redis), gateway WebSocket de espectador | `src/main.ts` | servicio `tournament-worker` |
| `bot-manager` | control de bots; pipeline de build/firma (`build-worker-main.ts`); proxy de Docker del host (`docker-proxy-main.ts`) | `src/main.ts` | servicios `bot-manager`, `bot-build-worker`; proxy en systemd |
| `replay-service` | almacén de replays en disco, ingesta firmada, lectura | `src/main.ts` | servicio `replay-service` |
| `map-service` | almacén de mapas en memoria | `src/main.ts` | servicio `map-service` (sin uso, [TD-017](../roadmap/technical-debt.md#td-017)) |
| `web` | panel React + Vite, visor Phaser, editor de mapas y loadouts | `src/main.ts` | servicio `web` |
| `streamer` | retransmisión de la vista `/broadcast` (ffmpeg + navegador) | `src/main.ts` | perfil `streaming` (no desplegado) |
| `arena-server`, `arena-viewer` | **prototipo v1** (demo de tanques) | — | sólo `docker-compose.demo.yml`; fuera del `tsconfig` |

## `packages/`

| Paquete | Contenido |
|---|---|
| `protocol` | protocolo `arena/1` motor↔bot (esquemas JSON, validación) — contrato |
| `module-catalog` | catálogo de módulos y loadouts, validador, balance — contrato |
| `map-schema` | esquema y validación de mapas — contrato |
| `game-rules` | constantes de juego (fuente: ADR-000), temporización, `safeLookup` |
| `build-info` | identidad de build ADR-016 (`/version`, `BUILD_COMMIT`) |
| `data-dir` | comprobación de directorios de datos escribibles |
| `readiness` | motor y sondas de readiness R17 ([../operations/readiness.md](../operations/readiness.md)) |
| `first-run` | modelo del asistente de primer arranque (13 dominios) |
| `shared-types` | placeholder (sólo README) |

Política de cambio de contratos: [contract-compatibility.md](contract-compatibility.md).

## `sdks/`, `runtimes/`, `example-bots/`, `bots/`

- `sdks/javascript` (`@arena/sdk`, workspace) y `sdks/python` (`arena-sdk`, `pyproject.toml`); `sdks/shared-contract-tests` con la suite JSON común; `sdks/dotnet` y `sdks/java` son placeholders post-MVP.
- `runtimes/node`, `runtimes/python`: Dockerfiles de runtime y `ALLOWED-PACKAGES.md`; `runtimes/DIGESTS.lock` fija por digest base e imagen ([releases.md](releases.md#runtimes-de-bots)).
- `example-bots/{javascript,python}`: bots de ejemplo con tests (algunos sólo con `RUN_SLOW=1`).
- `bots/s9-smoke-bot`: bot de humo que se copia a la imagen Node; `bots/bot-red`, `bots/bot-blue`: prototipo v1.

## `infrastructure/`

| Ruta | Contenido |
|---|---|
| `docker-compose.yml` | **el** compose de la plataforma (22 servicios, perfiles) |
| `.env.example` | plantilla de configuración |
| `deploy-contract.json` | contrato de despliegue (servicios, perfiles, overrides, servicios con estado) |
| `docker/<servicio>/Dockerfile` | imágenes (`node-service` genérico para api/worker/map/replay) |
| `gateway/nginx.conf`, `nginx-behind-proxy.conf` | modos del gateway |
| `backup/` | `backup.sh`, `restore.sh`, `healthcheck.sh`, `evidence.sh`, `entrypoint.sh` |
| `scripts/` | gates y herramientas: `release-gate`, `verify-image-provenance`, `check-running-image-id`, `tag-override-gate`, `deploy-contract-gate`, `backup-stack-gate`, `compose-canonical-check`, `scan-gate`, `runtime-drift-scan`, `preflight-apagado.sh`, `init-secrets.sh`, `install-docker-proxy.sh`, `smoke.sh`, y sus `*-mutations.mjs` |
| `systemd/` | unidad y ejemplo de configuración del proxy de Docker |
| `observability/` | Prometheus, Alertmanager, Grafana, Loki, Promtail (perfil `observability`) |
| `tests/` | tests de infraestructura (vitest): backup/restore, gates, compose, escáneres |
| `secrets/` | **no versionado** salvo `.gitignore` y `README.md` |

## `tests/`, `acceptance/`

| Ruta | Qué prueba |
|---|---|
| `tests/e2e` | MVP de extremo a extremo en proceso (`mvp-success`, `mvp-sabotage`) y smoke de batalla real (`e2e-real-battle-smoke`, sólo con Docker) |
| `tests/acceptance` | mapas publicados validados |
| `tests/gamedays` | guiones de caos automatizados (game day M3) |
| `tests/golden` | partidas doradas de física |
| `tests/maps-broken` | mapas inválidos que el validador debe rechazar |
| `tests/perf` | visor a 60 fps (Playwright; no forma parte de `npm test`) |
| `tests/sandbox-escape` | suite de escape del sandbox (Docker; CI de seguridad) |
| `acceptance/` | `criteria.mjs` + `run-acceptance.mjs` (escribe `docs/aceptacion/ultimo-informe.md`); `visual/` Playwright |

## `scripts/`

`readiness.ts` (CLI R17), `check-node.mjs`, `list-db-tests.mjs` (separa la suite de BD),
`verify-runtime-digests.ts`, `assert-real-digest.ts`, `scan-compose.ts`, `scan-runtime-vulns.sh`,
`e2e-real-battle-smoke.ts`, `runtime-deps-audit.mjs` (dependencias de runtime declaradas),
`r17-first-run-mutants.mjs`, `worker-degradation-mutants.{mjs,sh}`.

## Datos y otros

`maps/` (mapas de referencia, el `mvp-arena-01` lo siembra `bootstrap`), `data/replays/` (datos de
ejemplo), `.changeset/` (configuración de changesets), `Dosier_tecnico_….docx` y
`s9-ai-arena-part2.zip` en la raíz (material histórico del proyecto), `docker-compose.demo.yml` y
`.env.example` raíz (prototipo v1).

## Cómo se importa el código

Las apps no son workspaces: importan `packages/*` por **ruta relativa** con extensión
(`../../../packages/build-info/index.js`), con `allowImportingTsExtensions` y `tsx` en tiempo de
ejecución. `tsconfig.json` cubre `apps/**` y `packages/**` salvo `apps/web` (con su propio
`tsconfig`) y las dos apps v1; `npm run typecheck` compila ambos.

## Documentación relacionada

[setup.md](setup.md) · [testing.md](testing.md) · [../technical/services.md](../technical/services.md) ·
[../technical/architecture.md](../technical/architecture.md) · [../operations/docker.md](../operations/docker.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Carpetas y entrypoints | CODE_VERIFIED | `ls` del árbol en `27f70bb`; `SERVICE_ENTRY` del compose |
| Apps v1 excluidas de `tsconfig`; `typecheck` incluye `apps/web` | CODE_VERIFIED | `tsconfig.json`; `package.json` `typecheck` |
| `docker-compose.demo.yml` es el prototipo v1 | CODE_VERIFIED | cabecera del fichero |
| `run-acceptance.mjs` escribe `docs/aceptacion/ultimo-informe.md` | CODE_VERIFIED | `acceptance/run-acceptance.mjs:89-90` |
| 22 servicios en el compose | RUNTIME_VERIFIED | `docker compose config --services` con todos los perfiles |
