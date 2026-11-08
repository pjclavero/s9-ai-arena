# Retransmisión: `/broadcast`, streamer y RTMPS

## Resumen

Estado **verificado** de la retransmisión de S9 AI Arena (auditoría EQ5,
2026-11-02, sobre `main` `a1a6c4e` y la rama `equipo5/streaming`). Distingue lo
**implementado** de lo **verificado**, y lo verificado en un entorno **local
aislado** de lo verificado en **producción** (nada de esto último: la
producción no ejecuta el streamer). Sustituye como runbook vigente al de E11,
que se conserva en [history/operaciones/streaming-runbook.md](../history/operaciones/streaming-runbook.md).

**Actualización EQ5b (2026-11-02, rama `equipo5/streaming-admin`, PR #227):** la
retransmisión se administra desde la web (**Administración → Streaming**), la clave de
emisión **ya no va al argv de FFmpeg** (relé RTMP en el propio streamer) y se guarda
**sellada** (la API no puede descifrarla). Decisión en
[ADR-023](../adr/ADR-023-streaming-rele-rtmp-y-credenciales-selladas.md). Ver
[Administración desde la web](#administración-desde-la-web).

**Actualización STREAMER (2026-11-06, rama `equipo5/streamer-real`):** cierre del streamer para
producción. Corrige los P3 de #241 (R4-1 reconciliador, R4-2 `rollback:name`, R4-3 JSON del log) y
añade: parada con SIGKILL al árbol de procesos (sin Chromium huérfanos), START tras una emisión
abandonada o un reinicio del streamer, `lastSession`, métricas `stream_*` y aislamiento del servicio
(`cap_drop: ALL`, `init`, `pids`, `shm_size`). Incluye recursos medidos, rotación, backup/restore y el
plan de despliegue y rollback. La arquitectura comprobada contra el código está en
[streaming-architecture.md](../technical/streaming-architecture.md). YouTube real:
**BLOCKED_BY_AUTHORIZATION**.

**STREAMER-2 (2026-11-06, misma rama):** tres P3 de la revisión independiente. **H1:** la salida
de Chromium se lee siempre (antes nadie la leía y Chromium podía quedarse bloqueado con la imagen
congelada). **H2:** `lastError` conserva la causa raíz cuando la ingesta rechaza la clave. **H3:**
el perfil es **VBR con techo** (no CBR), los frames descartados son los medidos (no 0) y no todas
las líneas del log del contenedor son JSON (Xvfb escribe una). Ver
[Recursos medidos](#recursos-medidos) y la tabla de defectos (STR-7 y STR-8).

## Índice

- [Administración desde la web](#administración-desde-la-web)
- [Seguridad de la clave de emisión](#seguridad-de-la-clave-de-emisión)
- [Alertas](#alertas)
- [Piezas](#piezas)
- [Cronología](#cronología)
- [Estado verificado](#estado-verificado)
- [Requisitos para emitir de verdad](#requisitos-para-emitir-de-verdad)
- [Operación](#operación)
- [Errores estables](#errores-estables)
- [Recursos medidos](#recursos-medidos)
- [Secretos: custodia, rotación, backup y restore](#secretos-custodia-rotación-backup-y-restore)
- [Despliegue del perfil `streaming` (plan, NO ejecutado)](#despliegue-del-perfil-streaming-plan-no-ejecutado)
- [Rollback del perfil `streaming`](#rollback-del-perfil-streaming)
- [Diagnóstico](#diagnóstico)
- [Pruebas (§31)](#pruebas-31)
- [Defectos y limitaciones conocidos](#defectos-y-limitaciones-conocidos)
- [Cómo se verificó](#cómo-se-verificó)

## Administración desde la web

Pantalla **Administración → Streaming** (`#/streaming`, sólo `admin`; el RBAC lo aplica la
API: 12 operaciones `x-min-role: admin` del contrato 0.13.0, tag `streaming`). Ayuda offline en
**Ayuda → Administración: Streaming**. Uso normal sin SSH, `.env` ni Compose.

| Sección | Qué hace |
|---|---|
| Estado | `uxState`: desactivado, listo, iniciando (relé aún sin publicar), en directo (sólo con el relé publicando), grabando, reconectando, abandonada, interrumpida, servicio no disponible; avisos de «pendiente de reinicio» y de almacén sellado ausente |
| Monitorización | estado del streamer, destino (sin clave), FPS y bitrate reales, frames y descartes, reintentos, relé, grabación en curso y último error redactado (sondeo cada 3 s) |
| Destino y controles | batalla o torneo (los botones **«Retransmitir»** del detalle abren esta pantalla con el destino puesto y **no emiten**); retardo del directo LEÍDO de la copia de reglas; probar (TLS + handshake, sin publicar), iniciar/detener emisión o grabación, reiniciar |
| Configuración | activado, modo `rtmps`/`record`, plataforma (YouTube o RTMPS personalizado; catálogo extensible en `services/streaming.ts`), x264/NVENC (NVENC sólo si el runtime lo confirma codificando un frame), 1080p/720p, 30/60 FPS (60 pide confirmación), bitrate 1000-12000 kbit/s con recomendación |
| Credenciales | por plataforma: «configurada (****ABCD)» o «no configurada»; cambiar y eliminar. La clave nunca vuelve al navegador |
| Branding | nombre, logo (https:// o ruta propia) y colores #hex validados; vista previa = la propia `/broadcast` en su pantalla de espera |
| Grabaciones y retención | carpeta lógica `arena_replays/video`, número, tamaño y espacio libre; retención por edad (7/14/30 días o personalizada) y tamaño total; simular y aplicar; automática cada hora si se activa |
| Auditoría | acciones `streaming.*` de `audit_log` (sólo inserción), sin la clave |

Reglas de operación:

- **Una sola emisión a la vez** (índice único en BD + 409 del streamer). Iniciar el mismo
  destino con la misma configuración es idempotente; detener también.
- **Cambios con emisión activa** (§20): la retención se aplica al momento; modo, plataforma,
  ingesta, codificación, branding y clave **se aplican al pulsar «Reiniciar emisión»** (nunca
  en silencio); desactivar el streaming **detiene** la emisión y pide confirmación.
- **La clave queda atada a su ingesta**: en «RTMPS personalizado» guarda primero la URL de
  ingesta y después la clave. Si cambias la URL, la clave deja de valer («guardada para otra
  URL de ingesta») y hay que volver a introducirla; iniciar o probar responden
  `credential_unbound` sin emitir.
- La URL de ingesta personalizada tiene que ser un host público: se rechazan nombres
  internos (servicios del Compose, `localhost`, `.local`, `.internal`…), loopback, redes
  privadas, link-local e IPv4 no canónica.
- Iniciar, reiniciar y detener se ejecutan en serie: «Detener» pulsado mientras arranca
  espera a que termine el arranque y lo para. No se empieza a grabar si el streamer no puede
  medir el disco (`disk_unknown`) o quedan menos de 2 GiB (`disk_low`).
- `/broadcast` es anónima y hace falta el directo público activado. Se emite lo que un visitante
  puede leer (`wherePubliclyShowable`, `apps/api/src/replay-access.ts`): batallas sin bots no públicos
  y **todas** las batallas de un torneo creado con `broadcast: true`, con la proyección de
  competición de sus bots privados o de equipo (nombre, versión, bando; nunca dueño, código ni
  diagnóstico). Emitir no cambia ninguna visibilidad. Motivos de rechazo (antes `target_not_public`):
  `battle_not_public` para una batalla suelta con bots no públicos (no hay flag por batalla, porque sólo
  un torneo anuncia la retransmisión antes de la inscripción) y `tournament_not_broadcastable` para una
  batalla de un torneo sin `broadcast` con bots no públicos. Un torneo sin `broadcast` se puede emitir
  igual que antes: el director sólo muestra sus batallas sin bots no públicos. `GET
  /admin/streaming/target` devuelve `broadcastable`, `broadcastBlockedReason` y `tournamentBroadcast`;
  `publicBroadcastable` se mantiene como alias obsoleto.
- Despliegue: el perfil `streaming` sigue fuera del contrato de producción. Para usar la
  pantalla hace falta el servicio `streamer` y los secretos nuevos de `init-secrets.sh`
  (`streamer_control_secret`, `stream_secrets_private`/`stream_secrets_public`). Sin streamer
  la pantalla dice «Servicio de emisión no disponible».

## Seguridad de la clave de emisión

| Superficie | Cómo se protege | Evidencia |
|---|---|---|
| argv de FFmpeg (`ps`, `docker top`, `/proc/*/cmdline`) | ffmpeg escribe FLV por el fd 3; el relé Node publica con la clave | `apps/streamer/tests/secret-surfaces.test.ts` (calibrada: roja en main, verde aquí); auditoría con la imagen real: 0 apariciones |
| `/proc/*/environ`, `docker inspect` | la clave nunca va al entorno; sólo rutas de ficheros | idem |
| logs y `/status` | logger con registro vivo de secretos: la clave escapada en JSON, URL-codificada, sin distinguir mayúsculas y, desde EQ5d, **cualquier fragmento de ≥ 8 caracteres** de la clave, de su base64 (estándar/URL-safe) o de su hex, y desde EQ5e con un plegado de mayúsculas que no cambia la longitud (U+0130 «İ» ya no desplaza la marca); el relé redacta igual lo que diga el servidor. Puede sobre-redactar una palabra común contenida en la clave (`"service":"***"`). Límites en ADR-023 | tests del logger y del relé (`eq5d-correcciones.test.ts`, ingesta hostil con eco base64/hex en `eq6c-relay-break.test.ts`); `docker logs` 0 apariciones |
| `/status`, `/metrics` | destino descrito como `rtmps://host:puerto/app/***` | idem |
| API y frontend | entra por `PUT /admin/streaming/credentials/{platform}` y nunca sale (`****ABCD`); campo password, estado vaciado al enviar, nada en `localStorage`/`sessionStorage` | `apps/api/src/eq5b-streaming-admin.test.ts`, `apps/web/tests/eq5b-streaming-page.test.tsx`, spec de navegador `@streaming-e2e` (respuestas de red, DOM y storage) |
| BD | sobre v2 (AES-256-GCM con etiqueta de **16 bytes exactos** + RSA-OAEP-256 con la PÚBLICA) **atado a plataforma e ingesta**; la privada sólo la tiene el streamer, que registra cada sobre rechazado | volcado de todas las tablas de streaming y `audit_log` sin la clave; el sobre sólo se abre con la privada y hacia su destino |
| redirección de la clave | el streamer sólo abre el sobre si `platform` e `ingestUrl` de la orden casan con las selladas; la clave heredada sólo va a la ingesta del despliegue | `apps/streamer/src/eq6b-relay-break.test.ts`, `apps/streamer/src/eq5c-correcciones.test.ts` |
| red | TLS con certificado VERIFICADO (FFmpeg no verificaba); `rtmp://` en claro rechazado | `publisher.test.ts`, E2E contra MediaMTX con CA local |
| API interna del streamer | secreto compartido `x-streamer-auth`; **en cerrado** si el fichero está definido y no se puede leer (401 en todo, `/healthz` 503) | `control.ts` (401 sin cabecera), `eq6b-relay-break.test.ts` (proceso real con el secreto ilegible) |

Límite declarado (backup): el repositorio restic guarda `infrastructure/secrets/` (con la
privada `stream_secrets_private.pem`) y el volcado de la BD (con los sobres) en el mismo
repositorio y con la misma contraseña: quien tenga ambos puede abrir las claves de emisión
(ver ADR-023 § «Límites conocidos»).

Límite declarado: un proceso con el mismo uid que el streamer **dentro** del contenedor podría
leer su memoria (`/proc/<pid>/mem`) o la clave privada montada; el contenedor no ejecuta nada
más que Xvfb, Chromium y FFmpeg (sin privilegios, `no-new-privileges`).

## Alertas

Grupo `s9-streamer` de `infrastructure/observability/prometheus/alerts.yml`, todas
condicionadas a emisión pedida o streaming activado (con el streaming desactivado **no** salta
ninguna). Probadas con promtool (`alerts-streamer.test.yml`, paso del job `contracts` de la CI;
un mutante sin las guardas falla las 4).

| Alerta | Condición | Señales |
|---|---|---|
| `StreamerDown` | sesión activa y streaming activado en la API, y el streamer no emite (o ni existe) durante 2 min | `s9_streaming_session_active`, `s9_streaming_enabled` (API, con `S9_METRICS_ENABLED`), `streamer_up` |
| `StreamerRestartLoop` | más de 5 reintentos en 10 min | `streamer_restarts_total`, `streamer_desired` |
| `StreamerDroppedFramesHigh` | más del 5 % de frames descartados durante 5 min | `streamer_dropped_frames_total`, `streamer_frames_total` |
| `StreamerNoProgress` | más de 60 s sin progreso de ffmpeg | `streamer_progress_age_seconds` |

## Piezas

| Pieza | Dónde | Qué hace |
|---|---|---|
| Vista `/broadcast` | `apps/web/src/pages/BroadcastPage.tsx`, `apps/web/src/broadcast/` | composición 1920×1080 sin controles ni cursor: el MISMO visor y HUD que el visor en directo, branding por parámetros (`event`, `logo`, `primary`, `accent`, `poll`), `?battle=<id>` o `?tournament=<id>` |
| Director | `apps/web/src/broadcast/director.ts` | sondea la API **anónima** y decide la pantalla: espera, directo, intermedio, final |
| Canal de espectador | `apps/api/src/spectate/gateway.ts` | WebSocket con ticket de un solo uso; `/broadcast` es un espectador más (no toca el motor ni el tick) |
| Streamer | `apps/streamer/`, `infrastructure/docker/streamer/` | Xvfb + Chromium (kiosco, WebGL por SwiftShader) + FFmpeg `x11grab` → x264 → RTMPS o MP4; API interna de control |
| Servicio Compose | `streamer`, perfil `streaming` | **no** forma parte del perfil de producción ni de `servicios_esperados` de `infrastructure/deploy-contract.json` |

## Cronología

| Fecha | Hecho |
|---|---|
| 2026-07-16 | **E11**: `/broadcast` (T11.1) y servicio `streamer` con RTMPS a YouTube y modo grabación (T11.2). Sin navegador ni Docker en aquel entorno: todo lo «real» quedó [PENDIENTE] ([entrega](../history/entregas/entrega-E11.md)) |
| 2026-07-19 | Plan R14 (WebRTC) da «RTMP/YouTube/Twitch» por «fuera de alcance actual», sin contrastarlo con E11 |
| 2026-07-20 | [ADR-R14](../adr/ADR-R14-webrtc.md): no WebRTC P2P. Repite la frase sobre RTMP; ver su nota de corrección |
| 2026-11-02 | **EQ5**: primera ejecución real de la cadena completa en un entorno local; defectos corregidos en `equipo5/streaming`; este documento |

## Estado verificado

Leyenda: **PASS** con evidencia real · **FAIL** defecto real · **BLOCKED** no se
puede probar sin algo externo · **NOT TESTED** no se ha probado.

| Aspecto | Estado | Evidencia (entorno local aislado salvo indicación) |
|---|---|---|
| `/broadcast` a 1920×1080 sin controles ni cursor | PASS | Chromium real: escenario 1920×1080, sin desbordamiento, `cursor: none`, 0 controles visibles (el único elemento interactivo es el enlace «Saltar al contenido», oculto), 0 peticiones con `Authorization` |
| Mismo estado que el espectador | PASS | `/broadcast` usa el mismo `SpectatorClient` + gateway: marcador, reloj, equipos, vida y módulos llegan del snapshot público |
| Batalla suelta | PASS | espera → directo con HUD → final |
| Torneo (autodirector) | PASS **tras corregir 2 defectos** | espera → directo B1 → intermedio → directo B2 → final. En `main` el director (1) leía sólo las 100 últimas batallas de TODA la plataforma y (2) anunciaba «Torneo terminado» con batallas pendientes, porque un visitante no ve las programadas |
| Streamer: Xvfb + Chromium + FFmpeg x264 | PASS | imagen de `main` y de la rama, 1080p30, `libx264` veryfast/zerolatency, keyframe cada 2,0 s, ~28,5–30 fps, ~2,6 CPU y ~0,5 GB de RAM durante una batalla en directo |
| Audio silencioso para la ingesta | PASS | pista AAC LC estéreo 44,1 kHz, −91 dB |
| Modo grabación (MP4) | PASS | MP4 real: H.264 High 1920×1080 30 fps + AAC, 78,5 s, se decodifica entero sin errores; fichero `broadcast-<fecha>.mp4` de `streamer:streamer` 0644 en `arena_replays/video`. **Sin retención automática**: nada lo borra |
| RTMPS (handshake + ingesta) | PASS (local) | servidor RTMPS local con TLS: publicación aceptada, pistas H264 + MPEG-4 Audio, bytes recibidos crecientes |
| YouTube privado | BLOCKED | no hay clave ni canal de prueba facilitados por el operador |
| Recuperación ante corte de red de 30 s | PASS (local) | (a) servidor de ingesta congelado 30 s (`docker pause`): FFmpeg no muere, la conexión se reanuda sola; (b) servidor parado 30 s: 11 reintentos (`streamer_restarts_total=11`) y la emisión vuelve sola unos 10 s después de que vuelva el servidor. El motor no lo nota (step p99 0,67 ms, 1 tick > 50 ms en 4,5 min). Límite: con `STREAM_MAX_RETRIES=20` × 3 s, un corte de más de ~1 min deja el estado en `failed` sin reintentos posteriores y el healthcheck sigue sano |
| API de control (`/control/start`, `/control/stop`, `/status`, `/metrics`, `/healthz`, `/version`) | PASS | ejercida contra el contenedor real |
| Métricas Prometheus | PASS (configuración) | `/metrics` correcto; job `streamer` (`streamer:8090`) añadido a `prometheus.yml` con test que lo ata al puerto del Compose. No hay alerta sobre `streamer_up` (sólo el latido en cAdvisor). Raspado en un stack real: NOT TESTED |
| Clave fuera de logs, `/status`, `/metrics`, `docker inspect`, entorno, repo | PASS | 0 apariciones de una clave FALSA en cada superficie |
| Clave fuera del argv | **PASS** (EQ5b) | antes FAIL (`docker top` y el `ps` de cualquier usuario del host la mostraban). Ahora relé RTMP en el streamer: 0 apariciones en argv, `/proc`, entorno, logs, inspect, `/status`, `/metrics` con la imagen real emitiendo a una ingesta RTMPS local |
| Retardo anti-coaching | PARCIAL | el gateway retrasa el stream **y ahora también el `init`** (estado de `ahora - retardo` y el tramo pendiente a su hora; test `apps/api/src/spectate/delay-init.test.ts`). Pero **ningún ruleset del catálogo** declara `spectator.delaySeconds`: en la práctica el retardo es 0 (pendiente de reglas, EQ2) |
| Impacto en la batalla | PASS (local, con ruido) | ver [Cómo se verificó](#cómo-se-verificó) |
| OBS (Browser Source) | PASS (equivalente headless) / NOT TESTED (OBS real) | la URL de `/broadcast` carga a 1920×1080 sin controles en Chromium headless; no hay OBS en el entorno |
| NVENC | FAIL | el FFmpeg de la imagen (Alpine 3.20, 6.1.1) **no trae `h264_nvenc`**: `STREAM_ENCODER=nvenc` no puede funcionar con esta imagen aunque haya GPU |
| Producción | no desplegado (plan en [Despliegue](#despliegue-del-perfil-streaming-plan-no-ejecutado)) | perfil `streaming` fuera del contrato de despliegue; además la producción tiene **apagados** el directo público y los replays públicos, así que `/broadcast` (anónima) sólo podría mostrar «Esperando…» |

## Requisitos para emitir de verdad

1. **Capabilities públicas.** `/broadcast` es anónima por construcción. Sin
   `S9_PUBLIC_SPECTATE_ENABLED=1` no obtiene ticket ni ve ninguna batalla; sin
   `S9_PUBLIC_REPLAYS_ENABLED=1` no ve las terminadas (no hay marcador en el
   intermedio ni en el final). Además, sólo se emiten batallas cuyos bots sean
   **públicos**. Activarlas es una decisión de producto, no de este servicio.
2. **Clave de emisión**: `infrastructure/secrets/stream_key.txt`, rellenada a
   mano. `init-secrets.sh` la deja `0400` y propiedad del uid de ejecución: el
   secreto se monta tal cual, así que tiene que ser legible por el uid 1000 del
   contenedor.
3. **Perfil**: `docker compose --profile streaming up -d streamer` (no está en
   `production`).
4. **Retardo**: si se quiere retardo anti-coaching, hay que declarar
   `spectator.delaySeconds` en el ruleset del motor (competencia de reglas). Sin
   eso, la emisión va en tiempo real.

## Operación

Control (puerto 8090 en la red `platform`, sin publicar):

```bash
docker compose exec streamer wget -qO- --header 'content-type: application/json' \
  --post-data '{"broadcastUrl":"http://web:3000/broadcast?tournament=<id>&event=Copa"}' \
  http://localhost:8090/control/start
docker compose exec streamer wget -qO- http://localhost:8090/status
docker compose exec streamer wget -qO- --post-data '' http://localhost:8090/control/stop
```

Lo normal (EQ5b) es **Administración → Streaming**; lo de arriba queda como operación de
emergencia (y, con `STREAMER_CONTROL_SECRET_FILE` configurado, exige la cabecera
`x-streamer-auth`). Grabación sin canal: modo «Sólo grabar». Los MP4 se retienen según la
política de la pantalla (antes se acumulaban sin límite).

OBS: fuente «Navegador» de 1920×1080 con la misma URL de `/broadcast`; parar el
streamer para no emitir dos veces.

## Errores estables

Los códigos de error de la API (`code` en el cuerpo del error) son estables. El encargo STREAMER pide
cinco nombres genéricos. Se **reutilizan los códigos que ya existían**, sin crear otros paralelos, con
esta equivalencia, que fija `apps/api/src/streamer-real.test.ts`:

| Nombre del encargo | Código(s) de la API | HTTP | Cuándo |
|---|---|---|---|
| `STREAM_NOT_CONFIGURED` | `streaming_disabled`, `credential_missing`, `ingest_missing`, `credential_stale`, `credential_unbound`; `sealed_store_unavailable` al guardar una clave | 409 (503 el último) | streaming desactivado, sin clave, clave sellada con otro par o para otra ingesta, sin clave pública |
| `STREAM_ALREADY_ACTIVE` | `already_active` (API), `streamer_busy` (el streamer ya emite) | 409 | hay otra emisión; **no** se toca la activa |
| `STREAM_NOT_ACTIVE` | `not_active` | 409 | reiniciar sin emisión. **Detener sin emisión no es error**: 200 con `wasActive: false` (idempotente) |
| `STREAM_START_FAILED` | `streamer_unavailable` (503), `streamer_error` (502), `start_cancelled` (409), `battle_not_public` / `tournament_not_broadcastable` (409; antes `target_not_public`), `disk_low` / `disk_unknown` (409), `not_found` (404) | — | el streamer no responde o rechaza la orden, se detuvo mientras arrancaba, batalla no emitible o inexistente |
| `STREAM_STOP_FAILED` | `streamer_unavailable` | 503 | el streamer no responde al stop; la sesión **queda parada** en BD igualmente (`force` lo silencia) |

La API interna del streamer tiene sus propios códigos: `already_active`, `session_mismatch` (stop
condicionado), `unauthorized` y `control_secret_unavailable`. `lastError` siempre va redactado.

## Recursos medidos

Medición del 2026-11-06 con `tests/streaming-e2e/measure.sh`, en local y nunca en producción:

- **Cadena:** batalla REAL del motor (HunterBot contra HunterBot, 30 Hz) → `/broadcast` → imagen del
  streamer construida desde esta rama, con el **mismo aislamiento del Compose** (`init`,
  `cap_drop: ALL` + 3 capacidades, 512 pids) → RTMPS local (MediaMTX con TLS verificado).
- **Perfil:** 1080p30, x264 veryfast, vídeo **VBR con techo** de 4500 kbit/s (`-b:v` = `-maxrate`)
  y audio de 128 kbit/s. No es CBR: x264 no rellena hasta el techo (ver «Ancho de banda»).
- **Duración:** 12 min en LIVE, con una muestra cada ~6,6 s (109 muestras en LIVE).
- **Host de medida:** 8 vCPU Intel Xeon E5-2680 v4 a 2,40 GHz (Broadwell, sin SMT en la VM) y 8,7 GiB
  de RAM, **compartido** con otras cargas.
- **Unidades:** CPU en % de **un** núcleo (docker stats), memoria del contenedor según la cgroup.

| Fase | CPU_AVG | CPU_PEAK | RSS_AVG | RSS_PEAK | Procesos |
|---|---|---|---|---|---|
| IDLE (60 s) | 1,0 % | 8,7 % | 68 MiB | 81 MiB | 5 |
| STARTING (hasta publicar: 1,9 s) | 247 % | 247 % | 297 MiB | 297 MiB | 16 |
| LIVE (720 s) | **259 %** | **297 %** | **450 MiB** | **462 MiB** | 16-18 |
| STOP (60 s) | 0,1 % | 0,2 % | 73 MiB | 73 MiB | 5 |

- **Carga mínima (§26):** en 12 min hubo 21 640 frames (30,0 fps), 0 frames descartados, 0
  reconexiones y 0 errores. **Los descartes no son siempre 0:** la segunda medición de 90 s
  descartó **21 de 2852** (0,7 %), la revisión independiente midió **82 en 6 min** (≈ 0,8 %) y la
  pasada de 120 s de STREAMER-2 (imagen `bc5c3c1`) **23 de 3832** (0,6 %). Son
  los `drop_frames` que reporta ffmpeg (x11grab no llega a tiempo a algún fotograma con la CPU
  compartida); la alerta `StreamerDroppedFramesHigh` salta por encima del 5 %. La métrica
  `stream_dropped_frames_total` es exactamente ese valor (comprobado con ffmpeg real en
  `apps/streamer/src/streamer-2.test.ts`) y, como `stream_frames_total`, se reinicia con cada
  relanzamiento de ffmpeg (EQ5-11). La memoria es estable (448 MiB en el primer cuarto y 450 MiB en el
  último): no se ven fugas en esa ventana. Los procesos no se acumulan: 5 tras STOP y tras cada uno de
  5 ciclos start/stop, 0 zombis. `/dev/shm` llega a **54 MiB** del límite por defecto de 64 MiB, y
  por eso el Compose fija `shm_size: 256m`.
- **Ancho de banda (§24):** `VIDEO_BITRATE` = 4500 kbit/s (techo: `-b:v` = `-maxrate`, con
  `-bufsize` de 9000k) y `AUDIO_BITRATE` = 128 kbit/s. Es **VBR con techo**, no CBR: el
  `TOTAL_BITRATE` medido en la ingesta va de **≈ 270 a ≈ 1130 kbit/s** según la ejecución y la
  escena (339 en los 12 min, 808 en la de 90 s, hasta 952 en la revisión independiente; en
  STREAMER-2, 272 en `measure.sh` a 4500k y 985-1131 en el E2E a 3000k), frente a los
  techos de vídeo configurados en esas mediciones (3000 y 4500 kbit/s). La escena real (arena,
  pocos tanques y HUD) se comprime muchísimo y x264 no rellena hasta el techo. Para dimensionar la subida hay que usar el **techo**:
  ≈ **4,7 Mbit/s** sostenidos más la sobrecarga RTMP/TLS (unos 5 Mbit/s), o ≈ 2,6 Mbit/s con el
  preset de 720p a 2500k. `UPLOAD_AVAILABLE` no se ha medido: no hay forma segura de hacerlo sin
  emitir fuera, y queda como paso del despliegue.
- **Arranque:** de la orden al relé publicando, 1,9 s (9,7 s en frío, con el primer arranque de
  Chromium).
- **Calidad (§21):** MP4 de 45 s grabado por la misma cadena: H.264 1920×1080 a 30/1 y AAC,
  1347 frames. `blackdetect` no encuentra **ningún tramo negro** y `freezedetect` (pantalla quieta más
  de 2 s) encuentra **1**, que corresponde a un momento sin movimiento de los bots, no a un fallo de
  la captura. En los fotogramas (10/20/30/40 s) se ven el escenario completo, los dos bots con su
  nombre, el marcador, el reloj, las tarjetas de equipo con HP y módulos y el objetivo; el texto es
  legible. `/broadcast` **no tiene minimapa**. Defecto de UX fuera de alcance (STR-6): a veces un
  tanque queda bajo el marcador superior.

Una segunda medición más corta (90 s en LIVE, con la imagen final de la rama) dio CPU_AVG 221 %,
CPU_PEAK 274 %, RSS_AVG 640 MiB y RSS_PEAK **693 MiB**, con `/dev/shm` en 55 MiB, ≈ 808 kbit/s en
la ingesta, 21 frames descartados de 2852 y 14/14 comprobaciones. La pasada de 120 s de STREAMER-2
(imagen `bc5c3c1`, ya con `shm_size: 256m`) dio CPU_AVG 225 %, CPU_PEAK 268 %, RSS_AVG 754 MiB y
RSS_PEAK **805 MiB** (600 → 802 MiB entre el primer y el último cuarto), `/dev/shm` en 64 MiB y
14/14. La memoria de la cgroup incluye `/dev/shm` y varía entre ejecuciones: hay que contar con
**hasta ~0,8 GiB**, y la ventana de 120 s no basta para descartar crecimiento.

**Extrapolación al host de producción (con incertidumbre):** no se ha medido allí, por la regla de
no tocar producción. Con el mismo tipo de vCPU, una emisión 1080p30 necesita **unas 2,6 vCPU
sostenidas (picos de 3)** y **entre 0,5 y 0,8 GiB**, más un margen para escenas con más bots y efectos. EQ5
midió del orden de 2,6 CPU en otra batalla. Con 720p30 la carga del codificador baja, pero Chromium
sigue componiendo a 1920×1080 (SwiftShader), que es buena parte del coste. Las fuentes de
incertidumbre son:

- otro modelo o frecuencia de CPU;
- vecinos ruidosos en el hipervisor compartido;
- la complejidad de la escena: 4v4 con proyectiles cuesta más en SwiftShader;
- la memoria y el swap del host, que tienen una incidencia abierta.

**Criterio de despliegue:** tener ≥ 3 vCPU libres sostenidas y ≥ 1 GiB de RAM libre **sin swap**,
medidos en el host antes de desplegar. Si no se cumple, `CPU_ACCEPTABLE` y `MEMORY_ACCEPTABLE` se
consideran no demostrados en producción, y hay que usar 720p o reservar CPU.

## Secretos: custodia, rotación, backup y restore

Son tres secretos nuevos y uno heredado. La tabla completa, con quién monta cada uno, está en
[streaming-architecture.md](../technical/streaming-architecture.md#secretos). Todos viven en
`infrastructure/secrets/` (fuera del repo, en `.gitignore`), son propiedad del **uid 1000**, tienen
modo **0400** y se montan como secretos de Compose. La API sólo monta la pública y el secreto de
control. El streamer sólo monta la privada, el secreto de control y `stream_key`. Nadie más.

**Comprobar sin imprimir** (en el host, desde el directorio del Compose):

```bash
stat -c '%n %u:%g %a %s' infrastructure/secrets/streamer_control_secret.txt \
  infrastructure/secrets/stream_secrets_private.pem infrastructure/secrets/stream_secrets_public.pem
sha256sum infrastructure/secrets/stream_secrets_*.pem infrastructure/secrets/streamer_control_secret.txt
```

**Rotar la clave de YouTube** (lo normal), sin reconstruir ni reiniciar:

1. Genera la clave nueva en YouTube Studio.
2. En **Administración → Streaming → Credenciales**, escribe la nueva y guarda. Se sella y sustituye
   a la anterior en la BD.
3. Si hay una emisión en curso, sigue con la clave antigua hasta que pulses **Reiniciar emisión**. El
   siguiente inicio o reinicio usa la nueva (la pantalla lo avisa con «se aplica en el siguiente
   inicio»).
4. Revoca la clave antigua en YouTube Studio. La plataforma ya no la conserva: el sobre anterior se
   ha sobrescrito.

**Rotar la clave heredada** (`stream_key.txt`): sobrescribe el fichero **en su sitio**, sin moverlo y
sin pasar la clave por argv. Por ejemplo, con un editor que escriba en el mismo inodo, o con
`cat /ruta/segura/nueva > infrastructure/secrets/stream_key.txt` desde un fichero 0600. Se lee en cada
START: la nueva emisión usa la clave nueva sin reiniciar el contenedor.

> **Ojo con los bind mounts de fichero:** si el fichero se **sustituye** (`mv`, `install` o un editor
> que guarda con un inodo nuevo), el contenedor sigue viendo el inodo **antiguo**. En ese caso,
> recrea **sólo** el servicio afectado, sin rebuild:
> `docker compose --profile streaming up -d --force-recreate --no-deps streamer`. Para comprobarlo,
> `docker compose exec streamer sha256sum /run/secrets/stream_key` tiene que coincidir con el hash
> del host.

**Rotar el par de sellado o el secreto de control:** genera el material nuevo con `init-secrets.sh`
(guarda antes el anterior; el script no sobrescribe lo que ya existe) y sustitúyelo en
`infrastructure/secrets/`. Recrea `api` y `streamer` (`--force-recreate --no-deps`, sin rebuild).
Tras rotar el par, las claves guardadas aparecen como **«sellada con otra clave»** y hay que volver a
introducirlas (`credential_stale`). Los ficheros se releen en cada uso, así que basta con que los dos
contenedores vean el inodo nuevo (probado en `apps/streamer/src/streamer-real.test.ts`).

**Backup:** el servicio `backup` respalda `infrastructure/secrets/` entera en su propio snapshot
restic (tag `s9-arena-secrets`), separado del de datos. Los tres secretos de streaming entran ahí.
Límite declarado en ADR-023: la privada de sellado va en el mismo repositorio que el volcado de la BD.

**Restore** ([restore.md](restore.md)):
`restore.sh --restore-secrets <destino> [--snapshot <id>]` restaura con `umask 077` y conserva dueño
y modo. Antes de copiarlos a `infrastructure/secrets/`, comprueba dueño (1000:1000), modo (0400) y
hash con los comandos de arriba. Nunca hagas `cat` de los ficheros. Prueba local reproducible:
`tests/streaming-e2e/secrets-restore.sh`.

## Despliegue del perfil `streaming` (plan, NO ejecutado)

Estado de partida: la producción ejecuta la RC6, que ya incluye la API de administración y la
migración 017. El servicio `streamer` **no** está desplegado. Los tres secretos ya existen con 0400 y
uid 1000 y están en el backup, con restore verificado. Este plan **no se ha ejecutado**: desplegar
exige la autorización del operador.

1. **Requisitos previos:**
   - revisión independiente y CI verde del PR;
   - imagen `streamer` construida en la CI con `BUILD_COMMIT` = SHA del merge;
   - backup reciente verificado de la BD y de los secretos;
   - margen de CPU y RAM en el host: ver [Recursos medidos](#recursos-medidos). Reserva al menos las
     CPU de LIVE y comprueba que el host no esté ya paginando a swap. Si no hay margen, **no se
     despliega**.
2. **Comprobar los secretos sin imprimirlos:** dueño, modo y hash (ver arriba). Tiene que existir
   `stream_key.txt` (puede estar vacío) porque Compose lo declara.
3. **API:** se despliega con el commit del merge como el resto de servicios
   ([upgrades.md](upgrades.md)). **No hay migración nueva** (no existe la 019): este cambio no toca el
   esquema.
4. **Streamer:** con `STREAMER_TAG` apuntando a la imagen del merge,
   `docker compose --profile production --profile streaming up -d --no-deps streamer`.
5. **Verificación sin emitir:**
   - `docker compose ps streamer` debe dar `healthy`;
   - `/version` (`docker compose exec streamer wget -qO- http://localhost:8090/version`) debe dar el
     `BUILD_COMMIT` esperado;
   - `docker inspect` debe mostrar `CapDrop=[ALL]`, `Init=true` y `PidsLimit=512`;
   - el `CapEff` del proceso Node debe ser 0 (`grep CapEff /proc/<pid>/status` dentro del
     contenedor);
   - `docker inspect` y `docker logs` no deben contener la clave (recuento 0, como
     `tests/streaming-e2e/secret-audit.sh`).
6. **Pantalla:** **Administración → Streaming** debe mostrar «Listo». **Probar** hace TLS y handshake
   sin publicar.
7. **Emisión de prueba** en modo **Sólo grabar**, con una batalla pública, durante 1-2 min.
   Comprueba el MP4 (ffprobe) y los fotogramas. YouTube sólo con clave autorizada (ver abajo).
8. **Observación durante 24 h:** alertas `s9-streamer`, CPU y memoria del host y `stream_*` en
   `/metrics`.

**YouTube real** (§23/§33): **BLOCKED_BY_AUTHORIZATION**. No hay clave de prueba autorizada. Con
autorización:

- emisión **privada o no listada**;
- clave introducida desde la web;
- **Probar**, después **Iniciar** y vigilar en YouTube Studio que la señal llega estable durante
  10 min;
- **Detener**;
- reconexión: cortar la salida brevemente y comprobar que vuelve sola;
- revocar la clave al terminar.

## Rollback del perfil `streaming`

| Pieza | Cómo | Qué se pierde |
|---|---|---|
| Emisión en curso | **Detener emisión** (o `POST /admin/streaming/stop` con `force`) | nada |
| Contenedor `streamer` | `docker compose --profile streaming stop streamer` y `docker compose --profile streaming rm -f streamer` | nada: no guarda estado. La pantalla dice «Servicio de emisión no disponible» |
| Imagen | `STREAMER_TAG=<anterior>` y repetir el paso 4 | nada |
| Código de la API | volver a la RC anterior ([upgrades.md](upgrades.md)). El contrato 0.14.0 sólo añade campos, y la 0.13.0 los ignora | `lastSession` deja de mostrarse |
| Estado en BD | no hace falta tocarlo: una sesión `active` sin emisión la cierra el siguiente START (`not_emitting`) o **Detener**. Revertir la 017 (`rollback:name 017_streaming_admin`) borra configuración, sobres e historial (la auditoría se conserva) y sólo se hace si se abandona el streaming | configuración y claves selladas |
| Secretos | **no se borran automáticamente**, tampoco en el rollback. Siguen en `infrastructure/secrets/` y en el backup. Borrarlos es una decisión explícita del operador, que además debe revocar la clave en YouTube | — |

## Diagnóstico

| Síntoma | Mirar | Causa habitual |
|---|---|---|
| «Servicio de emisión no disponible» | `docker compose ps streamer`, `docker compose logs --tail 50 streamer` | perfil sin desplegar; contenedor `unhealthy` (secreto de control ilegible ⇒ `/healthz` 503) |
| «Iniciando» que no pasa a «En directo» | `lastError` en la pantalla, `relay.state` en `/status` | ingesta inalcanzable, clave rechazada (`BadName`), TLS no verificado |
| «Reconectando» en bucle | alerta `StreamerRestartLoop`, `stream_reconnects_total` | cortes de red o la ingesta cierra la conexión |
| «Abandonada» | `stream_failures_total`, `lastError` | más de 20 reintentos seguidos; corrige la causa y pulsa **Iniciar** |
| Pantalla negra o congelada | alerta `StreamerNoProgress`, fotogramas del MP4; si Chromium cayó, el log `chromium terminó; se relanza` lleva `outputTail` (los últimos 2 KiB de su stderr, redactados) | Chromium caído (se relanza solo); `/broadcast` sin directo público. `StreamerNoProgress` mira a ffmpeg, no a Chromium: una imagen congelada con ffmpeg sano no la detecta ninguna alerta |
| Procesos acumulados | `docker compose exec streamer ps -o pid,ppid,stat,args`, `stream_killed_total` | no debería ocurrir (parada del árbol + init); si `stream_killed_total` sube, hay hijos que no atienden SIGTERM |

## Pruebas (§31)

Pruebas mínimas del encargo. **Existía** quiere decir que estaba en `main` antes de esta rama;
**Nueva** quiere decir que se añade aquí (`streamer-real.test.ts` del streamer y de la API, o los
scripts locales). Las marcadas con ⚙ ejecutan **ffmpeg o procesos reales**.

| Prueba | Estado | Dónde |
|---|---|---|
| `STREAM_START_VALID` | Existía | `apps/api/src/eq5b-streaming-admin.test.ts`, `apps/streamer/src/control-admin.test.ts`; ⚙ `tests/streaming-e2e/e2e.sh` y `measure.sh` |
| `STREAM_STOP_VALID` | Existía | los mismos |
| `STREAM_STOP_IDEMPOTENT` | Existía + nueva | `eq5b-streaming-admin.test.ts`; nueva en el streamer (`ifSession` y stop sin cuerpo); ⚙ `measure.sh` (`stop_idempotent`) |
| `STREAM_ALREADY_ACTIVE` | Existía + nueva | `eq5b`, `control-admin.test.ts` (409); nueva en `apps/api/src/streamer-real.test.ts` (la emisión activa no se toca) |
| `INVALID_BATTLE` | Nueva (explícita) | `apps/api/src/streamer-real.test.ts` (404 / 400) |
| `MISSING_SECRET` | Existía + nueva | `eq5c-correcciones.test.ts` y `eq6b-relay-break.test.ts` (secreto de control ilegible ⇒ 401/503); nueva: `credential_missing` en la API |
| `INVALID_SECRET` | Existía | `eq5c-correcciones.test.ts`, `eq6b-relay-break.test.ts`, `eq5d-correcciones.test.ts` (sobre manipulado o truncado, otra clave, otro destino) |
| `FFMPEG_START_FAILURE` | Nueva ⚙ | `apps/streamer/src/streamer-real.test.ts` con el **ffmpeg real** (x11grab sin display ⇒ reintentos ⇒ `failed`); en la CI es obligatorio |
| `FFMPEG_RUNTIME_CRASH` | Existía + nueva ⚙ | `streamer.test.ts`, `eq6b` (simulado); ⚙ `measure.sh` (`kill -9` a ffmpeg en el contenedor ⇒ vuelve a publicar) |
| `RTMP_DISCONNECT` | Existía ⚙ | `r3-relay-break.test.ts`, `eq6c-relay-break.test.ts`; ⚙ `e2e.sh` (`reconnect_pause`, `reconnect_down`) |
| `RECONCILER_START_RACE` | Nueva | `apps/api/src/streamer-real.test.ts` (foto vieja de `/status`) |
| `RECONCILER_STOP_RACE` | Nueva | la misma (stop en vuelo) y `apps/streamer/src/streamer-real.test.ts` (`ifSession`) |
| `NO_ORPHAN_PROCESS` | Nueva ⚙ | `apps/streamer/src/streamer-real.test.ts` (procesos reales con hijos, también si ignoran SIGTERM); ⚙ `measure.sh` (contenedor real: STOP y 5 ciclos) |
| `SECRET_NOT_IN_LOGS` | Existía + nueva | `secret-surfaces.test.ts`, `eq5d`/`eq5e`; nueva: JSON válido con ingesta hostil (R4-3); ⚙ `measure.sh` (`key_not_leaked`, `log_lines_json`: desde STREAMER-2 revisa **todas** las líneas; la única no JSON admitida es la de Xvfb, `_XSERVTrans…`) |
| `CHROMIUM_BACKPRESSURE` | Nueva (STREAMER-2) | `apps/streamer/src/streamer-2.test.ts` (Chromium con > 2 MiB de salida sigue avanzando y los frames suben) y `r242-streamer-break.test.ts` (§20, de #243) |
| `ROOT_ERROR_PRESERVED` | Nueva (STREAMER-2) | `apps/streamer/src/streamer-2.test.ts` (relé real contra una ingesta que rechaza la clave; ffmpeg que escribe al pararlo) |
| `SECRET_NOT_IN_API` | Existía + nueva | `eq5b-streaming-admin.test.ts`, spec `@streaming-e2e`; nueva: `lastSession` sin sobre ni config |
| `PERMISSION_DENIED` | Existía + nueva | `conformance.test.ts` (RBAC del contrato); nueva: un usuario normal recibe 403 en start, stop, estado y credencial |
| `RESTART_RECOVERY` | Nueva | `apps/api/src/streamer-real.test.ts` (START tras `failed` y tras reiniciar el streamer) |

## Defectos y limitaciones conocidos

| Id | Severidad | Defecto | Estado |
|---|---|---|---|
| EQ5-1 | P1 | Autodirector de torneo: sólo veía las 100 últimas batallas globales | **corregido** (usa `GET /tournaments/{id}/battles`) |
| EQ5-2 | P1 | «Torneo terminado» en mitad del torneo (un visitante no ve las programadas); «Batalla 1 / 1» | **corregido** (el final lo decide `tournaments.state`) |
| EQ5-3 | P2 | Barra de Google Translate fija en el vídeo; puntero del Xvfb visible al arrancar | **corregido** (`--lang=es`, `--disable-features=Translate`, `-draw_mouse 0`); verificado en un MP4 grabado por la imagen construida desde la rama |
| EQ5-4 | P3 | Rótulos con UUID en vez del nombre del bot; «Torneo terminado» en una batalla suelta | **corregido** |
| EQ5-5 | P2 | Clave de emisión en el argv de FFmpeg (visible con `ps` en el host) | **corregido** (EQ5b, ADR-023): relé RTMP(S) en el propio streamer; ffmpeg escribe FLV por el fd 3 |
| EQ5-6 | P2 | `init` del espectador con snapshot vivo aunque haya retardo (reconectar saltaba el retardo) | **corregido** en el gateway; la declaración de `delaySeconds` en rulesets sigue **abierta** (reglas) |
| EQ5-7 | P2 | `/metrics` del streamer sin scrape de Prometheus | **corregido** (job `streamer`) y, EQ5b, alertas `StreamerDown`/`RestartLoop`/`DroppedFramesHigh`/`NoProgress` |
| EQ5-8 | P3 | NVENC imposible con la imagen actual | **abierto** (documentado) |
| EQ5-9 | P3 | Sin retención de MP4 en modo grabación | **corregido** (EQ5b): retención por edad/tamaño desde la web, auditada |
| EQ5-11 | P3 | Tras `failed` (corte > ~1 min) no hay reintento automático; cada reintento relanza también Chromium (recarga la página); `streamer_frames_total` vuelve a 0 en cada relanzamiento de FFmpeg | **abierto** |
| EQ5-12 | P3 | El ticker de eventos rotula ids de vehículo (`v_blue destruido`) | **abierto** (texto del evento del motor) |
| EQ6b-P1 | P1 | El rechazo explícito de la ingesta (clave errónea: `BadName`; app rechazada) no llegaba al supervisor: «en directo» sin emitir, sin reintento ni `lastError` | **corregido** (EQ5c): todo fallo del arranque pasa por `fail()` |
| EQ6b-P2-1 | P2 | Sin plazo tras el handshake: una ingesta muda colgaba el relé y `/control/test` | **corregido** (EQ5c): plazo por orden RTMP y plazo total de la prueba; se cierra el socket |
| EQ6b-P2-2 | P2 | El sobre no estaba atado a su destino: con el secreto interno se publicaba la clave de YouTube en otra ingesta | **corregido** (EQ5c): sobre v2 atado a plataforma + ingesta (ADR-023) |
| EQ6b-P2-3 | P2 | Control abierto si el fichero del secreto no se podía leer | **corregido** (EQ5c): fail-closed; aviso de `init-secrets.sh` |
| EQ6b-P2-4 | P2 | Emisión zombi en carreras start‖stop y restart‖stop | **corregido** (EQ5c): en serie + recomprobación en BD |
| EQ6b-P3 | P3 | Tope agregado del lector RTMP; SSRF de la ingesta; disco sin medir; `code` sin redactar | **corregidos** (EQ5c); SSRF por DNS rebinding y `/control/test` interno con `x-streamer-auth`: **abiertos** (ADR-023) |
| EQ6b-P3-backup | P3 | El backup restic guarda la privada de sellado junto al volcado de la BD | **abierto** (documentado en ADR-023) |
| EQ6c-P2 | P2 | `PUT enabled:false` con un start en vuelo dejaba la emisión viva con el streaming desactivado (UI «Desactivado», alertas silenciadas) | **corregido** (EQ5d): desactivar lee y para la sesión dentro del cerrojo; el start relee la configuración en el cerrojo y recomprueba `enabled` al responder el streamer |
| EQ6c-P3-1 | P3 | Entre dos instancias de la API, start‖stop y restart‖stop dejaban el streamer emitiendo sin sesión | **corregido** (EQ5d): el stop marca la BD antes de llamar al streamer; queda el caso contrario y visible («interrumpida», ADR-023) |
| EQ6c-P3-2 | P3 | GCM aceptaba etiquetas truncadas (4/8/12 bytes) | **corregido** (EQ5d): `authTagLength: 16` y longitudes exactas; sobres rechazados registrados |
| EQ6c-P3-3 | P3 | La clave codificada (base64/hex) en el rechazo de la ingesta llegaba a `/status` y a los logs | **corregido** (EQ5d): redacción de fragmentos ≥ 8 en claro, base64 y hex |
| EQ6c-P3-4 | P3 | Relé sin plazo de escritura: una ingesta que dejaba de leer lo dejaba «publicando» para siempre | **corregido** (EQ5d): `write_timeout` y reintento |
| EQ6c-P3-5 | P3 | «En directo» con el relé aún conectando | **corregido** (EQ5d): estado «Iniciando» |
| EQ6c-P3-6 | P3 | SSRF con IPv6 que incrustan una IPv4 (compatible, traducida, NAT64, 6to4) y site-local | **corregido** (EQ5d): normalización IPv6 y extracción de la IPv4 |
| R3-A | P3 | `redactSecret` calculaba los índices sobre `toLowerCase()` (que cambia la longitud con «İ») y la clave salía entera | **corregido** (EQ5e): `foldSameLength` |
| R3-B | P3 | start(A) ‖ stop(B) ‖ start(C en B) entre dos instancias dejaba una emisión sin sesión | **corregido** (EQ5e): reconciliación de huérfanas tras el 409 del streamer, en la recomprobación y cada 30 s; con una réplica (Compose) no se da; multi-réplica = límite declarado (ADR-023) |
| R3-C | P3 | El plazo de escritura del relé no se rearmaba si la ingesta leía un poco y se colgaba | **corregido** (EQ5e): rearme mientras haya datos pendientes sin `drain` y avance |
| R3-D | P3 | El estado de la pantalla usaba el modo guardado, no el de la emisión, con un cambio pendiente de reinicio | **corregido** (EQ5e): modo del streamer o de la sesión |
| R3-E | P3 | Un start aplicado cuya respuesta se perdía (plazo, 503) dejaba una emisión sin sesión | **corregido** (EQ5e): stop compensatorio auditado (`streaming.session.start_compensated`) y reconciliación |
| R3-F | P3 | La prueba de la 017 y su vuelta atrás suponían que la 017 era la última (la 018 de #229 va detrás) | **corregido** (EQ5e): `rollback:name 017_streaming_admin`; prueba con una migración posterior simulada |
| EQ5-10 | P3 | Con el torneo en curso, la espera/intermedio no anuncian la próxima batalla (un visitante no la ve) | limitación de la política de visibilidad |
| R4-1 (#241) | P3 | El reconciliador podía parar una sesión legítima (foto vieja de `/status` o stop en vuelo no condicionado) | **corregido** (STREAMER): segunda lectura de `/status` tras la BD y `/control/stop {ifSession}` |
| R4-2 (#241) | P3 | `rollback:name 001_identity` ejecutaba `DROP … CASCADE` sin salvaguarda | **corregido** (STREAMER): lista cerrada 016/017/018 |
| R4-3 (#241) | P3 | La redacción sobre la línea ya serializada dejaba líneas de log que no eran JSON (`\***`) | **corregido** (STREAMER): redacción por valor en el `replacer` |
| R4-obs (#241) | P3 | `orphan_stopped` en cada tick si el stop falla; `outcome: stopped` sin nada emitiendo; AUTOSTART parado sin documentar | **corregidos** (una auditoría por emisión; `nothing_to_stop`; documentado en la arquitectura) |
| STR-1 | P2 | STOP sólo con SIGTERM al proceso padre: un hijo que no lo atendiera, o los hijos de Chromium, podían quedar vivos | **corregido**: SIGTERM al árbol (leído de `/proc`), SIGKILL tras 5 s e `init: true` |
| STR-2 | P2 | START tras una emisión abandonada o un reinicio del streamer respondía `alreadyActive` y no emitía | **corregido**: la sesión muerta se cierra (`not_emitting`, auditado) y se arranca |
| STR-3 | P3 | El contrato no declaraba `starting` en `uxState` | **corregido** (contrato 0.14.0) |
| STR-4 | P3 | Servicio sin `cap_drop`, sin límite de pids y con el /dev/shm por defecto (54 de 64 MiB usados en 12 min) | **corregido** en el Compose |
| STR-5 | P3 | Sin `read_only` en el contenedor (Chromium escribe en `$HOME` y Xvfb en `/tmp`) | **abierto** (deuda declarada) |
| STR-6 | P3 | El escenario de la batalla tapa a veces el marcador superior (un tanque bajo el rótulo) | **abierto**: UX de `/broadcast`, fuera del alcance de STREAMER |
| STR-7 (H1) | P3 | Nadie leía el stdout/stderr de Chromium: con más de 128-256 KiB de salida se bloqueaba en `write()` y la emisión seguía «en directo» con la imagen congelada y sin alerta | **corregido** (STREAMER-2): se leen siempre y se descartan; sólo se guarda una cola de 2 KiB del stderr, redactada al registrarla |
| STR-8 (H2) | P3 | Con la clave rechazada por la ingesta, `lastError` acababa mostrando el ruido de la parada de ffmpeg (`Nothing was written into output file…`) en vez del rechazo | **corregido** (STREAMER-2): guarda de generación en el stderr de ffmpeg; ese ruido se registra (`superseded: true`) pero no sustituye la causa |
| STR-9 (H3) | P3 | La documentación y la evidencia decían CBR, 0 frames descartados y «todas las líneas de log son JSON» (y `measure.sh` sólo miraba las que empiezan por `{`) | **corregido** (STREAMER-2): VBR con techo, descartes medidos, Xvfb declarado y `measure.sh` revisa todas las líneas |

## Cómo se verificó

Entorno local efímero en `127.0.0.1` (nunca producción): API real sobre
PostgreSQL embebido, gateway de espectador real, batallas REALES del motor a
30 Hz con bots en proceso, SPA construida con `vite build`, servidor RTMPS
local con TLS autofirmado y la imagen del streamer (la de `main` publicada en
GHCR y la construida desde esta rama), con la misma configuración del servicio
Compose y una clave **falsa**. Rendimiento del motor medido en el propio bucle
(duración del `step` y periodo entre ticks) antes, durante y después de la
emisión, con el host compartido con otras cargas:

| Ventana | step p99 | periodo p50 / p99 / máx | ticks > 50 ms |
|---|---|---|---|
| antes (30 s) | 0,89 ms | 33,4 / 34,0 / 771 ms | 2 |
| durante RTMPS (133 s) | 0,76 ms | 33,5 / 35,9 / 100 ms | 6 |
| después (30 s) | 0,54 ms | 33,4 / 33,8 / 34 ms | 0 |

El coste del `step` no cambia; el periodo gana algo de jitter (p99 +2 ms) por
competir por CPU en el mismo host. En producción el streamer y el worker
compartirían máquina: reservar ~3 CPU para el streamer.

Evidencia completa (no versionada): directorio de evidencias de la auditoría EQ5.
