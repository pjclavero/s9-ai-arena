# Red, gateway, proxy inverso y TLS

## Resumen

Cómo se expone S9 AI Arena: un único servicio con puertos publicados (`gateway`), dos modos de
TLS (en el propio gateway o en un proxy inverso delante), qué rutas enruta el gateway y cómo
configurar `TRUST_PROXY_HOPS` para que la API vea la IP real del cliente. Direcciones de
ejemplo: `192.0.2.x`, `arena.example.internal`.

## Índice

- [Puertos lógicos](#puertos-lógicos)
- [Rutas del gateway](#rutas-del-gateway)
- [Modo (a): TLS en el gateway](#modo-a-tls-en-el-gateway)
- [Modo (b): detrás de un proxy inverso](#modo-b-detrás-de-un-proxy-inverso)
- [TRUST_PROXY_HOPS](#trust_proxy_hops)
- [Exposición y superficie anónima](#exposición-y-superficie-anónima)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Puertos lógicos

| Puerto | Dónde | Expuesto al host |
|---|---|---|
| `HTTP_PORT` (80) / `HTTPS_PORT` (443) | gateway | **sí** (único) |
| 3000 | web | no |
| 8080 | api | no |
| 8081 | arena-engine (HTTP interno y WebSocket de bots) · tournament-worker (WebSocket de espectador) | no |
| 8082 | map-service | no |
| 8083 | replay-service | no |
| 8084 | bot-manager | no |
| 5432 / 6379 | postgres / queue | no |
| 2375 | docker-proxy, en el **host** (interfaz del bridge de Docker), acotado por firewall | no al exterior ([docker-proxy.md](docker-proxy.md)) |

## Rutas del gateway

Iguales en `nginx.conf` (servidor `:443`) y `nginx-behind-proxy.conf` (servidor `:80`):

| Ruta | Destino | Notas |
|---|---|---|
| `/healthz` | el propio gateway | `200 ok` |
| `= /version` | `/etc/nginx/version.json` de la imagen del gateway | sólo en el servidor `:80`; identidad ADR-016 del **gateway**, no de los demás servicios |
| `/api/v1/` | `api:8080` (quita el prefijo) | `/api/v1/healthz` = salud de la API |
| `/ws/` | `tournament-worker:8081` (quita el prefijo) | WebSocket de espectador, `proxy_read_timeout 3600s` |
| `/replays/` | `replay-service:8083` (sin quitar prefijo) | **anónimo** ([TD-004](../roadmap/technical-debt.md#td-004)); `/replays` sin barra redirige a `http://` ([TD-014](../roadmap/technical-debt.md#td-014)) |
| `/grafana/` | `grafana:3000` | sin observabilidad desplegada → 502 |
| `/` | `web:3000` | SPA: cualquier ruta desconocida (p. ej. `/api/healthz`) devuelve la web con 200 |

`client_max_body_size 20m`. El gateway añade `X-Correlation-Id`, `X-Forwarded-For` y HSTS.

## Modo (a): TLS en el gateway

`GATEWAY_CONF=nginx.conf` (por defecto). El servidor `:80` sólo responde `/healthz` y `/version`
y redirige todo lo demás a `https://`. El `:443` usa `infrastructure/secrets/tls/fullchain.pem` y
`privkey.pem` (autofirmados por `init-secrets.sh`; sustituir por los reales).

```ini
# infrastructure/.env
GATEWAY_CONF=nginx.conf
HTTP_PORT=80
HTTPS_PORT=443
TRUST_PROXY_HOPS=1
S9_DOMAIN=arena.example.internal
```

## Modo (b): detrás de un proxy inverso

Un proxy (p. ej. Nginx en `192.0.2.4`) termina TLS y reenvía por HTTP al gateway del stack, que
escucha sólo en `:80`. `GATEWAY_CONF=nginx-behind-proxy.conf` respeta el `X-Forwarded-Proto` del
proxy.

```ini
# infrastructure/.env
GATEWAY_CONF=nginx-behind-proxy.conf
HTTP_PORT=8080          # puerto en la LAN que alcanzará el proxy
TRUST_PROXY_HOPS=2      # proxy + gateway
S9_DOMAIN=arena.example.internal
```

El proxy debe:

- enviar `X-Forwarded-For $proxy_add_x_forwarded_for` y `X-Forwarded-Proto $scheme`;
- pasar `Upgrade`/`Connection` para `/ws/` (WebSocket) con un `proxy_read_timeout` amplio;
- **no** publicar `/version` hacia fuera si no se desea mostrar la identidad del gateway;
- limitar con firewall que sólo él alcance `HTTP_PORT` del host.

## TRUST_PROXY_HOPS

Número de saltos de proxy de confianza delante de la API (Express `trust proxy`), del que depende
la IP de cliente usada por la cuota anónima y el bloqueo de fuerza bruta del login.

| Valor | Topología |
|---|---|
| `0` | sin proxy (tests); es el valor del **código** si la variable falta |
| `1` | sólo el gateway del stack — valor por **defecto del compose** (modo a) |
| `2` | proxy inverso + gateway (modo b) |

Nunca un valor mayor que los saltos reales: un cliente podría inventarse su IP con
`X-Forwarded-For`. Con un proxy delante y `1`, todos los clientes comparten la IP del proxy: esa es
la situación documentada en la auditoría para la instalación de referencia
([TD-012](../roadmap/technical-debt.md#td-012)).

## Exposición y superficie anónima

- Sin sesión responden, además de la web: `/api/v1/healthz`, las rutas públicas de la API
  (p. ej. `GET /teams`, que expone identificadores, [TD-011](../roadmap/technical-debt.md#td-011)),
  y todo `/replays/*` del replay-service ([TD-004](../roadmap/technical-debt.md#td-004)).
- Antes de abrir la instalación a Internet revisa la puerta de espectador y replays públicos
  ([../technical/replays.md](../technical/replays.md), [../technical/security.md](../technical/security.md)).
- La red `arena` es `internal`: los bots no tienen salida a Internet.

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| 502 en `/grafana/` | perfil `observability` no desplegado | ignorar o no publicar la ruta en el proxy |
| `/api/healthz` da 200 HTML | no es una ruta de la API | usar `/api/v1/healthz` |
| Login bloqueado para todos tras unos fallos | `TRUST_PROXY_HOPS` menor que los saltos reales | ajustar a `2` en modo (b) |
| Bucle de redirecciones | `nginx.conf` detrás de un proxy que ya termina TLS | usar `nginx-behind-proxy.conf` |
| El espectador en directo no conecta | `SPECTATE_WS_URL` no configurable por el compose y secreto ausente en el worker | [TD-028](../roadmap/technical-debt.md#td-028) |

## Documentación relacionada

[configuration.md](configuration.md) · [docker.md](docker.md) · [installation.md](installation.md) ·
[../technical/gateway.md](../technical/gateway.md) · [../technical/security.md](../technical/security.md) ·
[../technical/websocket.md](../technical/websocket.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Sólo el gateway publica puertos | CODE_VERIFIED | `ports:` en el compose (sólo `gateway`) |
| Tabla de rutas | CODE_VERIFIED | `infrastructure/gateway/nginx.conf:46-136`; `nginx-behind-proxy.conf:47-108` |
| `:80` de `nginx.conf` redirige a HTTPS salvo `/healthz` y `/version` | CODE_VERIFIED | `nginx.conf:52-67` |
| `/api/v1/healthz` JSON; `/api/healthz` HTML 200; `/grafana/` 502 | RUNTIME_VERIFIED | entorno aislado (gateway `nginx-behind-proxy.conf`) |
| `TRUST_PROXY_HOPS` 0 (código) / 1 (compose) / 2 (proxy) | CODE_VERIFIED | `apps/api/src/middleware/proxy-trust.ts:15-27`; compose `TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-1}` |
| Red `arena` `internal` con nombre explícito | CODE_VERIFIED | bloque `networks:` del compose |
