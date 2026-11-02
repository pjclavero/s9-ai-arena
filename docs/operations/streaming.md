# Retransmisión: `/broadcast`, streamer y RTMPS

## Resumen

Estado **verificado** de la retransmisión de S9 AI Arena (auditoría EQ5,
2026-11-02, sobre `main` `a1a6c4e` y la rama `equipo5/streaming`). Distingue lo
**implementado** de lo **verificado**, y lo verificado en un entorno **local
aislado** de lo verificado en **producción** (nada de esto último: la
producción no ejecuta el streamer). Sustituye como runbook vigente al de E11,
que se conserva en [history/operaciones/streaming-runbook.md](../history/operaciones/streaming-runbook.md).

## Índice

- [Piezas](#piezas)
- [Cronología](#cronología)
- [Estado verificado](#estado-verificado)
- [Requisitos para emitir de verdad](#requisitos-para-emitir-de-verdad)
- [Operación](#operación)
- [Defectos y limitaciones conocidos](#defectos-y-limitaciones-conocidos)
- [Cómo se verificó](#cómo-se-verificó)

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
| Clave fuera del argv | **FAIL** | la clave viaja en el argv de FFmpeg: `docker top` y el `ps` de **cualquier usuario del host** la muestran |
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

Grabación sin canal: `STREAM_MODE=record` (sin clave). Los MP4 se acumulan en
`arena_replays/video` sin límite: bórralos a mano.

OBS: fuente «Navegador» de 1920×1080 con la misma URL de `/broadcast`; parar el
streamer para no emitir dos veces.

## Defectos y limitaciones conocidos

| Id | Severidad | Defecto | Estado |
|---|---|---|---|
| EQ5-1 | P1 | Autodirector de torneo: sólo veía las 100 últimas batallas globales | **corregido** (usa `GET /tournaments/{id}/battles`) |
| EQ5-2 | P1 | «Torneo terminado» en mitad del torneo (un visitante no ve las programadas); «Batalla 1 / 1» | **corregido** (el final lo decide `tournaments.state`) |
| EQ5-3 | P2 | Barra de Google Translate fija en el vídeo; puntero del Xvfb visible al arrancar | **corregido** (`--lang=es`, `--disable-features=Translate`, `-draw_mouse 0`); verificado en un MP4 grabado por la imagen construida desde la rama |
| EQ5-4 | P3 | Rótulos con UUID en vez del nombre del bot; «Torneo terminado» en una batalla suelta | **corregido** |
| EQ5-5 | P2 | Clave de emisión en el argv de FFmpeg (visible con `ps` en el host) | **abierto**: FFmpeg no lee la URL de salida de un fichero (probado: ni siquiera FFmpeg 7.1 acepta `-/rtmp_playpath <fichero>`). Mitigación del operador: `/proc` del host con `hidepid=invisible`; arreglo de verdad: un relé que lea la clave de fichero |
| EQ5-6 | P2 | `init` del espectador con snapshot vivo aunque haya retardo (reconectar saltaba el retardo) | **corregido** en el gateway; la declaración de `delaySeconds` en rulesets sigue **abierta** (reglas) |
| EQ5-7 | P2 | `/metrics` del streamer sin scrape de Prometheus | **corregido** (job `streamer`); falta una alerta sobre `streamer_up` |
| EQ5-8 | P3 | NVENC imposible con la imagen actual | **abierto** (documentado) |
| EQ5-9 | P3 | Sin retención de MP4 en modo grabación | **abierto** |
| EQ5-11 | P3 | Tras `failed` (corte > ~1 min) no hay reintento automático; cada reintento relanza también Chromium (recarga la página); `streamer_frames_total` vuelve a 0 en cada relanzamiento de FFmpeg | **abierto** |
| EQ5-12 | P3 | El ticker de eventos rotula ids de vehículo (`v_blue destruido`) | **abierto** (texto del evento del motor) |
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
