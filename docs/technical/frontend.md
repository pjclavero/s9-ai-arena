# Frontend web (panel React)

## Resumen

`apps/web` es una SPA hecha con React 19 y Vite 8 ([ADR-E7-003](../adr/ADR-E7-003-panel-react-vite.md)):

- **Enrutado**: por hash (`#/…`) y escrito a mano.
- **Estado**: local por componente, más un hook de recursos con estados `loading`/`error`/`ready`.
- **Comunicación**: un cliente HTTP único hacia `/api/v1`.
- **Visualización**: Phaser 4 para el visor en directo, el reproductor y la vista de emisión.

En producción la sirve el contenedor `web` detrás del gateway, en el mismo origen que la API ([gateway.md](gateway.md)).

Problemas actuales relevantes:

- el visor y el reproductor fallan al arrancar Phaser ([TD-009](../roadmap/technical-debt.md#td-009));
- «Crear batalla» siempre recibe 400 ([TD-003](../roadmap/technical-debt.md#td-003));
- la lista de replays se rompe por un 301 a `http://` ([TD-014](../roadmap/technical-debt.md#td-014));
- hay errores tragados y estados poco claros ([TD-022](../roadmap/technical-debt.md#td-022)).

## Índice

- [Arquitectura](#arquitectura)
- [Routing](#routing)
- [Sesión y cliente API](#sesión-y-cliente-api)
- [Estado y recursos](#estado-y-recursos)
- [Formularios y errores](#formularios-y-errores)
- [Visor, reproductor y Phaser](#visor-reproductor-y-phaser)
- [Mapa de páginas → endpoints](#mapa-de-páginas--endpoints)
- [Tests](#tests)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Arquitectura

| Ruta | Contenido |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Arranque, rutas, navegación, *error boundaries* |
| `src/api.ts` | Cliente HTTP y sesión |
| `src/resource.tsx` | `useResource` y `ResourceView` |
| `src/ui/primitives.tsx` | Primitivas del sistema de diseño R16: `Panel`, `Button`, `LoadingState`, `ErrorState`, `EmptyState`, `StatusBadge` |
| `src/pages/*.tsx` | Una página por ruta |
| `src/viewer/*` | Escena Phaser (`PhaserViewer.ts`), cliente de espectador, `LiveFeed`, `ReplayPlayer`, HUD, niebla, minimapa, cámaras, interpolación, balística, efectos |
| `src/broadcast/*` | Composición 1080p para emitir |

Los estilos básicos están dentro de `index.html`. El validador de loadout del catálogo se compila dentro del panel (`LoadoutEditor`).

## Routing

`App.tsx` resuelve `window.location.hash` (por defecto `#/bots`):

1. **Emisión**: `/broadcast?battle=…|?tournament=…` (`matchBroadcastRoute`), sin panel ni login.
2. **Rutas públicas** (se pintan antes del login, `matchPublicRoute`):
   - `#/viewer/<battleId>`;
   - `#/replay/<battleId>?t=<tick>`;
   - `#/live`;
   - `#/ranking`.
3. **Mientras arranca**: «Recuperando sesión…».
4. **Sin sesión**: `LoginPage`.
5. **Panel**:
   - `#/tournaments/<id>/bracket` y `#/tournaments/<id>` (`matchPanelRoute`);
   - `#/battles/new` y `#/battles[?bot=<id>]`;
   - `#/tournaments`, `#/teams`, `#/replays`, `#/maps/editor`, `#/maps`;
   - `#/system`, `#/audit`, `#/roles`, `#/admin`;
   - **cualquier otro hash cae en «Mis bots»**. No hay página 404.

La navegación muestra «Mis bots, Equipos, Torneos, Batallas, Replays, Mapas, En directo, Ranking», el nombre y los roles del usuario, y «Salir». A un `admin` le añade «Administración, Sistema, Auditoría, Roles». **La web sólo oculta enlaces; la autorización es de la API.**

## Sesión y cliente API

`src/api.ts`:

- **Peticiones**: base `/api/v1`, con `credentials:"include"`, JSON o `FormData`.
- **Token**: el *access token* vive **sólo en memoria**. La persistencia es la cookie httpOnly `s9_refresh`.
- **Arranque y F5**: `bootstrapSession()` hace `POST /auth/refresh` y después `GET /users/me`.
- **Interceptor único de 401** (salvo en rutas `/auth/*`): hace un *refresh* compartido entre peticiones simultáneas y reintenta. Si falla, `expireSession("Tu sesión ha caducado. Vuelve a iniciar sesión.")`.
- **Errores**: cada respuesta no `ok` lanza `ApiRequestError(status, body)`. El mensaje que se ve es `body.message`.
- **Sin plazo**: `fetch` no tiene timeout. Una API que no responde deja «Cargando…» indefinidamente. Sólo el sondeo de builds tiene tope propio.
- **API caída al pulsar F5**: el refresh falla y se muestra el login, aunque la sesión no haya caducado ([TD-022](../roadmap/technical-debt.md#td-022)).
- **Excepción**: `ReplaysPage` usa `fetch("/replays")` directo (sin `/api/v1`) y `ReplayPage` lee `/replays/{id}/index|segment` del replay-service sin token. Ver [replays.md](replays.md).

## Estado y recursos

- `useResource(loader, deps)` devuelve `{status:"loading"|"error"|"ready", data, staleError?}` y un `reload({silent})`. El modo silencioso revalida sin desmontar el subárbol (B11).
- `ResourceView` pinta la carga y el error con «Reintentar».
- **Sondeo de builds** en «Mis bots»: cada 2 s, máximo 30 lecturas, con un tope de espera de 30 s por lectura. Al agotarse, la web dice «estado desconocido» en vez de inventar un final.
- **Torneo**: el detalle refresca sus batallas cada 5 s en silencio.

## Formularios y errores

| Pantalla | Problema |
|---|---|
| Login y registro | Formularios reales: Enter funciona, etiquetas visibles, `role="alert"` |
| «Mis bots» | El error de «Crear bot» sólo se pinta **dentro del detalle de un bot seleccionado**. Un 400 o un 500 al crear no se ve si no hay bot abierto |
| `TeamsPage` | Traga el error de carga (`refresh().catch(() => {})`): la tabla sale vacía |
| `#/battles` | `failureKind` siempre vale `'none'` en las batallas buenas y se pinta en rojo como «(none)» |
| Formularios de rol superior | Generar o publicar mapa, crear torneo y cerrar inscripciones se muestran a todos. Fallan después con «Requiere rol organizer» |
| `BattleNewPage` | Traga el 403 de `/system/status`, así que el botón real queda siempre deshabilitado para usuarios no admin |

En ningún sitio hay diálogos de confirmación ni gráficas.

## Visor, reproductor y Phaser

**Fallo de inicialización (estado actual, [TD-009](../roadmap/technical-debt.md#td-009)).** `ViewerPage.tsx:38`, `ReplayPage.tsx:75` y `BroadcastPage.tsx:228` hacen:

```ts
game = createViewerGame(host, { targetFps: 60 });          // new Phaser.Game({ scene: [ViewerScene], … })
const scene = game.scene.getScene("viewer");               // ← null: la escena aún no existe
```

En Phaser 4.2.1, las escenas declaradas en la configuración se registran en el evento `READY`, que es asíncrono; hasta entonces `getScene` devuelve `null`. Lo que pasa después depende de la página:

- **Visor**: `new LiveFeed(null)` llama a `scene.setPlaybackClock` y lanza `TypeError`. El `SpectatorClient` nunca llega a crearse: el estado se queda en «conectando…» sin pedir ticket.
- **Reproductor**: el índice y los segmentos se descargan, pero el lienzo queda vacío y «tick 0 / N» no avanza.
- **Emisión**: le pasa lo mismo.

Los tests usan jsdom con un Phaser simulado y no lo detectan. El test visual de aceptación sólo carga el login.

Funcionalidad implementada en la escena, cubierta por tests unitarios:

- vehículos con nómina (nombre y chasis), interpolación, balística y efectos de daño;
- minas, niebla de guerra (si el ruleset la permite) y capas de depuración (si el ticket lo permite);
- minimapa y objetivos (banderas, zonas, juggernaut);
- HUD con marcador, reloj, equipos y *kill feed*;
- cámaras global, por equipo y de seguimiento.
- El reproductor añade reproducir y pausar, velocidades de 0,5× a 8×, línea de tiempo con salto y enlace compartible con tick.

## Mapa de páginas → endpoints

| Página | Ruta | Endpoints |
|---|---|---|
| Login | (sin sesión) | `POST /auth/register`, `POST /auth/login`, `GET /users/me` |
| Arranque | — | `POST /auth/refresh`, `GET /users/me`, `GET /catalog/versions`, `GET /catalog/{v}/modules` |
| Mis bots + Loadout | `#/bots` | `GET /bots?ownerId=`, `POST /bots`, `GET /bots/{id}/versions`, `GET/POST /bots/{id}/loadouts`, `POST /bots/{id}/versions` (multipart), `POST …/actions/submit`, `GET …/versions/{v}/builds`, `POST …/actions/publish {codePublic:false}` |
| Equipos | `#/teams` | `GET /teams`, `POST /teams`, `POST /teams/{id}/members` |
| Torneos | `#/tournaments` | `GET /tournaments`, `POST /tournaments` |
| Detalle de torneo | `#/tournaments/<id>` | `GET /tournaments/{id}`, `GET /tournaments/{id}/battles` (cada 5 s), `GET /bots?ownerId=`, `POST …/entries`, `POST …/actions/close-entries` |
| Cuadro | `#/tournaments/<id>/bracket` | `GET /tournaments/{id}/matches` |
| Batallas | `#/battles[?bot=]` | `GET /battles[?status=]`; el filtro por bot se hace en el cliente, sobre la primera página |
| Nueva batalla | `#/battles/new` | `GET /maps`, `GET /bots`, `GET /system/status`, `POST /battles`, `POST /battles/{id}/run` |
| Replays | `#/replays` | `fetch("/replays")` al replay-service |
| Reproductor | `#/replay/<id>?t=` | `GET /replays/{id}/index`, `GET /replays/{id}/segment` (replay-service) |
| Visor | `#/viewer/<id>` | `POST /battles/{id}/spectate-ticket`, WebSocket `/ws/spectate/<id>` |
| En directo | `#/live` | `GET /public/battles/live` |
| Ranking | `#/ranking` | `GET /standings?mode=` (sin `seasonId`, ver [tournaments.md](tournaments.md#clasificación-y-rating)) |
| Mapas | `#/maps` | `GET /maps`, `POST /maps` (multipart), `POST /maps/generate`, `POST /maps/{id}/versions/{v}/actions/publish` |
| Editor de mapas | `#/maps/editor` | **ninguno** |
| Administración | `#/admin` | `GET /admin/security-findings`, `GET /admin/audit-log`, `GET /catalog/versions`, `PUT /users/{id}/roles` |
| Sistema | `#/system` | `GET /system/status` |
| Auditoría | `#/audit` | `GET /admin/audit-log?limit=100` |
| Roles | `#/roles` | `GET /system/rbac` |
| Emisión | `/broadcast?…` | Lo mismo que el visor y el detalle de torneo |

En desarrollo, `vite.config.ts` reenvía `/api/v1` y `/replay-service`, pero **no `/replays`**: la lista y el reproductor no funcionan con `vite dev` sin el gateway. Ver [setup.md](../development/setup.md).

## Tests

`apps/web/tests/` tiene 31 ficheros de vitest con jsdom: sesión, visibilidad de admin, editor de loadout, panel de builds (B11), página de nueva batalla (con la API simulada), editor de mapas, visor (`viewer-r16…r36`), `spectator.e2e`, reproductor y ranking. La auditoría los ejecutó: 339 tests en verde. **Ninguno ejercita Phaser real ni la costura web→API del `rulesetId`** ([TD-018](../roadmap/technical-debt.md#td-018)).

## Errores / limitaciones

- No hay página 404, el timeout del cliente ni subida de archivo de código (sólo pegar texto).
- Faltan pantallas para estadísticas, historial de rating, gestión de cuenta, 2FA, sesiones y borradores de mapa.
- Los identificadores se ven como UUID truncados.
- En móvil (375 px), el editor de mapas y el reproductor desbordan el ancho de la pantalla.

## Estado actual

- **FUNCIONA ACTUALMENTE**: sesión persistente, panel de bots y loadout, equipos, torneos, mapas (importar), ranking (aunque vacío), páginas de administración.
- **PARCIAL**: nueva batalla (400), lista de replays (301 en producción), editor de mapas (sólo cliente).
- **ROTO**: visor, reproductor y emisión en navegador.
- **PENDIENTE**: lo enumerado en la sección anterior.

## Documentación relacionada

- Usuario: [Índice de usuario](../user/index.md) y cada página de `docs/user/`
- Técnica: [api.md](api.md), [websocket.md](websocket.md), [replays.md](replays.md), [maps.md](maps.md), [bots.md](bots.md)
- Arquitectura (A): [gateway.md](gateway.md), [security.md](security.md)
- Desarrollo (C): [setup.md](../development/setup.md), [testing.md](../development/testing.md)
- Histórico absorbido: R16 (sistema de diseño y auditoría visual), R7, R8 y B11 (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| React 19, Vite 8, Phaser 4.2.1 | CODE_VERIFIED | `package.json:57-64` |
| Enrutado por hash, rutas públicas y de panel, sin 404 | CODE_VERIFIED | `apps/web/src/App.tsx:48-89,140-279` |
| Token en memoria, cookie, interceptor de 401 | CODE_VERIFIED | `apps/web/src/api.ts:303-418` |
| `getScene` inmediatamente después de `new Phaser.Game` | CODE_VERIFIED | `apps/web/src/pages/ViewerPage.tsx:37-42`; `ReplayPage.tsx:74-75`; `BroadcastPage.tsx:228` |
| `LiveFeed` llama a `setPlaybackClock` en su constructor | CODE_VERIFIED | `apps/web/src/viewer/live-feed.ts:97-103` |
| Visor y reproductor rotos en navegador real | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1b y §4 (Chromium 130) |
| Error de crear bot fuera del árbol visible | CODE_VERIFIED | `apps/web/src/pages/BotsPage.tsx:474-484,722-726` |
| `TeamsPage` traga el error | CODE_VERIFIED | `apps/web/src/pages/TeamsPage.tsx:33` |
| `BattleNewPage` traga el 403 de `/system/status` | CODE_VERIFIED | `apps/web/src/pages/BattleNewPage.tsx:66-71` |
| Vite no reenvía `/replays` | CODE_VERIFIED | `apps/web/vite.config.ts` |
| 339 tests web en verde | RUNTIME_VERIFIED | Auditoría B pasada 1 (cabecera) |
| Desbordamiento a 375 px en el editor y el reproductor | RUNTIME_VERIFIED | Auditoría B pasada 2 §1d |
