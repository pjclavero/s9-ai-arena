# E11 · Streaming — entrega v1

Cubre **T11.1 y T11.2** (cap. 21 del dosier técnico) y las mejoras E11.M, sobre
`de61d79` (E1-E10 integrados, incluidos E8 visor y E9 torneos). Rama
`e11-streaming`. La regla de oro del capítulo se cumple por construcción: nada
de esta entrega importa ni toca `apps/arena-engine/src/sim/` — el streaming
consume el canal de espectador de E8 como un cliente más y la API pública de
visitante.

## Estado de la suite (medido en este entorno, Node v20.19.2, 2026-07-16)

```bash
npm test -- --maxWorkers=2
# 627 pasan · 1 falla · 3 skipped (631)
```

- El **único fallo** es el PREEXISTENTE de entorno (`zstdCompressSync` no existe
  en Node 20, exige ≥22.15) en `apps/arena-engine/tests/replay-golden.test.ts`.
  No es de E11 y no se ha tocado. Línea base antes de E11: 592 / mismo fallo / 3.
- E11 añade **35 tests, todos verdes**: 16 en `apps/web/tests/{broadcast-logic,
  broadcast-page}` y 19 en `apps/streamer/src/streamer.test.ts`.
- `npx vite build apps/web` compila; el visor Phaser sigue siendo el chunk
  perezoso de E8 (1,38 MB gzip 361 kB): /broadcast lo reutiliza, no lo duplica.
- Los 56 tests de infraestructura de E10 (compose/scan/observabilidad/backup)
  siguen verdes con los cambios del servicio `streamer`.

## Limitaciones de entorno (honestas, aplican a toda la entrega)

Sin grupo docker ni sudo, sin navegador y sin canal de YouTube en este entorno:
**no se ha construido la imagen streamer ni ejecutado Chromium/FFmpeg reales ni
emitido a ningún servicio externo**. Todo lo que exige eso queda [PENDIENTE]
con su guion; la lógica está implementada y probada con procesos/fetch
inyectados. Ningún test usa BDs ni servicios del homelab.

## Contenido

```
apps/web/src/broadcast/
  config.ts        T11.1 · autoconfiguración por query (?battle|?tournament), branding por
                           parámetros (logo/colores/evento) con saneado anti-inyección,
                           enrutado /broadcast y #/broadcast
  director.ts      T11.1 · decideScreen PURA (espera/directo/intermedio/final) +
                           BroadcastDirector (sondeo de la API pública, avance automático)
                           + createPublicApi (cliente ANÓNIMO: jamás Authorization)
apps/web/src/pages/BroadcastPage.tsx  T11.1 · composición 1920×1080 sin controles ni cursor:
                           visor E8 real (PhaserViewer+SpectatorClient) + marcador +
                           participantes con loadout resumido + progreso + ticker + branding
apps/web/src/App.tsx       T11.1 · ruta pública /broadcast (path y hash), sin login
apps/streamer/src/
  config.ts        T11.2 · secreto SOLO por archivo (STREAM_KEY_FILE); logger que REDACTA
  ffmpeg.ts        T11.2 · chromium kiosco sobre Xvfb + ffmpeg x11grab→RTMPS; x264 base,
                           nvenc opción; modo record (E11.M); argv redactado para logs
  metrics.ts       T11.2 · parser de `-progress` (frames/fps/bitrate/drops) + Prometheus
  supervisor.ts    T11.2 · start/stop, reintentos ante corte RTMPS (generaciones
                           anti-doble-reintento; el progreso salda el contador)
  control.ts       T11.2 · API interna: POST /control/start|stop, GET /status|/metrics|/healthz
  main.ts          T11.2 · SERVICE_ENTRY real del contenedor
infrastructure/docker/streamer/       T11.2 · imagen real (chromium+ffmpeg+xvfb+node/tsx) y
                           entrypoint con Xvfb 1920×1080 (sustituye el esqueleto de E10)
infrastructure/docker-compose.yml     T11.2 · env del streamer (MODE/ENCODER/AUTOSTART),
                           volumen arena_replays (modo record) y healthcheck por /healthz
docs/streaming-runbook.md  E11.M · operación, NVENC=GPU passthrough Proxmox, etapa OBS,
                           retardo anti-coaching vía ruleset, guion de la prueba de 30 min
```

Commits (uno por tarea): `f50b523` T11.1 · `e7b1e3f` T11.2 (+ este documento).

## Estado de la DoD por tarea

| Tarea | Criterio del dosier | Estado |
|---|---|---|
| T11.1 | Batalla en directo a 1080p estable en Chromium headless 30 min sin fugas de memoria | **[PENDIENTE]** sin navegador en este entorno. Mitigación real: /broadcast monta el MISMO visor de E8 (presupuesto sin allocs por frame documentado en PhaserViewer) y el chrome de emisión mantiene listas acotadas (feed 50, ticker 6). Guion en el runbook §7 |
| T11.1 | Modo torneo encadena batallas con pantallas de espera (E2E con torneo simulado) | **[EJECUTADO a nivel lógico+jsdom]** torneo simulado de 2 batallas: waiting → live(b1) → intermission (marcador última + próxima) → live(b2) → finished, con avance automático y sin pantallas duplicadas; pantallas renderizadas verificadas en jsdom. **[PENDIENTE]** la variante con navegador real |
| T11.1 | El branding cambia por parámetros sin redeploy | **[EJECUTADO]** misma build, otra query ⇒ otro evento/logo/colores (test de lógica + render jsdom); entradas saneadas (colores solo #hex, logo solo http(s)/relativo, ids conservadores) |
| T11.1 | Solo canal público de espectador: cero datos privados (mismo test de fuga de E8) | **[EJECUTADO]** /broadcast usa el MISMO SpectatorClient y gateway de E8 — el barrido de fugas byte a byte de E8 (spectator.e2e.test.ts) cubre este canal sin cambios. Además: cliente API anónimo por construcción (nunca Authorization), verificado en test tanto en el director como en la página (todas las peticiones: GET/POST anónimos a rutas de visitante) |
| T11.2 | Emisión privada de 30 min a YouTube sin caídas, bitrate estable (runbook) | **[PENDIENTE]** prohibido emitir a servicios externos desde este entorno y no hay docker. Guion y tabla de evidencia en docs/streaming-runbook.md §7 |
| T11.2 | Las métricas del motor no se degradan durante la emisión (test conjunto E10/E2) | **[PENDIENTE de despliegue]** por diseño no hay camino: el streamer es un contenedor aparte (límite 4 CPU/4 GB), consume el gateway de espectador (que lee arrays públicos sin tocar la simulación) y no comparte proceso con el motor. La verificación empírica es parte de la prueba de 30 min |
| T11.2 | La clave RTMPS no aparece en logs, inspect ni variables (revisión automatizada) | **[EJECUTADO a nivel de tests]** la clave entra SOLO por archivo (`STREAM_KEY_FILE`), la config es serializable sin clave, el logger redacta TODO (incl. stderr de ffmpeg y argv), y /status,/metrics,/healthz se barren en test. En Compose no hay ninguna variable con la clave (el test de E10 “ninguna variable lleva una clave en claro” sigue verde). **[PENDIENTE]** `docker inspect` sobre el contenedor real (runbook §7.5) |
| T11.2 | Un corte de red de 30 s se recupera con reintento sin intervención (caos) | **[EJECUTADO a nivel lógico]** test de caos con procesos inyectados: muerte de ffmpeg ⇒ relanzamiento automático con espera; el progreso posterior salda el contador (cortes repetidos ≠ agotamiento); reintentos agotados ⇒ `failed` sin spawns fantasma; sin doble reintento por el exit del chromium sacrificado. **[PENDIENTE]** el corte de red real con `docker network disconnect` (runbook §7.4) |

Mejoras E11.M (las cuatro del dosier):

- **NVENC**: documentado que exige GPU con passthrough PCIe en Proxmox
  (runbook §3); x264 por software queda como base para no bloquear el hito.
- **Modo «solo grabación»**: hecho (`STREAM_MODE=record` → mp4 en
  `arena_replays/video`, sin clave), con test.
- **Etapa OBS**: documentada como procedimiento operativo (runbook §6), no
  como software del repo.
- **Retardo de emisión 30–60 s para finales**: se resuelve con el retardo
  anti-coaching que E8 ya implementa en el gateway
  (`ruleset.spectator.delaySeconds`, configurable por ruleset conforme a
  ADR-000); duplicarlo en FFmpeg desincronizaría vídeo y datos. Documentado en
  runbook §5.

## Decisiones (las que alguien querrá discutir)

1. **El estado del torneo se lee de la API pública, no de un canal nuevo.** El
   director sondea `listBattles` (visitor) y filtra por `tournamentId`: cero
   endpoints nuevos, cero datos privados y el avance automático sale del estado
   real que escribe el worker de E9. Coste: hasta `pollIntervalMs` (4 s por
   defecto, configurable por query) de latencia al cambiar de pantalla —
   irrelevante en emisión.
2. **La “ronda” se muestra como progreso (Batalla n/m).** El número de ronda
   vive en `matches` y el contrato público de E1 (`Battle`) no lo expone; antes
   que tocar el contrato, la cabecera muestra el progreso real del torneo. Si
   E9 pasa `round` en el `meta` de `attachBattle()` (campo libre ya previsto por
   E8), la vista puede promocionarlo sin cambio de contrato — anotado abajo.
3. **Chromium NO headless sobre Xvfb** (en vez de headless + screencast): FFmpeg
   captura el framebuffer por x11grab, que es el camino estándar, sin protocolo
   DevTools ni dependencias nuevas. El “headless” del DoD se cumple a nivel de
   host (no hay pantalla física).
4. **La clave jamás sale del proceso Node**: el entrypoint no la lee ni exporta;
   `loadStreamKey` la lee del archivo y viaja separada de la config. El único
   lugar donde existe fuera es el argv de ffmpeg DENTRO del contenedor
   (inevitable: RTMPS de YouTube es `url/clave`); todo lo loggable pasa por
   redacción y así lo verifican los tests.
5. **Healthcheck por la API de control, no por `pgrep ffmpeg`**: el esqueleto de
   E10 daba por sano solo “ffmpeg corriendo”, pero el servicio es legítimamente
   sano con la emisión parada (esperando `/control/start`). El estado de la
   emisión lo vigila E10 por `/metrics` (`streamer_up`).

## Pendiente de reconciliación (explícito)

- **E9 → gateway**: `attachBattle()` sigue siendo el punto pendiente declarado
  por E8 (“en producción el worker de E9 llama a attachBattle al arrancar cada
  batalla”). /broadcast hereda esa pendencia: sin ese cableado, el directo
  muestra la pantalla de espera aunque la batalla esté `running`. Sugerido:
  pasar también `meta.round` al attach (decisión 2).
- **E10 · scrape**: añadir el job del streamer a `prometheus.yml`
  (`streamer:8090/metrics`, red platform) y una alerta sobre `streamer_up==0`
  con emisión esperada. No se ha tocado la observabilidad de E10 desde E11.
- **E10 · gateway web**: `/broadcast` es ruta del SPA; el fallback a
  `index.html` del gateway debe cubrirla (la variante `#/broadcast` funciona ya
  sin tocar nada).
- **Imagen streamer**: `npm install -g tsx@4` fija major, no build exacto;
  cuando E10 fije la política de pinning de imágenes, alinear.
