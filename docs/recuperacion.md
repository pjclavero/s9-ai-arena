# Runbook de recuperación total — S9 AI Arena

Objetivo (DoD T10.4): desde una **VM vacía + el último backup** hasta la
plataforma funcional con datos en **menos de 2 horas**, con verificación de
integridad. Estrategia de copias: ADR-010 D10.4 (pg_dump + restic, cron diario
del servicio `backup` del stack, alerta si falla o si no hay backup en 26 h).

> **Estado del simulacro:** PENDIENTE de entorno con Docker (el entorno de
> desarrollo actual no tiene acceso al daemon). Este runbook está listo para
> ejecutarse; al hacerlo, registrar los tiempos en la tabla del final y
> archivar el resultado en este documento.
>
> **Auditoría y runbook detallado (no ejecutado):**
> [`docs/ops/restore-drill-runbook.md`](ops/restore-drill-runbook.md) audita
> `backup.sh`/`restore.sh` línea a línea, añade salvaguardas explícitas para
> restaurar SOLO a un destino temporal aislado (nunca producción), pasos de
> verificación de integridad más profundos (recuento de filas, migraciones,
> trigger append-only de `audit_log`, consulta de negocio) y cronometraje de
> RPO/RTO. Documenta también un defecto real encontrado: el manifest de
> integridad de `backup.sh` usa rutas relativas incompatibles con la
> estructura de rutas absolutas que deja `restic restore --target`, por lo
> que `restore.sh --verify` falla el 100 % de las entradas contra un restore
> real sin un paso previo de reestructuración (ver §0 y §3.6 de ese
> documento). Sigue sin ejecutarse: la tabla de abajo permanece vacía.

## Requisitos previos

- Acceso al repositorio restic (`RESTIC_REPOSITORY`, NAS/ZFS del operador) y a
  su contraseña (`restic_password`, custodiada FUERA del servidor: gestor de
  contraseñas del operador; sin ella no hay recuperación posible).
- **Si el destino es SFTP (fix/backup-sftp-scheduled-runtime,
  fix/restore-sftp-bootstrap):** además hace falta, TAMBIÉN custodiado fuera
  del servidor, el material para alcanzar el host de respaldo por SSH: la
  clave privada `restic_ssh_key` y el `restic_ssh_known_hosts` con la huella
  ya verificada del host. Es el mismo problema del huevo y la gallina que
  `restic_password`: ambos viajan DENTRO del snapshot de secretos
  (`s9-arena-secrets`) por comodidad del día a día, pero ese snapshot vive
  precisamente en el repositorio SFTP al que sólo se llega usando esa misma
  clave — sin una copia fuera del servidor, Fase 2 no puede arrancar. Ver
  `infrastructure/.env.example` para el formato de `RESTIC_REPOSITORY` con
  un host de respaldo confinado (`ChrootDirectory`).
  - `restore.sh` (desde fix/restore-sftp-bootstrap) prepara ~/.ssh por sí
    mismo a partir de `RESTIC_SSH_KEY_FILE`/`RESTIC_SSH_KNOWN_HOSTS_FILE` —
    ya NO hace falta colocar la clave a mano en un contenedor de
    recuperación nuevo (antes de esta rama, `restore.sh` no sabía nada del
    backend sftp y "funcionaba" sólo por rebote, en el MISMO contenedor
    donde ya había corrido `backup.sh`; un contenedor de recuperación
    recién creado fallaba con "Host key verification failed"). Sigue
    haciendo falta que esos dos ficheros existan y sean legibles ANTES de
    invocar `restore.sh` — eso es exactamente lo que dice el riesgo de
    custodia justo abajo.
- Imágenes versionadas en `ghcr.io/pjclavero/s9-ai-arena/*` (las publica la CI
  en cada merge a main, etiquetadas `v<versión>` y `sha-<commit>`).

## Puesta en marcha del repositorio (una sola vez, ANTES del primer backup)

Un repositorio restic no existe hasta que se crea. Mientras no exista, cada
ejecución de `backup.sh` termina en `FULL FAILURE` con este mensaje, que es
el síntoma exacto de que falta este paso y no otra cosa:

```
Fatal: unable to open config file: Lstat: file does not exist
Is there a repository at the following location?
```

Creación, desde el propio contenedor de backup (mismo binario, misma clave y
misma ruta que usará el backup programado):

```bash
docker compose -f infrastructure/docker-compose.yml exec backup \
  /usr/local/bin/backup.sh --init-repo
```

Es **idempotente**: si el repositorio ya existe lo dice y no toca nada.

Este paso es explícito a propósito, y `backup.sh` NO lo hace por su cuenta
durante un backup. Si `restic backup` inicializase el repositorio al no
encontrarlo, una errata en `RESTIC_REPOSITORY` crearía en silencio un
repositorio nuevo y vacío: el backup reportaría éxito, la alerta
`BackupTooOld` se apagaría y el histórico real quedaría huérfano en la ruta
correcta. Ese fallo es peor que no tener backup, porque además oculta que no
lo hay.

## Procedimiento

Cronometrar cada fase (`date` antes y después).

> **fix/restore-snapshot-selection — usa siempre `--snapshot <id>`, nunca la
> ausencia de argumento, para una recuperación de desastre real.** En el
> simulacro del 2026-08-18 se decidió restaurar el snapshot `76a13494`;
> pasaron dos días hasta ejecutar la recuperación, el cron nocturno subió
> snapshots nuevos, y `restore.sh` (que entonces sólo sabía pedir `latest`)
> restauró `4fac59f8` — un snapshot DISTINTO al decidido, sin que nada lo
> avisara salvo revisar el ID a mano después. `--restore`/`--restore-secrets`
> ahora aceptan `--snapshot <id>` para fijar exactamente el snapshot
> conocido-bueno que se decidió restaurar, y siguen aceptando `--latest`
> (o ningún selector, que se comporta igual, por compatibilidad con scripts
> existentes) para el caso de "el más reciente sirve". En una recuperación
> real:
>   1. `bash infrastructure/backup/restore.sh --list` — anota el ID EXACTO
>      del snapshot que decides restaurar, en el momento en que lo decides.
>   2. Usa `--snapshot <ese-id>` en `--restore`/`--restore-secrets`, no
>      `--latest` ni la ausencia de selector — entre la decisión y la
>      ejecución puede pasar tiempo suficiente para que el cron nocturno
>      cambie cuál es el "más reciente", exactamente como pasó en el
>      simulacro. `--latest` sólo es aceptable cuando la decisión y la
>      ejecución son el mismo instante (p.ej. un smoke test rutinario, no
>      una recuperación de desastre).
>   3. El ID resuelto queda siempre en el log JSON de `restore.sh`
>      (`"snapshot solicitado"` antes de tocar el repositorio,
>      `"snapshot resuelto"` justo después) — archívalo junto con el resto
>      de la evidencia del simulacro/incidente.
> Un `--snapshot` con un ID que no existe, o que existe pero pertenece al
> otro tag (p.ej. pedir un snapshot de secretos para `--restore`), falla
> cerrado con un mensaje claro y no restaura nada — nunca cae en silencio a
> `latest`.

### Fase 1 · VM limpia (≈15 min)

```bash
# Debian/Ubuntu con Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sh
git clone https://github.com/pjclavero/s9-ai-arena.git && cd s9-ai-arena
```

### Fase 2 · Restaurar secretos (≈10 min)

```bash
export RESTIC_REPOSITORY=<repositorio>   # y RESTIC_PASSWORD por el operador
# Si RESTIC_REPOSITORY es sftp:..., restore.sh prepara ~/.ssh POR SU CUENTA
# (fix/restore-sftp-bootstrap, mismo bootstrap que usa backup.sh) a partir
# de estas dos variables — deben apuntar a ficheros ya presentes y legibles
# ANTES de este comando (custodiados fuera del servidor, ver Requisitos
# previos): restic no puede alcanzar el repositorio sin ellos, así que no
# hay forma de "restaurarlos desde el propio backup" en este primer paso.
export RESTIC_SSH_KEY_FILE=<ruta a la clave privada custodiada>
export RESTIC_SSH_KNOWN_HOSTS_FILE=<ruta al known_hosts con la huella verificada>
bash infrastructure/backup/restore.sh --list
# ID EXACTO decidido al revisar el --list de arriba (nunca --latest en una
# recuperación real: ver el aviso al principio de "## Procedimiento").
bash infrastructure/backup/restore.sh --restore-secrets /tmp/restore-secrets \
  --snapshot <id-de-secrets-decidido-con---list>
# Colocarlos (rutas con permisos 0600; NUNCA volcarlos a pantalla/logs):
mkdir -p infrastructure/secrets
cp -a /tmp/restore-secrets/secrets/. infrastructure/secrets/
rm -rf /tmp/restore-secrets
cp infrastructure/.env.example infrastructure/.env   # reponer configuración
```

### Fase 3 · Restaurar datos (≈20–40 min según volumen)

```bash
bash infrastructure/backup/restore.sh --list
# ID EXACTO del snapshot de DATOS decidido en el paso anterior — no
# --latest: es el mismo motivo que en Fase 2, y el mismo defecto real
# que el simulacro del 2026-08-18 reprodujo.
bash infrastructure/backup/restore.sh --restore /tmp/restore-data \
  --snapshot <id-de-datos-decidido-con---list>
```

> **#110b:** `backup.sh` sube UN ÚNICO directorio de "staging" a restic (tag
> `s9-arena-data`) con la jerarquía `maps/`, `bot_sources/`, `assets/`,
> `replays/`, el dump de PostgreSQL y los dos manifests, todo junto y en las
> mismas rutas relativas que describe `manifest.sha256` — así el manifest y
> los datos que verifica quedan SIEMPRE en el mismo árbol (antes no era así:
> el manifest usaba rutas relativas y los datos se restauraban con su ruta
> absoluta de origen, y `restore.sh --verify` no encontraba nada). `restic
> restore` conserva la ruta absoluta original del staging dentro de
> `--target`, así que localízalo así antes de seguir:
> ```bash
> STAGE="$(dirname "$(find /tmp/restore-data -name manifest.sha256)")"
> echo "STAGE=$STAGE"   # debe apuntar a .../staging
> ```

### Fase 4 · Recrear contenedores desde imágenes versionadas (≈10 min)

```bash
# TAG=v<versión> del último despliegue conocido (no build local: imágenes de la CI)
sed -i 's/^TAG=.*/TAG=v0.0.0/' infrastructure/.env
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production pull
# Levantar SOLO la base de datos primero:
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d postgres
```

### Fase 5 · Restaurar la base de datos (≈10–20 min)

```bash
# El dump vive directamente en la raíz del staging (ver Fase 3).
DUMP=$(find "$STAGE" -maxdepth 1 -name 'pgdump-*.dump' | sort | tail -1)
docker compose -f infrastructure/docker-compose.yml cp "$DUMP" postgres:/tmp/restore.dump
docker compose -f infrastructure/docker-compose.yml exec postgres \
  sh -c 'pg_restore -c --if-exists -U arena -d arena /tmp/restore.dump && rm /tmp/restore.dump'
```

### Fase 6 · Restaurar volúmenes (≈10 min)

```bash
# #110b: nombres de staging (guion bajo, como en manifest.json/métricas) →
# volúmenes reales del compose (arena_<nombre>). "assets" se incluye porque
# backup.sh lo captura desde #110b — antes de este cambio se perdía en la
# restauración aunque SÍ estuviera en el backup. Si una fuente estaba
# `empty` o `error` en el backup, su carpeta no existe en el staging: se
# salta sin copiar nada. El directorio especial que antes limitaba los
# replays copiados a un único subárbol ya no existe como tal: el alcance de
# replays se amplió a todo el volumen (ver Fase 3).
declare -A VOLUME_FOR=( [maps]=arena_maps [bot_sources]=arena_bot_sources [replays]=arena_replays [assets]=arena_assets )
for name in maps bot_sources replays assets; do
  src="$STAGE/$name"
  [ -d "$src" ] || { echo "skip $name (vacío o en error en este backup)"; continue; }
  docker run --rm -v "s9-ai-arena_${VOLUME_FOR[$name]}:/dst" -v "$src:/src:ro" alpine \
    sh -c 'cp -a /src/. /dst/'
done
```

### Fase 7 · Arrancar todo y verificar (≈15 min)

```bash
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d
docker compose -f infrastructure/docker-compose.yml ps          # todo healthy

# Integridad (criterio del cap. 28): checksums de postgres (pg_dump), mapas,
# bot-sources, assets y replays (manifest.sha256 vive junto a los datos en
# $STAGE, por eso `--verify` puede apuntar a todo /tmp/restore-data: localiza
# el único manifest.sha256 igual que en Fase 3 y falla si hay cero o más de
# uno). D3 (#112) CERRADO: el dump de PostgreSQL (pgdump-*.dump) SÍ está
# incluido en manifest.sha256 desde este cambio — ya no es el único activo
# del backup sin checksum verificado por --verify; su corrupción se detecta
# igual que la de cualquier otra fuente.
# NOTA OPERATIVA (snapshots antiguos): esto sólo aplica a backups generados
# DESPUÉS de este cambio. manifest.json lleva un marcador de contrato
# ("schema") que restore.sh usa para distinguirlos automáticamente — no
# hace falta que el operador haga nada distinto al restaurar uno u otro.
# Un snapshot tomado ANTES de este cambio (sin "schema", o con datos, o con
# las cuatro fuentes no críticas vacías) seguirá teniendo el dump fuera del
# manifest: su restore.sh --verify verificará mapas/bot-sources/assets/
# replays pero NO el dump, y lo dirá explícitamente ("snapshot legacy
# anterior a D3: el dump de PostgreSQL NO tiene checksum en este
# manifest"); la integridad del dump en ese caso depende de que pg_dump/
# restic no fallaran en silencio en su momento, no de un hash. Un snapshot
# NUEVO (con "schema") exige siempre la entrada del dump — si falta o el
# manifest aparece vacío, --verify falla en vez de darlo por bueno.
bash infrastructure/backup/restore.sh --verify /tmp/restore-data

# Migraciones al día (contrato con E7: el api las reporta en /healthz)
curl -s http://localhost:${HTTP_PORT:-80}/api/healthz

# Humo E2E
bash infrastructure/scripts/smoke.sh https://<S9_DOMAIN>

rm -rf /tmp/restore-data   # limpiar restos en claro
```

## Verificaciones finales

| Verificación | Cómo | Criterio |
|---|---|---|
| Healthchecks | `docker compose ps` | todos `healthy` |
| Integridad de mapas/bot-sources/assets/replays | `restore.sh --verify` (sha256, probado en `infrastructure/tests/backup.test.ts` con un snapshot generado por `backup.sh` real, no montado a mano) | 0 discrepancias |
| Migraciones | `/api/healthz` | al día |
| Humo E2E | `smoke.sh` | 4/4 OK |
| Secretos | revisar salida de consola y `docker compose logs` | ningún valor de secreto impreso |

## Registro del simulacro (rellenar al ejecutarlo)

| Fecha | Fase 1 | F2 | F3 | F4 | F5 | F6 | F7 | TOTAL | ¿< 2 h? |
|---|---|---|---|---|---|---|---|---|---|
| _pendiente de entorno con Docker_ | | | | | | | | | |

## Custodia del paquete break-glass y de su frase de paso

El paquete *break-glass* es un único fichero cifrado
(`s9-ai-arena-break-glass.tar.gz.gpg`, GPG simétrico AES256, 0600 root:root)
que contiene todo lo que hace falta para arrancar la Fase 2 desde cero:
contraseña del repositorio restic, clave SSH del backend sftp, `known_hosts`
con la huella ya verificada, el procedimiento impreso y un binario estático de
restic. Su frase de paso NO está en ninguna máquina: la custodia el operador.

Ese diseño cierra el problema del huevo y la gallina de "Requisitos previos".
Lo que NO cierra por sí solo es **dónde vive el paquete**, y ahí hay una
condición que debe cumplirse siempre:

> Perder la máquina de producción **y** el host de respaldo no puede equivaler
> a perder el acceso al backup. Si la única copia del paquete vive en el host
> de respaldo, comparte dominio de fallo con el repositorio restic: el mismo
> incendio, el mismo robo, el mismo fallo de la fuente de alimentación o el
> mismo `zfs destroy` se llevan las dos cosas a la vez, y el backup pasa a ser
> irrecuperable aunque los datos siguieran existiendo en otro sitio.

### Regla de las tres copias

1. **Copia operativa** — en el host de respaldo, junto a
   `verify-break-glass.sh`. Es la que se usa en un simulacro rutinario.
2. **Copia fría fuera de línea** — en un soporte que NO esté conectado a
   ninguna de las dos máquinas ni a la red: una llave USB (idealmente dos, de
   fabricantes distintos) guardada físicamente lejos, en un sobre firmado y
   fechado.
3. **Copia remota** — fuera del edificio: otra ubicación física del operador,
   o almacenamiento de un tercero. Como el paquete ya va cifrado con GPG
   simétrico y la frase de paso no viaja con él, un almacenamiento no
   confiable es aceptable para el blob; lo que nunca puede acompañarlo es la
   frase de paso.

Opciones concretas para un homelab, con su compromiso:

| Opción | Dominio de fallo | Compromiso |
|---|---|---|
| USB cifrada en otro edificio | Independiente | Hay que refrescarla a mano; la memoria flash se degrada sin alimentar (revisar al menos una vez al año) |
| Copia en un equipo de escritorio del operador | Independiente del rack, no del domicilio | Cómoda y verificable a menudo; no protege contra un siniestro del domicilio |
| Almacenamiento de un tercero (nube, cuenta ajena al proyecto) | Totalmente independiente | El blob es opaco (GPG), pero el proveedor sabe que existe; jamás subir la frase de paso al mismo sitio |
| Copia impresa en papel del blob | Independiente | Descartada: 9 MB no son transcribibles. **Sí** tiene sentido imprimir el procedimiento y la huella SHA-256 del blob |

### Procedimiento (lo ejecuta el OPERADOR, en persona, en un TTY)

Ningún agente ejecuta estos pasos: mueven material de recuperación y exigen la
frase de paso, que sólo el operador conoce.

1. En el host de respaldo, anotar la huella del blob actual:
   `sha256sum <backup-path>/recovery-secrets/s9-ai-arena/s9-ai-arena-break-glass.tar.gz.gpg`
2. Copiar el blob al soporte externo **por un canal que no lo deje en un
   tercer sitio**: montar la USB en el host de respaldo y `cp` directo, o
   `scp` a un equipo del operador. Nunca a un directorio compartido ni a un
   correo.
3. `chmod 600` en el destino y volver a calcular la huella. Debe coincidir con
   la del paso 1, carácter a carácter. Si no coincide, la copia no vale.
4. Guardar junto a la copia — **en papel**, no en el mismo soporte — la fecha,
   la huella SHA-256 y una línea que diga dónde está la frase de paso (no la
   frase).
5. Repetir para la tercera copia, en otra ubicación.
6. Registrar la fecha en el "Registro del simulacro" de este documento.

### Verificación (obligatoria, y en el sitio correcto)

Una copia no verificada no cuenta. Al menos una vez por trimestre, y siempre
tras regenerar el paquete, el operador ejecuta `verify-break-glass.sh` **desde
la copia externa, en una máquina que no sea ni producción ni el host de
respaldo**. Ese script descifra el paquete en un temporal, contrasta los
SHA-256 de su contenido y muestra la huella de la clave SSH recuperada; no
restaura datos, no toca el repositorio, no toca sshd. Una verificación hecha
sólo sobre la copia operativa demuestra que la copia operativa está bien, que
es justamente la que se supone que se ha perdido en el escenario que importa.

### Custodia de la frase de paso

La frase de paso es el único elemento que **no** debe estar en ninguna de las
tres copias, ni en producción, ni en el host de respaldo, ni en este
repositorio, ni en una transcripción de un agente. Opciones, con su
compromiso:

| Opción | Compromiso |
|---|---|
| Gestor de contraseñas del operador con copia de seguridad propia | Lo más práctico; su propia contraseña maestra pasa a ser el único punto de fallo, así que necesita a su vez una vía de recuperación |
| Papel sellado en dos ubicaciones físicas distintas | Inmune a fallos digitales; hay que protegerlo del extravío y de la lectura casual |
| Reparto Shamir (p. ej. 2 de 3 fragmentos) entre personas o ubicaciones | Ninguna copia suelta sirve por sí sola; añade el riesgo de no poder reunir el quórum en una urgencia — sólo tiene sentido con más de una persona de confianza |
| Derivarla de un secreto que el operador ya memoriza | Descartada: si se olvida, no hay reserva; y si se apunta, es la opción de papel con peor disciplina |

Recomendación para este homelab: gestor de contraseñas **y** una copia en
papel sellada en una ubicación distinta de las tres copias del blob. Una sola
vía de custodia convierte un olvido en una pérdida total.

## Riesgos conocidos

- La contraseña de restic es el único secreto no recuperable desde el propio
  backup: debe custodiarse fuera del servidor (doble custodia recomendada).
  El paquete break-glass resuelve el arranque en frío, pero sólo si existe una
  copia FUERA del dominio de fallo del repositorio — ver "Custodia del paquete
  break-glass y de su frase de paso" más arriba. Una única copia guardada en
  el host de respaldo NO cumple esa condición: se pierde con el mismo suceso
  que se lleva el repositorio.
- **`--latest` con varios hosts en el repositorio (fix/restic-json-nested-parser):**
  `restic snapshots --latest 1` devuelve el más reciente **de cada grupo
  (host,paths)**, no uno solo. Un repositorio con hostnames históricos —el del
  primer backup manual y los IDs de contenedor anteriores a
  fix/restic-stable-hostname— hace que `--latest` sea ambiguo, y `restore.sh`
  falla en cerrado listando los candidatos. Desde este cambio, `restore.sh`
  acota con `--host $RESTIC_HOSTNAME` cuando esa variable está definida (el
  mismo host que `backup.sh` pasa a `backup` y a `forget`), así que en el
  entorno de recuperación hay que definirla igual que en producción. En una
  recuperación real, de todas formas, se elige el snapshot con `--snapshot
  <id>` tras revisar `--list`: `--latest` no es el camino recomendado.
- **Versión de restic (fix/restic-json-nested-parser):** `resolve_snapshot()`
  ya no depende de que los objetos de `restic snapshots --json` sean planos,
  así que `restic` vuelve a instalarse sin versión fijada en
  `infrastructure/docker/backup/Dockerfile`. Lo que sigue siendo un contrato
  OBSERVADO y no garantizado por restic es el agrupamiento de `forget`
  (`--group-by host,tags`): antes de dar por buena una versión nueva en
  producción hay que reconstruir la imagen, pasar `infrastructure/tests` y
  repetir el simulacro de este documento contra el repositorio real.
- **Custodia de la clave SSH del backend sftp (fix/restore-sftp-bootstrap,
  NO resuelto por este cambio — es un problema OPERATIVO, no de código):**
  `restore.sh` recibe `RESTIC_SSH_KEY_FILE`/`RESTIC_SSH_KNOWN_HOSTS_FILE`,
  nunca los genera ni los custodia. Si esa clave viviera ÚNICAMENTE dentro
  de VM108 (o de la máquina que sea, en cada despliegue) — por ejemplo,
  guardada sólo en un fichero local del host o en un volumen que también
  desaparece con él — un desastre que se lleve por delante esa máquina se
  lleva también el ÚNICO medio de alcanzar el backup: "el backup existe" y
  "el backup es alcanzable" dejarían de ser la misma afirmación. Es
  exactamente el mismo problema del huevo y la gallina que ya tiene
  `restic_password` (arriba), aplicado a la clave SSH. Mitigación: la misma
  doble custodia fuera del servidor que ya exige `restic_password` — un
  gestor de secretos del operador, NUNCA sólo el propio servidor que se
  quiere poder recuperar. Pendiente de decisión/verificación explícita del
  operador; no se resuelve con código.
- `arena_build_cache` NO se copia (decisión de retención del dosier 23.1): se
  regenera. Los replays SÍ se copian en su totalidad desde #110b (antes sólo
  se copiaba `official/`, un subdirectorio que en producción no existe, así
  que nunca se había copiado ni un solo replay); quedan sujetos a
  `REPLAY_RETENTION_DAYS`, salvo `official/` que se conserva sin límite.
- El staging temporal de `backup.sh` ($WORK_DIR, por defecto
  `/tmp/backup-work`) puede llegar a pesar como la suma de
  maps+bot_sources+assets+replays retenidos: está en el volumen dedicado
  `backup_work` del compose (ver `infrastructure/docker-compose.yml`) para
  que ese crecimiento no comparta cupo con el resto del contenedor y se
  pueda vigilar con `docker system df -v`.
- Si se usa PostgreSQL externo (perfil `external-db`), la Fase 5 se ejecuta
  contra esa instancia (`pg_restore -h <host externo>`) y la Fase 4 no levanta
  postgres.
