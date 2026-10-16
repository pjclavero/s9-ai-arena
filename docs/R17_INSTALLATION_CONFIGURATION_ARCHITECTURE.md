# R17 – Arquitectura de instalación y configuración

**Propuesta de arquitectura:** modelo extensible de configuración, secretos, readiness, wizard de setup, backup y capabilities para S9 AI Arena en entornos de producción.

---

## 1. Objetivos (Goals)

1. **Honestidad de readiness:** distinción clara entre "el servicio está vivo" y "el servicio está funcional"; no repetir el incidente del volumen vacío que pasó "healthy" diez días.
2. **Reconfiguración sin reinicio:** cambiar muchos parámetros (direcciones, repositorios, retención) sin reiniciar contenedores.
3. **Wizard interactivo:** guía de configuración inicial que camine al operador a través de:
   - Identidad del stack (dominio, puertos).
   - Autenticación en repositorio de backup.
   - Validación de volúmenes.
   - Habilitar capabilities progresivamente (batallas reales, espectador público, etc.).
4. **Gestión multi-repositorio:** desde el diseño, soportar N repositorios de backup (aunque Slice-0 implemente uno activo).
5. **Seguridad:** secretos **nunca** en BD normal, nunca en API, nunca en logs. La UI solo ve `configured: true/false` y `last_updated`.
6. **Migración limpia:** permitir que instalaciones actuales (v2 o v3 del stack) adopten R17 sin pérdida de datos.

---

## 2. No-Goals

- **Cambio de capabilities sin reinicio:** S9_ENABLE_REAL_BATTLE_RUNS, S9_PUBLIC_SPECTATE_ENABLED, etc. siguen siendo decisiones del operador en boot.
- **UI de edición de ficheros .env:** la UI no edita infrastructure/.env directamente.
- **Soporte de secretos rotativos sin reaprovisionamiento:** cambiar un secreto requiere reproducir el archivo en `infrastructure/secrets/` y reiniciar el servicio dependiente.
- **Auditoría de cambios por operación:** la auditoría de configuración es un log por lotes (cuándo se cambió qué BD, backup, etc.), no operación por operación.

---

## 3. Taxonomía de configuración: cinco clases

### 3.1 BOOTSTRAP CONFIG

Cargada **UNA SOLA VEZ** al arrancar la API, derivada de variables de entorno (`infrastructure/.env`). Cambiarla requiere **reinicio**.

```typescript
interface BootstrapConfig {
  nodeEnv: "development" | "production";
  port: number;
  databaseUrl: string;  // PostgreSQL URI
  corsOrigin: string;
  trustProxyHops: number;
  logLevel: string;
}
```

**Archivo de verdad:** `infrastructure/.env` (cargado por Compose en tiempo de contenedor).

### 3.2 RUNTIME CONFIG

Vive en tabla BD `system_config` (nueva), reutilizable sin reinicio. Operador la cambia vía wizard o API privada admin-only.

```typescript
interface RuntimeConfig {
  s9_domain: string;
  http_port: number;
  https_port: number;
  gateway_conf: "nginx.conf" | "nginx-behind-proxy.conf";
  replay_retention_days: number;
  alert_webhook_url?: string;
  alert_email?: string;
  // Campos derived (no se escriben directamente, se derivan de backup_repositories):
  backup_active_repository_id?: uuid;
}
```

**Almacenamiento:** tabla `system_config (key, value, updated_at, updated_by)`.

**Sin UI de edición directa:** la UI no edita estas filas. Solo el wizard (setup_state PENDING → COMPLETE) o scripts administrativos.

### 3.3 SECRETS

Viven **fuera de BD**, en `infrastructure/secrets/` o `$SECRETS_MOUNT` (mount point del volumen). Nunca se retornan por API, nunca se loguean.

```typescript
interface Secrets {
  postgres_password: string;       // archivo
  jwt_secret: string;              // archivo
  artifact_signing_key: string;    // PEM ed25519
  restic_password: string;         // archivo por repo
  stream_key?: string;             // opcional, YouTube
}
```

**Acceso desde BD:** la tabla `backup_repositories` tiene un campo `secret_reference: string` (ej. `vault://restic-prod`) que apunta a un secret sin exponerlo. En ejecución, el código busca el secret por referencia, no por el valor en BD.

### 3.4 DETECTED CAPABILITIES

Resueltas **en boot** y reutilizables como flags de read-only en BD. Ejemplo:

```typescript
interface DetectedCapabilities {
  realBattleRunsEnabled: boolean;       // S9_ENABLE_REAL_BATTLE_RUNS
  publicSpectateEnabled: boolean;       // S9_PUBLIC_SPECTATE_ENABLED
  publicReplaysEnabled: boolean;        // S9_PUBLIC_REPLAYS_ENABLED
  metricsEnabled: boolean;              // S9_METRICS_ENABLED
}
```

Guardadas en tabla `capability_config (capability, enabled, detected, last_check, last_error)` UNA SOLA VEZ en setup.

**Cambiar capability = reinicio + nueva línea en BD** (auditoria).

### 3.5 DERIVED READINESS

Calculadas **en runtime** combinando estados de readiness checks independientes. Se almacenan en tabla `readiness_checks (check_name, status, last_updated, reason)`.

---

## 4. Modelo de BD: tablas nuevas

Agregadas al esquema (T7.1) para R17:

### 4.1 system_config

```sql
CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (key IN ('s9_domain', 'http_port', 'https_port', 'gateway_conf', ...))
);
```

Datos iniciales:
- `s9_domain` → `<insert from S9_DOMAIN env>`
- `http_port` → `<insert from HTTP_PORT env>`
- etc.

### 4.2 backup_repositories

```sql
CREATE TABLE backup_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) <= 128),
  repo_type ENUM ('local', 'sftp', 's3', 'azure', 'rclone') NOT NULL,
  location TEXT NOT NULL,  -- ruta, URI SFTP, etc. (NUNCA credencial aquí)
  secret_reference TEXT,   -- "vault://restic-prod", "file://secrets/restic-s3.txt"
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tested_at TIMESTAMPTZ,
  test_result TEXT,  -- "OK", "unreachable", "permission_denied", "invalid_repository"
  CONSTRAINT only_one_active CHECK (
    -- En Slice-0 solo uno activo; R17.3 relaja esto
    NOT (SELECT count(*) FROM backup_repositories WHERE is_active) > 1
  )
);
```

### 4.3 backup_policies

```sql
CREATE TABLE backup_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES backup_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hourly_keep INT DEFAULT 0,
  daily_keep INT DEFAULT 14,
  weekly_keep INT DEFAULT 8,
  monthly_keep INT DEFAULT 12,
  yearly_keep INT DEFAULT 0,
  snapshot_ttl_days INT DEFAULT 180,  -- edad máxima de snapshot
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Inicialización: `(repository_id, 14, 8, 12, 0, 180)` por cada repositorio creado.

### 4.4 backup_sources

```sql
CREATE TABLE backup_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES backup_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,  -- "database", "maps", "replays", "assets", "secrets"
  source_type ENUM ('database', 'volume', 'directory') NOT NULL,
  include_path TEXT NOT NULL,  -- "/data/maps", tabla "public.*", etc.
  exclude_pattern TEXT,  -- "**/node_modules", opcional
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Inicialización (Slice-0):
- `(repo, "database", "database", "public.*")`
- `(repo, "maps", "volume", "/data/maps")`
- `(repo, "replays_official", "volume", "/data/replays/official")`
- `(repo, "secrets", "directory", "/secrets")`
- `(repo, "bot_sources", "volume", "/data/bot-sources")` [opcional]

### 4.5 capability_config

```sql
CREATE TABLE capability_config (
  capability TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  detected BOOLEAN NOT NULL DEFAULT FALSE,  -- si la infraestructura lo soporta
  last_check TIMESTAMPTZ,
  last_error TEXT,
  CHECK (capability IN (
    'S9_ENABLE_REAL_BATTLE_RUNS',
    'S9_PUBLIC_SPECTATE_ENABLED',
    'S9_PUBLIC_REPLAYS_ENABLED',
    'S9_METRICS_ENABLED'
  ))
);
```

Inicialización (en bootstrap):
```sql
INSERT INTO capability_config VALUES
  ('S9_ENABLE_REAL_BATTLE_RUNS', (S9_ENABLE_REAL_BATTLE_RUNS = '1'), runner_detected(), now(), null),
  ...
```

### 4.6 readiness_checks

```sql
CREATE TABLE readiness_checks (
  check_name TEXT PRIMARY KEY,
  status ENUM ('UNKNOWN', 'PASS', 'WARN', 'FAIL') NOT NULL DEFAULT 'UNKNOWN',
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,  -- "BD alcanzable", "volumen no escribible: permission denied", etc.
  CHECK (check_name IN (
    'database', 'storage_maps', 'storage_replays', 'storage_bot_sources', 'storage_assets',
    'runner', 'build', 'replay', 'backup', 'security', 'spectator', 'public_replay'
  ))
);
```

### 4.7 setup_state

```sql
CREATE TABLE setup_state (
  id INT PRIMARY KEY DEFAULT 1,  -- singleton
  status ENUM ('NOT_STARTED', 'IN_PROGRESS', 'READY') NOT NULL DEFAULT 'NOT_STARTED',
  current_step TEXT,  -- "identity", "backup_repo", "capabilities", "done"
  step_status ENUM ('PENDING', 'COMPLETE', 'WARNING', 'BLOCKED') NOT NULL DEFAULT 'PENDING',
  step_data JSONB,  -- {"domain": "...", "domain_verified": true, ...}
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT
);
```

---

## 5. Gestión de secretos

### 5.1 Segregación

**En entorno de bootstrap:**
```bash
# infrastructure/secrets/ — cada archivo = un secreto
cat secrets/postgres_password.txt   # nunca en BD
cat secrets/jwt_secret.txt
cat secrets/artifact_signing_key.pem
```

**En BD:** solo **referencias** a secretos, no valores:
```sql
INSERT INTO backup_repositories VALUES
  (..., secret_reference => 'file://secrets/restic-prod.txt');
```

**En código:** lookup por referencia:
```typescript
async function resolveSecret(ref: string): Promise<string> {
  if (ref.startsWith("file://")) {
    const path = ref.slice(7);
    return fs.readFileSync(`/secrets/${path}`, 'utf8').trim();
  }
  if (ref.startsWith("vault://")) {
    // Futuro: integración con HashiCorp Vault
    throw new Error("Vault no soportado en Slice-0");
  }
  throw new Error(`Secret reference no válida: ${ref}`);
}
```

### 5.2 Rotación

Cambiar `secrets/restic-prod.txt`:
1. Operador edita el archivo.
2. Reinicia el contenedor backup (nuevo contenedor monta el nuevo secret).
3. No hay cambio en BD.

Cambiar `restic_password` de un repositorio específico:
1. Operador crea `secrets/restic-repo2.txt`.
2. API privada actualiza `backup_repositories.secret_reference` a `file://secrets/restic-repo2.txt`.
3. Próximo backup usa la nueva contraseña.

---

## 6. Modelo de readiness honesto

### 6.1 Definición de cada check

| Check | Condiciones PASS | Condiciones WARN | Condiciones FAIL |
|---|---|---|---|
| **database** | PostgreSQL responde + esquemas aplicadas + tablas críticas (users, roles, battles) existen | N/A | PostgreSQL no responde OR esquema incompleto |
| **storage_maps** | `/data/maps` es directorio + escribible (probe de escritura) | Vacío (esto es OK, mapas sin cargar todavía) | No es directorio OR no escribible (EACCES) |
| **storage_replays** | `/data/replays` es directorio + escribible | Vacío O no tiene `official/` subdirectorio (crear automáticamente) | No escribible |
| **storage_bot_sources** | `/data/bot-sources` es directorio + escribible | Vacío | No escribible |
| **storage_assets** | `/data/assets` es directorio + escribible | Vacío | No escribible |
| **runner** | arena-engine responde a GET /healthz + devuelve 200 | Lentitud (timeout > 2s) | No alcanzable OR status != 200 |
| **build** | bot-manager alcanzable + secreto `artifact_signing_key` presente en `/run/secrets/` | N/A | No alcanzable OR secreto falta |
| **replay** | replay-service alcanzable + `/data/replays` escribible | N/A | No alcanzable OR volumen no escribible |
| **backup** | `backup_repositories.is_active` hay uno + es alcanzable + credenciales válidas (test de `restic snapshots`) | Repo alcanzable pero sin snapshots recientes (> 48h) | No alcanzable OR credenciales inválidas OR contenido no reconocible |
| **security** | `jwt_secret` + `artifact_signing_key` + `postgres_password` presentes en `/run/secrets/` | N/A | Algún secreto falta |
| **spectator** | database PASS + runner PASS + (S9_PUBLIC_SPECTATE_ENABLED=1 OR skip) | N/A | database/runner en FAIL |
| **public_replay** | replay PASS + database PASS + (S9_PUBLIC_REPLAYS_ENABLED=1 OR skip) | N/A | replay/database en FAIL |

### 6.2 Niveles de protección de datos

**UNPROTECTED** (nivel 0)
- BD viva pero sin backup verificable.
- Riesgo: pérdida total si fallo de almacenamiento.
- Condición: `backup readiness != PASS`.

**BACKED_UP** (nivel 1)
- Snapshot restic verificable del repositorio activo existe.
- Incluye BD y todos los volúmenes especificados en `backup_sources`.
- Snapshot creado dentro de política de edad (ej., < 48h).
- Condición: `backup readiness = PASS AND last_successful_backup <= 48h`.

**RECOVERY_VERIFIED** (nivel 2)
- Simulacro de restauración real completado satisfactoriamente.
- Se extrae BD, volúmenes a directorio temporal y se valida integridad.
- No se escriben datos reales (dry-run).
- Condición: simulacro reciente (< 7 días) sin errores. [**R17.5+**]

### 6.3 Estados agregados

| Estado | Condición |
|---|---|
| `SETUP_REQUIRED` | database FAIL OR (storage_replays/maps/bot_sources/assets) FAIL |
| `READY_WITH_WARNINGS` | (database+storage) PASS BUT (backup WARN OR runner lento OR ...) |
| `READY` | database+storage PASS AND (backup PASS OR no ha hecho primer backup aún pero > 6h y sin error) |
| `BLOCKED` | readiness critical detecta fallo que bloquea ejecución (ej., volumen sin permiso) |

**Regla inviolable:** `healthy` (proceso con PID) ≠> `ready` (datos accesibles, verificable).

---

## 7. Wizard de configuración

### 7.1 Flujo UX

**Pantalla inicial (setup.ts):**
```
┌──────────────────────────────────────────┐
│  S9 AI Arena · Configuración inicial     │
├──────────────────────────────────────────┤
│  Paso 1: Identidad del stack             │
│  Paso 2: Autenticación de backup         │
│  Paso 3: Validación de almacenamiento    │
│  Paso 4: Habilitación de capabilities    │
│  Paso 5: Resumen y aplicación            │
└──────────────────────────────────────────┘
```

### 7.2 Paso 1: Identidad

**Entradas:**
- `S9_DOMAIN` (ej. `<dominio-publico>`)
- `HTTP_PORT`, `HTTPS_PORT` (por defecto 80, 443)
- `GATEWAY_CONF` (nginx.conf OR nginx-behind-proxy.conf)

**Validaciones:**
- Dominio resuelve (DNS query).
- Puertos no están ocupados en el host.

**Almacenamiento:** `system_config` table (clave-valor).

### 7.3 Paso 2: Backup

**Entradas:**
- Tipo de repositorio (local, SFTP, S3, Azure, rclone).
- Ubicación (ruta local, URI SFTP, cubo S3, etc.).
- Credenciales (si aplica): usuario/host SFTP, access key S3, etc.

**Validación ("Test repository"):**
1. Alcanzable (red + autenticación).
2. Escribible (crear archivo temporal, eliminarlo).
3. Si existe contenido:
   - Si es repositorio restic válido → "OK, snapshots existing found".
   - Si es desconocido → RECHAZADO ("Cannot initialize over unknown content").
4. Nunca se borra, nunca se modifican datos.

**Inicialización:**
- Si vacío → `restic init --password-file /run/secrets/restic_password`.
- Si repositorio válido → skip (reutilizar).

**Almacenamiento:**
- `backup_repositories (id, name, repo_type, location, secret_reference, is_active)`.
- `backup_policies (repository_id, ...)` con defaults.
- `backup_sources (repository_id, ...)` con defaults.

### 7.4 Paso 3: Almacenamiento

**Verificación automática de volúmenes:**
1. Cada volumen (`arena_maps`, `arena_replays`, etc.) se comprueba con probe de escritura.
2. Si falla → BLOCKED (no se puede continuar).
3. Si pasa → PASS.

**Acción:**
- Crear subdirectorio `official/` en `arena_replays` si no existe.
- Establecer permisos correctos vía `infrastructure/docker/node-service/entrypoint.sh`.

### 7.5 Paso 4: Capabilities

**Interactivos:**
- `S9_ENABLE_REAL_BATTLE_RUNS` — ¿lanzar batallas reales? (requiere runner disponible).
- `S9_PUBLIC_SPECTATE_ENABLED` — ¿permitir espectador anónimo?
- `S9_PUBLIC_REPLAYS_ENABLED` — ¿permitir replays públicos?
- `S9_METRICS_ENABLED` — ¿exponer métricas Prometheus?

**Cada uno:**
- Muestra estado de readiness en tiempo real.
- Si readiness es PASS → checkbox "Habilitar".
- Si readiness es FAIL → botón "Ver detalles" (qué bloqueó).

**Cambios aplicados:**
- Escribir en `capability_config` tabla.
- **Avisar:** "Requiere reinicio de la API".

### 7.6 Paso 5: Resumen

**Resumen inmutable (JSON):**
```json
{
  "s9_domain": "<dominio-publico>",
  "http_port": 80,
  "gateway_conf": "nginx-behind-proxy.conf",
  "backup_repository": {
    "id": "...",
    "name": "NAS-ZFS",
    "type": "sftp",
    "status": "OK (3 snapshots)"
  },
  "storage_status": {
    "maps": "PASS",
    "replays": "PASS",
    "bot_sources": "PASS",
    "assets": "PASS"
  },
  "capabilities_enabled": {
    "real_battle_runs": true,
    "public_spectate": false,
    "public_replays": false,
    "metrics": true
  }
}
```

**Acción final:**
- Guardar en BD (`setup_state.status = 'READY'`).
- Logging: `audit_log` con operación "setup_completed" + usuario.
- **REINICIAR API** (para aplicar capabilities).

---

## 8. Contratos de API

### 8.1 Endpoints administrativos (R17.1+)

**GET /admin/setup**
```typescript
{
  status: "NOT_STARTED" | "IN_PROGRESS" | "READY";
  current_step: string | null;
  step_data: Record<string, any>;
  progress: { current: number; total: number };
}
```

**POST /admin/setup/step/:step** (x-min-role: admin)
```
Body: { field: value, ... }
Response: { ok: boolean; errors?: string[]; next_step?: string; }
```

**GET /admin/readiness** (x-min-role: admin)
```typescript
{
  status: "SETUP_REQUIRED" | "READY_WITH_WARNINGS" | "READY" | "BLOCKED";
  aggregated: {
    database: "PASS" | "FAIL";
    storage: "PASS" | "FAIL";
    backup: "PASS" | "WARN" | "FAIL";
    capabilities: Record<string, boolean>;
  };
  checks: Array<{
    name: string;
    status: "PASS" | "WARN" | "FAIL";
    reason?: string;
    last_updated: ISO8601;
  }>;
}
```

**POST /admin/backup/test** (x-min-role: admin)
```
Body: { repository_id: uuid; }
Response: { ok: boolean; result: string; }
```

**POST /admin/backup/initialize** (x-min-role: admin)
```
Body: { repository_id: uuid; }
Response: { ok: boolean; message: string; }
Behavior:
  - Si vacío: restic init (primera vez).
  - Si válido: skip.
  - Si contenido desconocido: error.
```

### 8.2 Campos públicos (readiness)

`GET /system/status` expone (read-only, no secrets):
```typescript
{
  databaseOk: boolean;
  storageOk: boolean;
  backupConfigured: boolean;  // NUNCA la contraseña
  backupLastSuccess?: ISO8601;  // NUNCA la ubicación en claro
  capabilities: {
    realBattleRuns: { enabled: boolean; available: boolean; };
    publicSpectate: boolean;
    publicReplays: boolean;
    metrics: boolean;
  };
  readiness: {
    database: "PASS" | "WARN" | "FAIL";
    storage: "PASS" | "WARN" | "FAIL";
    backup: "PASS" | "WARN" | "FAIL";
  };
}
```

---

## 9. Seguridad

### 9.1 Principios

1. **Secretos nunca en BD normal:** tabla `backup_repositories.secret_reference` apunta a archivo, no almacena valor.
2. **Secretos nunca en logs:** redacción de logs en todos los servicios.
3. **Secretos nunca retornados por API:** ni siquiera en endpoints admin.
4. **UI no edita variables de entorno:** el wizard escribe en BD; las capabilities de bootstrap siguen siendo solo-lectura en boot.
5. **RBAC: solo admin puede configurar:** todos los endpoints de setup/readiness requieren x-min-role: admin.

### 9.2 Auditoría

Tabla `audit_log` registra:
```sql
INSERT INTO audit_log VALUES
  (user_id, "setup_step_completed", '{"step": "backup", "status": "OK"}', now());
```

---

## 10. Modelo de fallo (failure modes)

### 10.1 Fallo de setup incompleto

**Escenario:** wizard abandona a medio paso (navegador cierra).

**Comportamiento:**
- `setup_state.status = IN_PROGRESS` persiste.
- Próxima vez que se abre `/admin/setup` → reanuda desde `current_step`.
- Datos parciales en `step_data` (JSONB) se recuperan.

### 10.2 Fallo de cambio de capabilities

**Escenario:** admin habilita `S9_ENABLE_REAL_BATTLE_RUNS=true` pero el runner no está listo.

**Comportamiento:**
- `capability_config.enabled = true` se escribe en BD.
- App avisa: "Requiere reinicio; runner_availability = false".
- POST /battles devuelve 503 `runner_unavailable` (idéntico a estado actual).
- Readiness report: "runner FAIL".

### 10.3 Backup configurado pero inaccesible

**Escenario:** RESTIC_REPOSITORY válido en setup, pero luego se desconecta la red al NAS.

**Comportamiento:**
1. Backup.sh intenta restic backup → FALLA.
2. Escribe métricas de error.
3. Próximo readiness check: backup FAIL.
4. UI avisa: "Backup BLOQUEADO hace 18 horas".
5. Sistema sigue funcionando (nivel READY_WITH_WARNINGS).

---

## 11. Testing

### 11.1 Tests de setup (R17.1)

```typescript
describe("setup wizard", () => {
  test("rejects invalid domain", async () => {
    const res = await POST("/admin/setup/step/identity", {
      s9_domain: "invalid..domain"
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContain("invalid domain");
  });

  test("test repository on empty destination", async () => {
    const res = await POST("/admin/backup/test", {
      repository_id: tmpRepoId
    });
    expect(res.ok).toBe(true);
    expect(res.result).toContain("empty target");
  });

  test("rejects initialize over unknown content", async () => {
    // copiar archivos aleatorios a destino
    const res = await POST("/admin/backup/initialize", {
      repository_id: tmpRepoId
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("unknown content");
  });

  test("readiness aggregates independent checks", async () => {
    const res = await GET("/admin/readiness");
    expect(res.status).toHaveProperty("database");
    expect(res.status).toHaveProperty("storage");
    expect(res.status).toHaveProperty("backup");
  });
});
```

---

## 12. Despliegue (deployment)

### 12.1 Instalación nueva (greenfield)

1. Operador clona el repo, copia `infrastructure/.env.example` a `infrastructure/.env`.
2. Ejecuta `docker compose --profile production up -d` (sin `RESTIC_REPOSITORY`).
3. Accede a `https://<s9_domain>/setup` (auth bypass para wizard + auditoría).
4. Completa los 5 pasos (identidad, backup, storage, capabilities, resumen).
5. Sistema reinicia la API automáticamente.
6. Accede a UI normal de la plataforma.

### 12.2 Migración desde v2 actual

1. BD existente se preserva (`arena` Postgres intacta).
2. Script de migración `infrastructure/migrations/r17_init_schema.sql` agrega:
   - Tabla `system_config` con valores derivados de `infrastructure/.env` actual.
   - Tabla `backup_repositories` (vacío, esperando configuración).
   - Tabla `capability_config` derivado de env vars actuales.
   - Tabla `readiness_checks` (todos en UNKNOWN).
   - Tabla `setup_state` con `status = IN_PROGRESS` (requiere completar wizard).
3. Operador accede a `https://<s9_domain>/setup?migrate=true` para wizard incompleto.
4. Vuelca estado actual de `infrastructure/.env` en wizard como sugerencias.

### 12.3 Reconfiguración sin downtime

Cambiar parámetro en BD (ej. `replay_retention_days`):
1. API privada actualiza `system_config (key='replay_retention_days', value='365')`.
2. Próximo backup.sh lee variable de entorno derivada de BD.
3. **Sin reinicio de contenedores.**

---

## 13. Slices de implementación

| Slice | Componentes | Gated by | Ownership |
|---|---|---|---|
| **R17.0** | Modelo de configuración + motor de readiness | Tests de readiness, sin UI | Backend |
| **R17.1** | Wizard + setup_state + DB schema | Integración E2E del wizard | Backend + Frontend |
| **R17.2** | Abstracción de storage (volúmenes virtuales) | Tests de probe de escritura | Devops + Backend |
| **R17.3** | Backup multi-repositorio + políticas extensibles | CI + tests de restore dry-run | Devops |
| **R17.4** | Puertas de capabilities + readiness honesto | Bloqueo de batalla si runner falla | Backend |
| **R17.5** | Seguridad + diagnóstico + preflight checks | Audit log completo + redacción de secrets | Backend + Devops |
| **R17.6** | Reconfiguración/upgrade sin downtime | Schema migrations + backwards compat | Backend |

**Matriz de propiedad de ficheros:**
| Path | Slice | Owner |
|---|---|---|
| `apps/api/src/routes/setup.ts` | R17.1 | Backend |
| `apps/api/src/db/migrations/r17_*.ts` | R17.0–R17.6 | Backend |
| `apps/web/src/setup/` | R17.1 | Frontend |
| `infrastructure/docker-compose.yml` | R17.2/R17.5 | Devops |
| `infrastructure/backup/backup.sh` | R17.3 | Devops |
| `packages/readiness/` | R17.0/R17.4 | Backend |

---

## 14. Honestidad del modelo: resumen final

### Antes (estado actual)

- Healthcheck: `GET /healthz → 200` → "ok" aunque BD esté caída o volumen vacío.
- Configuración: entorno + hardcoding + secretos sueltos.
- Readiness: invisible.
- Setup: copy-paste de ejemplos .env.

### Después (R17)

- Readiness: comprobación honesta de acceso a datos, volumen escribible, snapshot reciente.
- Configuración: 5 clases (bootstrap, runtime, secrets, capabilities, readiness).
- Setup: wizard interactivo con validación en tiempo real.
- Auditoría: cada cambio registrado en `audit_log`.
- Seguridad: secretos fuera de BD, nunca en logs, nunca en API.
- Fallo cerrado: si readiness crítico falla, operación correspondiente rechazada con mensaje accionable.

