# Proxy de la API de Docker (host)

> **Estado:** vigente, revisado contra `27f70bb`. El proxy se instala en el host como unidad
> systemd. En la instalación de referencia está instalado, pero la **ejecución real de bots está
> apagada**: `DOCKER_PROXY_URL` del `arena-engine` está vacío y toda batalla la ejecuta el
> `tournament-worker` con un bot stub ([TD-002](../roadmap/technical-debt.md#td-002)). Índice de
> operación: [index.md](index.md) · Seguridad: [../technical/security.md](../technical/security.md).

R-DEPLOY · R2 (R1.7 · ERR-SEC-02). Este documento describe el **único proceso
autorizado a tocar `/var/run/docker.sock`** en el host. Ningún contenedor del
stack monta el socket; el `bot-manager` lanza contenedores de bots **solo** a
través de este proxy, con allowlist estricta.

## Por qué existe

Montar el socket de Docker dentro de un servicio que procesa **código de
usuario** (el `bot-manager`) equivale a RCE → root del host. R1.7 retiró esa
excepción. En su lugar, un proxy con allowlist media todas las operaciones:

- Permite: crear / arrancar / parar / inspeccionar contenedores de bots.
- Rechaza: `privileged`, bind-mounts, `--network host`, cambios de usuario, y
  cualquier verbo fuera de la allowlist.
- Fuerza: red `arena` y usuario del sandbox (`SANDBOX_USER`).

Lógica y política: `apps/bot-manager/src/docker-proxy.ts` (`DEFAULT_POLICY`),
entrypoint `apps/bot-manager/src/docker-proxy-main.ts`. Probada en proceso en
`apps/bot-manager/tests/docker-proxy.test.ts`.

## Los tres procesos de bot-manager (no confundirlos)

| Proceso | Dónde corre | Cometido |
|---|---|---|
| **bot-manager (API/control)** | contenedor (`bot-manager`) | Orquesta; habla con el proxy por `DOCKER_PROXY_URL`. Entrypoint `apps/bot-manager/src/main.ts` (R1). |
| **bot-build-worker** | contenedor (`bot-build-worker`) | Ejecuta el pipeline de build/análisis/**firma**. Entrypoint `apps/bot-manager/src/build-worker-main.ts` (R2). |
| **docker-proxy** | **HOST**, systemd | Único con acceso al socket. Entrypoint `apps/bot-manager/src/docker-proxy-main.ts`. **NO va en Compose** (montaría el socket). |

## Alcance de red (importante)

El bind por defecto **no es `127.0.0.1`**: un proceso en loopback del host **no
es alcanzable** desde un contenedor vía `host-gateway`. El proxy escucha en la
**interfaz interna controlada** del bridge de Docker (`docker0`, típicamente
`<ip-docker0>`) y se acota por firewall a esa red. Desde el Compose, el
`bot-manager` lo alcanza con:

```yaml
extra_hosts: ["docker-proxy.internal:host-gateway"]
environment:
  DOCKER_PROXY_URL: http://docker-proxy.internal:2375
```

`host-gateway` resuelve a la IP del host tal como la ve el contenedor; el proxy
debe escuchar en esa IP (no en loopback). Cierra el puerto 2375 al exterior:

```bash
sudo ufw deny in on eth0 to any port 2375        # o la interfaz LAN real
sudo ufw allow in on docker0 to any port 2375
```

## Instalación

```bash
# En el host, con el repo desplegado en /opt/s9-ai-arena (APP_DIR):
sudo APP_DIR=/opt/s9-ai-arena bash infrastructure/scripts/install-docker-proxy.sh install
# Ajusta la config antes de fiarte del arranque:
sudo nano /etc/s9-ai-arena/docker-proxy.env     # DOCKER_PROXY_BIND, ARENA_NETWORK…
sudo systemctl restart s9-docker-proxy
```

La unidad (`infrastructure/systemd/s9-docker-proxy.service`) corre como usuario
dedicado `s9proxy` (sin login) del grupo `docker`, con `Restart=always` y
endurecimiento systemd (`NoNewPrivileges`, `ProtectSystem=strict`, etc.).

## Validación

```bash
sudo bash infrastructure/scripts/install-docker-proxy.sh validate
# Comprueba: unidad activa, /_ping a través del proxy, y los últimos logs JSON
# (cada decisión allow/deny queda registrada por journald).
sudo journalctl -u s9-docker-proxy -f
```

Desde el contenedor `bot-manager` (una vez arriba el stack):

```bash
docker compose -f infrastructure/docker-compose.yml exec bot-manager \
  wget -qO- http://docker-proxy.internal:2375/_ping && echo OK
```

## Rollback

```bash
sudo bash infrastructure/scripts/install-docker-proxy.sh rollback
# Para y retira la unidad; conserva config y usuario.
```

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

- **FUNCIONA ACTUALMENTE:** instalador `install|validate|rollback`, unidad endurecida, política con
  allowlist probada en tests (`apps/bot-manager/tests/docker-proxy.test.ts`).
- **PARCIAL:** el `bot-manager` alcanza el proxy (`DOCKER_PROXY_URL` por defecto), pero el build de
  bots no llega a `published` ([TD-001](../roadmap/technical-debt.md#td-001)).
- **PENDIENTE:** cablear el motor (`DOCKER_PROXY_URL` del `arena-engine`) forma parte de la puerta
  de ejecución real, descrita en [../technical/battles.md](../technical/battles.md); no activarla
  sin resolver la doble ejecución ([TD-002](../roadmap/technical-debt.md#td-002)).

## Documentación relacionada

[docker.md](docker.md#otros-servicios) · [networking.md](networking.md#puertos-lógicos) ·
[configuration.md](configuration.md) · [../technical/bots.md](../technical/bots.md) ·
[../technical/security.md](../technical/security.md) · Informe de origen (R1.7):
[../history/rondas/ronda2/reportes/R1.7-docker-sock.md](../history/rondas/ronda2/reportes/R1.7-docker-sock.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `install|validate|rollback`, `APP_DIR`, `/etc/s9-ai-arena`, usuario `s9proxy` | CODE_VERIFIED | `infrastructure/scripts/install-docker-proxy.sh` |
| Bind por defecto en la IP de `docker0` (`DOCKER_PROXY_BIND`), puerto 2375 | CODE_VERIFIED | `install-docker-proxy.sh:47`; `infrastructure/systemd/docker-proxy.env.example:8-9` |
| `bot-manager` usa `docker-proxy.internal:host-gateway` | CODE_VERIFIED | compose, servicio `bot-manager` (`extra_hosts`, `DOCKER_PROXY_URL`) |
| `arena-engine` con `DOCKER_PROXY_URL` vacío por defecto | CODE_VERIFIED | compose, servicio `arena-engine` |
| Unidad presente en la instalación de referencia | RUNTIME_VERIFIED (auditoría 2026-10-15, sólo lectura) | `s9-docker-proxy.service` |
