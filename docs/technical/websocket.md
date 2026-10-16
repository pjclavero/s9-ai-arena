# WebSocket de espectador (visor en directo)

## Resumen

El directo de una batalla se sirve por WebSocket desde el **gateway de espectador**. Este gateway vive **dentro del `tournament-worker`**, porque la simulación ocurre en ese proceso. El flujo es:

1. El cliente pide un **ticket firmado** a la API (`POST /api/v1/battles/{id}/spectate-ticket`).
2. Se conecta a `/ws/spectate/<battleId>` con el ticket como **subprotocolo**.
3. Recibe `init`, `snapshot`, `event`, `debug` y `result`.

Estado actual:

- el visor web arranca Phaser correctamente y pide el ticket ([TD-009](../roadmap/technical-debt.md#td-009), corregido en `fc/dev-d-frontend`);
- el worker recibe el MISMO secreto que la API (`jwt_secret` por fichero) y verifica los tickets; un test de compose exige esa coherencia ([TD-028](../roadmap/technical-debt.md#td-028), corregido en la rama, pendiente de despliegue);
- las batallas duran segundos, así que casi nunca hay nada «en directo».

## Índice

- [Qué es](#qué-es)
- [Flujo](#flujo)
- [Ticket](#ticket)
- [Conexión y cierres](#conexión-y-cierres)
- [Mensajes](#mensajes)
- [Cliente web](#cliente-web)
- [Configuración](#configuración)
- [Seguridad](#seguridad)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Es un canal de **sólo snapshots públicos** (regla D8: nunca observaciones privadas de un bot). Componentes:

- `SpectateGateway` en `apps/api/src/spectate/gateway.ts`, instanciado por `apps/tournament-worker/src/main.ts` en `SPECTATE_PORT` (8081 por defecto);
- la ruta `/ws/` del gateway nginx;
- el cliente `apps/web/src/viewer/spectator-client.ts`.

## Flujo

```text
Navegador ──POST /api/v1/battles/{id}/spectate-ticket──▶ API ─(firma ticket, 60 s)─▶ {ticket, wsUrl, expiresAt}
Navegador ──WS wsUrl, Sec-WebSocket-Protocol: spectate.v1, ticket.<jwt>──▶ nginx /ws/ ──▶ tournament-worker:SpectateGateway
worker: attachBattle(battleId, Battle) al empezar · bombeo cada 33 ms · detachBattle 3 s tras terminar
```

## Ticket

`getSpectateTicket` (`routes/battles.ts:445-482`):

- **Rol**: `visitor`, `security: []`.
- **Anónimo**: si `S9_PUBLIC_SPECTATE_ENABLED` está apagada (por defecto), un anónimo recibe **404** (Carril J). Con sesión siempre se emite.
- **Respuesta 201**: `{ticket, wsUrl: "<SPECTATE_WS_URL>/<battleId>", expiresAt}`.
- **Claims**: `{battleId, jti, debug, anon}`. `debug` es verdadero si el rol es ≥ `moderator`; la API lo firma y el cliente no se lo puede conceder.
- **Validez**: TTL de 60 s y un solo uso (por `jti`).
- **En producción**: si `SPECTATE_WS_URL` no empieza por `wss://`, la ruta responde `500 spectate_ws_misconfigured`.
- **Cuota**: anónima, `spectate-ticket`.

Nota: el runtime de producción mezcla versiones y tiene una API anterior a Carril J, que emitía tickets a anónimos sin bandera. Ver [current-status.md](../roadmap/current-status.md) y [TD-006](../roadmap/technical-debt.md#td-006).

## Conexión y cierres

URL esperada: `/spectate/<battleId>`. nginx reescribe `/ws/spectate/<id>` a `/spectate/<id>`. Códigos de cierre (`gateway.ts:185-248`):

| Código | Motivo |
|---|---|
| 4400 | `bad_request` o `ticket_in_url` (ticket en la URL: prohibido) |
| 4401 | `invalid_ticket` (firma, caducidad o secreto ausente) |
| 4403 | `ticket_battle_mismatch`, `public_spectate_disabled` (ticket anónimo con la bandera apagada en el worker), `ticket_already_used` |
| 4404 | `battle_not_live` (la batalla no está registrada en el gateway) |
| 4429 | `too_many_spectators` (100 por batalla por defecto) |

Los mensajes entrantes tienen un tope de 64 KiB.

## Mensajes

Todos son JSON con `type`:

| `type` | Contenido |
|---|---|
| `init` | `battleId`, `serverTimeMs`, `spectator:{allowFogView, delaySeconds, debug}`, `meta` (`mode`, `mapId`, `mapVersion`, `tournamentId`, `matchId`, `round`, `official`, `roster:[{id, botId, team, chassis, name}]`), `snapshot` (el último), `finished`, `result?` |
| `snapshot` | `snapshot` (snapshot público del motor: vehículos, proyectiles, marcador y objetivos), `serverTimeMs` |
| `event` | `event` (evento público del motor: marcador, banderas, destrucciones…) |
| `debug` | `tick`, `layers` (sólo para tickets con `debug`, y sólo si quien registró la batalla da capas) |
| `result` | `result` final; después el bombeo se detiene |

Si el ruleset declara `spectator.delaySeconds` (anti-*coaching*), los mensajes se retrasan ese tiempo. Las finales de torneo van sin retardo (`spectator_mode='visible'`). Los rulesets MVP actuales no declaran `spectator`.

## Cliente web

`SpectatorClient`:

- obtiene el ticket con `api("POST", …/spectate-ticket)`;
- abre `new WebSocket(wsUrl, ["spectate.v1", "ticket.<jwt>"])`;
- resuelve un `wsUrl` relativo (`/ws/spectate/<id>`) contra el origen de la página, con `wss:` si la página es https (`resolveWsUrl`);
- reconecta con *backoff* exponencial (1 s a 30 s, con *jitter*), pidiendo **un ticket nuevo** en cada intento, **salvo** ante un rechazo definitivo: 4xx al pedir el ticket (excepto 429) o cierre 4400/4401/4403/4404 (4429 sí es transitorio). Entonces emite `rejected` `{kind, status?, code?, reason}` una sola vez y se detiene;
- emite `init`, `snapshot`, `event`, `debug`, `result`, `disconnect`, `reconnected`, `gave_up` y `rejected`.

`ViewerPage` traduce esos eventos a estados (`data-state`: init, connecting, live, reconnecting, finished, rejected, offline, error) y textos explicativos por código ([frontend.md](frontend.md#visor-reproductor-y-phaser), [Visor de usuario](../user/viewer.md)).

## Configuración

Los valores concretos están en [configuration.md](../operations/configuration.md) (C).

| Variable | Servicio | Efecto |
|---|---|---|
| `SPECTATE_WS_URL` | API | Base del `wsUrl`; `wss://` obligatorio en producción. El compose no la entrega hoy ([TD-030](../roadmap/technical-debt.md#td-030)) y el valor por defecto `ws://localhost:8081/spectate` no sirve a un navegador: propuesta (para B/REVIEW) un valor relativo `/ws/spectate`, que el cliente ya admite |
| `S9_PUBLIC_SPECTATE_ENABLED` | API y worker | Espectador anónimo (apagado por defecto). Son dos controles independientes |
| `SPECTATE_PORT` | worker | Puerto del gateway |
| `JWT_SECRET_FILE` (o `SPECTATE_TICKET_SECRET_FILE`) | API (firma) y worker (verificación) | La clave del ticket se deriva por HKDF del mismo secreto: ambos montan `jwt_secret`. Lo exige `apps/api/src/spectate/ticket-secret-compose.test.ts` ([TD-028](../roadmap/technical-debt.md#td-028)) |

## Seguridad

- El ticket viaja en el subprotocolo, no en la URL, para no acabar en los logs de acceso.
- Un solo uso y TTL corto.
- El flag `debug` va firmado.
- El canal sólo lleva los arrays públicos de la batalla (`snapshots`, `publicEvents`).

Detalle transversal en [security.md](security.md) (A).

## Errores / limitaciones

- **Privilegio del worker**: para verificar tickets el worker recibe el secreto de SESIÓN (con él podría firmar tokens de sesión). Mejor: un `spectate_ticket_secret` dedicado montado en API y worker (`SPECTATE_TICKET_SECRET_FILE`); requiere tocar el bloque `api`, el `secrets:` de primer nivel e `init-secrets.sh` (propiedad de REVIEW; propuesto como deuda nueva).
- **Despliegue**: el cambio de compose exige **recrear** el `tournament-worker` (lo refleja `compose-canonical-check.test.ts`).
- **Directo casi imposible**: el worker simula sin ritmo de tiempo real (0,2–2,6 s por batalla en la auditoría) y desconecta a los 3 s.
- **`#/live`**: depende de `GET /public/battles/live`, que con la bandera apagada responde `{enabled:false}` («La emisión pública está desactivada»).

## Estado actual

- **FUNCIONA ACTUALMENTE**: emisión de tickets con sesión, protocolo del gateway y reconexión (cubiertos por tests: `spectator.e2e`, `gateway-hardening`, `j-fail-closed`).
- **FUNCIONA ACTUALMENTE (rama `fc/dev-d-frontend`, entorno aislado)**: ticket firmado por la API verificado por el worker a través de TLS → gateway real → worker (sonda: `4404 battle_not_live` con el secreto compartido, `4401` con uno ajeno); el visor pide un ticket y explica el rechazo sin bucle.
- **PARCIAL**: directo con una batalla viva en navegador (falta una batalla ejecutándose: carriles A/B); el despliegue en producción no se ha tocado.
- **PENDIENTE**: ritmo de tiempo real (o retardo) para que el directo tenga sentido.

## Documentación relacionada

- Usuario: [Visor y espectador](../user/viewer.md)
- Técnica: [frontend.md](frontend.md), [battles.md](battles.md), [replays.md](replays.md), [api.md](api.md)
- Arquitectura (A): [gateway.md](gateway.md), [data-flow.md](data-flow.md), [security.md](security.md)
- Histórico absorbido: R11 (espectador), runbook de *streaming* (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md)); [ADR-R14 WebRTC](../adr/ADR-R14-webrtc.md)

## Verificación

Verificado contra `27f70bb`; filas FC-D contra `fc/dev-d-frontend` (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| El gateway vive en el worker | CODE_VERIFIED | `apps/tournament-worker/src/main.ts:56-60,65` |
| nginx `/ws/` reescribe y hace *proxy* al worker | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf:78-84` |
| Ticket: 404 anónimo sin bandera; claims; TTL 60 s; `wss://` en producción | CODE_VERIFIED | `apps/api/src/routes/battles.ts:28-42,445-482` |
| Subprotocolos `spectate.v1` + `ticket.<jwt>` | CODE_VERIFIED | `apps/api/src/spectate/gateway.ts:41-47`; `apps/web/src/viewer/spectator-client.ts:195-201` |
| Códigos de cierre 4400–4429 | CODE_VERIFIED | `gateway.ts:185-248` |
| Mensajes `init`/`snapshot`/`event`/`debug`/`result` | CODE_VERIFIED | `gateway.ts:264-283,302-320` |
| `attachBattle` y `detachBattle` a los 3 s | CODE_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:208-254` |
| Visor roto en navegador en la base (main y producción) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1b/§4 |
| Worker con `jwt_secret` (FC-D) | CODE_VERIFIED | `infrastructure/docker-compose.yml:338-339`; test `apps/api/src/spectate/ticket-secret-compose.test.ts` (rc=0; quitar el secreto ⇒ 2 rojos, secreto ajeno ⇒ 1 rojo) |
| Ticket verificado en la cadena real TLS→gateway→worker | RUNTIME_VERIFIED | `tests/browser/env/ticket-probe.ts` desde `run.sh`: compartido `{"code":4404}`, ajeno `{"code":4401}` (TD028_PROBE_RC=0) |
| Rechazos terminales sin reconexión | RUNTIME_VERIFIED | `tests/browser/specs/viewer.spec.ts` (1 sola petición de ticket); `apps/web/src/viewer/spectator-client.ts:191,379` |
| En producción `/ws/` responde 426 | RUNTIME_VERIFIED | Auditoría B pasada 1 (GET anónimos) |
