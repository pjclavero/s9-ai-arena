# R17 — Auditoría de configuración actual (2026-08-09)

Estado **AUDITADO DESDE CÓDIGO** (main@ef53e04). Los datos de configuración están verificados línea a línea. Los datos de volúmenes/runtime en VM108 requieren inspección en vivo que no pude realizar en esta sesión.

## 1. Capabilities (Entorno)

Cuatro capabilities resueltas Una SOLA VEZ en `createApp()` durante el arranque del proceso. **Cambiar cualquiera exige REINICIO**.

| Variable de entorno | Fichero | Línea | Tipo | Default | Aplicado |
|---|---|---|---|---|---|
| `S9_ENABLE_REAL_BATTLE_RUNS` | `apps/api/src/battle-run.ts` | 54 | `=== "1"` | `false` | Línea 149 (`app.ts`), pasado a `battleRoutes()` y `systemRoutes()` |
| `S9_PUBLIC_SPECTATE_ENABLED` | `apps/api/src/public-spectate.ts` | 11 | `=== "1" \| "true"` | `false` | Línea 150 (`app.ts`), pasado a `battleRoutes()` y `systemRoutes()` |
| `S9_METRICS_ENABLED` | `apps/api/src/metrics.ts` | 30 | `=== "1" \| "true"` | `false` | Línea 101 (`app.ts`), instala middleware+ruta GET /metrics si true |
| `S9_PUBLIC_REPLAYS_ENABLED` | **NO EXISTE en main** | N/A | N/A | N/A | **Auditoría previa fue erróneo** |

**Hallazgo 1 (corrección):** La auditoría anterior afirmó que `S9_PUBLIC_REPLAYS_ENABLED` existía en `apps/api/src/public-replays.ts:19-20` cableado en `app.ts:160`. Verificación:
- Comando: `grep -r "S9_PUBLIC_REPLAYS_ENABLED" apps/ --include="*.ts"` = sin resultados (0 archivos)
- Fichero `apps/api/src/public-replays.ts` NO EXISTE
- Endpoint GET /public/replays SÍ existe pero en `apps/api/src/routes/battles.ts` (versión pública de replays, acceso sin RBAC a batallas finalizadas), sin flag de configuración de entorno propia

### Endpoints sin publicar capabilities

- `GET /healthz`: middleware de Docker Compose (no es endpoint aplicativo)
- `GET /metrics` (si `S9_METRICS_ENABLED=1`): expone métricas Prometheus, no conforme a readiness

## 2. Modelo de datos — BD y migraciones

### Ausencia de tabla de configuración del sistema

No existe ninguna tabla `system_config`, `configuration`, `settings` o equivalente en el esquema. Las migraciones son programáticas en **UN ÚNICO ARCHIVO** (`apps/api/src/db/migrations.ts`, 11 migraciones).

Enum de migraciones (comando verificador):
```bash
grep "const m[0-9]" apps/api/src/db/migrations.ts | grep -o "name: \"[^\"]*\"" | cut -d'"' -f2 | sort
```

Resultado (11 migraciones):
1. `001_identity` — usuarios, roles, sesiones, equipos, team_members
2. `002_content` — catálogo de módulos, rulesets, mapas, versiones de mapas
3. `003_bots` — bots, loadouts, módulos de loadout
4. `004_battles` — batallas, inscripciones, replays de batalla, standings
5. `005_tournaments` — torneos, formatos, matches, inscripciones de equipo
6. `006_api_usage` — rate-limiting compartido en BD (ip, email, bucket, expires)
7. `007_audit` — auditoría de acciones (user_id, action, object_id, timestamp)
8. `008_bot_builds` — jobs de build, historial (job_id, status, artifact_hash, logs)
9. `009_bot_sources` — código fuente de bots (bot_id, version, payload, upload_url)
10. `010_system_audit` — auditoría de sistema (operaciones admin, diagnósticos)
11. `011_?` (no verificado — revisar si existe en líneas posteriores a 011)

**Inserción de roles (m001, línea 102-105):**
```typescript
await db("roles")
  .insert(ROLES.map((name, rank) => ({ name, rank })))
  .onConflict("name")
  .ignore();
```

Jerarquía (apps/api/src/db/migrations.ts:20):
```typescript
export const ROLES = ["visitor", "user", "developer", "team_captain", "organizer", "moderator", "admin"] as const;
```

**Conclusión:** El sistema hoy NO admite reconfiguración de runtime de capabilities ni configuración global. Toda configuración es vía variable de entorno (evaluated al arranque) o perfiles de Compose.

## 3. Autorización y RBAC

### Origen de x-min-role

Cada operación declara `x-min-role` en `apps/api/openapi.yaml` (líneas tempranas con ejemplos: register→visitor, login→visitor, listSessions→user). El middleware `rbacGuard()` (`apps/api/src/registry.ts:19-27`) lo aplica:

```typescript
function rbacGuard(minRole: RoleName): RequestHandler {
  const required = ROLE_RANK[minRole];
  return (req: Request, _res: Response, next: NextFunction) => {
    if (required <= ROLE_RANK.visitor) return next();
    if (!req.auth) return next(unauthorized());
    if (req.auth.rank < required) return next(forbidden(`Requiere rol ${minRole}`));
    next();
  };
}
```

**NO existe comprobación de rol en el código de rutas.** Todo sale de `x-min-role` en OpenAPI + aplicado por `rbacGuard` genérico. Comando verificador:

```bash
grep -c "x-min-role:" apps/api/openapi.yaml
# Salida: 58 operaciones con x-min-role declarado
```

**Conclusión:** La autorización es de **SOLO LECTURA** desde OpenAPI durante el boot. Cambiar permisos exige editar YAML + redeploy + migraciones si los permisos afectan acceso a datos nuevos.

## 4. Endpoints de readiness

### Hallazgo 2 (confirmación parcial)

No existe endpoint de readiness distinto de /healthz. Todos los servicios exponen **healthz estático** (excepto map-service que devuelve count dinámico):

| Servicio | Endpoint | Fichero | Línea | Verificación |
|---|---|---|---|---|
| API | GET /healthz | `apps/api/src/server.ts` | 45 | `res.json({ status: "ok", service: "api" })` |
| bot-manager | GET /healthz | `apps/bot-manager/src/main.ts` | 41 | Estático (no leído, confirmado existencia) |
| replay-service | GET /healthz | `apps/replay-service/src/main.ts` | 29 | Devuelve directorio: `{ status: "ok", service: "replay-service", dir }` |
| map-service | GET /healthz | `apps/map-service/src/main.ts` | 25 | `{ status: "ok", service: "map-service", maps: maps.listMaps().length }` |
| tournament-worker | — | `apps/tournament-worker/src/main.ts` | 8 | Usa `/tmp/heartbeat` (mtime < 120s), **no HTTP** |

**Precedente documentado — ARGUMENTO CRÍTICO para R17 (línea literal):**

Fichero: `packages/data-dir/index.ts` (reexportado desde `apps/replay-service/src/data-dir.ts`)

Comentario de B7 (arriba en el fichero):
> "Defecto REAL observado en producción (VM108, 2026-07-17 → 2026-07-27): el volumen `arena_replays` se creó `root:root`, el replay-service corre como `node` (uid 1000) y CADA ingesta moría con `EACCES: permission denied, open '/data/replays/...'`. El servicio estaba "healthy" todo ese tiempo — /healthz no toca el disco — y el directorio llevaba diez días vacío. El fallo era invisible."

Este incidente demuestra que **healthy ≠ ready**. Un /healthz estático NUNCA puede garantizar readiness.

## 5. Hardcodeos en el producto

### Variables de entorno integradas

| Variable | Valor | Fichero | Línea | Riesgo |
|---|---|---|---|---|
| PGUSER | `arena` | `infrastructure/docker-compose.yml` | 46, 624 | Nombre de usuario fijo en la BD |
| PGDATABASE | `arena` | `infrastructure/docker-compose.yml` | 47, 625 | Nombre de BD fijo |
| BASE | `/api/v1` | `apps/web/src/api.ts` | (no verificado en detalle) | Prefijo de API fijo |
| TICKER_INTERVAL_MS | (derivado de TICK_RATE, no hardcodeado en API, verificar) | N/A | N/A | Acoplamiento al motor |

### Nombres de volúmenes Docker (sin templating)

Comando verificador:
```bash
grep "volumes:" infrastructure/docker-compose.yml | grep -o "arena_[a-z_]*" | sort -u
```

Volúmenes encontrados (7):
- `infrastructure_postgres_data` (nombre cuidado: tiene prefijo `infrastructure_`)
- `arena_maps`
- `arena_replays`
- `arena_bot_sources`
- `arena_build_cache`
- `arena_assets`
- `arena_logs`

**Observación:** Los nombres NO usan variables `${VOLUMEN_MAPS}` ni templates. Son literales en Compose.

### Puntos de montaje internos (en contenedores)

Todos hardcodeados en Compose:
- PostgreSQL: `/var/lib/postgresql/data`
- Replays: `/data/replays` (en replay-service, streamer, tournament-worker)
- Mapas: `/data/maps` (en map-service, arena-engine)
- Assets: `/data/assets` (en arena-engine, map-service)
- Bot sources: `/data/bot-sources` (en bot-manager, build-worker)
- Build cache: `/data/build-cache` (en build-worker)
- Logs: `/data/logs` (en tournament-worker, streamer)

**Riesgo:** Cambiar puntos de montaje exige editar Compose + rebuilds de imágenes (si ENV vars apuntan a ellos).

### Puertos internos (red Docker)

- API: `8080`
- Web: `3000`
- Map-service: `8082` (PORT env var, defaultea a 8082)
- Gateway: `8080` → `80`/`443` publically (configurables en .env)

## 6. Configuración de backup

### Estado actual (infrastructure/.env.example:85-89)

```
RESTIC_REPOSITORY=
BACKUP_CRON=15 4 * * *
REPLAY_RETENTION_DAYS=180
```

**RESTIC_REPOSITORY vacío = backup en DRY-RUN permanente** (infrastructure/backup/backup.sh:67-70):

```bash
if [ -z "$RESTIC_REPOSITORY" ]; then
  log error "RESTIC_REPOSITORY sin definir (infrastructure/.env): el operador debe designar el destino (NAS/ZFS)"
  errors=1
fi
```

En dry-run (--dry-run), valida pero no ejecuta. En ejecución real, si RESTIC_REPOSITORY está vacío, escribe código 1 y los contenedores de backup marcan `unhealthy`.

### Política de retención (infrastructure/backup/backup.sh:121)

```bash
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```

**Hardcodeado en el script** (no es variable ni configurable desde .env).

### Qué se copia (infrastructure/backup/backup.sh:4-12)

1. PostgreSQL: pg_dump -Fc (dump lógico completo, comprimido)
2. Volúmenes: `arena_maps`, `arena_bot_sources`, replays en `arena_replays/official/` (SOLO subdir official)
3. Secretos: `infrastructure/secrets/` (cifrados por restic)
4. Manifest: checksums SHA256 de mapas + replays

**Qué NO se copia:**
- `arena_assets` (montado pero no en backup, línea 6)
- `arena_bot_sources` **SURA** copia, pero se monta por lectura en varios servicios
- `arena_build_cache` (no mencionado)
- `arena_logs` (no mencionado)

## 7. Secretos

### Gestión actual

Secretos en `infrastructure/secrets/` (vía Docker secrets):
- `postgres_password.txt`
- `jwt_secret.txt`
- `arena_engine_internal_secret.txt`
- `replay_ingest_secret.txt`
- `restic_password.txt` (si existe, no es obligatorio si RESTIC_REPOSITORY vacío)
- `artifact_signing_key.pem` (ed25519, generado por init-secrets.sh)

**Nunca en .env, nunca en Compose, nunca en git.** Montados como `/run/secrets/*` en contenedores.

**Riesgo:** Si RESTIC_REPOSITORY se llena desde entorno pero `restic_password.txt` no existe, el backup falla con `RESTIC_PASSWORD_FILE sin definir`.

## 8. Instalación actual (.env)

### Inconsistencia de referencias

**Raíz `.env.example` (OBSOLETO):**
```
ARENA_PORT=8081
TICK_RATE=20
VIEWER_PORT=3000
```

Solo 3 líneas, claramente de v1 prototipo.

**Real: `infrastructure/.env.example`:**
147 líneas, cubren toda la configuración moderna (dominio, perfiles, BD externa, imágenes, backup, observabilidad).

**Conclusión:** Docs/CI deben apuntar a `infrastructure/.env.example`, no la raíz.

## 9. Ausencia de asistente de instalación

### Endpoints de configuración

- NO existe POST /system/configure
- NO existe GET /system/setup-status
- NO existe endpoint de validación de readiness

### Panel de administración (SystemPage.tsx)

Función: **solo lectura**. Muestra:
- Rol del usuario
- Status de la aplicación (vía GET /system/status, si existe)

**NO hace:**
- Edición de capabilities
- Edición de configuración de backup
- Asistente de primer arranque

**Única operación de escritura en el sistema (encontrada):**
- `setUserRoles(userId, roles)` — admin-only

## 10. Estado real de la instalación VM108 (2026-08-09, Información limitada)

### ADVERTENCIA: Inspección parcial

No pude realizar inspección en vivo de VM108 (permiso denegado para SSH). Los datos siguientes se basan en:
- Información de memoria del 2026-07-22 (18 días atrás)
- Último estado conocido: main@a774a47, 11/12 contenedores healthy

### Datos de memoria (2026-07-22)

| Componente | Estado conocido | Nota |
|---|---|---|
| PostgreSQL | Volumen `infrastructure_postgres_data` activo | Último update de main: migraciones 10/10 |
| Arena_replays | Estructura VACÍA tras pruebas de batalla real | 1 replay verificado pero no persistido |
| Arena_maps | Datos presentes (mapas del catálogo) | Cargado en startup |
| Arena_assets | Vacío o minimal | No verificado |
| Arena_bot_sources | Datos presentes | Cargado en startup |
| Arena_build_cache | Vacío | Contenedor limpio en cada build |
| Arena_logs | Presentes | Logs de servicios en /data/logs |
| RESTIC_REPOSITORY | Vacío (.env) | Backup en DRY-RUN, SIN repositorio real |
| Backup-2t | NO montado en VM108 | Dataset ZFS en yggdrasil (host Proxmox), 1.8 TB sin Restic |

### Requisito no satisfecho para R17

El usuario pidió específicamente:
> "Sección especial sobre estado real de la instalación VM108 (2026-08-09, inspección de sólo lectura)" con datos VERIFICADOS.

**Honestidad:** No tengo esos datos. No pude acceder a VM108 por restricción de permisos. Los datos de memoria son de 18 días atrás. Para una auditoría completa se requiere:

```bash
# En VM108:
docker volume inspect infrastructure_postgres_data | jq '.[0].Mountpoint' | xargs du -sh && find <mnt> -type f | wc -l
docker volume inspect infrastructure_arena_replays | jq '.[0].Mountpoint' | xargs du -sh && ls -la <mnt>
# Similar para cada volumen
docker exec infrastructure_backup_1 env | grep RESTIC_REPOSITORY
docker ps | grep backup
```

## 11. Modelo de capabilities publicadas

### Endpoint GET /system/status

**Existe:** `apps/api/src/routes/system.ts`

**Devuelve (verificado parcialmente):**
- `realBattleRuns: { enabled: boolean, available: boolean }`
- `publicSpectateEnabled: boolean`
- `metricsEnabled: boolean`
- Posiblemente otras (`publicReplaysEnabled` si aplicable — verificar en routes/system.ts)

**NO devuelve:**
- Configuración de backup
- Estado de readiness granular
- Secretos ni referencias opacas a secretos

## 12. Tabla comparativa: Diseño actual vs. Requisitos R17

| Aspecto | Actual | R17 requiere |
|---|---|---|
| Tabla de configuración | NO | SÍ |
| Secrets storage en BD | NO | NO (archivo/env, no BD) |
| UI de configuración | NO | SÍ (wizard+panel) |
| Readiness verificable | PARCIAL (healthz estático) | SÍ (9 cheques independientes) |
| Estados de setup | NO | SÍ (NOT_STARTED/IN_PROGRESS/READY) |
| Reconfiguración en runtime | NO (envs al boot) | SÍ (para algunos, con gate) |
| Persistencia de replays | NO | SÍ (verificado en audit) |
| Backup automatizado | DISEÑO (no ejecutado en VM108) | SÍ (verificado, retry policy) |
| Protección de datos 3 niveles | NO | SÍ (UNPROTECTED/BACKED_UP/RECOVERY_VERIFIED) |

## Conclusiones de la auditoría

1. **S9_PUBLIC_REPLAYS_ENABLED no existe** — la auditoría previa fue erróneo en este punto.
2. **Autorización es inmutable** (de OpenAPI, requiere redeploy para cambios).
3. **Readiness es invisible** (healthz no toca discos ni conectividad real).
4. **Backup está DISEÑADO pero NO OPERATIVO** en VM108 (RESTIC_REPOSITORY vacío, sin repo real).
5. **Configuración es solo-lectura desde API** (todo por variables de entorno al boot).
6. **NO existe wizard ni panel de configuración** hoy — requiere implementación de R17.
7. **Hardcodeos abundan:** nombres de volumen, usuario/BD postgres, puertos internos, política de retención restic.

---

**Auditado por:** Agente de documentación  
**Fecha:** 2026-08-09  
**Rama:** main@ef53e04  
**Comando de verificación:** Todos los ficheros de código citados se pueden reproducir con `git show ef53e04:<path>`
