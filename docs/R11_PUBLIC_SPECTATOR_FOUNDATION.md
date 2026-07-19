# R11 · Spectator / streaming público interno (foundation — diseño)

## Estado actual / qué existe

- **Visor y reproductor**: `ViewerPage` (directo) y `ReplayPage` (replay con salto por tick),
  rutas públicas `#/viewer/:battleId` y `#/replay/:battleId` (`matchPublicRoute`, sin login).
- **Gateway de espectador**: `apps/api/src/spectate/gateway.ts` + ticket `getSpectateTicket`
  (un solo uso, canal WS servido por el gateway; SOLO snapshots públicos, nunca observaciones privadas).
- **Broadcast**: `BroadcastPage` + `broadcast/director` (vista `/broadcast`, E11) — captura interna.
- **Replays gestionados**: `GET /replays` (R7-A #50, pendiente de merge) + `#/replays`.

## Qué falta (gap R11)

- **Lista pública `#/live`**: batallas en directo / recientes, read-only, **gateada**.
- **Endpoints públicos** de solo lectura (mínimos, gateados).

## Alcance permitido (foundation, gateado)

Modo público read-only: lista de batallas live/recientes, abrir espectador, marcador,
bots/equipos, tick actual, estado, resultado, enlace a replay al terminar, overlay fullscreen,
y **estado `disabled`** si el modo público no está activo.

## Config (off por defecto)

```text
S9_PUBLIC_SPECTATE_ENABLED=0     # capability booleana en /system/status; NUNCA secretos
S9_PUBLIC_REPLAYS_ENABLED=0
```

## Rutas UI propuestas

```text
#/live              lista pública (gateada)
#/live/:battleId    espectador público
#/spectate/:battleId (alias)
```

## Endpoints propuestos (gateados; NO duplicar ViewerPage/replay existentes)

```text
GET /public/battles/live          → lista batallas running/recientes (solo campos públicos)
GET /public/battles/:battleId      → estado público (marcador, tick, resultado)
GET /public/battles/:battleId/replay → enlace/redirect al replay si disponible
GET /public/replays                → alias público de GET /replays (si S9_PUBLIC_REPLAYS_ENABLED)
```

Si hay eventos live: reutilizar el **ticket de espectador + WS del gateway** existente (no
crear un WS nuevo); alternativa SSE `GET /public/battles/:id/events` si se decide.

## Seguridad (crítica)

Solo lectura. **No** exponer `DOCKER_PROXY_URL`, envs, tokens, stack traces, rutas internas,
datos admin ni digests completos si se decide ocultarlos. Rate-limit (reutilizar `anonQuota`)
o TODO documentado. Modo **disabled por defecto**. Mensajes limpios. Sin CORS abierto nuevo.

## Fuera de alcance

RTMP, YouTube, Twitch, OBS, stream keys, emisión automática.

## Tests esperados

Spectator disabled por defecto; live list vacía; no expone secretos; replay público solo si
enabled; render `#/live`; overlay; error limpio si battle no existe; enlace a replay final.

## Riesgos / dependencias

- **Depende de R7-A (#50)** para `GET /replays` y el listado. Solape App.tsx (nueva ruta/nav).
- Reutilizar el gateway/ticket existente evita duplicar el canal WS (riesgo de seguridad).

## Primer PR recomendado

`feature/r11-public-spectator-foundation` (tras merge de #50): `LivePage` + `routes/public.ts`
gateado + capability en /system/status + tests + docs. Off por defecto.

## Dictamen

**R11-B** — diseño/contrato preparado; implementación pendiente (depende de #50).
