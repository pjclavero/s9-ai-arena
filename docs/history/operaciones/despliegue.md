# Despliegue de S9 AI Arena

> **⚠️ Estado real (2026-07-18):** el núcleo de la v2 YA está desplegado en VM108. Para el
> estado vigente y la operación usa **[ESTADO_ACTUAL.md](ESTADO_ACTUAL.md)**,
> **[OPERACION_VM108.md](OPERACION_VM108.md)** y **[DESPLIEGUE_DOMINIO.md](DESPLIEGUE_DOMINIO.md)**.
> El dominio correcto es **`s9arena.seccionnueve.duckdns.org`** (NO `arena.…`, que es otro
> proyecto en VM107). Este documento describe el procedimiento general de despliegue.

La plataforma es **una única aplicación desplegable en una sola máquina**: el stack
Compose de `infrastructure/docker-compose.yml` contiene TODO lo necesario (gateway,
web, api, motor, workers, bot-manager, Redis y PostgreSQL — este último opcional si
se usa la instancia existente del servidor vía `DATABASE_URL`). Dosier: capítulo 6.

> **Qué Compose usar (R-DEPLOY · R7):**
> - **Oficial / producción (VM108):** `infrastructure/docker-compose.yml` — este
>   documento. Es el ÚNICO válido en producción.
> - **Demo / legado (v1):** `docker-compose.demo.yml` de la RAÍZ (antes
>   `docker-compose.yml`; renombrado para quitar la ambigüedad). Es el prototipo
>   de tanques (arena-server/arena-viewer/bot-red/bot-blue). **NO usar en prod.**
>   Se propone retirarlo junto con `pnpm-workspace.yaml`, `apps/arena-server`,
>   `apps/arena-viewer` y `bots/*` en un PR de limpieza aprobado por el operador
>   (ADR-010 D10.1).
>
> Validar el oficial sin daemon: `docker compose -f infrastructure/docker-compose.yml
> --profile production config` (y la suite `infrastructure/tests/compose.test.ts`).

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
S9_DOMAIN=s9arena.seccionnueve.duckdns.org
TRUST_PROXY_HOPS=2      # VM104 + gateway del stack (R1.8 · ERR-SEC-05)
```

En VM104, un `server` para `s9arena.seccionnueve.duckdns.org` con
`proxy_pass http://<IP-de-la-VM-del-stack>:8080;`, cabeceras `X-Forwarded-Proto https`
y `X-Forwarded-For $proxy_add_x_forwarded_for` (obligatoria: con
`TRUST_PROXY_HOPS=2` la API espera que VM104 añada la IP real del cliente),
y soporte de upgrade WebSocket para `/ws/`. El humo en este modo:
`smoke.sh https://s9arena.seccionnueve.duckdns.org`.

> **Dominio (R-DEPLOY · R6):** S9 AI Arena usa **`s9arena.seccionnueve.duckdns.org`**.
> El subdominio **`arena.seccionnueve.duckdns.org` está RESERVADO por otro
> proyecto** del homelab y NO debe usarse aquí. VM104 termina el wildcard
> `*.seccionnueve.duckdns.org`; añade **solo** el `server` de `s9arena` sin tocar
> los vhosts de otros proyectos.

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
DATABASE_URL=postgresql://arena@192.0.2.10:5432/arena
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
- Ningún servicio privilegiado ni con `docker.sock` — **sin excepciones**
  (R1.7/ERR-SEC-02: la antigua excepción de bot-manager se retiró). Lo vigila
  `infrastructure/scripts/scan-compose.mjs` (etapa 6 de la CI y tests), con
  `complianceViolations` (`apps/bot-manager/src/compliance.mjs`) como única
  fuente de verdad.
- **Proxy de la API de Docker (R1.7).** `bot-manager` lanza contenedores vía
  `DOCKER_PROXY_URL` contra un proxy con allowlist estricta
  (crear/arrancar/parar/inspeccionar; rechaza `privileged`, bind-mounts,
  `--network host` y cambios de usuario). El proxy corre **en el host**, fuera
  del Compose, como único proceso con acceso al socket:
  `npx tsx apps/bot-manager/src/docker-proxy-main.ts` (el operador lo
  encapsula en una unidad systemd en R-DEPLOY; escucha en 127.0.0.1:2375 por
  defecto y el Compose lo alcanza por el alias `docker-proxy.internal` →
  `host-gateway`). **Pendiente R-DEPLOY:** verificación viva de la ruta
  bot-manager → proxy → socket (en el entorno de desarrollo no hay Docker; la
  lógica del proxy está probada en proceso en
  `apps/bot-manager/tests/docker-proxy.test.ts`).
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

## Identidad de build y gate de procedencia (ADR-016)

Toda imagen del stack lleva DENTRO el commit del que salió: `BUILD_COMMIT`,
`BUILD_DATE` y `SERVICE_NAME` como `ARG` -> `ENV` y como etiquetas OCI
(`org.opencontainers.image.revision/created/title/source`), y lo expone en
`GET /version`:

```json
{ "service": "replay-service", "commit": "4d469dc" }
```

`/version` no lleva autenticación (no contiene nada que proteger; el motivo
completo está en el ADR) y el gateway **no** lo enruta hacia fuera: cada
servicio lo sirve en su puerto, en las redes internas.

**Construir a mano SIEMPRE con la identidad.** Si no se pasa, la imagen queda
marcada `unknown` y el gate la rechaza:

```bash
BUILD_COMMIT=$(git rev-parse HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  docker compose -f infrastructure/docker-compose.yml --profile production build
```

> Y **nunca** con `--project-directory` apuntando al directorio de producción
> mientras se construye desde otro árbol: el `build.context: ..` se resuelve
> contra ese directorio y se construye el árbol equivocado. Ocurrió: se compiló
> `98f381ec` y se etiquetó `4d469dc`.

**Gate antes de dar por bueno un despliegue.** Para cada servicio deben cumplirse
las CUATRO, no tres:

1. el `tag` de la imagen nombra el commit desplegado;
2. `org.opencontainers.image.revision` de la imagen = ese commit;
3. `/version` del contenedor EN MARCHA = ese commit;
4. la image ID en ejecución EXISTE todavía en el daemon (`docker image inspect`,
   nunca `docker images -q`: ese listado omite las imágenes sin etiqueta);
5. la referencia declarada SIGUE resolviendo a la image ID que corre.

```bash
# (1)(2)(3)
node infrastructure/scripts/verify-image-provenance.mjs \
  --image <ref> --commit <sha> --service <nombre> --port <puerto>

# (4)(5) sobre el daemon entero: cada contenedor cae en uno de los cuatro
# estados de ADR-016 (IMAGE_MISSING · TAG_CONTENT_MISMATCH · TAG_MOVED · RUNTIME_MATCH)
node infrastructure/scripts/check-running-image-id.mjs [--json]
```

(1) por sí sola es una tautología: comparar "imagen declarada" con "imagen
desplegada" no dice nada cuando la etiqueta miente. (4) es el otro incidente
real: un contenedor corriendo sobre una image ID ya borrada del daemon. Si (4)
falla es **DRIFT CRÍTICO**: el estado no es reproducible, un restart no lo
recupera y **el baseline no sirve para rollback** — hay que reconstruir o volver
a bajar la imagen del registro antes de tocar nada.

(5) es un tercer incidente, visto en producción: la etiqueta se movió bajo un
contenedor vivo (upstream republicó la misma etiqueta). El contenedor está sano,
pero un `restart` traería otra versión sin que nadie lo hubiera decidido; sale
como `TAG_MOVED`. El clasificador **no corrige nada**: anclar un digest es una
decisión del operador, con su ventana.

Ojo con la procedencia: una imagen sin identidad de build embebida (todas las
anteriores a ADR-016) sale `not_exercised`, **nunca "verificada"**. Sin el commit
dentro, lo único mirado sería la etiqueta, que es lo que puede mentir.

El `tournament-worker` no expone HTTP: su identidad está en `/tmp/version.json`
dentro del contenedor (`docker exec … cat /tmp/version.json`).

## Contrato de release: BUILD y DEPLOY son fases distintas (ADR-017)

El procedimiento formal, con los incidentes que lo justifican, está en
**[ADR-017](decisiones/ADR-017-contrato-de-release.md)**. Lo esencial:

```
BUILD   árbol fuente correcto · commit correcto · contexto correcto ·
        BUILD_COMMIT embebido · etiquetas de imagen · verificación de CONTENIDO
DEPLOY  --no-build OBLIGATORIO · project-directory productivo · imagen ya construida ·
        image ID en ejecución · spec diff · health · smoke · verificación de versión
```

`--project-directory` controla **tres** cosas a la vez —contexto de
construcción, rutas relativas y **secretos**—, así que en despliegue va el de
producción **y además `--no-build`**: los secretos resuelven bien y no se puede
construir.

**Prohibido como evidencia única**: la etiqueta, un `docker compose` con salida
0 y un contenedor `healthy`. Todo despliegue debe poder responder con evidencia
**qué código, qué imagen, qué SPEC y qué runtime**.

```bash
node infrastructure/scripts/release-gate.mjs --invocacion build \
  --arbol-fuente /tmp/arbol-<sha> -- <invocación de build>
node infrastructure/scripts/release-gate.mjs --invocacion deploy -- <invocación de deploy>
node infrastructure/scripts/release-gate.mjs --evidencia despliegue.json
node infrastructure/scripts/release-gate.mjs --self-test   # calibración
```

Reglas asociadas, todas con incidente detrás: nada de `git clone` de ruta local
sin `--no-hardlinks` (un clon hardlinkeado vació 384 objetos del repo
productivo); limpiar con `rm -rf`, nunca con `shred`; ninguna operación
destructiva como prueba de humo en producción (una sonda de retención sin
autenticación borró replays reales); los invariantes se miden sobre el
**proyecto Compose**, no sobre el host; y la CI se lee por **recuento de
conclusiones de todos los checks**, jamás por el final de un `--watch`
(`skipped`/`neutral`/`not_exercised` no son éxito).

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
