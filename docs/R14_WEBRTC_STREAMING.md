# R14 · Streaming WebRTC (espectadores)

> Documentación y plan. **No implementa** nada. Bloque separado. No abre producción, no toca
> VM108/VM104/runner/proxy, no expone secretos.
>
> **RESUELTO (2026-07-20)**: la decisión final es **no implementar WebRTC** — ver
> `docs/R14_ADR_WEBRTC.md` (dictamen R14-ADR). Este documento se conserva como registro
> del diseño evaluado y de sus condiciones de reapertura.

## Orden y dependencias

**R14 va DESPUÉS de R11.** Secuencia de streaming:

1. **R11 — Spectator público interno** (foundation, gateado). Primero.
2. **R14 — WebRTC** (P2P para espectadores). Después.
3. **RTMP / YouTube / Twitch** — **mucho** después, fuera de alcance actual.

R14 **depende de**:

- **R11 spectator foundation** (canal/gateway de espectador ya existente y gateado).
- **API pública read-only** estable (`#/live`, endpoints `GET /public/...`).
- **Modelo de eventos estable** (formato de frames/eventos de batalla).
- **Replay/live feed estable** (para fallback).

## Diseño propuesto (no implementar aún)

- **WebRTC P2P** para espectadores: el feed de la batalla se distribuye por datachannel/media a los
  espectadores conectados, reduciendo carga del servidor.
- **Fallback** cuando WebRTC no negocia: **replay polling** o **SSE** (server-sent events) read-only.
- **Feature flag** (`S9_WEBRTC_ENABLED=0` por defecto). Off en producción.
- **Límite de espectadores** por batalla (evitar abuso de recursos).
- **Sin exponer secretos** ni `DOCKER_PROXY_URL` en el frontend; el señalizador no entrega tokens de
  ejecución ni credenciales de infraestructura.
- **TURN/STUN**: tema **futuro** (NAT traversal). De inicio, solo redes que permitan P2P directo o el
  fallback SSE/polling.

## Seguridad

- Read-only: los espectadores **nunca** pueden enviar comandos a bots ni disparar ejecución.
- No abrir puertos de producción ni cambiar dominios para esto.
- Señalización autenticada/limitada; sin filtrar IPs internas de infraestructura.

## Fuera de alcance (explícito)

- RTMP, YouTube Live, Twitch (ingest/broadcast a plataformas externas).
- Grabación/redistribución a CDN.

## Definición de done (cuando se autorice)

Diseño de señalización + flag off + límites + fallback SSE/polling documentados y con test de humo;
**no** se activa en producción. Depende de que R11 esté en main.
