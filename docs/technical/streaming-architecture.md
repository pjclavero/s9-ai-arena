# STREAMING_ARCHITECTURE: arquitectura del streamer real

## Resumen

Este documento describe cómo sale una batalla de S9 AI Arena en directo hacia una ingesta RTMPS
(YouTube u otra). Está comprobado contra el código de la rama `equipo5/streamer-real`, que parte de
`main` `0abd3eb` (incluye #227), y no contra documentos anteriores. Cada afirmación lleva el fichero
donde se puede comprobar.

El streaming **web** (vista `/broadcast` y canal de espectador) ya funcionaba y no cambia. Lo que
cierra este documento es el **streamer**: el servicio que convierte esa vista en vídeo y lo publica.

Documentos relacionados:

- Decisión de diseño: [ADR-023](../adr/ADR-023-streaming-rele-rtmp-y-credenciales-selladas.md).
- Operación: [streaming.md](../operations/streaming.md), que incluye el despliegue, la rotación, el
  backup, el rollback y el diagnóstico.

## Índice

- [Flujo completo](#flujo-completo)
- [Piezas](#piezas)
- [Protocolo de control](#protocolo-de-control)
- [Estados](#estados)
- [Arranque (START)](#arranque-start)
- [Parada (STOP)](#parada-stop)
- [Errores, crash y recuperación](#errores-crash-y-recuperación)
- [Reconciliador](#reconciliador)
- [Concurrencia](#concurrencia)
- [Vídeo: fuente, ffmpeg y perfil](#vídeo-fuente-ffmpeg-y-perfil)
- [Audio](#audio)
- [RTMPS y claves](#rtmps-y-claves)
- [Secretos](#secretos)
- [Logs, métricas y healthchecks](#logs-métricas-y-healthchecks)
- [Servicio y aislamiento (Compose)](#servicio-y-aislamiento-compose)
- [CI](#ci)
- [Qué existe y qué falta](#qué-existe-y-qué-falta)
- [Verificación](#verificación)

## Flujo completo

```
batalla (motor, tournament-worker)
  └─ snapshots públicos ─► SpectateGateway (WebSocket, ticket de un solo uso, retardo del ruleset)
                              └─► vista /broadcast (SPA, anónima, 1920×1080, sin controles)
                                    └─ pintada por Chromium en kiosco sobre un Xvfb (:99)
                                          └─ ffmpeg x11grab (+ silencio anullsrc) ─► x264 + AAC ─► FLV por el fd 3
                                                └─ relé RTMP en Node (RtmpPublisher) ─► RTMPS con TLS verificado
                                                      └─► ingesta (YouTube: rtmps://a.rtmps.youtube.com/live2)

operador (admin) ─► web: Administración → Streaming ─► API /admin/streaming/* (RBAC admin, BD, auditoría)
                        └─ POST /control/start {plan + credencial SELLADA} ─► API interna del streamer
                           (red platform, x-streamer-auth, nunca publicada)
```

El streamer es **un espectador más**: no abre ningún canal hacia el motor ni hacia la BD. Carga
`/broadcast` como cualquier navegador y empuja el vídeo hacia fuera (`apps/streamer/src/supervisor.ts`,
cabecera). No tiene lógica de juego.

## Piezas

| Pieza | Fichero | Responsabilidad |
|---|---|---|
| Vista `/broadcast` | `apps/web/src/pages/BroadcastPage.tsx`, `apps/web/src/broadcast/` | composición 1920×1080, HUD, director (espera, directo, intermedio, final) |
| Canal de espectador | `apps/api/src/spectate/gateway.ts` | snapshots públicos con el retardo del ruleset |
| Pantalla de administración | `apps/web/src/pages/StreamingPage.tsx` | estado, destino, configuración, credenciales (sólo `****ABCD`), Start/Stop/Reiniciar |
| API de administración | `apps/api/src/routes/streaming.ts`, `apps/api/src/services/streaming.ts` | RBAC admin, configuración, sellado, sesiones en BD, cerrojo, compensación, reconciliador, retención |
| Cliente del control | `apps/api/src/services/streamer-client.ts` | HTTP con `x-streamer-auth` (secreto releído en cada llamada), plazo de 10 s |
| Entrypoint del streamer | `apps/streamer/src/main.ts`, `infrastructure/docker/streamer/entrypoint.sh` | Xvfb, API de control, spawner real, apagado ordenado |
| Supervisor | `apps/streamer/src/supervisor.ts` | lanza Chromium y ffmpeg, reintentos, SIGTERM→SIGKILL, contadores |
| Control interno | `apps/streamer/src/control.ts` | `/control/start`, `/control/stop`, `/control/test`, `/status`, `/metrics`, `/healthz`, `/version`, grabaciones |
| Plan de sesión | `apps/streamer/src/session.ts` | valida la orden (SSRF de `/broadcast`, rangos, NVENC confirmado, credencial sellada) |
| Línea de ffmpeg | `apps/streamer/src/ffmpeg.ts` | argumentos de Chromium y ffmpeg (sin destino ni clave) |
| Relé RTMP | `apps/streamer/src/rtmp/publisher.ts` | handshake, connect/publish, chunking, TLS verificado, plazos |
| Credenciales selladas | `packages/stream-secrets/` | RSA-OAEP-256 + AES-256-GCM, sobre atado a plataforma + ingesta |
| Métricas | `apps/streamer/src/metrics.ts`, `apps/api/src/metrics.ts` | Prometheus a mano (sin librería nueva) |
| Alertas | `infrastructure/observability/prometheus/alerts.yml` (grupo `s9-streamer`) | `StreamerDown`, `RestartLoop`, `DroppedFramesHigh`, `NoProgress` |

## Protocolo de control

API HTTP interna del streamer en el puerto 8090 de la red `platform`. No se publica. Si existe
`STREAMER_CONTROL_SECRET_FILE`, todo menos `/metrics`, `/healthz` y `/version` exige `x-streamer-auth`,
comparado en tiempo constante. Si ese fichero no se puede leer, la API falla en cerrado: 401 y
`/healthz` 503 (`control.ts`).

| Llamada | Efecto |
|---|---|
| `POST /control/start` | valida el plan, abre la credencial sellada y arranca. Con la misma sesión ya activa es idempotente. Si hay otra activa sin `replace` responde **409** `already_active` |
| `POST /control/stop` | para la emisión y es idempotente (`wasActive`). Con `{ifSession}` sólo para si la emisión es **esa** sesión; si no, responde **409** `session_mismatch` (#241, R4-1) |
| `POST /control/test` | TLS, handshake y connect sin publicar, con un plazo total de 15 s |
| `GET /status` | estado, sesión, destino redactado, `lastError` redactado, relé, estadísticas, contadores y `pendingChildren`; **nunca** la clave |
| `GET /metrics` | Prometheus |
| `GET /healthz` | 200 o 503 (secreto de control ilegible) |

## Estados

**Streamer** (`SupervisorState`, `supervisor.ts`): `idle` → `streaming` ⇄ `retrying` → `failed`;
`stop()` lleva a `stopped` desde cualquier estado. `streaming` se fija al lanzar los procesos. El
directo de verdad lo indica el relé (`relay.state === "publishing"`).

**Pantalla** (`uxState`, `routes/streaming.ts`), derivado y sin duplicar estados:

| uxState | Condición |
|---|---|
| `disabled` | streaming desactivado |
| `streamer_unreachable` | el streamer no responde |
| `ready` | sin sesión y el streamer no emite |
| `starting` | el streamer está en `streaming` y el relé aún no publica |
| `live` | el relé publica (sólo entonces es LIVE, no al hacer spawn) |
| `recording` | modo `record` emitiendo |
| `retrying` | reconectando |
| `failed` | reintentos agotados |
| `interrupted` | la BD tiene una sesión activa y el streamer no emite |

**Sesión** (tabla `streaming_sessions`, migración 017): `active`, `stopped` o `failed`, con
`started_at`, `stopped_at` y `stop_reason`. `GET /admin/streaming` devuelve la sesión activa y, desde
la versión 0.14.0 del contrato, `lastSession` (la última terminada: id, modo, destino, `startedAt`,
`stoppedAt`, `stopReason`). Los campos mínimos del encargo se corresponden así:

| Campo del encargo | Dónde está |
|---|---|
| streamId | `session.id` y `lastSession.id` |
| battleId | `target.{kind,id}` |
| status | `uxState` y `streamer.state` |
| startedAt / stoppedAt | `session.startedAt`, `lastSession.stoppedAt` |
| lastError | `streamer.lastError` (redactado y truncado a 300) |
| tipo de destino | `settings.mode` y `settings.platform`; el destino sin clave es `streamer.target` |

Ninguno contiene la clave, la credencial ni la línea de ffmpeg con secretos (ffmpeg no los tiene).

## Arranque (START)

1. **RBAC:** la operación `startStreaming` tiene `x-min-role: admin` en el contrato.
2. **Comprobación previa, fuera del cerrojo:** el streaming tiene que estar activado, el destino
   tiene que existir (404) y debe ser público (`target_not_public`). En modo grabación se mide además
   el disco (`disk_unknown` / `disk_low`).
3. **Dentro del cerrojo:** se relee la configuración. Si hay una sesión activa **y el streamer
   responde sin emitir** (reintentos agotados o streamer reiniciado), esa sesión se cierra como
   `failed` (`not_emitting`, auditado como `streaming.session.recovered`) y se arranca de nuevo. Si
   la sesión es la misma con la misma configuración, la respuesta es idempotente; si es otra, `409
   already_active`.
4. Se valida la credencial: `credential_missing`, `credential_stale` o `credential_unbound`.
5. Se **inserta la sesión antes** de llamar al streamer y se manda `POST /control/start` con el sobre
   sellado.
6. El streamer valida el plan por su cuenta y abre el sobre sólo si plataforma e ingesta coinciden.
   Lanza Chromium y ffmpeg. El relé publica cuando la ingesta acepta `publish`.
7. **Recomprobación:** si mientras tanto se pidió un stop o se desactivó el streaming, se para
   (`stopIfCancelled`).
8. Si no hay respuesta o llega un 5xx, se manda un stop **compensatorio** condicionado a esta sesión.

## Parada (STOP)

- **API:** marca la sesión `stopped` en BD **antes** de llamar al streamer, dentro del cerrojo. Es
  idempotente (`wasActive: false`). Si el streamer no responde, la sesión queda parada y la API
  responde 503 `streamer_unavailable`, salvo con `force`.
- **Streamer:** cierra el relé y manda SIGTERM al **árbol** de ffmpeg y al de Chromium, es decir,
  al proceso y a todos sus descendientes (zygote, GPU, renderers). El árbol se lee de `/proc` por
  ppid y cada pid se guarda con su instante de arranque, para no señalar un pid reutilizado. Pasada la
  gracia de 5 s (`STOP_GRACE_MS`), vuelve a leer el árbol, manda SIGKILL a lo que siga vivo y lo
  cuenta en `stream_killed_total`. Los hijos **siguen en el grupo de procesos del servicio**, así que
  si el servicio muere de golpe, su grupo se los lleva. Un primer intento con `detached` los sacaba
  del grupo, y lo detectó `packages/test-process/no-orphans.test.ts` en la CI. Un stop
  repetido no rompe nada. No hay ficheros temporales ni locks propios. En modo grabación, ffmpeg cierra
  el MP4 al recibir SIGTERM.
- **Contenedor:** `init: true` (tini) recoge los descendientes que se salen del árbol, como los
  `chrome_crashpad_handler` que se re-parentan a PID 1. Al recibir SIGTERM, el proceso espera hasta
  6 s a que los hijos salgan.

## Errores, crash y recuperación

| Caso | Qué pasa | Estado final |
|---|---|---|
| ffmpeg muere | `exit` → reintento (3 s, hasta 20 seguidos; un tramo publicando reinicia el contador) | `streaming` otra vez, o `failed` |
| Se cae la conexión RTMP | `error` del relé → reintento | igual |
| La ingesta rechaza la clave | `publish` rechazado → `error` → reintento → `failed`, con `lastError` redactado | `failed` |
| Desaparece el input (Chromium muere) | `exit` de Chromium → reintento de los dos procesos | igual |
| Se reinicia la API | sesión en BD intacta, el reconciliador sigue en marcha, el streamer sigue emitiendo | `live` |
| Se reinicia el streamer | streamer en `idle`, BD activa → `interrupted`; **START vuelve a emitir** | `live` |

Nunca queda `streaming` sin proceso: todo `exit` o `error` de la generación vigente lleva a
`retrying` o a `failed`. Desde `failed` se puede volver a hacer START, y también Reiniciar o Detener.

## Reconciliador

`startOrphanReconciler` (`routes/streaming.ts`) se arranca sólo en `server.ts`, cada 30 s, y no se
arma si no hay `STREAMER_CONTROL_URL`. En cada tick hace **un** `GET /status`. Si el streamer no
emite, no consulta la BD. Los ticks no se solapan.

Una emisión es **huérfana** si el streamer emite y la BD no tiene ninguna sesión activa, o tiene otra.
Ante una huérfana:

1. Lee `/status`, después la BD y **vuelve a leer `/status`** (#241, R4-1). Si la segunda foto ya no
   coincide con la primera, no hace nada.
2. Manda el stop **condicionado** (`ifSession`). Si entretanto el streamer pasó a otra sesión,
   responde 409 y no se para nada.
3. Audita `streaming.session.orphan_stopped`. Si el stop falla, la auditoría se hace **una vez por
   emisión**, no en cada tick.

Con `STREAM_AUTOSTART=1` (modo heredado sin sesión) el reconciliador para esa emisión en ≤ 30 s. Es el
comportamiento esperado: una emisión sin sesión no es gobernable desde la web.

## Concurrencia

Sólo cabe **una** emisión, por tres vías:

- el índice único parcial sobre `streaming_sessions(state='active')`, migración 017;
- el 409 del streamer;
- el cerrojo por proceso de la API.

Un segundo START con otro destino responde **409 `already_active`** y no toca la emisión en curso.
Entre varias instancias de la API, el orden «marcar la BD y después llamar al streamer» y las
recomprobaciones cubren las carreras (ADR-023). El Compose despliega una sola réplica.

## Vídeo: fuente, ffmpeg y perfil

- **Fuente:** Chromium **no headless** en kiosco, `--app=<broadcastUrl>`, sobre un Xvfb de
  1920×1080×24, con WebGL por **SwiftShader** (render por software, sin GPU). ffmpeg captura el
  framebuffer con `x11grab -draw_mouse 0`. No depende de ninguna sesión gráfica humana.
- **Codificación** (`ffmpeg.ts`): `libx264 -preset veryfast -tune zerolatency`, `-b:v` = `-maxrate` =
  bitrate configurado, `-bufsize` = 2× el bitrate, `yuv420p`, GOP = 2 × FPS (un keyframe cada 2 s,
  como pide YouTube) y AAC a 128 kbit/s. El preset 720p escala con `scale=…:flags=bicubic`. NVENC
  sólo se usa si el runtime lo confirma codificando un frame, y la imagen Alpine no lo incluye.
- **Salida:** `-f flv pipe:3`. ffmpeg **no conoce** ni el destino ni la clave. Usa `-loglevel error`
  y `-progress pipe:1` para las métricas.
- **Reconexión:** no se usa el `-reconnect` de ffmpeg. Reconecta el supervisor (ver la tabla de
  errores).
- **Perfil por defecto:** 1080p30 a 4500 kbit/s, con 720p y 60 FPS opcionales y un rango de
  1000-12000 kbit/s. Las medidas reales de CPU, memoria y ancho de banda están en
  [streaming.md](../operations/streaming.md#recursos-medidos).

## Audio

La vista `/broadcast` no produce audio que capturar: x11grab sólo graba vídeo. YouTube exige una
pista de audio, así que se añade **silencio** con `anullsrc` (estéreo, 44,1 kHz, AAC a 128 kbit/s).
Es una decisión deliberada. No hay audio sintético ni música, y no se añadirá audio del juego sin un
diseño propio de captura.

## RTMPS y claves

- **Destino:** por defecto `rtmps://a.rtmps.youtube.com/live2`, el endpoint oficial. `rtmp://` en claro
  se rechaza salvo `STREAMER_ALLOW_PLAIN_RTMP=1`, que sólo se usa en pruebas locales. El TLS se
  verifica contra el almacén del sistema (o contra `NODE_EXTRA_CA_CERTS` en la CA local del E2E).
- **Clave:** llega **sellada** en cada orden de arranque y se abre en memoria con la privada. La forma
  heredada (`STREAM_KEY_FILE`) se lee en el momento de cada START y sólo hacia la ingesta del propio
  despliegue.
- **Dónde no está la clave:** no está en argv, en el entorno, en logs, en `/status`, en `/metrics`,
  en la BD en claro, en el navegador, en los replays ni en la CI. En la BD sólo se guardan el sobre y
  `last4`.

## Secretos

| Secreto (fichero en `infrastructure/secrets/`) | Lo monta | Para qué |
|---|---|---|
| `streamer_control_secret.txt` | api, streamer | autenticación de la API interna de control |
| `stream_secrets_public.pem` | api | sellar las claves que entran por la web |
| `stream_secrets_private.pem` | streamer | abrir los sobres |
| `stream_key.txt` (heredado, opcional) | streamer | clave fija de despliegue |

Los genera `infrastructure/scripts/init-secrets.sh`. Su dueño es el uid 1000, con modo 0400, y se
montan como secretos de Compose (bind mount de fichero). Ningún otro servicio los monta y no están en
la imagen. `docker inspect` sólo muestra las **rutas**. Los tres primeros se releen en cada uso, de
modo que se pueden rotar sin reconstruir. Entran en el backup restic junto con
`infrastructure/secrets/` (límite declarado en ADR-023: la privada va con el volcado de la BD). La
rotación, el backup y el restore se describen en [streaming.md](../operations/streaming.md).

## Logs, métricas y healthchecks

- **Logs:** una línea JSON por evento. Se registran: `emisión arrancada` (con `sessionId`), `emisión
  parada por control`, `ffmpeg lanzado` (argv sin secretos), `ffmpeg terminó`, `relé RTMP publicando`,
  `relé RTMP: corte de la ingesta`, `reintento de emisión`, `emisión abandonada: reintentos agotados`
  y `proceso sin salir tras SIGTERM: SIGKILL`. La redacción se aplica **a cada valor** antes de
  serializar (#241, R4-3), así que cada línea sigue siendo JSON válido. Cubre la clave y cualquier
  fragmento suyo de 8 o más caracteres, en claro, base64 o hex, con plegado de mayúsculas que conserva
  la longitud (`İ`).
- **Métricas del streamer:** `streamer_*` (EQ5b) y los nombres del encargo, añadidos en el mismo
  endpoint: `stream_active`, `stream_start_total`, `stream_stop_total`, `stream_failures_total`,
  `stream_reconnects_total`, `stream_uptime_seconds`, `stream_frames_total`,
  `stream_dropped_frames_total` y `stream_killed_total`.
- **Métricas de la API:** `s9_streaming_enabled` y `s9_streaming_session_active`.
- **Healthcheck del contenedor:** `wget http://localhost:8090/healthz` cada 30 s. El estado de la
  emisión se vigila con las alertas, no con el healthcheck: una emisión `failed` no reinicia el
  contenedor.

## Servicio y aislamiento (Compose)

El servicio `streamer` (perfil `streaming`) es un **contenedor permanente** y los procesos se lanzan
bajo demanda:

- `restart: unless-stopped`, healthcheck y logging con rotación (`*default-logging`);
- límites: 4 CPU, 4 GiB y 512 pids;
- `init: true`;
- `cap_drop: [ALL]` y `cap_add: [CHOWN, SETUID, SETGID]`. Esas tres capacidades sólo las usa el
  entrypoint de datos, como root y durante un instante, para el `chown` del volumen y el `su-exec`.
  Después el proceso corre como uid 1000 con `CapEff` vacío (medido) y `no-new-privileges`;
- redes `platform` (para `web`, el control desde la API y el scrape de Prometheus) y `public`, sin
  puertos, sólo para la salida RTMPS. **No** está en `data`, así que no alcanza la BD;
- sin `docker.sock` y sin rutas del host. El único volumen es `arena_replays`, para el modo grabación;
- sólo sus secretos.

No usa `read_only`: Chromium escribe su perfil en `$HOME` y Xvfb su socket en `/tmp`. Hacerlo exigiría
`tmpfs` con el uid correcto, y queda como deuda declarada.

## CI

La CI no depende de YouTube. Corren en la CI los tests unitarios y de integración del streamer
(`apps/streamer/**`, incluidos los de procesos reales y el de ffmpeg real) y de la API (`eq5*`,
`eq6*`, `r3*` y `streamer-real.test.ts`, contra PostgreSQL embebido). También se construye la imagen
del streamer, con una prueba viva dentro del build, y se comprueban las alertas con promtool. El E2E
con MediaMTX (`tests/streaming-e2e/e2e.sh`) y la medición (`tests/streaming-e2e/measure.sh`) son
locales.

## Qué existe y qué falta

Auditoría frente a las 39 secciones del encargo STREAMER (2026-11-06). **Existía** quiere decir en
`main` `0abd3eb`; **Esta rama** recoge lo que se añade aquí.

| § | Existía | Esta rama |
|---|---|---|
| 1 Auditoría | documentos dispersos | este documento |
| 2 Responsabilidades | supervisor sin lógica de juego | — |
| 3 Estados | estados del streamer, `uxState` y sesión en BD | `lastSession` con `stoppedAt`/`stopReason`; `starting` declarado en el contrato (0.14.0) |
| 4 Concurrencia | una sola emisión: índice único + 409 | equivalencia con `STREAM_ALREADY_ACTIVE` y test |
| 5 YouTube | RTMPS oficial, clave sellada | BLOCKED: no hay clave autorizada |
| 6 Secretos | 3 secretos, cada uno montado sólo donde hace falta | tabla y operación unificadas |
| 7 Redacción | n-gramas, base64/hex, `İ` | **R4-3**: redacción por valor; el JSON no se rompe |
| 8 ffmpeg | x264, CBR, GOP de 2 s, AAC, fd 3 | documentado; parada con SIGKILL |
| 9 Perfil | 1080p30 4500k | medido (ver streaming.md) |
| 10 Audio | `anullsrc` | decisión documentada |
| 11 START | RBAC, destino público, credencial atada, LIVE sólo con el relé publicando | **recuperación**: START tras FAILED o tras reiniciar el streamer |
| 12 STOP | idempotente, sólo SIGTERM | SIGTERM → 5 s → SIGKILL al **árbol** de procesos |
| 13 Crash | reintentos → `failed` | re-START (RESTART_RECOVERY), probado con ffmpeg real y SIGKILL |
| 14 Reconciliador | 30 s, foto del streamer y luego la BD | **R4-1**: doble lectura, stop condicionado, auditoría sin bucle, sin solapes |
| 15 Servicio | healthcheck, restart, límites | `pids` e `init` |
| 16 Aislamiento | sin socket ni BD, `no-new-privileges` | `cap_drop: [ALL]` + 3 capacidades; `CapEff` 0 medido |
| 17 Errores | códigos propios | tabla de equivalencias STREAM_* y test |
| 18 UI | estado, destino, inicio, error, Start/Stop | sin cambios |
| 19-20 Fuente / Chromium | Xvfb + Chromium | prueba de huérfanos (unitaria con procesos reales y en contenedor) |
| 21 Calidad | MP4 verificado (EQ5b) | fotogramas, `blackdetect` y `freezedetect` |
| 22/32 Destino seguro / E2E | E2E con MediaMTX | medición sostenida reproducible (`measure.sh`) |
| 24-26 BW/CPU/RSS | sin medir | medidos |
| 27 Logs | líneas útiles | test de logs útiles y JSON válido |
| 28 Métricas | `streamer_*` | `stream_*` |
| 29 Backup | restic | permisos verificados tras restore local |
| 30 Rotación | relectura de ficheros | documentada y probada |
| 31 Tests | la mayoría | ver la tabla en streaming.md |
| 34/35/37 Docs, rollback y despliegue | runbook | plan de despliegue y rollback (sin ejecutar) |
| R4-2 | `rollbackNamed` admitía cualquier migración | lista cerrada 016/017/018 |

## Verificación

| Afirmación | Dónde |
|---|---|
| ffmpeg sin destino ni clave | `apps/streamer/src/ffmpeg.ts` (`pipe:3`), `apps/streamer/tests/secret-surfaces.test.ts` |
| Stop condicionado | `apps/streamer/src/control.ts` (`ifSession`), `apps/streamer/src/streamer-real.test.ts` |
| Doble lectura del reconciliador | `apps/api/src/routes/streaming.ts` (`reconcileOrphanEmission`), `apps/api/src/streamer-real.test.ts` |
| SIGKILL al árbol y ningún huérfano | `apps/streamer/src/supervisor.ts` (`terminate`, `processTree`), `apps/streamer/src/main.ts` (`realSpawner`), `streamer-real.test.ts`, `packages/test-process/no-orphans.test.ts` |
| Log con JSON válido | `apps/streamer/src/config.ts` (`createLogger`), `streamer-real.test.ts` |
| Lista cerrada de migraciones | `apps/api/src/db/migrations.ts` (`NAMED_ROLLBACK_ALLOWED`) |
| Aislamiento | `infrastructure/docker-compose.yml` (servicio `streamer`), `tests/streaming-e2e/measure.sh` (`hardening.txt`) |
