# API de plataforma (REST)

## Resumen

La API (`apps/api`, Express) es la única puerta de escritura de la plataforma. Detrás del gateway se publica bajo **`/api/v1`**; nginx quita el prefijo antes de llegar al proceso. El contrato es `apps/api/openapi.yaml`: cada ruta se registra por su `operationId` y el **rol mínimo sale de `x-min-role`**, así que no se puede montar una ruta sin RBAC. Hay **8 extensiones** fuera del contrato, registradas con `defineExtension`.

Autenticación:

- *access token* JWT de 15 min, enviado como Bearer;
- *refresh token* rotatorio, también en la cookie httpOnly `s9_refresh`;
- TOTP opcional.

## Índice

- [Estructura](#estructura)
- [Autenticación y sesión](#autenticación-y-sesión)
- [Autorización (RBAC)](#autorización-rbac)
- [Convenciones](#convenciones)
- [Errores](#errores)
- [Recursos por área](#recursos-por-área)
- [Extensiones fuera del contrato](#extensiones-fuera-del-contrato)
- [Límites de ritmo y cuotas](#límites-de-ritmo-y-cuotas)
- [Endpoints sin pantalla en la web](#endpoints-sin-pantalla-en-la-web)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Estructura

| Pieza | Fichero |
|---|---|
| Entrada | `src/server.ts`: `/healthz` y `/version` en un envolvente aparte; `trust proxy` = `TRUST_PROXY_HOPS` |
| App | `src/app.ts`: JSON ≤ 1 MB, contexto de petición (correlación), cabeceras de seguridad y CORS, autenticación, routers, 404 genérico y manejador de errores |
| Contrato | `openapi.yaml` + `src/openapi.ts` (carga y `ROLE_RANK`) |
| Registro | `src/registry.ts` (`defineOperation`, `defineExtension`, `rbacGuard`) |
| Routers | `src/routes/{auth,users,teams,bots,catalog,keys,admin,battles,standings,tournaments,maps,system}.ts` |
| Errores | `src/errors.ts` |

`servers` del contrato: `https://arena.example/api/v1`, un ejemplo.

## Autenticación y sesión

- **`POST /auth/register`**:
  - `{email, password ≥12, displayName ≤48}` → `201`;
  - **concede los roles `user` y `developer`**;
  - email duplicado: `409 email_taken`;
  - el registro **está abierto**: no hay invitación ni interruptor ([TD-012](../roadmap/technical-debt.md#td-012)).
- **`POST /auth/login`**:
  - `{email, password, totp?}` → `{accessToken, refreshToken, expiresIn}` y cookie `s9_refresh` (httpOnly, `SameSite=Lax`, `Secure` si la petición llegó por HTTPS);
  - errores: `401 Credenciales inválidas`; `401 Se requiere un código TOTP válido (2FA activo)`;
  - Argon2id con hash señuelo, para que el tiempo de respuesta no revele qué cuentas existen;
  - bloqueo por clave `IP|email` tras **20 fallos**, durante 15 min (`429`);
  - además, 60 intentos/min por IP.
  - La auditoría hizo 12 fallos seguidos y no obtuvo `429`, lo que encaja con el umbral de 20. La IP efectiva depende de `TRUST_PROXY_HOPS` ([security.md](security.md), [TD-012](../roadmap/technical-debt.md#td-012)).
- **`POST /auth/refresh`**:
  - acepta el token en el cuerpo o la cookie;
  - **rota** el token; reutilizar uno ya rotado revoca toda la familia;
  - vida deslizante de 14 días y absoluta de 30 días.
- **`POST /auth/logout`** (extensión): revoca la sesión de la cookie.
- **Otras**: `GET/DELETE /auth/sessions[/{id}]`, `POST/DELETE /auth/2fa`, `POST /auth/recover`, `POST /auth/reset`.
  - `recover` y `reset` son extensiones y no tienen transporte de correo.
- **Cambio de contraseña**: no existe.

## Autorización (RBAC)

Roles en orden de rango (`ROLES`, `migrations.ts:20`): `visitor < user < developer < team_captain < organizer < moderator < admin`. El rango es acumulativo: un rol superior hereda lo de los inferiores.

`rbacGuard`:

- con `x-min-role: visitor` deja pasar a anónimos;
- si hace falta sesión y no la hay, `401`;
- con rango insuficiente, `403 Requiere rol <rol>`.

La autorización por recurso va dentro de cada ruta (dueño del bot, capitán del equipo…). La matriz completa se consulta en `GET /system/rbac` (admin) y en la página `#/roles`.

## Convenciones

- **Paginación**: `?limit` (por defecto 20, máximo 100) y `?cursor` opaco (`created_at`+`id`), con `nextCursor` en la respuesta. Afecta a bots, batallas, mapas, torneos y equipos.
- **Transiciones** como acciones: `POST …/actions/{submit|publish|suspend|retire|close-entries|dry-run}`.
- **Caché**: hay `Cache-Control` en las lecturas públicas (5–60 s; los replays, `immutable`).
- **Correlación**: cada respuesta de error incluye `correlationId`.

## Errores

Forma única (`errors.ts`): `{error: <código>, message, correlationId, …extra}`.

| HTTP | Código | Ejemplos |
|---|---|---|
| 400 | `bad_request` | «rulesetId desconocido», «JSON inválido», «name obligatorio (máx. 48)» |
| 401 | `unauthorized` | Sin credencial o credencial inválida |
| 403 | `forbidden` | «Requiere rol organizer», «Solo el dueño del bot puede hacer esto» |
| 404 | `not_found` | Recurso inexistente **o no visible** (no revela existencia); «Ruta no encontrada» |
| 409 | varios | `illegal_transition` (con `currentState`, `allowedTransitions`), `bot_not_published`, `email_taken`, `immutable`, `already_entered`, `invalid_state`, `bot_version_not_eligible` (con `notEligible`), `entries_not_eligible` (con `notEligibleEntries`) |
| 413 | `source_too_large` | Código > 10 MB |
| 422 | `loadout_invalid` (`violations`), `map_invalid` (`checks`) | Validadores del catálogo y de mapas |
| 429 | `too_many_requests`, `too_many_running_battles` | Límites |
| 500 | `internal` | «Error interno»: excepciones no previstas, p. ej. importar el JSON del editor ([TD-010](../roadmap/technical-debt.md#td-010)) o carreras de doble envío ([TD-013](../roadmap/technical-debt.md#td-013)) |
| 503 | `real_battle_runs_disabled`, `runner_unavailable` | `/battles/{id}/run` |

## Recursos por área

Rol mínimo según `x-min-role`. «anón.» = `visitor` sin credencial.

**Cuentas y usuarios**:

| Método y ruta | Rol |
|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/refresh` | anón. |
| `GET /auth/sessions`, `DELETE /auth/sessions/{sessionId}`, `POST/DELETE /auth/2fa` | user |
| `GET /users/me`, `PATCH /users/me` (sólo `displayName`) | user |
| `GET /users/{userId}` | anón. |
| `PUT /users/{userId}/roles` | admin |

**Equipos**:

| Método y ruta | Rol |
|---|---|
| `GET /teams` | anón. (expone `captainId` y `memberIds`, [TD-011](../roadmap/technical-debt.md#td-011)) |
| `POST /teams` | user |
| `POST /teams/{teamId}/members`, `DELETE /teams/{teamId}/members/{userId}` | team_captain (y ser el capitán, o admin) |

**Bots** ([bots.md](bots.md)):

| Método y ruta | Rol |
|---|---|
| `GET /bots`, `GET /bots/{botId}`, `GET /bots/{botId}/versions` | anón. (filtrado por visibilidad) |
| `POST /bots`, `PATCH /bots/{botId}`, `POST /bots/{botId}/loadouts` | user (dueño) |
| `POST /bots/{botId}/versions` (multipart) | developer |
| `GET /bots/{botId}/versions/{version}/source` | user (reglas de visibilidad del código) |
| `POST …/versions/{version}/actions/submit` y `…/publish` | developer |
| `POST …/actions/retire` | developer |
| `POST …/actions/suspend` | moderator |
| `GET /builds/{buildId}` | developer |

**Catálogo** ([equipment.md](equipment.md)):

| Método y ruta | Rol |
|---|---|
| `GET /catalog/versions`, `GET /catalog/{catalogVersion}/modules` | anón. |
| `POST /catalog/versions` | admin |

**Mapas** ([maps.md](maps.md)):

| Método y ruta | Rol |
|---|---|
| `GET /maps`, `GET /maps/{mapId}/versions/{version}` | anón. |
| `POST /maps`, `POST /maps/drafts` | user |
| `POST /maps/generate`, `POST …/actions/publish` | organizer |
| `PUT /maps/{mapId}/versions/{version}` | admin (siempre 409) |

**Torneos y clasificación** ([tournaments.md](tournaments.md)):

| Método y ruta | Rol |
|---|---|
| `GET /tournaments`, `GET /tournaments/{id}/matches`, `GET /tournaments/{id}/team-standings` | anón. |
| `POST /tournaments`, `POST …/actions/close-entries`, `POST …/actions/dry-run` | organizer |
| `POST /tournaments/{id}/entries` | user |
| `GET /standings`, `GET /bots/{botId}/rating-history` | anón. |

**Batallas, espectador y replays** ([battles.md](battles.md), [websocket.md](websocket.md), [replays.md](replays.md)):

| Método y ruta | Rol |
|---|---|
| `GET /battles`, `GET /battles/{battleId}`, `GET /battles/{battleId}/audit`, `GET /battles/{battleId}/stats` | anón. |
| `POST /battles` | user |
| `POST /battles/{battleId}/run` | user |
| `POST /battles/{battleId}/spectate-ticket` | anón. (404 sin sesión con la bandera apagada) |
| `GET /replays/{battleId}`, `POST /replays/{battleId}/verify` | anón. (cuota) |
| `GET /public/battles/live`, `GET /public/battles/{battleId}` | anón. (bandera `S9_PUBLIC_SPECTATE_ENABLED`) |
| `GET /public/replays`, `GET /public/replays/{battleId}`, `GET /public/replays/{battleId}/download` | anón. (bandera `S9_PUBLIC_REPLAYS_ENABLED`) |

**Administración** ([../user/administration.md](../user/administration.md)):

| Método y ruta | Rol |
|---|---|
| `GET /admin/security-findings`, `GET /admin/audit-log` | admin |
| `GET /system/status`, `GET /system/rbac` | admin |

## Extensiones fuera del contrato

Están registradas con `defineExtension` y **no aparecen en `openapi.yaml`**. El test de conformidad las admite como extensiones documentadas.

| operationId | Método y ruta | Rol |
|---|---|---|
| `logout` | `POST /auth/logout` | visitor |
| `recoverAccount` | `POST /auth/recover` | visitor |
| `resetPassword` | `POST /auth/reset` | visitor |
| `getSigningPublicKey` | `GET /keys/artifact-signing` | visitor |
| `listBotLoadouts` | `GET /bots/{botId}/loadouts` | user |
| `listBotVersionBuilds` | `GET /bots/{botId}/versions/{version}/builds` | user |
| `getTournament` | `GET /tournaments/{tournamentId}` | visitor |
| `listTournamentBattles` | `GET /tournaments/{tournamentId}/battles` | visitor |

Fuera de `createApp`, en el envolvente: `GET /healthz` y `GET /version` (este último no se publica en el servidor TLS del gateway; ver [gateway.md](gateway.md)). `GET /metrics` sólo existe con la bandera de métricas.

## Límites de ritmo y cuotas

Los contadores se guardan en la tabla `api_usage`, compartidos entre réplicas.

| Ámbito | Límite |
|---|---|
| Registro | 30/min por IP |
| Login | 60/min por IP; bloqueo tras 20 fallos por IP+email |
| Refresh | 60/min |
| `POST /bots/{id}/versions` y `submit` | 60/hora cada uno |
| Rutas públicas anónimas | Cuota por ruta (300/hora por defecto), sólo para anónimos |
| `/battles/{id}/run` | Techo de batallas `running` (1 por defecto) |

## Endpoints sin pantalla en la web

`PATCH /users/me`, sesiones, 2FA, `recover` y `reset`, `GET /users/{id}`, quitar miembro de equipo, `GET/PATCH /bots/{id}`, código fuente, `suspend`, `retire`, `GET /builds/{id}`, `POST /maps/drafts`, `GET/PUT /maps/{id}/versions/{v}`, `POST /catalog/versions`, `dry-run`, `team-standings`, `/battles/{id}/audit`, **`/battles/{id}/stats`**, `GET /replays/{id}`, `POST /replays/{id}/verify`, **`/bots/{id}/rating-history`** y `/public/replays*`. Mapa completo de páginas a endpoints en [frontend.md](frontend.md#mapa-de-páginas--endpoints).

## Estado actual

- **FUNCIONA ACTUALMENTE**: contrato con RBAC, autenticación con rotación de refresh, paginación y validaciones.
- **PARCIAL**: falta cambio de contraseña y transporte de correo. Hay carreras que devuelven 500 ([TD-013](../roadmap/technical-debt.md#td-013)). Hay huecos de autorización por recurso ([TD-005](../roadmap/technical-debt.md#td-005)) y listados anónimos con identificadores ([TD-011](../roadmap/technical-debt.md#td-011)).
- **PENDIENTE**: incorporar las extensiones al contrato; cerrar la costura `rulesetId` ([TD-003](../roadmap/technical-debt.md#td-003)).

## Documentación relacionada

- Técnica: [frontend.md](frontend.md), [battles.md](battles.md), [bots.md](bots.md), [maps.md](maps.md), [tournaments.md](tournaments.md), [replays.md](replays.md), [websocket.md](websocket.md)
- Arquitectura (A): [security.md](security.md), [gateway.md](gateway.md), [database.md](database.md), [services.md](services.md)
- Operación (C): [configuration.md](../operations/configuration.md)
- Usuario: [Cuentas](../user/accounts.md), [Administración](../user/administration.md)

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| Rutas y roles del contrato (tablas anteriores) | CODE_VERIFIED | `apps/api/openapi.yaml` (operaciones con `x-min-role` volcadas con un script) |
| El rol mínimo sale del contrato | CODE_VERIFIED | `apps/api/src/registry.ts:20-60` |
| 8 extensiones con `defineExtension` | CODE_VERIFIED | `routes/auth.ts:297,384,399`; `routes/keys.ts:19`; `routes/bots.ts:217,236`; `routes/tournaments.ts:129,143` |
| Prefijo `/api/v1` quitado por nginx | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf:72-76` |
| Registro abierto con `user`+`developer` | CODE_VERIFIED | `apps/api/src/routes/auth.ts:148-174` |
| Bloqueo tras 20 fallos y límites de ritmo | CODE_VERIFIED | `apps/api/src/middleware/shared-rate-limit.ts:115-155`; `apps/api/src/app.ts:126-151` |
| 12 fallos sin 429 | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §5 |
| Rotación de refresh con revocación de familia | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/auth.ts:229-292`; auditoría B p2 §5 |
| TTL 15 min, 14 días y 30 días; cookie `s9_refresh` | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:25-32`; `routes/auth.ts:35,57-69` |
| Forma de los errores y 500 genérico | CODE_VERIFIED | `apps/api/src/errors.ts`; `app.ts:175-194` |
| Paginación con `limit` 20/100 | CODE_VERIFIED | `apps/api/src/serialize.ts:58-62` |
| Cuota anónima 300/hora | CODE_VERIFIED | `apps/api/src/middleware/anon-quota.ts:15-20` |
