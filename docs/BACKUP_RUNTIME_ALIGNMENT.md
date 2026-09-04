# Alineación del runtime de `backup` · procedimiento preparado, NO ejecutado

> **Estado: preparación.** Este documento no despliega nada. No se ha
> construido ninguna imagen, no se ha recreado ningún servicio, no se ha
> ejecutado `backup.sh` y no se ha tocado el repositorio restic más allá de
> consultas `--no-lock`. La ejecución es decisión del operador, y va **después**
> de la canonización del compose (PR #137).
>
> Base de la medición: `main` = `ad0a42b`; árbol de despliegue de `<vm-arena>`
> también en `ad0a42b`; `TAG=4d469dc` en el `.env` de producción.
> Medido el 2026-09-04.

## 0. Los hechos, medidos hoy sobre el servicio vivo

Todo lo que sigue se obtuvo con `docker inspect`, `docker run --network none`
sobre la propia imagen y `restic … --no-lock`. Nada es supuesto.

| Hecho | Valor medido |
| --- | --- |
| Imagen en marcha | `s9arena/backup:11b36a7` (image ID `sha256:feb305c788c5…`) |
| Procedencia Compose | `com.docker.compose.project.config_files` = **otro árbol** (`…/deploy-11b36a7/…`), no el de despliegue |
| Healthcheck efectivo | `pgrep crond >/dev/null` — el viejo |
| `RESTIC_HOSTNAME` en el contenedor | **ausente** |
| `BUILD_COMMIT` / etiquetas OCI en la imagen | **ausentes** (`.Config.Labels` es `null`) |
| `/usr/local/bin/lib/setup-ssh.sh` | **ausente** |
| `/usr/local/bin/healthcheck.sh`, `evidence.sh` | **ausentes** |
| `RESTIC_HOSTNAME` en `backup.sh` de la imagen | 0 apariciones |
| `"schema":2` en `backup.sh` de la imagen | 0 apariciones |
| `snapshot_selector_or_die` en `restore.sh` de la imagen | 0 apariciones |
| `restic` en la imagen | 0.16.4 |
| Última copia | exit 0, snapshot creado, 2026-09-04 04:15 UTC |
| Snapshots en el repositorio | 35, en **3 grupos de hostname** (ver §8) |

**Consecuencia que conviene ver antes de nada:** el compose de `ad0a42b` declara
`healthcheck: /usr/local/bin/healthcheck.sh`, y ese fichero **no existe en la
imagen `11b36a7`**. Recrear `backup` con el compose nuevo y la imagen vieja
dejaría el contenedor permanentemente `unhealthy`. Imagen y compose se alinean
**a la vez** o no se alinean.

## 1. El contrato de los dos bloques

Implementado en `infrastructure/deploy-contract.json` (clave `bloques`) y
verificado por `infrastructure/scripts/backup-stack-gate.mjs`:

```
APP_STACK     profile development         11 servicios
BACKUP_STACK  servicio backup explícito     1 servicio
TOTAL ESPERADO                             12
```

El bloque de aplicación se despliega **por perfil**; el de copia, **nombrando el
servicio**, con `--no-build` y `--no-deps`. El motivo no es estético: `backup`
lleva `profiles: [production, external-db]`, así que **elegir un perfil un poco
más ancho arranca la copia de seguridad**. Medido:

| Perfil | Servicios | ¿trae `backup`? |
| --- | --- | --- |
| `development` | 11 | no |
| `production` | 12 | **sí** |
| `external-db` | 11 | **sí** (y sin `postgres`) |
| `nucleo` | 7 | no |
| `bots` / `streaming` / `observability` | 1 / 1 / 8 | no |
| (sin perfil) | **0** | no |

El gate comprueba cinco garantías, cada una con código propio:
`APP_CONJUNTO_DISTINTO`, `BACKUP_CONJUNTO_DISTINTO`/`BACKUP_NO_RENDERIZA`,
`TOTAL_DISTINTO`/`BLOQUES_SOLAPAN`, `CONTAMINACION_APP`/`PERFIL_ANCHO_NO_DECLARADO`
y `FLAG_OBLIGATORIA_AUSENTE`. La cuarta es la pedida por el operador, y tiene
dos mitades a propósito:

- que el perfil elegido para APP_STACK **no** arrastre `backup` (hoy);
- que **cualquier** perfil del compose que renderice `backup` esté declarado en
  `perfiles_rechazados` (mañana). Sin esta segunda mitad, un PR futuro que
  añadiera `development` a `profiles:` de `backup` pasaría en verde.

No reimplementa nada de #138: importa su renderizador (`renderizar`) y consume
`servicios_esperados` y `gestionados_aparte` del mismo contrato, para que no
puedan existir dos verdades sobre el mismo conjunto.

Las dos invocaciones las emite el propio gate desde el contrato que verifica:

```
node infrastructure/scripts/backup-stack-gate.mjs --invocacion \
  --project-directory <dir-de-produccion> --tag-backup ad0a42b
```

## 2. Construcción de `s9arena/backup:ad0a42b`

**Regla que no se negocia:** nunca construir desde el árbol de producción. El
`build.context: ..` del compose se resuelve contra `--project-directory`, y con
el de producción el render dice literalmente `context: /opt` — construiría el
árbol equivocado. Es el incidente 1 de ADR-016 (árbol viejo etiquetado con el
commit nuevo).

### Camino A (preferido): usar el artefacto que ya construyó la CI

**La etiqueta NO es el commit corto.** La CI publica con el prefijo `sha-` y el
sha **completo** (`.github/workflows/ci.yml`, job `build-images`:
`tags: <prefijo>/<servicio>:sha-${{ github.sha }}` y `:v<version>`, con
`push: github.ref == 'refs/heads/main'`). Por eso
`…/backup:ad0a42b` devuelve `not found`: esa etiqueta no existe y nunca
existió. La referencia literal verificada es:

```
ghcr.io/pjclavero/s9-ai-arena/backup:sha-ad0a42b79503ede4d726be9899960d817b70ce97
```

Comprobada con estos dos comandos, ambos contra el **registro** (el almacén
local de Docker no es autoridad):

```
docker manifest inspect \
  ghcr.io/pjclavero/s9-ai-arena/backup:sha-ad0a42b79503ede4d726be9899960d817b70ce97
# → resuelve (EXISTE)

docker buildx imagetools inspect \
  ghcr.io/pjclavero/s9-ai-arena/backup:sha-ad0a42b79503ede4d726be9899960d817b70ce97 \
  --format '{{.Manifest.Digest}}'
# → sha256:79cb2eb34660c922c4a036862f6c5b9d6a5a946a61b07dadb73efac4fcc89b1b
```

Para constancia: `ghcr.io/pjclavero/s9-ai-arena/backup:main` **no existe**
(`manifest unknown`) — no se publica etiqueta de rama. Publica por etiqueta
`sha-<sha completo>` y por `v<version>`; el digest lo asigna el registro y es lo
que se usa para descargar.

- digest: `sha256:79cb2eb34660c922c4a036862f6c5b9d6a5a946a61b07dadb73efac4fcc89b1b`
- `org.opencontainers.image.revision` = `ad0a42b79503ede4d726be9899960d817b70ce97`
- `org.opencontainers.image.title` = `backup`
- `BUILD_COMMIT` = mismo sha, `BUILD_DATE` = `2026-09-03T23:28:12Z`

Procedimiento (para cuando se autorice):

```
D=sha256:79cb2eb34660c922c4a036862f6c5b9d6a5a946a61b07dadb73efac4fcc89b1b
docker pull ghcr.io/pjclavero/s9-ai-arena/backup@$D
docker tag  ghcr.io/pjclavero/s9-ai-arena/backup@$D s9arena/backup:ad0a42b
```

Se descarga **por digest**, no por etiqueta: una etiqueta puede moverse bajo los
pies (incidente 3 de ADR-016).

### El nombre local y su encaje con `TAG`: `BACKUP_TAG`

La pregunta era legítima y la respuesta anterior era ambigua, así que el compose
deja de permitir la ambigüedad. Antes, `backup` derivaba su imagen de
`${TAG}`, y eso dejaba sólo dos salidas, las dos malas:

- **retaguear a `s9arena/backup:4d469dc`** — una etiqueta que dice `4d469dc`
  sobre contenido `ad0a42b`. Es **exactamente** el incidente 1 de ADR-016, y
  `verify-image-provenance.mjs` lo pondría rojo con razón;
- **mover `TAG` en la línea de comandos** — cambia la referencia de los **otros
  once** servicios en el mismo render.

Este PR implementa la tercera salida, la que quedó propuesta y ahora ya no lo
está (era territorio de #137, ya mergeado):

```yaml
image: ${IMAGE_PREFIX:-ghcr.io/pjclavero/s9-ai-arena}/backup:${BACKUP_TAG:-latest}
```

Medido con Docker real, no deducido (`docker compose config --images` sobre un
compose mínimo con las dos formas; fixture `interpolacion_medida`):

| Variables | `api` | `backup` |
| --- | --- | --- |
| `TAG=4d469dc` (sin `BACKUP_TAG`) | `s9arena/api:4d469dc` | `s9arena/backup:latest` ← **fail-closed** |
| `TAG=4d469dc`, `BACKUP_TAG=ad0a42b` | `s9arena/api:4d469dc` | `s9arena/backup:ad0a42b` |
| `TAG=CENTINELA`, `BACKUP_TAG=ad0a42b` | `s9arena/api:CENTINELA` | `s9arena/backup:ad0a42b` ← **no se mueve** |

**Respuesta directa: el retag local es `s9arena/backup:ad0a42b`, y la alineación
NO exige tocar `TAG`.** El `TAG=4d469dc` de los otros once servicios se queda
donde está. No se anida `${BACKUP_TAG:-${TAG:-latest}}` a propósito: heredar
`TAG` en silencio reintroduciría el acoplamiento que la variable existe para
romper.

El contrato declara `entorno.BACKUP_TAG = "ad0a42b"` y
`bloques.BACKUP_STACK.imagen_esperada = "s9arena/backup:ad0a42b"`. Eso es el
**objetivo**, no lo que corre: mientras no se ejecute la alineación,
`IMAGEN_DIVERGENTE` para `backup` está ROJO **a propósito**, y ponerse verde es
la señal de que la alineación ocurrió. El gate lo comprueba con dos garantías
(`BACKUP_IMAGEN_DISTINTA` y `TAG_GLOBAL_ARRASTRA_BACKUP`), la segunda **por
efecto**: renderiza con un TAG centinela y exige que la imagen de `backup` no se
mueva. Leer del YAML que pone `${BACKUP_TAG}` no valdría — una interpolación
anidada sería cierta en el texto y falsa en el render.

### Camino B (respaldo): construir desde un clon del REMOTO

Sólo si GHCR no está disponible. Nunca `git clone` de una ruta local (los
hardlinks de `.git/objects` han vaciado ya un repositorio en este proyecto):

```
umask 077
D=$(mktemp -d /var/tmp/backup-build-XXXXXX)
git clone https://github.com/pjclavero/s9-ai-arena.git "$D/src"     # remoto
git -C "$D/src" checkout ad0a42b79503ede4d726be9899960d817b70ce97
git -C "$D/src" rev-parse HEAD                                       # tiene que imprimir ese sha
test -z "$(git -C "$D/src" status --porcelain)"                      # árbol limpio o se para

docker build \
  -f "$D/src/infrastructure/docker/backup/Dockerfile" \
  --build-arg BUILD_COMMIT=ad0a42b79503ede4d726be9899960d817b70ce97 \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg SERVICE_NAME=backup \
  -t s9arena/backup:ad0a42b \
  "$D/src"                        # el CONTEXTO es el clon, jamás el árbol de producción

rm -rf "$D"                       # rm -rf, nunca shred
```

Los tres `--build-arg` son los mismos que pasa la CI (`.github/workflows/ci.yml`,
job `build-images`). Sin ellos la imagen queda marcada `unknown` y **no hereda
un commit por descuido**, que es justo lo que se quiere.

**Advertencia sobre `restic`:** el Dockerfile instala `restic` **sin versión
fijada**, por una decisión documentada en él. Una imagen construida hoy puede
traer una versión distinta de la 0.16.4 que corre. El guion de verificación (§5)
registra `restic version` de la imagen nueva; si sube de 0.17, hay que releer la
nota del Dockerfile sobre `snapshots --json` y `forget --group-by` antes de
autorizar nada.

### Verificación de contenido, con control negativo

El control negativo es la imagen que corre hoy, cuyos cuatro defectos están
medidos (§0). El mismo comando sobre las dos imágenes:

```
for IMG in s9arena/backup:ad0a42b s9arena/backup:11b36a7; do
  echo "== $IMG"
  docker run --rm --network none --entrypoint sh "$IMG" -c '
    ls /usr/local/bin/lib/setup-ssh.sh /usr/local/bin/healthcheck.sh 2>&1
    echo "RESTIC_HOSTNAME=$(grep -c RESTIC_HOSTNAME /usr/local/bin/backup.sh)"
    echo "schema2=$(grep -c "\"schema\":2" /usr/local/bin/backup.sh)"
    echo "selector=$(grep -c snapshot_selector_or_die /usr/local/bin/restore.sh)"
    restic version'
done
```

| Marcador | `:11b36a7` (medido) | `:ad0a42b` (esperado, del repo en ad0a42b) |
| --- | --- | --- |
| `lib/setup-ssh.sh` | ausente | presente |
| `healthcheck.sh` | ausente | presente |
| `RESTIC_HOSTNAME` en `backup.sh` | 0 | 15 |
| `"schema":2` en `backup.sh` | 0 | 2 |
| `snapshot_selector_or_die` en `restore.sh` | 0 | 4 |

**Qué demuestra:** que el contenido de la imagen nueva es el del árbol
`ad0a42b` en los cuatro puntos que motivan la alineación, y que la vieja no lo
es. **Qué NO demuestra:** que el backup funcione — eso sólo lo demuestra una
ejecución real (§5).

## 3. Cadena de procedencia

`backup` **no expone `/version`**. Comprobado: ADR-016 enumera quién lo expone
—los servicios Express (`api`, `arena-engine`, `map-service`, `replay-service`,
`bot-manager`), `streamer`, `web` y `gateway` (fichero estático) y
`tournament-worker` (fichero `/tmp/version.json`)— y `backup` no aparece en esa
lista ni una vez en todo el ADR. No inventes un endpoint: no lo hay.

La cadena, eslabón a eslabón:

| Eslabón | Cómo se observa | Qué demuestra |
| --- | --- | --- |
| Registro → artefacto | `docker buildx imagetools inspect …@sha256:79cb2eb3…` | que ese digest existe y qué contiene su config |
| Artefacto → commit | `docker image inspect s9arena/backup:ad0a42b -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'` | que el commit viaja DENTRO de la imagen (rompe la tautología de la etiqueta) |
| Etiqueta ↔ metadata ↔ servicio | `node infrastructure/scripts/verify-image-provenance.mjs --image s9arena/backup:ad0a42b --commit ad0a42b79503ede4d726be9899960d817b70ce97 --service backup --no-runtime` | las tres coherencias que sí aplican |
| Artefacto → proceso | `docker exec infrastructure-backup-1 printenv BUILD_COMMIT` | que **lo que corre** es esa imagen |

`--no-runtime` es **obligatorio** aquí: sin él el verificador intentaría un
`GET /version` que este servicio no sirve, y un rojo por endpoint inexistente no
es un defecto de procedencia. El eslabón de runtime lo cubre `printenv`, que lee
el `ENV BUILD_COMMIT` que el Dockerfile promueve desde el `ARG`.

**Qué NO demuestra `--no-runtime`:** nada sobre el proceso. Por eso el
`printenv` no es opcional: sin él, la procedencia queda verificada sobre una
imagen que podría no ser la que el contenedor está ejecutando.

### Si el registro no responde (ADR-018 aplicado a este carril)

Los dos primeros eslabones consultan GHCR, así que pueden fallar por red, por
rate-limit o porque falte el cliente. **Ese fallo NO se lee como «la imagen es
incorrecta»**: es *no comprobado*, bloquea igual, y se reintenta. No se duplica
aquí ninguna tabla de estados: la distinción vive donde le toca, en el gate de
despliegue, que separa «el registro dice que no» (`N2_DIGEST_NO_RESUELVE`) de
«no pude preguntar» (`N2_REGISTRO_INACCESIBLE`).

Este carril amplía esa segunda clase con un caso medido: ejecutando el gate con
`--registro` **sin `docker` en el PATH**, el error `spawnSync docker ENOENT` se
clasificaba como `N2_DIGEST_NO_RESUELVE`, es decir «ese digest no existe» —
falso, existe y lo que faltaba era el cliente. Ahora sale
`N2_REGISTRO_INACCESIBLE`. Sigue siendo rojo (no comprobado no es aprobado),
pero deja de mandar a nadie a reconstruir una imagen que está bien. Es el mismo
error que ADR-018 corrige en `scan`, aplicado a la herramienta en vez de a la
red.

En la práctica, para este procedimiento: si `docker manifest inspect` o
`buildx imagetools inspect` fallan, **no se pasa al Camino B automáticamente**
—eso sería tratar una fuente caída como un veredicto—; se reintenta, y sólo si
el registro responde de verdad que la referencia no existe se cambia de camino.

## 4. Comando de recreación · RENDERIZADO, sin ejecutar

Renderizado con `docker compose config` (que sólo renderiza) sobre el árbol de
producción, con `TAG=ad0a42b` y perfil `production`. Esto es exactamente lo que
resolvería:

```yaml
backup:
  image: s9arena/backup:ad0a42b          # hoy: s9arena/backup:11b36a7
  profiles: [production, external-db]
  healthcheck:
    test: [CMD-SHELL, /usr/local/bin/healthcheck.sh]   # hoy: pgrep crond
    interval: 1m0s  timeout: 10s  retries: 3  start_period: 30s
  environment:
    RESTIC_HOSTNAME: arena-backup-host   # hoy: AUSENTE
    BACKUP_CRON: 15 4 * * *
    REPLAY_RETENTION_DAYS: "180"
    RESTIC_REPOSITORY: sftp:<backup-host>:<backup-path>
    RESTIC_PASSWORD_FILE: /run/secrets/<secret-name>
    RESTIC_SSH_KEY_FILE: /run/secrets/<secret-name>
    RESTIC_SSH_KNOWN_HOSTS_FILE: /run/secrets/<secret-name>
    PGHOST: postgres  PGUSER: arena  PGDATABASE: arena
    PGPASSWORD_FILE: /run/secrets/<secret-name>
    METRICS_DIR: /textfile  WORK_DIR: /tmp/backup-work
  depends_on: { postgres: { condition: service_healthy, required: false } }
  build:
    context: /opt                        # ← POR ESO --no-build ES OBLIGATORIO
    dockerfile: infrastructure/docker/backup/Dockerfile
```

El comando (**no ejecutado**), literal y sin ambigüedad:

```
BACKUP_TAG=ad0a42b IMAGE_PREFIX=s9arena docker compose \
  -f infrastructure/docker-compose.yml \
  --env-file infrastructure/.env \
  -p infrastructure \
  --project-directory <dir-de-produccion> \
  --profile production \
  up -d --no-build --no-deps --force-recreate backup
```

`TAG` **no aparece**: lo aporta el `.env` y sigue valiendo `4d469dc` para los
otros once servicios. Antes de ejecutarlo, el render tiene que confirmarlo:

```
BACKUP_TAG=ad0a42b IMAGE_PREFIX=s9arena docker compose … --profile production config --images
# los 11 servicios de aplicación en :4d469dc y SÓLO backup en :ad0a42b
```

Qué hace cada pieza, y qué pasaría sin ella:

- **`--no-build`** — sin él, `build.context: /opt` construiría el árbol
  equivocado y lo etiquetaría `ad0a42b`. El incidente original del proyecto.
- **`--no-deps`** — `depends_on` apunta a `postgres`, que es **NO RESTART**.
  Sin `--no-deps`, `up` es libre de tocarlo.
- **`backup` al final** — nombrar el servicio es lo único que impide que
  `--profile production` recree los doce. Sin ese argumento, `TAG=ad0a42b`
  buscaría `s9arena/api:ad0a42b` y compañía, que **no existen en el daemon**:
  el `up` fallaría, o peor, arrastraría servicios sanos.
- **`--project-directory` de producción** — es donde viven `.env`, `secrets/` y
  los `./secrets:ro`. Con otro directorio, los secretos no resuelven.

**Riesgo que ESTE PR elimina:** en la versión anterior del compose había que
pasar `TAG=ad0a42b`, que afecta a **todos** los servicios del render y dejaba
como única protección el nombrar el servicio. Con `BACKUP_TAG` esa clase de
accidente deja de existir: aunque alguien olvide el argumento `backup` final, el
render de los otros once sigue en `:4d469dc` y `--no-deps` impide arrastrar
`postgres`.

**Barrera adicional confirmada (y ahora explicada):** hoy, sin `BACKUP_TAG` en
el `.env`, el compose pide `s9arena/backup:latest`, imagen que no existe en el
daemon. Con `--no-build`, un intento falla **en seco** en lugar de crear un
contenedor roto. El defecto `latest` es deliberado por eso mismo.

## 5. Guion de verificación posterior (para cuando se autorice)

Cada paso declara qué demuestra y qué no.

**V1 · procedencia** — `docker exec infrastructure-backup-1 printenv BUILD_COMMIT`
debe imprimir `ad0a42b79503ede4d726be9899960d817b70ce97`.
*Demuestra:* el proceso corre la imagen construida desde ese commit.
*No demuestra:* que el backup funcione.

**V0 · captura previa (obligatoria, ANTES de recrear)** — sin esto, V2 no es
verificable:

```
docker exec infrastructure-backup-1 \
  grep '^s9_backup_last_success_timestamp_seconds' /textfile/s9_backup.prom
# anotar el valor: T_ANTES
```

**V2 · healthcheck real** —
`docker inspect infrastructure-backup-1 --format '{{json .Config.Healthcheck}}'`
debe contener `/usr/local/bin/healthcheck.sh`, **no** `pgrep crond`.
*Demuestra:* el contenedor se juzga por la copia, no por el demonio.
*No demuestra:* **nada sobre la imagen nueva.** Confirmado leyendo
`infrastructure/backup/healthcheck.sh`: decide el color a partir de
`$METRICS_DIR/s9_backup.prom`, que vive en el volumen **nombrado**
`backup_metrics` y por tanto **sobrevive a la recreación**. Un `healthy`
inmediato está leyendo la ejecución **anterior** —la del 04:15 hecha por la
imagen vieja— y sería verde aunque la imagen nueva estuviera rota.

> **CRITERIO DE ACEPTACIÓN V2 (no es una nota):** un `healthy` sólo se acepta si
> `s9_backup_last_success_timestamp_seconds` es **estrictamente mayor** que
> `T_ANTES`. Mientras valga `T_ANTES`, el estado del contenedor es
> **NO CONCLUYENTE**, se registre como se registre, y la alineación no se da por
> buena. Es decir: **V2 no se cierra hasta que V4 haya producido una ejecución
> nueva.**
>
> Caso límite, también comprobado en el guion: si alguien vaciara el volumen de
> métricas, `healthcheck.sh` no falla de inmediato — hay una ventana de arranque
> (`BACKUP_HEALTH_GRACE_HOURS`, por defecto 26 h) en la que la ausencia de
> métricas sale `BACKUP STARTING` con **exit 0**. Otra razón por la que el color
> del contenedor no sirve como prueba de la alineación: hay que mirar la marca
> de tiempo, no el semáforo.

**V3 · ejecución en seco** —
`docker exec infrastructure-backup-1 /usr/local/bin/backup.sh --dry-run`.
Debe imprimir `PLAN 4/5 … --host arena-backup-host`, `PLAN 5/5 … --host
arena-backup-host --group-by host,tags`, `SFTP · ssh presente` y `CONFIG OK`.
Códigos: `0` config completa, `1` config incompleta, `3` backend sftp mal
configurado. **`3` es de despliegue, no transitorio: se para aquí.**
*Demuestra:* configuración, hostname estable y cliente ssh presentes; no escribe
nada. *No demuestra:* que restic alcance el destino ni que el `pg_dump` salga.

**V4 · ejecución real** — `docker exec infrastructure-backup-1 /usr/local/bin/backup.sh`.
Sólo tras V1 y V3 en verde y dentro de la ventana (§6); V2 queda abierto hasta
aquí por construcción. Después, lo primero es cerrar V2:

```
docker exec infrastructure-backup-1 \
  grep '^s9_backup_last_success_timestamp_seconds' /textfile/s9_backup.prom
# tiene que ser > T_ANTES; si no lo es, la copia NO se ha ejecutado y el healthy
# que hubiera es del registro viejo: PARAR y hacer rollback (§7).
```

Y a continuación:

```
# snapshot nuevo bajo el hostname LÓGICO
docker exec infrastructure-backup-1 restic --no-lock snapshots --host arena-backup-host --json

# manifest de esquema 2 y pg_dump dentro del snapshot
docker exec infrastructure-backup-1 restic --no-lock dump <snapshot> \
  /tmp/backup-work/staging/manifest.json | head -c 200      # debe empezar por {"schema":2
docker exec infrastructure-backup-1 restic --no-lock ls <snapshot> | grep pgdump-
docker exec infrastructure-backup-1 restic --no-lock dump <snapshot> \
  /tmp/backup-work/staging/manifest.sha256 | grep pgdump-   # su SHA-256 debe estar aquí
```

*Demuestra:* que la copia nueva existe, que su manifest declara `schema 2`, que
el `pg_dump` está presente y que su SHA-256 figura en `manifest.sha256` — es
decir, que la copia es **verificable**, cosa que ninguno de los 35 snapshots
actuales es. *No demuestra:* que se pueda restaurar. Eso es el simulacro de
`docs/recuperacion.md`, y es un carril propio.

`restic check` **no** aparece en ningún paso de comprobación manual: toma lock y
escribe. Lo ejecuta `backup.sh` al final de una ejecución real, y ahí es donde
debe quedarse.

## 6. Ventana segura

El cron del contenedor dispara a las **04:15 UTC** (`BACKUP_CRON=15 4 * * *`).
La ejecución medida el 2026-09-04 duró **6 s**, pero el margen no se calcula con
la duración típica: un `forget --prune` puede tardar mucho más.

**Ventana recomendada: 06:00–23:00 UTC.** Deja >1 h de cola tras la ejecución
programada y >5 h antes de la siguiente.

Comprobar que no hay copia en curso, antes de tocar nada:

```
# 1. ¿hay un backup.sh vivo dentro del contenedor?  (PID explícito, no `pgrep -f`
#    con la propia cadena: se encontraría a sí mismo)
docker exec infrastructure-backup-1 sh -c 'pgrep -x backup.sh || echo "sin backup en curso"'

# 2. ¿hay lock en el repositorio?  (list, que NO toma lock; nunca `restic check`)
docker exec infrastructure-backup-1 restic --no-lock list locks

# 3. ¿cuándo fue el último éxito?
docker exec infrastructure-backup-1 grep last_success /textfile/s9_backup.prom
```

Los tres tienen que estar tranquilos. Un lock presente **no** se quita con
`restic unlock`: significa que hay algo corriendo o que algo murió a medias, y
las dos cosas se investigan, no se fuerzan.

## 7. Rollback exacto a `:11b36a7`

La imagen vieja se referencia **por image ID**, no por etiqueta: una etiqueta
puede moverse. Y su existencia se comprueba con `docker image inspect`, **nunca**
con `docker images -q`, que omite las imágenes sin etiqueta de nivel superior
(ese listado ya produjo a la vez un drift crítico falso y ceguera al drift
verdadero — ADR-016, incidente 3).

```
# ANTES de recrear nada: anotar la ID y comprobar que existe DE VERDAD
ID=$(docker inspect infrastructure-backup-1 --format '{{.Image}}')
echo "$ID"                                  # medido hoy: sha256:feb305c788c5…
docker image inspect "$ID" >/dev/null && echo "la imagen de rollback EXISTE"
```

Si `docker image inspect` falla, **no hay rollback** y la alineación no debe
empezar: se estaría trabajando sin red.

Rollback (misma envoltura, la ID en lugar de la etiqueta):

```
docker tag <ID> s9arena/backup:11b36a7      # sólo si la etiqueta se hubiera perdido
TAG=11b36a7 IMAGE_PREFIX=s9arena docker compose \
  -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  -p infrastructure --project-directory <dir-de-produccion> \
  --profile production up -d --no-build --no-deps --force-recreate backup
```

**Aviso:** el rollback devuelve la imagen vieja, pero el compose de `ad0a42b`
seguirá declarando `healthcheck: /usr/local/bin/healthcheck.sh`, que **no existe
en `:11b36a7`** (§0). Tras un rollback el contenedor quedará `unhealthy` aunque
la copia funcione. Es un rollback de imagen, no de contrato; hay que saberlo
antes, no descubrirlo a las 04:15.

### Criterio de aceptación ejecutable (#137, ya en `main`)

Los tres códigos de `compose-canonical-check.mjs` que hoy salen ROJOS para
`backup` y que la alineación tiene que apagar, medibles antes y después:

| Código | Por qué está rojo hoy | Cuándo se apaga |
| --- | --- | --- |
| `IMAGEN_DIVERGENTE` | canónico `s9arena/backup:ad0a42b` (declarado en `entorno.BACKUP_TAG`) frente a vivo `s9arena/backup:11b36a7` | al recrear con la imagen nueva |
| `ENV_FALTA(RESTIC_HOSTNAME)` | el contenedor vivo no tiene la variable | al recrear con el compose de `main` |
| `HEALTHCHECK_DIVERGENTE` | vivo `pgrep crond` frente a canónico `healthcheck.sh` | al recrear (y sólo entonces el fichero existe en la imagen) |

Los tres se apagan **con la misma recreación**, que es otra forma de decir lo
del §0: imagen y compose se alinean a la vez.

## 8. Efecto sobre la retención

Estado medido hoy en el repositorio (35 snapshots):

| hostname | tags | n | último |
| --- | --- | --- | --- |
| `s9-arena` | `s9-arena-primer-backup` | 1 | 2026-08-09 |
| `9b22f5959ea2` | `s9-arena-data` / `s9-arena-secrets` | 1 + 1 | 2026-08-13 |
| `a834a832b86e` | `s9-arena-data` / `s9-arena-secrets` | 16 + 16 | 2026-09-04 |

Los dos hexadecimales son **IDs de contenedor**: el hostname por defecto que
restic toma cuando nadie le pasa `--host`. Cambian en cada recreación; por eso
existe `RESTIC_HOSTNAME`.

`backup.sh` de la imagen en marcha ejecuta:

```
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

sin `--host` y sin `--group-by`. Con restic 0.16.4 el agrupamiento **por
defecto** es `host,paths`, así que hoy hay **5 grupos** (3 hostnames × sus rutas)
y cada uno se poda por separado. El grupo grande (`a834a832b86e` /
`/tmp/backup-work/staging`) tiene 16 diarios y `--keep-daily 14`, es decir que
**ya está podando** (los dos más viejos caen por diario y sobreviven por semanal
o mensual según la fecha).

La versión alineada ejecuta:

```
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune \
  --host arena-backup-host --group-by host,tags
```

Aparece un **cuarto hostname**, `arena-backup-host`. Efecto de la primera poda
alineada, y por qué:

1. **`--host arena-backup-host` es un FILTRO de candidatos.** Los snapshots de
   los otros tres hostnames dejan de ser siquiera considerados: no se pueden
   borrar. No es que "sobrevivan a la política": es que no entran en ella.
2. **Dentro del hostname nuevo habrá 2 snapshots** (uno `s9-arena-data`, uno
   `s9-arena-secrets`), en **2 grupos** distintos por `--group-by host,tags`.
   Con `--keep-daily 14`, un grupo de 1 conserva su único snapshot.

**Conclusión: la primera poda alineada no borra nada.** Ninguno de los dos
caminos por los que podría borrar está abierto — el legado queda fuera del
filtro, y lo nuevo está muy por debajo del mínimo que se conserva.

**Lo que sí cambia, y hay que declararlo:** a partir de la alineación, los 35
snapshots legados quedan **permanentemente exentos de retención**. Ningún
`forget` con `--host arena-backup-host` volverá a mirarlos, así que el
repositorio conserva ese lastre para siempre salvo que alguien lo pode
deliberadamente. Eso es una decisión del operador, con dos opciones y ninguna
inocua:

- **dejarlos** — 35 snapshots de coste fijo, y el historial anterior a la
  alineación se conserva íntegro;
- **podarlos** — un `forget` explícito por hostname legado. Es **destructivo** y
  escribe en el repositorio: no entra en este carril, necesita su propia
  autorización, su ventana, y comprobar antes que la copia nueva ya es
  verificable (§5 V4).

Falsable, además, y así debe comprobarse: si tras la primera ejecución alineada
`restic --no-lock snapshots` devolviera **menos de 35 + 2** snapshots, esta
sección es **falsa** y hay que pararlo todo antes de la segunda ejecución.
