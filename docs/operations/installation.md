# Instalación desde una máquina nueva

## Resumen

Procedimiento reproducible para levantar S9 AI Arena con el perfil `production` en un host
Linux limpio, usando las imágenes que publica la CI con una etiqueta **inmutable**
(`sha-<commit>`). Sustituye a la antigua «instalación en tres pasos», que no producía una
instalación válida ([TD-024](../roadmap/technical-debt.md#td-024)).

## Índice

- [Qué es](#qué-es)
- [1. Prerrequisitos](#1-prerrequisitos)
- [2. Clonar el repositorio](#2-clonar-el-repositorio)
- [3. Generar los secretos](#3-generar-los-secretos)
- [4. Elegir la versión de las imágenes](#4-elegir-la-versión-de-las-imágenes)
- [5. Configurar `infrastructure/.env`](#5-configurar-infrastructureenv)
- [6. Descargar las imágenes](#6-descargar-las-imágenes)
- [7. Arrancar](#7-arrancar)
- [8. Base de datos y contenido base](#8-base-de-datos-y-contenido-base)
- [9. Primer administrador](#9-primer-administrador)
- [10. Verificar](#10-verificar)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Una instalación es: un clon del repositorio (sólo se usan `infrastructure/` y los scripts), un
directorio de secretos por fichero (`infrastructure/secrets/`, nunca versionado), un fichero
`infrastructure/.env` con la configuración no secreta, y el proyecto Compose `infrastructure`
con el perfil `production`. Los datos viven en volúmenes Docker (`infrastructure_*`).

## 1. Prerrequisitos

| Requisito | Para qué | Notas |
|---|---|---|
| Linux con Docker Engine y Docker Compose v2 | ejecutar el stack | probado con Compose v2; los ejemplos usan `docker compose` |
| `git`, `curl` | clon y verificación | — |
| `openssl`, `ssh-keygen` | `init-secrets.sh` genera la clave de firma ed25519, el TLS autofirmado y la clave SSH del backup | sin ellos el script avisa y no los genera |
| Node.js ≥ 22.15 (opcional) | ejecutar en el host los gates `infrastructure/scripts/*.mjs` y `scripts/readiness.ts` | no hace falta para arrancar el stack |
| `restic` (opcional) | sólo para **restaurar** desde el host ([restore.md](restore.md)) | el backup programado lo trae su propia imagen |
| Un usuario de despliegue sin privilegios, dueño del clon | operar sin `root` | los contenedores Node corren como uid 1000 y leen los secretos con ese uid |
| Un repositorio restic (SFTP o ruta montada) | copias diarias | ver [backup.md](backup.md) |
| Opcional: el proxy de Docker del host | ejecución real de bots | hoy apagado en producción; ver [docker-proxy.md](docker-proxy.md) |

## 2. Clonar el repositorio

```bash
git clone https://github.com/pjclavero/s9-ai-arena.git /opt/s9-ai-arena
cd /opt/s9-ai-arena
git checkout <commit>            # el mismo commit cuyas imágenes vas a desplegar (paso 4)
git rev-parse HEAD
```

Hazlo con el usuario de despliegue: un `git` como `root` deja objetos de `.git/` de `root` y
rompe operaciones posteriores.

## 3. Generar los secretos

```bash
bash infrastructure/scripts/init-secrets.sh
```

> Ejecútalo siempre como fichero, **nunca por stdin**: el script calcula su directorio a partir de
> su propia ruta y, por stdin, escribiría en `/secrets`. En un host ya instalado donde el directorio
> de secretos no es de root, ejecutarlo como root exige antes `TD064_PREFLIGHT = PASS`
> ([TD-064](../roadmap/technical-debt.md#td-064), [upgrades.md](upgrades.md#rc3-orden-del-despliegue-de-4cc7651)).

Genera, sólo si no existen, en `infrastructure/secrets/` (permisos `0400`, dueño
`RUNTIME_UID:RUNTIME_GID`, por defecto `1000:1000`): `postgres_password.txt`, `jwt_secret.txt`,
`grafana_admin_password.txt`, `restic_password.txt`, `arena_engine_internal_secret.txt`,
`replay_ingest_secret.txt`, `artifact_signing_key.pem` (ed25519), `restic_ssh_key` (+ `.pub`),
`stream_key.txt` y `restic_ssh_known_hosts` vacíos, y un TLS autofirmado en `tls/`.

Después:

1. **Custodia fuera del servidor** `restic_password.txt`, `restic_ssh_key` y `restic_ssh_known_hosts`:
   sin ellos no hay restauración posible ([restore.md](restore.md#custodia)).
2. Si el backup va por SFTP, añade `restic_ssh_key.pub` a `authorized_keys` del `<backup-host>` y
   rellena `restic_ssh_known_hosts` con la huella **ya verificada** del host
   (`ssh-keyscan -t ed25519 <backup-host>` y comparación a mano). Nunca `StrictHostKeyChecking=no`.
3. En modo standalone con TLS en el gateway, sustituye `tls/fullchain.pem` y `tls/privkey.pem` por
   los certificados reales.

Nunca imprimas los ficheros de secretos en pantalla ni los pases por la línea de comandos.

## 4. Elegir la versión de las imágenes

La CI construye y publica en cada merge a `main` todas las imágenes en
`ghcr.io/pjclavero/s9-ai-arena/<servicio>` con dos etiquetas: `sha-<commit completo>`
(**inmutable**) y `v<versión>` (siempre `v0.0.0`, porque el `package.json` raíz no declara versión:
es una etiqueta **móvil** que apunta al último build de `main`). No se publica `latest`.

Usa siempre `sha-<commit>` y comprueba que existe para todos los servicios antes de seguir, por
ejemplo con `docker manifest inspect ghcr.io/pjclavero/s9-ai-arena/api:sha-<commit>`.

## 5. Configurar `infrastructure/.env`

```bash
cp infrastructure/.env.example infrastructure/.env
```

Edita **como mínimo** (detalle de cada variable en [configuration.md](configuration.md)):

| Variable | Valor | Por qué |
|---|---|---|
| `TAG` | `sha-<commit>` | el ejemplo trae `TAG=latest`, que no existe en el registro |
| `BACKUP_TAG` | `sha-<commit>` | `backup` no sigue a `TAG`; sin definir apunta a `latest` y falla al recrear |
| `S9_DOMAIN` | p. ej. `arena.example.internal` | sustituye el valor del ejemplo, que es de otra instalación |
| `GATEWAY_CONF` | `nginx.conf` (TLS en el gateway) o `nginx-behind-proxy.conf` (detrás de proxy) | ver [networking.md](networking.md) |
| `HTTP_PORT` / `HTTPS_PORT` | p. ej. `8080` sólo HTTP si hay proxy delante | el gateway es el único servicio con puertos publicados |
| `TRUST_PROXY_HOPS` | `1` standalone, `2` detrás de un proxy | el ejemplo lo deja comentado (= `1` en el compose) |
| `RESTIC_REPOSITORY` | p. ej. `sftp:<backup-user>@<backup-host>:/restic` | vacío → el backup no puede copiar |
| `RESTIC_HOSTNAME` | nombre lógico fijo de esta instalación | agrupa la retención; no cambiarlo después |
| `COMPOSE_PROFILES` | `production` (opcional) | evita olvidar `--profile production` |

Ningún secreto va en `.env`.

## 6. Descargar las imágenes

```bash
DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
$DC config --services          # deben salir 12 servicios
$DC pull
```

`postgres` (16.14) y `queue` (Redis 7.4.9) se descargan fijados por digest desde el compose.

Alternativa: construir las imágenes en un host de build con identidad (ADR-016) y desplegarlas
después; ver [upgrades.md](upgrades.md#construir-fuera-del-host-productivo). No construyas en el
host productivo con `--profile production build`.

### Imágenes de runtime de los bots

`$DC pull` **no** trae las imágenes de runtime de los bots (python y node): no son servicios del
compose, las lanza el proxy de Docker ([docker-proxy.md](docker-proxy.md)), y el proxy **no permite
`pull`**. Hay que descargarlas en el Docker del host antes de activar la ejecución real; es parte del
Gate F (host / proxy / sandbox):

```bash
bash scripts/ops/pull-runtime-images.sh               # descarga por digest y verifica
bash scripts/ops/pull-runtime-images.sh --check-only  # sólo comprueba (sólo lectura)
```

El script toma **sólo la 3ª columna** de `runtimes/DIGESTS.lock` (la misma imagen que admite la
allowlist del proxy; la base de la 2ª columna nunca se descarga), rechaza cualquier referencia que no
sea `repo@sha256:<64 hex>` y verifica con `docker image inspect` que el digest exacto está en
`RepoDigests` (un `pull` con rc=0 no basta). Termina con `RUNTIME_IMAGES_READY=YES` y rc=0 sólo si
todas están presentes. GHCR se descarga de forma anónima (el repositorio es público): no hace falta
ninguna credencial en el host.

### Proxy de Docker del host (artefacto instalado, TD-062)

El proxy **no** se ejecuta desde este árbol, y su instalador tampoco: el árbol lo puede escribir el
usuario de despliegue, y el proxy tiene el grupo `docker`, que equivale a root.

- Root clona el repo **aparte**, fijado al SHA revisado.
- Construye allí el bundle y lo compara con el sha256 que publica la CI de `main`.
- Instala desde ese clon.
- Después valida **sólo** con la copia instalada del preflight.

Desde una copia que no es de root, el instalador se niega (rc 2).

```bash
# como root, umask 022; pasos y condiciones de parada: upgrades.md#td-062
S=/root/s9-td062/$SHA
cd "$S" && npm ci --ignore-scripts && node infrastructure/scripts/build-docker-proxy-bundle.mjs --commit "$SHA"
S9PX_EXPECT_SHA256=<sha256 de la CI de main> bash "$S/infrastructure/scripts/install-docker-proxy.sh" install
/usr/local/sbin/s9-docker-proxy-preflight preflight     # rc 0 = frontera de privilegio OK
```

Detalle, propietarios y verificación: [docker-proxy.md](docker-proxy.md#frontera-de-privilegio-td-062).


## 7. Arrancar

```bash
$DC up -d --no-build
$DC ps
```

`--no-build` garantiza que no se construye nada en el host. El orden lo resuelven los
`depends_on` y los healthchecks. Sin `--profile production` (o `COMPOSE_PROFILES`) **no arranca
ningún servicio**: todos están en algún perfil.

Esperable en el primer arranque:

- `backup` queda `unhealthy` hasta su primera copia correcta (cron diario, por defecto `15 4 * * *`
  en UTC) — ver [backup.md](backup.md).
- `arena-engine` y `bot-manager` arrancan aunque la ejecución real esté apagada.

## 8. Base de datos y contenido base

La API **no** aplica migraciones al arrancar. Hay que ejecutar una vez `bootstrap` (migraciones +
ruleset, catálogo y mapa base, **sin usuarios**). Es idempotente:

```bash
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts bootstrap
# → "Contenido base aplicado (ruleset, catálogo, mapa). Sin usuarios."
```

Dentro del contenedor la conexión sale de `PGHOST`/`PGUSER`/`PGDATABASE` + `PGPASSWORD_FILE`
(los pone el compose). Detalle y comandos prohibidos en [first-run.md](first-run.md).

## 9. Primer administrador

**Hoy no existe una vía limpia** ([TD-023](../roadmap/technical-debt.md#td-023)): `bootstrap` no
crea usuarios, el registro público da los roles `user` y `developer`, y cambiar roles
(`PUT /users/{id}/roles`) exige ya un administrador. El único camino es registrarse y promover la
cuenta por SQL. Procedimiento completo, con su bloque DANGER, en
[first-run.md](first-run.md#3-primer-administrador).

## 10. Verificar

Desde el host (sustituye el puerto si cambiaste `HTTP_PORT`):

```bash
curl -s http://127.0.0.1:${HTTP_PORT:-80}/healthz          # gateway → "ok"
curl -s http://127.0.0.1:${HTTP_PORT:-80}/api/v1/healthz   # API → {"status":"ok","service":"api"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${HTTP_PORT:-80}/   # web → 200
$DC ps --format '{{.Service}} {{.Status}}'                 # 11 healthy + backup
```

Con `GATEWAY_CONF=nginx.conf` el puerto 80 redirige a HTTPS salvo `/healthz` y `/version`: usa
`curl -k https://127.0.0.1:${HTTPS_PORT:-443}/api/v1/healthz`.

**No uses** como prueba:

- `/api/healthz`: el gateway no lo enruta a la API; responde la web con un `200 text/html`
  (falso verde).
- `infrastructure/scripts/smoke.sh`: comprueba `/api/healthz` y `/replays/healthz` (este último no
  existe → 404), así que nunca sale verde con sentido ([TD-020](../roadmap/technical-debt.md#td-020)).

Más comprobaciones en [diagnostics.md](diagnostics.md) y [readiness.md](readiness.md).

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `manifest unknown` al hacer `pull` | `TAG`/`BACKUP_TAG` en `latest` o un sha sin publicar | fija `sha-<commit>` existente para todos |
| `docker compose up -d` no hace nada | falta `--profile production` / `COMPOSE_PROFILES` | añádelo |
| La API reinicia en bucle: «Sin conexión a PostgreSQL» o secreto ilegible | secretos con dueño distinto de uid 1000 | reejecuta `init-secrets.sh` con `RUNTIME_UID`/`RUNTIME_GID` correctos |
| `TRUST_PROXY_HOPS inválido` y la API no arranca | valor fuera de `0..8` | corrige `.env` |
| Registro falla con error de clave foránea de `roles` | no se ejecutó `bootstrap` (las migraciones crean los roles) | paso 8 |
| `backup` reinicia: «CONFIG INCOMPLETA» o «backend sftp mal configurado» | `RESTIC_HOSTNAME` vacío, o SFTP sin clave/known_hosts | [backup.md](backup.md) |

## Estado actual

- **FUNCIONA ACTUALMENTE:** pasos 1-8 y 10 con imágenes `sha-<commit>` publicadas.
- **PARCIAL:** el producto instalado tiene limitaciones funcionales (ningún bot llega a
  `published`, batallas con stub, creación de batallas desde la web rota): ver
  [../roadmap/current-status.md](../roadmap/current-status.md).
- **PENDIENTE:** primer administrador sin SQL; `.env.example` con un `TAG` válido; humo fiable
  ([TD-024](../roadmap/technical-debt.md#td-024), [TD-020](../roadmap/technical-debt.md#td-020)).
- **Desde `4cc7651` (base de RC3):** el proxy de Docker del host se instala como artefacto de root
  desde un clon fijado al SHA ([Proxy de Docker del host](#proxy-de-docker-del-host-artefacto-instalado-td-062)).
  La custodia de `restic_password` y de las claves SSH fuera del servidor sigue siendo requisito (sin
  ella no hay restauración). Sacar además el paquete break-glass fuera del dominio de fallo del
  repositorio de copias es recomendación, no requisito: DEFERRED por decisión del operador
  (2026-10-22, [TD-007](../roadmap/technical-debt.md#td-007)).

## Documentación relacionada

[first-run.md](first-run.md) · [configuration.md](configuration.md) · [docker.md](docker.md) ·
[networking.md](networking.md) · [firewall.md](firewall.md) · [backup.md](backup.md) · [upgrades.md](upgrades.md) ·
[../technical/services.md](../technical/services.md) · [../technical/database.md](../technical/database.md) ·
[../development/releases.md](../development/releases.md) · ADR: [ADR-016](../adr/ADR-016-identidad-de-build.md),
[ADR-017](../adr/ADR-017-contrato-de-release.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Pasos 3, 5, 6, 7, 8, 10 ejecutados en un entorno aislado (Docker rootless, proyecto distinto, puerto 18080, imágenes `sha-27f70bb…`) | RUNTIME_VERIFIED | script de verificación de la consolidación (no versionado): `bootstrap` ×2 rc=0, gateway `/healthz` ok, `/api/v1/healthz` JSON, registro 201, promoción SQL, login, `pg_roles` = sólo `arena` |
| `init-secrets.sh` genera esos ficheros con `0400` y dueño 1000:1000 | CODE_VERIFIED + RUNTIME_VERIFIED | `infrastructure/scripts/init-secrets.sh:28-107` |
| La CI etiqueta `sha-<commit>` y `v<version ?? 0.0.0>`; no `latest` | CODE_VERIFIED + RUNTIME_VERIFIED | `.github/workflows/ci.yml:362,375-377`; GHCR: `latest` 404, `sha-27f70bb…` 200 en los 11 repos de imagen |
| `.env.example` trae `TAG=latest` y `BACKUP_TAG=latest` | CODE_VERIFIED | `infrastructure/.env.example` sección Imágenes |
| La API no migra al arrancar; `bootstrap` = migrate + seedContent sin usuarios | CODE_VERIFIED | `apps/api/src/server.ts:15-58`; `apps/api/src/db/cli.ts:56-59` |
| Sin perfil no arranca ningún servicio | RUNTIME_VERIFIED | `docker compose -f infrastructure/docker-compose.yml config --services` → 0 |
| `/api/healthz` cae en la web; `/api/v1/healthz` es la API | CODE_VERIFIED + RUNTIME_VERIFIED | `infrastructure/gateway/nginx-behind-proxy.conf:72-107`; entorno aislado |
| `smoke.sh` comprueba `/api/healthz` y `/replays/healthz` | CODE_VERIFIED | `infrastructure/scripts/smoke.sh:21-24` |
| Contenedores Node bajan a uid 1000 | CODE_VERIFIED | `infrastructure/docker/node-service/Dockerfile:13-15,46`; `entrypoint.sh` |
| `pull-runtime-images.sh` descarga sólo la 3ª columna del lock, por digest, y falla si `image inspect` no muestra el digest | CODE_VERIFIED + RUNTIME_VERIFIED | `infrastructure/tests/pull-runtime-images.test.ts`; Docker rootless aislado: rc=0 con el lock real, rc=1 con un digest inexistente |
| En un host sin las imágenes de runtime, `--check-only` da `ABSENT` y rc=1 | RUNTIME_VERIFIED (2026-10-21, sólo lectura) | `--check-only` contra un host real sin las imágenes |
