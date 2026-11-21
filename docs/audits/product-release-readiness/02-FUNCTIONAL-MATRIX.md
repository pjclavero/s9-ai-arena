# 02 · Matriz funcional

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: estado real, evidencia, huecos, prioridad y esfuerzo de cada funcionalidad del producto, y qué bloquea una versión presentable. Veredicto y plan en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Contexto en [01-PROJECT-INVENTORY.md](01-PROJECT-INVENTORY.md); fortalezas y debilidades en [03-STRENGTHS-WEAKNESSES.md](03-STRENGTHS-WEAKNESSES.md).

## Cómo leer esta matriz

**Niveles de «Estado real»** (se marca un nivel sólo con evidencia; si no, `?`):

| Letra | Nivel | Qué cuenta como evidencia |
|---|---|---|
| D | Diseñado | documento/ADR/PR de diseño |
| I | Implementado | código en rama o en main |
| M | Integrado en main | código en 8f380eb (`CODE_VERIFIED`) y, si hay, run de CI de 8f380eb (`TEST_VERIFIED`) |
| P | Desplegado | **sólo evidencia de tercero (operador), no reverificada por la auditoría**; si no hay: `?` |
| F | Funcionando | ejecución observada. Esta auditoría no ha ejecutado nada (FASE 1): `F` aparece sólo como «CI verde» (`TEST_VERIFIED`) o como declaración de tercero (`DOC_ONLY`/tercero) |

**Severidad** = P0–P4 final: la de REVISION-TECNICA cuando la ajusta («P1→P2 (REVISION-TECNICA)»), si no la del autor; el director arbitró los casos marcados «(DECISIONES-DIRECTOR)». **Grupo** = A–E de REVISION-PRODUCTO para la opción recomendada A+ (A bloqueante de la versión presentable · B necesario para la versión objetivo siguiente · C poslanzamiento · D futuro · E descartar), salvo arbitrajes del director. Un P2 puede ser grupo A si es barato y condiciona la presentación. Esfuerzos S/M/L/XL tal como vienen de los informes, con su incertidumbre; **cualquier suma es suma de estimaciones, no medición**.

«Bloquea lanzamiento» = bloquea la **versión presentable A+** (autoalojable v0.x, en español, registro por invitación, streaming «experimental»). Todo lo que depende de laboratorio o producción: `BLOCKED (FASE 2)`.

Los IDs se conservan de los informes (ARQ, BE, UX, OPS, SEC, STR, DOC, QA, REV). El índice completo con severidad final, grupo, evidencia e informe origen está en el [Anexo A](#anexo-a--índice-de-hallazgos). Los enlaces a `07-INSTALLATION-OPERATIONS.md` apuntan al desarrollo de los OPS-.

---

## 1. Motor y reglas

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Simulación determinista (PRNG con flujos con nombre, hash de estado por componente, lint de determinismo) | D·I·M · P: declarado (tercero) · F: `determinism-1000` pasa en nightly 44519497401 (`TEST_VERIFIED`) | `arena-engine/src/rng.ts`; `sim/state-hash.ts:15,63,100-110`; `scripts/lint-determinism.mjs:30-48` · `CODE_VERIFIED` (ARQ) | Determinismo entre CPU/versiones de Node no probado: ARQ-11 (P3, D, HIPÓTESIS). `BLOCKED (FASE 2)`: mismo replay en dos CPUs | P3 | M (incertidumbre alta) | No |
| Física Rapier fijada por sha256 | D·I·M | `engine-deps.json` v0.5.0; `docs/technical/engine.md:159` · `CODE_VERIFIED` | Arranque con wasm alterado sin ejecutar (`BLOCKED (FASE 2)`) | P3 | S | No |
| Versionado de motor y rulesets (ADR-022/024; una subida por OLA) | D·I·M | `engine-deps.json`; ADR-024 · `CODE_VERIFIED` | ARQ-03 (P3, B): versión escrita a mano en `rules-doc.ts:68,149` sin cruce con `engine-deps.json`. ARQ-05 (P4, C): estado de ADR-024 e índice desfasados | P3 | S | No |
| Replay v2 y verificación (versión única, rechazo con motivo) | D·I·M | `replay.ts:329-360`; `engine-compat.ts` · `CODE_VERIFIED` | **ARQ-01 (P2, B)**: `runStatsJob` re-simula sin `headerIncompatibility` (`replay-service/src/stats.ts:620-659`); hoy no se materializa, obligatorio antes de la próxima subida de motor. ARQ-06 (P3, D): sin política de ratings ante cambio de motor | P2 | S | No |
| Modos y rulesets (dm, tdm, ctf, zona, 4v4, prórroga hasta 36.000 ticks extra) | D·I·M | `game-rules/index.ts:320,328`; roadmap · `CODE_VERIFIED` | ARQ-04 (P3, C): la prueba de resistencia sólo ejerce `dm_practice` (`mf-resistance-docker.test.ts:114`). Issues #232 (`sharedTeamVision`) y #233 (`utility` ignorado) abiertas (DOC) | P3 | M | No |
| Regla arma↔munición | D·I·M | validador `module-catalog/validator/index.ts:303-390`; motor `sim/combat.ts:138-149`; elegibilidad `api/src/services/version-eligibility.ts:51-104` · `CODE_VERIFIED` | ARQ-07 (P3, C): lógica en tres sitios, sin función compartida; hoy sin incoherencia observada | P3 | M | No |
| Rendimiento por tick / memoria en batallas largas | D·I·M · rendimiento: `UNKNOWN` | `battle.ts:1093` (`maxTicks=100000`); `battle-rules.ts:110` (≤8 participantes) | ARQ-12 (P3, C): límites en ticks, no en CPU; sin medición. `BLOCKED (FASE 2)` | P3 | M | No |
| Código muerto del motor (`match.ts`, `checkpoint.ts`, `POST /run`) y reanudación por checkpoint | I·M sin consumidor | grep de importadores · `CODE_VERIFIED`; TD-021/TD-039 | ARQ-09 (P4, C) borrar; ARQ-10 (P4, D, `DESIGN_ONLY`): reanudar batallas en vivo sólo en diseño | P4 | S–M | No |
| Anclas de mutantes en CI | I·M parcial | `hardening-mutant-anchors.test.ts:13` (sólo mc/md/mb/g1) · `CODE_VERIFIED` | ARQ-02 (P3, C): me/ma/g2/g3 sin vigilar | P3 | S–M | No |

## 2. Bots y equipamiento

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Crear bot, editor, versiones, validación en sandbox, publicación | D·I·M · P/F: declarado (tercero) | `BotsPage.tsx:1057`; `build-diagnosis.tsx:185-206`; golden de `functional-e2e` en `ci` 44383512640 (registro → build real → batalla → replay; `TEST_VERIFIED`) | UX-04 (P2, C): editor `<textarea>` sin resaltado. UX-03 (P3, B): estados en inglés crudo. UX-05 (P3, B): `aria-label` con slugs. UX-11 (P2, B; A si FASE 2 lo confirma): «publicada≠elegible» sólo se explica tras el fallo | P2 | M–L | No |
| Equipamiento / loadout / catálogo de módulos | D·I·M | `LoadoutEditor.tsx:10,195`; `docs/technical/equipment.md` · `CODE_VERIFIED` | TD-016 PARCIAL: campos de catálogo sin efecto; decisión de masa/coste de munición (#197/#198); Module Catalog v2 `DESIGN_ONLY` (PR #266) | P3 | M | No |
| Bot rival para el primer combate («sparring») | I·M para operador: `demo-teams` por CLI (V-05) · jugador: no existe | `apps/api/src/db/cli.ts:10,70`; `BattleNewPage.tsx:285,298,421-422` | **UX-01 (P1→P2 (REVISION-TECNICA), grupo A en forma barata (DECISIONES-DIRECTOR))**: en una instalación nueva no hay bots ajenos; bot del sistema publicado por `bootstrap` o `demo-teams` documentado. Instancia vacía tras instalar (REVISION-PRODUCTO, A) | P2 | M | **Sí (A)** |
| Seguridad del sandbox de bots (cap-drop, seccomp, rootfs de sólo lectura, límites obligatorios) | D·I·M · P: declarado (tercero) | `docker-proxy.ts:316-450,926-936`; `compliance.mjs` · `CODE_VERIFIED`. La postura del contenedor está cubierta; **el aislamiento de red no** | **REV-01 (P2 (REVISION-TECNICA)→P1 (DECISIONES-DIRECTOR), A)**: la prueba de red no puede ponerse roja (`tests/sandbox-escape/run-escape-suite.sh:52,88`, V-07). REV-04 (P2, B): canal entre bots por red `arena` compartida. SEC-04 (P2, C): workers con credenciales de BD en la misma red | P1 | M (REV-01) · M (REV-04) · L (SEC-04) | **Sí (A) por REV-01**; REV-04 pasa a A si se presume de competiciones con premio |
| Imágenes de servicio (TD-031) | I·M | `node-service/Dockerfile:9,21`; `ci.yml:878-880` (sólo `fs`) | **TD-031 (P1, A hasta medir con Trivy; DECISIONES-DIRECTOR)** y SEC-05 (P2, B): base por tag, `devDependencies` en imagen final, sin escaneo de imágenes de servicio. 74 HIGH/CRITICAL de una medición anterior, no remedida. `BLOCKED (FASE 2)` | P1 | M | **Sí (A)** |

## 3. Batallas individuales y de equipos

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Cola de batallas (Postgres, `FOR UPDATE SKIP LOCKED`, lease, reintentos por clase) | D·I·M · F: golden y docker-e2e en `ci` 44383512640 (`TEST_VERIFIED`) | `queue.ts:34-226`; `battle-runner.ts:173,228-280,640-667` · `CODE_VERIFIED` | BE-13 (P3, C): batalla `running` huérfana, `BLOCKED (FASE 2)`. BE-14 (P3, C): lock de build de 10 min sin renovación | P3 | S–M | No |
| Timeout de batalla | I·M | guard `ceil(ticks×ms×1,25)+15 s`, 1 reintento `battle_timeout` (PR #298); medición real = tercero | Verificar 10 batallas de 9.000 ticks en laboratorio (`BLOCKED (FASE 2)`) | P3 | S | No |
| Batallas de práctica | D·I·M | `routes/battles.ts:614-663` · `CODE_VERIFIED` | **REV-03 (P2, B)**: sin cuota por usuario, sin autor registrado (`created_by`), cola FIFO compartida con torneos | P2 | S–M | No |
| Batallas por equipos 4v4 / radio de equipo / identificación visual | D·I·M · P: declarado (tercero) | `art-direction.ts`; `PhaserViewer.ts` | STR-15 (P3, C): sin marca por bot dentro del equipo ni prueba de daltonismo. Modo CTF rechazado en torneos con motivo (TD-070) | P3 | M | No |
| Ejecución real de bots en la instalación nueva (proxy + firewall + runtimes + `DOCKER_PROXY_URL`) | D·I·M · P: declarado (tercero, reinstalación del 19-nov) · F: `container-proxy-e2e` verde en CI | `docker-compose.yml:290-308,366-368,474,543`; `installation.md:44,123-165`; `configuration.md:52-53` | **OPS-01 (P1, A)**: tras la guía principal el stack queda sano pero las batallas quedan `scheduled` y ningún bot llega a `published`. [OPS-03](07-INSTALLATION-OPERATIONS.md#ops-03) (P1, **A en forma mínima** (REVISION-PRODUCTO)): bundle del proxy y su sha256 como asset de release | P1 | S (doc) + M (script) | **Sí (A)** |
| Verificación de replay (`POST /replays/{id}/verify`) | D·I·M | `routes/replays.ts:290-342`; `anon-quota.ts:15,20` | **REV-02 (P2, B condicional (DECISIONES-DIRECTOR))**: re-simula en el proceso de la API sin cuota para autenticados; pasa a A si FASE 2 mide >1 s con registro abierto. `BLOCKED (FASE 2)` | P2 | S–M | Condicional |

## 4. Torneos

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Formatos (6), inscripción individual y de equipos (#290), cancelación (#289), rescate de `running` con batalla `failed` (#299) | D·I·M · F: sin torneo real en CI salvo `e2e-mvp` (`TEST_VERIFIED`) | `tournaments.ts:41,45-70,853-895`; `results.ts:73,266-271,549` · `CODE_VERIFIED` | E2E de formatos distintos de eliminación simple (DOC §3); CTF en torneos | P3 | M | No |
| Torneo `closed` atascado si `generate_schedule` se agota | I·M con hueco | `battle-failure.ts:14-17`; `results.ts:549-558`; `tournaments.ts:41`; `scheduler.ts:249-275` · `CODE_VERIFIED`; no reproducido | **BE-01 (P1→P2 (REVISION-TECNICA); grupo B + runbook SQL en A (DECISIONES-DIRECTOR))**. Salida mínima de producto: cancelación administrativa desde `closed` (D10) | P2 | M | No (runbook en A) |
| Operar la cola: jobs `needs_review` | I·M sin superficie | `grep needs_review` sólo en `migrations.ts` y tests | **BE-02 (P1→P2 (REVISION-TECNICA), B; runbook en A)**: listar/reintentar/descartar sólo por SQL | P2 | M | No (runbook en A) |
| Cancelar torneos `closed`/`running` | D·I·M parcial | `tournaments.ts:36-40` | BE-08 (P2, C): decisión documentada; #287/#288 abiertas con backend ya en main (cerrables tras confirmar web) | P2 | M | No |
| Pantalla de creación de torneo | I·M | `TournamentsPage.tsx:35,150-152` | UX-07 (P2, B): ruleset como texto libre con `mvp-default`, error crudo. Listados sin paginar con N+1 (BE-12, P2, C) | P2 | S | No |
| Rescate de torneos / reaper | I·M | `settleFailedBattle`, `rescueStuckTournaments` (cada 5 min) | Cubierto salvo BE-01 | — | — | No |

## 5. Replays y espectador

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Reproductor web de replays v2 | D·I·M · F: golden en `ci` (`TEST_VERIFIED`) | `ReplayPage.tsx`; `/replays/:id/segment`; TD-009 cerrada (PR #152) | **STR-03 (P2, B)**: replays previos al formato v2/0.5.0 se listan pero devuelven el mismo 404 sin explicar (`replay-service/src/segment.ts:~40`; `apps/web` sin `formatVersion`). Alcance real depende de qué conserve producción (`UNKNOWN`) o de la purga (PR #295 draft) | P2 | S | No |
| Compatibilidad entre versiones de motor | D·I·M (política «ninguna» por decisión) | `engine-deps.json`; ADR-024 | STR-04 (P3, C; A en opción C): cada subida huérfana el histórico verificable; política declarada en docs de usuario | P3 | M–L | No |
| Espectador en vivo (gateway WS, ticket de un uso, retardo 30 s, proyección por audiencia) | D·I·M · espectador/replays públicos **apagados por defecto** | `spectate/gateway.ts` (562 l.); `battle-rules.ts:86` · `CODE_VERIFIED` | STR-08 (P3, C): gateway en el proceso del motor, sin `bufferedAmount`; SEC-10 (P3, C): sin `limit_req/limit_conn`; prueba de fuga E2E real `BLOCKED (FASE 2)` (T11) | P2–P3 | M | Sólo si se activa espectador público |
| Retardo anti-coaching configurable / spoiler | I·M fijo | `battle-rules.ts:86`; `scheduler.ts:200` | STR-06 (P3, C): no configurable desde web; el resultado público puede adelantarse al feed | P3 | M | No |
| Visitante anónimo de la web | I·M | `App.tsx:254-275` (REVISION-PRODUCTO) | Recorrido omitido por la auditoría: con flags públicos apagados, el anónimo ve portada, ranking **vacío** y replays 404. DOC-10 (P3, A): sin capturas ni vídeo | P3 | S | **Sí (A) como escaparate** (DOC-10) |
| Accesibilidad del visor | I·M | `theater.tsx:169-197`; `a11y-basics.spec.ts:KNOWN` | UX-10 (P2, C, HIPÓTESIS): canvas sin alternativa textual; UX-06 (P3, C): tema único, sin `prefers-reduced-motion` | P3 | M | No |

## 6. Streaming V1

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Cadena admin web → API → streamer → Chromium+Xvfb → ffmpeg → relé RTMPS, failover, claves selladas | D·I·M · P: desactivado en la instalación nueva (declarado) · F: emisión real a una plataforma en noviembre = **`DOC_ONLY`** | `apps/streamer/src/*`; `ffmpeg.ts:33` (`pipe:3`); `secret-surfaces.test.ts`; `ci` 44383512640 incluye `build-images (streamer)` | Se presenta como **experimental** (DECISIONES-DIRECTOR). El documento de arquitectura aún dice «YouTube BLOCKED» (STR-12, P3, B) | P3 | S | No (si no se anuncia) |
| Sesión larga | I·M; sin evidencia | `supervisor.ts` sin vigilancia de RSS (`grep` vacío); mediciones de 12 min, 90 s y 120 s (`streaming.md:563-638`, `DOC_ONLY`) | **STR-01 (P1→P2 (REVISION-TECNICA, DECISIONES-DIRECTOR), grupo C)**: soak ≥6–8 h `BLOCKED (FASE 2)` (T4) | P2 | M (incertidumbre media) | No |
| Detección de imagen congelada | I·M sólo blanco/uniforme | `frame-check.ts:69`; `supervisor.ts ~L560-620` | STR-02 (P2, C): `SIGSTOP` del renderer `BLOCKED (FASE 2)` (T5) | P2 | S–M | No |
| Color de bots blanco en emisión | defecto declarado (PR #286 draft §9.2) | `PhaserViewer.tintForTeam`; `NEUTRAL_TEAM_COLOR` | STR-05 (P2, C): causa HIPÓTESIS; no registrado como TD; captura de frame en laboratorio (T1) | P2 | S + S/M | No |
| Dependencia de `S9_PUBLIC_SPECTATE_ENABLED` y reinicio | I·M | `routes/streaming.ts` (`targetRejectMessage`, 409) | STR-07 (P2, C): flag apagado durante emisión `UNKNOWN` (T6). STR-17 (P2, **B, operación** (REVISION-TECNICA)): claves no migradas a la instalación nueva, re-introducir por web | P2 | S | No |
| Verificación E2E y CI del streaming | tests unitarios en `ci`; E2E manuales | `tests/streaming-e2e/*` fuera de CI | STR-10 (P2, C): C3b abierta. **STR-09 = QA-01**: la nightly cubre 4 tests del streamer sin ffmpeg; ver §16 | P2 | M | No |
| Coste en host compartido | medido en laboratorio por el autor | `streaming.md` | STR-16 (P3, C): 0,6–0,8 % de frames descartados sin diagnosticar; ≥3 vCPU y ≥1 GiB libres sin swap; incidencia #185 abierta | P3 | M | No |
| Documentación y deuda registrada | — | `ffmpeg.ts:10-13`, `recordings.ts`, `alerts.yml:116-155` | STR-11 (P3, B): TD-066 obsoleta (tres de cuatro defectos ya no existen); STR-12 (P3, B) | P3 | S | No |

## 7. Streaming V2 / Broadcast Manager

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| `StreamSession` / `BroadcastItem` / `BroadcastQueue`, start sincronizado batalla↔emisión, streaming de replays | **D sólo** (`DESIGN_ONLY`) | PR #275: 2 ficheros de docs, 1.249 líneas; `git grep` de `StreamSession/BroadcastItem/BroadcastQueue` vacío en 8f380eb | **STR-14 (P4, D)**: rebase del diseño (base desfasada) y decisión ir/no ir. STR-13 (P4, D): «fuentes tipo OBS» sólo por URL | P4 | XL | No |
| «Próxima ola» web/streaming/UX | D sólo | PR #286 draft: `NEXT_WEB_STREAMING_UX_WAVE.md` (586 l.) | Revisar fechas y fusionar como plan (DOC-08) | P4 | S | No |

## 8. Administración web

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Panel (roles, auditoría, hallazgos, catálogo, estado, streaming, ajustes de runtime) | D·I·M | `AdminPage.tsx`, `RolesPage.tsx`, `StreamingPage.tsx`, `SystemPage.tsx` | UX-08 (P2, **B** (REVISION-PRODUCTO)): roles por UUID tecleado, sin listado/baja de usuarios (TD-023, P2; la subida a P1 de OPS no se sostiene) | P2 | M | No |
| Primer administrador | I·M sin ruta de producto | `first-run.md:79-103` (INSERT por `psql`); `cli.ts` sin `create-admin`; `auth.ts:167-171` | **OPS-02 (P1→P2 (REVISION-TECNICA), grupo A (DECISIONES-DIRECTOR))**: `create-admin` por CLI, esfuerzo S; D5 de la Definition of Done | P2 | S | **Sí (A)** |
| Guardas de administración | I·M | `users.ts:38-63` | REV-06 (P3, C): un admin puede dejar la instalación sin administradores | P3 | S | No |
| Operación del día 2 (jobs, retención, salud) | parcial | `server.ts:31` (`/healthz` fijo); `metrics.ts` (apagado por defecto) | BE-03 (P2, B): `/healthz` no comprueba nada; BE-04 (P2, C): sin métricas de cola; BE-10 (P3, C): sin retención de `jobs`/`audit_log`; OPS-12 (P2, B): sin `doctor`. «Doctor-lite» (batalla de humo) en A (REVISION-PRODUCTO) | P2 | M | Doctor-lite: **Sí (A)** |
| Moderación de contenido público y baja de cuenta/privacidad/términos | **no evaluado** (recorrido omitido) | `openapi.yaml:284-330` (`/users/me` sin `delete`); sin página de privacidad | Nuevo en REVISION-PRODUCTO: B; A si se aloja una instancia pública con registro de terceros | P2 | M | Condicional (instancia propia) |
| Notificaciones (build terminado, batalla jugada) | no existen | — | Nuevo (REVISION-PRODUCTO): B | P3 | M | No |

## 9. Usuarios y cuentas

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Registro, login, sesión (JWT 15 min en memoria + refresh opaco rotado por familia, 2FA en login) | D·I·M | `auth/tokens.ts:25-80`; `routes/auth.ts:228+`; `LoginPage.tsx` | SEC-12 (P3, C): sin longitud mínima de secreto ni runbook de rotación; SEC-08 (P3, C): TOTP en claro | P3 | S | No |
| Registro abierto sin interruptor | I·M | `routes/auth.ts:147-175` (cualquier alta recibe `user`+`developer`) | **SEC-02 (P2, grupo A (DECISIONES-DIRECTOR))**: `REGISTRATION_MODE=open|invite|closed`, **por invitación por defecto** (D6). M | P2 | M | **Sí (A)** |
| Cambio de contraseña, recuperación, pantallas 2FA/sesiones | I·M parcial: `/auth/recover` crea el token y lo descarta | `routes/auth.ts:386-448`; `git grep "auth/(2fa|sessions|recover|reset)" apps/web/src` vacío | **UX-02 / SEC-03 / TD-012 (D-01 de REVISION-TECNICA; P1 si registro abierto a externos, P2 si es por invitación; grupo A = cambio de contraseña + reset asistido por admin; email/recuperación autónoma = B (DECISIONES-DIRECTOR))** | P1 condicional | S–M (A) · L (email) | **Sí (A) en su forma mínima** (D11) |
| Registro no atómico y carreras de unicidad | I·M con defecto | `auth.ts:147-175` | BE-11 (P2, C): usuario sin roles por fallo a medias; doble envío → 500 (TD-013, P2); REV-07 (P3, C): el 500 vuelca el error de BD al log | P2 | S | No |
| Oráculo de existencia de cuentas/bots | I·M | `auth.ts:158-160`; `teams.ts:187-199`; `tournaments.ts:340-345` | SEC-06 (P3, C); BE-06 (P2, C; B en B-pública): 35 `.catch(() => null)` convierten errores de BD en 404; #247 abierta | P2 | M | No |
| `seed` con cuentas de desarrollo | I·M | `cli.ts:63-66`; `seeds/dev.ts:27-34,73-89` | **SEC-14 / REV-05 (P3→P2 (REVISION-TECNICA), B)**: concede `admin` a una cuenta preexistente sin cambiar su contraseña; guarda de entorno | P2 | S | No (B; A en B-pública) |
| Cabeceras de seguridad de la SPA | I·M ausente | `docker/web/nginx.conf`; `gateway/nginx.conf:88` (sólo HSTS); CSP/XFO sólo en API (`context.ts:29-31`) | **SEC-01 (P2, grupo A (DECISIONES-DIRECTOR))**: S; golden de navegador debe seguir verde (D7) | P2 | S | **Sí (A)** |

## 10. Estadísticas y rankings

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Elo, clasificación de temporada (`official_played_not_reverted`, #229, migr. 018), estadísticas por batalla | D·I·M | `docs/user/rankings.md`, `statistics.md`; ADR-E9-002; `ratings.ts`, `season.ts` | ARQ-01 (P2, B) y ARQ-06 (P3, D): sin política de temporada ante cambio de motor; TD-067/068/069/071 (P3). `BLOCKED (FASE 2)`: ranking real sin datos en instalación nueva | P3 | S–M | No |

## 11. Mejoras visuales

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| R16.1–R16.3 (visor Phaser, atlas, tinte de equipo) | D·I·M | `PhaserViewer.ts`; `art-direction.ts` | STR-05, STR-15 (C) | P3 | M | No |
| Fase 0 (inventario/contrato) | D sólo | PR #253 draft: 10 ficheros, 4.477 líneas + `visual-contract.test.ts` | Decisión de producto (integrar, archivar o cerrar conservando rama) | P4 | XL | No (grupo D) |
| Fase 1 y posteriores (sonido, texturas, niebla) | no existen | ninguna rama ni PR | — | P4 | XL | No (grupo D) |

## 12. SDK y herramientas para programadores de bots

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| SDK JavaScript y Python (0.1.0) + simulador local JS | D·I·M | `sdks/javascript/src/local-simulator.ts`; `sdks/python/arena_sdk`; tests de contrato compartidos | UX-09 (P2, B): sólo desde el repo (`git clone`, Node 22, `pip install -e`); sin registro de paquetes. DOC-11 (P2, B; A en B-pública): sin quickstart de 5 minutos; SDK sin licencia | P2 | S (quickstart) · M–L (publicar) | No (la licencia sí, ver §16) |
| SDK .NET y Java | **sólo README** | `sdks/dotnet/README.md`, `sdks/java/README.md` | Rotular o retirar directorios vacíos | P3 | S | No |
| Plantillas de bot y runtimes | D·I·M | `bot-templates.ts`; `runtimes/DIGESTS.lock` | Pruebas de plantillas contra el motor: CI no verificado | P3 | S | No |
| Referencia de API renderizada | OpenAPI 0.25.0 a mano | `docs/technical/api.md` (279 l.); `openapi.yaml` | DOC-12 (P3, C). BE-05 (P2, C): validación de entrada manual, no derivada del esquema | P3 | S–M · L | No |
| Idioma | sólo español | `index.html lang="es"` | DOC-09 (P3, C/D): sin inglés ni capa i18n; asumido en A+ | P3 | M · XL | No |

## 13. Instalación y mantenimiento

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Instalación del stack (pasos 1–10 de `installation.md`) | D·I·M · P: declarado (tercero, 11 intervenciones manuales en la reinstalación) · F: arranque desde cero en CI (`container-proxy-e2e`) | `installation.md`; `infrastructure/tests/compose*.test.ts` | Ver OPS-01. **QA-03 (P1→P2 (REVISION-TECNICA), B (DECISIONES-DIRECTOR); en A basta el ensayo manual D4 con evidencia)**: sin prueba de instalación limpia por una persona ajena ni de upgrade N-1→N. `BLOCKED (FASE 2)` | P2 | M | **Sí (A) el ensayo** |
| `.env.example`, `smoke.sh`, enlaces | I·M defectuosos | `infrastructure/.env.example:57,79` (`TAG=latest`); remite a `docs/despliegue.md` (inexistente); `smoke.sh` espera 200 en `/replays/healthz` cuando el gateway devuelve 404 (`gateway/nginx.conf:124-131`) | **OPS-04 (P1, A; V-04)**: plantilla errónea y con valores de la instalación del operador (topología en repo público); el humo no puede dar verde con sentido (TD-020). Limpieza de ficheros rastreados = A (TD-008 → P2; purga de historial = E) | P1 | S | **Sí (A)** |
| Requisitos de hardware, disco y SO | **falta** | `grep` en `docs/operations/*`; compose: límites sumados ≈19,5 CPU y ≈12,75 GiB en `production` (cálculo del autor) | **OPS-05 (P1→P2 (REVISION-TECNICA), A como tarea S)**; declarar «soportado: Debian 12»; OPS-15 (P3, C) | P2 | S + M (medir) | **Sí (A)** |
| Orden de arranque, README y portada de docs | I·M defectuosos | `installation.md:172,189,218,120`; `README.md:8-14` (V-02) | OPS-13 (P3, A); **OPS-11 = DOC-01 (P1, A)**: «no es funcional de extremo a extremo», «12 servicios»; 586 commits de desfase | P1 | S (README) + M (roadmap) | **Sí (A)** |
| TLS | autofirmado o proxy del operador | `networking.md:55-92`; `init-secrets.sh` | OPS-09 (P2, B; **receta documentada en A**; ACME integrado B/C) | P2 | S (receta) · M | Receta: **Sí (A)** |
| Actualización y rollback | procedimiento manual y seguro | `upgrades.md`; `NAMED_ROLLBACK_ALLOWED` | OPS-08 (P2, B): sin `upgrade.sh`; la API no migra al arrancar. BE-09 (P3, C): `down` con pérdida de datos en 011/018/019 | P2 | M–L | No |
| Desinstalación | **falta** | sólo `s9-firewall uninstall` y retirada del proxy | OPS-10 (P2, C) | P2 | S–M | No |
| Observabilidad y alertas | perfil opcional; alertas «NOT TESTED» en instalación real | `observability.md:75-97`; `alertmanager` con webhook de relleno | OPS-12 (P2, B); TD-007 (P0→P1, justificada, REVISION-TECNICA): `postgres` sin `stop_grace_period` | P1 | M | No (B) |
| Releases | **ninguna** | `git tag` = 0; sin CHANGELOG; sin LICENSE | **OPS-14 / DOC-05 (P2, grupo A en forma mínima (REVISION-PRODUCTO))**: tag `v0.x.y`, notas, digests y bundle del proxy como asset (D1) | P2 | S–M | **Sí (A)** |

## 14. Backups (y restauración)

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Backup restic (`pg_dump -Fc`, manifest sha256, secretos en snapshot aparte, healthcheck de copia a 26 h) | D·I·M · F: `e2e-backup-sftp` y `e2e-restore-sftp-bootstrap` verdes en `ci` 44383512640 (`TEST_VERIFIED`, restic/sftp sintético) · P: declarado (tercero) | `backup.md`; `entrypoint.sh:30-58`; `backup.sh:~747-771` | **OPS-06 (P1, B; en A, aviso claro si `RESTIC_REPOSITORY` está vacío (D12))**: repositorio externo sin guía del lado servidor, `.env` fuera del snapshot, poda `--prune` incondicional, sin alerta por defecto | P1 | M | Aviso: **Sí (A)** |
| Restauración completa | I·M parcial: `restore.sh` + fases 4–7 manuales | `restore.md`; tercero: restore del dump a BD temporal 40/40 tablas, **no** el procedimiento completo en host limpio; último ensayo cronometrado en agosto | **OPS-07 (P1, B; ensayo único completo con acta en A (D12))**; `restore-all.sh` B; #107 (`restore.sh --verify` falla). `BLOCKED (FASE 2)` (escenario S08) | P1 | M | Ensayo: **Sí (A)** |
| Restauración desde backup real de producción | no ejercida | QA §3 | Sólo sintético en CI; `BLOCKED (FASE 2)` | P2 | M | Parcial |

## 15. Export/import portable

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Export/import de bots, versiones y equipos (idempotente, reanudable, `--dry-run`, verifica antes de escribir) | D·I·M · F: `portable-roundtrip.test.ts` en CI (rc no verificado) · P: 37/37 bots y 8/8 equipos según tercero (informe-export-b) | `scripts/portable/*`; `docs/operations/portable-export.md` | **BE-07 (P2, C en A+; B en B-pública)**: 60 versiones/h por usuario sin `Retry-After` (la API nunca lo emite: `grep` vacío en `apps/api/src`) ni vía de operador. Importar ≥130 versiones en laboratorio: `BLOCKED (FASE 2)` | P2 | S–M | No |

## 16. Calidad, CI, seguridad transversal y release (necesario para presentar)

| Funcionalidad | Estado real | Evidencia | Qué falta | Prioridad | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| LICENSE | **no existe**; repo público | `git ls-tree 8f380eb`; `license: null` | **DOC-02 (P1, A)**; consolida UX-09 y OPS-14 (director). Elegir licencia (decisión del propietario), campo `license` en paquetes, NOTICE; revisar el `.docx` y el zip antes de licenciar | P1 | S (decisión: legal, incertidumbre media) | **Sí (A)** |
| Señal diaria de CI (nightly) | **muerta desde 2026-08-04** | run 44519497401; `nightly.yml` vs `ci.yml:62-92`; 111 fallos en las últimas 129 ejecuciones (V-03/V-06) | **QA-01 (P2, grupo A (DECISIONES-DIRECTOR))**: añadir ffmpeg y userns, fijar `ubuntu-24.04`; cierre = 7 ejecuciones seguidas en verde (D13). Es también STR-09 | P2 | S | **Sí (A)** |
| Pruebas de seguridad vacías | I·M, no pueden fallar | `run-escape-suite.sh:26,52,87-88`; `05_internal_network_scan.py:7-8`; `e6-security.yml:106` | **REV-01 (P1, A)** (ver §2) | P1 | M | **Sí (A)** |
| Mutantes, streaming real, visuales y rendimiento fuera de CI | tests escritos, no ejecutados | `grep` de workflows | QA-02 (P2, C); QA-07 (P3, C): 86 tests saltados; QA-05 (P3, C): aserción temporal | P2 | M | No |
| Staging / humo | jobs `exit 0` («omitido») | `ci.yml:944-1012` | QA-04 (P3; retirar jobs o documentar promoción manual) | P3 | M | No |
| Escaparate del repositorio | 29 PR «NO MERGEAR» abiertos (de 51), zip/docx/compose v1 en raíz, 0 capturas | DOC-13, DOC-07, DOC-10, ARQ-08; V-01 | **DOC-13 (P3, A (DECISIONES-DIRECTOR))**, **DOC-07 (P3, A)**, **DOC-10 (P3, A)**; DOC-06 (P2, B): SECURITY.md y plantillas; DOC-08 (P3, B): PR documentales | P3 | S | **Sí (A)** |
| Roadmap y documentación de estado | desfasados | `docs/roadmap/*` ancladas a `e3bf2fa` | DOC-03 (P2, B; en A sólo README, `current-status` y `known-issues`); L (≈71 TD, 1.444 líneas) | P2 | L | Parcial |
| Rate limit, carga y abuso | I·M | `shared-rate-limit.ts` | BE-15 (P3, C); SEC-10 (P3, C); REV-02/REV-03 (P2, B) | P3 | S–M | No |

---

## 17. Tres listas para la próxima versión

Referencia: opción A+ (REVISION-PRODUCTO, DECISIONES-DIRECTOR). Criterios de salida D1–D16 en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md); toda evidencia sobre **un único SHA** y con acta (rc y salida).

### 17.1 Imprescindible para la próxima versión presentable (grupo A)

| # | Elemento | IDs | Esfuerzo |
|---|---|---|---|
| 1 | LICENSE elegida por el propietario y campo `license` | DOC-02 | S |
| 2 | README y portada de docs veraces, con limitaciones declaradas y ≥2 capturas | DOC-01, OPS-11, DOC-10 | S |
| 3 | Instalación que llega a ejecutar batallas: paso de host (runtimes → red → firewall → proxy → `DOCKER_PROXY_URL`), `install-host.sh`, orden `postgres+queue → bootstrap → up` | OPS-01, OPS-13 | S (doc) + M (script) |
| 4 | Bundle del proxy y sha256 como asset de una release etiquetada; notas y digests | OPS-03, OPS-14, DOC-05 | M |
| 5 | `create-admin` por CLI | OPS-02 | S |
| 6 | `.env.example` limpio, sin valores de la instalación del operador; `smoke.sh` arreglado o convertido en «doctor-lite» con batalla de humo | OPS-04, TD-008 (sólo ficheros rastreados), TD-020 | S–M |
| 7 | Requisitos de hardware/SO declarados («soportado: Debian 12») | OPS-05 | S + M |
| 8 | Registro por invitación por defecto (interruptor) | SEC-02 | M |
| 9 | Cambio de contraseña + reset asistido por admin, auditado | UX-02 / SEC-03 / TD-012 | S–M |
| 10 | Cabeceras de seguridad de la SPA | SEC-01 | S |
| 11 | Rival de práctica / instancia no vacía tras `bootstrap` | UX-01 | M |
| 12 | Prueba de aislamiento de red rehecha en la red real, con control positivo y mutante | REV-01 | M |
| 13 | Imágenes de servicio escaneadas con Trivy (decide P1/P2) | TD-031, SEC-05 | M (`BLOCKED (FASE 2)`) |
| 14 | Nightly verde (7 ejecuciones seguidas) | QA-01 | S |
| 15 | Aviso claro si backup no configurado; **un** ensayo completo de restore en host limpio con acta | OPS-06 (parte), OPS-07 (ensayo) | S + M |
| 16 | Ensayo manual D4: instalación por persona ajena hasta una batalla `finished` | QA-03 | M (`BLOCKED (FASE 2)`) |
| 17 | Salida documentada para torneo `closed` atascado y runbook de `needs_review` | BE-01, BE-02 | S (runbook) |
| 18 | Receta TLS documentada con un proxy que emita certificados | OPS-09 | S |
| 19 | Escaparate: cerrar PR «NO MERGEAR», retirar zip/docx/compose v1 de la raíz | DOC-13, DOC-07, ARQ-08 | S |

Suma orientativa de A+ de REVISION-PRODUCTO: ~4–6 semanas-persona. **Es suma de estimaciones de los informes, no medición**; dominan OPS-01/03, SEC-02, UX-01 y los dos ensayos de laboratorio. La decisión de licencia es del propietario y debe tomarse primero.

### 17.2 Conveniente, aplazable (grupos B y C)

Grupo B (versión objetivo siguiente): `s9ctl` guiado, `doctor` completo, `restore-all.sh`, `upgrade.sh` + ensayo de rollback (OPS-06 resto, OPS-07, OPS-08, OPS-12); ACME integrado (OPS-09); recuperación de contraseña por email (UX-02); superficie operativa de jobs (BE-02), `/healthz` real (BE-03), unicidad → 409 y `.catch(() => null)` (BE-06, BE-11), `Retry-After` y límite de import (BE-07), métricas de cola (BE-04), retención (BE-10); cuotas REV-02/REV-03 y canal entre bots REV-04 (A si se presume de competiciones con premio); guardarraíl de `seed` (SEC-14, REV-05); escaneo y endurecimiento de imágenes (SEC-05); replays antiguos legibles o purgados (STR-03); estados traducidos y `aria-label` (UX-03, UX-05); ruleset como selector (UX-07); gestión de usuarios (UX-08, TD-023); aviso de elegibilidad (UX-11); quickstart de bots, SDK publicados (DOC-11, UX-09); SECURITY.md y plantillas (DOC-06); re-auditoría completa del roadmap (DOC-03); ARQ-01, ARQ-03; STR-11/STR-12; test de instalación/upgrade automatizado (QA-03); baja de cuenta, privacidad y términos (A si se aloja una instancia con registro de terceros).

Grupo C (poslanzamiento): editor con resaltado (UX-04), tema/accesibilidad del visor (UX-06, UX-10), validación por esquema (BE-05), paginación (BE-12), mutantes en CI (QA-02), umbrales de cobertura (QA-06), hardening de contenedores y Redis (SEC-04, SEC-07), TOTP cifrado (SEC-08), límites de gateway (SEC-10), acciones de CI por SHA (SEC-11), desinstalación (OPS-10), notificaciones, moderación (A si registro abierto), anclas de mutantes (ARQ-02), código muerto (ARQ-09), streaming V1 endurecido (STR-01, STR-02, STR-05..08, STR-15, STR-16).

### 17.3 Futuro / experimental (grupo D) y descartable (E)

Grupo D: Streaming V2 / Broadcast Manager (STR-14, STR-13, PR #275 y #286), mejoras visuales fases 0/1+ (PR #253), Module Catalog v2 (PR #266), i18n/inglés (DOC-09), reanudación de batallas en vivo por checkpoint (ARQ-10), política de ratings por temporada ante cambio de motor (ARQ-06), determinismo entre plataformas (ARQ-11), asistente web de instalación.

Grupo E: purga del historial de git por topología (sólo se limpian ficheros rastreados), `s9ctl` como instalador interactivo completo como primer paso, jobs de staging no configurados (retirar o documentar).

---

## 18. Diferencias entre código y producción

Lo que sigue **no** se ha verificado en producción (FASE 2 bloqueada); sólo se compara lo que el código dice con lo que el operador declara.

| Tema | Código @8f380eb | Producción (declarado, tercero) | Estado |
|---|---|---|---|
| Versión desplegada | motor 0.5.0, migraciones hasta 022 | reinstalación limpia sobre `sha-8f380eb` con 13/13 contenedores | `BLOCKED (FASE 2)`: leer `/version` y `docker inspect` en sólo lectura |
| Ejecución real de bots | requiere proxy + firewall + runtimes + `DOCKER_PROXY_URL` (la guía lo trata como opcional) | instalado el 19-nov por el operador; 8 operaciones reales vía proxy | tercero; la **instalación de un tercero** no lo reproduce hoy (OPS-01) |
| Streaming | V1 integrado; `start` rechaza con 409 si el espectador público está apagado | desactivado; claves no migradas; emisión real en noviembre | `DOC_ONLY`/`UNKNOWN` (STR-17) |
| Backup/restore | `forget --prune` incondicional; restore completo manual | copia desde la instalación nueva correcta; restore a BD temporal 40/40 tablas; el último ensayo cronometrado del procedimiento completo es de agosto | tercero; ensayo completo `BLOCKED (FASE 2)` |
| Replays previos | formato v2 único; v1 y 0.4.0 no se reproducen ni re-simulan | qué replays conserva producción: desconocido | `UNKNOWN` (STR-03) |
| Torneos/jobs atascados | BE-01/BE-02 sin salida de producto | consulta de `jobs` y torneos `closed`/`running` de >1 h | `BLOCKED (FASE 2)` (lectura) |
| Capacidad | sin requisitos declarados; límites de compose sumados ≈19,5 CPU | instancia de 4 vCPU/≈7 GB, concurrencia 2; tres batallas simultáneas ya ahogaron una instancia; swap/RAM (#185) | `DOC_ONLY` |
| Documentación | README «no funcional» (2026-10-18); roadmap anclado a `e3bf2fa` | producción actual más nueva que la documentación | verificado en código (V-02) |
| Espectador y replays públicos | apagados por defecto; `S9_PUBLIC_SPECTATE_ENABLED` | apagados | `CODE_VERIFIED`; alcance de red `UNKNOWN` |

---

## Anexo A · Índice de hallazgos

Una fila por ID: severidad final, grupo final, evidencia y informe origen. «→» = ajuste de REVISION-TECNICA; «(DD)» = DECISIONES-DIRECTOR. Informes: 01 arquitectura/motor · 02 backend/API/datos · 03 frontend/UX · 04 devops/instalación · 05 seguridad · 06 streaming/visor · 07 documentación/roadmap · 08 QA · REV = REVISION-TECNICA. Todos los `fichero:línea` son de 8f380eb y están en el informe de origen; aquí sólo se resume el estado.

| ID | Sev. final | Grupo | Evidencia | Origen |
|---|---|---|---|---|
| ARQ-01 | P2 | B (obligatorio antes de la próxima subida de motor) | `CODE_VERIFIED`; ingesta no trazada | 01 |
| ARQ-02 | P3 | C | `CODE_VERIFIED` | 01 |
| ARQ-03 | P3 | B | `CODE_VERIFIED` | 01 |
| ARQ-04 | P3 | C | `CODE_VERIFIED` | 01 |
| ARQ-05 | P4 | C | `CODE_VERIFIED` | 01 |
| ARQ-06 | P3 | D | `CODE_VERIFIED` (ausencia) | 01 |
| ARQ-07 | P3 | C | `CODE_VERIFIED` | 01 |
| ARQ-08 | P3 | A (limpieza; V-01: sin secretos) | `CODE_VERIFIED` | 01 · V-01 |
| ARQ-09 | P4 | C | `CODE_VERIFIED` | 01 |
| ARQ-10 | P4 | D | `DESIGN_ONLY` | 01 |
| ARQ-11 | P3 | D | HIPÓTESIS; `BLOCKED (FASE 2)` | 01 |
| ARQ-12 | P3 | C | rendimiento `UNKNOWN` | 01 |
| BE-01 | P1→P2 | B + runbook SQL en A (DD) | `CODE_VERIFIED`; no reproducido | 02 · REV |
| BE-02 | P1→P2 | B (runbook en A) | `CODE_VERIFIED` | 02 · REV |
| BE-03 | P2 | B | `CODE_VERIFIED` (`server.ts:31`) | 02 |
| BE-04 | P2 | C | `CODE_VERIFIED` | 02 |
| BE-05 | P2 | C | `CODE_VERIFIED` | 02 |
| BE-06 | P2 | C (B en B-pública) | `CODE_VERIFIED` (35 ocurrencias) | 02 · REV |
| BE-07 | P2 | C (B en B-pública) | `CODE_VERIFIED`; `Retry-After` ausente | 02 · REV |
| BE-08 | P2 | C | `CODE_VERIFIED` | 02 |
| BE-09 | P3 | C | `CODE_VERIFIED`; rendimiento `UNKNOWN` | 02 |
| BE-10 | P3 | C (B en B-pública) | `CODE_VERIFIED` | 02 |
| BE-11 | P2 | C (B en B-pública) | `CODE_VERIFIED` | 02 · REV |
| BE-12 | P2 | C | riesgo; tamaño real `UNKNOWN` | 02 |
| BE-13 | P3 | C | HIPÓTESIS; `BLOCKED (FASE 2)` | 02 |
| BE-14 | P3 | C | `CODE_VERIFIED`; impacto `UNKNOWN` | 02 |
| BE-15 | P3 | C | sin medir | 02 |
| UX-01 | P1→P2 | A en forma barata (DD) | `CODE_VERIFIED` | 03 · REV · DIRECTOR-NOTAS V-05 |
| UX-02 | P1 condicional | A (cambio + reset asistido); email B (DD) | `CODE_VERIFIED` | 03 · REV (D-01) |
| UX-03 | P3 | B | `CODE_VERIFIED` | 03 |
| UX-04 | P2 | C | `CODE_VERIFIED` | 03 |
| UX-05 | P3 | B | `CODE_VERIFIED` | 03 · REV |
| UX-06 | P3 | C | HIPÓTESIS (contraste sin medir) | 03 |
| UX-07 | P2 | B | `CODE_VERIFIED` | 03 · REV |
| UX-08 | P2 | B | `CODE_VERIFIED` | 03 |
| UX-09 | P2 | B (A: quickstart) | `CODE_VERIFIED` | 03 · REV |
| UX-10 | P2 | C | HIPÓTESIS; `BLOCKED (FASE 2)` | 03 |
| UX-11 | P2 | B (A si FASE 2 lo confirma) | HIPÓTESIS | 03 |
| OPS-01 | P1 | A | `CODE_VERIFIED`/`DOC_ONLY`; tercero | 04 · REV |
| OPS-02 | P1→P2 | A (DD) | `CODE_VERIFIED` | 04 · REV |
| OPS-03 | P1 | B → A en forma mínima | `CODE_VERIFIED` + tercero | 04 · REV |
| OPS-04 | P1 | A | `CODE_VERIFIED` (V-04) | 04 · REV |
| OPS-05 | P1→P2 | A (tarea S) | `CODE_VERIFIED`/`DOC_ONLY` | 04 · REV |
| OPS-06 | P1 | B (aviso en A) | `CODE_VERIFIED` + tercero | 04 · REV |
| OPS-07 | P1 | B (ensayo en A) | `CODE_VERIFIED` + tercero parcial | 04 · REV |
| OPS-08 | P2 | B | `CODE_VERIFIED` | 04 |
| OPS-09 | P2 | B (receta en A) | `CODE_VERIFIED` | 04 |
| OPS-10 | P2 | C | `CODE_VERIFIED` (ausencia) | 04 |
| OPS-11 | P2 | A (duplicado de DOC-01) | `CODE_VERIFIED` | 04 · REV |
| OPS-12 | P2 | B | `CODE_VERIFIED`/`DOC_ONLY` | 04 |
| OPS-13 | P3 | A | `DOC_ONLY` + tercero | 04 |
| OPS-14 | P2 | A (forma mínima) | `CODE_VERIFIED` | 04 |
| OPS-15 | P3 | C | `DOC_ONLY` | 04 |
| SEC-01 | P2 | A (DD) | `CODE_VERIFIED` | 05 · REV |
| SEC-02 | P2 | A (DD) | `CODE_VERIFIED` | 05 |
| SEC-03 | P2 | A (cambio + reset asistido; email B) | `CODE_VERIFIED` | 05 |
| SEC-04 | P2 | C | `CODE_VERIFIED`; sin ruta de explotación conocida | 05 · REV |
| SEC-05 | P2 | B | `CODE_VERIFIED`; no re-medida | 05 · REV |
| SEC-06 | P3 | C | `CODE_VERIFIED` | 05 · REV |
| SEC-07 | P3 | C | `CODE_VERIFIED` | 05 |
| SEC-08 | P3 | C | `CODE_VERIFIED` | 05 |
| SEC-09 | P3 | C | alcance real `UNKNOWN` | 05 |
| SEC-10 | P3 | C | `CODE_VERIFIED` | 05 |
| SEC-11 | P3→P4 | C | `CODE_VERIFIED` (permisos por defecto: `read`) | 05 · REV |
| SEC-12 | P3 | C | `CODE_VERIFIED` | 05 |
| SEC-13 | P3 (TD-008 → P2) | A sólo limpieza de ficheros; purga E (DD) | `CODE_VERIFIED` | 05 · REV |
| SEC-14 | P3→P2 | B | `CODE_VERIFIED` | 05 · REV |
| STR-01 | P1→P2 | C (DD) | `DOC_ONLY`; `BLOCKED (FASE 2)` | 06 · REV |
| STR-02 | P2 | C | `CODE_VERIFIED` (ausencia); efecto `UNKNOWN` | 06 · REV |
| STR-03 | P2 | B | `CODE_VERIFIED` | 06 · REV |
| STR-04 | P3 | C | `CODE_VERIFIED` | 06 |
| STR-05 | P2 | C | defecto declarado; causa HIPÓTESIS | 06 |
| STR-06 | P3 | C | `CODE_VERIFIED` | 06 |
| STR-07 | P2 | C | `CODE_VERIFIED`; efecto `UNKNOWN` | 06 |
| STR-08 | P3 | C | `CODE_VERIFIED` | 06 |
| STR-09 | P2 | A (= QA-01) | `TEST_VERIFIED` | 06 · 08 · REV |
| STR-10 | P2 | C | `CODE_VERIFIED` (ausencia en CI) | 06 |
| STR-11 | P3 | B (cerrar/reescribir TD-066) | `CODE_VERIFIED` refuta TD-066 | 06 · REV |
| STR-12 | P3 | B | `CODE_VERIFIED` | 06 |
| STR-13 | P4 | D | `DESIGN_ONLY` | 06 |
| STR-14 | P4 | D | `DESIGN_ONLY` | 06 |
| STR-15 | P3 | C | `DESIGN_ONLY` | 06 |
| STR-16 | P3 | C | medido en laboratorio por el autor | 06 |
| STR-17 | P2 | B, operación (no bloquea el producto) | mecanismo `CODE_VERIFIED`; estado real `UNKNOWN` | 06 · REV |
| DOC-01 | P1 | A | `CODE_VERIFIED` (V-02) | 07 · REV |
| DOC-02 | P1 | A | `CODE_VERIFIED` | 07 · REV |
| DOC-03 | P2 | B (README, `current-status`, `known-issues` en A) | `CODE_VERIFIED` | 07 · REV |
| DOC-04 | P3 | C | `CODE_VERIFIED` | 07 |
| DOC-05 | P2 | A (forma mínima) | `CODE_VERIFIED` | 07 · REV |
| DOC-06 | P2 | B | `CODE_VERIFIED` | 07 |
| DOC-07 | P3 | A | `CODE_VERIFIED` (V-01) | 07 |
| DOC-08 | P3 | B | `CODE_VERIFIED` | 07 |
| DOC-09 | P3 | C | `CODE_VERIFIED` | 07 |
| DOC-10 | P3 | A (DD) | `CODE_VERIFIED` | 07 |
| DOC-11 | P2 | B | `CODE_VERIFIED` | 07 |
| DOC-12 | P3 | C | `CODE_VERIFIED` | 07 |
| DOC-13 | P3 | A (DD; acción del operador) | `CODE_VERIFIED`; recuento 29 de 51 (gh, 2026-11-19) | 07 · REV |
| QA-01 | P2 | A (DD) | `TEST_VERIFIED` (run 44519497401) | 08 · REV · V-03/V-06 |
| QA-02 | P2 | C | `CODE_VERIFIED`; calibración `DOC_ONLY` | 08 |
| QA-03 | P1→P2 | B (ensayo manual D4 en A) (DD) | `CODE_VERIFIED` parcial | 08 · REV |
| QA-04 | P3 | B en B-pública; retirar jobs o documentar en A+ | `TEST_VERIFIED` | 08 · REV |
| QA-05 | P3 | C | `TEST_VERIFIED` (una caída, run 43872795722) | 08 |
| QA-06 | P3 | C | `CODE_VERIFIED`; protección de rama verificada | 08 · REV |
| QA-07 | P3 | C | PARTIAL | 08 |
| REV-01 | P2→P1 (DD) | A | `CODE_VERIFIED` (V-07) | REV · V-07 |
| REV-02 | P2 | B condicional (DD) | `CODE_VERIFIED`; coste `UNKNOWN` | REV |
| REV-03 | P2 | B | `CODE_VERIFIED` | REV |
| REV-04 | P2 | B (A si presume de competiciones con premio) (DD) | diseño `CODE_VERIFIED`; explotación `UNKNOWN` | REV |
| REV-05 | P2 | B | `CODE_VERIFIED` | REV |
| REV-06 | P3 | C | `CODE_VERIFIED` | REV |
| REV-07 | P3 | C | contenido real `UNKNOWN` | REV |
| TD-031 | P1 | A hasta medir (DD) | no re-medida | 05 · REV |
| TD-007 | P0→P1 | B | `CODE_VERIFIED` + tercero | 04 · REV |
| TD-006 | P0→P3 | — (cerrar con `runtime-drift-scan` en FASE 2) | tercero | 04 · REV |
| TD-008 | P0→P2 | A sólo ficheros rastreados | `CODE_VERIFIED` | 05 · 07 · REV |
