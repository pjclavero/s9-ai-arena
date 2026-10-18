# Frontend web (panel React)

## Resumen

`apps/web` es una SPA hecha con React 19 y Vite 8 ([ADR-E7-003](../adr/ADR-E7-003-panel-react-vite.md)):

- **Enrutado**: por hash (`#/…`), con una tabla de rutas estáticas y página 404.
- **Estado**: local por componente, más un hook de recursos con estados `loading`/`error`/`ready`.
- **Comunicación**: un cliente HTTP único hacia `/api/v1`, con plazo (timeout) y clasificación única de errores.
- **Visualización**: Phaser 4 para el visor en directo, el reproductor y la vista de emisión; las páginas esperan a la señal real de arranque de Phaser.

En producción la sirve el contenedor `web` detrás del gateway, en el mismo origen que la API ([gateway.md](gateway.md)).

Cambios del cierre funcional 2026-10 (carril D): arranque de Phaser corregido ([TD-009](../roadmap/technical-debt.md#td-009)), lista de replays sin redirección a `http://` ([TD-014](../roadmap/technical-debt.md#td-014)), componentes comunes de estado, timeout, 404 y arranque con la API caída ([TD-022](../roadmap/technical-debt.md#td-022)), y E2E de navegador real canónico.

## Índice

- [Arquitectura](#arquitectura)
- [Routing](#routing)
- [Sesión y cliente API](#sesión-y-cliente-api)
- [Estados comunes y errores](#estados-comunes-y-errores)
- [Visor, reproductor y Phaser](#visor-reproductor-y-phaser)
- [Resultados de batalla](#resultados-de-batalla)
- [Mapa de páginas → endpoints](#mapa-de-páginas--endpoints)
- [Tests](#tests)
- [E2E de navegador](#e2e-de-navegador)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Arquitectura

| Ruta | Contenido |
|---|---|
| `src/main.tsx`, `src/App.tsx` | Arranque, tabla de rutas, navegación, *error boundaries*, 404, error de arranque |
| `src/api.ts` | Cliente HTTP con plazo, `fetchJson`, sesión |
| `src/errors.ts` | `ApiRequestError` y `describeApiError` (clasificación única) |
| `src/resource.tsx` | `useResource` y `ResourceView` |
| `src/ui/primitives.tsx` | `Panel`, `Button`, `LoadingState`, `ErrorState`, `FormError`, `EmptyState`, `StatusBadge` |
| `src/battle-result.ts` | Lectura tolerante del contrato BATTLE_RESULT |
| `src/pages/*.tsx` | Una página por ruta (incluida `NotFoundPage`) |
| `src/viewer/*` | Escena Phaser (`PhaserViewer.ts`), espera de escena (`scene-ready.ts`), cliente de espectador, `LiveFeed`, `ReplayPlayer`, HUD, niebla, minimapa, cámaras… |
| `src/broadcast/*` | Composición 1080p para emitir |

## Routing

`App.tsx` resuelve `window.location.hash` (por defecto `#/bots`):

1. **Emisión**: `/broadcast?battle=…|?tournament=…` (`matchBroadcastRoute`), sin panel ni login.
2. **Rutas públicas** (antes del login, `matchPublicRoute`): `#/viewer/<id>`, `#/replay/<id>?t=<tick>`, `#/live`, `#/ranking`.
3. **Mientras arranca**: «Recuperando sesión…». Si la API está caída (red, plazo o 5xx): «No se puede contactar con la plataforma» con «Reintentar» (ya **no** manda al login).
4. **Sin sesión**: `LoginPage`.
5. **Panel**: rutas con parámetros en `matchPanelRoute` (`#/tournaments/<id>/bracket`, `#/tournaments/<id>`, `#/battles/new`, `#/battles[?bot=<id>]`, anclada: `#/battles/<basura>` es 404) y estáticas en `STATIC_PANEL_ROUTES` (`bots`, `teams`, `tournaments`, `replays`, `maps/editor`, `maps`, `system`, `audit`, `roles`, `admin`), cada patrón anclado al segmento completo.
6. **Cualquier otro hash ⇒ `NotFoundPage`** (`data-testid="not-found"`), con «Volver» y enlaces principales.

**Registrar una ruta nueva** (A y C la piden en COORD o en su informe; la registra D o REVIEW): nombre en `StaticPanelRoute` + entrada en `STATIC_PANEL_ROUTES` + caso en `renderStaticPanel` + enlace en la `<nav>` si procede + test en `apps/web/tests/fc-d-ux-states.test.tsx`.

**La web sólo oculta enlaces; la autorización es de la API.**

## Sesión y cliente API

`src/api.ts`:

- **Peticiones**: base `/api/v1`, con `credentials:"include"`, JSON o `FormData`.
- **Plazo**: `API_TIMEOUT_MS = 15000` por defecto (`opts.timeoutMs` por llamada). Al vencer, `AbortController` aborta y se lanza `ApiRequestError(status 0, kind "timeout")`; un fallo de red da `kind "network"`.
- **Token**: el *access token* vive **sólo en memoria**; la persistencia es la cookie httpOnly `s9_refresh`.
- **Arranque y F5**: `bootstrapSession()` hace `POST /auth/refresh` y después `GET /users/me`. Devuelve `null` sólo si **no hay sesión** (400/401/403); si la API falla (red, plazo, 5xx) **lanza**, y el App muestra el error de arranque.
- **Interceptor único de 401** (salvo `/auth/*`): refresh compartido y reintento; si falla, `expireSession(...)`.
- **Respuestas**: no-ok ⇒ `ApiRequestError(status, body)`; si el cuerpo no es JSON (502 HTML del gateway) el mensaje nombra el estado. Un 200 con HTML donde se esperaba JSON también es error.
- **`fetchJson(url)`**: el mismo plazo y la misma clasificación para rutas fuera de `/api/v1` (replay-service): lo usan `ReplaysPage` (`/replays/`) y `ReplayPage` (índice y segmentos).

## Estados comunes y errores

Contrato publicado para todos los carriles (COORD.md, `[D]`):

| Pieza | Uso |
|---|---|
| `describeApiError(e)` | `{kind, title, detail, status?, retryable}`; `kind` ∈ validation (400/422), unauthorized (401), forbidden (403), notFound (404), conflict (409), unavailable (429/502/503/504), server (otros 5xx), timeout, network, unknown. Clasifica por forma (status/kind), no por `instanceof` |
| `<LoadingState label>` | `role="status"` «Cargando …» |
| `<ErrorState label error onRetry?>` | `role="alert"`, `data-error-kind`, título según el tipo, «No se pudo cargar *label*: *detalle real*», «Reintentar» y, en 401/404, un enlace de salida |
| `<FormError error>` | Errores de acciones: título + `body.message` + `details`/`fieldErrors`; `null` no pinta nada |
| `<EmptyState message action?>` | Lista vacía con siguiente paso |
| `ResourceView` | Pinta Loading/ErrorState con el error original |

Regla D2: **nunca** `.catch(() => {})` ni lista vacía tras un fallo. Páginas de D ya adaptadas: Login, Batallas, Replays, Reproductor, Visor, Emisión, Sistema, Administración, detalle de torneo.

Pendiente en páginas de otros carriles (avisado en COORD): `TeamsPage` (C) traga el error de carga; el error de «Crear bot» (A) sólo se ve con un bot abierto; `BattleNewPage` (C) traga el 403 de `/system/status`.

## Visor, reproductor y Phaser

**Arranque (TD-009, corregido).** En Phaser 4.2.1 las escenas del config se registran en `SceneManager.bootQueue`, en el evento `READY` del juego (asíncrono); hasta entonces `getScene` devuelve `null`. Ahora las tres páginas hacen:

```ts
game = createViewerGame(host, { targetFps: 60 });
const scene = await waitForViewerScene(game); // READY del juego + CREATE de la escena
```

`waitForScene` (`src/viewer/scene-ready.ts`) es puro: si el juego no está en marcha espera `Phaser.Core.Events.READY`; si la escena no ha llegado a `RUNNING`, espera `Phaser.Scenes.Events.CREATE`; rechaza con `SceneNotReadyError` si el juego se destruye o vence el plazo (15 s). Sin `sleep`.

**Reproductor** (`ReplayPage`): primero el índice (si no existe, no arranca Phaser), después Phaser, después la reproducción. `data-testid="replay-status"` expone `data-state` = loading → init → playing/paused → finished, o error con `data-error-kind`; `replay-tick` expone `data-tick`/`data-total`. Un segmento que falla a mitad se muestra («error al cargar el replay») con «Reintentar».

**Visor** (`ViewerPage`): `data-state` = init → connecting → live/reconnecting → finished, o rejected/offline/error. `SpectatorClient` trata como **definitivos** un 4xx al pedir el ticket (salvo 429) y los cierres 4400/4401/4403/4404 del gateway (4429 sigue siendo transitorio): emite `rejected` una vez y no reconecta. `wsUrl` relativo se ancla al origen (`wss:` bajo https). Ver [websocket.md](websocket.md).

**Emisión** (`BroadcastPage`): misma espera; un rechazo o fallo de arranque se escribe en el marcador.

## Resultados de batalla

`summarizeBattle` (`src/battle-result.ts`) lee el contrato de B (`battle-result/v1`: `winner`, `ticks`, `score`, `disqualified`, `endReason`, `agents`; `participants[].outcome`; `startedAt`/`finishedAt`; `replayAvailable`) y tolera la forma anterior de la base. `#/battles` muestra estado en texto, resultado («gana *equipo*», «empate», «sin ganador»), marcador, motivo de fin, aviso si los bots no fueron contenedores reales, descalificados, duración y enlace al replay (o «sin replay»). `failureKind = none` ya no se pinta como error; `failed` ya no se pinta «en cola».

## Mapa de páginas → endpoints

| Página | Ruta | Endpoints |
|---|---|---|
| Login | (sin sesión) | `POST /auth/register`, `POST /auth/login`, `GET /users/me` |
| Arranque | — | `POST /auth/refresh`, `GET /users/me`, `GET /catalog/versions`, `GET /catalog/{v}/modules` |
| Mis bots + Loadout | `#/bots` | `GET /bots?ownerId=`, `POST /bots`, versiones, loadouts, builds, publish (A) |
| Equipos | `#/teams` | `GET /teams`, `POST /teams`, `POST /teams/{id}/members` (C) |
| Torneos | `#/tournaments` | `GET /tournaments`, `POST /tournaments` |
| Detalle de torneo | `#/tournaments/<id>` | `GET /tournaments/{id}`, `GET /tournaments/{id}/battles` (cada 5 s), entradas, cierre |
| Cuadro | `#/tournaments/<id>/bracket` | `GET /tournaments/{id}/matches` |
| Batallas | `#/battles[?bot=]` | `GET /battles[?status=]`; filtro por bot en el cliente |
| Nueva batalla | `#/battles/new` | `GET /rulesets`, `GET /maps`, `GET /bots`, `POST /battles` (C/B) |
| Replays | `#/replays` | `GET /replays/` (replay-service, con barra final) |
| Reproductor | `#/replay/<id>?t=` | `GET /replays/{id}/index`, `GET /replays/{id}/segment` |
| Visor | `#/viewer/<id>` | `POST /battles/{id}/spectate-ticket`, WebSocket `/ws/spectate/<id>` |
| En directo | `#/live` | `GET /public/battles/live` |
| Ranking | `#/ranking` | `GET /standings?mode=` (la API resuelve la temporada activa, TD-029) |
| Mapas / editor | `#/maps`, `#/maps/editor` | (C) |
| Administración, Sistema, Auditoría, Roles | `#/admin`, `#/system`, `#/audit`, `#/roles` | `GET /admin/*`, `GET /system/status`, `GET /system/rbac`, `PUT /users/{id}/roles` |
| 404 | cualquier otro hash | — |

En desarrollo, `vite.config.ts` reenvía `/api/v1`, `/replays` (sin rewrite) y `/ws` (WebSocket, sin el prefijo), igual que el gateway.

## Tests

- **Unitarios** (vitest + jsdom, `apps/web/tests/`): 32 ficheros, 365 tests (rc=0 en `fc/dev-d-frontend`). `fc-d-ux-states.test.tsx` cubre plazo, clasificación, `ErrorState`/`FormError`, arranque con la API caída, 404, espera de escena con un juego falso que reproduce el orden de eventos de Phaser 4.2.1, rechazos terminales del espectador, `resolveWsUrl` y `summarizeBattle`.
- **E2E de navegador real**: ver la sección siguiente. Es la evidencia de Phaser real (los unitarios no la sustituyen).

## E2E de navegador

Directorio canónico `tests/browser/`, comando **`npm run test:browser`** (= `bash tests/browser/run.sh`, Node ≥ 22.15 y Docker local).

| Pieza | Qué es |
|---|---|
| `run.sh` | Orquesta el entorno aislado (también el `bot-build-worker`, el s9-docker-proxy LOCAL del repo y el `tournament-worker` con ejecución en contenedores), la fase **golden**, la sonda TD-028 y tres fases de Playwright; rc 0 sólo si todo pasa; resumen en `$S9_E2E_STATE/out/summary.txt` |
| `env/api-env.ts` | API real (`createApp`) sobre PostgreSQL embebido con `seedDev`+`seedContent` |
| `env/gen-nginx-confs.mjs` | Genera las confs del gateway (`infrastructure/gateway/nginx-behind-proxy.conf`) y del web (`infrastructure/docker/web/nginx.conf`) **reales**, sustituyendo sólo nombres de servicio y `listen`; añade un proxy TLS delante. Falla si la conf real deja de casar |
| `env/ticket-probe.ts` | Sonda TD-028: ticket firmado → TLS → gateway → worker |
| `specs/golden-path.spec.ts` | `@golden`: registro → 2 bots con build REAL → equipo → mapa → batalla REAL (contenedores) → visor en directo → stats → replay. Su batalla es la que usan la fase 1 (replay) y la sonda: ya no hay atajo `seed-replay` |
| `playwright.config.ts`, `specs/*.spec.ts` | Specs `@golden`, `@fase1` (todo vivo), `@fase2` (replay-service parado), `@fase3` (API parada) |

Navegador: `mcr.microsoft.com/playwright:v1.48.2-jammy@sha256:96dc479b…` (Chromium 130), `@playwright/test` 1.48.2 instalado en el contenedor desde `tests/browser/package-lock.json`. Todo escucha en `127.0.0.1`; los secretos son ficheros 0600 efímeros. Variables: `S9_E2E_STATE`, `S9_E2E_PORT_BASE` (38080), `S9_E2E_GREP`, `S9_E2E_KEEP=1`, `S9_E2E_SKIP_GOLDEN=1` (sin Docker para bots: la fase 1 de replay falla, no hay atajo), `S9_SANDBOX_ADVERTISE_HOST` (IP del host alcanzable desde los contenedores). La red Docker `arena` es compartida: se crea si falta y nunca se borra.

## Errores / limitaciones

- No hay subida de archivo de código (sólo pegar texto) ni pantallas de estadísticas, historial de rating, gestión de cuenta, 2FA, sesiones o borradores de mapa.
- Los identificadores se ven como UUID truncados.
- En móvil (375 px) no se ha vuelto a medir el desbordamiento del editor de mapas y del reproductor.
- El directo con una batalla viva se prueba en la fase golden (el marcador del visor recibe la baja decisiva); la emisión (`#/broadcast`) con batalla viva no tiene E2E.

## Estado actual

- **FUNCIONA ACTUALMENTE**: sesión persistente; arranque con API caída explicado; 404; estados comunes; lista de replays tras TLS; reproductor (lista → abrir → canvas → ticks → pausa → fin); visor hasta el ticket y rechazos explicados; resultados de batalla en `#/battles`.
- **FUNCIONA ACTUALMENTE** (integración REVIEW): visor con batalla VIVA (ticket real de la API → TLS → gateway → worker); TeamsPage, BattleNewPage y «Crear bot» usan `ErrorState`/`FormError`.
- **PARCIAL**: emisión (`#/broadcast`) con batalla viva sin E2E.
- **PENDIENTE**: lo enumerado en la sección anterior.

## Documentación relacionada

- Usuario: [Índice de usuario](../user/index.md), [Visor](../user/viewer.md), [Replays](../user/replays.md)
- Técnica: [api.md](api.md), [websocket.md](websocket.md), [replays.md](replays.md), [gateway.md](gateway.md)
- Desarrollo: [setup.md](../development/setup.md), [testing.md](../development/testing.md)

## Verificación

Verificado contra la rama `fc/dev-d-frontend` (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| Espera de READY + CREATE, sin sleep | CODE_VERIFIED | `apps/web/src/viewer/scene-ready.ts:58-94`; `PhaserViewer.ts:750`; `ReplayPage.tsx:124`, `ViewerPage.tsx:103`, `BroadcastPage.tsx:233` |
| Reproductor dibuja, avanza y termina en Chromium real tras TLS | RUNTIME_VERIFIED | `tests/browser/specs/replay.spec.ts` (fase1 rc=0); mutación «getScene directo» ⇒ 2 specs rojas (rc=1) |
| Sin 301 a `http://` en `/replays` | RUNTIME_VERIFIED | `replay.spec.ts` «GET /replays (sin barra)…»; mutación del gateway ⇒ `Location=http://…/replays/`, rc=1 |
| Plazo del cliente y clasificación | CODE_VERIFIED | `apps/web/src/api.ts:37,58`; `errors.ts:52`; `fc-d-ux-states.test.tsx` |
| F5 con API caída ⇒ error de arranque, no login | RUNTIME_VERIFIED | `degraded.spec.ts` @fase3 (API parada de verdad, rc=0); `App.tsx:229` |
| 502 real del replay-service ⇒ error con Reintentar | RUNTIME_VERIFIED | `degraded.spec.ts` @fase2 (rc=0) |
| 404 de rutas | RUNTIME_VERIFIED | `ux.spec.ts` «ruta desconocida…»; `App.tsx:112,294` |
| 403 real ⇒ «No tienes permiso» | RUNTIME_VERIFIED | `ux.spec.ts` (`#/system` como usuario normal) |
| Rechazo del visor sin bucle | RUNTIME_VERIFIED | `viewer.spec.ts` (1 sola petición de ticket); `spectator-client.ts:191,379` |
| React 19, Vite 8, Phaser 4.2.1 | CODE_VERIFIED | `package.json` |
