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

### 1.1 Estado de los defectos que agravaban el cuadro

Tres cosas agravaban el cuadro cuando se abrió este carril. **Dos ya están
resueltas en producción** (hoy, y sin tocar el runtime), y la tercera resultó
ser en parte un error de diagnóstico de este mismo documento. Se dejan escritas
porque el matiz importa.

**(a) El directorio de despliegue estaba en un commit viejo — RESUELTO.**
Avanzado de `98f381e` a `ad0a42b` con `merge --ff-only`; `.env` y `secrets/`
intactos, verificado por sha256. Ya trae `RESTIC_HOSTNAME`, `ARENA_DATA_DIRS`,
`replay_ingest_secret`, el pin de `postgres` y el healthcheck de `backup`.

**(b) `TAG` valía `local` en el `.env` de producción — RESUELTO.** Ahora vale
`4d469dc`, la versión desplegada. Mientras valía `local`, un `up --no-build`
desde el despliegue habría buscado `s9arena/api:local` y habría revertido el
rollout entero. Render actual: 11 servicios (perfil `development`), `postgres`
con su digest, `backup` ausente a propósito, 0 condiciones peligrosas.

**(c) El pin de `postgres`: el defecto era la coherencia etiqueta↔digest, no el
digest.** Este documento afirmó que el digest `sha256:57c72fd2a128…` «no
resolvía» porque era el image ID local y no un digest de registro. **Era
incorrecto.** Medido contra el REGISTRO:

```
docker buildx imagetools inspect postgres:16.14-alpine
  Digest: sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
docker buildx imagetools inspect postgres@sha256:57c72fd2…
  → resuelve; índice OCI multiplataforma, PG_VERSION=16.14
```

El digest siempre fue válido y coincide con el índice OCI de `16.14-alpine`. Lo
que fallaba era otra cosa, y hay que distinguir las tres:

1. **Resolución LOCAL**: `docker image inspect postgres:16-alpine@sha256:57c7…`
   → `No such image`. Cierto, pero es un hecho del almacén local: esa imagen no
   tiene `RepoDigests` (está sin etiquetar), así que la búsqueda local por
   digest no la encuentra. **No dice nada sobre el registro.**
2. **Coherencia etiqueta↔digest**: el compose emparejaba la etiqueta
   `16-alpine` (que hoy apunta a 16.15) con el digest de `16.14-alpine`. *Ése*
   era el defecto real, y #138 lo corrigió a `postgres:16.14-alpine@sha256:57c7…`.
3. **Nombrabilidad de la imagen en marcha**: sigue sin `RepoTags` ni
   `RepoDigests` en el almacén local. Es una molestia operativa, no un
   impedimento para reproducirla: la referencia del contrato resuelve contra el
   registro.

> **La lección, que es el motivo de dejar esto escrito:** concluir sobre el
> REGISTRO desde un fallo del ALMACÉN LOCAL. #138 convirtió exactamente ese
> error en un control ejecutable (`N2_FUENTE_NO_AUTORIZADA`): el nivel 2 sólo
> acepta como autoridad una respuesta del registro. Cuando la evidencia venga
> del almacén local, la conclusión no puede pasar de ahí.

## 2. Diferencia entre lo desplegado y `main`

Renderizando `main` con el conjunto canónico del contrato (perfil `development`
más `backup` por nombre) y las variables reales del despliegue, y comparando con la spec real de cada contenedor vivo (montajes por
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
| `postgres` | **No** | referencia de imagen: el despliegue vivo declara `postgres:16-alpine`, el contrato `postgres:16.14-alpine@sha256:57c7…`. Misma imagen (el digest resuelve y coincide con la que corre), distinta cadena: un `up` lo recrearía |

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
     --contract infrastructure/deploy-contract.json
   ```
   Anotar la lista `Recrear al canonizar`. **Esa lista es el alcance del cambio.**
   Si aparece un servicio que no se esperaba, el procedimiento se para.
3. Comprobar que el render no está vacío. El conjunto canónico lo fija
   `infrastructure/deploy-contract.json`: **APP_STACK** (perfil `development`,
   11 servicios) más **`backup`** nombrado explícitamente — 12 en total. El
   perfil no se ensancha a 12 a propósito, para que ningún perfil pueda arrancar
   `backup` por accidente: tiene ventana propia. Sin perfil, el compose de este
   stack renderiza **cero** servicios (todos llevan `profiles:`), y comparar
   contra el conjunto vacío daría un falso verde; el comprobador sale con rc=2
   si el contrato no declara perfiles.

### Aplicación

Los pasos 4 y 6 **ya están hechos** (§1.1): `TAG=4d469dc` y el árbol de
despliegue en `ad0a42b`. Se dejan descritos porque forman parte del
procedimiento y hay que rehacerlos en cualquier despliegue futuro.

4. ~~Corregir `TAG`~~ **hecho**. Verificar siempre con `docker compose config
   --images` que la lista coincide con `docker ps --format '{{.Image}}'`.
5. **`postgres` no necesita arreglo de pin**: el contrato lo fija a
   `postgres:16.14-alpine@sha256:57c7…`, que resuelve en el registro y es la
   imagen que corre. Lo que sí queda es que **un `up` lo recrearía igualmente**,
   porque la cadena declarada en el contenedor vivo (`postgres:16-alpine`) no es
   la del contrato. Por eso `postgres` va con `--no-deps` y fuera del alcance de
   cualquier `up` del proyecto entero, hasta que el operador autorice su ventana.
6. ~~Actualizar el árbol de despliegue~~ **hecho** (`merge --ff-only`, `.env` y
   `secrets/` preservados y verificados por sha256). Nota para futuras
   actualizaciones: ese árbol es también el contexto de construcción de algunos
   flujos; como el operador exige `--no-build` en todo despliegue, el contexto no
   debería ejercitarse nunca, y `release-gate.mjs` ya rechaza un DEPLOY sin
   `--no-build`.
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
| `postgres` | **NO** | DO NOT RESTART: estado durable irreemplazable. La imagen SÍ es reproducible (el digest del contrato resuelve en el registro y es la que corre, §1.1c); lo que no puede hacerse es recrear el contenedor |

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
estropea el comprobador de diez maneras distintas y exige que la suite se ponga
roja con cada una.

### 5.1 Superficie para construir encima

El conjunto canónico NO se decide aquí: se lee de
`infrastructure/deploy-contract.json` (#138), y el contrato se carga con el
`cargar()` de `deploy-contract-gate.mjs`, no con un lector propio, para que un
contrato que aquel rechace tampoco valga aquí.

```
node infrastructure/scripts/compose-canonical-check.mjs \
  --facts hechos.json --contract infrastructure/deploy-contract.json [--json]
```

Lo que un carril que construya encima puede consumir sin duplicar nada:

| Export | Qué da |
| --- | --- |
| `comprobar(hechos, specs, {canonica})` | veredicto completo: `{reproducible, procedencias, hallazgos, recrear, reetiquetar}` |
| `comprobarServicio(hecho, spec)` | los hallazgos de UN servicio; sirve para mirar sólo `backup` |
| `comprobarProcedencia(hechos, {canonica})` | únicamente la fuente de verdad, sin spec |
| `specDesdeCompose(doc, {vars, profiles, incluir})` | spec renderizada; `incluir` es lo que mete a `backup` por nombre |
| `CODIGOS` | los códigos de hallazgo, para filtrar por tipo |
| `puertoDesdeCompose`, `healthcheckDesdeCompose` | traducción Compose → forma del daemon |

Y del carril G (`runtime-drift-scan.mjs`), ya extendido por este carril:
`procedencia(labels)`, `puertosPublicados(c)`, `huella(x)`, `ipLogica(ip)`.

Para el carril de `backup` en concreto: `backup` sale hoy en `recrear` con tres
hallazgos (`IMAGEN_DIVERGENTE`, `ENV_FALTA` de `RESTIC_HOSTNAME`,
`HEALTHCHECK_DIVERGENTE`). Cuando su alineación esté hecha, esos tres tienen que
desaparecer y `backup` debe pasar a `reetiquetar` o salir limpio — eso es un
criterio de aceptación ejecutable, no una impresión.

### Topología

Ni los hechos ni el informe publican rutas de anfitrión ni IPs. `config_files` y
`working_dir` viajan como huella más un booleano («¿vive el compose dentro del
directorio de despliegue?»), que es lo único que hay que comprobar;
`command`/`entrypoint`/`healthcheck` del contenedor viajan hasheados, porque una
línea de arranque puede llevar un hostname o la ruta de un secreto. Cuando hay
que enseñar un literal, se enseña el del compose —que es público—, nunca el del
anfitrión.
