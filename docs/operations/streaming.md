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

## Índice

- [Administración desde la web](#administración-desde-la-web)
- [Seguridad de la clave de emisión](#seguridad-de-la-clave-de-emisión)
- [Alertas](#alertas)
- [Piezas](#piezas)
- [Cronología](#cronología)
- [Estado verificado](#estado-verificado)
- [Requisitos para emitir de verdad](#requisitos-para-emitir-de-verdad)
- [Operación](#operación)
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
- `/broadcast` es anónima: sólo se emiten batallas sin bots privados (la API lo rechaza con
  `target_not_public`) y hace falta el directo público activado.
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
| Producción | no desplegado | perfil `streaming` fuera del contrato de despliegue; además la producción tiene **apagados** el directo público y los replays públicos, así que `/broadcast` (anónima) sólo podría mostrar «Esperando…» |

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
