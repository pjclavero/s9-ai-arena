# R17 — Installation, Configuration & Readiness · Arquitectura propuesta

**Scope:** Diseño de la gestión de configuración, secrets, readiness checks y el flujo de asistente de instalación para que el stack sea verificable y autoconfigurable sin hardcodeos.

**No es un PRD.** Fija la taxonomía, el modelo de datos y los límites de cada slice. Las decisiones de implementación se toman slice por slice.

---

## 0. Goals y non-goals

### Goals

1. **Verificabilidad:** El sistema puede probar que está en un estado conocido sin acceso shell (sin `docker exec`, sin archivos en el host).
2. **Autoconfigurable:** Un operador sin experiencia puede seguir un wizard que lo lleve de FRESH a READY.
3. **Tolerancia a retrasos:** Setup puede abandonarse y reanudarse sin conflictos.
4. **Secrets seguros:** Nunca en BD, nunca en API responses, nunca en .env (salvo lectura en startup).
5. **Diagnosticable:** Si falla, el mensaje es accionable (no "unhealthy", sino "database_ready=false porque PostgreSQL sin responder en ::5432").
6. **Sin hardcodeos nuevos:** La UI NO debe referenciar rutas, volúmenes, puertos específicos de VM108.

### Non-goals

1. Reconfiguración de TODAS las capabilities en vivo (algunas siempre exigen reinicio: `S9_ENABLE_REAL_BATTLE_RUNS` etc.).
2. Replicación/HA de la configuración (single writer, siempre).
3. Auditoría de cambios de configuración (`who changed what when` — captura diferencial de valores, no historial).
4. Migraciones reversibles de datos (backup/restore sí, viajes de versión no).

---

## 1. Taxonomía: cinco clases de configuración

### 1.1 BOOTSTRAP CONFIG

**Resuelto antes del primer boot del API.** Sin esto, el proceso no puede arrancar.

- `DATABASE_URL` — conexión a PostgreSQL (JDBC URL o `postgresql://user:pass@host:port/db`)
- `SECRET_STORE_TYPE` — "env" (default) | "file" (directorio con ficheros 0600) | "hashicorp-vault" (futuro)
- `SECRET_STORE_LOCATION` — ruta o URL del almacén (p. ej. `/run/secrets` para Docker secrets, `s3://bucket/secrets` futuro)
- `BIND_ADDRESS` — IP/puerto del API (default `0.0.0.0:8080`)
- `JWT_SIGNING_KEY_REF` — referencia opaca al secret que firma JWTs (p. ej. `file:jwt_secret.txt` o `env:JWT_SECRET`)

**Entrega:** Variables de entorno (o fichero 0600 si se adopta `SECRET_STORE_TYPE=file`). NO en BD.

**Verificación:** Test de bootstrap sin acceso a BD (conecta solo para versionado de schema, nada más).

### 1.2 RUNTIME CONFIG

**Configurable tras bootstrap, persiste en BD.** Cambios se reflejan sin reinicio (donde sea posible).

**Tabla `system_config`:**
```sql
CREATE TABLE system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  value_type text NOT NULL, -- 'string' | 'int' | 'boolean' | 'json'
  is_secret boolean NOT NULL DEFAULT false,
  configured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Keys de configuración:**
| Key | Type | Ejemplo | Requiere reinicio |
|---|---|---|---|
| `installation_name` | string | "S9 AI Arena - Torneo Nov" | NO |
| `public_url` | string | "https://s9arena.seccionnueve.duckdns.org" | NO (usado en links, no en boot) |
| `timezone` | string | "Europe/Madrid" | NO |
| `storage.maps.target` | string (ref opaca) | "volume:arena_maps" | SÍ (requiere remount) |
| `storage.assets.target` | string | "volume:arena_assets" | SÍ |
| `storage.bot_sources.target` | string | "volume:arena_bot_sources" | SÍ |
| `storage.build_cache.target` | string | "volume:arena_build_cache" | SÍ |
| `storage.replays.target` | string | "volume:arena_replays" | SÍ |
| `storage.logs.target` | string | "volume:arena_logs" | SÍ |
| `backup.primary_repository` | string (ref opaca) | "repo:s9-arena-primary" | NO (pero requiere credenciales) |
| `backup.retention.hourly` | int | 48 | NO (aplica en próximo forget) |
| `backup.retention.daily` | int | 14 | NO |
| `backup.retention.weekly` | int | 8 | NO |
| `backup.retention.monthly` | int | 12 | NO |
| `backup.schedule` | string (cron) | "15 4 * * *" | NO |
| `capability.real_battle_runs` | boolean | true | **SÍ** (mapped a env var al boot) |
| `capability.public_spectate` | boolean | false | **SÍ** |
| `capability.metrics` | boolean | true | **SÍ** |
| `capability.public_replays` | boolean | false | **SÍ** |

**No se expone ni edita vía API NUNCA.** Solo vía UI admin con roles:admin.

### 1.3 SECRETS

**Jamás en `system_config`.** Referencias opacas a un almacén externo.

**Tabla `system_secrets`:**
```sql
CREATE TABLE system_secrets (
  name text PRIMARY KEY,
  secret_type text NOT NULL, -- 'password' | 'key' | 'certificate' | 'token'
  last_rotated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  configured_at timestamptz NOT NULL DEFAULT now()
);
```

**API NUNCA devuelve el valor.** Solo devuelve `{ name, secret_type, last_rotated_at, configured: true }`.

**Almacenamiento:** Docker secrets, env vars, o future Vault (no en BD).

**Keys secretos:**
- `jwt_secret` — firma de JWTs
- `arena_engine_internal_secret` — token Arena Engine ↔ API
- `replay_ingest_secret` — token Replay-Service ingesta
- `artifact_signing_key` — clave privada ed25519 para firmar bots
- `postgres_password` — contraseña de BD (solo de lectura para app)
- `restic_password` — contraseña/key del repo Restic

### 1.4 DETECTED CAPABILITIES

**Resuelto al boot + re-escaneable sin reinicio.** El sistema descubre qué CAN hacer.

**Tabla `system_detected_capabilities`:**
```sql
CREATE TABLE system_detected_capabilities (
  name text PRIMARY KEY, -- 'docker_available' | 'backup_repo_reachable' | 'maps_writable' | ...
  detected boolean NOT NULL,
  last_check_at timestamptz NOT NULL DEFAULT now(),
  check_output text -- diagnóstico si detected=false
);
```

**Cheques (sin riesgo de datos):**
- `docker_available`: ¿Hay socket en `/var/run/docker.sock`?
- `backup_repo_reachable`: ¿`restic -r $REPO cat config` responde?
- `maps_writable`: ¿Escribo un fichero de prueba en `/data/maps/.healthz`?
- `replays_writable`: ¿Escribo un fichero en `/data/replays/.healthz`?
- `bot_sources_writable`: ¿Escribo un fichero en `/data/bot-sources/.healthz`?

### 1.5 DERIVED READINESS

**Estados calculados al arrancar + actualizados por healthchecks.** NO se persisten, se derivan de otros estados.

**Tabla `system_readiness_state`:**
```sql
CREATE TABLE system_readiness_state (
  check_name text PRIMARY KEY,
  -- 'PENDING' | 'COMPLETE' | 'WARNING' | 'BLOCKED'
  status text NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  diagnostic text -- "PostgreSQL respondió en 42ms" o "postgres sin responder en ::5432"
);
```

**9 Cheques independientes:**
1. **database_ready** — PostgreSQL responde, schema migrado a version 10/10
2. **storage_ready** — mapas, bots, replays, logs alcanzables (writable)
3. **runner_ready** — Docker disponible (si `real_battle_runs=enabled`)
4. **build_ready** — npm/node versión correcta, dependencias en node_modules
5. **replay_ready** — replay-service health + `/data/replays` writable
6. **backup_ready** — si enabled, repo Restic alcanzable + credenciales correctas
7. **security_ready** — secrets configurados (jwt, signing key)
8. **spectator_ready** — si `public_spectate=enabled`, validar permisos de red
9. **public_replay_ready** — si `public_replays=enabled`, replays oficiales alcanzables

**Estados agregados (entrada point del usuario):**
- `SETUP_REQUIRED` — al menos 1 check es PENDING o BLOCKED
- `READY_WITH_WARNINGS` — todos COMPLETE pero al menos 1 capability=disabled sin motivo
- `READY` — todos COMPLETE, todas las capabilities enabled alcanzan su full ready
- `BLOCKED` — al menos 1 check PERMANENTLY BLOCKED (p. ej. Docker sin permiso después de instalación)

---

## 2. Gestión de secretos

### Principios

1. **Nunca en respuestas API.** Devolver solo `{ configured: true/false, last_rotated_at, expires_at }`.
2. **Nunca en logs.** Si un secret aparece en un log, es un BUG (usar structured logging con filtros).
3. **Nunca en .env a menos que sea variable de bootstrap.** Ejemplo: `DATABASE_URL=postgresql://...` es aceptable si se Lee una sola vez al boot.
4. **Almacenamiento:** Docker secrets (`/run/secrets/*` con modo 0400) o ficheros 0600 en host (si es posible).
5. **Rotación auditada.** La tabla `system_secrets` registra CUÁNDO se rotó, no el valor.

### Manejo en la aplicación

```typescript
// ✅ Bien: leer al boot, guardar en variable privada
const jwtSecret = await secretStore.get('jwt_secret');
app.use(authMiddleware(jwtSecret));

// ❌ Mal: leer por request
app.get('/config', (req, res) => {
  const key = process.env.SOME_SECRET; // Nunca
  res.json({ secret: key }); // Nunca
});

// ✅ Bien: devolver opacidad
app.get('/config', (req, res) => {
  res.json({ 
    jwt_configured: true, 
    last_rotated: '2026-08-01T14:22:00Z' 
  });
});
```

---

## 3. Abstracción de storage

### Problema hoy

Los volúmenes son nombres literales: `arena_maps`, `arena_replays`. Si el operador quiere usar NFS en `/mnt/nas/maps` en lugar de volumen Docker, hace un fork del código.

### Solución: Storage targets

**Tabla `storage_targets`:**
```sql
CREATE TABLE storage_targets (
  id text PRIMARY KEY, -- 'arena_maps' | 'arena_replays' | ...
  storage_type text NOT NULL, -- 'docker_volume' | 'host_path' | 'nfs' | 's3'
  location text NOT NULL, -- "volume:arena_maps" o "/mnt/nas/maps" o "nfs://192.168.1.210/maps"
  access_mode text NOT NULL, -- 'rw' | 'ro'
  configured_at timestamptz NOT NULL DEFAULT now()
);
```

**En el Compose (futuro, con interpolación):**
```yaml
volumes:
  maps:
    driver: local
    driver_opts:
      type: nfs
      o: "addr=192.168.1.210,vers=4,soft,timeo=180"
      device: ":/exports/maps"
```

**Hoy:** Hardcodeado; R17 lo documenta, future slices lo abstraen.

---

## 4. Modelo de backup extensible

### Problema hoy

Un solo repositorio, hardcodeado. Si quiero un backup secundario (disaster recovery), o cambiar de proveedor, tengo que editar scripts.

### Solución: Múltiples repositorios desde el principio

**Tabla `backup_repositories`:**
```sql
CREATE TABLE backup_repositories (
  id text PRIMARY KEY, -- 'primary' | 'secondary' | 'offsite'
  repo_type text NOT NULL, -- 'restic' | 'duplicacy' | 's3' (extensible)
  url text NOT NULL, -- "s3://bucket/s9-arena" o "sftp://backup@nas/arenas9"
  credential_ref text NOT NULL, -- referencia opaca a secret store
  is_primary boolean NOT NULL DEFAULT false,
  configured_at timestamptz NOT NULL DEFAULT now()
);
```

**Tabla `backup_policies`:**
```sql
CREATE TABLE backup_policies (
  id text PRIMARY KEY, -- 'default' | 'aggressive' | 'minimal'
  repository_id text NOT NULL REFERENCES backup_repositories(id),
  retention_hourly int DEFAULT 48,
  retention_daily int DEFAULT 14,
  retention_weekly int DEFAULT 8,
  retention_monthly int DEFAULT 12,
  schedule text NOT NULL, -- cron: "15 4 * * *"
  enabled boolean NOT NULL DEFAULT true
);
```

**Tabla `backup_sources`:**
```sql
CREATE TABLE backup_sources (
  id text PRIMARY KEY, -- 'postgres' | 'replays_official' | 'bot_sources' | ...
  description text,
  source_type text NOT NULL, -- 'database' | 'directory'
  location text NOT NULL, -- "postgresql://..." o "/data/replays/official"
  include_pattern text, -- glob: "official/**" (opcional, default="*")
  policy_id text NOT NULL REFERENCES backup_policies(id)
);
```

**Comportamiento:**
- Al menos 1 repo MUST ser primary.
- Cada policy es independiente (distintos horarios, retenciones).
- El wizard permite "crear un segundo repositorio" sin migración.

---

## 5. Estados de readiness

### Modelo de máquina de estados

```
Arranque del sistema
    ↓
    setup_state = NOT_STARTED
    ↓
    [Operador abre UI panel]
    ↓
    setup_state = IN_PROGRESS
    [Cada paso: PENDING → COMPLETE | WARNING | BLOCKED]
    ↓
    Todos los pasos COMPLETE
    ↓
    setup_state = READY
    [Sistema operativo, puede aceptar tráfico]
```

**Tabla `setup_state`:**
```sql
CREATE TABLE setup_state (
  step_name text PRIMARY KEY, -- 'bootstrap' | 'database' | 'storage' | 'backup' | 'security' | ...
  status text NOT NULL, -- 'PENDING' | 'COMPLETE' | 'WARNING' | 'BLOCKED'
  completed_at timestamptz,
  diagnostic text
);
```

### Las 9 comprobaciones de readiness (detalladas)

| # | Check | Condición READY | Condición WARNING | Condición BLOCKED |
|---|---|---|---|---|
| 1 | database_ready | PostgreSQL ✓ + schema 10/10 + DB accesible | Latencia > 1s | PostgreSQL no responde en 30s |
| 2 | storage_maps | `/data/maps` writable | Disco < 100MB libre | No accesible o permisos insuficientes |
| 3 | storage_replays | `/data/replays` writable + intención confirmada | Disco < 1GB libre | No accesible o no writable |
| 4 | storage_bot_sources | `/data/bot-sources` writable | Disco < 500MB libre | No accesible |
| 5 | storage_build_cache | `/data/build-cache` writable | No persistent (contenedor efímero OK) | No writable |
| 6 | runner_ready | Docker socket ✓ + proxy alcanzable (si `real_battle_runs=enabled`) | Contenedores residuos | Socket no alcanzable o permiso denegado |
| 7 | replay_ready | replay-service `/healthz` 200 + `/data/replays` writable | Latencia > 2s | Health check falló o no writable |
| 8 | backup_ready | Si `backup_enabled=true`, repo alcanzable + `restic cat config` OK | Retry de conexión pendiente | Repo 404 o credenciales incorrectas |
| 9 | security_ready | Secretos configurados (jwt, signing_key) | Ningún aviso hoy | Secret key expirada o faltante |

**Agregación:**
- ALL COMPLETE → READY
- ALL COMPLETE + ≥1 WARNING → READY_WITH_WARNINGS
- ≥1 PENDING → SETUP_REQUIRED
- ≥1 BLOCKED → BLOCKED (solo operador puede desbloquear, manualmente)

---

## 6. Asistente de instalación (wizard)

### Flujo de usuario

```
1. INIT SCREEN
   ├─ Si setup_state=READY → "Already set up, edit via Panel"
   ├─ Si setup_state=IN_PROGRESS → "Resume from step 4/9"
   └─ Si setup_state=NOT_STARTED → "Start wizard"

2. STEP 1: Basic info
   ├─ Installation name (default: "S9 AI Arena")
   ├─ Public URL (default: detected de request header Host)
   ├─ Timezone (default: UTC)
   └─ [NEXT] → si todos valid → mark step COMPLETE

3. STEP 2: Database (si NO external DATABASE_URL)
   ├─ Host, port, user, database (defaults: localhost, 5432, arena, arena)
   ├─ [TEST CONNECTION]
   │  └─ Si falla → show diagnostic (timeout, auth, etc.)
   ├─ [RUN MIGRATIONS] → si auto-select, ejecuta `migrate up`
   └─ [NEXT]

4. STEP 3: Storage
   ├─ Para cada volumen (maps, replays, bot_sources, ...):
   │  ├─ Type: "Docker volume" / "Host path" / "NFS" (expandible)
   │  ├─ Target: autocomplete suggestions (p. ej. "arena_maps")
   │  ├─ [VERIFY] → escribe + borra fichero de prueba
   │  └─ Status: "✓ Writable, 42GB free"
   └─ [NEXT]

5. STEP 4: Backup (optional, puede saltarse)
   ├─ Enable backup? [Toggle]
   ├─ Si enabled:
   │  ├─ Repository type: "Filesystem" / "SFTP" / "S3" (dropdown)
   │  ├─ URL: "s3://bucket/path" o "/backup-2t" o "sftp://host/path"
   │  ├─ Credential: (opaco, no mostrar valores)
   │  │  ├─ [Generate] → crea secret aleatorio
   │  │  └─ [Paste] → entrada masked
   │  ├─ [TEST REPOSITORY]
   │  │  └─ Verifica: alcanzable / repositorio válido / credenciales OK
   │  ├─ [INITIALIZE] si repo EMPTY (distinción: EMPTY / VALID / UNKNOWN)
   │  └─ Retention fields (hourly, daily, weekly, monthly)
   └─ [NEXT]

6. STEP 5: Capabilities
   ├─ Real battle runs (toggle + explanation de que exige Docker)
   ├─ Public spectate (toggle + privacy implications)
   ├─ Metrics (toggle + storage implications)
   ├─ Public replays (toggle + exige replay-ready + backup policy)
   └─ [NEXT]

7. STEP 6: Preflight checks (read-only)
   ├─ Tabla: cada uno de los 9 cheques
   ├─ Status: "COMPLETE ✓" | "WARNING ⚠" | "BLOCKED ✗"
   ├─ Diagnostic: "PostgreSQL respondió en 34ms"
   ├─ Si alguno BLOCKED: "Fix required before continuing"
   │  └─ [Fix wizard] → lleva a subwizard de diagnóstico
   └─ Si todos OK: [FINISH]

8. COMPLETION SCREEN
   ├─ setup_state = READY
   ├─ "Installation complete. System is ready."
   ├─ [View dashboard] → redirige a admin panel
   └─ [Review config] → panel read-only de toda la configuración
```

### Propiedades del wizard

- **Abandonable:** Cada paso es independiente. Si cierro sesión en step 3, puedo reanudar en step 3.
- **Reversible:** Puedo volver a un paso anterior y cambiar (solo si no afecta pasos posteriores).
- **Fail-closed:** Si un test falla, [NEXT] deshabilitado. Debo [FIX] primero.
- **Sin hardcodeos:** El wizard NO menciona `/data`, `arena_maps`, `backup-2t`, IPs específicas de VM108 en el UI copy. Usa términos genéricos: "Storage location", "Backup repository", "Replica service".

---

## 7. Contratos de API

### Nuevos endpoints (todos admin-only, roles:admin)

#### Sistema

```
GET /api/v1/system/setup-state
Respuesta:
{
  "setup_state": "IN_PROGRESS" | "READY" | "BLOCKED",
  "steps": [
    { "name": "bootstrap", "status": "COMPLETE", "completed_at": "2026-08-09T14:22:00Z" },
    { "name": "database", "status": "COMPLETE", "diagnostic": "PostgreSQL 14.2, schema v10" },
    { "name": "storage", "status": "WARNING", "diagnostic": "replays disk <1GB free" },
    ...
  ]
}

GET /api/v1/system/readiness
Respuesta:
{
  "aggregate": "READY",
  "checks": [
    { "name": "database_ready", "status": "COMPLETE", "diagnostic": "PostgreSQL respondió en 34ms" },
    { "name": "storage_ready", "status": "COMPLETE", "diagnostic": "All volumes writable" },
    ...
  ],
  "capabilities_available": {
    "real_battle_runs": true,  // Backend can run real battles if enabled
    "public_spectate": true,   // Backend public spectate available
    "metrics": true,
    "public_replays": true
  }
}

POST /api/v1/system/setup/verify-storage
Body: { "target": "arena_maps" }
Respuesta: { "writable": true, "disk_free_mb": 42000, "diagnostic": "OK" }

POST /api/v1/system/setup/test-backup-repo
Body: { "repo_url": "s3://bucket/path", "credential_ref": "..." }
Respuesta: { "reachable": true, "valid_repo": true, "diagnostic": "OK", "last_snapshot": "2026-08-08T23:14:00Z" }

POST /api/v1/system/setup/initialize-backup-repo
Body: { "repo_url": "...", "credential_ref": "...", "allow_reinit": false }
Respuesta: { "status": "initialized", "first_backup_scheduled": "2026-08-09T04:15:00Z" }

POST /api/v1/system/setup/mark-step-complete
Body: { "step_name": "storage" }
Respuesta: { "step_name": "storage", "status": "COMPLETE", "completed_at": "..." }
```

#### Configuración (read-only en esta versión)

```
GET /api/v1/system/config
Respuesta: (todos los valores no-secretos, refs opacas para secrets)
{
  "installation_name": "S9 AI Arena",
  "public_url": "https://s9arena.seccionnueve.duckdns.org",
  "timezone": "Europe/Madrid",
  "capabilities": {
    "real_battle_runs": { "enabled": false, "reason_if_disabled": "not_configured" },
    "public_spectate": { "enabled": true },
    "metrics": { "enabled": true },
    "public_replays": { "enabled": false, "reason_if_disabled": "no_backup" }
  },
  "backup": {
    "enabled": false,
    "primary_repo": null,
    "last_backup": null,
    "next_backup": null
  }
}

GET /api/v1/system/secrets
Respuesta: (NUNCA valores, NUNCA)
{
  "jwt_secret": { "configured": true, "last_rotated_at": "2026-08-01T14:22:00Z" },
  "signing_key": { "configured": true, "last_rotated_at": "2026-07-15T10:00:00Z" },
  "restic_password": { "configured": false, "reason": "no backup configured" }
}
```

---

## 8. Modelo de BD

### Tablas nuevas (esquema v11+)

```sql
-- Configuración del sistema (no secretos)
CREATE TABLE system_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  value_type text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Referencias a secretos (no los valores)
CREATE TABLE system_secrets (
  name text PRIMARY KEY,
  secret_type text NOT NULL,
  last_rotated_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

-- Estado del setup (wizard)
CREATE TABLE setup_state (
  step_name text PRIMARY KEY,
  status text NOT NULL,
  completed_at timestamptz,
  diagnostic text
);

-- Readiness checks
CREATE TABLE system_readiness_state (
  check_name text PRIMARY KEY,
  status text NOT NULL,
  last_checked_at timestamptz DEFAULT now(),
  diagnostic text
);

-- Repos de backup (1..N)
CREATE TABLE backup_repositories (
  id text PRIMARY KEY,
  repo_type text NOT NULL,
  url text NOT NULL,
  credential_ref text NOT NULL,
  is_primary boolean DEFAULT false,
  configured_at timestamptz DEFAULT now()
);

-- Políticas de retención (1..N por repo)
CREATE TABLE backup_policies (
  id text PRIMARY KEY,
  repository_id text NOT NULL REFERENCES backup_repositories(id),
  retention_hourly int,
  retention_daily int,
  retention_weekly int,
  retention_monthly int,
  schedule text NOT NULL,
  enabled boolean DEFAULT true
);

-- Fuentes de backup (qué se copia)
CREATE TABLE backup_sources (
  id text PRIMARY KEY,
  description text,
  source_type text NOT NULL,
  location text NOT NULL,
  include_pattern text,
  policy_id text NOT NULL REFERENCES backup_policies(id)
);

-- Targets de almacenamiento (abstracción de volúmenes)
CREATE TABLE storage_targets (
  id text PRIMARY KEY,
  storage_type text NOT NULL,
  location text NOT NULL,
  access_mode text NOT NULL DEFAULT 'rw',
  configured_at timestamptz DEFAULT now()
);

-- Detected capabilities (qué CAN el sistema hacer)
CREATE TABLE system_detected_capabilities (
  name text PRIMARY KEY,
  detected boolean NOT NULL,
  last_check_at timestamptz DEFAULT now(),
  check_output text
);
```

---

## 9. Seguridad

### Principios

1. **Endpoints de setup admin-only.** `x-min-role: admin` en OpenAPI.
2. **Secrets en HTTP request** → HTTPS mandatory. Content-Security-Policy: no inline scripts.
3. **Rate-limit en setup endpoints.** POST /setup/* máx 10/min (no DDoS de repositorio).
4. **Audit trail.** Cada operación setup se registra en `audit_logs` (user_id, action, timestamp, resource, old_value, new_value — pero new_value=`***` si es secret).
5. **Verificación de integridad de replays.** Test repository debe validar que el snapshot existe y contiene al menos (PostgreSQL dump + manifest.sha256).

### Casos de amenaza cubiertos

| Amenaza | Mitigación |
|---|---|
| Operador pasando creds por CLI visible | Wizard UI masked inputs, no env vars públicas |
| Backup sin verificar credenciales | Test repository antes de inicializar |
| Cambio de capabilities sin impacto | PENDING check ≠ COMPLETE ⇒ capability locked |
| Repo 404 después de setup pero antes de uso | Readiness check regular detects y reporta |
| Replay-service crash pero healthz OK | Readiness check toca `/data/replays`, no solo HTTP |

---

## 10. Estrategia de migración

### Fase 1: No-op (cambios solo de esquema)

M011 crea las tablas nuevas VACÍAS. Ninguna lógica cambia. El sistema sigue funcionando hoy.

### Fase 2: Lectura en startup (lazy eval de env)

El API lee `infrastructure/.env`, mapea a `system_config` para audit/visibilidad. La lógica sigue tomando decisiones de env vars (backward compatible).

### Fase 3: Adopción gradual

Admin puede usar el panel para editar valores (sin reinicio, donde aplicable). El env vars sigue siendo source-of-truth.

### Fase 4: Cutover (cuando sea seguro)

Cambiar source-of-truth: BD → env vars (reversible con `--use-env-override`).

---

## 11. Modos de fallo

### Fallo 1: RESTIC_REPOSITORY vacío

**Síntoma:** `backup_ready = BLOCKED`, mensajes de error en `/healthz` de backup.

**Recuperación:** Admin abre wizard, step 4, configura repository, [INITIALIZE].

### Fallo 2: PostgreSQL sin migrar

**Síntoma:** `database_ready = BLOCKED`, API no arranca o falla en primeira query.

**Recuperación:** Wizard step 2 ofrece [RUN MIGRATIONS] → ejecuta `migrate up`.

### Fallo 3: `/data/replays` sin escribir

**Síntoma:** `replay_ready = BLOCKED`, batallas se lanzan pero no se ingestaría replay.

**Recuperación:** Wizard step 3 verifica permisos, ofrece [VERIFY] + diagnostic (uid mismatch, filesystem read-only, etc.).

### Fallo 4: Capability enabled pero depended check BLOCKED

Ejemplo: `public_replays=true` pero `backup_ready=BLOCKED`.

**Síntoma:** Endpoint GET /public/replays 503 "dependency_not_ready".

**Recuperación:** Readiness check muestra que public_replays depende de backup → admin fija backup → re-check.

---

## 12. Tests

### Test de conformance R17

```bash
# Conformance: el sistema siempre tiene un estado readiness válido
GET /system/readiness → { aggregate: "SETUP_REQUIRED" | "READY_WITH_WARNINGS" | "READY" | "BLOCKED" }
# ∀ estado, ∃ recuperación (no hay "stuck" permanente)

# Conformance: setup siempre es resumible
POST /system/setup/mark-step-complete (step=1)
# ... cerrar sesión ...
GET /system/setup-state → step=1 COMPLETE, step=2 PENDING
# ... reabrir ...
POST /system/setup/mark-step-complete (step=2)
# Resultado: paso 1 aún COMPLETE, paso 2 ahora COMPLETE
```

### Test de seguridad

```bash
# Secrets jamás en respuesta
GET /system/config | grep -i secret → 0 matches
GET /system/secrets | jq '.*.value' → null (nunca se expone)

# Rate-limit en setup
for i in {1..15}; do
  POST /system/setup/verify-storage
done
# Resultado: primeras 10 OK, 11-15 reciben 429 Too Many Requests
```

### Test de readiness

```bash
# Si storage=BLOCKED, capabilities depended=disabled
mkdir -p /tmp/broken
chmod 000 /tmp/broken  # sin permisos
# Remapear storage target a /tmp/broken
GET /system/readiness
# storage_ready=BLOCKED
GET /system/config → public_replays=disabled, reason="storage_not_ready"
# Resultado: no es BLOCKED global, pero capability está locked
```

---

## 13. Plan de despliegue: Slices R17.0 - R17.6

### R17.0: Modelo de configuración + Motor de readiness

**Scope:** Tablas BD + CLI de readiness check.

**Archivos:**
```
apps/api/src/db/migrations/m011_system_config.ts
apps/api/src/system/config.ts (ConfigService)
apps/api/src/system/readiness.ts (ReadinessEngine)
apps/api/src/routes/system-setup.ts (GET /system/setup-state, GET /system/readiness)
```

**Propietario:** (asignar)  
**Duración:** 1-2 días  
**Bloquea:** Todos los otros slices  
**Gate:** CI verde + 15 tests de readiness + CLI verificable sin API

---

### R17.1: Shell del wizard + Estado de setup

**Scope:** UI wizard (React), estados de setup, validación cliente.

**Archivos:**
```
apps/web/src/pages/SetupWizard.tsx
apps/web/src/routes/(admin)-setup.tsx
apps/web/src/hooks/useSetupState.ts
apps/api/src/routes/system-setup.ts (PUT /system/setup/step/:name, POST .../mark-complete)
```

**Propietario:** (asignar)  
**Duración:** 2 días  
**Bloquea:** R17.2, R17.3, R17.4  
**Gate:** Wizard navega 6/7 steps, estado persiste y reanuda

---

### R17.2: Abstracción de storage

**Scope:** Storage_targets table, verificación de writability, tests de volumen.

**Archivos:**
```
apps/api/src/system/storage.ts (StorageVerifier)
apps/api/src/routes/system-setup.ts (POST .../verify-storage)
infrastructure/tests/storage-targets.test.ts
```

**Propietario:** (asignar)  
**Duración:** 1 día  
**Bloquea:** Nada  
**Gate:** Todos los targets (maps, replays, etc.) verificables; tests en Linux + Docker

---

### R17.3: Administración de backup

**Scope:** Backup_repositories, backup_policies, test-repo, initialize-repo.

**Archivos:**
```
apps/api/src/system/backup.ts (BackupAdmin)
apps/api/src/routes/system-setup.ts (POST .../test-backup-repo, POST .../initialize-backup-repo)
infrastructure/backup/restic-admin.sh (helper de CLI)
infrastructure/tests/backup-admin.test.ts
```

**Propietario:** (asignar)  
**Duración:** 2 días  
**Bloquea:** Nada (puede ser paralelo a R17.2)  
**Gate:** Test repo (Restic local), initialize repo (Restic real si creds), CI sin Docker

---

### R17.4: Puertas de capabilities

**Scope:** Gating de capabilities por readiness checks. Si `real_battle_runs=enabled` pero `runner_ready=BLOCKED`, responder 503.

**Archivos:**
```
apps/api/src/system/capabilities-gate.ts
apps/api/src/routes/battles.ts (middleware de gate en POST /battles/:id/run)
```

**Propietario:** (asignar)  
**Duración:** 1 día  
**Bloquea:** Nada  
**Gate:** Cuando runner BLOCKED, battle-run responde 503 + diagnostic

---

### R17.5: Seguridad + diagnóstico + preflight

**Scope:** Rate-limits en setup endpoints, audit trail, secretes masked en logs, endpoints HTTPS-only.

**Archivos:**
```
apps/api/src/middleware/setup-rate-limit.ts
apps/api/src/audit/audit-trail.ts (log setup operations)
infrastructure/nginx/setup-https-only.conf
```

**Propietario:** (asignar)  
**Duración:** 1 día  
**Bloquea:** Nada  
**Gate:** CI lint (no secrets en logs), rate-limit test 10/min

---

### R17.6: Reconfiguración + upgrade

**Scope:** Cambiar capabilities en runtime (sin reinicio para no-exigentes). Rollback de migraciones si es necesario.

**Archivos:**
```
apps/api/src/system/reconfig.ts (RuntimeReconfigurer)
apps/api/src/routes/system-admin.ts (POST /system/capabilities/:name)
```

**Propietario:** (asignar)  
**Duración:** 2 días  
**Bloquea:** Nada  
**Gate:** Cambiar `installation_name` sin reinicio, verificar persiste; cambiar `metrics=true/false` sin reinicio, verificar /metrics existe/no existe

---

## Matriz de propietarios por fichero (paralelo sin colisiones)

| Fichero/módulo | R17.0 | R17.1 | R17.2 | R17.3 | R17.4 | R17.5 | R17.6 |
|---|---|---|---|---|---|---|---|
| `apps/api/src/db/migrations/m011_*.ts` | **O** | R | — | — | — | — | — |
| `apps/api/src/system/config.ts` | **O** | — | — | — | — | — | R |
| `apps/api/src/system/readiness.ts` | **O** | R | R | R | R | R | — |
| `apps/api/src/system/storage.ts` | — | — | **O** | — | — | — | — |
| `apps/api/src/system/backup.ts` | — | — | — | **O** | — | R | — |
| `apps/api/src/system/capabilities-gate.ts` | — | — | — | — | **O** | — | R |
| `apps/api/src/routes/system-setup.ts` | O | **O** | R | R | — | R | — |
| `apps/web/src/pages/SetupWizard.tsx` | — | **O** | — | — | — | — | — |
| `infrastructure/backup/restic-admin.sh` | — | — | — | **O** | — | — | R |
| `infrastructure/tests/*` | O | R | **O** | **O** | — | **O** | — |

Leyenda: **O** = Propietario principal, R = Revisor/dependencia

---

## Conclusiones

1. **Arquitectura modular:** Cada slice es independiente en código, pero todos dependen de R17.0.
2. **Garantías:**
   - Secrets jamás en BD ni API.
   - Configuración versionada en BD (audit trail).
   - Readiness verificable sin acceso shell.
   - Setup abandonable y reanudable.
3. **No es infra como código todavía**, pero sienta las bases (S3, Vault, NFS quedan como implementación futura de storage_targets y backup_repositories).
4. **Regla de oro:** La UI NUNCA menciona names específicos de VM108 (backup-2t, arena_maps, 192.168.1.205). Todo es "Storage location", "Repository URL", "Service target" — el operador proporciona el detalle.

---

**Versión:** 0.1 (propuesta)  
**Revisor:** (pendiente)  
**Fecha de documento:** 2026-08-09
