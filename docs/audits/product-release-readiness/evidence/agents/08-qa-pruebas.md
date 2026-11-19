> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Agente 8 — QA, pruebas y validación

- Repo: pjclavero/s9-ai-arena · HEAD verificado: `8f380eb700c3e984691649b3449d2c543038dfb1` (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`) · Fecha: 2026-11-19
- Alcance: inventario de suites, CI (`.github/workflows/*`), branch protection, estado de CI de 8f380eb, nightly rojo, histórico, eficacia (mutantes/skips/asserts), gates de dependencias, batería mínima para la versión presentable.
- NO se pudo mirar: ejecución local de tests (prohibida), producción y laboratorio, logs de runs anteriores salvo los citados, contenido de artefactos de CI (informes de cobertura/aceptación). Conteos de tests = `it(`/`test(` estáticos por grep (subestiman tests parametrizados) salvo el total de la nightly, que es salida real.

## 2. Resumen y veredicto: READY_WITH_CONDITIONS (para QA); la versión presentable NO tiene aún evidencia de varias áreas

1. CI de PR/push es sólida y real: `semaforo` + 3 jobs `functional-e2e` (golden con navegador, docker-e2e, container-proxy-e2e) son obligatorios en main, `enforce_admins=true`, strict=true, 0 revisiones requeridas (CODE_VERIFIED, API de protección). En 8f380eb: ci success (run 44383512640, 25 min), E6 security success (44383512289), acceptance programada success (44537834319).
2. **La nightly lleva en rojo >=30 ejecuciones consecutivas (desde al menos 22-oct hasta 19-nov, 29/29 listadas con failure)**. Es un fallo real de configuración del job, no flaky ni de infraestructura externa: el run 44519497401 falla 6 tests en 4 ficheros por falta de ffmpeg y de userns sin privilegios en el runner (`ubuntu-latest` = ubuntu-26.04), pasos que `ci.yml` sí prepara y `nightly.yml` no. (TEST_VERIFIED por el log del run; CODE_VERIFIED por diff de workflows.)
3. Consecuencia: el job rojo diario normaliza el rojo y puede enmascarar una regresión real en las suites RUN_SLOW (winrate, CTF 2v2) y en el determinismo x1000 (este último sí pasa: determinism-1000 success en 43 s ese día).
4. Total de la última nightly: 6.869 tests, 6.777 pasan, 86 skipped, 6 fallan, 485 ficheros (salida real del run).
5. Hay 4 ámbitos con tests escritos pero NO ejecutados en ningún workflow: mutantes (scripts/*-mutants.*, tests/mutants), streaming real (tests/streaming-e2e), perf del visor 60 fps, visual (acceptance/visual). La calibración por mutantes es manual y su evidencia es DOC_ONLY.
6. Huecos funcionales sin prueba automatizada end-to-end: instalación desde cero en máquina limpia, upgrade/rollback de versión, restore de un backup REAL a un entorno limpio completo, streaming a destino real, recuperación tras caída de servicios, consumo de recursos bajo carga de varios torneos.
7. Deploy a staging: nunca configurado (`STAGING_HOST` vacío); `deploy-staging` y `smoke-and-promote` salen "omitido" y el check "Semáforo CI" queda NEUTRAL/amarillo. El gate es honesto (no verde falso) pero no hay humo contra un despliegue real en CI.
8. Gate de dependencias operativo y fail-closed, con una excepción activa y datada (GHSA-fc5q-39xc-vjpf, picomatch, caduca 2026-12-17).
9. Flakiness: una única caída de `acceptance` en 30 ejecuciones (16-nov, aserción de retardo anti-coaching 211 >= 250 ms: sensible al tiempo).
10. Baterías de la sección 7: ningún caso está en PASS por ejecución mía; los estados salen de runs de terceros citados o NOT_RUN.

## 3. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Unit+DB (ci `unit`, vitest apps/packages/infrastructure, cobertura V8) | Corre en PR/push; success en 8f380eb | ci run 44383512640 (job unit 11 min); TEST_VERIFIED | Sin umbral de cobertura (`grep thresholds vitest*.ts` = nada); cobertura sólo informativa | P3 | S | No |
| functional-e2e (golden navegador + docker-e2e + container-proxy-e2e) | Obligatorio, success | mismo run; protección de rama; TEST_VERIFIED | Corre en ubuntu-24.04 hosted, no en host de producción | - | - | No |
| e2e-mvp (6 pasos + 6 sabotajes) y regression-battles | success | mismo run | - | - | - | No |
| e2e backup SFTP y restore bootstrap | success en CI (contenedores) | mismo run; tests con mutaciones (clave, huella, snapshot corrupto) | Es restic/sftp sintético; no restaura un backup real de producción | P2 | M | Parcial (backup/restore) |
| E6 security (static, digests-gate, runtime-vuln-scan Trivy, sandbox-escape) | success en push 8f380eb | run 44383512289 | Se SALTA si DIGESTS.lock tiene placeholders (hoy no) | P3 | S | No |
| nightly (determinismo x1000 + RUN_SLOW) | **ROJO crónico** | run 44519497401; histórico 29/29 failure | Arreglar prerequisitos o dividir; ver QA-01 | P2 | S | Condición |
| acceptance diaria (10 criterios cap. 28) | success 28/29 | gh run list; 16-nov failure por tiempo | Cobertura "parcial" declarada en criterios bots/web | P3 | S | No |
| Playwright `tests/browser` (35 specs) | Sólo vía functional-e2e golden | functional-e2e.yml línea 104 | Cuántos specs corren realmente en CI vs `test.skip` por entorno (streaming-admin, replay) | P3 | S | No |
| Visual (`acceptance/visual`), perf 60 fps | No ejecutados en CI | grep workflows = nada | Programar o descartar | P3 | M | No |
| Mutantes (≈20 scripts en scripts/ + tests/mutants) | No en CI; manuales | grep workflows; DOC_ONLY | Enganchar un subconjunto crítico (auth, permisos, torneos) a nightly | P2 | M | No |
| Streaming real (tests/streaming-e2e) | Manual con script; no en CI | grep workflows | Prueba con destino real de laboratorio | P2 | M | Condición si se presenta streaming |
| Instalación desde cero / upgrade / rollback | Documentado (docs/operations/installation.md, upgrades.md); sin test E2E de máquina limpia | ls infrastructure/tests | Procedimiento ejecutado en lab | P1 | M | Sí (para "presentable") |
| Gate dependencias (`scan`) | success | scan-gate.mjs; excepción json | Revisar caducidad 17-dic | P3 | S | No |

## 4. Fortalezas y debilidades

Fortalezas (con evidencia):
- Gate fail-closed documentado en código: `functional-e2e` sin `if:` ni continue-on-error, "skipped / 0 tests / sin batalla real => FALLA" (`scripts/ci/assert-functional-e2e.mjs`, workflow líneas 104-108). Tests de seguridad de CI que fallan en vez de saltarse ("la CI tiene ffmpeg (si no, este test falla en vez de saltarse)").
- Los tests de backup incluyen mutaciones con resultado distinto y no confundible (red / huella / auth / repo / checksum), visibles en el log de la nightly (6 "MUTACIÓN ... PASS"): evidencia de que el test puede ponerse rojo (TEST_VERIFIED, run 44519497401).
- Suite grande: 485 ficheros / 6.869 tests en la nightly; matrices de acceso de replays (TD-004), inmutabilidad frozen, etc. aparecen en la salida.
- Branch protection con admins incluidos y checks obligatorios reales.
- Gate de dependencias con semántica explícita (ADR-018), estados SCAN_ERROR/NOT_EXERCISED distintos de CLEAN.

Debilidades:
- Nightly muerta como señal (QA-01). Mutantes y streaming fuera de CI (QA-02). Sin staging real (QA-04). Sin pruebas de instalación limpia/upgrade (QA-03).
- Tests con dependencia temporal: 91 ficheros de test usan setTimeout/Date.now/waitFor/sleep (grep estático, sin juzgar cada uno); la caída del 16-nov lo ilustra.
- Playwright con `retries: 0` en `tests/browser`: bueno para no ocultar flakiness, pero sin historial de estabilidad: hay 20 runs de `functional-e2e` por dispatch (12 fallos, la mayoría en ramas de trabajo oct-21; último en main success 25-oct) y en CI el job se ejecuta vía workflow_call (23 success / 2 failure de 25 runs de ci.yml en main).

## 5. Hallazgos

### QA-01 · Nightly en rojo crónico por prerequisitos que `ci.yml` ya resuelve
- Área: CI / Severidad: P2 (histórico TD-019: P3; sube porque 29 días consecutivos de rojo anulan la señal de determinismo x1000 y RUN_SLOW) · Tipo: DEFECTO_CONFIRMADO · Grupo: B (necesaria para versión)
- Descripción: el job `slow-suites` ejecuta `npm test` completo con `RUN_SLOW=1` en `ubuntu-latest` (hoy imagen ubuntu-26.04 según el log) sin los pasos "userns sin privilegios" ni "ffmpeg real" que sí tiene `ci.yml:unit`. Fallan 6 tests: `b13-data-volumes` (userns), `stream-tap` x2, `streamer-2` x1 y `streamer-real` x2 (ffmpeg). Impacto: equipo de desarrollo/admin; el rojo diario enseña a ignorar el job y puede ocultar regresiones reales en winrate/CTF 2v2 (aunque ese día no fallaron; los 6 fallos son de entorno).
- Evidencia: run 44519497401 (jobs: determinism-1000 success 43 s, slow-suites failure 8 min 27 s; "Test Files 4 failed | 473 passed | 8 skipped (485); Tests 6 failed | 6777 passed | 86 skipped (6869)"); `nightly.yml` vs `ci.yml` líneas 62-92; histórico `gh run list --workflow nightly.yml`: 29 de 29 failure entre 22-oct y 19-nov. TEST_VERIFIED + CODE_VERIFIED.
- Real/flaky/infra: REAL y determinista (misma causa día tras día); no es infraestructura de GitHub. En fechas anteriores la causa incluía además `backup:e2e-test` no cargada y restore-sftp-bootstrap (runs 39750535840, 42018077946); esos dos ya no fallan el 19-nov, así que hubo arreglos parciales pero el job nunca volvió a verde.
- Causa probable: los pasos de preparación se añadieron a `ci.yml` pero no se replicaron en `nightly.yml`; además `npm test` repite lo que ya cubre `ci.yml`, incluyendo suites con contenedores (backup, restore) que no deberían ir en este job.
- Solución: copiar los dos pasos a `slow-suites`, o restringir el job a los ficheros RUN_SLOW (`npx vitest run <ficheros RUN_SLOW>`); añadir notificación de fallo; fijar `runs-on: ubuntu-24.04` como los functional-e2e para evitar derivas de imagen (ubuntu-latest ya es 26.04). Condición de cierre: 7 ejecuciones consecutivas verdes.
- Esfuerzo: S, incertidumbre baja. Dependencias: ninguna. Validación: ejecutar `workflow_dispatch` de nightly tras el cambio (lab/CI, no la máquina de orquestación).

### QA-02 · Calibración por mutantes y suites de alto valor fuera de CI
- Área: eficacia de tests / Severidad: P2 · Tipo: RIESGO · Grupo: C
- Descripción: ≈20 scripts de mutantes (`scripts/*-mutants.*`, `tests/mutants/mf-lifecycle`) y `tests/streaming-e2e`, `tests/perf`, `acceptance/visual` no aparecen en ningún workflow. Que los tests detectan mutantes es afirmación de documentación/PRs (DOC_ONLY); nada la reevalúa en cada cambio, por lo que una refactorización puede dejar tests que ya no pueden ponerse rojos sin que nadie lo vea.
- Evidencia: `grep mutants|test:visual|perf|streaming-e2e .github/workflows/*.yml` sólo devuelve comentarios. CODE_VERIFIED.
- Solución: nightly con subconjunto de mutantes de las garantías críticas (auth/permisos, aislamiento, torneos, backup); resto bajo demanda documentada. Esfuerzo M, incertidumbre media.

### QA-03 · Sin prueba automatizada de instalación limpia, upgrade ni rollback de versión
- Área: pruebas de ciclo de vida / Severidad: P1 para "versión presentable" · Tipo: FALTA · Grupo: A
- Descripción: existen docs (`docs/operations/installation.md`, `upgrades.md`, `first-run.md`, `restore.md`) y tests de piezas (first-run package: 32 casos, migraciones rollback:1, simulacro pg_dump/pg_restore), pero ningún job instala el stack desde cero en una máquina limpia ni actualiza N-1 -> N con datos ni hace rollback. El `functional-e2e` levanta Compose con estado nuevo (parte de la instalación) pero no con una base de datos de versión anterior.
- Evidencia: lista de `infrastructure/tests/` (sin upgrade/install); `docs/operations/upgrades.md`:341-363 describe el procedimiento (DOC_ONLY). Estado: PARTIAL.
- Solución: procedimiento B-01..B-14 de la sección 7 en laboratorio aislado; automatizar el upgrade con datos sembrados como job manual (`workflow_dispatch`). Esfuerzo M-L, incertidumbre media. Validación: ejecución en laboratorio con acta.

### QA-04 · Despliegue y humo en staging siempre "omitido"
- Área: CI / Severidad: P3 (TD-019: P3, sin cambio) · Tipo: DEUDA · Grupo: B
- Descripción: `deploy-staging` y `smoke-and-promote` hacen `exit 0` con "omitido" cuando falta `STAGING_HOST`; el semáforo queda amarillo/NEUTRAL (check "Semáforo CI" en 8f380eb = neutral). Es honesto (no verde falso) pero significa que ninguna promoción pasa por humo HTTP real.
- Evidencia: ci.yml 944-1012; E6/ci run 44383512640 (deploy-staging 6 s, smoke-and-promote 5 s); check "Semáforo CI" neutral. CODE_VERIFIED + TEST_VERIFIED.
- Solución: o configurar un entorno de humo (lab) o retirar los jobs y documentar que la promoción es manual. Esfuerzo M, baja.

### QA-05 · Aserción dependiente de tiempo en acceptance (flaky puntual)
- Área: determinismo de tests / Severidad: P3 · Tipo: RIESGO · Grupo: C
- Evidencia: run 43872795722 (16-nov): `apps/web/tests/spectator.e2e.test.ts` "E8.M retardo anti-coaching", `expected 211 to be greater than or equal to 250`. 1 fallo en 29 runs programados (resto success). Estado: TEST_VERIFIED (el fallo) / HIPÓTESIS (causa: runner cargado).
- Solución: medir con relojes simulados o con margen proporcional. Esfuerzo S.

### QA-06 · Cobertura sin umbral y semáforo que acepta amarillo
- Área: gates / Severidad: P3 · Tipo: DEUDA · Grupo: C
- Descripción: la cobertura V8 se publica como artefacto pero `vitest*.ts` no define `thresholds` (CODE_VERIFIED). La protección exige `semaforo` (rojo bloquea; amarillo no). Con 0 aprobaciones requeridas, un PR se puede mergear sin revisión humana si CI está verde.
- Solución: umbral mínimo por paquete crítico (api, bot-manager) y revisión obligatoria en rutas de seguridad (CODEOWNERS). Esfuerzo S.

### QA-07 · Skips condicionados por entorno
- Área: eficacia / Severidad: P3 · Tipo: RIESGO · Grupo: C
- Descripción: 29 `.skip`/`.runIf`/`.skipIf` repartidos (grep estático, cantidades por tipo: skip 29, runIf 14) y 86 tests skipped en la nightly; el repo mitiga con "falla en vez de saltarse" en CI para los críticos (ffmpeg, userns, Docker), pero `eq5b-streaming-admin.spec.ts:302/393` y `ux255-...` saltan sin batalla/clave sembrada: pueden dar verde sin ejercer replay ni streaming. El gate `assert-functional-e2e` cubre sólo el golden. Estado: PARTIAL (no he verificado cuáles de los 86 skipped son críticos).
- Esfuerzo S-M.

## 6. Deuda técnica

| ID | Prioridad previa | Nueva | Motivo |
|---|---|---|---|
| TD-019 (nightly rojo + deploy-staging) | P3 | P2 para la parte nightly; P3 para staging | 29 días de rojo continuo; causas actuales identificadas (QA-01). Nota: el documento `known-issues.md` cita "40/40 failure" y dos causas (unshare, backup:e2e-test); hoy son unshare+ffmpeg, la de backup ya no aparece |
| Nueva: cobertura sin umbrales | - | P3 | QA-06 |
| Nueva: mutantes fuera de CI | - | P2 | QA-02 |
| Nueva: ubuntu-latest sin fijar en nightly/acceptance/ci (deriva a 26.04) | - | P3 | los functional-e2e usan ubuntu-24.04 fijo; el resto flota |

## 7. Verificaciones para FASE 2 y BATERÍA MÍNIMA DE PRUEBAS

Estados: PASS sólo con ejecución citada. Entornos: LAB (lab aislado), CI (GitHub Actions), PROD-RO (producción sólo lectura).

| ID | Prueba | Nivel | Entorno | Comando / procedimiento | Criterio PASS | Estado actual (evidencia) |
|---|---|---|---|---|---|---|
| B-01 | Instalación desde cero | Sistema | LAB (VM limpia) | Seguir `docs/operations/installation.md` literal en máquina sin estado; `npm run` de readiness (`scripts/readiness.ts`) y `infrastructure/scripts/smoke.sh` | Stack sano, readiness sin bloqueantes, sin pasos no documentados | NOT_RUN (sólo hay compose desde cero en CI: functional-e2e run 44383512640 PARTIAL) |
| B-02 | Registro y login (incl. 2FA si aplica, rate limit) | E2E | CI | `tests/browser/specs/onboarding.spec.ts`, `golden-path.spec.ts` | Specs verdes | PASS en CI como parte del golden (run 44383512640, job golden success). Contenido de specs no revisado línea a línea |
| B-03 | Primer bot y primera batalla | E2E | CI + LAB | golden path (build real en sandbox Docker + batalla + replay) | Batalla real con replay, sin skip | PASS en CI (functional-e2e golden/docker-e2e, run 44383512640); LAB NOT_RUN |
| B-04 | Torneo individual | Integración | CI | `apps/tournament-worker/src/tournament-e2e.test.ts`, caos E9 (acceptance criterio "torneos") | Reanuda sin duplicar/perder | PASS en CI (acceptance run 44537834319 success, 19-nov; ci unit) |
| B-05 | Torneo por equipos / 4v4 | E2E | CI | `tests/browser/specs/team-battle-4v4.spec.ts`, `teams.spec.ts` | Verde sin skip | NOT_RUN como evidencia independiente: no he confirmado que corra en el functional-e2e (el workflow ejecuta `npm run test:browser`; pendiente de leer `tests/browser/run.sh`) |
| B-06 | Errores y cancelaciones (build fallido, bot que cuelga, cancelación de torneo, timeout) | Integración | CI | `build-error-recovery.spec.ts`, `tournament-cancel`/`battle-timeout` tests y sus mutantes | Estados terminales correctos y limpieza sin huérfanos | PARTIAL: tests en unit (success) pero mutantes NOT_RUN en CI |
| B-07 | Determinismo (1000 repeticiones y matriz semilla/versión) | Unit | CI | `DETERMINISM_RUNS=1000 npx vitest run apps/arena-engine/tests/determinism.test.ts` | Hashes idénticos | PASS en CI: nightly determinism-1000 success (run 44519497401) y acceptance 1000 (44537834319) |
| B-08 | Replays (reproducción, integridad, acceso por actor) | Integración+E2E | CI | `td004-replay-access.test.ts`, `replay.spec.ts` | Matriz actor×batalla×recurso verde | PASS en CI para la matriz de acceso (salida de nightly 44519497401); `replay.spec.ts` salta si no hay batalla sembrada: PARTIAL |
| B-09 | Permisos / autorización por rol | Integración | CI | suites `apps/api` (112 ficheros) + mutantes de ownership | Sin acceso cruzado | PASS en CI (unit); mutación NOT_RUN |
| B-10 | Aislamiento del sandbox de bots | Sistema | CI + LAB | `tests/sandbox-escape/run-escape-suite.sh` (E6 sandbox-escape) y container-proxy-e2e | Sin escape, sin acceso a red/secretos | PASS en CI (E6 run 44383512289 sandbox-escape success; functional-e2e container-proxy success). LAB NOT_RUN |
| B-11 | Backup | Sistema | CI + LAB + PROD-RO | CI: jobs e2e-backup-sftp; PROD-RO: leer señales de `docs/testing/drills/backup-evidencia.md` (último snapshot < 26 h, manifiesto, sha256) | Snapshot fresco y verificado | CI: PASS (run 44383512640). PROD: NOT_RUN en esta fase (evidencia de tercero requerida) |
| B-12 | Restore a entorno limpio con datos reales y verificación | Sistema | LAB | `restore.md`; restaurar snapshot en VM limpia y comparar conteos/hashes | App arranca con los datos restaurados | CI sintético PASS (e2e-restore-sftp-bootstrap); restore real NOT_RUN |
| B-13 | Actualización N-1 -> N con datos y rollback (migraciones `rollback:1`) | Sistema | LAB | `docs/operations/upgrades.md`: backup, upgrade, verificación, rollback a imagen anterior | Datos intactos tras upgrade y tras rollback | NOT_RUN |
| B-14 | Streaming (arranque, rechazo de clave, reintento, parada) | Integración+Sistema | CI (ffmpeg real) + LAB | Unit con ffmpeg real (`streamer-real.test.ts`) y `tests/streaming-e2e/e2e.sh` con destino de laboratorio | Estados `failed`/`streaming` correctos, clave nunca en logs | Unit: PASS en CI (ci unit con ffmpeg instalado), FAIL en nightly (QA-01); e2e.sh NOT_RUN |
| B-15 | Consumo de recursos (RAM/CPU/disco con N batallas y torneo) | Carga | LAB | Torneo grande en lab con `docker stats`, `free -m`, uso de disco antes/después | Dentro de presupuesto; sin swap sostenido | NOT_RUN (hay un issue histórico de RAM abierto, ver memoria del proyecto: DOC_ONLY) |
| B-16 | Recuperación de servicios (matar api/worker/bot-manager/proxy; reinicio del host) | Caos | LAB | Gamedays (`tests/gamedays/gameday-m3.test.ts`) + `docker kill` por servicio | Reanuda sin pérdida y readiness verde | PARTIAL: gameday M3 en unit (CI) y acta de julio (DOC_ONLY); ejecución real NOT_RUN |
| B-17 | Gate de dependencias y excepción datada | CI | CI | `node infrastructure/scripts/scan-gate.mjs ejecutar npm-audit` | Sin HIGH/CRIT no exceptuado; excepción vigente | PASS en CI (scan success, run 44383512640). Caduca 2026-12-17 |
| B-18 | Nightly verde | CI | CI | `gh workflow run nightly.yml` tras QA-01 | 7 días verdes | FAIL (run 44519497401) |
| B-19 | UI responsive/a11y/visor 60 fps | E2E | CI/LAB | `responsive.spec.ts`, `a11y-basics.spec.ts`, `test:visual`, `viewer-60fps.perf.spec.ts` | Verde | Specs de browser: parte del golden (sin verificar cuáles); visual/perf NOT_RUN |
| B-20 | Calibración por mutantes del subconjunto crítico | Calidad de tests | LAB | Ejecutar `scripts/*-mutants*` de auth/torneos sobre árbol limpio, uno a la vez | Todos los mutantes detectados | NOT_RUN |

## 8. Respuestas cortas

- Qué falló en nightly 44519497401 y si es real: fallan 6 tests de 4 ficheros porque el runner no tiene ffmpeg ni userns sin privilegios; es REAL y determinista (de configuración del job), no flaky ni infra de GitHub.
- Flakiness: nightly = 0 flaky porque falla siempre (29/29); acceptance = 1 fallo en 29 (aserción de 250 ms, 16-nov); ci en main = 2 failure de 25.
- Protección de main: checks `semaforo` + 3 functional-e2e, strict, admins incluidos, 0 revisiones requeridas, sin force push.
- Runners: todos hospedados por GitHub (ubuntu-latest o ubuntu-24.04); no hay self-hosted. Tiempos de ci 8f380eb: ~26 min (golden es el camino crítico, ~26 min).
- Gates de dependencias: `scan` (npm audit + Compose + Trivy fs) y E6 runtime-vuln-scan (Trivy, bloquea CRITICAL) en verde en 8f380eb; excepción GHSA-fc5q-39xc-vjpf (picomatch <= 4.0.7, dev) vigente hasta 2026-12-17; se desactiva sola si pasa a dependencia de producción.
- Número aproximado de tests por paquete (it/test estáticos): api 1171 (112 ficheros), web 955 (103), infrastructure 878 (42), engine 575, tournament-worker 364, bot-manager 296, streamer 200, tests/ 203, module-catalog 137, readiness 118, replay-service 94, game-rules 76, map-service 45; arena-server y arena-viewer sin tests propios; SDK JS 24, Python 3 ficheros. Total real nightly: 6.869.

