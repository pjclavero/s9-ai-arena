# Integración continua (GitHub Actions)

## Resumen

Los cinco workflows de `.github/workflows/`, cuándo se disparan, qué jobs tienen y qué significa
su resultado. Incluye los dos puntos que más confunden: la **nightly está en rojo crónico** y
**`deploy-staging` no despliega nada** aunque salga en verde.

## Índice

- [Workflows](#workflows)
- [`ci.yml`](#ciyml)
- [El semáforo](#el-semáforo)
- [`deploy-staging` y `smoke-and-promote`](#deploy-staging-y-smoke-and-promote)
- [`nightly.yml`](#nightlyyml)
- [`e6-security.yml`](#e6-securityyml)
- [`acceptance.yml` y `runtimes-publish.yml`](#acceptanceyml-y-runtimes-publishyml)
- [Cómo leer la CI](#cómo-leer-la-ci)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Workflows

| Workflow | Disparadores | Propósito |
|---|---|---|
| `ci.yml` (`ci`) | `pull_request`; `push` a `main` | calidad, tests, imágenes, gates, escaneo, E2E, semáforo |
| `nightly.yml` | cron `30 3 * * *` (UTC) + manual | determinismo ×1000 y suites lentas |
| `e6-security.yml` (`E6 security`) | `pull_request`; `push` a `main` | chequeos estáticos de seguridad, digests, escaneo de runtimes, escape del sandbox |
| `acceptance.yml` | cron `45 4 * * *` + manual | criterios de aceptación; publica `docs/aceptacion/ultimo-informe.md` como artefacto |
| `runtimes-publish.yml` | sólo manual | construir y publicar las imágenes de runtime de bots en GHCR |

Concurrencia de `ci.yml`: un grupo por ref; en PR se cancela la ejecución anterior.

## `ci.yml`

Node `22.15` en todos los jobs (`NODE_VERSION`).

| Job | Depende de | Qué hace |
|---|---|---|
| `lint-format-types` | — | `npm ci`, `npm run lint`, `typecheck`, `format:check` |
| `unit` | — | habilita userns sin privilegios en el runner y ejecuta `vitest run apps packages infrastructure` con cobertura V8 (excluye los dos E2E SFTP) |
| `contracts` | — | `vitest run sdks` + `pytest` del SDK Python |
| `regression-battles` | — | goldens, determinismo (100) y bots de ejemplo: `vitest run apps/arena-engine/tests example-bots` |
| `build-images` | lint, unit, contracts, regression | matriz de 11 imágenes (gateway, arena-engine, web, api, tournament-worker, bot-manager, map-service, replay-service, streamer, backup, bot-runtime-python) con `BUILD_COMMIT`; **push sólo en `main`** con etiquetas `sha-<sha>` y `v<versión>` |
| `e2e-backup-sftp` | unit, build-images | E2E de backup contra SFTP con chroot y PostgreSQL reales (Docker) |
| `e2e-restore-sftp-bootstrap` | unit, build-images | E2E de restauración desde un contenedor nuevo |
| `image-provenance` | — | ADR-016: control positivo y negativo de procedencia de imagen, deriva de image ID, compose canónico, contrato de despliegue, backup-stack, override de versión, release-gate (con sus mutantes) |
| `scan` | build-images | `npm audit`, escaneo del compose y Trivy, clasificados por `scan-gate.mjs` (ADR-018) |
| `e2e-mvp` | — | `vitest run tests/e2e` |
| `deploy-staging` | scan, e2e-mvp | sólo en `main`; ver abajo |
| `smoke-and-promote` | deploy-staging | sólo en `main`; environment `production` con aprobación manual |
| `semaforo` | todos | `if: always()`; veredicto del run |

Los tests de `tests/gamedays` y `tests/acceptance` no están en ningún job de `ci.yml` (sí en `npm test`
y en la nightly).

## El semáforo

`semaforo` corre siempre y aplica `infrastructure/scripts/ci-gate.mjs` (con tests en
`infrastructure/tests/ci-gate.test.ts`):

- 🔴 algún job falló → el job falla y bloquea;
- 🟡 hubo trabajo **omitido** (p. ej. staging sin configurar) → job verde, check «Semáforo CI» en
  `neutral`, avisos y resumen; lo omitido **no** cuenta como aprobado;
- 🟢 todo ejecutado de verdad.

## `deploy-staging` y `smoke-and-promote`

- Si el secreto `STAGING_HOST` **no** está definido: `resultado=omitido` (semáforo amarillo).
- Si **está** definido: imprime «Desplegando…», **no ejecuta nada** (el `ssh` está comentado) y
  escribe `resultado=desplegado`. Es un **verde falso latente** ([TD-019](../roadmap/technical-debt.md#td-019)).
- `smoke-and-promote` sólo actúa si el anterior dijo `desplegado`; ejecutaría `smoke.sh`, que
  comprueba rutas que no reflejan la salud real ([TD-020](../roadmap/technical-debt.md#td-020)).
- La CI no lee `STAGING_SSH_KEY` aunque documentos antiguos lo pidan.

Conclusión: **la CI no despliega**. El despliegue es manual ([../operations/upgrades.md](../operations/upgrades.md)).

## `nightly.yml`

| Job | Qué hace | Estado |
|---|---|---|
| `determinism-1000` | `DETERMINISM_RUNS=1000` sobre `determinism.test.ts` | verde |
| `slow-suites` | crea `sdks/python/.venv`, `RUN_SLOW=1 npm test` | **rojo crónico**: las últimas 40 ejecuciones en `failure` a 2026-10-15 |

Causas medidas en la auditoría (2026-10-14): `infrastructure/tests/b13-data-volumes` falla porque
el job nightly no habilita `unshare -rm` (el job `unit` de `ci.yml` sí lo hace), y
`restore-sftp-bootstrap` necesita la imagen `s9-ai-arena/backup:e2e-test`, que en `ci.yml` construye
`build-images` y en la nightly no se carga. El resto de la suite pasa. Seguimiento:
[TD-019](../roadmap/technical-debt.md#td-019).

## `e6-security.yml`

| Job | Qué hace |
|---|---|
| `static-checks` | chequeos estáticos del sandbox/runtimes |
| `digests-gate` | decide si `runtimes/DIGESTS.lock` tiene digests reales (`real_digests`) |
| `runtime-vuln-scan`, `sandbox-escape` | sólo si `real_digests == 'true'`; si no, quedan **skipped** (gris), nunca verdes sin probar |

## `acceptance.yml` y `runtimes-publish.yml`

- `acceptance.yml` ejecuta `acceptance/run-acceptance.mjs`, que escribe la tabla en
  `docs/aceptacion/ultimo-informe.md` y la sube como artefacto (por eso ese fichero no se mueve).
- `runtimes-publish.yml` construye `bot-runtime-<runtime>` en GHCR etiquetado con el sha y muestra
  el digest para fijarlo a mano en `runtimes/DIGESTS.lock` ([releases.md](releases.md#runtimes-de-bots)).

## Cómo leer la CI

```bash
gh pr checks <n> --json name,state,bucket
gh run list --workflow nightly.yml --limit 10
```

Se cuentan **todas** las conclusiones. `skipped`, `neutral` y en curso no son éxito; un recuento
vacío no es verde (ADR-017 §10). No uses el final de `gh run watch` como veredicto.

## Documentación relacionada

[workflow.md](workflow.md) · [testing.md](testing.md) · [releases.md](releases.md) ·
[../operations/upgrades.md](../operations/upgrades.md) · [ADR-017](../adr/ADR-017-contrato-de-release.md) ·
[ADR-018](../adr/ADR-018-semantica-del-scan.md) · Informes históricos de la CI:
[../history/rondas/ronda2/reportes/R2.2-semaforo-ci.md](../history/rondas/ronda2/reportes/R2.2-semaforo-ci.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Disparadores y jobs de los 5 workflows | CODE_VERIFIED | `.github/workflows/*.yml` parseados (`on:`, `jobs:`, `needs:`, `if:`) |
| `unit` habilita userns y excluye los E2E SFTP | CODE_VERIFIED | `ci.yml:72-105` |
| Matriz de 11 imágenes; push sólo en `main`; etiquetas | CODE_VERIFIED | `ci.yml:290-377` |
| `deploy-staging` con `ssh` comentado y `resultado=desplegado` | CODE_VERIFIED | `ci.yml:930-947` |
| Nightly 40/40 en rojo y causas | RUNTIME_VERIFIED (auditoría 2026-10-15, historial de Actions) | runs del workflow `nightly` |
| Jobs de E6 condicionados a `real_digests` | CODE_VERIFIED | `e6-security.yml` (`if: needs.digests-gate.outputs.real_digests == 'true'`) |
