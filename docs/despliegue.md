# Despliegue de S9 AI Arena

La plataforma es **una única aplicación desplegable en una sola máquina**: el stack
Compose de `infrastructure/docker-compose.yml` contiene TODO lo necesario (gateway,
web, api, motor, workers, bot-manager, Redis y PostgreSQL — este último opcional si
se usa la instancia existente del servidor vía `DATABASE_URL`). Dosier: capítulo 6.

> **Obsoleto:** el `docker-compose.yml` de la RAÍZ del repo es del prototipo previo
> (arena-server/arena-viewer/bot-red/bot-blue) y NO es este stack. Se propone
> retirarlo junto con `pnpm-workspace.yaml`, `apps/arena-server`, `apps/arena-viewer`
> y `bots/*` en un PR de limpieza aprobado por el operador (ADR-010 D10.1).

## Instalación limpia en tres pasos

En una VM limpia con Docker Engine + Compose v2 y git:

```bash
# 1. Clonar y configurar (secretos por archivo + .env)
git clone https://github.com/pjclavero/s9-ai-arena.git && cd s9-ai-arena
bash infrastructure/scripts/init-secrets.sh
cp infrastructure/.env.example infrastructure/.env   # editar: dominio, modo, BD

# 2. Levantar el stack (perfil según el caso, ver tabla)
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d

# 3. Verificar: healthchecks verdes + humo
docker compose -f infrastructure/docker-compose.yml ps
bash infrastructure/scripts/smoke.sh https://<S9_DOMAIN>
```

## Perfiles (dosier 6.1)

| Perfil | Uso |
|---|---|
| `development` | Desarrollo local (BD en contenedor) |
| `production` | Producción autocontenida (BD en contenedor) |
| `external-db` | Producción con PostgreSQL externo: definir `DATABASE_URL` en `.env`; **el servicio postgres no arranca** (nota del dosier 6.2) |
| `bots` | Plantilla del runtime de bots (los reales los lanza bot-manager) |
| `streaming` | Streamer Chromium+FFmpeg hacia YouTube (E11) |
| `observability` | Prometheus + Grafana + Loki + Alertmanager (cap. 24, opcional) |

Combinables: `--profile production --profile observability`, o con
`COMPOSE_PROFILES=production,observability` en `.env`.

## Modos de exposición web

La plataforma corre entera en una máquina; lo único externo en este homelab es el
acceso web público.

### (a) Standalone puro

El gateway del stack termina TLS y expone 80/443 directamente
(`GATEWAY_CONF=nginx.conf`, por defecto). Certificados en
`infrastructure/secrets/tls/` (`fullchain.pem`, `privkey.pem`);
`init-secrets.sh` genera uno autofirmado si no hay.

### (b) Detrás del proxy de VM104 (modo real de este homelab)

El Nginx de **vm104-web-hosting (192.168.1.204)** hace de proxy inverso con el
wildcard `*.seccionnueve.duckdns.org` y termina TLS; el gateway del stack solo
expone HTTP interno a la LAN.

En `infrastructure/.env` de la VM donde se despliegue el stack:

```bash
GATEWAY_CONF=nginx-behind-proxy.conf
HTTP_PORT=8080          # puerto HTTP hacia la LAN (el que verá VM104)
HTTPS_PORT=127.0.0.1:8443   # sin uso en este modo; ligado a loopback
S9_DOMAIN=arena.seccionnueve.duckdns.org
TRUST_PROXY_HOPS=2      # VM104 + gateway del stack (R1.8 · ERR-SEC-05)
```

En VM104, un `server` para `arena.seccionnueve.duckdns.org` con
`proxy_pass http://<IP-de-la-VM-del-stack>:8080;`, cabeceras `X-Forwarded-Proto https`
y `X-Forwarded-For $proxy_add_x_forwarded_for` (obligatoria: con
`TRUST_PROXY_HOPS=2` la API espera que VM104 añada la IP real del cliente),
y soporte de upgrade WebSocket para `/ws/`. El humo en este modo:
`smoke.sh https://arena.seccionnueve.duckdns.org`.

> **IP real del cliente (R1.8 · ERR-SEC-05):** la API calcula `req.ip` con una
> confianza de proxy **acotada** al número de saltos declarado en
> `TRUST_PROXY_HOPS` (1 en modo (a), por defecto en el Compose; 2 en modo (b)),
> nunca `trust proxy: true`. La cuota anónima y el bloqueo de fuerza bruta de
> login se anclan a esa IP; una `X-Forwarded-For` inyectada por un cliente
> externo se descarta porque queda fuera de los saltos de confianza.

## PostgreSQL externo (nota del 6.2)

```bash
# .env
COMPOSE_PROFILES=external-db
DATABASE_URL=postgresql://arena@192.168.1.205:5432/arena
```

Verificable sin levantar nada: `docker compose -f infrastructure/docker-compose.yml
--profile external-db config --services` no lista `postgres`
(test en `infrastructure/tests/compose.test.ts`).

## Seguridad del stack (cap. 28)

- Redes del 6.4: solo `gateway` en `public`; `platform/arena/build/data` son
  `internal: true` (sin Internet). Los bots viven solo en `arena`: no hay ruta a
  postgres, redis ni api. `bot-manager` (builders) no está en `data`.
- Secretos **siempre por archivo** (`/run/secrets/*`), generados por
  `init-secrets.sh`; `infrastructure/secrets/` está fuera del control de versiones.
- Ningún servicio privilegiado ni con `docker.sock`, **salvo bot-manager**
  (excepción documentada en el propio compose; mitigación a futuro:
  docker-socket-proxy o builder rootless). Lo vigila
  `infrastructure/scripts/scan-compose.mjs` (etapa 6 de la CI y tests).
- Todos los servicios con healthcheck, `depends_on` condicionado a
  `service_healthy`, límites de CPU/RAM y `no-new-privileges`.

## CI/CD — configuración del repositorio (pasos del operador, pendientes de confirmación humana)

La CI (`.github/workflows/ci.yml`, 8 etapas del dosier 22.3) ya está versionada.
Falta configuración del repositorio en GitHub que E10 NO aplica por sí mismo:

1. Protección de `main` + Require review from Code Owners + status checks
   obligatorios: pasos exactos en `docs/decisiones/ADR-010…` (D10.5).
2. Environments `staging` y `production` (este último con *required reviewers*:
   es la promoción manual de la etapa 8).
3. Secretos de despliegue: `STAGING_HOST`, `STAGING_SSH_KEY`.
4. PR canario de verificación (romper un esquema de E1 / un golden de E2 y
   comprobar el bloqueo automático).
5. **Regla de aceptación (E12/T12.2):** la aprobación manual del environment
   `production` (etapa 8) exige que la última ejecución del workflow
   `acceptance` (10 criterios del cap. 28, nightly y bajo demanda) esté en
   verde: el informe está en `docs/aceptacion/ultimo-informe.md` y como
   artefacto `acceptance-report`. Un criterio en rojo = NO se promociona.

## Actualización en caliente (E10.M)

Despliegue por servicio: `docker compose -f infrastructure/docker-compose.yml
--profile production up -d --no-deps <servicio>`. Antes de reiniciar
`arena-engine`, drenar las batallas en curso pausando el consumo de la cola
(coordinado con E9).

## Verificación pendiente de un entorno con Docker

En el entorno de desarrollo actual no hay acceso al daemon de Docker, así que lo
verificado aquí es parseo + `docker compose config` + tests
(`infrastructure/tests/`). Queda pendiente, con Docker real:

```bash
# 1. Los 12 servicios sanos
docker compose -f infrastructure/docker-compose.yml --profile production up -d
docker compose -f infrastructure/docker-compose.yml ps   # todos healthy

# 2. Solo 80/443 expuestos (desde OTRA máquina)
nmap -p- <IP-del-host>

# 3. Un bot no alcanza postgres/redis/api (desde la red arena)
docker run --rm --network s9-ai-arena_arena alpine \
  sh -c 'nc -zw2 postgres 5432 || nc -zw2 queue 6379 || nc -zw2 api 8080; echo exit=$?'
# se espera fallo de resolución/conexión en los tres

# 4. Humo E2E
bash infrastructure/scripts/smoke.sh https://<S9_DOMAIN>
```
