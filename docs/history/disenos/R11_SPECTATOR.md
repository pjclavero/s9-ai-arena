# R11 · Espectador público (slice mínimo)

> Implementado en la rama `feature/r11-spectator`. Verificado leyendo
> directamente `apps/api/src/public-spectate.ts`, `apps/api/src/routes/battles.ts`,
> `apps/api/src/routes/system.ts`, `apps/web/src/pages/LivePage.tsx`, `apps/web/src/App.tsx`,
> `apps/api/src/r11-public-spectate.test.ts` y `apps/web/tests/live-page.test.tsx`. Diseño previo
> en `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md` (dictamen R11-B); este documento describe lo que
> **existe de verdad** en código, no el catálogo completo de endpoints propuesto allí.

## Qué es

Un slice mínimo de descubrimiento público: un único endpoint, `GET /public/battles/live`, que
permite listar las batallas en directo (`status = running`) **sin cuenta**, más la capability
correspondiente reflejada en `GET /system/status`. No es un producto de espectadores completo —
no añade estado público por batalla, ni marcador, ni enlace automático a replay al terminar (eso
sigue en el catálogo de `R11_PUBLIC_SPECTATOR_FOUNDATION.md`, pendiente de un slice posterior).

Apagado por defecto vía la capability `S9_PUBLIC_SPECTATE_ENABLED`.

## Decisión de transporte: reutilizar el WS existente

Este slice **no** crea ningún canal de observación en tiempo real nuevo. El transporte para ver
una batalla en directo ya existe y no se toca:

- **Gateway de espectador** (`apps/api/src/spectate/gateway.ts`) + ticket de un solo uso
  (`getSpectateTicket` / `signSpectateTicket`), que sirve snapshots públicos por WebSocket.
- **Visor** (`ViewerPage` / `SpectatorClient` / `PhaserViewer`), ya montado en la ruta pública
  `#/viewer/:battleId`.

`GET /public/battles/live` solo resuelve el problema de **descubrimiento**: qué batallas hay para
ver ahora mismo, sin necesitar ya el `battleId` de antemano. Una vez elegida una batalla en la
lista, el enlace apunta a `#/viewer/:id`, que consume el canal WS/ticket que ya existía.

Por qué no otras alternativas:

- **No** se reutiliza ni se extiende el **inspector de R13.1** (`apps/arena-engine/src/inspector.ts`).
  Ese inspector es una herramienta de depuración local por *polling* HTTP, sin autenticación,
  pensada para bind `127.0.0.1` en la misma máquina que ejecuta el motor — lo dice explícitamente
  `docs/R13_1_RUNTIME_INSPECTOR.md` ("no es la base de un producto de espectadores"). Servirlo a
  público externo requeriría añadirle autenticación, rate limiting y un modelo de exposición que
  no tiene y que no es su propósito.
- **No** se abre un WebSocket nuevo. El gateway existente ya resuelve la entrega en tiempo real
  con tickets de un solo uso y solo snapshots públicos; duplicarlo sería superficie de ataque
  adicional sin beneficio (mismo razonamiento que ya recogía la foundation: "reutilizar el
  gateway/ticket existente evita duplicar el canal WS").
- **No** se implementa WebRTC. Eso es `docs/R14_WEBRTC_STREAMING.md`, explícitamente posterior y
  dependiente de que R11 (esta base) esté cerrada — fuera de alcance de este slice.

## Capability y cómo activarla

```bash
# Variable de entorno leída por publicSpectateEnabledFromEnv() (apps/api/src/public-spectate.ts)
S9_PUBLIC_SPECTATE_ENABLED=1     # o "true" (case-insensitive); cualquier otro valor = apagado
```

- Apagada por defecto: ausente, `"0"`, `"false"` o cualquier valor distinto de `"1"`/`"true"` →
  `false`.
- Inyectable en `createApp({ publicSpectateEnabled: true|false })` para tests, sin depender de
  `process.env` real; si no se pasa explícitamente, `app.ts` cae al valor real del entorno
  (`cfg.publicSpectateEnabled ?? publicSpectateEnabledFromEnv()`).
- Se propaga a `battleRoutes()` (gatea el endpoint) y a `systemRoutes()` (la expone en
  `GET /system/status.publicSpectateEnabled`, solo lectura, para que la UI decida qué mostrar sin
  tener que llamar primero al endpoint público).

## Contrato del endpoint

`GET /public/battles/live` — operación `listPublicLiveBattles` en `apps/api/openapi.yaml`
(contrato 0.4.0, 59 operaciones totales, verificado por `conformance.test.ts`):
`security: []`, `x-min-role: visitor` (sin cuenta). Responde **200 siempre**, nunca 403/404.

### Capability apagada (por defecto)

No toca la base de datos en absoluto — corta antes de la consulta:

```json
{ "enabled": false, "battles": [] }
```

### Capability encendida, sin batallas en directo

```json
{ "enabled": true, "battles": [] }
```

### Capability encendida, con batallas en directo

```json
{
  "enabled": true,
  "battles": [
    {
      "id": "b7e1...",
      "status": "running",
      "mode": "deathmatch",
      "mapId": "mvp-arena-01",
      "mapName": "Arena MVP",
      "createdAt": "2026-07-19T10:00:00.000Z",
      "startedAt": "2026-07-19T10:00:05.000Z"
    }
  ]
}
```

Consulta real (`routes/battles.ts`): `battles` con `join maps` (para `mapName`), filtro
`status = running`, orden `started_at desc`, límite 50. Cabecera `Cache-Control: public,
max-age=5`.

## Campos públicos y qué se excluye deliberadamente

Campos servidos: `id`, `status`, `mode`, `mapId`, `mapName`, `createdAt`, `startedAt`,
`finishedAt` (este último no viaja — queda `undefined` — mientras la batalla sigue `running`).

Excluidos a propósito (seguridad — verificado explícitamente por test, incluida una
comprobación de que el JSON serializado no contiene el valor literal de la semilla ni del
commitment):

- `seed`, `seedCommitment`, `seedRevealProof` — la semilla determinista de la batalla nunca debe
  filtrarse mientras está en curso; revelarla permitiría predecir el resultado.
- `participants` — quién juega no es necesario para descubrir la batalla y evita exponer
  relaciones bot↔usuario sin necesidad.
- `result` — no aplica a una batalla `running`, y de tenerlo, es información que se sirve por el
  canal correcto (espectador/replay), no por el listado.
- `ticket`, `token` — el ticket de espectador WS es de un solo uso y se emite por el flujo
  existente (`signSpectateTicket`), no por este listado; no tiene sentido pre-filtrarlo aquí.

El resto de invariantes de seguridad del proyecto (sin secretos, sin stack traces, sin rutas
internas) se cumplen porque el endpoint es una proyección de columnas explícita — no hay
`SELECT *` ni serialización genérica de la fila de `battles`.

## Página `#/live`

- Ruta pública reconocida por `matchPublicRoute()` en `apps/web/src/App.tsx`
  (`/^#\/live(?:[/?]|$)/` → `{ kind: "live" }`), en el mismo lugar que `#/viewer` y `#/replay` —
  no requiere sesión.
- Enlace de navegación "En directo" añadido en la barra del panel (`App.tsx`), como atajo; la
  ruta en sí es accesible sin pasar por el panel autenticado.
- `LivePage` (`apps/web/src/pages/LivePage.tsx`) usa el patrón R3.7 (`useResource` +
  `ResourceView`, `ERR-VIS-10`): un fallo de carga se anuncia con `role="alert"` y botón
  "Reintentar", nunca se pinta como lista vacía.
- Tres estados de render, todos con `data-testid` propio para los tests:
  - `enabled: false` → aviso `live-disabled` ("La emisión pública está desactivada en este
    entorno."), no una lista vacía engañosa.
  - `enabled: true, battles: []` → `live-empty` ("No hay ninguna batalla en directo ahora
    mismo.").
  - `enabled: true, battles: [...]` → `live-battles`, cada fila enlaza a
    `#/viewer/<id>` (URL-encoded) mostrando `mapName · mode`.

## Tests y mutaciones

- **8 tests API** (`apps/api/src/r11-public-spectate.test.ts`): `publicSpectateEnabledFromEnv`
  (default OFF, solo `"1"`/`"true"` case-insensitive activan); `createApp()` sin
  `publicSpectateEnabled` explícito cae al entorno real (apagado en test); capability apagada →
  200 sin cuenta con `{enabled:false,battles:[]}` aunque haya batallas en directo sembradas;
  reflejo en `GET /system/status`; capability encendida → solo los 7 campos públicos esperados
  (comparación exacta de claves con `Object.keys(...).sort()`), ausencia explícita de
  `seed`/`seedCommitment`/`seedRevealProof`/`participants`/`result`/`ticket`/`token`, y el valor
  literal de la semilla/commitment sembrados no aparece en el JSON serializado; batallas
  `scheduled`/`finished` no aparecen en el listado `live`.
- **5 tests web** (`apps/web/tests/live-page.test.tsx`): `#/live` reconocida como ruta pública
  igual que `#/viewer`/`#/replay`; los tres estados de `LivePage` (desactivada, vacía, con
  listado y enlace correcto); fallo de carga anunciado con `role="alert"` + reintento que
  recupera el estado vacío tras reintentar.
- **6 mutaciones de no-vacuidad verificadas** sobre este slice: una de ellas destapó que el
  default de `publicSpectateEnabledFromEnv()` podía quedar mal cubierto (el test que fija
  `createApp()` sin `publicSpectateEnabled` explícito no existía) y se corrigió añadiendo el test
  correspondiente (`R11 · createApp() sin publicSpectateEnabled explícito usa el entorno real`).

## Limitaciones del slice

- **Solo batallas en directo (`running`)**: no lista batallas recientes/terminadas. La foundation
  original proponía un estado "recientes" además de "live"; este slice implementa únicamente el
  descubrimiento de lo que está corriendo ahora mismo.
- **Sin estado público por batalla**: no hay `GET /public/battles/:battleId` (marcador, tick,
  resultado) ni `GET /public/battles/:battleId/replay` (enlace a replay al terminar). El
  descubrimiento apunta directamente a `#/viewer/:id`, que ya resuelve ver la batalla vía el
  gateway existente, pero no hay endpoint público específico de detalle.
- **Sin alias público de replays** (`GET /public/replays`, `S9_PUBLIC_REPLAYS_ENABLED`): no
  implementado en este slice.
- **Activación en producción fuera de alcance**: este documento no autoriza ni recomienda
  activar `S9_PUBLIC_SPECTATE_ENABLED=1` en ningún entorno desplegado. Sigue apagado por defecto;
  la decisión de encenderlo en producción es del operador y está gateada a confirmación explícita
  (no forma parte de este slice de código).
- **Sin rate limiting propio**: el endpoint no aplica `anonQuota` (a diferencia de otros
  endpoints anónimos del router); solo tiene el `Cache-Control: public, max-age=5` como mitigación
  ligera de repetición. Queda como TODO si se decide activar en producción.

## Qué queda para más adelante

- Endpoints de detalle público por batalla y alias de replays (catálogo completo en
  `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md`).
- **R14 (WebRTC)**: explícitamente posterior y dependiente de que esta base de descubrimiento
  esté consolidada — no se adelanta aquí.
- Rate limiting específico del endpoint público si se decide exponerlo fuera de un entorno de
  confianza.
