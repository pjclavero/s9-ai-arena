# Gateway (nginx)

## Resumen

El servicio `gateway` es un nginx 1.27 y es el **único** con puertos publicados. Enruta por prefijo
hacia web, api, el WebSocket de espectador (que vive en el tournament-worker), replay-service y
Grafana. Hay dos configuraciones versionadas, y `GATEWAY_CONF` elige cuál se monta:

| Fichero | Modo | TLS |
|---|---|---|
| `infrastructure/gateway/nginx.conf` | standalone | TLS en el gateway (:443); :80 redirige a https |
| `infrastructure/gateway/nginx-behind-proxy.conf` | detrás de un proxy inverso externo | el proxy externo termina TLS; el gateway sólo escucha HTTP :80 |

El despliegue actual usa el modo «detrás de proxy».

## Índice

- [Rutas](#rutas)
- [Cabeceras](#cabeceras)
- [WebSocket](#websocket)
- [El caso /replays](#el-caso-replays)
- [El 301 de /replays](#el-301-de-replays)
- [Lo que no hay](#lo-que-no-hay)
- [Configuración](#configuración)
- [Verificación](#verificación)

## Rutas

Las rutas son idénticas en los dos ficheros; en `nginx.conf` están en el bloque `server` de :443.

| `location` | Destino | Reescritura | Autenticación en el borde |
|---|---|---|---|
| `/healthz` | respuesta fija `200 ok` del propio nginx | — | no |
| `= /version` | `alias /etc/nginx/version.json` (identidad de build del gateway; sólo en el server :80) | — | no |
| `/api/v1/` | `http://api:8080` | `^/api/v1/(.*)$ → /$1` | la hace la API (JWT + RBAC) |
| `/ws/` | `http://tournament-worker:8081` | `^/ws/(.*)$ → /$1` (así, `/ws/spectate/<id>` llega como `/spectate/<id>`) | ticket verificado por el worker |
| `/replays/` | `http://replay-service:8083` | **sin** reescritura: el servicio registra sus rutas con el prefijo `/replays` | **ninguna** ([TD-004](../roadmap/technical-debt.md#td-004)) |
| `/grafana/` | `http://grafana:3000` | — | la de Grafana. Si el perfil `observability` no está activo, da 502 |
| `/` | `http://web:3000` | — | no (SPA) |

Los upstreams usan variables (`set $api_up …`) y `resolver 127.0.0.11` (el DNS interno de Docker).
Así se resuelven en caliente y el gateway arranca aunque un upstream no exista.

## Cabeceras

| Cabecera | Valor | Motivo |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | HSTS en el gateway (R2.6) |
| `X-Correlation-Id` | se conserva la del cliente o se genera con `$request_id` | trazabilidad entre servicios |
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for` | la API calcula `req.ip` con `TRUST_PROXY_HOPS` |
| `X-Forwarded-Proto` | en el modo «detrás de proxy», el que envía el proxy externo | — |
| `X-Real-IP`, `Host` | `$remote_addr`, `$host` | — |
| `client_max_body_size` | 20 MB | — |

Con un proxy externo delante hay **dos** saltos (proxy externo + gateway). Si `TRUST_PROXY_HOPS`
vale 1 (el valor por defecto), la API toma como IP del cliente la del proxy externo
([TD-012](../roadmap/technical-debt.md#td-012)).

## WebSocket

`/ws/` añade `Upgrade` y `Connection` (con un `map` de `$http_upgrade`) y `proxy_read_timeout 3600s`.
El ticket viaja en `Sec-WebSocket-Protocol` (`spectate.v1, ticket.<jwt>`) y **no** en la URL, para
que no quede en los logs de acceso. Ver [websocket.md](websocket.md).

## El caso /replays

Hasta [TD-004](../roadmap/technical-debt.md#td-004), `/replays/` exponía a través del gateway
**todas** las rutas del replay-service, incluidas las de lectura sin autenticación.

Desde la rama `prc/dev-sec` (**sin desplegar**), `location = /replays` y `location /replays/`
responden **404** JSON, sin `Location` y para cualquier método. El navegador lee los replays por
`/api/v1/replays/...`: la API es la única autoridad y aplica la política de acceso antes de
entregar bytes ([replays.md](replays.md#autorización-de-acceso-td-004)). El replay-service sólo es
alcanzable por la red interna.

Lo cubre `infrastructure/gateway/tests/replay-gateway.test.ts`, con nginx real y las dos confs del
repo. Re-exponer el `proxy_pass` lo pone en rojo.

## El 301 de /replays

> Histórico (corregido en FC-D y, desde TD-004, `/replays` ya no se enruta). En la base, la SPA
> pedía `fetch("/replays")`, sin barra final. nginx
sólo tiene `location /replays/`, así que responde **301** hacia `/replays/`. Esa redirección es
absoluta y se construye con el esquema con el que el gateway recibió la petición, que es `http`,
porque el TLS lo termina el proxy externo. El navegador está en una página `https`, bloquea la
redirección por **contenido mixto** y la página `#/replays` muestra «Servicio de replays no
disponible». En HTTP plano, sin TLS, sí funciona.

Se corrigió con `absolute_redirect off` y `location = /replays`; ver [TD-014](../roadmap/technical-debt.md#td-014).

## Lo que no hay

- **`/api/healthz` no existe:** cae en `location /` y devuelve la SPA con 200. Una sonda contra esa ruta siempre «pasa». Para sondear la API hay que usar `/api/v1/...` o el healthcheck interno del contenedor ([TD-020](../roadmap/technical-debt.md#td-020)).
- **`/replays/*` no llega al replay-service** (TD-004): 404 del propio gateway.
- **No hay limitación de tasa** en nginx (`limit_req`): los límites están en la API.
- **No hay página 404:** cualquier ruta desconocida la sirve la SPA.

## Configuración

| Variable | Uso |
|---|---|
| `GATEWAY_CONF` | fichero de configuración que se monta (por defecto `nginx.conf`) |
| `S9_DOMAIN` | dominio (modo standalone) |
| `HTTP_PORT`, `HTTPS_PORT` | puertos publicados en el host |

Los certificados se montan desde `infrastructure/secrets/tls` (sólo lectura) en el modo
standalone. La configuración de red del despliegue está en
[docs/operations/networking.md](../operations/networking.md).

> Nota: el comentario de cabecera de `nginx-behind-proxy.conf` contiene información de topología
> real ([TD-008](../roadmap/technical-debt.md#td-008)). No la copies a la documentación.

## Documentación relacionada

- [services.md](services.md#gateway) · [data-flow.md](data-flow.md) · [security.md](security.md) · [replays.md](replays.md) · [websocket.md](websocket.md)
- [docs/operations/networking.md](../operations/networking.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| `location` y destinos | CODE_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf` (bloque `server`); `nginx.conf:67-135` |
| :80 → 301 https en standalone | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:67` |
| Cabeceras | CODE_VERIFIED | `nginx-behind-proxy.conf`, bloque `http` (`proxy_set_header`, `add_header`) |
| Sin `limit_req` | CODE_VERIFIED | `grep limit_req infrastructure/gateway/*.conf` (vacío) |
| `/replays*` ⇒ 404 en el gateway (TD-004) | CODE_VERIFIED / RUNTIME_VERIFIED (entorno aislado) | `infrastructure/gateway/nginx.conf:124-132`; `nginx-behind-proxy.conf:103-111`; `infrastructure/gateway/tests/replay-gateway.test.ts` |
| 301 a http bloqueado en producción | BROWSER (auditoría, interna) | auditoría del 2026-10-15, pasada 2 ([resumen](../audits/2026-10-15/README.md)) |
| `/api/healthz` devuelve la SPA | RUNTIME_VERIFIED (en la auditoría) | GET al gateway |
| Escrituras de replay con secreto | CODE_VERIFIED | `apps/replay-service/src/server.ts:111,252` (`requireWriteAuth`) |
