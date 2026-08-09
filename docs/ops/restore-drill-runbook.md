# Runbook ejecutable del simulacro de restauración (T10.4 / ADR-010 D10.4)

> **Estado: NO EJECUTADO.** Este documento se produjo en un entorno de
> desarrollo sin acceso al demonio Docker (ver "Qué falta para ejecutarlo de
> verdad" al final). Es auditoría + procedimiento verificado hasta donde el
> entorno permite (sintaxis de los scripts, coherencia backup↔restore,
> lectura del esquema). **No sustituye a `docs/recuperacion.md`** — es su
> complemento operativo con salvaguardas anti-producción explícitas,
> restauración a destino temporal aislado y verificación de integridad más
> profunda que el manifest de checksums.

## 0. Resumen de la auditoría (con fichero:línea)

- `infrastructure/backup/backup.sh:97-99` — `pg_dump -Fc` (formato custom
  comprimido) del `PGDATABASE` completo.
- `infrastructure/backup/backup.sh:102-105` — `manifest.sha256`: checksums de
  `MAPS_DIR` (con prefijo `maps/`) y de `REPLAYS_DIR/official` (con prefijo
  `official/`), **relativos a esos directorios**, no al propio manifiesto.
- `infrastructure/backup/backup.sh:107-115` — `restic backup` de
  `$MAPS_DIR $BOT_SOURCES_DIR $RECENT_OFFICIAL "$WORK_DIR"/pgdump-*.dump
  "$WORK_DIR/manifest.sha256"` — rutas **absolutas** (`/data/maps`,
  `/data/bot-sources`, `/tmp/backup-work/...`). restic conserva la ruta
  absoluta de origen al restaurar con `--target`.
- `infrastructure/backup/backup.sh:117-118` — secretos (`$SECRETS_DIR`) en un
  snapshot aparte, tag `s9-arena-secrets`.
- `infrastructure/backup/restore.sh:16-21` — plan dry-run coherente con lo
  anterior.
- `infrastructure/backup/restore.sh:26-28` — `--restore <destino>`:
  `restic restore latest --tag s9-arena-data --target <destino>`.
- `infrastructure/backup/restore.sh:37-43` — `--verify <dir>`: busca
  `manifest.sha256` bajo `<dir>`, hace `cd` a su directorio y ejecuta
  `sha256sum -c manifest.sha256` (rutas relativas `maps/…` y `official/…`).
- `docs/recuperacion.md:8` (antes de esta rama) — declaraba el simulacro
  PENDIENTE; su tabla de registro (~113-117) estaba vacía. **Confirmado, sigue
  vacía** — este runbook no la rellena (no se ha ejecutado; ver §6).
- `apps/api/src/db/migrations.ts:429-446` — tabla `audit_log` con trigger
  `audit_log_append_only` (`BEFORE UPDATE OR DELETE` → `RAISE EXCEPTION`):
  invariante de solo-inserción a verificar tras restaurar.
- `apps/api/src/db/migrations.ts:674-707` — `MIGRATIONS` (11 migraciones,
  `migrateToLatest`); la restauración debe quedar al mismo nivel que refleja
  `/api/healthz` en producción, sin re-ejecutar migraciones sobre datos ya
  migrados.
- `infrastructure/docker-compose.yml:493-515` — servicio `postgres` (imagen
  `postgres:16-alpine`, perfiles `nucleo, development, production`, red
  `data` interna, healthcheck `pg_isready`).
- `infrastructure/docker-compose.yml:611-645` — servicio `backup`: monta
  `arena_maps`, `arena_bot_sources`, `arena_replays` **`:ro`**, y
  `./secrets:/secrets:ro`; cron `BACKUP_CRON` (por defecto `15 4 * * *`).

### Hallazgo real: el manifest de integridad NO puede verificarse sobre un `restic restore` real

Este es el defecto más importante del carril, y **rompe la Fase de
verificación de `docs/recuperacion.md` tal y como está escrita hoy**:

- `backup.sh` construye `manifest.sha256` con rutas **relativas a
  `$MAPS_DIR`/`$REPLAYS_DIR`** (`maps/<archivo>`, `official/<archivo>`,
  `backup.sh:104-105`), pensadas para vivir **junto a** carpetas `maps/` y
  `official/` en el mismo directorio.
- Pero lo que `restic backup` respalda (`backup.sh:115`) son las rutas
  **absolutas** `/data/maps`, `/tmp/backup-work/replays-official` (que a su
  vez, por el `cp --parents` de `backup.sh:112-114`, conserva internamente
  `data/replays/official/…`) y `/tmp/backup-work/manifest.sha256`.
- `restic restore --target <destino>` (comportamiento documentado de restic)
  reconstruye **la ruta absoluta original** bajo `<destino>`. Tras
  `restore.sh --restore <destino>` (`restore.sh:26-28`) el resultado real es:
  - `<destino>/data/maps/…` (NO `<destino>/tmp/backup-work/maps/…`)
  - `<destino>/tmp/backup-work/replays-official/data/replays/official/…`
    (NO `<destino>/tmp/backup-work/official/…`)
  - `<destino>/tmp/backup-work/manifest.sha256`
- `restore.sh --verify <dir>` (`restore.sh:37-43`) localiza el manifiesto,
  hace `cd` a su directorio (`<destino>/tmp/backup-work`) y busca ahí mismo
  `maps/…` y `official/…` — que **no existen en esa ruta**. `sha256sum -c`
  falla el 100 % de las entradas con "No such file or directory": el
  verificador reporta corrupción total incluso con un backup perfecto.
- **Por qué el test unitario no lo detectó**:
  `infrastructure/tests/backup.test.ts:82-97` construye el manifiesto y las
  carpetas `maps/`/`official/` **colocadas manualmente** junto al manifest
  (`cwd: restored`, líneas 83-89) — un montaje sintético que nunca reproduce
  el árbol de directorios que realmente deja `restic restore --target`. El
  test es válido para el formato del manifest y `sha256sum -c`, pero no
  ejerce la ruta real backup→restic→restore→verify de punta a punta.
- **Consecuencia operativa**: sin el paso de reestructuración manual que
  añado en §3.4 (mover/enlazar los árboles restaurados para que
  coincidan con lo que el manifest espera), `restore.sh --verify` es
  **inutilizable tal cual** contra un restore real. No lo arreglo en este
  carril (alcance: runbook + auditoría, sin tocar producción/scripts sin
  autorización), pero documento el rodeo necesario y lo dejo como hallazgo
  prioritario para quien apruebe un PR de corrección de `backup.sh`/
  `restore.sh` (opción más limpia: que `backup.sh` genere el manifest con
  rutas absolutas, o que copie maps/official a una carpeta de staging antes
  de calcular el manifest, para que ambos —manifest y datos— viajen bajo la
  misma raíz relativa).

## 1. Precondiciones (verificar SIEMPRE antes de restaurar)

```bash
# 1.1 — Salvaguarda anti-producción: el destino JAMÁS puede ser el host/volúmenes
#       productivos. Definir explícitamente un destino temporal y comprobarlo.
RESTORE_ROOT="/tmp/s9-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
PROD_MARKERS=(/srv/s9-ai-arena "/var/lib/docker/volumes/s9-ai-arena_postgres_data")

for marker in "${PROD_MARKERS[@]}"; do
  case "$RESTORE_ROOT" in
    "$marker"*) echo "ABORTAR: el destino coincide con una ruta de producción ($marker)" >&2; exit 1 ;;
  esac
done
if [ -d /srv/s9-ai-arena/infrastructure ] && [ "$PWD" = "/srv/s9-ai-arena" ]; then
  echo "ABORTAR: estás en el checkout de producción; clona el repo aparte para el simulacro" >&2
  exit 1
fi
mkdir -p "$RESTORE_ROOT"
echo "Destino temporal: $RESTORE_ROOT"

# 1.2 — Nombres/puertos que NO colisionan con nada productivo (proyecto Compose distinto).
export COMPOSE_PROJECT_NAME="s9-restore-drill"
export HTTP_PORT=18080   # producción usa 80/443 (infrastructure/.env)
export HTTPS_PORT=18443
export PG_DRILL_PORT=15432

# 1.3 — Config de restic: SOLO lectura contra el repositorio (restic restore no
#       escribe en el repositorio; restic backup/forget sí — no se invocan aquí).
export RESTIC_REPOSITORY="<repositorio restic designado por el operador>"
# La contraseña NUNCA en la línea de comandos ni en el entorno persistente:
# fichero 0600 provisto por el operador, referenciado por variable:
export RESTIC_PASSWORD_FILE="/ruta/segura/0600/restic_password"   # NO commitear, NO pegar el valor aquí
test -r "$RESTIC_PASSWORD_FILE" || { echo "ABORTAR: falta RESTIC_PASSWORD_FILE legible"; exit 1; }
stat -c '%a' "$RESTIC_PASSWORD_FILE" | grep -q '^600$' || echo "AVISO: permisos del fichero de contraseña != 0600"

# 1.4 — Herramientas requeridas
command -v restic >/dev/null || { echo "FALTA restic"; exit 1; }
command -v docker  >/dev/null || { echo "FALTA docker (motor de contenedores)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "FALTA acceso al demonio Docker (permiso/socket) — ver 'Qué falta' al final"; exit 1; }
```

Sintaxis de los dos scripts, verificable aquí sin Docker:

```bash
bash -n infrastructure/backup/backup.sh   && echo "backup.sh: sintaxis OK"
bash -n infrastructure/backup/restore.sh  && echo "restore.sh: sintaxis OK"
```
(Ejecutado en esta auditoría: ambos OK.)

## 2. Restauración a destino temporal aislado

```bash
cd "$RESTORE_ROOT"
git clone --depth 1 https://github.com/pjclavero/s9-ai-arena.git repo
cd repo

# 2.1 — Listar snapshots disponibles (solo lectura sobre el repositorio restic)
bash infrastructure/backup/restore.sh --list

# 2.2 — Restaurar el snapshot de datos más reciente a un directorio DENTRO
#       de $RESTORE_ROOT, nunca sobre rutas productivas.
bash infrastructure/backup/restore.sh --restore "$RESTORE_ROOT/data"

# 2.3 — Restaurar secretos a un directorio aparte, permisos restrictivos
#       (restore.sh ya hace umask 077; no imprime valores).
bash infrastructure/backup/restore.sh --restore-secrets "$RESTORE_ROOT/secrets-restored"
mkdir -p infrastructure/secrets
cp -a "$RESTORE_ROOT/secrets-restored/secrets/." infrastructure/secrets/
chmod 700 infrastructure/secrets
find infrastructure/secrets -type f -exec chmod 600 {} \;
rm -rf "$RESTORE_ROOT/secrets-restored"

# 2.4 — Config del simulacro: puertos/nombres NO productivos (§1.2), TAG conocido
cp infrastructure/.env.example infrastructure/.env
sed -i "s/^HTTP_PORT=.*/HTTP_PORT=${HTTP_PORT}/" infrastructure/.env
sed -i "s/^HTTPS_PORT=.*/HTTPS_PORT=${HTTPS_PORT}/" infrastructure/.env
sed -i 's/^TAG=.*/TAG=v0.0.0/' infrastructure/.env   # sustituir por el tag del último despliegue conocido

# 2.5 — Levantar SOLO postgres del drill, con un project name propio para que
#       NO comparta red/volúmenes con el stack productivo.
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  --env-file infrastructure/.env --profile production up -d postgres
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml ps postgres
# Esperar healthy:
timeout 60 bash -c \
  'until [ "$(docker inspect -f "{{.State.Health.Status}}" '"$COMPOSE_PROJECT_NAME"'-postgres-1 2>/dev/null)" = healthy ]; do sleep 2; done'
```

## 3. Verificación de integridad comprobable

### 3.1 — Restaurar el dump lógico en el Postgres efímero del drill

```bash
DUMP=$(find "$RESTORE_ROOT/data" -name 'pgdump-*.dump' | sort | tail -1)
test -n "$DUMP" || { echo "ABORTAR: no hay pgdump-*.dump en el snapshot restaurado"; exit 1; }
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  cp "$DUMP" postgres:/tmp/restore.dump
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres sh -c \
  'pg_restore -c --if-exists -U arena -d arena /tmp/restore.dump && rm /tmp/restore.dump'
```

### 3.2 — Recuento de filas por tabla (evidencia de que los datos llegaron, no solo el esquema)

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres psql -U arena -d arena -Atc "
    SELECT relname, n_live_tup
    FROM pg_stat_user_tables
    ORDER BY relname;" | tee "$RESTORE_ROOT/row-counts.txt"
# Anotar aquí (o comparar a mano) contra un recuento previo conocido de producción,
# tomado ANTES del simulacro con la misma consulta contra la BD real (solo lectura).
```

### 3.3 — Migraciones al día (sin re-ejecutar `migrateToLatest` sobre datos ya migrados)

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres psql -U arena -d arena -Atc \
  "SELECT count(*) FROM knex_migrations;"
# Comparar con el número de entradas de MIGRATIONS en apps/api/src/db/migrations.ts
# (11 al momento de este runbook: m001_identity … m011_battle_cpu_ms, línea 674).
grep -c "^const m0" apps/api/src/db/migrations.ts
```

### 3.4 — Invariante del esquema: `audit_log` es de solo-inserción

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres psql -U arena -d arena -Atc "
    SELECT tgname FROM pg_trigger WHERE tgname = 'audit_log_append_only';"
# Debe devolver exactamente: audit_log_append_only

# Probar que el trigger realmente bloquea UPDATE/DELETE (rollback explícito,
# no deja huella):
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres psql -U arena -d arena -v ON_ERROR_STOP=0 -Atc "
    BEGIN;
    UPDATE audit_log SET action = action WHERE false;  -- 0 filas pero dispara el trigger si hay alguna fila
    DELETE FROM audit_log WHERE false;
    ROLLBACK;"
# Con audit_log vacío el UPDATE/DELETE de 0 filas no dispara BEFORE UPDATE/DELETE;
# si hay filas, cualquier intento real de UPDATE/DELETE debe fallar con
# "audit_log es de solo inserción" (migrations.ts:442).
```

### 3.5 — Consulta de negocio (los datos SIRVEN, no solo existen)

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml \
  exec -T postgres psql -U arena -d arena -Atc "
    SELECT b.id, b.status, count(p.id) AS participantes
    FROM battles b
    LEFT JOIN participants p ON p.battle_id = b.id
    GROUP BY b.id, b.status
    ORDER BY b.id DESC
    LIMIT 5;"
# Criterio: al menos una batalla con status final y >0 participantes coherente
# con lo esperado en producción (verificar a ojo contra el recuento de 3.2).
```

### 3.6 — Manifest de mapas/replays: **requiere el rodeo del hallazgo del §0**

```bash
# NO ejecutar restore.sh --verify directamente sobre $RESTORE_ROOT/data: fallará
# el 100% de las entradas por el defecto documentado arriba. Reestructurar antes:
MDIR=$(dirname "$(find "$RESTORE_ROOT/data" -name manifest.sha256)")
mkdir -p "$MDIR/maps" "$MDIR/official"
# maps/: restic restauró bajo $RESTORE_ROOT/data/data/maps (ruta absoluta original)
cp -a "$RESTORE_ROOT/data/data/maps/." "$MDIR/maps/" 2>/dev/null || true
# official/: restic restauró bajo $MDIR/replays-official/data/replays/official
cp -a "$MDIR/replays-official/data/replays/official/." "$MDIR/official/" 2>/dev/null || true

bash infrastructure/backup/restore.sh --verify "$MDIR"
```

## 4. RPO y RTO reales

```bash
DRILL_LOG="$RESTORE_ROOT/tiempos.tsv"
echo -e "fase\tinicio\tfin\tsegundos" > "$DRILL_LOG"
# Envolver cada fase (1..3.6) así, o cronometrar a mano con `date -u +%s`:
t0=$(date +%s); <comando de la fase>; t1=$(date +%s)
echo -e "F1_clone\t$t0\t$t1\t$((t1-t0))" >> "$DRILL_LOG"

# RPO real: antigüedad del snapshot restaurado respecto a "ahora" en el
# momento en que se decide restaurar (no cuando el backup se ejecutó):
restic snapshots --tag s9-arena-data --json | \
  python3 -c "import json,sys,datetime; s=json.load(sys.stdin)[-1]; \
    t=datetime.datetime.fromisoformat(s['time']); \
    print('snapshot', s['short_id'], t.isoformat()); \
    print('RPO (s) =', int((datetime.datetime.now(t.tzinfo)-t).total_seconds()))"

# RTO real: suma de la columna 'segundos' de $DRILL_LOG desde el inicio del
# simulacro (Fase 1) hasta 3.5 verificado en verde. Objetivo DoD T10.4: < 2 h.
awk -F'\t' 'NR>1{s+=$4} END{print "RTO total (s) =", s, " (~" s/60 " min)"}' "$DRILL_LOG"
```

Anotar RPO/RTO en `docs/recuperacion.md` §"Registro del simulacro" **solo
cuando el simulacro se haya ejecutado de verdad** (no en este PR).

## 5. Limpieza del destino temporal

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml down -v
# ↑ -v es seguro AQUÍ porque -p limita el alcance a los volúmenes con prefijo
#   "$COMPOSE_PROJECT_NAME" (proyecto propio del drill, ver §1.2/2.4). NUNCA
#   ejecutar `docker compose down -v` sin -p/--project-name explícito, y NUNCA
#   contra el project name de producción.
docker volume ls --filter "name=${COMPOSE_PROJECT_NAME}" -q | xargs -r docker volume rm
rm -rf "$RESTORE_ROOT"
```

## 6. Rollback si algo falla a mitad

- **Falla la Fase 1 (precondiciones)**: abortar sin tocar nada; no se ha
  creado ningún recurso todavía salvo `$RESTORE_ROOT` (borrar con `rm -rf
  "$RESTORE_ROOT"`).
- **Falla `restic restore` (§2)**: no afecta al repositorio restic (solo
  lectura); borrar `$RESTORE_ROOT` y reintentar, o probar
  `restic snapshots --tag s9-arena-data` con un `--tag`/ID de snapshot
  anterior si el último está corrupto.
- **Falla `pg_restore` a medias (§3.1)**: el Postgres del drill es efímero y
  propio (`-p "$COMPOSE_PROJECT_NAME"`); no requiere reparación, solo:
  `docker compose -p "$COMPOSE_PROJECT_NAME" -f infrastructure/docker-compose.yml down -v`
  y repetir 2.5 + 3.1 desde cero (el volumen se recrea vacío).
- **Falla la verificación de integridad (§3.2-3.6)**: NO se declara el
  simulacro exitoso. Registrar el fallo con evidencia (`row-counts.txt`,
  salida de psql/sha256sum) y tratarlo como hallazgo, no como éxito
  parcial. No se toca producción en ningún caso: este runbook nunca escribe
  sobre el stack productivo.
- **En cualquier punto**: producción no se ve afectada porque (a) todos los
  recursos usan `-p "$COMPOSE_PROJECT_NAME"` con puertos no productivos
  (§1.2), (b) `restic restore`/`--restore-secrets` son de solo lectura sobre
  el repositorio, y (c) la salvaguarda de §1.1 aborta si el destino coincide
  con una ruta productiva conocida.

## 7. Qué falta para ejecutarlo de verdad (honesto, sin simular)

Verificado en esta máquina: el binario `docker` cliente existe (29.5.2) pero
`docker info` / `docker ps` devuelven `permission denied` sobre
`/var/run/docker.sock`, y no hay `sudo` disponible. **No es posible levantar
el Postgres efímero de la Fase 2.5 en este entorno**, y por tanto tampoco
ejecutar las Fases 3.1-3.6 ni medir un RTO real. Todo lo de este documento
hasta el paso de `docker compose up` (validación de sintaxis, lectura de
scripts, precondiciones §1) sí se comprobó de verdad; el resto quedó
verificado por inspección de código, no por ejecución.

Para ejecutarlo de verdad hace falta UNA de estas dos cosas (a decidir por el
operador, no por este agente):

1. **Acceso al demonio Docker desde esta máquina** (usuario en el grupo
   `docker`, o un socket accesible) — el runbook completo (Fases 1-6) tardaría
   entre **20 y 40 minutos** en un entorno con red decente al repositorio
   restic (dominado por el tamaño del `pg_dump` y de los mapas/replays
   oficiales a restaurar), más el tiempo de descarga de la imagen
   `postgres:16-alpine` si no está en caché local.
2. **Una VM del homelab donde el operador lo lance** siguiendo este mismo
   documento (p. ej. una VM de pruebas separada de VM104/105/108, NUNCA una
   de producción) — mismo orden de magnitud de tiempo, más el tiempo de
   aprovisionar la VM si no existe ya una reutilizable.

Además, ejecutarlo de verdad requiere que el operador facilite (por fichero
0600, nunca en la línea de comandos ni en chat): la URL/credenciales de
`RESTIC_REPOSITORY` y el valor de `restic_password`. Sin ellos no hay
snapshots que listar ni restaurar.

**Recomendación aparte de este runbook** (no se actúa aquí): abrir un PR
específico para corregir el defecto del §0 (manifest de integridad
incompatible con la estructura de `restic restore`) antes de dar por bueno
el `--verify` en un simulacro real — de lo contrario el primer simulacro
ejecutado reportará una falsa corrupción del 100 % de mapas/replays.
