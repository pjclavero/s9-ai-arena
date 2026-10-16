# Runbook de streaming (E11 · cap. 21)

Operación de la retransmisión a YouTube. Regla de oro: **el streaming no toca
jamás el motor ni el tick de batalla** — el streamer es un espectador más que
carga la vista `/broadcast` (T11.1) y empuja vídeo hacia fuera.

## 1. Preparación

1. Clave de emisión de YouTube (Studio → Emitir en directo → Clave de emisión).
2. En el host del stack: `infrastructure/scripts/init-secrets.sh` y pegar la
   clave en `infrastructure/secrets/stream_key.txt` (archivo con `umask 077`).
   **La clave nunca va al repo, ni a variables de entorno, ni a logs**: el
   supervisor la lee de `/run/secrets/stream_key` y redacta cualquier texto
   que salga por el logger o por la API de control (revisión automatizada en
   `apps/streamer/src/streamer.test.ts`).
3. Arrancar el perfil: `docker compose --profile streaming up -d streamer`.

## 2. Operación de un evento

La vista se autoconfigura por query; el branding viaja por parámetros (T11.1,
sin redeploy):

```
http://web:3000/broadcast?tournament=<id>&event=Copa%20S9&logo=/img/copa.png&primary=%23112233&accent=%23ffb300
```

- `?tournament=<id>`: encadena automáticamente las batallas del torneo con
  pantallas de espera/intermedio/final (estado de E9 por la API pública).
- `?battle=<id>`: una batalla concreta.

Control de la emisión (API interna, red `platform`, puerto 8090 SIN publicar;
desde el host: `docker compose exec streamer wget -qO- http://localhost:8090/status`):

```
POST /control/start {"broadcastUrl": "http://web:3000/broadcast?tournament=t1&event=..."}
POST /control/stop
GET  /status      # estado, reintentos, métricas (el destino RTMPS sale redactado)
GET  /metrics     # Prometheus para E10: streamer_up, streamer_bitrate_kbps, streamer_fps,
                  # streamer_frames_total, streamer_dropped_frames_total, streamer_restarts_total
```

Cortes de RTMPS: el supervisor relanza FFmpeg solo (espera `STREAM_RETRY_DELAY_MS`,
hasta `STREAM_MAX_RETRIES` intentos seguidos; cualquier tramo con progreso
resetea el contador). Un corte de red de ~30 s se recupera sin intervención.

## 3. Codificación: x264 base, NVENC opcional

- **Base: x264 por software** (`STREAM_ENCODER=x264`, preset veryfast +
  zerolatency, 1080p30 ~4500 kbit/s). No exige nada del host: es lo que
  desbloquea el hito.
- **Opción NVENC** (`STREAM_ENCODER=nvenc`): exige que la VM del stack tenga
  **GPU NVIDIA con passthrough PCIe en Proxmox** (el dosier no lo señalaba;
  E11.M lo documenta aquí): IOMMU activado (`intel_iommu=on`/`amd_iommu=on`),
  la GPU en un grupo IOMMU propio, `hostpci0` en la VM, driver NVIDIA +
  `nvidia-container-toolkit` en el guest y `device_requests`/`gpus` añadidos al
  servicio `streamer` del Compose. Sin todo eso, dejar x264.

## 4. Modo «solo grabación» (E11.M, sin canal)

`STREAM_MODE=record` codifica a archivo en vez de emitir: FFmpeg escribe
`/data/replays/video/broadcast-<fecha>.mp4` (volumen `arena_replays`, misma
política de retención 23.1). No requiere clave de emisión. Útil para clips y
para ensayar eventos antes de tener canal.

## 5. Retardo anti-coaching en finales (E11.M)

El retardo de emisión (30–60 s recomendados para finales) **no se hace en
FFmpeg**: ya existe en el canal de espectador (`ruleset.spectator.delaySeconds`,
E8) y `/broadcast` lo hereda, con marcador y ticker sincronizados con el vídeo.
Configurarlo en el ruleset del torneo (ADR-000: todo por ruleset).

## 6. Etapa OBS en un PC (opcional, fuera del repo)

Alternativa manual para eventos presentados: una escena de OBS con una fuente
«Navegador» apuntando a la URL de `/broadcast` (1920×1080), micrófonos y
transiciones del realizador, emitiendo OBS a YouTube. Es un procedimiento
operativo, **no software del repo** (E11.M): el contenedor streamer queda
parado (`/control/stop`) para no emitir dos veces.

## 7. Prueba de emisión privada de 30 min (DoD T11.2 — pendiente de ejecución)

Evidencia a registrar aquí cuando haya canal y entorno con docker:

1. Emisión **privada** en YouTube Studio; clave en `stream_key.txt`.
2. `POST /control/start` con un torneo real de prueba (E9 dry-run o liga corta).
3. Durante 30 min: capturar `GET /metrics` cada minuto (bitrate estable, fps ≈ 30,
   `streamer_dropped_frames_total` sin crecer) y el panel de E10 con el tick del
   motor (DoD: sin degradación de la batalla).
4. Test de caos: cortar la red del contenedor 30 s
   (`docker network disconnect ... && sleep 30 && docker network connect ...`);
   la emisión debe recuperarse sola (ver `streamer_restarts_total`).
5. Revisión de fugas: `docker compose logs streamer | grep -c "$KEY"` = 0 y
   `docker inspect streamer` sin la clave (solo `STREAM_KEY_FILE`).

| Fecha | Duración | Bitrate medio | Cortes/reintentos | Tick del motor | Resultado |
|---|---|---|---|---|---|
| _pendiente_ | | | | | |
