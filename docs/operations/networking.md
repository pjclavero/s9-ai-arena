# Red, gateway, proxy inverso y TLS

## Resumen

Cómo se expone S9 AI Arena: un único servicio con puertos publicados (`gateway`), dos modos de
TLS (en el propio gateway o en un proxy inverso delante), qué rutas enruta el gateway y cómo
configurar `TRUST_PROXY_HOPS` para que la API vea la IP real del cliente, y la red interna de
control por la que los servicios alcanzan el s9-docker-proxy del host. Direcciones de ejemplo:
`192.0.2.x`, `arena.example.internal` (`10.89.250.0/24` es una constante de diseño del compose, no
una dirección de una instalación concreta).

## Índice

- [Puertos lógicos](#puertos-lógicos)
- [Rutas del gateway](#rutas-del-gateway)
- [Modo (a): TLS en el gateway](#modo-a-tls-en-el-gateway)
- [Modo (b): detrás de un proxy inverso](#modo-b-detrás-de-un-proxy-inverso)
- [TRUST_PROXY_HOPS](#trust_proxy_hops)
- [Exposición y superficie anónima](#exposición-y-superficie-anónima)
- [Red de control del docker-proxy (`bot-control`)](#red-de-control-del-docker-proxy-bot-control)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
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
| 2375 | docker-proxy, en el **host**, sólo en `10.89.250.1` (gateway de la red `bot-control`); ningún servicio lo publica ni lo expone | no al exterior ([red de control](#red-de-control-del-docker-proxy-bot-control), [docker-proxy.md](docker-proxy.md)) |

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

## Red de control del docker-proxy (`bot-control`)

### Qué es

El s9-docker-proxy corre en el **host** como unidad systemd (es el único proceso con el socket de
Docker; [docker-proxy.md](docker-proxy.md)). Los servicios que lanzan contenedores lo alcanzan por
una red Compose dedicada, interna y con todo fijo, porque la consumen piezas que viven **fuera** de
Compose (el proxy, el firewall del host y la CI):

| Constante | Valor |
|---|---|
| Clave en el compose / nombre Docker | `bot-control` / `s9-bot-control` (`name:` fijo) |
| Tipo | `bridge`, `internal: true` (sin ruta por defecto ni salida a Internet) |
| Bridge en el host | `s9-botctl0` (`com.docker.network.bridge.name`) |
| Subred / gateway | `10.89.250.0/24` / `10.89.250.1`, fuera de los pools por defecto de Docker (`172.17–31/16`, `192.168/16`) |
| Alias | `extra_hosts: ["docker-proxy.internal:10.89.250.1"]`: IP fija, **nunca** `host-gateway` |
| URL | `http://docker-proxy.internal:2375` |

`host-gateway` resuelve a la IP de `docker0`; desde un contenedor que sólo está en redes `internal`
no hay ruta hacia ella (`ENETUNREACH`). Ese fue el bloqueo de la RC1: los consumidores estaban en
redes internas y el alias apuntaba a `host-gateway`.

### Quién está en la red

Sólo los procesos que, **por código**, instancian `ProxyContainerRunner` desde su `SERVICE_ENTRY`
(el test lo comprueba por AST del grafo de imports):

| Servicio | ¿Consume el proxy? | Dónde | En `bot-control` | `DOCKER_PROXY_URL` por defecto |
|---|---|---|---|---|
| `tournament-worker` | sí | `apps/tournament-worker/src/main.ts` | sí | **vacía** ⇒ no reclama `run_battle` (interruptor del operador) |
| `bot-build-worker` | sí | `apps/bot-manager/src/build-worker-wiring.ts` | sí | `http://docker-proxy.internal:2375` |
| `arena-engine` | sí, si hay URL | `apps/arena-engine/src/service.ts` | sí | **vacía** ⇒ `/run` responde 503 |
| `bot-manager` | **no**: sólo exige la URL no vacía y la publica en `/healthz` | `apps/bot-manager/src/main.ts` | **no** | `http://docker-proxy.internal:2375` (inalcanzable desde aquí, a propósito) |
| api, web, gateway, map-service, replay-service, queue, postgres, backup | no | — | no | — |
| contenedores de bots | no | red `arena` únicamente | no | — |

Un servicio que pase a consumir el proxy sin entrar en la red, o uno que entre sin consumirlo, pone
en rojo `infrastructure/tests/bot-control-network.test.ts`.

### Lo que la red NO cierra

Una IP **propiedad del host** es alcanzable desde cualquier contenedor con ruta por defecto, aunque
no comparta red con ella. En `production` tienen ruta por defecto (alguna red no interna) **gateway**
y **backup** (red `public`); con el perfil `streaming` u `observability` también streamer y
alertmanager. Desde ellos `10.89.250.1:2375` conecta si nada más lo impide: medido, ver
[Verificación](#verificación). Esa conectividad residual la cierran las otras dos capas, cada una con
su prueba:

1. **Firewall del host** (como código): 2375 sólo desde `-i s9-botctl0` y origen `10.89.250.0/24`
   ([docker-proxy.md](docker-proxy.md)).
2. **Control de cliente en el propio proxy** (`DOCKER_PROXY_ALLOWED_CLIENTS=10.89.250.0/24`): un
   consumidor llega con origen en `10.89.250.0/24` (la ruta es la de la subred conectada); gateway y
   backup llegan con la IP de su red `public`, fuera de ese rango.

### Sonda de alcance

`scripts/ops/network-probe.mjs` mide desde **cada** contenedor de un proyecto Compose una conexión
TCP al proxy y la clasifica (`CONNECT`, `ENETUNREACH`, `TIMEOUT`, `REFUSED`, `ERROR:<código>`). Mide
con un contenedor efímero que comparte el espacio de red del medido (`--network container:<id>`),
sin privilegios y con la imagen de runtime node fijada en `runtimes/DIGESTS.lock`. Lo esperado se
deduce de la topología real del contenedor:

| Categoría | Condición | Esperado |
|---|---|---|
| `MEMBER` | está en `s9-bot-control` | `CONNECT` |
| `INTERNAL_ONLY` | todas sus redes son `internal` | `ENETUNREACH` |
| `DEFAULT_ROUTE` | alguna red no interna | se mide y se reporta; con `--expect-default-route-blocked`, cualquier cosa salvo `CONNECT` |

```bash
# Sólo lectura: crea y borra contenedores efímeros de sonda, no toca los del stack.
node scripts/ops/network-probe.mjs --project infrastructure \
  --expect-members arena-engine,bot-build-worker,tournament-worker
# rc 0 = todo según lo esperado · 1 = alguna expectativa falla · 2 = no se pudo medir
```

`--expect-members` fija además el conjunto de miembros: sin él, la sonda sólo comprueba que la
conectividad es coherente con la topología, no que la topología sea la correcta. `--json` da la
salida para la CI. `replica-compose --prefix <p>` emite un compose inerte derivado del render real
(mismas redes, flags `internal`, subred y `extra_hosts`, nombres con prefijo) para medir la
topología sin levantar la aplicación.

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| 502 en `/grafana/` | perfil `observability` no desplegado | ignorar o no publicar la ruta en el proxy |
| `/api/healthz` da 200 HTML | no es una ruta de la API | usar `/api/v1/healthz` |
| Login bloqueado para todos tras unos fallos | `TRUST_PROXY_HOPS` menor que los saltos reales | ajustar a `2` en modo (b) |
| Bucle de redirecciones | `nginx.conf` detrás de un proxy que ya termina TLS | usar `nginx-behind-proxy.conf` |
| El espectador en directo no conecta | `SPECTATE_WS_URL` no configurable por el compose y secreto ausente en el worker | [TD-028](../roadmap/technical-debt.md#td-028) |
| Un consumidor da `ENETUNREACH` a `docker-proxy.internal` | no está en `bot-control` o el alias apunta a otra IP | `config --format json` del servicio; la sonda lo clasifica como `INTERNAL_ONLY` |
| Un consumidor da `REFUSED` a `10.89.250.1:2375` | la red existe pero el proxy no escucha en esa IP (arrancó antes que el bridge, o bind distinto) | [docker-proxy.md](docker-proxy.md) |
| `Pool overlaps with other one on this address space` al crear la red | otra red del host ya usa `10.89.250.0/24` | liberar ese rango; la subred es parte del contrato del proxy y del firewall |
| gateway o backup dan `CONNECT` al proxy | ruta por defecto al host (red `public`); la red sola no lo impide | firewall del host y control de cliente del proxy (ver arriba) |

## Estado actual

- **FUNCIONA ACTUALMENTE (código y CI):** red `bot-control`, alias fijo `docker-proxy.internal` y
  firewall del host, en `main` desde RC2 y presentes en la base de RC3 (`4cc7651`). Los mide en cada PR
  y en `main` el check obligatorio `functional-e2e / container-proxy-e2e`.
- **SIN DESPLEGAR:** en producción (árbol `1b4d8eb`, lectura del 2026-10-22) no existe la red
  `bot-control` y el firewall no está aplicado ([TD-053](../roadmap/technical-debt.md#td-053)). El proxy
  antiguo, que escuchaba en `docker0`, está parado desde el 2026-10-22 por decisión del operador
  ([TD-062](../roadmap/technical-debt.md#td-062)). Ninguno de esos cambios afecta a las rutas públicas del gateway.
- **PENDIENTE:** inventario de las demás escuchas del host ([TD-063](../roadmap/technical-debt.md#td-063)).
  El orden de aplicación en producción está en [upgrades.md](upgrades.md#rc3-orden-del-despliegue-de-4cc7651).

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
| `bot-control`: nombre, bridge, subred, gateway, `internal`; sin solape con pools de Docker | CODE_VERIFIED | `infrastructure/tests/bot-control-network.test.ts` sobre `docker compose config --format json` |
| Miembros de `bot-control` = consumidores del proxy por código, en todos los perfiles | CODE_VERIFIED | mismo test (AST desde `SERVICE_ENTRY`); calibrado con mutaciones que lo ponen rojo |
| Ningún servicio usa `host-gateway`; ninguno publica ni expone 2375; ninguno usa la red del host | CODE_VERIFIED | mismo test, todos los perfiles |
| Ruta por defecto al host en `production`: sólo gateway y backup | CODE_VERIFIED | mismo test (`defaultRouteServices`) |
| Consumidores `CONNECT`; internos no consumidores `ENETUNREACH`; gateway y backup `CONNECT` sin firewall | RUNTIME_VERIFIED (Docker rootless, réplica `replica-compose` del render real, listener de prueba en `10.89.250.1:2375` dentro del netns de rootlesskit; no es el proxy real) | `scripts/ops/network-probe.mjs` (informe RC2 DEV-NET) |
