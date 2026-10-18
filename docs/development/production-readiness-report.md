# Informe de Production Readiness Closure — 2026-10

## Resumen

Revisión, integración y prueba de los tres carriles de la fase *Production Readiness Closure* de
S9 AI Arena sobre la base `20d827d` (HEAD verificado del cierre funcional, PR #152): DEV-SANDBOX
([TD-034](../roadmap/technical-debt.md#td-034)), DEV-SEC ([TD-004](../roadmap/technical-debt.md#td-004))
y DEV-CI ([TD-045](../roadmap/technical-debt.md#td-045)). Rama `integration/production-readiness`
(PR #158), **fusionada en `main` el 2026-10-19** (`59322e2`).

Resultado de la revisión (2026-10-18): TD-004 y TD-034 **CERRADAS**, con evidencia local y en CI
real; TD-045 con el gate activo y calibrado, pero **sin bloqueo efectivo**, porque `main` no tenía
protección de rama. Veredicto de entonces: BLOCKED.

[Cierre de gobernanza](#cierre-de-gobernanza-2026-10-19) (2026-10-19): fusión de #152 y #158,
protección de `main` con `functional-e2e` obligatorio (administradores incluidos) y control negativo
del bloqueo en GitHub real. TD-045 queda **CERRADA**.

Veredicto: **PRODUCTION_READY** (código y gobernanza). **Nada se ha desplegado** ni se ha tocado
producción; el despliegue es la fase siguiente y necesita autorización del operador.

## Índice

- [BASE COMMIT](#base-commit)
- [INTEGRATION HEAD](#integration-head)
- [TD-004](#td-004)
- [TD-034](#td-034)
- [TD-045](#td-045)
- [Cierre de gobernanza (2026-10-19)](#cierre-de-gobernanza-2026-10-19)
- [SECURITY](#security)
- [SANDBOX](#sandbox)
- [CI](#ci)
- [GOLDEN PATH](#golden-path)
- [NEGATIVE CONTROLS](#negative-controls)
- [KNOWN LIMITATIONS](#known-limitations)
- [REMAINING P0](#remaining-p0)
- [REMAINING P1](#remaining-p1)
- [PRODUCTION CHANGES](#production-changes)
- [VERDICT](#verdict)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## BASE COMMIT

| Elemento | Valor |
|---|---|
| Base | `20d827d83715c7e1dd624e212116e077cd35a843` (HEAD de `integration/functional-closure`, PR #152) |
| `origin/main` | `0b8c12b9b32fd9ce2761ecaa3c0e3694398f6b03` (sin cambios) |
| DEV-SANDBOX `prc/dev-sandbox` | `b355a4283557cff5952be8b5cd2301abad7680d5` · merge-base = base |
| DEV-SEC `prc/dev-sec` | `c1e4d8d9479734518b87f3a3bc25b429a0fa9a01` · merge-base = base |
| DEV-CI `prc/dev-ci` | `eb386ba4b9c7ef74bbf652b8e184bf240b68ac3c` · merge-base = base |

## INTEGRATION HEAD

Orden de integración (`--no-ff`, sin conflictos de texto): SANDBOX → SEC → CI, y después los commits
de REVIEW:

| Commit | Qué |
|---|---|
| `9824283` | merge `prc/dev-sandbox` |
| `ee70342` | merge `prc/dev-sec` |
| `c62f1ca` | merge `prc/dev-ci` |
| `0b462fe` | compose, `.env.example` y `configuration.md`: comentarios de TD-004 propuestos por DEV-SEC |
| `84cfb3a` | costuras de CI: test del gateway y relojes de TD-034 dentro de `functional-e2e`; el golden exige el replay por la API |
| `6a4c177` | costura encontrada por la CI: `container-battle-e2e.test.ts` verificaba el replay sin sesión |
| (este commit) | documentación canónica y este informe (sólo docs) |

El código verificado en CI real es `6a4c177`. El commit final sólo añade documentación; su run de CI
figura en el PR #158.

## TD-004

**CERRADA en la integración; sin desplegar.**

- La API es la única autoridad (`apps/api/src/replay-access.ts`): staff, dueño o equipo de un bot
  participante; público sólo con `S9_PUBLIC_REPLAYS_ENABLED` y todos los bots `public`. Cualquier
  otra cosa, el mismo 404 que un id inexistente.
- El gateway responde 404 en `/replays` y `/replays/*` en las dos confs reales.
- El reproductor lee por `/api/v1/replays/<id>/index` y `/segment`.

Evidencia: anónimo ⇒ 404 en metadata, índice, segmento y archivo por el gateway real; autorizado ⇒
200; ajeno ⇒ el mismo 404 (`replay-gateway.test.ts`, 11/11, local y CI real). Mutación del bypass
⇒ rojo local (5 tests, rc=1) y en CI real (PR #159).

## TD-034

**CERRADA en la integración; sin desplegar.**

Dos relojes separados por la señal `ready` del bootstrap: `SANDBOX_STARTUP_TIMEOUT_MS` (30000,
plataforma, se agota como infraestructura) y `BOT_EXECUTION_TIMEOUT_MS` (5000, bot, desde `ready`).

| Caso (R6) | Resultado |
|---|---|
| Arranque lento (7 s de plataforma) + bot válido | `validated` (SAN-5) |
| Arranque rápido + ejecución lenta | `rejected`, `bot_execution_timeout` (SAN-6, SAN-10) |
| Nunca `ready` | `SandboxInfrastructureError` `[sandbox_start_timeout]`, nunca `rejected` (SAN-9) |

`build-sandbox-timing-docker.test.ts` 7/7 en local y en CI real (job `docker-e2e`). Mutación «el
reloj del bot empieza en el lanzamiento» ⇒ 4 rojos (rc=1). Contrato de configuración comprobado
(R8):

| Variable | `.env.example` | compose | `process.env` | parser | docs |
|---|---|---|---|---|---|
| `SANDBOX_STARTUP_TIMEOUT_MS` | comentada, 30000 | `tournament-worker` y `bot-build-worker`, `${…:-30000}` | `startupTimeoutsFromEnv` (worker `main.ts`, `build-worker-wiring.ts`) | entero 1..600000; inválido ⇒ no arranca | `configuration.md`, `bots.md`, `workers.md` |
| `BOT_EXECUTION_TIMEOUT_MS` | comentada, 5000 | ídem, `${…:-5000}` | ídem | ídem | ídem |

`service-env-contract.test.ts` las cubre (mutación M8 de DEV-SANDBOX). `run.sh` y la CI corren con
esos mismos valores: `run.sh` los fija explícitamente y G6 de `functional-e2e-gate.test.ts` exige
que coincidan con compose y código.

## TD-045

**CERRADA (2026-10-19).** En la revisión del 2026-10-18 quedó abierta sólo por la falta de
protección de rama; el [cierre de gobernanza](#cierre-de-gobernanza-2026-10-19) la resolvió.

- `functional-e2e` (jobs `golden` y `docker-e2e`) es `obligatorio` en el semáforo: skipped,
  cancelled o ausente ⇒ ROJO.
- PASS en CI real sobre la integración (run 39141675080) y sobre `main` tras el merge (run
  39173546382).
- ROJO en las calibraciones sobre la integración (#159 y #160), en el primer run de #158 por una
  regresión real, y en #161 contra `main` protegida.
- `main` protegida con los tres checks obligatorios ([ci.md](ci.md#protección-de-rama)); un rojo
  impide el merge, también con `--admin`.

## Cierre de gobernanza (2026-10-19)

| Paso | Resultado | Evidencia |
|---|---|---|
| Verificar PR #152 | HEAD `20d827d` (el verificado), `MERGEABLE CLEAN`, CI 26 success / 2 skipped | `gh pr view 152`, `gh pr checks 152` |
| Merge de #152 | `main` = `debdf8a` (merge atado a `20d827d`; la rama no se borró, para no cerrar #158) | `gh pr merge --match-head-commit` |
| CI de `main` tras #152 | ci 23 success; E6 4 success + «Semáforo CI» neutral (amarillo conocido: staging omitido); 0 fallos | runs 39172291370 y 39172291290 |
| #158 contra `main` | base cambiada a `main` y rama actualizada sin force push: `c7f69b5`, mismo árbol que `367ca36` (revisado); diff = 74 ficheros, todos de los tres carriles o de la integración de REVIEW | `gh pr edit --base`, `gh pr update-branch`, `git rev-parse <commit>^{tree}` |
| Protección de `main` | checks obligatorios `semaforo` + los dos `functional-e2e` (GitHub Actions, `app_id` 15368), `strict`, PR obligatorio (0 aprobaciones), administradores incluidos, sin force push ni borrado | `gh api …/branches/main/protection` |
| Control negativo del bloqueo | PR #161 desechable (reproductor sin READY): golden y `semaforo` ROJO, `unit` verde; merge rechazado sin privilegios y con `--admin`; `main` sin cambios; PR cerrado y rama borrada | PR #161, run 39173036990 |
| CI de #158 actualizado | 28 success / 2 skipped (staging); los tres checks obligatorios en verde; golden con `agents=container`, Artillero 11 disparos / Pacifista 0, replay por `/api/v1/replays` | run 39172930109 |
| Merge de #158 | por la vía normal, sin `--admin`: `main` = `59322e2`, árbol = el revisado | `gh pr merge --match-head-commit` |
| CI de `main` tras #158 | ci 25 success, incluidos `functional-e2e / golden`, `functional-e2e / docker-e2e` y `semaforo`; E6 4 success + «Semáforo CI» neutral (staging); 0 fallos | runs 39173546382 y 39173546351 |

## SECURITY

- **Diff semántico (R2):**
  - No hay bypass nuevo ni timeouts relajados sin separar relojes.
  - No hay `skip` disfrazado: los tests opt-in nuevos son obligatorios en CI, y el veredicto rechaza `skipped`.
  - No hay fallbacks silenciosos: un plazo inválido impide arrancar.
  - Cambios fuera de la propiedad de cada carril: los specs de `tests/browser` (de DEV-CI) los tocó DEV-SEC; REVIEW los validó y los conserva.
- **Escaneo público (R9):**
  - `scan_docs.py`: 31 hallazgos, en los mismos ficheros que la base (históricos o documentación, 192.0.2.x).
  - `check_links.py`: 12 rotos, los históricos de la base.
  - Líneas añadidas fuera de docs (4604): sin IPs LAN/WAN/tailnet, hostnames internos, VMIDs ni tokens. El único hallazgo es la cabecera de una clave **ficticia** truncada, fixture de G5 (detector de fugas).
- **Riesgos residuales:**
  - las lecturas del replay-service no exigen credencial dentro de la red `platform`;
  - con la señal `ready` perdida, un informe de plataforma falseado antes del HELLO cuenta como infraestructura (falla cerrado).

El texto de DEV-SANDBOX sobre la señal `ready` está integrado en [security.md](../technical/security.md).

## SANDBOX

Ver [TD-034](#td-034). Bootstraps de Python y Node con `ready` antes del código del usuario;
endpoint `POST /s9/artifact/<id>/ready` con el token de la oferta; tras `ready`, todo informe es
del bot. Métricas por etapa en `builds.stages[].metrics`.

## CI

| Suite | Resultado (rc real) |
|---|---|
| typecheck (raíz y web) · lint · format:check | rc=0 · rc=0 · rc=0 |
| vitest completo (unit, integration, contracts, security; incluye backup/restore SFTP con Docker) | **rc=0**: 210 ficheros passed / 7 skipped; 2907 tests passed / 39 skipped (los opt-in Docker, que se ejecutan aparte) |
| Docker E2E opt-in, los 5 ficheros de `docker-e2e` | rc=0, 35/35, veredicto independiente rc=0 (local y CI real) |
| `functional-e2e-gate.test.ts` | 47/47 (G1–G6) |
| CI real, PR #158 sobre `6a4c177` | run 39141675080: los 25 jobs en verde salvo `deploy-staging` y `smoke-and-promote` (sólo main); `functional-e2e/golden`, `functional-e2e/docker-e2e`, `scan` y `semaforo` en verde |

La primera ejecución local de la suite completa tuvo un rojo en `backup-sftp-e2e.test.ts` (plazo de
30 s de `ssh-keyscan` bajo carga). Pasa en solitario (7/7) y en la repetición completa (rc=0), y no
hay cambios en backup: es un plazo sensible a la carga, no una regresión. Los restos
`s9-backup-e2e-*` y `s9-restore-e2e-*` ya no existían.

## GOLDEN PATH

Dos ejecuciones completas de `npm run test:browser` en Chromium real (imagen Playwright fijada),
sobre `6a4c177`, cada una con:
- bots reales con build en el sandbox Docker;
- batalla real con contenedores;
- ganador, stats y replay por la API autorizada.

| Ejecución | rc | Fases | Batalla | Disparos (Artillero / Pacifista) | Replay |
|---|---|---|---|---|---|
| 1 | `BROWSER_E2E_RC=0` | golden 1, fase1 15, fase2 1, fase3 2, sonda 4404/4401 | `ff08d696-…` `agents=container`, gana red | 14 / 0 | índice 200 ×1, segmento 200 ×2, `/replays*` ×0 |
| 2 | `BROWSER_E2E_RC=0` | ídem | `d997d092-…` `agents=container`, gana red | 13 / 0 | índice 200 ×1, segmento 200 ×2, `/replays*` ×0 |

Las dos con el veredicto independiente `assert-functional-e2e.mjs browser` en rc=0. En CI real
(job `golden` de run 39141675080) también hay `BROWSER_E2E_RC=0` y el veredicto pasa.

## NEGATIVE CONTROLS

| Mutación | Dónde | Resultado |
|---|---|---|
| Re-exponer `proxy_pass` en `/replays*` (ambas confs) | local | 5 rojos en `replay-gateway.test.ts` y `replay-page-gateway-path.test.ts`, rc=1 |
| Ídem | CI real, PR #159 (run 39141682346) | `golden` FAIL (fase1), `docker-e2e` FAIL (gateway, 3 rojos), `unit` FAIL, `semaforo` ROJO |
| El reproductor vuelve a leer `/replays` del gateway | CI real, PR #160 (run 39141685353) | `golden` FAIL (todas las fases), `docker-e2e` PASS, `unit` **verde**, `semaforo` ROJO |
| Reloj del bot desde el lanzamiento (TD-034) | local, Docker | 4 rojos (SAN-5, SAN-7 y dos unitarios), rc=1 |
| `run.sh` con `BOT_EXECUTION_TIMEOUT_MS=60000` | local | G6 rojo, rc=1 |
| Veredicto: replay leído por `/replays*`, sin índice 200, sin evidencia | local (G4) | FAIL, CLI rc=1 |
| Regresión real no sembrada: `container-battle-e2e` sin sesión tras TD-004 | CI real, run 39140871812 | `docker-e2e` FAIL, `semaforo` ROJO; corregido en `6a4c177` |

Los PR #159 y #160 están cerrados y sus ramas borradas. Ninguna mutación está en la integración.

## KNOWN LIMITATIONS

- **TD-034:**
  - El reloj del bot es de pared, no de CPU (máximo observado: 619 ms).
  - En batalla, el motivo va en el mensaje del fallo; no hay columna `startup_ms`.
  - `SAN-7` (estrés) corre ahora en cada PR. En un runner muy cargado podría dar un falso rojo, que sería visible y no un verde falso.
- **Contenedores `bot-`:** las comprobaciones «no quedan contenedores `^bot-`» se contaminan si hay ejecuciones concurrentes en la misma máquina.
  - En CI, el runner es efímero y `docker-e2e` usa `--maxWorkers=1`.
  - En local, REVIEW no solapó ejecuciones Docker.
- **Fallo intermitente ajeno:** un run de E6 (`static-checks`, run 39140916157) falló en `battle-launch-host.test.ts` con «Connection terminated unexpectedly» de PostgreSQL embebido. Pasa en el resto de runs; no está relacionado con la integración.
- **Prueba del gateway:** el test del gateway usa `nginx-unprivileged:1.27`, no la imagen `nginx:1.27-alpine` del Dockerfile (misma versión mayor).
- **Deuda previa:** `smoke.sh` sigue comprobando `/replays/healthz` (TD-019/TD-020).

## REMAINING P0

Ninguno del alcance. TD-004 está cerrada en la integración; en producción sigue abierta hasta
desplegar.

## REMAINING P1

- Ninguno del alcance: [TD-045](../roadmap/technical-debt.md#td-045) quedó CERRADA en el cierre de gobernanza.
- Fuera del alcance de esta fase: [TD-047](../roadmap/technical-debt.md#td-047),
  [TD-033](../roadmap/technical-debt.md#td-033) y [TD-043](../roadmap/technical-debt.md#td-043).

## PRODUCTION CHANGES

**NONE.**
- Sin SSH a la VM de producción.
- Sin compose, migraciones, `.env` ni BD de producción.
- Ninguna migración nueva en la integración.
- Sin despliegue.
- Docker sólo el rootless local, con recursos `prcrev-*` que ya se limpiaron.

## VERDICT

**PRODUCTION_READY** (2026-10-19) — TD-004, TD-034 y TD-045 CLOSED; #152 y #158 en `main`
(`59322e2`) con la CI en verde; `functional-e2e` obligatorio y verificado como bloqueante en GitHub
real; sin fugas de secretos ni de topología; producción intacta.

La revisión del 2026-10-18 dio BLOCKED, sólo por la falta de protección de rama; el
[cierre de gobernanza](#cierre-de-gobernanza-2026-10-19) lo resolvió.

PRODUCTION_READY **no** significa desplegado. La fase siguiente (Release Candidate y despliegue
controlado: migraciones `012`/`013`, `artifact_verify_key`, `s9-docker-proxy`, backup/readiness,
gate A-G, golden path tras desplegar) necesita autorización explícita del operador.

## Documentación relacionada

- [functional-closure-report.md](functional-closure-report.md) · [ci.md](ci.md) · [testing.md](testing.md)
- [current-status.md](../roadmap/current-status.md) · [known-issues.md](../roadmap/known-issues.md) · [technical-debt.md](../roadmap/technical-debt.md)
- [security.md](../technical/security.md) · [replays.md](../technical/replays.md) · [bots.md](../technical/bots.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Las tres ramas parten de la base | CODE_VERIFIED | `git merge-base` = `20d827d` en las tres |
| Golden completo ×2 en Chromium real | RUNTIME_VERIFIED (aislado) | `npm run test:browser` rc=0 ×2 + veredicto rc=0 |
| functional-e2e verde en CI real | RUNTIME_VERIFIED (GitHub Actions) | run 39141675080 (PR #158) |
| Calibraciones en rojo | RUNTIME_VERIFIED (GitHub Actions) | runs 39141682346 (#159), 39141685353 (#160), 39140871812 |
| `main` sin protección (estado de la revisión) | CODE_VERIFIED | API de GitHub, 2026-10-18 |
| `main` protegida con `functional-e2e` obligatorio; el bloqueo funciona también con `--admin` | RUNTIME_VERIFIED (GitHub real) | `gh api …/branches/main/protection`; PR #161 rechazado (2026-10-19) |
| #152 y #158 en `main`; CI de `main` en verde con `functional-e2e` | RUNTIME_VERIFIED (GitHub Actions) | `main` = `59322e2`; run 39173546382 (2026-10-19) |
| Producción sin cambios | DESIGN_ONLY | ningún comando contra producción |
