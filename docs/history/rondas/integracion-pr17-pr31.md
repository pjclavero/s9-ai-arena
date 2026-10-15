# Integración Ronda 2 y Ronda 3 — PR #17–#31

Rama: `integration/ronda2-ronda3` · Fecha: 2026-07-18 · Entorno de integración: ia-server (VM102), Linux, Node v20.19.2, sin Docker daemon, sin navegador.

## Estado inicial

- Base común: `ronda2/entrypoints-servicios` (`a5651ff`), cabeza del PR #17 (a su vez sobre `ronda2/r-p0-bloqueantes`).
- 12 PRs de tarea en borrador (#18–#31), todos con base `ronda2/entrypoints-servicios` salvo los apilados (#24 sobre la rama de #22, #31 sobre la de #28).
- Suite de referencia en la base: **706 ✅ / 1 ❌ / 3 skipped** (el ❌ es `zstdCompressSync` en `replay-golden.test.ts`, exige Node ≥ 22.15; en esta máquina hay Node 20 — fallo aceptado e idéntico en todas las ramas).

## Matriz de PR y dependencias

| PR | Tarea | Rama | Base declarada | Dependencia real |
|---|---|---|---|---|
| #17 | Entrypoints de servicio + R1.4/R1.5 Linux | `ronda2/entrypoints-servicios` | `ronda2/r-p0-bloqueantes` | — (es la base de todos) |
| #18 | R1.8 rate-limit tras proxy | `ronda2/r1.8-rate-limit-proxy` | entrypoints | — |
| #19 | R1.7 docker.sock → proxy allowlist | `ronda2/r1.7-docker-sock` | entrypoints | — |
| #20 | R2.8 CLI arena-sim JS | `ronda2/r2.8-cli-arena-sim-js` | entrypoints | — |
| #21 | R2.7 determinismo (hash solver + lint) | `ronda2/r2.7-determinismo` | entrypoints | golden compartido con #30 |
| #22 | R2.1 tipos + CI bloqueante | `ronda2/r2.1-tipos-ci` | entrypoints | — |
| #24 | R2.2 semáforo CI | `ronda2/r2.2-semaforo-ci` | rama de #22 | **apilado sobre #22** |
| #23 | R2.3 split test:pure/test:db | `ronda2/r2.3-split-suite` | entrypoints | — |
| #25 | R2.4 AST + auth endurecida | `ronda2/r2.4-ast-auth` | entrypoints | migración 009; choca con #18/#19/#26 |
| #26 | R2.5 cola builds + firma + rate-limit BD | `ronda2/r2.5-colas-firma` | entrypoints | migración 010; choca con #25/#18/#19 |
| #27 | R2.6 saneado subidas y cabeceras | `ronda2/r2.6-subidas-cabeceras` | entrypoints | choca con #25/#26 (auth/bots) |
| #28 | R3.1 replay interpolado | `ronda2/r3.1-replay-interpolado` | entrypoints | base de #31 |
| #31 | R3.2 interpolación/cámara/transporte | `ronda2/r3.2-interp-camara` | rama de #28 | **apilado sobre #28**; choca con #27 (gateway) |
| #29 | R3.7 panel | `ronda2/r3.7-panel` | entrypoints | choca con #25/#26 (auth), #22 (formato web) |
| #30 | R3.8 modos baratos | `ronda2/r3.8-modos-baratos` | entrypoints | choca con #21 (motor, golden) |

## Orden aplicado

`#18 → #19 → #20 → #21 → #22 → #24 → #23 → #25 → #26 → #27 → #28 → #31 → #29 → #30`

- Motivo: primero los independientes, después el clúster conflictivo de `apps/api` (#25/#26/#27) en orden de dependencia de migraciones (009 antes que 010), después la cadena del visor (#28→#31), el panel (#29) y el motor (#30) al final para resolver el golden una única vez.
- **Cambios respecto al plan inicial:** el plan era mergear los PRs en GitHub sobre `ronda2/entrypoints-servicios` y cerrar con #17; a petición del operador se cambió a una rama de integración local `integration/ronda2-ronda3` con merges `--no-ff` por rama, sin tocar los PRs ni sus ramas. #29 y #30 se añadieron al tren cuando sus agentes terminaron (a mitad de integración).

## Conflictos encontrados y resolución

| Merge | Ficheros | Resolución |
|---|---|---|
| #19 | `docs/ronda2/README.md` | tabla: conservar ambas filas |
| #22 | `battle.ts`, `scan-compose.mjs` (+test), `helpers.ts` (SDK), README, `package-lock.json` | en los 4 de código ganó HEAD: eran fixes reales (#21 predicado de tipo, #19 escáner sin allowlist, #20 refactor del simulador local) frente al mismo código viejo reformateado/retipado por R2.1 |
| #23 | README | tabla |
| #25 | `package.json`/lock (acorn), `migrations.ts` (009), `registry.ts` (`reauth:false`), `routes/auth.ts` (login señuelo), `auth.test.ts`, `config.ts`+`static-analysis.ts` (listas ampliadas, os/process fuera) | unión semántica: se conservó todo lo de R2.4 sobre el formato de R2.1; lockfile regenerado con `npm install` |
| #26 | `app.ts`, `migrations.ts` (009+010 conviven), `routes/auth.ts` (**contratos async de R2.5 + señuelo/refreshLimiter de R2.4**), `routes/bots.ts` (pathParam + limitSubmit), `signing.ts`, README | la resolución más delicada: el login combinado usa `LoginGuardLike`/`RateLimiterLike` (await) y mantiene la anti-enumeración; `refreshLimiter` pasó a `SharedRateLimiter(auth.refresh)` |
| #27 | `routes/bots.ts` (imports), 3 tests E2E (ticket por subprotocolo), README | lado R2.6 (subprotocolo) en los tests; imports unidos |
| #28 | README | tabla |
| #31 | `spectate/gateway.ts` (init + serverTimeMs + flag immediate de R2.6), `camera.ts` (modo manual), `interpolation.ts` (campo team), `spectator-client.ts` (tipos de evento) | unión de ambos lados |
| #29 | `routes/auth.ts` (**cookie httpOnly sobre familias de R2.4**), `routes/bots.ts`, `conformance.test.ts` (7 extensiones exactas), `index.html` + 3 páginas del panel, README | refresh combinado: acepta body o cookie, busca por familia (R2.4), rota y reescribe cookie (R3.7); páginas del panel = lado R3.7 + prettier |
| #30 | `modes.ts` (participants + incompatibilidades), `game-rules/index.ts` (Ruleset con hashEveryNTicks + match/domination/juggernaut), `spectator.e2e.test.ts` (whitelist con juggernaut), **golden** | unión; golden regenerado (ver abajo) |

**Ficheros especialmente sensibles:** `apps/api/src/routes/auth.ts` (tocado por #18/#25/#26/#29: señuelo + familias + contratos async + cookie), `apps/api/src/db/migrations.ts` (009+010), `apps/api/src/routes/bots.ts` (#22/#26/#27/#29), `apps/api/src/spectate/gateway.ts` (#27/#31), `tests/golden/combat_result.json` (#21/#30), `docs/ronda2/README.md` (todos; consolidado al final en commit separado).

## Cambios de comportamiento detectados en la integración

1. **Refresh por cookie hereda las familias de R2.4** (único ajuste de test necesario): el test de R3.7 esperaba que, tras reutilizar una cookie rotada, la cookie buena siguiera valiendo. Con R2.4, presentar un token rotado revoca la familia entera. Se mantuvo la semántica endurecida y se actualizó `r37-panel.test.ts` (commit propio, documentado).
2. **Golden regenerado una vez** (`combat_result.json`): #21 (huella del solver en el hash) y #30 (campo `jug`) cambiaban el esquema del hash por separado; el hash combinado solo es calculable con ambos integrados. Solo cambia `finalStateHash`; `winner`/`ticks`/`score` intactos.
3. **`.prettierignore`**: `apps/arena-engine` entra al formateo (la exclusión era explícitamente "hasta que se fusione R2.7"). Commit mecánico separado.
4. Flaky observado (no regresión): el test 2FA de R2.4 puede fallar bajo carga de la suite completa por expiración de la ventana TOTP de 30 s; pasa en aislamiento y en re-ejecución.

## Tests

| Ejecución | Resultado |
|---|---|
| `npm test` (suite completa) | **926 ✅ · 1 ❌ · 3 skipped** (96 ficheros) — el ❌ es el zstd conocido (Node < 22.15) |
| `npm run test:pure` | 750 ✅ · 1 ❌ (mismo zstd) · 3 skipped |
| `npm run test:db` | 176 ✅ · 0 ❌ — partición exhaustiva: 750+176 = 926 |
| `npm run typecheck` (raíz + apps/web) | 0 errores |
| `npm run lint` (determinismo) | OK — 12 ficheros de src/ vigilados, 4 exclusiones explícitas |
| `npm run format:check` | limpio (tras commit mecánico de formato) |
| `npx vite build apps/web` | ✓ built (aviso de chunk > 500 kB, no error) |
| Delta vs base (706/1/3) | **+220 tests, 0 fallos nuevos** |

## Estado por área

- **Docker/infra:** `docker compose --profile production --profile development config` válido (CLI sin daemon); `scan-compose.mjs` OK (sin privilegiados, sin docker.sock en ningún servicio, puertos solo en gateway). **Riesgo residual:** `SERVICE_ENTRY` de `bot-manager` (`src/main.ts`) y `map-service` (`src/main.ts`) apuntan a ficheros inexistentes — no es un typo integrable: bot-manager expone `docker-proxy-main.ts`/`build-worker-main.ts` (dos daemons reales sin servicio propio en el Compose) y map-service es una librería sin servidor. Es trabajo de R-DEPLOY/R6.3, ya documentado por R2.6.
- **Migraciones:** 001–010 aplican y revierten (up→down→up) sobre BD vacía (schema.test.ts, en verde); la 009 incluye backfill de sesiones vivas (probado con el PostgreSQL embebido).
- **Seguridad:** login con señuelo anti-enumeración, bloqueo por fuerza bruta persistente en BD, familias de refresh con revocación ante reutilización, reauth fuerte para 2FA, rate-limit compartido que sobrevive reinicios, cola real de builds con worker fail-closed, firma de artefactos desde el almacén de secretos verificada antes de lanzar, AST real para análisis de bots, subidas con esquema estricto, ticket de espectador fuera de la URL, HSTS en el gateway. Todo con test en verde.
- **Motor:** determinismo (lint total + hash con huella del solver + hashEveryNTicks), 7 modos (dm/tdm/ctf/zone_control/lms/domination/juggernaut) con escenarios guionizados deterministas, nivel match con `rng.fork`, golden reproducible.
- **Visor:** replay interpolado con reloj de reproducción compartido, delay-buffer sobre ticks, balística local, niebla con histéresis, cámara amortiguada con interacción, reconexión con backoff+jitter; verificado a nivel unitario y de transporte WS real. **Verificación visual en navegador: NO EJECUTADA.**
- **Panel:** torneos/batallas/historial con enlaces sin UUIDs, sesión persistente por cookie httpOnly con interceptor único de 401, editor de loadout con revisión vigente, error boundary, a11y; verificado con tests de componentes. **E2E con navegador: NO EJECUTADA.**

## Validación E2E final — cobertura y pendientes

Ejecutado dentro de la suite (equivalente a E2E de proceso, con API+BD+gateway+motor reales): instalación limpia (`npm install` en worktree), migraciones sobre BD vacía, login correcto/fallido/bloqueo, refresh (body y cookie) y reutilización, logout, sesión caducada, permisos/RBAC, subida de bot válida y rechazo de paquete inválido, build en cola consumido por worker, verificación de firma (artefacto manipulado descalificado), batalla simple, modos nuevos de #30, torneo E2E, visor en directo por WS real con corte y reconexión del gateway, replay golden y búsqueda temporal (seek) a nivel de ReplayFeed.

**NO EJECUTADA** (falta infraestructura en esta máquina — sin daemon Docker, sin navegador, sin staging):
- arranque real de `docker compose up` + healthchecks + reinicio de servicios + persistencia entre reinicios;
- actualización de una base de datos anterior REAL de producción (solo probado el backfill sintético de 009);
- visor/replay/broadcast renderizando en navegador (Phaser) y ausencia de errores en consola web;
- run real de la CI con el semáforo (primer run del PR será la verificación viva);
- ejecución del sandbox real de contenedores (cubierta antes en VM108 por R6.1, no re-ejecutada aquí).

## Riesgos pendientes

1. SERVICE_ENTRY de bot-manager/map-service (los contenedores abortarían en el guard del Dockerfile) — R-DEPLOY.
2. Los dos daemons nuevos de bot-manager (docker-proxy y build-worker) no tienen servicio en el Compose (dejado fuera a propósito por R2.5/R1.7 para no chocar) — R-DEPLOY.
3. Verificación visual del visor/panel pendiente de navegador.
4. Flaky TOTP bajo carga (ventana de 30 s) — candidato a `otplib` con ventana ±1 en tests.
5. El fallo del zstd desaparece con Node ≥ 22.15 (VM108 lo tiene); en Node 20 seguirá rojo.

## Recomendación de merge

**APTO CON VALIDACIONES MANUALES PENDIENTES.** El código compila, la suite está en verde con delta 0 de fallos respecto a la base, los conflictos se resolvieron semánticamente y las validaciones no ejecutables están acotadas y listadas. Antes del merge a `main` conviene: (1) un run de CI del PR de integración (activa typecheck bloqueante + semáforo), y (2) un vistazo visual al visor/panel en navegador. El despliegue real queda para R-DEPLOY.

**Rollback:** la rama es aditiva — `main` no se toca; basta con no mergear el PR de integración, o revertir su merge commit (`git revert -m 1 <sha>`) si ya se hubiera mergeado. Las ramas y PRs originales (#17–#31) permanecen intactos como fuente de verdad por tarea.

## Tabla final

| PR | Estado | Dependencia | Conflictos | Tests | Dictamen |
|---|---|---|---|---|---|
| #17 | Integrado (es la base) | — | — | ✅ | APTO |
| #18 | Integrado | — | README | ✅ | APTO |
| #19 | Integrado | — | README | ✅ | APTO |
| #20 | Integrado | — | — | ✅ | APTO |
| #21 | Integrado | golden ↔ #30 | battle.ts, golden | ✅ | APTO |
| #22 | Integrado | — | 4 ficheros formato-vs-fix | ✅ | APTO |
| #24 | Integrado | #22 | — | ✅ (run real de CI pendiente) | APTO con CI pendiente |
| #23 | Integrado | — | README | ✅ (Windows real no probado) | APTO |
| #25 | Integrado | 009 | auth/config/AST | ✅ | APTO |
| #26 | Integrado | 010, #25 | app/auth/bots/signing | ✅ | APTO |
| #27 | Integrado | #25/#26 | bots + 3 tests E2E | ✅ | APTO |
| #28 | Integrado | — | README | ✅ (visual pendiente) | APTO |
| #31 | Integrado | #28, #27 | gateway/viewer ×4 | ✅ (visual pendiente) | APTO |
| #29 | Integrado | #25/#26 | auth/bots/panel ×8 | ✅ (1 test ajustado a R2.4; E2E visual pendiente) | APTO |
| #30 | Integrado | #21 | modes/ruleset/golden | ✅ (golden regenerado) | APTO |
