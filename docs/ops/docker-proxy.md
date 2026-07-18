# Proxy de la API de Docker — runbook del host (VM108)

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
`172.17.0.1`) y se acota por firewall a esa red. Desde el Compose, el
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
# Para y retira la unidad; conserva config y usuario. Borrado total:
sudo rm -rf /etc/s9-ai-arena && sudo userdel s9proxy
```

## Estado en este entorno

**NO EJECUTADO** en VM102 (sin daemon de Docker ni sudo): la unidad, la config
de ejemplo, el instalador y este runbook quedan listos. La verificación viva
(proxy ↔ socket ↔ bot-manager) es un paso de operador en VM108.
