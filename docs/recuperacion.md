# Runbook de recuperación total — S9 AI Arena

Objetivo (DoD T10.4): desde una **VM vacía + el último backup** hasta la
plataforma funcional con datos en **menos de 2 horas**, con verificación de
integridad. Estrategia de copias: ADR-010 D10.4 (pg_dump + restic, cron diario
del servicio `backup` del stack, alerta si falla o si no hay backup en 26 h).

> **Estado del simulacro:** PENDIENTE de entorno con Docker (el entorno de
> desarrollo actual no tiene acceso al daemon). Este runbook está listo para
> ejecutarse; al hacerlo, registrar los tiempos en la tabla del final y
> archivar el resultado en este documento.

## Requisitos previos

- Acceso al repositorio restic (`RESTIC_REPOSITORY`, NAS/ZFS del operador) y a
  su contraseña (`restic_password`, custodiada FUERA del servidor: gestor de
  contraseñas del operador; sin ella no hay recuperación posible).
- **Si el destino es SFTP (fix/backup-sftp-scheduled-runtime):** además hace
  falta, TAMBIÉN custodiado fuera del servidor, el material para alcanzar el
  host de respaldo por SSH: la clave privada `restic_ssh_key` y el
  `restic_ssh_known_hosts` con la huella ya verificada del host. Es el mismo
  problema del huevo y la gallina que `restic_password`: ambos viajan DENTRO
  del snapshot de secretos (`s9-arena-secrets`) por comodidad del día a día,
  pero ese snapshot vive precisamente en el repositorio SFTP al que sólo se
  llega usando esa misma clave — sin una copia fuera del servidor, Fase 2 no
  puede arrancar. Ver `infrastructure/.env.example` para el formato de
  `RESTIC_REPOSITORY` con un host de respaldo confinado (`ChrootDirectory`).
- Imágenes versionadas en `ghcr.io/pjclavero/s9-ai-arena/*` (las publica la CI
  en cada merge a main, etiquetadas `v<versión>` y `sha-<commit>`).

## Procedimiento

Cronometrar cada fase (`date` antes y después).

### Fase 1 · VM limpia (≈15 min)

```bash
# Debian/Ubuntu con Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sh
git clone https://github.com/pjclavero/s9-ai-arena.git && cd s9-ai-arena
```

### Fase 2 · Restaurar secretos (≈10 min)

```bash
export RESTIC_REPOSITORY=<repositorio>   # y RESTIC_PASSWORD por el operador
# Si RESTIC_REPOSITORY es sftp:..., restore.sh (como backup.sh) necesita
# 'ssh' instalado y ~/.ssh listo con la clave y el known_hosts custodiados
# fuera del servidor (ver Requisitos previos) ANTES de este comando — restic
# no puede alcanzar el repositorio sin ellos, así que no hay forma de
# "restaurarlos desde el propio backup" en este primer paso.
bash infrastructure/backup/restore.sh --restore-secrets /tmp/restore-secrets
# Colocarlos (rutas con permisos 0600; NUNCA volcarlos a pantalla/logs):
mkdir -p infrastructure/secrets
cp -a /tmp/restore-secrets/secrets/. infrastructure/secrets/
rm -rf /tmp/restore-secrets
cp infrastructure/.env.example infrastructure/.env   # reponer configuración
```

### Fase 3 · Restaurar datos (≈20–40 min según volumen)

```bash
bash infrastructure/backup/restore.sh --list
bash infrastructure/backup/restore.sh --restore /tmp/restore-data
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

# Integridad (criterio del cap. 28): checksums de mapas, bot-sources,
# assets y replays (manifest.sha256 vive junto a los datos en $STAGE, por
# eso `--verify` puede apuntar a todo /tmp/restore-data: localiza el único
# manifest.sha256 igual que en Fase 3 y falla si hay cero o más de uno).
# LIMITACIÓN CONOCIDA (D3, sin implementar a propósito): el dump de
# PostgreSQL (pgdump-*.dump) NO está incluido en manifest.sha256 — es el
# único activo de este backup sin checksum verificado por --verify. Su
# integridad depende hoy de que pg_dump/restic no fallen en silencio, no de
# un hash. Opción técnica disponible si se decide cerrar esta laguna: quitar
# la exclusión `! -path './pgdump-*'` de la generación del manifest en
# backup.sh (cambio de una línea); contra: el nombre del dump incluye el
# timestamp de cada ejecución, así que el checksum nunca es comparable
# entre backups, sólo sirve para detectar corrupción dentro del mismo
# snapshot.
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

## Riesgos conocidos

- La contraseña de restic es el único secreto no recuperable desde el propio
  backup: debe custodiarse fuera del servidor (doble custodia recomendada).
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
