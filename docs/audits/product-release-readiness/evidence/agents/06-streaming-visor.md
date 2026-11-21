> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Agente 6 — Streaming, visor y retransmisión

- Repo: pjclavero/s9-ai-arena · HEAD verificado (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`): `8f380eb700c3e984691649b3449d2c543038dfb1` (main, motor 0.5.0)
- Fecha: 2026-11-19 · FASE 1 (estática)
- Alcance: replays (formato/versionado/compatibilidad), espectador en vivo (gateway WS, retardo, proyección por audiencia), renderer/identificación de equipos, Streaming V1 (streamer, director, RTMPS, admin web, claves), Streaming V2 (PR #275, ms/architecture-v2) y «próxima ola» (PR #286), sincronía batalla↔emisión, sesiones largas y coste.
- NO se pudo mirar (prohibido en FASE 1): producción, VM, ejecución de tests/render/ffmpeg, la emisión real a YouTube de noviembre (sólo hay documentación y la historia que aporta el brief: `DOC_ONLY`). El único «TEST_VERIFIED» citado es el resultado de runs de CI sobre 8f380eb.

## 1. Veredicto (10 líneas)

**READY_WITH_CONDITIONS para el streaming V1 como herramienta de operador; NOT_READY para «emisión de eventos largos sin supervisión» y para V2.**

1. V1 está implementado e integrado en main de punta a punta (admin web → API → streamer → Chromium+Xvfb → ffmpeg → relé RTMPS propio con TLS verificado, claves selladas, failover principal/respaldo). `CODE_VERIFIED`.
2. La emisión real a YouTube existe sólo como afirmación del brief y de documentos (`DOC_ONLY`); el doc de arquitectura del propio repo aún dice «YouTube BLOCKED» (desfasado).
3. Los fallos históricos están corregidos en código: pantalla blanca (#256, puerta de render + vigilante), «emisión vacía» sin `S9_PUBLIC_SPECTATE_ENABLED` (ahora `start` responde 409 con motivo, no emite), director que cortaba antes del retardo (#284 es el fix del director; #282 es el de latidos/watchdog; ambos en main).
4. Lo más débil: **no hay evidencia de sesión larga** (máx. 12 min medidos, Chromium en una sola página durante horas, sin reciclado) y **no hay detección de imagen congelada** (sólo blanco/uniforme). C3b sigue abierta.
5. Replays: formato v2 sólo (sin compatibilidad hacia atrás por decisión, `BACKWARD_COMPATIBILITY_REQUIRED=NO`); los replays previos a 0.5.0 se listan pero no se pueden reproducir, y el visor no lo explica (sólo `verify` lo dice).
6. Espectador en vivo: proyección por audiencia (`public_live`/`broadcast`/`staff`), ticket de un solo uso, retardo fijo 30 s con latidos; bien diseñado. Retardo no configurable desde web; resultado público puede adelantarse al feed retrasado (spoiler).
7. Color de bots blancos en emisión: bug declarado en PR #286 draft, sin corregir ni registrado como TD en main; causa no determinable estáticamente.
8. Streaming V2 / Broadcast Manager: **DESIGN_ONLY**. PR #275 es sólo documento (2 ficheros docs, 1255 líneas); no hay una línea de `StreamSession/BroadcastItem/BroadcastQueue` en main (`git grep` vacío en 8f380eb). FASE 0/1 visual: sólo docs (PR #253 draft, rama `mejoras-visuales` = un plan maestro); FASE 1 no existe como rama.
9. CI: el job `ci` de 8f380eb está verde (incluye `build-images (streamer)`); el job nocturno `slow-suites` está ROJO en 8f380eb por falta de ffmpeg/userns en ese job (4 tests de streamer). Los scripts E2E reales (`tests/streaming-e2e/*`) no corren en CI.
10. Coste medido (no en producción): ~2,6 CPU y 0,5-0,8 GiB para 1080p30; el host de producción tiene incidencia de swap/RAM abierta (#185) → `CPU_ACCEPTABLE`/`MEMORY_ACCEPTABLE` no demostrados allí.

## 2. Matriz

Niveles: D=diseñado · I=implementado · M=integrado en main · P=desplegado · F=funcionando de verdad. Sólo se marca P/F cuando hay evidencia; si no, «?» (no verificable en FASE 1).

| Elemento | Nivel real | Evidencia | Qué falta | Prio | Esf. | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| Formato replay v2 (JSONL+gzip/zstd, keyframes, checkpoints por componente) | D·I·M | `apps/arena-engine/src/replay.ts:30` (`REPLAY_FORMAT_VERSION=2`), `replay-service/src/format.ts`, CODE_VERIFIED; Node 22.15 en Dockerfiles → zstd disponible | prueba de ida y vuelta zstd en la imagen real | P3 | S | No |
| Compatibilidad entre versiones de motor | D·I·M (sólo «misma versión») | `engine-deps.json` 0.5.0 «verificador de versión única»; `engine-version-bump.test.ts` | política de longevidad/migración de replays; mensaje en visor (STR-04/05) | P2 | M | No (sí si hay replays viejos que mostrar) |
| Reproductor web de replays | D·I·M, P? | `ReplayPage.tsx`, segmentos `/replays/:id/segment`; TD-009 cerrada (PR #152) | UX para replays v1 (STR-04) | P2 | S | No |
| Espectador en vivo: gateway WS | D·I·M | `apps/api/src/spectate/gateway.ts` (562 l.), ticket por subprotocolo, jti de un uso, tope 100/batalla, maxPayload 64 KiB | límites de conexión en el borde (`limit_conn` ausente: `git grep` vacío en infrastructure/gateway), backpressure (STR-10) | P2 | M | Sólo si se activa espectador público |
| Retardo anti-coaching | D·I·M | gateway `history` + `sendTo` diferido; `TOURNAMENT_SPECTATOR_DELAY_SECONDS=30` (`game-rules/battle-rules.ts:86`), máx. 30 s | configurable desde web (STR-07) | P3 | M | No |
| Visibilidad privada de equipos/equipamiento | D·I·M | un `AudienceProjector` por audiencia firmada (`gateway.ts`, `packages/projection`, `policy.ts` `EQUIPMENT_PRIVATE`); tests `ma-projection-boundary`, `g2-armor-broken-ws` | prueba de fuga E2E real en FASE 2 | P2 | S | No |
| Renderer (Phaser, atlas, tinte de equipo) | D·I·M | `PhaserViewer.ts`, `packages/game-rules/art-direction.ts` (paleta determinista) | color blanco en emisión (STR-06); distinción intra-equipo 4v4 | P2 | M | No |
| Mejoras visuales FASE 0 (inventario/contrato) | D sólo | PR #253 draft: 10 ficheros, 4477 líneas, docs + `visual-contract.test.ts`; `mejoras-visuales` = master plan | decidir/ejecutar FASE 1 | P4 | XL | No |
| Mejoras visuales FASE 1 | no existe | ninguna rama ni PR | — | P4 | XL | No |
| Streamer V1 (supervisor, ffmpeg, relé RTMPS) | D·I·M, P?, F (DOC_ONLY) | `apps/streamer/src/*`; ffmpeg sin destino/clave (`pipe:3`, `ffmpeg.ts:33`); CI `ci` verde en 8f380eb (build-images streamer) | sesión larga, congelado (STR-01/03) | P1 | M | Condicional (eventos largos) |
| Director `/broadcast` con línea temporal retrasada | D·I·M | `broadcast/director.ts`, `delayed-timeline.ts`; commits c5b16a3b/257c365f (#284), 01aae7bf (#282) | C3b: prueba con 5+ ticks/batalla larga (STR-13) | P2 | M | No |
| Admin de streaming web (estado, destino, claves, start/stop, failover) | D·I·M | `StreamingPage.tsx`, `routes/streaming.ts`, `services/streaming.ts`, migración 017 | claves no migradas a la instalación nueva (operativo) | P2 | S | **Sí en la instalación nueva si se quiere emitir** (re-introducir claves) |
| Claves de emisión selladas | D·I·M | `packages/stream-secrets` RSA-OAEP+AES-GCM, atadas a plataforma+ingesta; `secret-surfaces.test.ts` | prueba de restauración del par de claves en el host nuevo | P2 | S | Igual que arriba |
| «Fuentes tipo OBS» V1 | PARCIAL (sólo URL) | `/broadcast?battle=id|?tournament=id` (`broadcast/config.ts:69`); requiere anónimo+flag | listado de fuentes, `layout=clean`, fondo transparente, una URL por batalla (= V2 MS-6) | P4 | L | No |
| Streaming V2 / Broadcast Manager | D sólo | `origin/ms/architecture-v2` 1077a04b: sólo `docs/technical/STREAMING_ARCHITECTURE_V2.md`; base 7bddda9 desfasada | rebase del diseño sobre main; decisión de ir/no ir | P4 | XL | No |
| Start sincronizado batalla↔emisión | D sólo (V2 §8) | doc V2; V1 no retiene batallas | — | P4 | XL | No |
| Próxima ola Web/Streaming/UX | D sólo | PR #286 draft: `NEXT_WEB_STREAMING_UX_WAVE.md` (586 l.) | — | — | — | No |
| Streaming de replays en emisión | D sólo | V2 §13; en V1 `broadcast-no-replay` (#256) | MS-7 | P4 | L | No |

## 3. Fortalezas (con evidencia) y debilidades

Fortalezas
- Frontera de secretos muy cuidada: clave sellada, sin argv/env/logs/`/status`; ffmpeg no conoce ni destino ni clave (`apps/streamer/src/ffmpeg.ts:33`, test `secret-surfaces.test.ts`). `CODE_VERIFIED`.
- El streamer valida por su cuenta la orden (SSRF de `/broadcast` mismo origen, listas cerradas, NVENC sólo confirmado) `session.ts`. `CODE_VERIFIED`.
- Puerta «render listo» y vigilante de blanco (`supervisor.ts` `RENDER_*`), relé RTMP con Happy Eyeballs y `connect` txn 1 (regresión de «modo YouTube real»), failover a respaldo. `CODE_VERIFIED` (tests unitarios en CI).
- Anti-fugas del canal en vivo: proyección única por audiencia, `debug` sólo con ticket staff firmado, latido sin estado (`heartbeatMessage`), buffers acotados en el cliente (`interpolation.ts:189`, `MAX_LIVE_EFFECTS=512`, `MAX_DECALS=128`).
- Fail-closed: con `S9_PUBLIC_SPECTATE_ENABLED` apagado no se emiten tickets anónimos (`routes/battles.ts` ~L692) y `start` rechaza el destino con motivo (`routes/streaming.ts` `targetRejectMessage`). Esto cierra el defecto «emisión vacía» a nivel de inicio.
- Alertas Prometheus del streamer (`StreamerDown`, `RestartLoop`, `DroppedFramesHigh`, `NoProgress`, `RenderNotReady`) y reconciliador con doble lectura.

Debilidades: ver hallazgos (sesión larga, congelado, replays viejos, color, nightly rojo, V2 sólo diseño, coste en host compartido).

## 4. Hallazgos

### STR-01 · Estabilidad en sesiones largas no demostrada (ni mitigada)
- Streaming / P1 · RIESGO (FALTA de evidencia) · Grupo B
- Descripción: Chromium sobre una misma página `/broadcast` durante horas (torneo largo), un WS por batalla seguida, sin reciclado programado de Chromium ni de la página. Las mediciones son de 12 min (RSS 448→450 MiB), 90 s y 120 s; en la de 120 s el RSS creció 600→802 MiB y el propio doc dice que «no basta para descartar crecimiento». El diseño V2 lista «fugas, renderer colgado» como riesgo propio. Impacto: administrador/espectadores; emisión que se degrada o cae a las horas, justo en eventos.
- Evidencia: `docs/operations/streaming.md` «Recursos medidos» (L563-638) `DOC_ONLY`; no hay watcher de RSS ni de uptime de página en `supervisor.ts` (`grep` de rss/memory vacío) `CODE_VERIFIED`; V2 §25.
- Causa probable: ausencia de soak test y de política de reciclado. Solución: soak de ≥6-8 h con batallas encadenadas (FASE 2), métricas de RSS de Chromium en `/metrics`, y si crece, reciclado en intermedio con la puerta de render ya existente.
- Esfuerzo: M (media incertidumbre). Dependencias: lab con ≥4 vCPU. Validación: curva de RSS/FPS/descartes por hora plana.

### STR-02 · No hay detección de imagen CONGELADA (sólo blanco/uniforme)
- Streaming / P2 · HIPÓTESIS con base de código · Grupo B
- Descripción: el vigilante clasifica un frame suelto por luma (`classifyFrame`: white/uniform/visible, `frame-check.ts:69`). Una página con JS colgado, o un feed WS atascado con la última escena dibujada, es «visible» y se emite congelado. Sólo el proceso Chromium caído y el blanco disparan reintento. Mitigación parcial: `StreamerNoProgress` (alerta de progreso de ffmpeg, que seguirá avanzando con imagen congelada) y heartbeat WS del visor (10 s de watchdog en cliente).
- Evidencia: `supervisor.ts` ~L560-620, `frame-check.ts`. `CODE_VERIFIED` (ausencia). El efecto real es `UNKNOWN` hasta FASE 2.
- Solución: comparar hash/diff entre N frames separados y exigir variación mínima (el reloj/marcador del HUD cambia), con tolerancia en slates; alerta distinta. Esfuerzo S-M. Validación: inyectar congelación (SIGSTOP al renderer) en lab.

### STR-03 · Replays previos al formato v2/motor 0.5.0 son ilegibles y el visor no lo explica
- Replays / P2 · DEFECTO_CONFIRMADO (a nivel de código) · Grupo B
- Descripción: `fromJsonl` rechaza cualquier `formatVersion != 2` (`replay.ts` «cualquier otra versión se RECHAZA»). La lista de replays sigue mostrándolos (el índice `.replay.json` se lee aparte), pero `decodeReplayFile` devuelve `null` (`replay-service/src/segment.ts:~40`) y la API responde el mismo 404 uniforme de «replay inexistente» (`routes/replays.ts`). Sólo `verifyReplay` produce `format_version_mismatch` con mensaje humano (`routes/replays.ts:314-320`); `apps/web` no contiene ni `format_version_mismatch` ni `formatVersion`. Para el jugador/programador de bots: «mi replay desapareció / error al abrir». Para el administrador: no sabe si está corrupto.
- Alcance real depende de si prod conserva replays v1 (el reset competitivo pre-0.5 es el PR #295 draft; `UNKNOWN`).
- Solución: distinguir en el índice/lista (`playable: false, reason: format_version`) y mostrarlo en la lista y en el reproductor; o decidir expresamente purgarlos. Esfuerzo S. Validación: abrir fixture `engine-0.1.0-sin-perimetro.replay.jsonl.gz` por la API y comprobar el mensaje.

### STR-04 · Política de compatibilidad de replays = «ninguna»; cada subida de motor huérfana los anteriores
- Replays / P3 · DEUDA/decisión de producto · Grupo C
- Descripción: `engine-deps.json` 0.5.0 declara verificador de versión única; ADR-024 quita `engine.reproduces`. Los replays 0.4.0 dan `engine_version_mismatch` en verificación (no «manipulado», bien) pero siguen sin poder re-simularse; las estadísticas «por re-simulación» (`docs/technical/engine.md`) tampoco. Los replays públicos proyectados usan el stream grabado, no re-simulan (la reproducción en visor de un v2 de 0.4.0 es a verificar, `UNKNOWN`). Los oficiales «se conservan siempre» pero ya no son verificables.
- Solución: congelar el motor por temporada o conservar la imagen del motor anterior para verificar; o declarar la política explícitamente en docs de usuario. Esfuerzo L si se quiere compat real. Validación: replay v2/0.4.0 en el visor.

### STR-05 · Color de bots blanco/neutro en la emisión (STREAMING_BOT_TEAM_COLOR = FAIL)
- Renderer/Streaming / P2 · DEFECTO declarado, causa HIPÓTESIS · Grupo B
- Descripción: según el borrador PR #286 §9.2, en la emisión los bots salen blancos aunque web live/replay los coloreen. En main el color se resuelve por equipo en `PhaserViewer.tintForTeam` desde `art-direction.ts`; `team` es público en la proyección (`policy.ts` `vehicle.team`, `roster.team`) y el fallback es `NEUTRAL_TEAM_COLOR` (gris `0x9aa4a0`, que en vídeo puede parecer blanco). El chasis se pinta blanco + `setTint` (batch WebGL), por lo que las hipótesis son: (a) `team` ausente/ vacío al crear el sprite por orden init/roster, (b) tinte WebGL bajo SwiftShader, (c) audiencia `broadcast` sin `team`. No se puede decidir sin ejecutar.
- No está registrado en `docs/roadmap/technical-debt.md` ni `known-issues.md` (`git grep` de `STREAMING_BOT_TEAM_COLOR` en 8f380eb: vacío) → deuda no registrada.
- Solución: captura de frame de `/broadcast` en lab (Xvfb+SwiftShader) contra el mismo estado que `/viewer`, aserción de píxel por equipo; registrar TD. Esfuerzo S (diagnóstico) + S/M (arreglo).

### STR-06 · Retardo fijo de 30 s, no configurable; resultado público puede anticiparse al feed
- Espectador / P3 · FALTA + RIESGO · Grupo C
- Descripción: `delaySeconds` por ruleset (1-30), 30 s para torneos, 0 para la final (`spectator_mode: "visible"`, `scheduler.ts:200`, `engine-executor.ts:301`). El director duplica el tope 30 000 ms (`MAX_SPECTATOR_DELAY_MS`, atado por test). `STREAM_DELAY_CONFIGURABLE` está sólo en el borrador #286. Spoiler: con replays/estado público activados, `GET /battles/{id}` y la lista de replays pueden revelar el resultado antes del fin retrasado (borrador #286 §9.5; el director usa la API real sólo para descubrir, `FIX-DIRECTOR-DELAY`). No hay canal de coaching durante la batalla (la proyección pública va retrasada). Esfuerzo M. Validación: matriz 0/15/30/60/máx/inválido del propio borrador.

### STR-07 · Dependencia de S9_PUBLIC_SPECTATE_ENABLED: el aviso existe en el inicio, no durante la emisión
- Streaming / P2 · RIESGO · Grupo B
- Descripción: `/broadcast` es anónima y exige el flag; `start` lo comprueba (`broadcast-effective.ts`, `targetRejectMessage`: 409 `public_spectate_disabled`) `CODE_VERIFIED`. En la instalación nueva el flag está apagado y el streaming desactivado: hay que activar ambos conscientemente (también el espectador público abre la superficie WS: faltan `limit_conn/limit_req` en `/ws/`, `pending-features.md` y `git grep` vacío). Si el flag se apaga durante una emisión (ajuste de runtime en caliente), las conexiones nuevas del gateway rechazan tickets anónimos (4403) y los tickets del API devuelven 404: el director debería mostrar `SOURCE_ERROR` en vez de una espera falsa, pero **no se ha comprobado que el streamer lo reporte como fallo** (`UNKNOWN`). Validación en FASE 2 (§7, T6).

### STR-08 · Gateway en el proceso del worker: coste y backpressure
- Espectador / P3 · RIESGO · Grupo C
- Descripción: el gateway corre en el mismo proceso que el motor (tournament-worker, `engine-executor.ts:304-326`). Cada snapshot se proyecta 3 veces (3 audiencias) aunque no haya clientes (a propósito, por numeración), `battle.snapshots` crece durante toda la batalla, y cada mensaje a cada cliente con retardo crea un `setTimeout` (≈ 10 Hz × 30 s = ~300+ timers vivos por cliente) sin comprobar `ws.bufferedAmount`: un cliente lento acumula memoria; sin ping/pong salvo el latido de retardo. Tope 100 clientes/batalla. Impacto: el pico de espectadores compite con el tick del motor. Evidencia `CODE_VERIFIED` (gateway.ts L270-340, 480-562). Validación: carga en lab con N=100 clientes lentos y medir periodo de tick.

### STR-09 · El job nocturno `slow-suites` está rojo en 8f380eb por entorno (sin ffmpeg/userns)
- CI / P2 · DEFECTO_CONFIRMADO · Grupo B
- Evidencia `TEST_VERIFIED`: run 44519497401 (nightly, 2026-11-19, sha 8f380eb): `slow-suites` failure; fallos `stream-tap.test.ts` (2), `streamer-real.test.ts` (2), `streamer-2.test.ts` (1), `b13-data-volumes` (1): `spawnSync ffmpeg ENOENT`, «unshare -rm no funciona en este runner». El job `ci` de 8f380eb (run 44383512640, 2026-11-18) está verde y su etapa `unit` instala ffmpeg y habilita userns (`ci.yml` ~L72-90), por lo que los tests del streamer con ffmpeg real están protegidos en CI normal pero **no** en el nocturno. Efecto: el nocturno rojo se normaliza y puede ocultar regresiones reales (`determinism-1000` sí pasa). Solución: mismo paso de ffmpeg/userns en `nightly.yml`. Esfuerzo S.

### STR-10 · C3b y verificación E2E del streaming fuera de CI
- Streaming / P2 · FALTA · Grupo B
- Descripción: C3 se verificó en producción pero C3b (≥5 ticks distintos por batalla, movimiento, HUD cambiante, transición, final respetando retardo, sin reset RTMP) sigue abierta (#286 §13; `git grep` de «C3b» en main: vacío). Los scripts `tests/streaming-e2e/*` (MediaMTX, `measure.sh`, `issue-256.sh`) son manuales; `acceptance/visual` (Playwright) y parte de `tests/acceptance` no corren en el CI normal (#286 §12.2). El workflow `acceptance` está verde en 8f380eb (run 44537834319), pero no cubre emisión (UNKNOWN su contenido exacto). No bloquea, pero la prueba de que «sale bien en vídeo» depende de ejecuciones manuales.

### STR-11 · TD-066 está obsoleta: los dos defectos que cita ya no existen
- Streaming / P3 · DEUDA mal registrada · Grupo E (cerrar/reescribir)
- `technical-debt.md` TD-066 (P3, ABIERTA) afirma «la clave entra en el argv de FFmpeg `ffmpeg.ts:115-118`», «sin retención de MP4» y «sin alerta streamer_up». En 8f380eb ffmpeg escribe FLV por `pipe:3` (`ffmpeg.ts:33`; `secret-surfaces.test.ts`), hay retención de grabaciones (`apps/streamer/src/recordings.ts`, #249) y alertas `StreamerDown/RestartLoop/NoProgress` (`alerts.yml` L116-155). Queda vigente sólo «YouTube sin probar» (afirmado probado en noviembre por el brief; sin evidencia en el repo). `known-issues.md` L41 y L71 repiten la afirmación (CODE_VERIFIED refutada). Prioridad anterior P3 → propuesta: reabrir como «prueba E2E documentada con YouTube» P4 y cerrar el resto.

### STR-12 · Documentación de streaming desfasada
- Docs / P3 · DEUDA · Grupo C
- `docs/technical/streaming-architecture.md` se declara «comprobado contra equipo5/streamer-real, base 0abd3eb» y marca YouTube «BLOCKED»; el comentario de cabecera del gateway aún dice «pendiente de reconciliación con E9». V2 se basó en 7bddda9 y cita #269-#272/#274 como «no integrados»: hoy #274 está mergeado (2026-11-12) y las capas MD/MA/MG están en main (`replay.ts` v2, `packages/projection`, `broadcast-effective.ts`). Esfuerzo S.

### STR-13 · «Fuentes tipo OBS»: sólo una URL por destino; sin sincronía de arranque
- Streaming / P4 · FALTA (diseñada en V2) · Grupo D
- V1 permite `?battle=`/`?tournament=` como fuente de navegador, pero sin lista de fuentes, `layout=clean`, fondo transparente ni pre-roll; ninguna sincronización «la batalla no empieza hasta que la emisión está lista» (V2 §8 `START_WITH_BROADCAST`, retención en `claimBattle`), por lo que en V1 una batalla programada empieza independientemente del streamer (el director admite «wait=scheduled»). V2 es sólo diseño (STR-14).

### STR-14 · Streaming V2 es documento, no producto; diseño parcialmente caducado
- Streaming / P4 · FALTA · Grupo D
- `git -C <clon-del-repo> diff --stat origin/main...origin/ms/architecture-v2`: 2 ficheros (`docs/technical/STREAMING_ARCHITECTURE_V2.md` +1249, `index.md` +6). PR #275 OPEN draft, sin merge; main no contiene `StreamSession/BroadcastItem/BroadcastQueue` (`git grep` vacío). Decisiones D1-D4 «DECIDED» por el operador (12-nov) pero sin código; plan MS-2…MS-8 sin empezar. Antes de implementar hay que rebasar sobre main (base 7bddda9, flujo OLA 2 ya integrado) y reconciliar con la «próxima ola» (#286, draft docs). Esfuerzo XL para el conjunto.

### STR-15 · Identificación visual de equipos 4v4: sólo color por nombre + etiqueta
- Renderer / P3 · FALTA · Grupo C
- Paleta determinista por nombre (`art-direction.ts`: red/blue/green… + rotación de 8 tonos, gris al agotarse). Dentro del equipo sólo hay nombre de bot (etiqueta), no marca por bot; no hay comprobación de accesibilidad (daltonismo) ni de contraste en vídeo comprimido a 1080p30/VBR. FASE 0/1 de «mejoras visuales» es sólo plan (PR #253 draft, `mejoras-visuales` con un único commit docs). `DESIGN_ONLY`.

### STR-16 · Dropped frames 0,6-0,8 % sin diagnosticar; ancho de banda y host de producción no medidos
- Streaming / P3 · RIESGO · Grupo B
- Medidos en lab: 21/2852, 82 en 6 min, 23/3832; causa `UNKNOWN` (#286 §12.1). `UPLOAD_AVAILABLE` no medido; extrapolación a prod «con incertidumbre»; host de producción con swap/RAM (#185). Criterio de despliegue del propio doc: ≥3 vCPU y ≥1 GiB libres sin swap. Si se emite en el mismo host que el motor, hay contención (gateway en el worker, STR-08).

### STR-17 · Reinicio del streamer / claves no migradas en la instalación nueva
- Operación / P2 · RIESGO · Grupo A para quien quiera emitir
- Streaming desactivado y claves no migradas (afirmado por el brief; producción no verificable). Mecanismo de código: la clave se guarda sellada con la pública y el streamer la abre con la privada (`stream_secrets_*.pem` en `infrastructure/secrets/`); si la instalación nueva generó un par distinto, las credenciales antiguas dan `credential_stale/unbound` y hay que volver a introducirlas por la web (`routes/streaming.ts`). El reinicio del streamer deja la sesión `interrupted` y exige un START (reconciliador, `uxState`), no reanuda solo (diseño V1; V2 lo cambiaría). `CODE_VERIFIED` del mecanismo; estado real `UNKNOWN`.

## 5. Deuda técnica (revalidación)

| ID | Anterior | Nueva | Motivo |
|---|---|---|---|
| TD-066 | P3 ABIERTA (clave en argv, sin retención, sin alerta, YouTube sin probar) | cerrar tres de cuatro; resto P4 | STR-11: `ffmpeg.ts:33` `pipe:3`; `recordings.ts`; `alerts.yml` |
| TD-009 (reproductor roto) | CERRADA | confirmo cerrada en código | `ReplayPage` + segmentos; browser real sólo en `functional-e2e` (verde en 8f380eb) |
| TD-004 (replays anónimos) | CERRADA | confirmo | `replay-access.ts`, proyección pública (`replay-projection.ts`) |
| TD-028 (espectador público) | CERRADA | sigue condicionada al gate: `limit_conn/limit_req` ausentes | `git grep` vacío en `infrastructure/gateway` |
| TD-071 (`aborted` sin `technical_limit`) | P3 | sin cambio | fuera de mi área |

Deuda NUEVA no registrada: STR-05 (color), STR-06 (delay/spoiler), STR-09 (nightly rojo), STR-10 (C3b/acceptance), STR-03 (UX replays v1), STR-01/02 (sesión larga y congelado), STR-16 (dropped frames).

## 6. Verificaciones para FASE 2 (lab aislado, sin claves reales)

Entorno: lab aislado (≥4 vCPU, imagen real del streamer, MediaMTX local con TLS de CA local en el almacén; `STREAMER_ALLOW_PLAIN_RTMP` sólo si se prueba sin TLS; clave **ficticia** sellada con un par de claves de laboratorio, nunca la de producción). Reutilizar `tests/streaming-e2e/e2e.sh`, `measure.sh`, `issue-256.sh`, `issue-251-restart.sh`.

| ID | Prueba | Resultado que confirma / refuta |
|---|---|---|
| T1 Render | `/broadcast?battle=<id>` con una batalla real 4v4 bajo Xvfb+SwiftShader; captura de frames (x11grab) cada 10 s; aserción de color medio por zona de bot y comparación con `/viewer` del mismo estado | Confirma/refuta STR-05: píxeles de equipo distintos y no neutros; si grises → causa en init/roster/tinte |
| T2 Emisión local | START (admin) con destino MediaMTX + clave ficticia; leer con ffprobe/ffplay: 1080p30, GOP 2 s, AAC; `blackdetect`/`freezedetect`; métricas `stream_*` | LIVE sólo cuando el relé publica; 0 negro; descartes % documentados (STR-16) |
| T3 Corte de ingesta | matar/pausar MediaMTX 30 s y 3 min; reanudar | reconexión sin intervención, contador de reintentos, failover a un 2.º MediaMTX tras 3 fallos de red; clave rechazada NO cambia de ingesta |
| T4 Sesión larga (STR-01) | 8 h continuas encadenando 20+ batallas largas (4v4, mapa grande); muestrear RSS de Chromium/Node/ffmpeg, FPS, descartes, `/dev/shm`, nº procesos cada 30 s | RSS plano (pendiente ~0), 0 huérfanos/zombis, 0 reintentos espontáneos; si crece → diseñar reciclado |
| T5 Congelado (STR-02) | durante emisión, `SIGSTOP` al renderer de Chromium, y otro caso cortando el WS al gateway dejando la escena | refuta/confirma: hoy previsible que NO se detecte; tras el arreglo debe saltar alerta en < N s |
| T6 Flag público (STR-07) | arrancar emisión con `S9_PUBLIC_SPECTATE_ENABLED` activo y apagarlo en caliente a mitad | `director`→`SOURCE_ERROR` visible, alerta, o emisión vacía silenciosa; con el flag apagado desde el inicio, `start` = 409 |
| T7 Retardo/C3b | batalla ≥3 min con retardo 30 s: capturar ≥5 ticks distintos, transición a la siguiente, fin del torneo; medir latencia fin real → «terminado» en vídeo; comparar con valores 0/15/30 | fin visible ≥ delay tras el fin real; ningún reset RTMP; cierra C3b |
| T8 Spoiler | durante la batalla con retardo, hacer polling anónimo a `/battles/{id}`, `/public/battles/live`, `/replays` | cuantifica ventana en la que el resultado es público antes del feed |
| T9 Replay | abrir (API+visor) un fixture v1 (`engine-0.1.0-sin-perimetro…jsonl.gz`), un v2 de 0.4.0 y uno de 0.5.0; `verify` de cada uno | v1: confirma STR-03 (404 sin explicación); 0.4.0: `engine_version_mismatch` y si el visor reproduce |
| T10 Gateway bajo carga | 100 clientes (50 lentos con lectura pausada) sobre una batalla 4v4; medir periodo de tick del motor y RSS del worker | cuantifica STR-08; el tick no debe degradarse |
| T11 Fuga de proyección | WS con ticket `public_live`/`broadcast`/anónimo: buscar ids internos, radio, equipamiento, `debug`, `hullHpMax` | cero campos prohibidos; `debug` sólo con ticket staff |
| T12 Reinicio | `docker restart` del streamer en LIVE; reinicio del API | uxState `interrupted`, el reconciliador deja BD consistente, un START recupera |
| T13 CI | añadir ffmpeg+userns al nocturno y relanzar | `slow-suites` verde → cierra STR-09 |

## 7. Respuestas cortas

- ¿Streaming V1 funciona de verdad? Código e integración sí (M); «funcionando» depende de la evidencia de noviembre que sólo es documental aquí; producción desactivada en la instalación nueva y sin claves.
- ¿Y la «emisión vacía»? Ya no se puede iniciar con el flag apagado (409 con motivo); sigue siendo requisito operativo activar `S9_PUBLIC_SPECTATE_ENABLED` (y sus condiciones de borde).
- ¿#282? El fix del director que esperaba el retardo es #284 (`fix/director-delayed-timeline`, 2026-11-16); #282 (2026-11-15) es el de latidos/watchdog del gateway. Ambos en main.
- ¿V2 existe? No: diseño (PR #275 draft, docs únicamente). ¿PR #286? Draft de documentación.
- ¿Replays compatibles entre versiones? No: formato v2 único y verificador de versión única; v1 ilegible, versiones previas de motor sin re-simulación.
- ¿Sincronía batalla↔emisión? V1 no la controla (el director sigue la línea retrasada); retención/start sincronizado es V2.
- ¿Bloquea lanzamiento? Nada de mi área bloquea un lanzamiento sin emisión pública; para emitir: reintroducir claves, activar flags y pasar T2-T7.
