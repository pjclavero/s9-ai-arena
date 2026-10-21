# Integración continua (GitHub Actions)

## Resumen

Los seis workflows de `.github/workflows/`, cuándo se disparan, qué jobs tienen y qué significa
su resultado. Incluye los dos puntos que más confunden: la **nightly está en rojo crónico** y
**`deploy-staging` no despliega nada** aunque salga en verde. Desde TD-045 el golden path funcional
real (`functional-e2e`) es un job obligatorio del semáforo.

## Índice

- [Workflows](#workflows)
- [`ci.yml`](#ciyml)
- [El semáforo](#el-semáforo)
- [Gate funcional: `functional-e2e`](#gate-funcional-functional-e2e)
  - [Job `container-proxy-e2e` (RC2)](#job-container-proxy-e2e-rc2)
- [Protección de rama](#protección-de-rama)
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
| `functional-e2e.yml` | `workflow_call` desde `ci.yml` (todo PR y push a `main`); `workflow_dispatch` (gate manual de release) | golden path real en navegador + E2E Docker (TD-045) |
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
| `functional-e2e` | — | reusable `functional-e2e.yml`: jobs `golden`, `docker-e2e` y `container-proxy-e2e` ([abajo](#gate-funcional-functional-e2e)); sin `if:` ni `continue-on-error` |
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

`functional-e2e` es clase `obligatorio`: `skipped`, `cancelled`, `failure` o ausente en `needs` ⇒ 🔴
en PR y en `main` (tests G2 de `infrastructure/tests/functional-e2e-gate.test.ts`, y calibración 4
en CI real, abajo).

## Gate funcional: `functional-e2e`

Objetivo (TD-045): que **CI verde implique que el núcleo funcional real sigue funcionando**. Nada de
mocks internos de S9. Definido en `.github/workflows/functional-e2e.yml`, en `ubuntu-24.04` (Docker
rootful del runner). Corre en paralelo con el resto de `ci.yml`.

| Job | Qué ejecuta | Veredicto |
|---|---|---|
| `golden` | `npm run test:browser` completo (`tests/browser/run.sh`): fase golden (registro → bot A con build REAL en el sandbox → `published` → bot B → `published` → equipo → mapa → batalla → ejecución con los artefactos firmados en contenedores → visor en directo → `finished` → ganador → stats → replay reproducido por la API autorizada), fases 1-3 y sonda TD-028 | rc de `run.sh` **y** `scripts/ci/assert-functional-e2e.mjs browser`: cada fase con ≥1 test y 0 `skipped`/`flaky`/fallidos; `agents=container`, gana `red`, el Artillero dispara y el Pacifista no; el replay se leyó por `/api/v1/replays/<id>/index` y `/segment` (200) y **ninguna** petición fue a `/replays*` del gateway (TD-004); sonda 4404/4401 |
| `docker-e2e` | `vitest run --maxWorkers=1` de `build-sandbox-docker.test.ts`, `build-sandbox-timing-docker.test.ts` (TD-034), `fc-a-bot-pipeline-e2e.test.ts`, `container-battle-e2e.test.ts` e `infrastructure/gateway/tests/replay-gateway.test.ts` (TD-004, nginx real fijado por digest) con `S9_RUN_DOCKER_SANDBOX_E2E=1`, `S9_RUN_REAL_DOCKER_E2E=1` y `S9_RUN_GATEWAY_SECURITY_E2E=1` | `assert-functional-e2e.mjs vitest`: los 5 ficheros presentes, `passed`, todos sus tests `passed` (un `describe.skipIf` sin opt-in ⇒ FALLA) |

Entorno del job `golden` (todo en el runner, `127.0.0.1`, `$RUNNER_TEMP`):

- PostgreSQL `16.14-alpine` y Redis `7.4.9-alpine` como *services*, **las mismas imágenes fijadas
  por digest que `infrastructure/docker-compose.yml`**, con healthcheck; `run.sh` además espera a
  que PostgreSQL acepte consultas (`S9_E2E_PG_URL`) y el worker usa Redis (`S9_E2E_REDIS_URL`).
- API, tournament-worker (motor `arena-engine` en proceso, como en producción la ejecución de
  batallas, y gateway WS de espectador), bot-build-worker, `s9-docker-proxy` LOCAL, replay-service:
  procesos reales del repo. El servicio HTTP `arena-engine` (`POST /run`) no está en el camino del
  golden path y no se arranca.
- Web (`vite build`) con la conf nginx real del contenedor web; gateway con
  `infrastructure/gateway/nginx-behind-proxy.conf`; TLS delante. nginx fijado por digest.
- Chromium 130 de `mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc47…` (fijado). Node
  `22.15.0` exacto.
- Orden de arranque por healthchecks (`run.sh`): PostgreSQL → API `/healthz` → replay-service →
  cadena TLS→gateway → heartbeat y `battleExecution=container` del worker → docker-proxy escuchando
  → bot-build-worker con `sandbox=container`.

Relojes (CI-7): cada paso tiene su `timeout-minutes` (deps 10, imágenes 15, E2E 35, veredicto 2,
evidencia 3, limpieza 3; job 60) y Playwright conserva los suyos por fase (build 240 s por bot,
golden 900 s). Las imágenes de runtime se descargan en un paso propio **antes** del E2E: el límite de
arranque del bot (TD-034, código de DEV-SANDBOX) nunca mide un `docker pull`. No se ha subido ningún
límite del código: `run.sh` fija `SANDBOX_STARTUP_TIMEOUT_MS=30000` y `BOT_EXECUTION_TIMEOUT_MS=5000`
para el tournament-worker y el bot-build-worker, los mismos defectos que el compose de producción y
`startup-clock.ts`; `functional-e2e-gate.test.ts` (G6) exige que los tres coincidan y que el workflow
no los sobrescriba.

Evidencia (CI-8), artifact `functional-e2e-golden-<intento>` (también en verde, 14 días):
`logs/` de cada servicio, `logs/containers/` (`docker ps -a` y `docker logs` de los contenedores
propios y de bots antes de borrarlos), `out/summary.txt` con el rc por fase, `report.json` y
`playwright.log` por fase, `test-results/` (trace y capturas de Playwright en fallo), `shots/`,
`golden/evidence.json` (resultado de la batalla) y `db-evidence.json` (builds con sus etapas = logs
de build, versiones, batallas, jobs). `scripts/ci/collect-functional-evidence.sh` nunca copia
`secrets/`, `certs/`, `pw.env` ni `db.url` y busca el contenido de cada secreto efímero en lo que
copia: si aparece, retira el fichero y el paso falla. `docker-e2e` sube el informe JSON de vitest.

Limpieza (CI-9): `scripts/ci/cleanup-functional-e2e.sh` con `if: always()` borra los contenedores
con el prefijo del run (`s9ci-<run>-<intento>-*`), los de bot residuales, sus volúmenes anónimos y
el estado temporal; los services los retira el runner. Pensado para el runner efímero: en una
máquina compartida no lo uses (borra todos los `bot-*`).

### Job `container-proxy-e2e` (RC2)

Por qué (RC1 `DEPLOYMENT_BLOCKED`, REVIEW P0-3, TD-052): `golden` y `docker-e2e` corren los
servicios como procesos del runner y hablan con el proxy por `127.0.0.1`; nunca ejercitaron
**contenedor en red interna → proxy del host**, que en producción daba `ENETUNREACH` mientras el
gateway público sí lo alcanzaba. Este job lo prueba con el stack real, en `ubuntu-24.04` (Docker
rootful, `sudo`):

| Fase (`tests/container-proxy-e2e/run.sh <fase>`) | Qué hace |
|---|---|
| `prepare` | secretos efímeros con `init-secrets.sh`; `docker compose config --format json` del perfil `production` con el entorno del job y **sin** `DOCKER_PROXY_URL` (defectos); `compose-check.mjs` juzga el render; cuerpos de create con `ProxyContainerRunner.buildCreateBody` (`make-bodies.ts`) |
| `build` | imágenes de gateway, web, api, arena-engine, tournament-worker, bot-manager (también bot-build-worker), map-service y replay-service **desde el commit** (`BUILD_COMMIT=github.sha`, `s9cpx-local/*:ci-<sha>`; nunca se descargan de GHCR) |
| `up` | `up --no-start` (crea `s9-bot-control` y su bridge con `10.89.250.1`) → `s9-docker-proxy` como **proceso del host** con `DOCKER_PROXY_BIND=10.89.250.1`, `DOCKER_PROXY_ALLOWED_CLIENTS=10.89.250.0/24` y la allowlist `runtimes/DIGESTS.lock` → postgres/queue → `cli.ts bootstrap` (nunca `seed`) → aplicación con `--wait`; exige `battleExecution=container` y `sandbox=container` |
| `probes` | sonda (`probe.mjs`, en `--network container:<objetivo>`) desde **cada** contenedor del stack y dos equivalentes declarados (backup en sus mismas redes; un «bot» sólo en `arena`): fase A **sin** firewall y fase B **con** el firewall de DEV-SECOPS; escucha del proxy |
| `flow` | `flow.mjs` por la API pública del gateway: registro → 2 bots con código → builds → `published` → mapa propio → batalla → `finished` → stats → replay |
| `policy` | política desde `bot-build-worker` (consumidor legítimo). Va **después** del flujo: con un proxy sin control de propiedad estas peticiones paran de verdad postgres y el gateway (visto en la calibración) |
| `evidence`, `cleanup` | `if: always()`; logs, eventos y redes saneadas; luego proxy parado, firewall retirado, `down -v` |

Veredicto (`scripts/ci/assert-container-proxy-e2e.mjs <out> <commit>`, `if: always()`): una fase
que no corrió deja su fichero ausente y **falla**.

| Regla | Exige |
|---|---|
| R1 | compose resuelto según el contrato RC2: red `bot-control` (`s9-bot-control`, interna, `s9-botctl0`, `10.89.250.0/24`), miembros = consumidores, alias a `10.89.250.1`, sin 2375/docker.sock/privileged, `tournament-worker` apagado por defecto |
| R2-R3 | imágenes con `revision` = commit; consumidores en `s9-bot-control` con IP de la subred; ejecutores reales |
| R4-R5 | proxy escuchando **sólo** en `10.89.250.1:2375`; firewall `apply` y `check` con rc 0 |
| R6 | consumidor ⇒ `ACCESS` (create válido 201); no consumidor sólo en redes internas ⇒ sin ruta; gateway y backup (red no interna) ⇒ fase A **el proxy deniega** (403/cierre, capa c), fase B **no conectan** (capa b) |
| R7 | desde un consumidor legítimo: imagen ajena, base de `DIGESTS.lock`, digest fuera del lock y labels `s9.*` forjadas ⇒ 403; stop/start/inspect/stats de postgres (por id y nombre) y stop del gateway ⇒ 403; postgres sigue con el mismo arranque; lo creado por el proxy lleva sus labels y se puede inspeccionar |
| R8 | 2 builds `passed` → `published`; batalla `finished`, `agents=container`, gana red, blue 0 intentos; replay por `/api/v1/replays` 200 y `/replays*` del gateway 404 |
| R9 | eventos de Docker: ≥2 contenedores de runtime vía proxy en los builds y ≥2 en la batalla; todo create es del Compose, del arnés o del proxy (un create sin labels = bypass) |

Evidencia: artifact `functional-e2e-container-proxy-<intento>` (compose config, `compose-check`,
`services.json`, sondas, política, `flow.json`, eventos, redes, logs del proxy y de cada contenedor;
`collect-functional-evidence.sh` retira cualquier fichero con material secreto). Hacerlo check
obligatorio de `main` lo decide REVIEW.

### Calibración en CI real (2026-10-18)

| PR | Mutación | `golden` | `docker-e2e` | `semaforo` | Otros jobs rojos |
|---|---|---|---|---|---|
| #153 | ninguna (control positivo) | PASS | PASS | PASS | — |
| #154 | `build-worker-wiring.ts`: el pipeline pierde el sandbox | FAIL | FAIL | FAIL | ninguno (`unit` verde) |
| #155 | `engine-executor.ts`: el executor de batalla lanza siempre | FAIL | FAIL | FAIL | `unit` |
| #156 | `ReplayPage.tsx`: `getScene` sin esperar a READY (TD-009) | FAIL | PASS | FAIL | ninguno (`unit` verde) |
| #157 | `functional-e2e` con `if: false` | skipped | skipped | FAIL (fila «obligatorio sin ejecutar») | `unit` (G1 lo detecta) |

Calibración sobre la integración (REVIEW de Production Readiness, `integration/production-readiness`):

| PR | Mutación | `golden` | `docker-e2e` | `semaforo` | Otros jobs rojos |
|---|---|---|---|---|---|
| #158 | ninguna (control positivo, HEAD `6a4c177`) | PASS | PASS (5 ficheros, 35 tests) | PASS | — |
| #159 | gateway: `/replays*` vuelve a hacer `proxy_pass` al replay-service (bypass de TD-004) | FAIL (fase1, `replay.spec`) | FAIL (`replay-gateway.test.ts`, 3 rojos) | FAIL | `unit` (`replay-page-gateway-path.test.ts`) |
| #160 | `ReplayPage.tsx`: el reproductor vuelve a leer `/replays/<id>/index` del gateway | FAIL (golden y fases 1-3) | PASS (no toca la web) | FAIL | ninguno (`unit` verde) |

Además, el primer run de #158 (HEAD `84cfb3a`) salió ROJO en `docker-e2e`: `container-battle-e2e.test.ts`
(opt-in, nunca ejecutado por DEV-SEC) verificaba el replay sin sesión y TD-004 lo deniega; corregido en
`6a4c177`. Es la clase de regresión que este gate existe para ver.

Los PR de calibración se cerraron y sus ramas se borraron.

### Gate manual de release

Antes de etiquetar o desplegar un commit: *Actions → functional-e2e → Run workflow* sobre ese
commit (o `gh workflow run functional-e2e.yml --ref <rama-o-tag>`), y exigir `success` en ambos
jobs. En `main` el mismo gate ya corre en cada push.

### Ejecutarlo como en CI (REVIEW, integración)

```bash
npm ci
export S9_E2E_STATE=$(mktemp -d /tmp/prcci-review.XXXXXX)
S9_E2E_TAG=prcci-review S9_E2E_PORT_BASE=47080 npm run test:browser
node scripts/ci/assert-functional-e2e.mjs browser "$S9_E2E_STATE/out"
S9_RUN_DOCKER_SANDBOX_E2E=1 S9_RUN_REAL_DOCKER_E2E=1 npx vitest run \
  apps/bot-manager/tests/build-sandbox-docker.test.ts apps/api/src/fc-a-bot-pipeline-e2e.test.ts \
  apps/tournament-worker/src/container-battle-e2e.test.ts --maxWorkers=1
```

Sobre la rama de integración basta con que los cambios de SEC/SANDBOX estén mergeados: el job no
necesita variables nuevas salvo que alguna rama las introduzca (se anotan en COORD).

## Protección de rama

Desde el 2026-10-19 `main` está **protegida** (protección de rama clásica; se consulta con
`gh api repos/pjclavero/s9-ai-arena/branches/main/protection`). Ningún PR se fusiona si el gate
funcional falla:

| Regla | Valor |
|---|---|
| Checks obligatorios | `semaforo` · `functional-e2e / golden (navegador real + build y batalla reales)` · `functional-e2e / docker-e2e (sandbox real + build → published + batalla A+B)` |
| Origen de los checks | GitHub Actions (`app_id` 15368): otro integrador con el mismo nombre no los satisface |
| Rama al día con `main` | obligatoria (`strict`) |
| Pull request | obligatorio; 0 aprobaciones (un solo desarrollador: GitHub no deja aprobar el PR propio) |
| Administradores | **incluidos** (`enforce_admins`): `gh pr merge --admin` también queda bloqueado |
| Force push y borrado de `main` | bloqueados |

- `semaforo` agrega todo, incluido `functional-e2e`, y falla con un `skipped`. Los dos jobs de
  `functional-e2e` se exigen además por su nombre, para que un cambio en el semáforo no pueda
  dejarlos fuera en silencio.
- No es obligatorio el check-run «Semáforo CI»: se crea por API y en PRs de fork puede no existir.
- Ningún workflow empuja a `main`, así que exigir PR no rompe ninguna automatización.

Comprobación funcional (2026-10-19, PR #161 desechable con la reproducción de replay rota):
`functional-e2e / golden` y `semaforo` en rojo, `unit` en verde; el merge se rechazó sin privilegios
(«the base branch policy prohibits the merge») y con `--admin` («2 of 3 required status checks are
failing»). Cambiar o quitar estas reglas es una decisión del operador y debe documentarse aquí.

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
| Disparadores y jobs de los 6 workflows | CODE_VERIFIED | `.github/workflows/*.yml` parseados (`on:`, `jobs:`, `needs:`, `if:`) |
| `functional-e2e` obligatorio y exigido por el semáforo; skipped ⇒ ROJO | CODE_VERIFIED + RUNTIME_VERIFIED | `infrastructure/tests/functional-e2e-gate.test.ts` (G1-G5); PR #153 (PASS) y calibraciones #154-#157 (ROJO) |
| `main` protegida: 3 checks obligatorios, `strict`, PR obligatorio, administradores incluidos, sin force push ni borrado | RUNTIME_VERIFIED (2026-10-19) | `gh api …/branches/main/protection` |
| Un rojo de `functional-e2e` bloquea el merge (también con `--admin`) | RUNTIME_VERIFIED (2026-10-19) | PR #161: golden y `semaforo` en rojo; `gh pr merge` y `gh pr merge --admin` rechazados; `main` sin cambios |
| `unit` habilita userns y excluye los E2E SFTP | CODE_VERIFIED | `ci.yml:72-105` |
| Matriz de 11 imágenes; push sólo en `main`; etiquetas | CODE_VERIFIED | `ci.yml:290-377` |
| `deploy-staging` con `ssh` comentado y `resultado=desplegado` | CODE_VERIFIED | `ci.yml:930-947` |
| Nightly 40/40 en rojo y causas | RUNTIME_VERIFIED (auditoría 2026-10-15, historial de Actions) | runs del workflow `nightly` |
| Jobs de E6 condicionados a `real_digests` | CODE_VERIFIED | `e6-security.yml` (`if: needs.digests-gate.outputs.real_digests == 'true'`) |
