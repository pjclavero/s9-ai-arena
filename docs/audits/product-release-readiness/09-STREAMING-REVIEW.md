# 09 · Revisión de streaming, visor y retransmisión

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: estado real por niveles de replays, espectador, renderer, Streaming V1, Streaming V2/Broadcast Manager y mejoras visuales; hallazgos STR-; riesgos de sesión larga; pruebas de FASE 2 con destino RTMP local y clave ficticia. Veredicto global: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Deuda asociada: [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md). Batería de pruebas: [08-TEST-QUALITY.md](08-TEST-QUALITY.md) (B-14).

## 1. Veredicto

**Streaming V1: READY_WITH_CONDITIONS como herramienta de operador. Emisión de eventos largos sin supervisión y Streaming V2: NOT_READY.** El streaming se presenta como **experimental** (DECISIONES-DIRECTOR); no condiciona el lanzamiento A+ y no debe anunciarse como funcionalidad pública.

1. V1 está implementado e integrado en main de punta a punta (admin web → API → streamer → Chromium+Xvfb → ffmpeg → relé RTMPS propio con TLS verificado, claves selladas, failover principal/respaldo). CODE_VERIFIED.
2. La emisión real a una plataforma existe sólo como afirmación del operador y de documentos: **DOC_ONLY / evidencia de tercero, no reverificada**. El doc de arquitectura del propio repo aún marca el destino real como «BLOCKED» (desfasado, STR-12).
3. Los fallos históricos están corregidos en código: pantalla blanca (#256, puerta de render + vigilante), «emisión vacía» sin `S9_PUBLIC_SPECTATE_ENABLED` (ahora `start` responde 409 con motivo), director que cortaba antes del retardo (#284) y latidos/watchdog del gateway (#282); ambos en main.
4. Lo más débil: no hay evidencia de sesión larga (máximo 12 min medidos), ni detección de imagen congelada, y el color de los bots en la emisión es un defecto declarado sin corregir ni registrar (STR-05).
5. Replays: formato v2 único, sin compatibilidad hacia atrás por decisión; los previos a 0.5.0 se listan pero no se reproducen y el visor no lo explica (STR-03).
6. Espectador en vivo: proyección por audiencia, ticket de un solo uso, retardo fijo de 30 s con latidos; bien diseñado; sin límites en el borde.
7. V2 y mejoras visuales: **DESIGN_ONLY**, grupo D.
8. CI: `ci` verde en 8f380eb; la nightly está roja por ffmpeg/userns (STR-09 = [QA-01](08-TEST-QUALITY.md#qa-01)); los E2E reales de streaming no corren en CI.
9. Coste medido (no en producción): ~2,6 CPU y 0,5-0,8 GiB para 1080p30. El host de producción tiene una incidencia de swap/RAM abierta (#185): `CPU_ACCEPTABLE`/`MEMORY_ACCEPTABLE` no demostrados allí.

## 2. Estado por niveles

Niveles: **D** diseñado · **I** implementado · **M** integrado en main · **P** desplegado · **F** funcionando de verdad. P/F sólo con evidencia; si no, «?» (no verificable en FASE 1). Ningún elemento llega a P/F con evidencia verificada por esta auditoría.

| Elemento | Nivel real | Evidencia (@8f380eb) | Qué falta | Prio · grupo | Bloquea A+ |
|---|---|---|---|---|---|
| **Replays: formato v2** (JSONL+gzip/zstd, keyframes, checkpoints por componente) | D·I·M | `apps/arena-engine/src/replay.ts:30` (`REPLAY_FORMAT_VERSION=2`), `replay-service/src/format.ts`. CODE_VERIFIED | Prueba de ida y vuelta zstd en la imagen real | P3 · C | No |
| **Replays: compatibilidad entre versiones** | D·I·M, sólo «misma versión» | `engine-deps.json` 0.5.0 (verificador de versión único), `engine-version-bump.test.ts`; `fromJsonl` rechaza `formatVersion != 2` | Política de longevidad y mensaje en el visor (STR-03/04) | P2/P3 · B/C | No (sí si se muestran replays viejos) |
| **Replays: reproductor web** | D·I·M, P? | `ReplayPage.tsx`, segmentos `/replays/:id/segment`; TD-009 cerrada (PR #152); browser real sólo en `functional-e2e` (success en 44383512640) | UX para replays v1 (STR-03) | P2 · B | No |
| **Espectador: gateway WS** | D·I·M | `apps/api/src/spectate/gateway.ts` (562 l.): ticket por subprotocolo, `jti` de un uso, tope 100/batalla, `maxPayload` 64 KiB | `limit_conn/limit_req` ausentes en el borde; backpressure (STR-08) | P2/P3 · C | Sólo si se activa espectador público |
| **Espectador: retardo anti-coaching** | D·I·M | `TOURNAMENT_SPECTATOR_DELAY_SECONDS=30` (`game-rules/battle-rules.ts:86`), máximo 30 s | Configurable desde web; spoiler por API (STR-06) | P3 · C | No |
| **Espectador: visibilidad privada de equipos/equipamiento** | D·I·M | `AudienceProjector` por audiencia firmada; `packages/projection`; `policy.ts` `EQUIPMENT_PRIVATE`; tests `ma-projection-boundary`, `g2-armor-broken-ws` | Prueba de fuga E2E real (FASE 2, T11) | P2 · C | No |
| **Renderer** (Phaser, atlas, tinte de equipo) | D·I·M | `PhaserViewer.ts`, `packages/game-rules/art-direction.ts` (paleta determinista) | Color blanco en emisión (STR-05); distinción intra-equipo 4v4 (STR-15) | P2/P3 · C | No |
| **Streaming V1: streamer** (supervisor, ffmpeg, relé RTMPS) | D·I·M; P?; F = DOC_ONLY | `apps/streamer/src/*`; ffmpeg sin destino ni clave (`ffmpeg.ts:33`, `pipe:3`); CI `ci` verde (build-images streamer) | Sesión larga, congelado (STR-01/02) | P2 · C | No (eventos largos: condicional) |
| **Streaming V1: director `/broadcast`** con línea temporal retrasada | D·I·M | `broadcast/director.ts`, `delayed-timeline.ts`; commits de #284 y #282 | C3b: prueba con ≥5 ticks distintos en batalla larga (STR-10) | P2 · C | No |
| **Streaming V1: admin web** (estado, destino, claves, start/stop, failover) | D·I·M | `StreamingPage.tsx`, `routes/streaming.ts`, `services/streaming.ts`, migración 017 | Claves no migradas a la instalación nueva (STR-17) | P2 · C | Sólo si se quiere emitir |
| **Claves de emisión selladas** | D·I·M | `packages/stream-secrets` (RSA-OAEP+AES-GCM, atadas a plataforma+ingesta), `secret-surfaces.test.ts` | Prueba de restauración del par de claves en un host nuevo | P2 · C | Igual |
| **«Fuentes tipo OBS» V1** | PARCIAL (sólo URL) | `/broadcast?battle=id\|?tournament=id` (`broadcast/config.ts:69`); requiere anónimo + flag | Lista de fuentes, `layout=clean`, fondo transparente (= V2 MS-6) | P4 · D | No |
| **Streaming V2 / Broadcast Manager** | **D sólo** (DESIGN_ONLY) | PR #275 draft: `docs/technical/STREAMING_ARCHITECTURE_V2.md` (2 ficheros, ≈1.250 líneas); `git grep` de `StreamSession/BroadcastItem/BroadcastQueue` en 8f380eb: vacío | Rebase del diseño (base desfasada) y decisión de ir/no ir | P4 · D | No |
| **Start sincronizado batalla↔emisión** | D sólo (V2 §8) | V1 no retiene batallas | — | P4 · D | No |
| **Próxima ola Web/Streaming/UX** | D sólo | PR #286 draft: `NEXT_WEB_STREAMING_UX_WAVE.md` (586 l.) | — | — | No |
| **Mejoras visuales FASE 0** | D sólo | PR #253 draft: 10 ficheros, 4.477 líneas, docs + `visual-contract.test.ts` | Decidir/ejecutar FASE 1 | P4 · D | No |
| **Mejoras visuales FASE 1** | No existe | Ninguna rama ni PR | — | P4 · D | No |
| **Streaming de replays en emisión** | D sólo (V2 §13) | En V1 `broadcast-no-replay` (#256) | MS-7 | P4 · D | No |

## 3. Fortalezas verificadas (todas CODE_VERIFIED)

- Frontera de secretos cuidada: clave sellada, sin argv/env/logs/`/status`; ffmpeg no conoce ni destino ni clave (`apps/streamer/src/ffmpeg.ts:33`; `secret-surfaces.test.ts`).
- El streamer valida por su cuenta la orden (SSRF de `/broadcast` mismo origen, listas cerradas, NVENC sólo confirmado) en `session.ts`.
- Puerta «render listo» y vigilante de blanco (`supervisor.ts` `RENDER_*`), relé RTMP con Happy Eyeballs, failover a respaldo.
- Anti-fugas del canal en vivo: proyección única por audiencia, `debug` sólo con ticket staff firmado, buffers acotados en el cliente (`interpolation.ts:189`, `MAX_LIVE_EFFECTS=512`, `MAX_DECALS=128`).
- Fail-closed: con `S9_PUBLIC_SPECTATE_ENABLED` apagado no se emiten tickets anónimos y `start` rechaza con motivo (`routes/streaming.ts` `targetRejectMessage`, 409 `public_spectate_disabled`).
- Alertas del streamer (`StreamerDown`, `RestartLoop`, `DroppedFramesHigh`, `NoProgress`, `RenderNotReady`; `alerts.yml:116-155`) y reconciliador con doble lectura.

Los tests unitarios corren en `ci` (ffmpeg instalado) y están en success en 8f380eb; no se vieron en rojo ni se ejecutaron aquí.

## 4. Riesgos de sesión larga

| Riesgo | Estado | Evidencia | Mitigación existente | Falta |
|---|---|---|---|---|
| Crecimiento de memoria de Chromium sobre una misma página `/broadcast` durante horas | No demostrado ni mitigado | Mediciones de 12 min (RSS 448→450 MiB), 90 s y 120 s; en la de 120 s el RSS creció 600→802 MiB y el doc dice que «no basta para descartar crecimiento» (`docs/operations/streaming.md` L563-638, DOC_ONLY). Sin vigilancia de RSS ni de uptime de página en `supervisor.ts` (grep vacío) | Puerta de render y reintento si Chromium cae | Soak ≥6-8 h; métrica de RSS; reciclado programado |
| Imagen congelada (JS colgado o feed WS atascado) | No detectada | `frame-check.ts:69` clasifica un frame suelto por luma; «visible» se emite congelado | `StreamerNoProgress` (ffmpeg sigue avanzando con imagen congelada, no sirve) y watchdog de 10 s del visor | Comparar frames separados y exigir variación del HUD |
| Un WS por batalla en torneos largos | Sin medir | director sigue la línea retrasada | — | T4 |
| Gateway en el proceso del worker | Riesgo de contención | `engine-executor.ts:304-326`: cada snapshot se proyecta 3 veces; ≈300 timers vivos por cliente con retardo; sin `bufferedAmount` ni ping/pong | Tope 100 clientes | T10 |
| Flag público apagado a mitad de emisión | `UNKNOWN` | Tickets nuevos rechazados (4403); el streamer podría no reportarlo como fallo | `start` rechaza al inicio | T6 |
| Reinicio del streamer en LIVE | Por diseño | La sesión queda `interrupted` y exige START (V1; V2 lo cambiaría) | Reconciliador | T12 |
| Dropped frames 0,6-0,8 % | Sin diagnosticar | 21/2852, 82 en 6 min, 23/3832 (lab) | — | T2 |
| Host de producción con swap/RAM | Incidencia abierta (#185) | Criterio del propio doc: ≥3 vCPU y ≥1 GiB libres sin swap | — | Lab con ≥4 vCPU |

## 5. Hallazgos STR-

Severidad final según DECISIONES-DIRECTOR y REVISION-TECNICA; grupo según REVISION-PRODUCTO (opción A+). Informe origen: 06.

<a id="str-01"></a>
### STR-01 · Estabilidad en sesiones largas no demostrada ni mitigada

- **P1 → P2 (REVISION-TECNICA) · Grupo C (DECISIONES-DIRECTOR: streaming experimental; informe 06: B)** · RIESGO (FALTA de evidencia). Evidencia: DOC_ONLY (mediciones) + CODE_VERIFIED (ausencia de vigilancia).
- Argumento de RT: el streaming está desactivado por defecto y es opcional; no hay evidencia de fallo, sólo de ausencia de prueba. Sería P1 si el lanzamiento incluyera emisiones largas sin supervisión.
- Solución: soak ≥6-8 h con batallas encadenadas, RSS de Chromium en `/metrics`, reciclado en intermedio con la puerta de render existente. M, media. Validación: curva plana de RSS/FPS/descartes por hora (T4).

<a id="str-02"></a>
### STR-02 · No hay detección de imagen congelada (sólo blanco/uniforme)

- **P2 · Grupo C (RP)** · HIPÓTESIS con base de código. `frame-check.ts:69`, `supervisor.ts` ~L560-620. Efecto real UNKNOWN. Solución: comparar hash/diff entre N frames separados, alerta distinta. S-M. T5.

<a id="str-03"></a>
### STR-03 · Replays previos al formato v2 son ilegibles y el visor no lo explica

- **P2 · Grupo B** · DEFECTO_CONFIRMADO (código). `fromJsonl` rechaza `formatVersion != 2`; `decodeReplayFile` devuelve `null` (`replay-service/src/segment.ts:~40`); la API responde el mismo 404 uniforme de «replay inexistente»; sólo `verifyReplay` da `format_version_mismatch` (`routes/replays.ts:314-320`); `apps/web` no contiene `format_version_mismatch` ni `formatVersion` (RT: CONFIRMADO). El alcance depende de si producción conserva replays v1 (reset competitivo = PR #295 draft; UNKNOWN). Solución: `playable: false, reason: format_version` en índice y reproductor, o purga decidida. S. T9.

<a id="str-04"></a>
### STR-04 · Política de compatibilidad de replays = «ninguna»

- **P3 · Grupo C** · DEUDA / decisión de producto. Cada subida de motor deja sin re-simulación a los replays anteriores (`engine_version_mismatch`), incluidas las estadísticas por re-simulación y los oficiales «que se conservan siempre». Enlazado con ARQ-01 (el job de estadísticas re-simula sin comprobar versión: P2/B, obligatorio antes de la próxima subida de motor). Solución: congelar el motor por temporada, conservar la imagen del motor anterior, o declarar la política. L si se quiere compatibilidad real.

<a id="str-05"></a>
### STR-05 · Color de bots blanco/neutro en la emisión

- **P2 · Grupo C** · DEFECTO declarado, causa HIPÓTESIS. Según el borrador PR #286 §9.2 los bots salen blancos en la emisión aunque la web los coloree. En main: `PhaserViewer.tintForTeam` desde `art-direction.ts`, fallback `NEUTRAL_TEAM_COLOR` (gris `0x9aa4a0`, que en vídeo puede parecer blanco). Hipótesis: `team` ausente al crear el sprite, tinte WebGL bajo SwiftShader, o audiencia `broadcast` sin `team`. **No registrado** como TD en main (`git grep STREAMING_BOT_TEAM_COLOR`: vacío). S (diagnóstico) + S/M (arreglo). T1.

<a id="str-06"></a>
### STR-06 · Retardo fijo de 30 s no configurable; el resultado público puede anticiparse

- **P3 · Grupo C** · FALTA + RIESGO. `delaySeconds` por ruleset (1-30), 30 s para torneos, 0 para la final (`scheduler.ts:200`, `engine-executor.ts:301`). Con replays/estado público activados, `GET /battles/{id}` y la lista de replays pueden revelar el resultado antes del fin retrasado (#286 §9.5). No hay canal de coaching durante la batalla. M. T7, T8.

<a id="str-07"></a>
### STR-07 · Dependencia de `S9_PUBLIC_SPECTATE_ENABLED`

- **P2 · Grupo C** · RIESGO. `/broadcast` es anónima y exige el flag (`broadcast-effective.ts`); activarlo abre la superficie WS sin `limit_conn/limit_req` en `/ws/`. Si se apaga en caliente, no se comprobó que el streamer lo reporte como fallo (UNKNOWN). T6.

<a id="str-08"></a>
### STR-08 · Gateway en el proceso del worker: coste y backpressure

- **P3 · Grupo C** · RIESGO. Ver §4. `gateway.ts` L270-340, 480-562. El pico de espectadores compite con el tick del motor. T10.

<a id="str-09"></a>
### STR-09 · Nightly rojo en 8f380eb por falta de ffmpeg/userns

- **P2 · Grupo A (= [QA-01](08-TEST-QUALITY.md#qa-01); DECISIONES-DIRECTOR)** · DEFECTO_CONFIRMADO. TEST_VERIFIED: run 44519497401, `stream-tap.test.ts` (2), `streamer-real.test.ts` (2), `streamer-2.test.ts` (1), `b13-data-volumes` (1). Los tests del streamer con ffmpeg real están protegidos en `ci` pero no en la nightly. T13. S.

<a id="str-10"></a>
### STR-10 · C3b y E2E de streaming fuera de CI

- **P2 · Grupo C** · FALTA. C3 se verificó en producción (afirmación) pero C3b (≥5 ticks distintos por batalla, movimiento, HUD cambiante, transición, final respetando el retardo, sin reset RTMP) sigue abierta (#286 §13). `tests/streaming-e2e/*` (MediaMTX, `measure.sh`, `issue-256.sh`), `acceptance/visual` y parte de `tests/acceptance` son manuales. El workflow `acceptance` verde (44537834319) no se sabe si cubre emisión.

<a id="str-11"></a>
### STR-11 · TD-066 está obsoleta

- **P3 · Grupo E (cerrar/reescribir)** · DEUDA mal registrada. Los tres defectos que cita ya no existen en 8f380eb: `ffmpeg.ts:10-13,33` (FLV por `pipe:3`, sin clave en argv), `apps/streamer/src/recordings.ts` (retención, #249), `alerts.yml:116-155`. CODE_VERIFIED, confirmado por RT. Queda «prueba E2E documentada con YouTube» como P4. `known-issues.md` L41 y L71 repiten la afirmación obsoleta. Ver [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md#td-066).

<a id="str-12"></a>
### STR-12 · Documentación de streaming desfasada

- **P3 · Grupo B** · DEUDA. `docs/technical/streaming-architecture.md` (base 0abd3eb) marca el destino real «BLOCKED»; el comentario de cabecera del gateway dice «pendiente de reconciliación con E9»; V2 cita #269-#272/#274 como no integrados y hoy #274 está mergeado (2026-11-12). S.

<a id="str-13"></a>
### STR-13 · «Fuentes tipo OBS»: sólo una URL por destino; sin sincronía de arranque

- **P4 · Grupo D** · FALTA (diseñada en V2). Una batalla programada empieza independientemente del streamer (`wait=scheduled`).

<a id="str-14"></a>
### STR-14 · Streaming V2 es documento, no producto

- **P4 · Grupo D (DECISIONES-DIRECTOR: sólo diseño; no condiciona)** · FALTA. PR #275 draft, sin merge; base 7bddda9 desfasada; decisiones D1-D4 «DECIDED» por el operador (12-nov) sin código; plan MS-2…MS-8 sin empezar. Rebasar sobre main y reconciliar con #286 antes de implementar. XL.

<a id="str-15"></a>
### STR-15 · Identificación visual de equipos 4v4

- **P3 · Grupo C** · FALTA (DESIGN_ONLY). Paleta determinista por nombre con rotación de 8 tonos y gris al agotarse (`art-direction.ts`); dentro del equipo sólo etiqueta de nombre; sin comprobación de daltonismo ni de contraste en vídeo 1080p30 VBR. Fases visuales: sólo plan (PR #253).

<a id="str-16"></a>
### STR-16 · Dropped frames y ancho de banda sin diagnosticar

- **P3 · Grupo C** · RIESGO. Medidos en lab 0,6-0,8 % con causa UNKNOWN; `UPLOAD_AVAILABLE` no medido; extrapolación a producción con incertidumbre; contención si se emite en el mismo host que el motor (STR-08).

<a id="str-17"></a>
### STR-17 · Reinicio del streamer y claves no migradas a la instalación nueva

- **P2 · Grupo C (REVISION-PRODUCTO; REVISION-TECNICA lo saca de A: es tarea operativa de la instalación del operador, no defecto del producto)** · RIESGO. La clave sellada se abre con la privada (`stream_secrets_*.pem` en `infrastructure/secrets/`); si la instalación nueva generó un par distinto, las credenciales antiguas dan `credential_stale/unbound` y hay que reintroducirlas por la web (`routes/streaming.ts`). Estado real UNKNOWN; no debe contar como bloqueante de lanzamiento del producto.

## 6. Respuestas cortas

- ¿V1 funciona de verdad? Código e integración sí (M); «funcionando» depende de evidencia de noviembre que sólo es documental aquí; en la instalación nueva está desactivado y sin claves.
- ¿Sigue habiendo «emisión vacía»? Ya no se puede iniciar con el flag apagado (409 con motivo); sigue siendo requisito activar `S9_PUBLIC_SPECTATE_ENABLED` y sus condiciones de borde.
- ¿V2 existe? No: diseño (PR #275). ¿PR #286? Borrador de documentación.
- ¿Replays compatibles entre versiones? No: formato v2 único; v1 ilegible; versiones previas de motor sin re-simulación.
- ¿Sincronía batalla↔emisión? V1 no la controla; retención y arranque sincronizado son V2.
- ¿Bloquea lanzamiento? Nada de esta área bloquea un lanzamiento que no anuncie emisión. Para emitir: reintroducir claves, activar flags y pasar T2-T7.

## 7. Pruebas de FASE 2 (todas BLOCKED (FASE 2))

Entorno: laboratorio aislado (≥4 vCPU), imagen real del streamer, **destino RTMP local** (MediaMTX) con TLS de una CA local en el almacén de confianza (`STREAMER_ALLOW_PLAIN_RTMP` sólo si se prueba sin TLS) y **clave ficticia** sellada con un par de claves de laboratorio; **nunca la clave ni el par de producción**. Reutilizar `tests/streaming-e2e/e2e.sh`, `measure.sh`, `issue-256.sh`, `issue-251-restart.sh`. FASE 2 sigue bloqueada hasta que cierre la migración de producción; ninguna de estas pruebas se ha ejecutado.

| ID | Prueba | Confirma o refuta | Hallazgo |
|---|---|---|---|
| T1 Render | `/broadcast?battle=<id>` con batalla 4v4 bajo Xvfb+SwiftShader; captura de frames cada 10 s; color medio por zona de bot frente a `/viewer` del mismo estado | Píxeles de equipo distintos y no neutros; si grises, causa en init/roster/tinte | STR-05 |
| T2 Emisión local | START con destino MediaMTX y clave ficticia; `ffprobe`/`ffplay`: 1080p30, GOP 2 s, AAC; `blackdetect`/`freezedetect`; métricas `stream_*` | LIVE sólo cuando el relé publica; 0 negro; descartes documentados | STR-16 |
| T3 Corte de ingesta | Pausar el destino 30 s y 3 min; reanudar | Reconexión sin intervención; failover a un segundo MediaMTX tras 3 fallos de red; clave rechazada no cambia de ingesta | — |
| T4 Sesión larga | 8 h continuas con 20+ batallas largas 4v4; muestrear RSS de Chromium/Node/ffmpeg, FPS, descartes, `/dev/shm`, procesos cada 30 s | RSS plano, 0 huérfanos, 0 reintentos espontáneos; si crece, diseñar reciclado | STR-01 |
| T5 Congelado | `SIGSTOP` al renderer; cortar el WS al gateway dejando la escena | Hoy previsiblemente NO se detecta; tras el arreglo debe saltar alerta en < N s | STR-02 |
| T6 Flag público | Emitir con el flag activo y apagarlo en caliente | `SOURCE_ERROR` visible, alerta o emisión vacía silenciosa; con el flag apagado desde el inicio, `start` = 409 | STR-07 |
| T7 Retardo / C3b | Batalla ≥3 min con retardo 30 s: ≥5 ticks distintos, transición, fin de torneo; medir latencia fin real → «terminado» en vídeo; comparar 0/15/30 | Fin visible ≥ retardo; sin reset RTMP; cierra C3b | STR-06, STR-10 |
| T8 Spoiler | Polling anónimo a `/battles/{id}`, `/public/battles/live`, `/replays` durante la batalla con retardo | Cuantifica la ventana en que el resultado es público antes del feed | STR-06 |
| T9 Replay | Abrir (API y visor) un fixture v1, un v2 de 0.4.0 y uno de 0.5.0; `verify` de cada uno | v1: 404 sin explicación; 0.4.0: `engine_version_mismatch` y si el visor reproduce | STR-03/04 |
| T10 Gateway bajo carga | 100 clientes (50 lentos) sobre una batalla 4v4; periodo de tick y RSS del worker | El tick no debe degradarse | STR-08 |
| T11 Fuga de proyección | WS con ticket `public_live`/`broadcast`/anónimo: buscar ids internos, radio, equipamiento, `debug`, `hullHpMax` | Cero campos prohibidos; `debug` sólo con ticket staff | — |
| T12 Reinicio | `docker restart` del streamer en LIVE; reinicio de la API | `interrupted`, BD consistente, un START recupera | STR-17 |
| T13 CI | Añadir ffmpeg y userns a la nightly y relanzar | `slow-suites` verde | STR-09 |

La emisión a una plataforma real **no se prueba** en FASE 2 (sin claves reales); queda como P4 «prueba E2E documentada» (TD-066 reescrita).

## 8. Brechas

- No se miró producción, VM ni se ejecutó render/ffmpeg/tests. La emisión real de noviembre sólo es documental.
- Causa del color blanco (STR-05), crecimiento de memoria (STR-01) e imagen congelada (STR-02) requieren ejecución.
- Las cifras de coste del streamer (§1.9) no fueron reverificadas por la revisión técnica (RT §8).
- No se revisaron una a una las 14 operaciones de streaming de admin (RT §8).
