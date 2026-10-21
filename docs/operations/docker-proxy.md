# Proxy de la API de Docker (host)

> **Estado:** vigente, revisado contra RC2 (`rc2/dev-proxy`, base `7cf88dd`). El proxy se instala en
> el host como unidad systemd y es el único proceso con `/var/run/docker.sock`. RC2 cambia su
> alcance de red (red dedicada `bot-control`) y su política (control de cliente, allowlist de
> imágenes y propiedad de contenedores). La **ejecución real de bots sigue apagada** por defecto:
> `DOCKER_PROXY_URL` vacío en `tournament-worker`/`arena-engine` (puerta del operador). Índice de
> operación: [index.md](index.md) · Seguridad: [../technical/security.md](../technical/security.md).

R-DEPLOY · R2 (R1.7 · ERR-SEC-02) · RC2. Este documento describe el **único proceso autorizado a
tocar `/var/run/docker.sock`** en el host. Ningún contenedor del stack monta el socket; los
consumidores lanzan contenedores de bots **sólo** a través de este proxy.

## Por qué existe

Montar el socket de Docker dentro de un servicio que procesa **código de usuario** equivale a RCE →
root del host. R1.7 retiró esa excepción: un proxy con allowlist media todas las operaciones. RC1
(2026-10) demostró que la allowlist de endpoints y de postura **no bastaba**: quien alcanzara el
proxy podía crear un contenedor con cualquier imagen fijada por digest y parar o inspeccionar
cualquier contenedor del host, `postgres` incluido (controles N20–N23 de OPS-C).

## Política (RC2)

Cuatro controles independientes, todos *fail closed*. Lógica en `apps/bot-manager/src/docker-proxy.ts`,
configuración del proceso en `apps/bot-manager/src/docker-proxy-config.ts`, entrypoint
`apps/bot-manager/src/docker-proxy-main.ts`.

| Control | Qué hace | Si falla |
|---|---|---|
| Cliente | Sólo atiende conexiones cuya **IP de origen del socket** está en `DOCKER_PROXY_ALLOWED_CLIENTS` (nunca una cabecera). | 403 crudo y cierre de la conexión sin leer la petición; queda registrado con la IP. |
| Imagen | El create sólo admite una imagen **idéntica** a una de la 3.ª columna de `runtimes/DIGESTS.lock` (`repo@sha256:…`). La base (2.ª columna), un tag, otro registro o un digest ajeno no entran. | 403; no se llama a Docker. Lock ilegible o vacío: el proxy no arranca. |
| Propiedad | El create **impone** `s9.managed=true` y `s9.proxy.instance=<DOCKER_PROXY_INSTANCE>`; el cliente no puede fijar ninguna label `s9.*`. `start`/`stop`/`json`/`stats` exigen el **Id completo** (64 hex, nunca nombre ni prefijo); el proxy inspecciona antes y sólo reenvía si el contenedor lleva esas labels. | Contenedor ajeno: 403, sin tocarlo. Inexistente: 404 (el runner lo trata como «ya parado»). |
| Postura | Allowlist de campos del create y `complianceViolations` (tabla 18.2): usuario del sandbox, `cap-drop ALL`, rootfs de sólo lectura, `no-new-privileges`, seccomp, sin `privileged`, sin bind-mounts ni volúmenes, sin namespaces del host, sólo red `arena` con endpoint `{}`, DNS bloqueado y **límites obligatorios** (memoria ≤ 1 GiB, CPU ≤ 2, PIDs ≤ 256, sin swap extra). | 403 con el motivo. |

Operaciones permitidas (todo lo demás → 403): `POST /containers/create`, `POST /containers/{id}/start`,
`POST /containers/{id}/stop[?t=0..300]`, `GET /containers/{id}/json`,
`GET /containers/{id}/stats?stream=false`. No hay `DELETE`, `wait`, `logs`, `kill` ni `exec`: los
flujos reales usan `AutoRemove` y `state()` sobre el inspect (`ProxyContainerRunner`), y no hay
código que necesite más.

## Alcance de red

El proxy escucha **sólo** en la IP de gateway de la red dedicada `s9-bot-control` (bridge del host
`s9-botctl0`, subred `10.89.250.0/24`, gateway `10.89.250.1`), y sólo la consumen los servicios que
crean contenedores (por AST: `bot-build-worker`, `tournament-worker` y `arena-engine`; el
`bot-manager` no). Desde el Compose:

```yaml
extra_hosts: ["docker-proxy.internal:10.89.250.1"]   # IP fija, nunca host-gateway
environment:
  DOCKER_PROXY_URL: http://docker-proxy.internal:2375
```

La red dedicada **no basta**: una IP propiedad del host es alcanzable desde cualquier contenedor con
ruta por defecto (redes no internas, como las de `gateway` y `backup`), compartan red o no. Por eso
hay tres capas, cada una con su prueba: la red (compose, ver [networking.md](networking.md)), el
firewall del host (2375 sólo desde `s9-botctl0`) y el **control de cliente del propio proxy**
(`DOCKER_PROXY_ALLOWED_CLIENTS=10.89.250.0/24`), que rechaza esos orígenes aunque lleguen al puerto.

## Configuración

`/etc/s9-ai-arena/docker-proxy.env` (plantilla `infrastructure/systemd/docker-proxy.env.example`):

| Variable | Valor de producción | Validación (el proxy no arranca si falla; exit 78) |
|---|---|---|
| `DOCKER_PROXY_BIND` | `10.89.250.1` | **Obligatoria**, IP literal. Prohibidos vacío, `0.0.0.0`, `::`, la IP de `docker0` y `host-gateway`/nombres. |
| `DOCKER_PROXY_PORT` | `2375` | Entero 1–65535. |
| `DOCKER_PROXY_ALLOWED_CLIENTS` | `10.89.250.0/24` | IP o CIDR separados por comas; prohibido `/0`. Obligatoria si el bind no es loopback; con bind loopback, por defecto sólo loopback. |
| `DOCKER_PROXY_IMAGE_ALLOWLIST` | (vacía) | Ruta a un `DIGESTS.lock`; por defecto el del árbol (`<APP_DIR>/runtimes/DIGESTS.lock`). Se lee al arrancar: cambiar el lock exige reiniciar el proxy. |
| `DOCKER_PROXY_INSTANCE` | `s9-docker-proxy` | Valor de `s9.proxy.instance`; `[A-Za-z0-9][A-Za-z0-9_.-]{0,62}`. |
| `DOCKER_SOCKET`, `ARENA_NETWORK`, `SANDBOX_USER` | `/var/run/docker.sock`, `arena`, `10001:10001` | — |
| `DOCKER_PROXY_INSECURE_BIND_FOR_TESTS` | **nunca en producción** | `1` admite bind comodín o de `docker0` (sólo tests; avisa en el log y sigue exigiendo clientes). |

Si el bind falla porque `s9-botctl0` aún no existe (`EADDRNOTAVAIL`), el proceso sale con 1 y la
unidad reintenta; nunca cae a otra dirección.

## Instalación

```bash
# En el host, con el repo desplegado en /opt/s9-ai-arena (APP_DIR):
sudo APP_DIR=/opt/s9-ai-arena bash infrastructure/scripts/install-docker-proxy.sh install
sudo nano /etc/s9-ai-arena/docker-proxy.env     # DOCKER_PROXY_BIND, DOCKER_PROXY_ALLOWED_CLIENTS…
sudo systemctl restart s9-docker-proxy
```

La unidad (`infrastructure/systemd/s9-docker-proxy.service`) corre como usuario dedicado `s9proxy`
(sin login) del grupo `docker`, con `Restart=always` y endurecimiento systemd. Las imágenes de
runtime deben estar ya en el host (el proxy no permite `pull`).

## Validación

```bash
sudo bash infrastructure/scripts/install-docker-proxy.sh validate
sudo journalctl -u s9-docker-proxy -f   # cada decisión allow/deny, con "client" (IP de origen)
```

La línea de arranque (`proxy de Docker escuchando en …`) lista `allowedClients`, la ruta y las
imágenes de la allowlist y la instancia. Comprobaciones de alcance, desde contenedores del stack:

| Desde | Esperado |
|---|---|
| un consumidor (`bot-build-worker`) | conecta; `GET /_ping` → 403 de la allowlist de endpoints |
| `gateway`, `backup` (redes no internas) | firewall: timeout; sin firewall, el proxy responde 403 `cliente no autorizado` |
| servicios sólo en redes internas que no son `bot-control` | `ENETUNREACH` |

## Rollback

```bash
sudo bash infrastructure/scripts/install-docker-proxy.sh rollback
# Para y retira la unidad; conserva config y usuario.
```

Volver a la política de RC1 no es un rollback admisible: reabre N20–N23.

> **DANGER** — borrado total del proxy
>
> **PRECONDITION:** el proxy ya está parado (`rollback`) y no se va a reinstalar con la misma
> configuración.
>
> **EFFECT:** elimina `/etc/s9-ai-arena` (configuración del proxy) y el usuario de sistema `s9proxy`.
>
> **ROLLBACK:** reinstalar con `install-docker-proxy.sh install` y rehacer la configuración.

```bash
sudo rm -rf /etc/s9-ai-arena && sudo userdel s9proxy
```

## Estado actual

- **FUNCIONA (código y tests):** control de cliente, allowlist de imágenes, propiedad por labels,
  bind que falla cerrado y límites obligatorios. Probado en proceso
  (`apps/bot-manager/tests/docker-proxy.test.ts`, CI normal) y contra Docker real con el proceso real
  del proxy (`apps/bot-manager/tests/docker-proxy-docker.test.ts`, opt-in `S9_RUN_DOCKER_SANDBOX_E2E=1`).
- **PENDIENTE (otros carriles de RC2):** red `bot-control` en compose, firewall del host, unidad y
  `docker-proxy.env.example` con las variables nuevas, y el E2E contenedor → proxy en CI.
- **Compatibilidad:** el arnés manual `scripts/e2e-real-battle-smoke.ts` usa una imagen
  `s9-smoke-bot` que no está en `DIGESTS.lock`; con RC2 hay que arrancar el proxy con un lock propio
  (`DOCKER_PROXY_IMAGE_ALLOWLIST`) que la incluya. Los contenedores creados antes de RC2 no llevan las
  labels y el proxy ya no los opera.

## Documentación relacionada

[docker.md](docker.md#otros-servicios) · [networking.md](networking.md#puertos-lógicos) ·
[configuration.md](configuration.md) · [../technical/bots.md](../technical/bots.md) ·
[../technical/security.md](../technical/security.md) · Informe de origen (R1.7):
[../history/rondas/ronda2/reportes/R1.7-docker-sock.md](../history/rondas/ronda2/reportes/R1.7-docker-sock.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `install|validate|rollback`, `APP_DIR`, `/etc/s9-ai-arena`, usuario `s9proxy` | CODE_VERIFIED | `infrastructure/scripts/install-docker-proxy.sh` |
| Bind obligatorio; vacío, comodín, `docker0` y nombres rechazados | CODE_VERIFIED + TEST | `docker-proxy-config.ts` (`proxyConfigFromEnv`); `docker-proxy.test.ts` «bind y configuración» y spawn del proceso real (exit 78) |
| Control de cliente por IP de origen | CODE_VERIFIED + TEST (proceso, Docker real) | `docker-proxy.ts` (`createDockerProxyServer`); `docker-proxy-docker.test.ts`: cliente de red ajena no interna → 403 |
| Allowlist de imágenes = 3.ª columna de `DIGESTS.lock` | CODE_VERIFIED + TEST (N20) | `parseImageAllowlist`, `imageAllowlistViolation` |
| Propiedad por labels impuestas, Id completo, inspección previa | CODE_VERIFIED + TEST (N21–N23, Docker real) | `ownershipViolation`; víctima creada fuera del proxy sigue `running` con el mismo `StartedAt` |
| Cada control se pone ROJO al retirarlo | TEST (mutación) | informe RC2 DEV-PROXY |
| Red `bot-control`, firewall y unidad | PENDIENTE DE INTEGRACIÓN | ramas `rc2/dev-net`, `rc2/dev-secops` |
| Unidad presente en la instalación de referencia | RUNTIME_VERIFIED (auditoría 2026-10-15, sólo lectura; política de RC1) | `s9-docker-proxy.service` |
