# Compose canónico · fuente única de verdad del stack desplegado

> Estado: **procedimiento propuesto, NO aplicado.** Este carril no despliega
> nada. La aplicación es decisión del operador, y va **antes** de alinear
> `backup`.

## 1. El problema, medido

Los 12 contenedores del proyecto Compose `infrastructure` declaran **tres**
`com.docker.compose.project.config_files` distintos:

| Procedencia | Servicios |
| --- | --- |
| árbol de construcción A (temporal) | `api`, `arena-engine`, `bot-build-worker`, `bot-manager`, `gateway`, `map-service`, `replay-service`, `tournament-worker`, `web` |
| árbol de construcción B (temporal) | `backup` |
| directorio de despliegue | `postgres`, `queue` |

Todos comparten `working_dir` (el directorio de despliegue), porque cada
servicio se desplegó desde el árbol de **su** versión con `--project-directory`
de producción y `--no-build`. Servicio a servicio funcionó. El conjunto quedó
irreproducible: **ningún `docker compose` de la máquina rehace hoy lo que está
corriendo.**

La deriva es invisible para `docker ps` y para el escáner de imágenes —todas las
imágenes existen y todas las etiquetas cuadran—. Vive sólo en la etiqueta de
procedencia.

### 1.1 Tres defectos que agravan el cuadro

**(a) El directorio de despliegue está en un commit viejo.** Su
`docker-compose.yml` no tiene `RESTIC_HOSTNAME`, `ARENA_DATA_DIRS`, el secreto
`replay_ingest_secret`, el pin de `postgres`, ni el healthcheck de `backup`.

**(b) `TAG` vale `local` en el `.env` de producción.** Los contenedores corren
`…:4d469dc`. Un `docker compose up --no-build` desde el directorio de despliegue
buscaría hoy `s9arena/api:local` y compañía: **recrearía los doce servicios
contra imágenes que no son las desplegadas**, o fallaría por imagen inexistente.
Antes de cualquier canonización, `TAG` tiene que apuntar a la versión desplegada.

**(c) El pin de `postgres` es irresoluble.** El compose de `main` declara
`postgres:16-alpine@sha256:57c72fd2a128…`, pero ese sha256 es el **image ID
local** del contenedor en marcha, no un digest de registro:

```
docker image inspect 'postgres:16-alpine@sha256:57c72fd2a128…'
  → Error response from daemon: No such image
```

Además, la imagen en marcha (`57c72fd2a128…`) está **sin etiquetas y sin
RepoDigests**: no se la puede nombrar por ninguna referencia. Y la etiqueta
`postgres:16-alpine` apunta hoy a **otra** imagen (`cf78e766…`, PG 16.15 frente
al 16.14 que corre). Consecuencias:

- un `up` de `postgres` desde `main` **falla**: la referencia no resuelve;
- si se «arreglara» el pin poniendo la etiqueta a secas, el `up` **recrearía**
  `postgres` sobre una versión distinta de PostgreSQL — lo que DO NOT RESTART
  existe para impedir.

**No hay hoy ninguna referencia con la que un compose pueda reproducir el
`postgres` en marcha.** La única razón de que siga vivo es que nadie lo recrea.

## 2. Diferencia entre lo desplegado y `main`

Renderizando `main` con el perfil `production` y las variables reales del
despliegue, y comparando con la spec real de cada contenedor vivo (montajes por
destino + origen lógico + rw/ro + tipo, entorno, secretos, command/entrypoint,
healthcheck, puertos publicados):

| Servicio | ¿`main` lo reproduce idéntico? | Qué cambiaría al recrearlo |
| --- | --- | --- |
| `gateway` | Sí | — |
| `web` | Sí | — |
| `arena-engine` | Sí | — |
| `tournament-worker` | Sí | — |
| `replay-service` | Sí | — |
| `bot-manager` | Sí | — |
| `bot-build-worker` | Sí | — |
| `map-service` | Sí | — |
| `queue` | Sí | — |
| `api` | **No** | añade `S9_MAX_CONCURRENT_REAL_BATTLE_RUNS` |
| `backup` | **No** | imagen `11b36a7` → `4d469dc`; añade `RESTIC_HOSTNAME`; healthcheck `pgrep crond` → `/usr/local/bin/healthcheck.sh` |
| `postgres` | **No** | referencia de imagen; **irresoluble**, ver 1.1(c) |

Los nueve primeros ya coinciden en spec con `main`: sólo arrastran una
procedencia equivocada. **Ocho de ellos son inocuos de recrear** (`queue` no,
ver §4). Los tres últimos cambian de verdad.

## 3. Procedimiento de canonización

Principio: **la fuente única de verdad es el `docker-compose.yml` que vive en el
directorio de despliegue**, y todo despliegue lo invoca desde ahí, con
`--no-build`, sin `--project-directory` apuntando a otro sitio.

### Antes (todo lectura, nada se aplica)

1. Capturar los hechos del stack vivo:
   ```
   node infrastructure/scripts/runtime-drift-scan.mjs --collect > hechos.json
   ```
2. Ejecutar el comprobador contra el compose que se propone canonizar:
   ```
   node infrastructure/scripts/compose-canonical-check.mjs \
     --facts hechos.json --compose <despliegue>/infrastructure/docker-compose.yml \
     --profile production --compose-env TAG=<versión desplegada> …
   ```
   Anotar la lista `Recrear al canonizar`. **Esa lista es el alcance del cambio.**
   Si aparece un servicio que no se esperaba, el procedimiento se para.
3. Comprobar que el render no está vacío: `COMPOSE_PROFILES=production docker
   compose config --services` tiene que listar los 12. Sin perfil lista **cero**
   (todos los servicios llevan `profiles:`), y comparar contra el conjunto vacío
   daría un falso verde.

### Aplicación

4. **Corregir `TAG` en el `.env` del despliegue** para que valga la versión
   desplegada, no `local`. Sin esto, cualquier `up` recrea los doce servicios
   contra imágenes equivocadas. Verificar con `docker compose config --images`:
   la lista tiene que coincidir con `docker ps --format '{{.Image}}'`.
5. **Resolver el pin de `postgres` antes de tocar nada más.** Opciones, por orden
   de preferencia:
   - a) reetiquetar localmente la imagen en marcha para poder nombrarla
     (`docker tag <image-id> <etiqueta local estable>`) y referenciar esa
     etiqueta en el compose. No recrea el contenedor y hace el estado
     nombrable — hoy no lo es.
   - b) dejar `postgres` fuera del alcance y documentarlo (`--no-deps` en todo
     `up`, nunca `up` del proyecto entero).
   La opción (a) es la que devuelve reproducibilidad; la (b) sólo aplaza.
6. **Actualizar el árbol de despliegue a `main`**. Cuidado: ese árbol es también
   el contexto de construcción de algunos flujos. Como el operador exige
   `--no-build` en todo despliegue, el contexto no debería ejercitarse nunca;
   verificarlo explícitamente antes (`release-gate.mjs` ya rechaza un DEPLOY sin
   `--no-build`). Preservar `.env` y `secrets/`, que no están en el repositorio.
7. **Reetiquetar la procedencia sin recrear** los ocho servicios cuya spec ya
   coincide. `docker compose up --no-build --no-recreate <servicios>` desde el
   directorio canónico reconcilia las etiquetas sin tocar los contenedores
   cuando la configuración no ha cambiado. Verificar contenedor por contenedor
   que el `Created` **no** ha cambiado: si cambia, se recreó y hay que revisar
   por qué.
8. **Recrear sólo los que lo necesitan**, uno a uno y con su ventana: `api`,
   `backup`. `postgres` **no** (§4).

### Después

9. Repetir la captura de hechos y el comprobador. El veredicto tiene que ser
   `REPRODUCIBLE`, con **una sola** procedencia y esa procedencia
   `despliegue:`. Cualquier `arbol-ajeno:` residual es fallo.
10. Smoke del stack y `runtime-drift-scan.mjs` sin estados de drift.

## 4. Riesgo por servicio

| Servicio | ¿Recrear sin consecuencias? | Motivo |
| --- | --- | --- |
| `web`, `gateway`, `map-service`, `bot-manager`, `arena-engine` | Sí | sin estado propio; `gateway` corta el tráfico unos segundos |
| `replay-service`, `tournament-worker`, `bot-build-worker` | Con ventana | escriben en volúmenes compartidos (`arena_replays`, `arena_bot_sources`, `arena_build_cache`); recrear a mitad de una batalla o de una construcción pierde el trabajo en curso |
| `api` | Con ventana | corta la sesión de los usuarios conectados |
| `queue` | **Con cuidado** | Redis con `appendonly yes` sobre el volumen `queue_data`: los trabajos encolados sobreviven al reinicio, pero recrearlo con trabajos en vuelo los deja a medias. Ventana de cola vacía |
| `backup` | Con ventana propia | no recrear durante una ejecución de `restic`; además su alineación es un carril aparte, posterior a éste |
| `postgres` | **NO** | DO NOT RESTART. Y, además, hoy **no es reproducible**: su imagen no tiene etiqueta ni digest, y el pin del compose no resuelve (§1.1c) |

`postgres` es el único con estado durable irreemplazable. `queue` es el segundo
con estado y suele pasarse por alto: tiene persistencia activada.

## 5. Verificación ejecutable

`infrastructure/scripts/compose-canonical-check.mjs` consume los hechos que
produce el escáner del carril G (`runtime-drift-scan.mjs --collect`) y responde
si el stack vivo es reproducible desde el compose canónico. Se pone **rojo**
(rc=1) si:

- aparece una procedencia divergente (`CONFIG_FILES_DIVERGENTE`), hay más de una
  en el mismo proyecto (`CONFIG_FILES_MULTIPLE`) o falta la etiqueta
  (`CONFIG_FILES_AUSENTE`);
- la cobertura no cuadra (`SERVICIO_NO_RENDERIZADO`, `SERVICIO_NO_DESPLEGADO`);
- la spec real de un servicio no coincide con la renderizada: imagen, montajes,
  secretos, entorno, puertos publicados, command, entrypoint o healthcheck.

Además parte el stack en **`recrear`** (spec divergente: aplicar el canónico
cambia algo) y **`reetiquetar`** (sólo la procedencia está mal: el contenedor no
necesita tocarse). Esa partición es lo que hace que el procedimiento no recree
nada por inercia.

Calibración: `infrastructure/tests/compose-canonical-check.test.ts` (control
positivo + control negativo por cada garantía, sobre hechos REALES de
producción) y `infrastructure/scripts/compose-canonical-mutations.mjs`, que
estropea el comprobador de ocho maneras distintas y exige que la suite se ponga
roja con cada una.

### Topología

Ni los hechos ni el informe publican rutas de anfitrión ni IPs. `config_files` y
`working_dir` viajan como huella más un booleano («¿vive el compose dentro del
directorio de despliegue?»), que es lo único que hay que comprobar;
`command`/`entrypoint`/`healthcheck` del contenedor viajan hasheados, porque una
línea de arranque puede llevar un hostname o la ruta de un secreto. Cuando hay
que enseñar un literal, se enseña el del compose —que es público—, nunca el del
anfitrión.
