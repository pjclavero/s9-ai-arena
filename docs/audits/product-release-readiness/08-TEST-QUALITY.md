# 08 · Calidad de las pruebas y CI

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: inventario de suites y de CI, estado del commit auditado, la nightly muerta, las pruebas que no pueden fallar, los huecos y la batería mínima de pruebas con su estado real. Veredicto global: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Seguridad de las pruebas de aislamiento: [05-SECURITY-REVIEW.md](05-SECURITY-REVIEW.md#rev-01). Deuda: [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md).

## 1. Veredicto

**READY_WITH_CONDITIONS para la CI de PR; INSUFFICIENT_EVIDENCE para instalación, upgrade, restore, streaming real y UI de la versión presentable** (informe 08, con los ajustes de REVISION-TECNICA §7).

1. La CI de PR/push es real y exigente: `semaforo` + tres jobs `functional-e2e` (golden con navegador, `docker-e2e`, `container-proxy-e2e`) son obligatorios en main, con `strict`, administradores incluidos y 0 revisiones requeridas. En 8f380eb: `ci` success (run 44383512640), E6 security success (44383512289), `acceptance` programada success (44537834319).
2. **La nightly está muerta como señal desde agosto** (§4): último verde 2026-08-04; 111 fallos en las últimas 129 ejecuciones (V-06). Es un defecto de configuración del job, no flakiness.
3. **Hay al menos una prueba de seguridad que no puede fallar** (REV-01): el aislamiento de red del sandbox. «CI sólida y real» es cierto para el `ci` de PR, no para esa cobertura.
4. Cuatro ámbitos con pruebas escritas pero fuera de cualquier workflow: mutantes, streaming real, perf del visor y visual.
5. Huecos sin prueba automatizada end-to-end: instalación en máquina limpia, upgrade N-1→N con datos, restore de un backup real, streaming a destino real, recuperación tras caída, carga de varios torneos.
6. Ningún estado PASS de la batería (§6) proviene de una ejecución de esta auditoría: salen de runs de CI citados o están NOT_RUN/BLOCKED.

## 2. Inventario de suites

Recuentos estáticos `it(`/`test(` por grep (subestiman tests parametrizados), salvo el total de la nightly, que es salida real del run 44519497401. Los recuentos por paquete no fueron reproducidos por la revisión técnica (RT §8): son orientativos.

| Suite / paquete | Tests (estático) | Corre en | Notas |
|---|---|---|---|
| `apps/api` | 1.171 (112 ficheros) | `ci` job `unit`; nightly | Incluye `rbac-matrix.test.ts` (no ejecutado por la auditoría) |
| `apps/web` | 955 (103) | `ci` `unit` | |
| `infrastructure` | 878 (42) | `ci` `unit` | Sin tests de install/upgrade (QA-03) |
| `apps/arena-engine` | 575 | `ci` `unit`; nightly `determinism-1000` | `hardening-mutant-anchors.test.ts` sólo vigila mc/md/mb/g1 |
| `apps/tournament-worker` | 364 | `ci` `unit` | |
| `apps/bot-manager` | 296 | `ci` `unit` | |
| `apps/streamer` | 200 | `ci` `unit` (con ffmpeg); **falla en nightly** | `streamer-real`, `stream-tap`, `streamer-2` |
| `tests/` (transversales) | 203 | varios | |
| `module-catalog` / `readiness` / `replay-service` / `game-rules` / `map-service` | 137 / 118 / 94 / 76 / 45 | `ci` `unit` | |
| SDK JS / Python | 24 / 3 ficheros | `ci` | `arena-server` y `arena-viewer` sin tests propios |
| `tests/browser` (Playwright, 35 specs) | — | Sólo vía `functional-e2e` golden | `retries: 0`; cuántos specs corren realmente frente a `test.skip` por entorno: sin verificar |
| `tests/sandbox-escape` (E6) | — | `e6-security.yml:106` | **Prueba de red vacía (REV-01)** |
| Mutantes (~20 scripts, `tests/mutants/mf-lifecycle`) | — | **Ningún workflow** | Calibración manual: DOC_ONLY |
| `tests/streaming-e2e`, `tests/perf`, `acceptance/visual` | — | **Ningún workflow** | Scripts manuales |
| Total real de la última nightly | 6.869 tests, 6.777 pasan, 86 skipped, 6 fallan; 485 ficheros | nightly 44519497401 | TEST_VERIFIED |

Cobertura: V8, publicada como artefacto, **sin umbrales** (`vitest*.ts`, QA-06). 91 ficheros de test dependen de tiempo (`setTimeout/Date.now/waitFor/sleep`, grep sin juzgar caso a caso).

## 3. CI: protección de main, checks y runners

| Aspecto | Estado | Evidencia |
|---|---|---|
| Protección de `main` | 4 checks obligatorios: `semaforo` + 3 `functional-e2e` (golden, docker-e2e, container-proxy-e2e); `strict=true`; `enforce_admins=true`; 0 revisiones requeridas; sin force push | API de protección (QA, RT QA-06 CONFIRMADO). Con 0 aprobaciones, un PR con CI verde se mergea sin revisión humana (QA-06) |
| Gate de `functional-e2e` | Fail-closed: «skipped / 0 tests / sin batalla real ⇒ FALLA» | `scripts/ci/assert-functional-e2e.mjs`, workflow líneas 104-108 |
| `semaforo` | Rojo bloquea; amarillo/neutral no | El check «Semáforo CI» en 8f380eb queda neutral (QA-04) |
| Gate de dependencias `scan` | `npm audit` + validación de compose + Trivy `fs`; excepción vigente hasta 2026-12-17 | `scan-gate.mjs`; success en 44383512640 |
| E6 security | static, digests-gate, runtime-vuln-scan (Trivy sobre runtimes de bots), sandbox-escape | run 44383512289 success; se salta si `DIGESTS.lock` tiene placeholders (hoy no) |
| Runners | Todos alojados por GitHub; sin self-hosted. `functional-e2e` fija `ubuntu-24.04`; el resto usa `ubuntu-latest`, que ya es 26.04 | workflows; log del run 44519497401 |
| Duración | `ci` ≈ 25-26 min; el camino crítico es `golden` | run 44383512640 |
| Staging | Nunca configurado (`STAGING_HOST` vacío): `deploy-staging` y `smoke-and-promote` hacen `exit 0` «omitido» | `ci.yml:944-1012` (QA-04) |

El run 44383512640 tiene **28 jobs**. El informe 04 citó «26/26 success»; la revisión técnica señala que `deploy-staging` y `smoke-and-promote` figuran `success` siendo no-op: no valen como evidencia de despliegue ni de humo.

## 4. Estado de 8f380eb y la nightly muerta

| Workflow | Run | Conclusión | Observación |
|---|---|---|---|
| `ci` | 44383512640 (2026-11-18) | success | `unit` 11 min; build-images (streamer) incluido. TEST_VERIFIED |
| E6 security | 44383512289 | success | `sandbox-escape` verde pero vacío para la red (REV-01) |
| `acceptance` (programada) | 44537834319 (2026-11-19) | success | 1 fallo en 29 ejecuciones (QA-05, 2026-11-16, run 43872795722) |
| `nightly` | 44519497401 | **failure** | `determinism-1000` success (43 s); `slow-suites` failure (8 min 27 s) |

Los tres runs verdes y el run rojo tienen `headSha` 8f380eb (RT §4.8).

<a id="qa-01"></a>
### QA-01 · Nightly en rojo crónico por prerrequisitos que `ci.yml` ya resuelve

- **P2 · Grupo A (DECISIONES-DIRECTOR; informe 08: B)** · DEFECTO_CONFIRMADO. Evidencia: TEST_VERIFIED (log del run 44519497401) + CODE_VERIFIED (diff `nightly.yml` frente a `ci.yml:62-92`). Duplica STR-09 y TD-019 (P3 → P2, RT).
- **Racha real**: no son «29 consecutivas» (QA) ni «40/40» (nota inicial del director). V-03/V-06: último success programado **2026-08-04**; **111 failure en las últimas 129 ejecuciones** (`gh run list --workflow nightly.yml --limit 300`); RT contó 110 de 126 con el mismo criterio y todos los posteriores a esa fecha en rojo. La ventana de 29 de QA escondía la antigüedad.
- **Causa** (log): «Test Files 4 failed | 473 passed | 8 skipped (485); Tests 6 failed | 6777 passed | 86 skipped (6869)». Los 6 fallos: `b13-data-volumes` (1, «unshare -rm no funciona en este runner»), `stream-tap` (2), `streamer-2` (1), `streamer-real` (2) (`spawnSync ffmpeg ENOENT`). `nightly.yml` no tiene los pasos «userns sin privilegios» ni «ffmpeg real» de `ci.yml:unit`. Es determinista y de configuración, no infraestructura de GitHub.
- Histórico de causas: antes también `backup:e2e-test` no cargada y restore-sftp-bootstrap (runs 39750535840, 42018077946); esas dos ya no fallan, lo que indica arreglos parciales sin volver a verde.
- **Impacto**: el rojo diario normaliza la alerta y puede ocultar regresiones en winrate/CTF 2v2 (RUN_SLOW); `determinism-1000` sí corre.
- **Corrección**: copiar los dos pasos a `slow-suites` o limitar el job a los ficheros RUN_SLOW; notificación de fallo; `runs-on: ubuntu-24.04`. **Condición de cierre: 7 ejecuciones consecutivas verdes** (D13). S, baja. Validación: `workflow_dispatch` tras el cambio (CI/lab, no el host de orquestación).

<a id="qa-02"></a>
### QA-02 · Mutantes y suites de alto valor fuera de CI

- **P2 · Grupo C** · RIESGO. `grep mutants|test:visual|perf|streaming-e2e .github/workflows/*.yml` sólo devuelve comentarios. La afirmación «los tests detectan mutantes» es DOC_ONLY y nada la reevalúa. ARQ-02 es un caso concreto: `hardening-mutant-anchors.test.ts:13` fija `EXPECTED = { mc, md, mb, g1 }` y no vigila me/ma/g2/g3 (RT: CONFIRMADO). Corrección: subconjunto de mutantes críticos (auth/permisos, aislamiento, torneos, backup) en nightly. M, media. RP: C para A+, B para la versión pública.

<a id="qa-03"></a>
### QA-03 · Sin prueba automatizada de instalación limpia, upgrade ni rollback

- **P1 → P2 (REVISION-TECNICA); Grupo A → B (DECISIONES-DIRECTOR; en A basta el ensayo manual D4 con evidencia)** · FALTA · PARTIAL. `infrastructure/tests/` no tiene install ni upgrade; `upgrades.md:341-363` es DOC_ONLY. Matiz de RT: «sin prueba de instalación limpia» es parcialmente falso: `functional-e2e/container-proxy-e2e` levanta el stack Compose desde cero (run 44383512640) y hay una reinstalación manual real (informe-reinstalación, evidencia de tercero). Lo que falta de verdad es upgrade N-1→N con datos y rollback, que cubre el ensayo de laboratorio de FASE 2. M-L, media.

<a id="qa-04"></a>
### QA-04 · Despliegue y humo en staging siempre «omitido»

- **P3 · Grupo B** · DEUDA. Honesto (no verde falso) pero ninguna promoción pasa por humo HTTP real. Los jobs concluyen `success` sin ejecutar nada (RT). RP: retirar los jobs y documentar promoción manual (E/C para A-min). M.

<a id="qa-05"></a>
### QA-05 · Aserción dependiente de tiempo en acceptance

- **P3 · Grupo C** · RIESGO. Run 43872795722 (2026-11-16): `apps/web/tests/spectator.e2e.test.ts` «E8.M retardo anti-coaching», `expected 211 to be greater than or equal to 250`. 1 fallo en 29 ejecuciones. Causa HIPÓTESIS (runner cargado). Corrección: relojes simulados o margen proporcional. S.

<a id="qa-06"></a>
### QA-06 · Cobertura sin umbral y semáforo que acepta amarillo

- **P3 · Grupo C** · DEUDA. Sin `thresholds` en vitest; 0 aprobaciones requeridas. Corrección: umbral mínimo por paquete crítico (api, bot-manager) y CODEOWNERS en rutas de seguridad. S. Protección verificada por RT.

<a id="qa-07"></a>
### QA-07 · Skips condicionados por entorno

- **P3 · Grupo C** · RIESGO · PARTIAL. 29 `.skip` y 14 `.runIf`; 86 skipped en la nightly. `eq5b-streaming-admin.spec.ts:302/393` y `ux255-…` saltan sin batalla o clave sembrada y pueden dar verde sin ejercer replay ni streaming; `assert-functional-e2e` sólo cubre el golden. No se verificó cuáles de los 86 son críticos. S-M.

Nueva, informe 08: `ubuntu-latest` sin fijar en nightly/acceptance/ci (deriva a 26.04) P3.

## 5. Pruebas que no pueden fallar y falsas verificaciones

| # | Prueba o afirmación | Por qué no puede fallar / no vale | Evidencia | Corrección |
|---|---|---|---|---|
| 1 | **Aislamiento de red del sandbox (E6 `sandbox-escape`; QA B-10; SEC §8)** — REV-01, V-07 | Red `--internal` vacía y `--dns 0.0.0.0`; el escaneo apunta a nombres inexistentes; «SANDBOX-BLOCKED» garantizado. En la topología real el bot comparte red con `tournament-worker`, `bot-build-worker` y otros bots | `run-escape-suite.sh:26,52,87-88`; `05_internal_network_scan.py:7-8`; `docker-compose.yml:292,360,535,855` | Repetir en la red `arena` del stack real con control positivo y mutante (REV-01) |
| 2 | **`smoke.sh` / humo** (OPS-04, TD-020) | Espera 200 en `/replays/healthz` y el gateway responde 404 (`gateway/nginx.conf:124-131`): **no puede dar verde**; `/api/healthz` cae en la SPA y sí da verde falso | RT §2.1 OPS-04 | Que cree y termine una batalla de humo (D4 «doctor-lite») |
| 3 | «ci 26/26 jobs success» (informe 04) | El run tiene 28 jobs; `deploy-staging` y `smoke-and-promote` son no-op con `success` | RT §4.3 | No citarlo como evidencia de despliegue |
| 4 | «Nightly 29/29» (QA) | Evidencia real, ventana mal acotada | V-03/V-06 | Usar 111/129 desde 2026-08-04 |
| 5 | «429 con Retry-After» (UX, fortaleza) | La API nunca emite la cabecera (`grep Retry-After apps/api/src` vacío); la web la interpreta (`errors.ts:18,123`) | RT D-08 | Latente, no efectiva (BE-07) |
| 6 | «TD-062 CERRADA verificable», «TD-006 casi cerrable» (OPS) | Evidencia de tercero; cierre formal exige medición de FASE 2 | informe-reinstalación | `runtime-drift-scan` en FASE 2 |
| 7 | «0 rotos de 2.311 enlaces» (DOC) | Script propio no conservado; no reproducible | RT §4.6 | NO_VERIFICABLE; no bloquea |
| 8 | B-02/B-03 «PASS» incluyendo 2FA | El golden hace registro → build real → batalla → replay (en success), pero «incl. 2FA si aplica» **no está demostrado** | RT §4.7 | No contarlo |
| 9 | Pruebas «calibradas con mutaciones» (proxy, firewall, gateway de replays) | Afirmación documental; corren en CI pero ni vistas rojas ni ejecutadas aquí | informe 05 §4 | Calibración en FASE 2 / QA-02 |

Lo que sí aguanta: no hay ningún TEST_VERIFIED atribuido a un run que no sea de 8f380eb (RT §4.8); los tests de backup incluyen mutaciones con resultado distinto y visibles en el log de la nightly (6 «MUTACIÓN … PASS», TEST_VERIFIED).

## 6. Huecos de cobertura

| Hueco | Estado | Impacto en la versión presentable |
|---|---|---|
| Instalación en máquina limpia, siguiendo sólo la documentación | Hay compose desde cero en CI y una reinstalación manual de tercero (informe-reinstalación); ninguna ejecución con la guía literal | Condición D4 |
| Upgrade N-1→N con datos y rollback | Sin prueba (B-13) | B; ensayo en FASE 2 |
| Restore de un backup real a entorno limpio | CI sintético (restic/SFTP); restore real parcial de tercero (informe-export-b) | D12: un ensayo completo con acta |
| Streaming a destino real | `tests/streaming-e2e` manual; unit con ffmpeg real en CI pero rojo en nightly | Sólo si se presenta streaming |
| Recuperación tras caída de servicios | Gameday M3 en unit y acta de julio (DOC_ONLY) | B-16 |
| Consumo de recursos con varios torneos | Sin prueba (B-15); issue histórico de RAM abierto | OPS-05 |
| UI: visual, perf 60 fps, a11y | Fuera de CI (`acceptance/visual`, `viewer-60fps.perf.spec.ts`); parte del browser en el golden sin verificar | C |
| Calibración por mutantes | Fuera de CI | QA-02 |
| Anónimo, instancia vacía, día 2 del admin, moderación, privacidad | **Ningún informe lo recorrió** (REVISION-PRODUCTO §2) | FASE 2 |
| Carga de `verify` y prácticas | Sin prueba (REV-02, REV-03) | B/A según medición |

## 7. Batería mínima de pruebas

Estados: **PASS** sólo con ejecución citada (run de CI de 8f380eb u otro informe fechado; ninguna la ejecutó esta auditoría) · **FAIL** · **BLOCKED** (depende de FASE 2: laboratorio o producción) · **NOT_RUN** · **NOT_APPLICABLE**. Entornos: LAB = laboratorio aislado; CI = GitHub Actions; PROD-RO = producción sólo lectura (evidencia de tercero).

FASE 2 está **bloqueada** hasta que cierre la migración de producción en curso. Todo lo marcado BLOCKED (FASE 2) tiene su prueba enumerada en la columna de procedimiento.

| ID | Prueba | Nivel | Entorno | Procedimiento | Criterio PASS | Estado y evidencia |
|---|---|---|---|---|---|---|
| B-01 | Instalación desde cero | Sistema | LAB (VM limpia) | `installation.md` literal en máquina sin estado; `scripts/readiness.ts` y `infrastructure/scripts/smoke.sh` | Stack sano, readiness sin bloqueantes, sin pasos no documentados | **NOT_RUN / BLOCKED (FASE 2)**. Parcial: compose desde cero en CI (run 44383512640, TEST_VERIFIED) |
| B-02 | Registro y login (rate limit; 2FA si aplica) | E2E | CI | `tests/browser/specs/onboarding.spec.ts`, `golden-path.spec.ts` | Specs verdes | **PASS en CI**: golden success (run 44383512640). Specs no revisados línea a línea; 2FA no demostrado (RT §4.7) |
| B-03 | Primer bot y primera batalla | E2E | CI + LAB | Golden (build real en sandbox Docker + batalla + replay) | Batalla real con replay, sin skip | **PASS en CI** (functional-e2e golden/docker-e2e, 44383512640). LAB: BLOCKED (FASE 2) |
| B-04 | Torneo individual | Integración | CI | `tournament-e2e.test.ts`; caos E9 (acceptance) | Reanuda sin duplicar ni perder | **PASS en CI** (acceptance 44537834319; `ci` unit 44383512640) |
| B-05 | Torneo por equipos / 4v4 | E2E | CI | `team-battle-4v4.spec.ts`, `teams.spec.ts` | Verde sin skip | **NOT_RUN** como evidencia independiente: no confirmado que corra en `functional-e2e` (pendiente leer `tests/browser/run.sh`) |
| B-06 | Errores y cancelaciones (build fallido, bot que cuelga, cancelación, timeout) | Integración | CI | `build-error-recovery.spec.ts`, tests de `tournament-cancel`/`battle-timeout` y sus mutantes | Estados terminales correctos, sin huérfanos | **PASS parcial**: tests en unit (success); mutantes NOT_RUN en CI. No cubre BE-01 (torneo `closed` atascado) |
| B-07 | Determinismo (1000 repeticiones, matriz semilla/versión) | Unit | CI | `DETERMINISM_RUNS=1000 npx vitest run apps/arena-engine/tests/determinism.test.ts` | Hashes idénticos | **PASS en CI**: `determinism-1000` success en nightly 44519497401 y acceptance 44537834319 |
| B-08 | Replays (reproducción, integridad, acceso por actor) | Integración + E2E | CI | `td004-replay-access.test.ts`, `replay.spec.ts` | Matriz actor×batalla×recurso verde | **PASS parcial**: matriz de acceso en la salida de la nightly 44519497401; `replay.spec.ts` salta sin batalla sembrada |
| B-09 | Permisos / autorización por rol | Integración | CI | Suites `apps/api` (112 ficheros) + `rbac-matrix.test.ts` | Sin acceso cruzado | **PASS en CI** (unit); mutación NOT_RUN; IDOR manual con dos cuentas BLOCKED (FASE 2) |
| B-10a | Aislamiento del sandbox: **postura del contenedor** (cap-drop, rootfs, seccomp, límites) | Sistema | CI | `container-proxy-e2e`, `compliance.mjs`, E6 | Postura conforme | **PASS en CI** (E6 44383512289; functional-e2e 44383512640). La postura sí está cubierta (RT D-09) |
| B-10b | Aislamiento del sandbox: **red real** (alcance a workers y a otros bots) | Sistema | LAB | Bot real en la red `arena` del stack real: barrido de subred por IP y conexión a puertos de `tournament-worker`, `bot-build-worker` y a un segundo bot que escucha; control positivo + mutante «servicio con puerto abierto en `arena`» | Sin conexión no prevista **y** el control positivo/mutante pone la prueba roja | **CORREGIDO (REV-01, V-07): el «PASS en CI» anterior de B-10 queda invalidado para la red.** La prueba E6 es vacía y no puede fallar. Estado real: **BLOCKED (FASE 2)** |
| B-11 | Backup | Sistema | CI + LAB + PROD-RO | CI: `e2e-backup-sftp`; PROD-RO: señales de `docs/testing/drills/backup-evidencia.md` (snapshot < 26 h, manifiesto, sha256) | Snapshot fresco y verificado | CI: **PASS** (44383512640). PROD: BLOCKED (FASE 2); sólo evidencia de tercero (informe-reinstalación) |
| B-12 | Restore a entorno limpio con datos reales | Sistema | LAB | `restore.md`; restaurar en VM limpia y comparar conteos/hashes | App arranca con los datos restaurados | CI sintético **PASS** (`e2e-restore-sftp-bootstrap`); restore real **NOT_RUN / BLOCKED (FASE 2)** (informe-export-b: restore parcial a PG temporal, evidencia de tercero) |
| B-13 | Actualización N-1→N con datos y rollback | Sistema | LAB | `upgrades.md`: backup, upgrade, verificación, rollback a imagen anterior | Datos intactos tras upgrade y tras rollback | **NOT_RUN / BLOCKED (FASE 2)** |
| B-14 | Streaming (arranque, rechazo de clave, reintento, parada) | Integración + Sistema | CI (ffmpeg real) + LAB (destino RTMP local, clave ficticia) | Unit con ffmpeg real; `tests/streaming-e2e/e2e.sh`; T1-T13 de [09-STREAMING-REVIEW.md](09-STREAMING-REVIEW.md) | Estados `failed`/`streaming` correctos; clave nunca en logs | Unit: **PASS en `ci`** (ffmpeg instalado), **FAIL en nightly** (QA-01). E2E LAB: **BLOCKED (FASE 2)** |
| B-15 | Consumo de recursos con N batallas y torneo | Carga | LAB | Torneo grande con `docker stats`, `free -m`, disco antes/después | Dentro de presupuesto; sin swap sostenido | **NOT_RUN / BLOCKED (FASE 2)** |
| B-16 | Recuperación de servicios (matar api/worker/bot-manager/proxy; reinicio del host) | Caos | LAB | Gamedays (`gameday-m3.test.ts`) + `docker kill` por servicio | Reanuda sin pérdida; readiness verde | **PASS parcial** del gameday en unit; ejecución real **NOT_RUN / BLOCKED (FASE 2)** |
| B-17 | Gate de dependencias y excepción datada | CI | CI | `node infrastructure/scripts/scan-gate.mjs ejecutar npm-audit` | Sin HIGH/CRIT no exceptuado; excepción vigente | **PASS en CI** (`scan`, 44383512640). La excepción caduca 2026-12-17 |
| B-18 | Nightly verde (7 consecutivas) | CI | CI | `gh workflow run nightly.yml` tras QA-01; `gh run list --workflow nightly.yml` | 7 success consecutivos | **FAIL** (run 44519497401; 111/129 rojas; último verde 2026-08-04) |
| B-19 | UI responsive/a11y/visor 60 fps | E2E | CI/LAB | `responsive.spec.ts`, `a11y-basics.spec.ts`, `test:visual`, `viewer-60fps.perf.spec.ts` | Verde | Specs de browser: parte del golden sin verificar cuáles; visual/perf **NOT_RUN** |
| B-20 | Calibración por mutantes del subconjunto crítico | Calidad de tests | LAB | `scripts/*-mutants*` de auth/torneos sobre árbol limpio, uno a la vez | Todos los mutantes detectados | **NOT_RUN** |
| B-21 | Cabeceras de la SPA (SEC-01, D7) | E2E | CI + LAB | `curl -sI https://<lab>/`; test sobre la conf real del gateway; golden sigue verde | CSP, `frame-ancestors`/XFO, `nosniff`, `Referrer-Policy` presentes y el visor carga | **NOT_RUN** (cabeceras ausentes en código: CODE_VERIFIED) |
| B-22 | Registro cerrado por defecto (SEC-02, D6) | Contrato | CI + LAB | Con el `.env` por defecto, `POST /auth/register` anónimo | Rechazo (modo cerrado/invitación); test de contrato con mutación | **NOT_RUN** (hoy el registro está abierto) |
| B-23 | `create-admin` sin SQL (OPS-02, D5) | Sistema | LAB + CI | `cli.ts create-admin` y login web | rc 0 y login de admin | **NOT_RUN** (el comando no existe en 8f380eb) |
| B-24 | `smoke.sh` crea y termina una batalla (OPS-04) | Sistema | LAB | `smoke.sh` en instalación nueva | rc 0 sólo si hay batalla `finished`; rc ≠ 0 con proxy apagado | **FAIL** por diseño (espera 200 en una ruta que da 404: RT) |
| B-25 | `verifyReplay` bajo carga (REV-02) | Carga | LAB | Medir `verify` de una batalla CTF con prórroga; 10 en paralelo; latencia de `/users/me` | <1 s por verificación y latencia estable | **BLOCKED (FASE 2)** |
| B-26 | Cola: prácticas frente a torneo (REV-03) | Carga | LAB | Encolar 200 prácticas y cerrar un torneo | La primera batalla oficial no espera a la cola de prácticas | **BLOCKED (FASE 2)** |
| B-27 | `seed` sobre cuenta preexistente (REV-05) | Integración | LAB | Registrar el email semilla y ejecutar `seed` | `seed` rechaza; nadie obtiene `admin` | **BLOCKED (FASE 2)** (test unitario ausente) |
| B-28 | Escaneo de imágenes de servicio (TD-031) | CI + LAB | LAB | `trivy image --severity HIGH,CRITICAL` sobre las 6 imágenes Node | Recuento decide P1/P2; job de CI con control negativo | **BLOCKED (FASE 2)**. Última cifra: 74 (2026-10-16), no re-medida |
| B-29 | Deriva de runtime en producción (TD-006) | PROD-RO | PROD-RO | `runtime-drift-scan` + `docker inspect .Config.Image` | 13/13 contenedores en el SHA declarado | **BLOCKED (FASE 2)**; evidencia de tercero (informe-reinstalación) |
| B-30 | Recorrido anónimo, instancia recién instalada y día 2 del admin | Usabilidad | LAB | REVISION-PRODUCTO §9 (cuatro recorridos) | Rival de práctica disponible; sin pantallas vacías sin explicación; cada caso del día 2 se resuelve sin `psql` | **BLOCKED (FASE 2)** |
| B-31 | Escaparate (D14): 0 PR «NO MERGEAR», sin zip/docx en raíz, sin direcciones internas | Repo | CI + `gh` | `gh pr list --search "NO MERGEAR in:title" --state open`; `git ls-tree`; gate de parseo de direcciones | Los tres vacíos; el gate se pone rojo con un mutante | **FAIL** (29 con «NO MERGEAR»; zip/docx/compose v1 en raíz: CODE_VERIFIED, V-01) |

Criterio de salida (REVISION-PRODUCTO): D1-D21 con acta sobre **un único SHA**; cualquier cambio de código posterior invalida B-01, B-03 (LAB), B-18 y el golden de primer bot. Al comprobar la CI hay que contar **conclusiones de todos los checks**, no la cola de `--watch`.

## 8. Respuestas cortas

- ¿Qué falló en la nightly 44519497401 y es real? 6 tests de 4 ficheros por falta de ffmpeg y userns; real, determinista, de configuración del job.
- ¿Flakiness? Nightly: ninguna, falla siempre. `acceptance`: 1 fallo en 29 (aserción de 250 ms). `ci` en main: 2 failure de 25.
- ¿Protección de main? Ver §3.
- ¿Runners? Alojados por GitHub; sin self-hosted.
- ¿Qué se retira de lo afirmado antes? El PASS de aislamiento de red (B-10), «29/29», «26/26» y la fortaleza «429 con Retry-After».
