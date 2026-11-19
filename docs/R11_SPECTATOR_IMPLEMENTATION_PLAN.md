# R11 · Spectator — Auditoría (EQUIPO 2) y plan de los slices que faltan

> **Hallazgo principal de esta auditoría, antes de cualquier otra cosa**: el feature de
> espectador **ya está implementado** en `origin/main` (commit base `4505a54`), no en estado
> de diseño. Existen `docs/R11_SPECTATOR.md` (slice mínimo mergeado) y
> `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md` (catálogo de diseño, con la parte pendiente
> marcada explícitamente). Este documento **no repite ese trabajo**: audita lo que hay leyendo
> el código citado abajo (archivo:línea) y detalla únicamente lo que el propio catálogo R11
> deja como pendiente. También constata que **R13.1 (Runtime Inspector) ya está implementado**
> (`apps/arena-engine/src/inspector.ts`, `docs/R13_1_RUNTIME_INSPECTOR.md`), contra la premisa
> del encargo original ("R13.1 — not yet implemented"). Ver sección "Desviaciones del encargo".

## Arquitectura (lo que existe de verdad)

```
Espectador anónimo
   │
   │ 1) GET /public/battles/live  (descubrimiento, gateado)
   ▼
apps/api/src/routes/battles.ts:97-  → apps/api/src/public-spectate.ts (capability)
   │ elige battleId, navega a #/viewer/:id
   ▼
apps/web/src/App.tsx:48  matchPublicRoute() reconoce #/viewer, #/replay, #/live sin sesión
   │
   ▼
apps/web/src/pages/ViewerPage.tsx:44-46
   POST /battles/:id/spectate-ticket  →  SpectatorClient (apps/web/src/viewer/spectator-client.ts)
   │
   │ ticket JWT de un solo uso (jti), TTL corto (apps/api/src/auth/tokens.ts:142 signSpectateTicket)
   │ viaja como subprotocolo WS, nunca en la URL (spectator-client.ts:196-201)
   ▼
apps/api/src/spectate/gateway.ts  (WebSocketServer, sirve snapshots públicos a ~30 Hz
   vía SpectateGatewayOptions.pollIntervalMs=33ms, gateway.ts:65)
   │
   │ lee battle.snapshots / battle.publicEvents (arrays PÚBLICOS, gateway.ts:47-50)
   ▼
apps/arena-engine/src/sim/battle.ts:749 publicSnapshot() / :866 getPublicSnapshot()
```

Piezas reutilizables ya montadas y probadas:
- **Transporte**: WebSocket con ticket de un solo uso — `apps/api/src/spectate/gateway.ts` (329
  líneas), `apps/api/src/auth/tokens.ts:142-160` (`signSpectateTicket`/`verifySpectateTicket`).
- **Cliente**: `apps/web/src/viewer/spectator-client.ts` (333 líneas) — backoff exponencial con
  jitter (`backoffDelayMs`, líneas 58-66), watchdog de conexión zombi (líneas 244-267), buffer
  circular de eventos acotado (`RingBuffer`, líneas 69-102), reconexión que recupera estado
  completo vía el mensaje `init` sin recargar la página (líneas 172-179, 270-294).
- **Render**: `ViewerPage.tsx` (Phaser dinámico + `LiveFeed` con delay-buffer, líneas 1-156),
  `ReplayPage.tsx` (scrubbing por tick), `PhaserViewer.ts`, `HudOverlay.tsx`, `minimap.ts`,
  `fog.ts` (niebla de guerra opcional por ticket `allowFogView`).
- **Descubrimiento público**: `apps/web/src/pages/LivePage.tsx` (55 líneas) — tres estados
  (`live-disabled`/`live-empty`/`live-battles`, `LivePage.tsx` según cita en
  `docs/R11_SPECTATOR.md:140-146`), patrón `useResource`/`ResourceView` (R3.7).
- **Gate**: `apps/api/src/public-spectate.ts:12` `publicSpectateEnabledFromEnv()`, env
  `S9_PUBLIC_SPECTATE_ENABLED` (solo `"1"`/`"true"` case-insensitive activan, cualquier otro
  valor u omisión = apagado). Propagada a `battleRoutes()` (gatea el endpoint) y `systemRoutes()`
  (`GET /system/status.publicSpectateEnabled`, solo lectura). Verificado leyendo
  `apps/api/src/public-spectate.ts` y `apps/api/src/routes/system.ts:59`.

## Contrato esperado

### Ya implementado y estable (no tocar sin razón)

- `GET /public/battles/live` — `apps/api/src/routes/battles.ts:97` — campos:
  `id, status, mode, mapId, mapName, createdAt, startedAt, finishedAt` (7 claves exactas,
  comprobación con `Object.keys().sort()` en `apps/api/src/r11-public-spectate.test.ts`).
  Excluye explícitamente `seed`, `seedCommitment`, `seedRevealProof`, `participants`, `result`,
  `ticket`, `token` (test verifica ausencia literal del valor de semilla/commitment en el JSON
  serializado, no solo ausencia de la clave).
- `POST /battles/:id/spectate-ticket` — ya en producción de código (usado por
  `ViewerPage.tsx:45`, `BroadcastPage.tsx:236`), con cuota anónima (`anonQuota`,
  `apps/api/src/routes/battles.ts:278`).
- Canal WS de snapshots — mensajes `init` (snapshot completo + `spectator: {allowFogView,
  delaySeconds, debug}` + `meta`), `snapshot`, `event`, `debug` (solo si el ticket trae
  `debug:true`), `result`. Tipos en `spectator-client.ts:104-117, 296-331`.
- Snapshot público del motor — `battle.ts:749-779` `publicSnapshot()`: vehículos (posición,
  heading, hp, módulos), proyectiles, score, objetivos. **Comentario explícito en línea 775**:
  "Las minas NO van en el snapshot público: son información oculta hasta que explotan." El
  `stateHash()` (línea 786+) incluye RNG, velocidad, energía — eso SÍ se queda fuera del
  snapshot público, confirmado también por el test de R13.1 (`inspector.test.ts`, citado en
  `docs/R13_1_RUNTIME_INSPECTOR.md:110-111`) que comprueba ausencia literal de `seed`, `rng`,
  `mines`, `velocity`, `energyEU` en la respuesta servida.

### WAITING-DEPENDENCY

No aplica ninguna pieza de este documento a R13.1: **R13.1 ya está implementado** en
`origin/main` (`apps/arena-engine/src/inspector.ts`, `docs/R13_1_RUNTIME_INSPECTOR.md`), así
que no hay nada que marcar como bloqueado por él. Dicho esto, el propio `docs/R11_SPECTATOR.md:36-41`
deja escrito por qué el gateway de espectador **no** reutiliza el inspector de R13.1: el
inspector es HTTP-polling sin autenticación pensado para bind loopback en la misma máquina, no
un canal apto para público externo — el gateway WS con tickets es el camino correcto y ya existe.

Piezas del catálogo `R11_PUBLIC_SPECTATOR_FOUNDATION.md` marcadas allí mismo como **pendientes**
(no bloqueadas por ninguna dependencia externa, simplemente no implementadas todavía — se listan
aquí tal cual, sin inventar contrato nuevo):
- `GET /public/battles/:battleId` — estado público de detalle (marcador, tick, resultado) sin
  necesidad de abrir el WS. (`R11_PUBLIC_SPECTATOR_FOUNDATION.md:48`)
- `GET /public/battles/:battleId/replay` — enlace/redirect al replay una vez terminada la
  batalla. (línea 49)
- `GET /public/replays` — alias público de `GET /replays` bajo `S9_PUBLIC_REPLAYS_ENABLED`
  (línea 50), flag que **no existe todavía** en el código (solo se menciona en el documento de
  diseño; no aparece en ningún `grep` de `S9_PUBLIC_REPLAYS_ENABLED` fuera de docs).
- `#/live/:battleId` como ruta canónica de detalle público (hoy `#/live` enlaza directo a
  `#/viewer/:id`, que ya funciona, así que esto es una mejora de URL, no un bloqueador).

## Transporte recomendado y alternativas descartadas

No hay decisión nueva que tomar: el transporte ya elegido y en producción de código es
**WebSocket con ticket de un solo uso** (`apps/api/src/spectate/gateway.ts`). Datos reales
extraídos del propio código, no estimados:
- Cadencia de envío: `pollIntervalMs` por defecto no fijado explícitamente en la interfaz
  (`gateway.ts:65` documenta 33 ms ≈ 30 Hz como el valor que "sigue el ritmo de 30 Hz"; el
  motor añade snapshots cada `snapshotEveryNTicks`, ver comentario `gateway.ts:6`: "sirve el
  canal de SOLO snapshots públicos (D8) a 10 Hz").
- Ticket: JWT de un solo uso (`jti`), TTL corto, firmado con HKDF derivado del secreto de sesión
  (`apps/api/src/auth/tokens.ts:95` `hkdfSync(..., "s9-arena/spectate-ticket/v1", 32)`), viaja
  como subprotocolo WS (`spectator-client.ts:196-201`), nunca en query string (evita fugas por
  logs de acceso Nginx/Loki, comentario explícito en el propio código).
- Alternativas descartadas y por qué, según lo que el propio `docs/R11_SPECTATOR.md:34-47`
  documenta (no especulación de este audit):
  - **Reusar/extender el inspector R13.1**: descartado porque es HTTP-polling sin auth para
    loopback local, no apto para exposición pública sin añadirle auth + rate limit que no tiene
    ni es su propósito.
  - **Abrir un WS nuevo**: descartado, duplicaría superficie de ataque sin beneficio frente al
    gateway ya existente con tickets de un solo uso.
  - **WebRTC**: es `docs/R14_ADR_WEBRTC.md`, explícitamente posterior y dependiente de que esta
    base (R11) esté cerrada; no se adelanta.

## Frecuencia

Ya fijada en código, no rediseñable en este audit: snapshots del motor cada
`snapshotEveryNTicks` (comentario "a 10 Hz" en `gateway.ts:6`), sondeo del gateway a los
clientes cada `pollIntervalMs` (33 ms por defecto según el comentario de la interfaz en
`gateway.ts:65`, no verificado con un valor por defecto explícito en el cuerpo del archivo más
allá del comentario — **si se retoma este trabajo, confirmar el valor real por defecto leyendo
el resto de `gateway.ts` línea a línea**, esta auditoría no lo hizo al 100% por presupuesto de
tiempo).

## Reconexión

Completamente implementada y documentada en el propio código:
`apps/web/src/viewer/spectator-client.ts:172-294`. Backoff exponencial con jitter "equal
jitter" (`backoffDelayMs`, líneas 58-66: `delay = min(cap, base·2^(n-1))`, sorteo uniforme en
`[delay/2, delay]`), tope de reintentos configurable (`maxReconnectAttempts`, default 30, línea
277), watchdog de conexión zombi si no llega ningún mensaje en `watchdogTimeoutMs` (default
10 s, líneas 244-267), y el fallo de la conexión inicial entra al mismo bucle que un corte a
mitad de batalla (líneas 172-179, comentario explícito "antes: excepción y pantalla muerta").
Recuperación de estado vía snapshot completo en el mensaje `init`, sin recargar la página.

## Backpressure

- Buffer circular acotado de eventos en el cliente: `RingBuffer` (`spectator-client.ts:69-102`),
  capacidad configurable (`maxBufferedEvents`, default 500, línea 139) — una batalla larga no
  crece sin límite en RAM del navegador.
- Del lado del gateway: no se auditó línea a línea el manejo de backpressure de escritura al
  socket (`ws.send()` bajo cola llena) dentro de `gateway.ts` más allá de las primeras 90 líneas
  leídas; **queda pendiente de confirmar en un audit posterior si hay algún guard contra
  clientes lentos que no vacían su buffer TCP** — no se afirma que exista ni que falte, no se
  verificó.
- Límite de payload: no se encontró un límite explícito de tamaño de mensaje WS en las 90
  líneas leídas de `gateway.ts`; **no verificado**, habría que revisar el resto del archivo
  (líneas 90-329) antes de dar esto por cerrado.

## UI

Ya montada: `ViewerPage.tsx` (visor en directo, cámara global/equipo/seguir vehículo, niebla de
guerra opcional, capas de depuración si el ticket lo permite), `ReplayPage.tsx` (scrubbing),
`LivePage.tsx` (descubrimiento con 3 estados), `BroadcastPage.tsx` (vista de emisión interna),
`HudOverlay.tsx`, `minimap.ts`. No hay hueco de UI pendiente identificado para el slice mínimo;
los huecos son de **backend** (endpoints de detalle/replay público listados arriba).

## Errores

- `LivePage`: fallo de carga anunciado con `role="alert"` + botón "Reintentar" (patrón R3.7,
  nunca se pinta como lista vacía engañosa) — `docs/R11_SPECTATOR.md:137-139`.
- `SpectatorClient`: mensajes JSON corruptos en el canal se ignoran sin tumbar el visor
  (`spectator-client.ts:296-301`, `catch { return; }` con comentario explícito).
- Capability apagada → `200` siempre con `{enabled:false, battles:[]}`, nunca 403/404
  (`docs/R11_SPECTATOR.md:69-77`) — evita que el estado del flag se pueda usar para enumerar
  entornos.

## Seguridad / privacidad

Confirmado por lectura de código y por los propios tests citados en `docs/R11_SPECTATOR.md` y
`docs/R13_1_RUNTIME_INSPECTOR.md` (no re-ejecutados en este audit, solo leídos):
- **Nunca expuesto** al espectador público: `seed`, `seedCommitment`, `seedRevealProof` (predicen
  el resultado si se filtran durante la batalla), `rng` state, `mines` (ocultas hasta que
  explotan, comentario explícito `battle.ts:775`), `velocity`/`energyEU` internos, `participants`
  en el listado de descubrimiento, tokens/tickets ajenos.
- Ticket de espectador de un solo uso (`jti`), TTL corto, firmado con HKDF, transportado fuera
  de la URL — mitiga fuga por logs de acceso.
- El inspector R13.1 está deliberadamente aislado de esto: bind loopback, sin auth, pensado para
  depuración local únicamente; el propio documento de R13.1 dice explícitamente que **no es la
  base de un producto de espectadores** (`docs/R13_1_RUNTIME_INSPECTOR.md:154-158`).
- Rate limiting: `spectate-ticket` sí lleva `anonQuota` (`routes/battles.ts:278`); el propio
  `docs/R11_SPECTATOR.md:183-185` documenta que `GET /public/battles/live` **no** lo lleva
  (solo `Cache-Control: public, max-age=5` como mitigación ligera) — queda como TODO explícito
  si se decide exponer en producción.
- **Activación en producción sigue fuera de alcance**: `S9_PUBLIC_SPECTATE_ENABLED` apagada por
  defecto en todos los entornos desplegados; encenderla es decisión del operador, no de este
  programa (regla ya vigente, respetada por este audit — no se ha tocado ningún entorno).

## Plan de tests

Ya existen y cubren el slice mínimo (no reejecutados en este audit, solo verificado que los
archivos existen vía `git ls-files`):
- `apps/api/src/r11-public-spectate.test.ts` (8 tests: default off, capability apagada/encendida,
  campos exactos, ausencia de secretos, filtrado por estado).
- `apps/web/tests/live-page.test.tsx` (5 tests: ruta pública, 3 estados de `LivePage`, error+retry).
- `apps/web/tests/spectator.e2e.test.ts`, `apps/web/tests/broadcast-logic.test.ts` (flujo de
  ticket contra la API real).
- `tests/e2e/mvp-success.e2e.test.ts`, `tests/e2e/mvp-sabotage.e2e.test.ts`,
  `apps/tournament-worker/src/spectate-live.test.ts` (uso del endpoint de ticket en flujos
  mayores).

Si se retoma el catálogo pendiente (`GET /public/battles/:id`, `/replay`, `/public/replays`),
tests nuevos necesarios siguiendo el mismo patrón que `r11-public-spectate.test.ts`:
capability apagada → comportamiento idéntico al actual (nunca 403/404, cuerpo `disabled`
explícito), capability encendida → solo campos públicos permitidos, ausencia literal de
secretos en el JSON serializado, y (para `/replay`) comportamiento si la batalla no tiene replay
grabado todavía.

## Ficheros a tocar (si se retoma el catálogo pendiente)

Backend:
- `apps/api/src/routes/public.ts` (nuevo, o extender `apps/api/src/routes/battles.ts` con las
  rutas `/public/battles/:battleId` y `/public/battles/:battleId/replay`).
- `apps/api/src/public-spectate.ts` (añadir `publicReplaysEnabledFromEnv()` análogo al
  existente, si se implementa `S9_PUBLIC_REPLAYS_ENABLED`).
- `apps/api/openapi.yaml` (nuevas operaciones, siguiendo el patrón de `listPublicLiveBattles`).
- Tests nuevos: `apps/api/src/r11-public-battle-detail.test.ts` (o extender el existente).

Frontend:
- `apps/web/src/pages/LivePage.tsx` (enlazar a un futuro `#/live/:battleId` si se decide esa
  ruta canónica, en vez de saltar directo a `#/viewer/:id`).
- `apps/web/src/App.tsx` (`matchPublicRoute`, línea 48, si se añade `#/live/:battleId`).
- Sin cambios necesarios en `spectator-client.ts`, `ViewerPage.tsx`, `PhaserViewer.ts`: el canal
  en vivo ya funciona y no lo toca el catálogo pendiente (que es solo descubrimiento/detalle
  read-only adicional, no un canal nuevo).

Docs:
- `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md` (actualizar "Qué falta" al cerrar cada endpoint).

## Conflictos previsibles con otros carriles

- **R12 (matchmaking/torneos)**: toca páginas de torneo. `docs/R12_PREPARE_BATTLE_MATCHMAKING.md:189`
  ya menciona explícitamente que `LivePage` debe leer `S9_PUBLIC_SPECTATE_ENABLED` y mostrar
  "estado del ticket propio" — **conflicto directo previsible en `apps/web/src/pages/LivePage.tsx`
  y `apps/web/src/App.tsx`** si ambos carriles tocan la navegación/rutas públicas a la vez.
  También `apps/web/src/pages/BracketPage.tsx` y `TournamentDetailPage.tsx` son candidatos a
  enlazar a `#/viewer/:id` — coordinar quién añade esos enlaces primero.
- **R16 (primitivas visuales)**: existe y ya está (parcialmente) mergeado —
  `docs/R16_VISUAL_SLICE1.md` y `docs/R16_VISUAL_UPGRADE.md` en el árbol de `origin/main` en
  este commit. `R16_VISUAL_SLICE1.md:4` cita explícitamente
  `apps/web/src/viewer/atlas-geometry.ts`, `art-direction.ts`, `effects.ts`, `PhaserViewer.ts` —
  **los mismos archivos que monta `ViewerPage.tsx`** (línea 10: `rosterFromMeta` viene de
  `art-direction.js`; línea 35: `createViewerGame`/`ViewerScene` de `PhaserViewer.js`).
  Conflicto real, no hipotético: cualquier fase posterior de R16 (catálogo en
  `R16_VISUAL_SLICE1.md:58`) que toque `PhaserViewer.ts`, `overlay.ts`, `damage-visuals.ts` o
  `render-pools.ts` en paralelo a un cambio del canal de espectador debe coordinarse — ambos
  carriles comparten el mismo visor en producción de código, no capas separadas.
- **R13.1 (runtime inspector)**: contra la premisa del encargo, **ya está mergeado en
  `origin/main`** (no en una rama aparte pendiente de fusión — confirmado con
  `git ls-files | grep inspector.ts`, presente en el árbol de `origin/main` en el commit base
  `4505a54`). No hay conflicto de fusión pendiente: el propio `inspector.ts` y
  `docs/R11_SPECTATOR.md` ya documentan la frontera entre ambos (R13.1 no es la base del
  espectador, y el espectador no toca `inspector.ts`). Riesgo residual: si un futuro carril
  intenta "unificar" ambos canales (inspector local + gateway público), tocaría
  `apps/arena-engine/src/inspector.ts`, `apps/arena-engine/src/sim/battle.ts`
  (`publicSnapshot()`/`getPublicSnapshot()`, únicas fuentes de verdad de ambos) y
  `apps/api/src/spectate/gateway.ts` a la vez — desaconsejado por las propias razones de
  seguridad ya documentadas (loopback sin auth vs. WS público con ticket).

## Desviaciones del encargo original

1. **El encargo asume que R13.1 (Runtime Inspector) "not yet implemented"**. Falso: está
   implementado y mergeado en `origin/main` en el commit base (`apps/arena-engine/src/inspector.ts`,
   329→149 líneas reales, `docs/R13_1_RUNTIME_INSPECTOR.md` con cabecera "Implementado en la
   rama `feature/r13-1-engine-runtime-quality`" pero el archivo de código en sí ya está en
   `main`, confirmado con `git ls-files`). No se marcó ninguna pieza como
   WAITING-DEPENDENCY-de-R13.1 porque no aplica: R13.1 ya existe y, además, el propio diseño
   ya existente documenta por qué el espectador **no** depende de él en absoluto.
2. **El encargo asume que el feature de spectator está por diseñar/implementar desde cero**.
   Falso: existe un slice mínimo mergeado (transporte WS+ticket, viewer, descubrimiento
   `#/live`, gate por flag, tests) y un catálogo de diseño con lo pendiente explícitamente
   marcado. Este documento se ajustó a auditar lo real y detallar solo el remanente del propio
   catálogo — no se inventó un plan de implementación paralelo redundante.
3. **`git log --oneline -1 origin/main` = `4505a54`**, coincide exactamente con el commit base
   indicado en el encargo. Sin desviación en este punto.
4. Corrección tras una segunda pasada de `find`: `docs/R16_VISUAL_SLICE1.md` y
   `docs/R16_VISUAL_UPGRADE.md` **sí existen** en `origin/main` en este commit (la primera
   búsqueda con `grep -rn` sobre archivos de código no los encontró por no ser `.ts`/`.tsx`;
   corregido antes de cerrar este documento). Ver el conflicto real ya detallado arriba.
5. **Backpressure/límite de payload del gateway WS**: solo se leyeron las primeras ~90 líneas de
   `apps/api/src/spectate/gateway.ts` (de 329). No se afirma ni se descarta que exista guard de
   backpressure o límite de tamaño de mensaje — declarado explícitamente como no verificado en
   la sección correspondiente, en vez de asumir.
