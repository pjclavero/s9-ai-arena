# Tests

## Resumen

Qué suites existen, cómo se ejecutan en local y en CI, qué flags activan las lentas o las que
necesitan servicios reales, y —tan importante como lo anterior— **qué no prueban**. Todos los tests
son Vitest salvo el SDK Python (pytest) y la aceptación visual/perf (Playwright, fuera de `npm test`).

## Índice

- [Comandos](#comandos)
- [Suites](#suites)
- [PostgreSQL embebido y la separación pure/db](#postgresql-embebido-y-la-separación-puredb)
- [Flags y variables](#flags-y-variables)
- [Mutaciones y autopruebas](#mutaciones-y-autopruebas)
- [Límites conocidos](#límites-conocidos)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Comandos

| Comando | Qué ejecuta |
|---|---|
| `npm test` | toda la configuración base (`vitest.config.ts`): `apps`, `packages`, `sdks`, `example-bots`, `infrastructure`, `tests/{e2e,acceptance,gamedays}` |
| `npm run test:pure` | lo mismo **excepto** los ficheros que arrancan PostgreSQL (`startTestDb`) |
| `npm run test:db` | **sólo** los ficheros con `startTestDb` (falla si no encuentra ninguno) |
| `npx vitest run <ruta>` | un fichero o carpeta |
| `npm run typecheck` | `tsc --noEmit` raíz + `apps/web` |
| `npm run lint` | linter de determinismo del motor |
| `npm run format:check` | Prettier |
| `npm run test:visual` | aceptación visual Playwright (requiere instalar Playwright y navegador; no está en `package.json`) |
| `cd sdks/python && python -m pytest tests/ -q` | SDK Python |
| `npm run test:browser` | E2E de navegador real (`tests/browser/run.sh`): entorno aislado, fase **golden** (recorrido completo con build y batalla reales en Docker) y fases 1-3; Node ≥ 22.15 y Docker local ([frontend.md](../technical/frontend.md#e2e-de-navegador)). En CI: job obligatorio `functional-e2e` ([ci.md](ci.md#gate-funcional-functional-e2e)) |

Timeout por test: 180 s; hooks: 60 s.

## Suites

| Zona | Dónde | Qué cubre |
|---|---|---|
| API | `apps/api/src/**/*.test.ts` | rutas, RBAC, auth/TOTP, conformidad con `openapi.yaml`, migraciones, seeds, puertas de `/run`, espectador y replays públicos |
| Motor | `apps/arena-engine/tests` | física, goldens, determinismo (100 ejecuciones; 1000 en nightly), regresiones (`*-regression.test.ts`), inspector, checkpoint |
| Worker | `apps/tournament-worker/src` | cola (claim por fila), semántica de la señal Redis, degradación, standings |
| bot-manager | `apps/bot-manager/tests` | pipeline de build/firma, política del proxy de Docker |
| replay-service, map-service | `apps/*/src`, `apps/*/tests` | almacenamiento, ingesta firmada |
| Web | `apps/web/tests/*.test.tsx` | páginas con Testing Library + jsdom y **API simulada** (`vi.mock`, `fetch` sustituido) |
| Paquetes | `packages/**` | protocolo, catálogo y balance, esquema de mapas, readiness (con mutaciones), first-run |
| SDKs | `sdks/**`, `sdks/shared-contract-tests` | contrato JSON común JS/Python |
| Bots de ejemplo | `example-bots/**` | partidas con los bots de ejemplo (algunas sólo con `RUN_SLOW=1`) |
| Infraestructura | `infrastructure/tests` | compose, gates, backup/restore (con scripts reales), escáneres, observabilidad |
| E2E | `tests/e2e` | MVP en proceso (API + BD embebida + motor real) y sus sabotajes; smoke de batalla con contenedores sólo con Docker |
| Game days | `tests/gamedays` | guiones de caos automatizados |
| Sandbox | `tests/sandbox-escape` | intentos de escape; CI de seguridad con Docker |

## PostgreSQL embebido y la separación pure/db

`scripts/list-db-tests.mjs` recorre `apps`, `packages`, `sdks`, `example-bots`, `infrastructure` y
`tests` buscando el marcador `startTestDb` y genera la lista que `vitest.db.config.ts` incluye y
`vitest.pure.config.ts` excluye. Cada fichero de BD arranca su propio clúster embebido en un puerto
libre (ADR-E7-002). Con `DATABASE_URL` definida se usa ese servidor con bases efímeras.

## Flags y variables

| Variable | Efecto |
|---|---|
| `RUN_SLOW=1` | activa las suites lentas: winrate de bots de ejemplo (20 batallas por bot) y CTF 2v2 cruzado JS/Python |
| `PYTHON_BIN` | intérprete con `arena-sdk` para el CTF 2v2 (por defecto `sdks/python/.venv`) |
| `DETERMINISM_RUNS` | repeticiones del test de determinismo (la nightly usa 1000) |
| `REDIS_TEST_URL` | activa el contrato contra un **Redis real** en `redis-signal-semantics.test.ts`; sin ella se usa un doble |
| `S9_E2E_STATE`, `S9_E2E_PORT_BASE`, `S9_E2E_TAG` | `run.sh`: directorio de estado, primer puerto y prefijo de los contenedores propios |
| `S9_E2E_PG_URL`, `S9_E2E_REDIS_URL` | `run.sh`: PostgreSQL externo (BD efímera con CREATEDB) en lugar del embebido, y Redis para el worker; los usa la CI |
| `S9_RUN_REAL_DOCKER_E2E` | habilita los E2E de batalla real con contenedores: `tests/e2e/e2e-real-battle-smoke.test.ts` y `apps/tournament-worker/src/container-battle-e2e.test.ts` (build real + artefacto firmado + batalla, cierre funcional) |
| `S9_RUN_DOCKER_SANDBOX_E2E` | habilita los E2E del sandbox de build (`apps/bot-manager/tests/build-sandbox-docker.test.ts`, `apps/api/src/fc-a-bot-pipeline-e2e.test.ts`) |
| `S9_SANDBOX_ADVERTISE_HOST` | IP de este host alcanzable desde los contenedores de bots (por defecto, la primera IPv4 no interna) |
| `DATABASE_URL` | PostgreSQL externo en lugar del embebido |
| `ARENA_DEV_INSECURE_SECRETS=1` | secretos efímeros (lo fija el arnés de BD) |

## Mutaciones y autopruebas

Los gates de infraestructura tienen `--self-test` (controles positivo y negativo) y arneses
`*-mutations.mjs` que estropean el código y exigen que la suite se ponga roja. Lista y uso en
[workflow.md](workflow.md#4-controles-negativos-y-mutaciones).

## Límites conocidos

- **Web con API simulada**: los tests de `apps/web` no ejercen la API real; defectos de costura
  (p. ej. `rulesetId` de modo frente al `mvp-default` de la BD) pasan en verde
  ([TD-003](../roadmap/technical-debt.md#td-003), [TD-018](../roadmap/technical-debt.md#td-018)).
- **E2E con Docker fuera de `unit`**: los E2E opt-in (`S9_RUN_*`) quedan `skipped` en `npm test`
  y en el job `unit`; **sólo** cuentan porque el job `functional-e2e` los activa y exige 0 `skipped`
  ([ci.md](ci.md#gate-funcional-functional-e2e), TD-045). `tests/e2e/e2e-real-battle-smoke.test.ts`
  (smoke contra el despliegue real, paso de operación) sigue fuera de CI a propósito.
- **E2E del MVP en proceso**: usa los bots stub del motor; la ejecución de código de usuario en
  contenedores queda `skipped` y así se declara ([TD-002](../roadmap/technical-debt.md#td-002)).
- La matriz RBAC tiene tests tautológicos (comparan la matriz consigo misma)
  ([TD-018](../roadmap/technical-debt.md#td-018)).
- Algunos tests de infraestructura usan `unshare -rm`; en máquinas o runners con userns restringido
  fallan por entorno (causa de parte del rojo de la nightly, [TD-019](../roadmap/technical-debt.md#td-019)).
- El fichero `apps/arena-engine/tests/regression-locks.test.ts` citado por documentos antiguos
  **no existe**; los candados están en los `*-regression.test.ts` (ver
  [../testing/engine/ENGINE_REGRESSION_LOCKS.md](../testing/engine/ENGINE_REGRESSION_LOCKS.md), histórico).

## Documentación relacionada

[setup.md](setup.md) · [ci.md](ci.md) · [workflow.md](workflow.md) · [../testing/index.md](../testing/index.md)
(evidencias históricas de pruebas) · [ADR-E7-002](../adr/ADR-E7-002-postgres-embebido-en-tests.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `include` de Vitest y timeouts | CODE_VERIFIED | `vitest.config.ts` |
| Separación pure/db por `startTestDb` | CODE_VERIFIED | `scripts/list-db-tests.mjs`; `vitest.pure.config.ts`; `vitest.db.config.ts` |
| `RUN_SLOW`, `PYTHON_BIN`, `DETERMINISM_RUNS`, `REDIS_TEST_URL`, `S9_RUN_REAL_DOCKER_E2E` | CODE_VERIFIED | `example-bots/**/*.test.ts`; `.github/workflows/nightly.yml`; `apps/arena-engine/tests/determinism.test.ts`; `apps/tournament-worker/src/redis-signal-semantics.test.ts:348`; `tests/e2e/e2e-real-battle-smoke.test.ts` |
| Tests de web con `vi.mock` / `fetch` sustituido | CODE_VERIFIED | `apps/web/tests/admin-ops-pages.test.tsx:12`; `admin-visibility.test.tsx:34-35` |
| E2E MVP en proceso con stubs | CODE_VERIFIED | cabecera de `tests/e2e/mvp-success.e2e.test.ts` |
| Playwright no está en `package.json` | CODE_VERIFIED | `package.json` (sin `@playwright/test`) |
| Inventario de E2E opt-in y su activación en CI | CODE_VERIFIED | `grep -rn S9_RUN_` (5 ficheros); `.github/workflows/functional-e2e.yml` |
| Suites no ejecutadas en esta consolidación (Node 20 en la máquina de trabajo) | — | las cifras de verde/rojo vienen de la auditoría y de la CI |
