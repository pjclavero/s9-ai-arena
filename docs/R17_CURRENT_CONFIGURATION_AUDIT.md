# R17 – Auditoría de configuración actual

**Auditoría del estado actual (2026-08-09):** inventario de lo que se configura hoy, dónde, qué es secreto, qué está hardcodeado, qué exige reinicio, qué es runtime, qué depende de Docker, qué carece de UI, qué flags existen, qué readiness existe.

**Commit base:** `ef53e049f6642acd6654f3bca25a8302d19623ef` (coincide con `origin/main`).

---

## 1. Capabilities (cuatro, resueltas UNA SOLA VEZ en boot)

Todas se resuelven en `apps/api/src/app.ts:createApp()` líneas 110, 158-160, 173. Cambiarlas requiere **REINICIO**.

| Capability | Variable de entorno | Resolución | Línea | Comportamiento |
|---|---|---|---|---|
| Métricas Prometheus | `S9_METRICS_ENABLED` | `metricsEnabledFromEnv()` | 110 | Con flag OFF: `/metrics` no existe (404), middleware no se instala. Con flag ON: `/metrics` retorna texto Prometheus. |
| Ejecución real de batallas | `S9_ENABLE_REAL_BATTLE_RUNS` | `battleRunConfigFromEnv()` | 158 | Con flag OFF: POST /battles retorna `runner_unavailable` (503). Con flag ON + runner cableado: ejecuta en arena-engine HTTP. |
| Espectador público | `S9_PUBLIC_SPECTATE_ENABLED` | `publicSpectateEnabledFromEnv()` | 159 | Con flag OFF: GET /public/battles/live deniega acceso (usuario anónimo). Con flag ON: permite acceso sin token. |
| Replays públicos | `S9_PUBLIC_REPLAYS_ENABLED` | `publicReplaysEnabledFromEnv()` | 160 | Con flag OFF: GET /public/replays/* deniega acceso anónimo. Con flag ON: permite acceso sin token a batallas `finished`. Independiente de `S9_PUBLIC_SPECTATE_ENABLED`. |

**Importancia:** los cuatro se pasan a `battleRoutes()` (línea 162-169) y `systemRoutes()` (línea 173) como parámetros. El endpoint `GET /system/status` retorna el estado actual de cada uno (apps/api/src/routes/system.ts:54-65).

---

## 2. Variables de entorno (no-secrets)

Se cargan desde `infrastructure/.env.example` (el verdadero; `.env.example` raíz está **obsoleto** con solo 46 bytes).

### 2.1 Identidad y exposición

| Variable | Línea en `.env.example` | Default | Tipo | Reutilizable |
|---|---|---|---|---|
| `S9_DOMAIN` | 14 | (vacío, requerido) | cadena | Nombre del host público del stack (ej. `<dominio-publico>`). |
| `HTTP_PORT` | 20 | 80 | número | Puerto HTTP que publica el gateway. |
| `HTTPS_PORT` | 21 | 443 | número | Puerto HTTPS que publica el gateway. |
| `GATEWAY_CONF` | 26 | `nginx.conf` | `nginx.conf` o `nginx-behind-proxy.conf` | Elige si el gateway termina TLS (standalone) o está detrás de un proxy. |
| `TRUST_PROXY_HOPS` | 35 | 1 (por defecto en Compose) | número | Saltos de proxy de confianza para X-Forwarded-For (ERR-SEC-05, apps/api/src/app.ts:97-101). Si el stack está detrás de un proxy inverso externo, cambiar a 2. |

### 2.2 Base de datos

| Variable | Línea | Default | Tipo | Función |
|---|---|---|---|---|
| `DATABASE_URL` | 52 | (vacío → usa Postgres del stack) | PostgreSQL URI | Instancia externa de PostgreSQL (perfil `external-db`). Nunca incluir contraseña aquí; usar secreto o `.pgpass`. |
| `PGHOST` | infrastructure/backup/backup.sh:34 | `postgres` | nombre de host | Destino de `pg_dump` desde el contenedor backup (nombre DNS del stack). |
| `PGUSER` | infrastructure/backup/backup.sh:35 | `arena` | usuario | Usuario de backup de PostgreSQL. |
| `PGDATABASE` | infrastructure/backup/backup.sh:36 | `arena` | BD | Nombre de la BD a copia. |

### 2.3 Imágenes

| Variable | Línea | Default | Tipo | Función |
|---|---|---|---|---|
| `IMAGE_PREFIX` | 56 | `ghcr.io/pjclavero/s9-ai-arena` | URI de registro | Prefijo del registro de imágenes (GitHub Container Registry por defecto). |
| `TAG` | 57 | `latest` | versión | Tag a desplegar (la CI publica `sha-<commit>` y `v<versión>`). |

### 2.4 Observabilidad (opcional)

| Variable | Línea | Default | Tipo | Función |
|---|---|---|---|---|
| `ALERT_WEBHOOK_URL` | 75 | (vacío) | URL | Webhook de Alertmanager (Slack/Matrix/ntfy del operador). |
| `ALERT_EMAIL` | 77 | (vacío) | email | Email alternativo para alertas (requiere SMTP en alertmanager.yml). |
| `PG_EXPORTER_URI` | 79 | (vacío) | `<host>:<port>/<bd>?sslmode=disable` | URI de postgres-exporter cuando BD es externa (perfil `external-db`). |

### 2.5 Copias de seguridad

| Variable | Línea | Default | Tipo | Función | ⚠️ Crítico |
|---|---|---|---|---|---|
| `RESTIC_REPOSITORY` | 85 | (vacío, **bloquea backup en producción**) | ruta o SFTP URL | Destino del repositorio restic (NAS/ZFS del servidor, ej. `sftp:backup@<host>:/backups/s9-ai-arena` o `/mnt/nas/…`). **Sin esto, el backup corre en dry-run permanente.** |
| `BACKUP_CRON` | 87 | `15 4 * * *` | crontab | Hora del backup diario (formato crontab, hora local del contenedor). |
| `REPLAY_RETENTION_DAYS` | 89 | 180 | días | Retención de replays oficiales en el backup; los demás no se copian. |

**Observación crítica sobre retención:** línea 121 de `infrastructure/backup/backup.sh` hardcodea la política restic:
```bash
restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
```
Esta línea NO se parameteriza desde el entorno. El operador puede cambiar `REPLAY_RETENTION_DAYS`, pero la retención de **snapshots** está fija en 14 diarios, 8 semanales, 12 mensuales.

---

## 3. Secretos (nunca en tablas de configuración, nunca en logs)

Todos viven en `infrastructure/secrets/` (por archivo, .gitignore) y se pasan como `/run/secrets/*` en Compose.

| Secreto | Archivo | Generador | Línea en Compose | Uso | Rotación |
|---|---|---|---|---|---|
| `postgres_password` | `secrets/postgres_password.txt` | `infrastructure/scripts/init-secrets.sh` | 911 | Contraseña del usuario `arena` en PostgreSQL (servicios `postgres`, `api`, `bot-manager`, `tournament-worker`, `replay-service`, `backup`). | Manual (script + operador) |
| `jwt_secret` | `secrets/jwt_secret.txt` | `init-secrets.sh` | 913 | Secreto de firma JWT para tokens de sesión (apps/api/src/middleware/authenticate.ts). | Manual |
| `artifact_signing_key` | `secrets/artifact_signing_key.pem` | `init-secrets.sh` | 918 | Clave ed25519 (PEM PKCS8) para firmar artefactos de bots (ERR-SEC-15, apps/bot-manager/src/signing.ts). **El worker no arranca sin ella.** | Manual (fallo cerrado) |
| `restic_password` | `secrets/restic_password.txt` | `init-secrets.sh` | Montado en `backup`, línea 623 | Contraseña del repositorio restic (backup.sh línea 38: `RESTIC_PASSWORD_FILE=/run/secrets/restic_password`). | Manual |
| `stream_key` | `secrets/stream_key.txt` (opcional) | Operador | Comentado (perfil `streaming`). | Clave RTMPS de YouTube para streamer (apps/streamer/src/config.ts). **Nunca en argv ni en logs.** | Manual (YouTube) |

**Invariante crítica (infrastructure/docker-compose.yml:908-909):**
> Los SECRETOS nunca van aquí: viven en infrastructure/secrets/ (por archivo, nunca variables en claro).

Los secretos **nunca** se retornan por API, **nunca** aparecen en paneles de administración, **nunca** se loguean. El único valor público es un booleano `configured: true/false` (propuesto para R17.1+).

---

## 4. Configuración por BD: NO EXISTE tabla de sistema

No existe tabla `system_config` ni similar. Las **únicas** migraciones programáticas están en `apps/api/src/db/migrations.ts` (T7.1).

### 4.1 Tablas reales (inventario completo)

Generado con `grep -n "CREATE TABLE" apps/api/src/db/migrations.ts`:

| Dominio | Tabla | Línea | Propósito |
|---|---|---|---|
| **Identidad** | `users` | 38 | Usuarios, email, hash Argon2id, TOTP, recuperación |
| | `roles` | 49 | Catálogo: ["visitor", "user", "developer", "team_captain", "organizer", "moderator", "admin"] (jerarquía en línea 20) |
| | `user_roles` | 54 | Asignación de roles a usuarios (FK constrained) |
| | `sessions` | 60 | Sesiones activas, IP, user-agent, refresh_token_hash |
| | `password_resets` | 73 | Tokens de reseteo de contraseña |
| **Equipos** | `teams` | 81 | Equipos de jugadores, capitán |
| | `team_members` | 88 | Miembros de equipos (captain/member) |
| **Catálogo** | `catalog_versions` | 118 | Versiones del catálogo de módulos |
| | `module_definitions` | 127 | Definiciones de módulos (armas, sensores, motores) |
| | `rulesets` | 138 | Rulesets (conjunto de reglas) |
| **Mapas** | `maps` | 148 | Mapas (metadatos) |
| | `map_versions` | 155 | Versiones de mapa (draft/published, geométrica) |
| **Bots** | `bots` | 183 | Bots (propietario, nombre, descripción) |
| | `bot_loadouts` | 195 | Loadouts guardados de bot |
| | `loadout_modules` | 211 | Módulos en un loadout (FK a module_definitions) |
| | `bot_versions` | 222 | Versiones de código de bot (draft/validating/.../published) |
| | `builds` | 242 | Compilaciones (estado, artefacto, firma) |
| | `artifacts` | 254 | Artefactos (blob comprimido, hash) |
| **Batallas** | `tournaments` | 276 | Torneos (formato, estado) |
| | `entries` | 296 | Inscripciones de bots en torneos |
| | `matches` | 309 | Encuentros dentro de torneos |
| | `battles` | 319 | Batallas (estado running/finished/cancelled, replay_ref) |
| | `participants` | 345 | Bots en una batalla (loadout, stats) |
| | `battle_stats` | 367 | Estadísticas por bot en batalla (daño, muertes, etc.) |
| **Rating** | `ratings` | 374 | Rating Elo por bot+categoria |
| | `standing` | 386 | Clasificaciones agrarias por evento |
| | `rating_events` | 551 | Libro mayor de cambios Elo (auditoría) |
| **Admin** | `achievements` | 399 | Logros de jugador (futura API) |
| | `jobs` | 419 | Cola de compilaciones (estado, entrada/salida) |
| | `audit_log` | 429 | Auditoría de operaciones sensibles (ERR-SEC-12, ERR-SEC-14) |
| | `security_findings` | 448 | Hallazgos de seguridad en análisis estático de bots (ERR-SEC-11) |
| | `api_usage` | 458 | Contador de cuota anónima por IP (bloqueo de fuerza bruta) |
| **Streaming** | `session_refresh_tokens` | 594 | Tokens de refresh para sesiones en streaming (E11) |

**Resumen:** 32 tablas. **NO hay tabla de configuración de sistema.** Toda configuración es:
- **Entorno** (variables `.env` de Compose)
- **Secretos** (archivos en `/run/secrets/`)
- **Hardcodeado** (líneas fijas en el código, ej. retención restic en backup.sh:121)

---

## 5. Readiness: modelo actual vs. modelo propuesto

### 5.1 Estado ACTUAL (ingenuo)

Cada servicio declara un `/healthz` que comprueba **lo mínimo:**

| Servicio | Puerto | Healthcheck (línea docker-compose.yml) | Qué comprueba | Qué NO comprueba |
|---|---|---|---|---|
| **api** | 8080 | `GET /healthz` (45) | Responde 200 | BD accesible, volúmenes, capabilities |
| **web** | 3000 | `GET /healthz` (109) | Responde 200 | Conectividad a la API |
| **arena-engine** | 8081 | `GET /healthz` (236) | Responde 200 | Datos de mapa, módulos del catálogo |
| **bot-manager** | 8084 | `GET /healthz` (336) | Responde 200 | BD, acceso a runtimes, secretos |
| **replay-service** | 8082 | `GET /healthz` (417) | Responde 200 | Volumen arena_replays escribible |
| **map-service** | 8083 | `GET /healthz` (460) | Responde 200 | Volumen arena_maps accesible |
| **tournament-worker** | N/A (batch) | N/A | N/A | BD, jobs, rating_events |
| **backup** | N/A (cron) | `pgrep crond >/dev/null` (592) | `crond` proceso vivo | Si realmente ha hecho backup, si repositorio es válido, si datos se copiaron |
| **postgres** | 5432 | `pg_isready` | Postgres responde | BD funcional, schemas aplicadas |

**Problemas del modelo actual:**

1. **Precedente real (packages/data-dir/index.ts:4-9):**
   > "Defecto REAL observado en producción: el volumen `arena_replays` se creó `root:root`, el replay-service corre como `node` (uid 1000) y CADA ingesta moría con `EACCES: permission denied`. El servicio estaba 'healthy' todo ese tiempo — /healthz no toca el disco — y el directorio llevaba **diez días vacío**."

2. **Backup eternamente "healthy" en dry-run:** el contenedor backup es "sano" si `crond` está vivo, pero `RESTIC_REPOSITORY` está vacío (línea 85 de `.env.example`), así que el script corre en `--dry-run` permanente (backup.sh:24). No existe ninguna copia de seguridad, pero Docker lo marca "healthy" porque el proceso está vivo.

3. **Sin readiness separado:** no hay forma de distinguir entre "el servicio está arrancado" y "el servicio está LISTO para recibir tráfico real." Una UI no puede:
   - Impedir que el operador lance batallas reales hasta que el runner esté disponible.
   - Avisar de que el backup no ha funcionado en 30 días.
   - Bloquear escrituras en arena_replays si el volumen no es escribible.

### 5.2 Propuesta de modelo (R17.0 en adelante)

**Tres niveles NO equivalentes:**

1. **UNPROTECTED** (nivel 0): BD viva pero sin backup verificable. Riesgo máximo: pérdida total si fallo de hardware.
2. **BACKED_UP** (nivel 1): snapshot restic verificable que incluye BD dentro de política de edad. Requiere verificación real de `restic snapshots` (no solo "el proceso está vivo").
3. **RECOVERY_VERIFIED** (nivel 2): simulacro de restauración real satisfactorio. Ámbito limitado en el proyecto actual.

**Readiness independientes (cada uno Yes/No):**
- `database` — PostgreSQL responde, esquemas aplicadas, tablas criticas existen
- `storage` — volúmenes arena_maps, arena_replays, arena_bot_sources, arena_assets escribibles de verdad
- `runner` — arena-engine accesible y reacciona a requests
- `build` — bot-manager alcanzable, secreto de firma presente, runtimes cargables
- `replay` — replay-service alcanzable, volumen arena_replays escribible
- `backup` — repositorio restic configurable, alcanzable, credenciales válidas
- `security` — secretos presentes (jwt_secret, artifact_signing_key, etc.)
- `spectator` — si S9_PUBLIC_SPECTATE_ENABLED=1, arena-engine + replay-service listos
- `public_replay` — si S9_PUBLIC_REPLAYS_ENABLED=1, replay-service + BD listos

**Agregados (lógica AND/OR):**
- `SETUP_REQUIRED` — cualquier readiness crítico (BD, storage) en NO.
- `READY_WITH_WARNINGS` — todos críticos en SÍ pero backup en NO (datos sin protección).
- `READY` — todos listos.
- `BLOCKED` — algún critical fallo detectado (ej. volumen montado pero no escribible).

**Regla inviolable:** `healthy` (proceso vivo) ≠> `ready` (datos accesibles y verificables).

---

## 6. Autorización (RBAC)

### 6.1 Roles (jerarquía lineal)

Definidos en `apps/api/src/db/migrations.ts:20` e insertados en operación m001_identity de migraciones:

```
["visitor", "user", "developer", "team_captain", "organizer", "moderator", "admin"]
```

**Significado:**
- **visitor** — sin cuenta, acceso anónimo a público (batallas en vivo, replays si S9_PUBLIC_REPLAYS_ENABLED).
- **user** — cuenta verificada, puede crear bots y equipos.
- **developer** — permisos de compilación y depuración.
- **team_captain** — gestión de equipo.
- **organizer** — gestión de torneos.
- **moderator** — acción disciplinaria.
- **admin** — lectura de sistema, matriz RBAC.

### 6.2 Declaración y aplicación

Cada endpoint en `apps/api/openapi.yaml` declara `x-min-role` (ej. línea 73, 90, 124, etc.). El middleware `rbacGuard()` (apps/api/src/registry.ts:20) aplica la restricción:

```typescript
function rbacGuard(minRole: RoleName): RequestHandler {
  return async (req, res, next) => {
    if (!hasRole(req.user?.roles ?? [], minRole)) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}
```

Registrado en `defineOperation()` (registry.ts:57, 81).

**No existe UI administrativo de roles:** la única operación de write es `setUserRoles` (admin-only). Cambiar roles de un usuario requiere acceso directo a BD o API privada.

---

## 7. Flags sin UI

### 7.1 Capabilities (cambio requiere reinicio)

Todas las flags de capability mencionadas en sección 1 se leen del entorno **UNA SOLA VEZ** en boot y se pasan a `createApp()`. No se pueden cambiar sin reiniciar el contenedor de la API.

### 7.2 Modo de ejecución real

- **S9_ENABLE_REAL_BATTLE_RUNS=1** — abre POST /battles (línea 158).
- **Requiere runner cableado** (ARENA_ENGINE_URL + secreto compartido válido) para evitar 503.
- **La UI no tiene interruptor:** es una decisión del operador en `.env` o variable de Compose.

---

## 8. Estado de la instalación de referencia (actual)

Datos recopilados del documento `docs/estado-proyecto.md` y auditoría de configuración:

### 8.1 BD

- **Estado:** datos reales presentes (batallas, bots, usuarios, torneos del prototipo v1).
- **Versión:** PostgreSQL 18.4 (confirmado en tests E7).
- **Accesibilidad:** viva en el contenedor `postgres` del stack.
- **Tablas:** todas las 32 del esquema aplicadas sin error (migrations.ts:m001_identity - m*).

### 8.2 Volúmenes de datos

- **arena_maps** — volumen declarado (infrastructure/docker-compose.yml:887), **vacío** (no hay mapas oficiales cargados).
- **arena_bot_sources** — volumen declarado (889), **vacío** (bots de ejemplo solo en `example-bots/` del repo, no persistidos).
- **arena_assets** — volumen declarado (891), **vacío** (recursos de módulos no precargados).
- **arena_replays** — volumen declarado (888), **contiene replays en raíz**, subdirectorio `official/` **NO EXISTE**. Primera ingesta escribió replays sin subcarpeta.
- **arena_logs** — volumen declarado (897) **vacío y sin montar** (arena-engine escribe a stdout, no a archivo).

### 8.3 Backup

**Estado crítico: 18+ días en DRY-RUN permanente.**

- **RESTIC_REPOSITORY:** vacío (infrastructure/.env.example:85).
- **Script:** corre `backup.sh --dry-run` automáticamente cada día (infrastructure/backup/backup.sh:24).
- **Qué se copiaría si estuviera configurado:**
  - PostgreSQL (pg_dump custom format comprimido).
  - arena_maps completo (RO).
  - arena_bot_sources completo (RO).
  - arena_replays/official/ solamente dentro de REPLAY_RETENTION_DAYS (180 días).
  - infrastructure/secrets/ (cifrados por restic).
  - manifest.sha256 de verificación de integridad.
- **Qué NO se copia:**
  - arena_assets (no montado en contenedor backup — línea 884 de docker-compose.yml no incluye arena_assets).
  - arena_logs (vacío, no montado).
- **Healthcheck:** `pgrep crond >/dev/null` (línea 592 docker-compose.yml) comprueba que el proceso cron está vivo, **NO que ha hecho backup real**. Puede estar "healthy" semanas sin haber guardado nada.
- **Conclusión:** **NO existe ninguna copia de seguridad real.** La instalación es UNPROTECTED nivel 0 (BD sin backup verificable).

### 8.4 Servicios críticos

| Servicio | Estado real | Volúmenes | Capacidad |
|---|---|---|---|
| **API** | Responde | BD | Lectura-escritura de BD real |
| **Bot-Manager** | No desplegado (E6 solo verificable sin Docker) | Secretos | Necesita runtimes físicos + Docker |
| **Replay-Service** | No desplegado (E8 solo verificable sin Docker) | arena_replays (vacío excepto replays raíz) | Depende de volumen escribible |
| **Map-Service** | No desplegado (E4 validable sin servidor) | arena_maps (vacío) | Serve mapas (ninguno cargado) |
| **Tournament-Worker** | No desplegado (batch en E9) | BD, jobs | Procesa torneos (ninguno activo) |
| **Arena-Engine** | No desplegado (E2 validable en proceso) | Catálogo, módulos | Simula batallas (sin runner real cableado) |

**Contexto:** versión 1 (prototipo anterior) sigue en producción en el servidor de demostración. El stack v2 del capítulo 6 (infrastructure/docker-compose.yml) **nunca ha sido desplegado** (docs/estado-proyecto.md:37-46). Requiere Docker (no disponible en el servidor de desarrollo).

---

## 9. Imágenes Docker

Construidas por GitHub Actions (`.github/workflows/ci.yml`, incluida en E10):

- **IMAGE_PREFIX:** `ghcr.io/pjclavero/s9-ai-arena` (github/pjclavero).
- **TAGs:** 
  - `latest` (rama main después de CI verde).
  - `sha-<commit>` (cada build de rama).
  - `v<versión>` (tags git de release, futuro).
- **Servicios construidos:** 2 de 8 (según docs/estado-proyecto.md:104, línea 44).
- **Base:** `node:22` (línea E10 confirma Node 22; Node 20 en ia-server causa fallos zstd en tests).

---

## 10. Hallazgos de seguridad

### 10.1 Direcciones IP de instalación específica en `infrastructure/.env.example`

El archivo `.env.example` real (no el obsoleto de la raíz) contiene comentarios con ejemplos que incluyen direcciones IP internas de máquinas de esta instalación:
- Línea 50: comentario de `DATABASE_URL` con IP de BD externa.
- Línea 79: comentario de `PG_EXPORTER_URI` con IP de observabilidad.
- Línea 83: comentario de `RESTIC_REPOSITORY` con IP de host de backup.

**Impacto:** el repo es público; estos ejemplos exponen direcciones IP de infraestructura del servidor. Deben ser reemplazados por placeholders genéricos (`<database-host>`, `<backup-host>`, `<exporter-host>`) o direcciones de documentación (rango RFC 5737: `192.0.2.x`).

### 10.2 Entrypoints de servicios comentados

Líneas 60-66 de infrastructure/.env.example tienen entrypoints de servicios comentados (WEB_ENTRY, API_ENTRY, etc.). Están marcados como "los fija cada equipo cuando entrega" pero no se usan actualmente (los entrypoints están codificados en dockerfiles). No impacto de seguridad, pero confunden.

### 10.3 El `.env.example` raíz está obsoleto y confunde

`.env.example` raíz (46 bytes) vs `infrastructure/.env.example` (1400+ bytes). El raíz es un residuo del prototipo v1; debe ser retirado o actualizado a una remisión.

---

## 11. Observaciones finales

1. **No existe "tabla de configuración de sistema":** toda configuración es entorno + secretos + hardcoding.
2. **Readiness es actualmente trivial:** cada servicio reporta "ok" si el proceso está vivo, ignorando accesibilidad de datos, volúmenes y funcionalidad.
3. **Backup está bloqueado:** RESTIC_REPOSITORY vacío = dry-run permanente = cero copias de seguridad reales.
4. **Capabilities se resuelven UNA SOLA VEZ en boot:** cambiarlas requiere reiniciar la API (no son runtime).
5. **No hay UI administrativo de configuración:** solo lectura de estado en `/system/status` (admin-only).
6. **Secretos bien segregados:** nunca en tablas de BD, nunca en logs, nunca en retorno de API.
7. **RBAC declarativo:** cada endpoint declara `x-min-role`, middleware aplica la restricción.
8. **Volúmenes vacíos:** datos reales solo en BD; mapas, assets, bots de usuario no persistidos.

**Propósito de R17:** establecer un modelo de configuración extensible que permita:
- Readiness honesto (datos accesibles, verificable).
- Wizard de configuración inicial.
- Gestión de múltiples repositorios de backup.
- Distinción entre secret (nunca visible) y config (visible pero no editable desde UI).
- Salidas graciosas cuando capabilities críticas no están disponibles.

