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

La CI construye y publica `backup` en cada `main`. Comprobado contra el
**registro** (no contra el almacén local, que no es autoridad):

```
docker buildx imagetools inspect \
  ghcr.io/pjclavero/s9-ai-arena/backup:sha-ad0a42b79503ede4d726be9899960d817b70ce97
```

- digest: `sha256:79cb2eb34660c922c4a036862f6c5b9d6a5a946a61b07dadb73efac4fcc89b1b`
- `org.opencontainers.image.revision` = `ad0a42b79503ede4d726be9899960d817b70ce97`
- `org.opencontainers.image.title` = `backup`
- `BUILD_COMMIT` = mismo sha, `BUILD_DATE` = `2026-09-03T23:28:12Z`

Procedimiento (para cuando se autorice):

```
S=ad0a42b79503ede4d726be9899960d817b70ce97
D=sha256:79cb2eb34660c922c4a036862f6c5b9d6a5a946a61b07dadb73efac4fcc89b1b
docker pull ghcr.io/pjclavero/s9-ai-arena/backup@$D
docker tag  ghcr.io/pjclavero/s9-ai-arena/backup@$D s9arena/backup:ad0a42b
```

Se descarga **por digest**, no por etiqueta: una etiqueta puede moverse bajo los
pies (incidente 3 de ADR-016).

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

El comando (**no ejecutado**):

```
TAG=ad0a42b IMAGE_PREFIX=s9arena docker compose \
  -f infrastructure/docker-compose.yml \
  --env-file infrastructure/.env \
  -p infrastructure \
  --project-directory <dir-de-produccion> \
  --profile production \
  up -d --no-build --no-deps --force-recreate backup
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

**Riesgo declarado:** `TAG=ad0a42b` en la línea de comandos afecta a **todos**
los servicios del render, no sólo a `backup`. La única protección es nombrar el
servicio. Una alternativa más segura para el futuro —`image: …/backup:${BACKUP_TAG:-${TAG:-latest}}`—
se deja **propuesta y no implementada**: toca el compose, que es territorio de
la canonización (#137), y hacerlo aquí crearía dos verdades sobre el mismo
fichero.

## 5. Guion de verificación posterior (para cuando se autorice)

Cada paso declara qué demuestra y qué no.

**V1 · procedencia** — `docker exec infrastructure-backup-1 printenv BUILD_COMMIT`
debe imprimir `ad0a42b79503ede4d726be9899960d817b70ce97`.
*Demuestra:* el proceso corre la imagen construida desde ese commit.
*No demuestra:* que el backup funcione.

**V2 · healthcheck real** —
`docker inspect infrastructure-backup-1 --format '{{json .Config.Healthcheck}}'`
debe contener `/usr/local/bin/healthcheck.sh`, **no** `pgrep crond`.
*Demuestra:* el contenedor se juzga por la copia, no por el demonio.
*No demuestra:* que esté sano por el motivo correcto — **ojo**: el volumen
`backup_metrics` persiste entre recreaciones, así que un `healthy` inmediato
está leyendo el registro de la copia **anterior** (la del 04:15 con la imagen
vieja). Un verde aquí no dice nada de la imagen nueva hasta V4.

**V3 · ejecución en seco** —
`docker exec infrastructure-backup-1 /usr/local/bin/backup.sh --dry-run`.
Debe imprimir `PLAN 4/5 … --host arena-backup-host`, `PLAN 5/5 … --host
arena-backup-host --group-by host,tags`, `SFTP · ssh presente` y `CONFIG OK`.
Códigos: `0` config completa, `1` config incompleta, `3` backend sftp mal
configurado. **`3` es de despliegue, no transitorio: se para aquí.**
*Demuestra:* configuración, hostname estable y cliente ssh presentes; no escribe
nada. *No demuestra:* que restic alcance el destino ni que el `pg_dump` salga.

**V4 · ejecución real** — `docker exec infrastructure-backup-1 /usr/local/bin/backup.sh`.
Sólo tras V1–V3 en verde y dentro de la ventana (§6). Después:

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
