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
DUMP=$(find /tmp/restore-data -name 'pgdump-*.dump' | sort | tail -1)
docker compose -f infrastructure/docker-compose.yml cp "$DUMP" postgres:/tmp/restore.dump
docker compose -f infrastructure/docker-compose.yml exec postgres \
  sh -c 'pg_restore -c --if-exists -U arena -d arena /tmp/restore.dump && rm /tmp/restore.dump'
```

### Fase 6 · Restaurar volúmenes (≈10 min)

```bash
for v in maps bot-sources replays; do
  src=$(find /tmp/restore-data -type d -name "$v" -o -type d -name "replays-official" | head -1)
  # Copia al volumen con un contenedor auxiliar del propio stack:
  docker run --rm -v "s9-ai-arena_arena_${v//-/_}:/dst" -v "$src:/src:ro" alpine \
    sh -c 'cp -a /src/. /dst/'
done
```

### Fase 7 · Arrancar todo y verificar (≈15 min)

```bash
docker compose -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  --profile production up -d
docker compose -f infrastructure/docker-compose.yml ps          # todo healthy

# Integridad (criterio del cap. 28): checksums de mapas y replays oficiales
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
| Integridad de mapas/replays | `restore.sh --verify` (sha256, probado en `infrastructure/tests/backup.test.ts`) | 0 discrepancias |
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
- Replays no oficiales y `arena_build_cache` NO se copian (decisión de
  retención del dosier 23.1): se regeneran.
- Si se usa PostgreSQL externo (perfil `external-db`), la Fase 5 se ejecuta
  contra esa instancia (`pg_restore -h <host externo>`) y la Fase 4 no levanta
  postgres.
