# Actualizaciones y cambios de versión

## Resumen

Procedimiento único para cambiar la versión de los servicios: **construir fuera del host
productivo con identidad de build** (o usar las imágenes de la CI), **verificar el contenido**, y
**desplegar con `--no-build`** servicio a servicio, sin tocar `postgres`. Basado en ADR-016
(identidad de build) y ADR-017 (BUILD y DEPLOY son fases distintas) y en los gates de
`infrastructure/scripts/`.

## Índice

- [Principios](#principios)
- [Estado de partida: imágenes mezcladas](#estado-de-partida-imágenes-mezcladas)
- [Construir fuera del host productivo](#construir-fuera-del-host-productivo)
- [Verificar el contenido de la imagen](#verificar-el-contenido-de-la-imagen)
- [Desplegar](#desplegar)
- [RC2: proxy de Docker, red dedicada y firewall](#rc2-proxy-de-docker-red-dedicada-y-firewall)
- [TD-062: migrar el proxy al artefacto instalado](#td-062)
- [Override de versión por servicio](#override-de-versión-por-servicio)
- [Alinear todas las imágenes con un mismo `BUILD_COMMIT`](#alinear-todas-las-imágenes-con-un-mismo-build_commit)
- [PostgreSQL y Redis](#postgresql-y-redis)
- [Un solo compose canónico](#un-solo-compose-canónico)
- [Migraciones](#migraciones)
- [Vuelta atrás](#vuelta-atrás)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Principios

1. **Nunca `latest`** ni `v0.0.0` (móvil): siempre `sha-<commit>`.
2. **Nunca construir en el host productivo** (`--profile production build` allí sobrescribe las
   etiquetas locales con código distinto del que dicen y deja sin imagen de vuelta atrás).
3. **`up -d --no-build --no-deps <servicios>`**: nada se construye y `depends_on` no arrastra a
   `postgres` ni a `queue`.
4. **Copia previa**: `backup.sh` manual correcto antes de cualquier cambio ([backup.md](backup.md#copia-manual)).
5. Contar la CI por **todas** sus conclusiones; `skipped`/`neutral` no son verde
   ([../development/ci.md](../development/ci.md)).

## Estado de partida: imágenes mezcladas

La instalación de referencia corre hoy tres orígenes: 9 servicios de un build local sin identidad
(`4d469dc`), `tournament-worker` con override (`0daa500`) y `backup` (`ad0a42b`), y 7 contenedores
lanzados desde un directorio de build fuera del clon ([TD-006](../roadmap/technical-debt.md#td-006),
[TD-027](../roadmap/technical-debt.md#td-027)). Cualquier actualización debe empezar por
inventariarlo ([diagnostics.md](diagnostics.md#qué-versión-corre)) y [runtime-drift-scanner.md](runtime-drift-scanner.md).

## Construir fuera del host productivo

Opción A — **usar las imágenes de la CI** (recomendada): cada merge a `main` publica todas las
imágenes con `BUILD_COMMIT=<sha>` y etiqueta `sha-<sha>` ([../development/releases.md](../development/releases.md)).

Opción B — construir en un **host de build** desde un árbol limpio y declarado:

```bash
git clone https://github.com/pjclavero/s9-ai-arena.git /tmp/arbol-<sha>   # nunca un clon local con hardlinks
cd /tmp/arbol-<sha> && git checkout <sha>
export BUILD_COMMIT=$(git rev-parse HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) TAG=sha-$BUILD_COMMIT
ARBOL=/tmp/arbol-<sha>/infrastructure      # directorio del compose del árbol fuente: contra él se resuelve build.context: ..
node infrastructure/scripts/release-gate.mjs --invocacion build --arbol-fuente "$ARBOL" -- \
  docker compose --project-directory "$ARBOL" -f "$ARBOL/docker-compose.yml" --profile production build
```

`release-gate.mjs --invocacion build` rechaza la invocación si `--project-directory` no es
exactamente el árbol declarado con `--arbol-fuente` (el incidente original: se construyó el árbol
de producción y se etiquetó con el commit nuevo). Revisa su salida antes de ejecutar el build. Sin `BUILD_COMMIT` las imágenes salen con `unknown` y el gate ADR-016 las
rechaza.

## Verificar el contenido de la imagen

Antes de desplegar, por cada servicio que cambia:

```bash
node infrastructure/scripts/verify-image-provenance.mjs \
  --image ghcr.io/pjclavero/s9-ai-arena/<servicio>:sha-<sha> --commit <sha> --service <servicio> [--port <puerto>]
```

Comprueba que coinciden etiqueta, `org.opencontainers.image.revision` y `/version` del contenedor
arrancado en aislado. Para `postgres`/`queue` no aplica (imágenes oficiales por digest).

## Desplegar

En el host productivo, como usuario de despliegue, desde el clon productivo:

1. Preflight: [shutdown.md](shutdown.md#1-preflight) (sin trabajo en vuelo) y copia manual.
2. Cambiar en `infrastructure/.env` la etiqueta (`TAG`, o `<SERVICIO>_TAG` si es un override).
3. Comprobar qué va a cambiar **antes** de tocar nada:

   ```bash
   DC="docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env --profile production"
   $DC config --hash '*'          # compara con: docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' <contenedor>
   $DC pull <servicios>
   ```

   Sólo deben diferir los servicios que se quieren cambiar; si aparece `postgres`, **STOP**.
4. Desplegar sólo esos servicios:

   ```bash
   $DC up -d --no-build --no-deps <servicio> [<servicio>…]
   ```

5. Verificar: health ([diagnostics.md](diagnostics.md#salud-por-servicio)), image ID en ejecución
   (`node infrastructure/scripts/check-running-image-id.mjs`), `/version` del servicio y deriva
   ([runtime-drift-scanner.md](runtime-drift-scanner.md)).
6. Registrar fecha, servicios, etiquetas anterior y nueva, y resultado.

`release-gate.mjs --invocacion deploy -- <la invocación>` comprueba la invocación de despliegue
(`--no-build` presente, directorio de proyecto productivo) antes de ejecutarla, y
`release-gate.mjs --evidencia despliegue.json` valida que el despliegue responde «qué código, qué
imagen, qué spec, qué runtime».

## RC2: proxy de Docker, red dedicada y firewall

Desplegar una versión que incluya RC2 añade pasos en el **host**, además de recrear servicios. Van
en este orden, con la ejecución real todavía apagada (`DOCKER_PROXY_URL` vacío en
`tournament-worker` y `arena-engine`):

1. **Runtimes de los bots por digest** (el proxy no permite `pull`):
   `bash scripts/ops/pull-runtime-images.sh` y después `--check-only`, que debe dar
   `RUNTIME_IMAGES_READY=YES` ([installation.md](installation.md#imágenes-de-runtime-de-los-bots)).
2. **Red `bot-control`:** la crea Compose al recrear `bot-build-worker`, `tournament-worker` y
   `arena-engine` (bridge `s9-botctl0`, `10.89.250.0/24`; [networking.md](networking.md#red-de-control-del-docker-proxy-bot-control)).
3. **Firewall:** `sudo bash infrastructure/firewall/s9-firewall.sh install` y `check` (rc 0). Se
   inserta en caliente; nunca recargar ni hacer flush de nftables ([firewall.md](firewall.md)).
4. **Proxy:** `/etc/s9-ai-arena/docker-proxy.env` con `DOCKER_PROXY_BIND=10.89.250.1` y
   `DOCKER_PROXY_ALLOWED_CLIENTS=10.89.250.0/24`; `install-docker-proxy.sh check-env`, `install` y
   `validate` ([docker-proxy.md](docker-proxy.md#instalación)). Con el entorno de RC1 (bind en
   `docker0`) `install` aborta sin cambiar nada.
5. **Verificación:** `node scripts/ops/network-probe.mjs --project <proyecto> --expect-members
   arena-engine,bot-build-worker,tournament-worker --expect-default-route-blocked` (rc 0).

Encender la ejecución real (fijar `DOCKER_PROXY_URL` en `tournament-worker`) sigue siendo un gate
aparte del operador.

<a id="td-062"></a>
## TD-062: migrar el proxy al artefacto instalado

**Por qué:** la unidad que hay hoy en el host (RC1/RC2) ejecuta `npx tsx` desde el árbol de
despliegue, con `WorkingDirectory` en él, y lee la allowlist de `runtimes/DIGESTS.lock`. El usuario
de despliegue puede escribir ese árbol, y el proxy tiene el grupo `docker`: el usuario de despliegue
puede llegar a root ([TD-062](../roadmap/technical-debt.md#td-062)). Tras la migración, el proxy
ejecuta un bundle de root fuera del árbol ([docker-proxy.md](docker-proxy.md#frontera-de-privilegio-td-062)).

**Precondiciones:** commit con TD-062 desplegado en el árbol. La red `bot-control` existe (si no,
el `ExecStartPre` espera y la unidad no arranca). Ventana del operador: el proxy se reinicia una
vez, durante unos segundos.

1. **Comprobar el estado de partida (sólo lectura).** `preflight` debe salir **ROJO** con la unidad
   antigua. Es la prueba de que mide lo que dice:

   ```bash
   sudo bash infrastructure/scripts/install-docker-proxy.sh preflight; echo rc=$?   # esperado rc=1
   ```

2. **Construir el bundle sin root** y anotar su sha256. Compáralo con el que imprime la CI del
   mismo commit (`proxy-bundle.json` en la evidencia de `container-proxy-e2e`):

   ```bash
   npm run build:docker-proxy      # como usuario de despliegue, en el árbol
   ```

3. **Ajustar el entorno.** Es el único cambio a mano: en `/etc/s9-ai-arena/docker-proxy.env`, poner
   `DOCKER_PROXY_IMAGE_ALLOWLIST=/etc/s9-docker-proxy/DIGESTS.lock`. Con el valor antiguo, `install`
   aborta sin tocar la unidad. Retirar también cualquier `NODE_*`/`LD_*`.
4. **Instalar:**

   ```bash
   sudo S9PX_EXPECT_SHA256=<sha256 del paso 2> bash infrastructure/scripts/install-docker-proxy.sh install
   ```

   Copia el bundle y la allowlist con root:root, instala la unidad nueva y pasa `preflight --static`.
   Si sale ROJO, **no reinicia**. Si sale bien, reinicia el proxy y pasa el `preflight` completo.
5. **Verificar:**

   ```bash
   sudo bash infrastructure/scripts/install-docker-proxy.sh validate   # preflight VERDE + escucha + firewall
   ```

   Comprueba también que la línea de arranque del journal dice `"artifact":{"kind":"bundle",…}` y que
   `imageAllowlist.path` es `/etc/s9-docker-proxy/DIGESTS.lock`.
6. **Después, y sólo después,** se puede aplicar el chown del árbol de
   [TD-057](../roadmap/technical-debt.md#td-057). Repite `preflight`: debe seguir VERDE.

**Actualizar la allowlist o el código del proxy** en versiones posteriores: repite los pasos 2, 4 y 5.
Un cambio en `runtimes/DIGESTS.lock` **no** llega al proxy hasta que se reinstala, y `preflight`
avisa si la copia de root y la del árbol difieren.

**Vuelta atrás:** reinstala la versión anterior del repo con su `install`. No hay vuelta a la unidad
de RC1: reabre TD-062.

## Override de versión por servicio

`<SERVICIO>_TAG` en `infrastructure/.env` ancla un servicio a otra etiqueta sin mover los demás
(patrón `${<SERVICIO>_TAG:-${TAG}}`). Reglas:

- Sólo es reproducible si vive en `.env`: pasado en la línea de comandos desaparece y el siguiente
  `up` global revierte el servicio a `TAG` sin avisar.
- `bot-manager` y `bot-build-worker` comparten `BOT_MANAGER_TAG` (son la misma imagen).
- Los overrides activos deben estar declarados en `infrastructure/deploy-contract.json`
  (`overrides_de_version.activos`). El gate genera el comando exacto y comprueba que sólo cambia
  la imagen declarada:

  ```bash
  node infrastructure/scripts/tag-override-gate.mjs --gate         # rc=0 sólo si cambia 1 imagen y nada más
  node infrastructure/scripts/tag-override-gate.mjs --invocacion   # imprime el `up -d --no-build --no-deps …`
  ```

  El contrato renderiza las aplicaciones con el perfil `development` (los mismos 11 servicios que
  `production` **sin** `backup`, que se gestiona aparte); el comando generado es equivalente a
  usar `--profile production` con la lista explícita de servicios.

## Alinear todas las imágenes con un mismo `BUILD_COMMIT`

Objetivo pendiente para salir del estado mezclado ([TD-006](../roadmap/technical-debt.md#td-006)):

1. Elegir un commit de `main` con CI completa (todas las conclusiones `success`).
2. Comprobar que las 11 imágenes `sha-<commit>` existen y pasan `verify-image-provenance.mjs`.
3. En `.env`: `TAG=sha-<commit>`, **quitar** los `<SERVICIO>_TAG` (o declararlos), `BACKUP_TAG=sha-<commit>`
   en su propia ventana.
4. Desplegar los servicios de aplicación por grupos (`web gateway`, `api`, `replay-service map-service`,
   `bot-manager bot-build-worker`, `arena-engine`, `tournament-worker`) con `--no-deps`, verificando
   cada grupo.
5. `backup` al final, en ventana propia, tras una copia correcta con la versión anterior.
6. `postgres` y `queue` **no** cambian.

## PostgreSQL y Redis

- `postgres` está fijado por digest (`postgres:16.14-alpine@sha256:57c7…`). **No se recrea** en una
  actualización: sólo con autorización explícita, ventana de mantenimiento y copia verificada
  previa. Un cambio de versión mayor de PostgreSQL exige `pg_dump`/`pg_restore`
  ([restore.md](restore.md)), no un cambio de imagen.
- `queue` (Redis) es efímero: la autoridad del trabajo es PostgreSQL. Se recrea vacío en su propia
  ventana si hace falta.

> **DANGER** — recrear `postgres`
>
> **PRECONDITION:** autorización del operador, ventana, preflight `rc=0`, copia verificada del día.
>
> **EFFECT:** reinicia la base de datos; corta todas las conexiones; si la spec cambió, recrea el
> contenedor (los datos siguen en `infrastructure_postgres_data`).
>
> **ROLLBACK:** volver a la spec anterior y `up -d --no-build --no-deps postgres`; si los datos se
> dañaron, [restore.md](restore.md).

## Un solo compose canónico

Todos los contenedores del proyecto deben declarar el mismo `com.docker.compose.project.config_files`
(ver `docker compose ls`). Si hay dos orígenes, el siguiente despliegue debe hacerse desde el clon
productivo para **todos** los servicios afectados, con el procedimiento anterior, y retirar el
árbol de build ajeno ([TD-027](../roadmap/technical-debt.md#td-027)).

## Migraciones

La API no migra al arrancar. Tras desplegar una versión con migraciones nuevas:

```bash
$DC exec -w /app api npx tsx apps/api/src/db/cli.ts migrate
```

Hazlo con copia previa. `rollback:1` revierte exactamente una migración; `rollback:all` destruye el
esquema ([first-run.md](first-run.md#comandos-prohibidos-en-producción)).

## Vuelta atrás

- **Servicio de aplicación:** volver a la etiqueta anterior en `.env` y repetir el despliegue de ese
  servicio. Por eso nunca se sobrescriben etiquetas en el host.
- **Datos:** sólo restauración desde restic ([restore.md](restore.md)). **No hay snapshots de VM**
  en la instalación de referencia: cualquier `qm rollback` de documentos anteriores apunta a
  snapshots que ya no existen ([TD-007](../roadmap/technical-debt.md#td-007)).

## Errores / limitaciones

| Síntoma | Causa | Remedio |
|---|---|---|
| `config --hash` cambia en servicios que no tocaste | `.env` o compose distintos de los del despliegue anterior | revisar el diff antes de seguir |
| Tras un `up` global un servicio vuelve a otra versión | override pasado por línea de comandos | ponerlo en `.env` y declararlo |
| `verify-image-provenance` dice `unknown` | imagen construida sin `BUILD_COMMIT` | reconstruir con identidad o usar la de la CI |
| `deploy-staging` de la CI en verde | no despliega (el `ssh` está comentado) | no es evidencia de nada ([../development/ci.md](../development/ci.md)) |

## Documentación relacionada

[docker.md](docker.md) · [diagnostics.md](diagnostics.md) · [runtime-drift-scanner.md](runtime-drift-scanner.md) ·
[shutdown.md](shutdown.md) · [../development/releases.md](../development/releases.md) ·
[ADR-016](../adr/ADR-016-identidad-de-build.md) · [ADR-017](../adr/ADR-017-contrato-de-release.md) ·
Históricos: [../history/operaciones/OVERRIDE_VERSION_POR_SERVICIO.md](../history/operaciones/OVERRIDE_VERSION_POR_SERVICIO.md),
[../history/operaciones/COMPOSE_CANONICO.md](../history/operaciones/COMPOSE_CANONICO.md),
[../history/operaciones/CONTRATO_DESPLIEGUE.md](../history/operaciones/CONTRATO_DESPLIEGUE.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Patrón `${<SERVICIO>_TAG:-${TAG}}`; `BACKUP_TAG` aparte | CODE_VERIFIED | `image:` de cada servicio en el compose |
| `BOT_MANAGER_TAG` compartido; contrato con perfil `development` y backup aparte | CODE_VERIFIED | `infrastructure/deploy-contract.json` (`overrides_de_version`, `perfiles`, `gestionados_aparte`) |
| `tag-override-gate.mjs --gate/--invocacion` y comando `up -d --no-build --no-deps` | CODE_VERIFIED | `infrastructure/scripts/tag-override-gate.mjs:75-98,527-546` |
| `release-gate.mjs --invocacion build/deploy`, `--evidencia`; BUILD exige `--project-directory` = `--arbol-fuente` | CODE_VERIFIED | ADR-017 §2, §6; `infrastructure/scripts/release-gate.mjs:39-110,619-622` |
| Ejemplo de build de la opción B ejecutado | DESIGN_ONLY | no ejecutado en esta consolidación; la opción A (imágenes de la CI) sí está verificada |
| `verify-image-provenance.mjs` opciones | CODE_VERIFIED | cabecera del script (líneas 19-22, 160) |
| postgres/queue por digest | CODE_VERIFIED | compose |
| Estado mezclado 4d469dc / 0daa500 / ad0a42b y dos orígenes de config | RUNTIME_VERIFIED (auditoría 2026-10-15, sólo lectura) | `docker inspect`, `docker compose ls` |
| La CI publica `sha-<commit>` para los 11 repos de imagen | RUNTIME_VERIFIED | GHCR anónimo, `sha-27f70bb…` → 200 en todos |
| Sin snapshots de VM | RUNTIME_VERIFIED | verificación de la consolidación, 2026-10-15 (listado de snapshots del hipervisor) |
