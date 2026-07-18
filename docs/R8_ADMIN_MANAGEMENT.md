# R8 · Gestión/Admin ampliada (ops)

Estado del bloque **R8 — gestión/admin ampliada** sobre `main@da71bf7`
(PR #43 y **PR #44 mergeadas**; #44 arregló el runner real de VM108: seccomp
inline, red `arena`, digest vía registry local).

> Este bloque **NO** toca VM108/VM104, **NO** instala ni modifica `s9-docker-proxy`,
> **NO** toca el arnés real ni el runner, **NO** lanza contenedores, **NO** declara A
> y **NO** interfiere con el reintento operativo B+ → A. Todo lo añadido es
> **solo lectura** salvo lo que ya existía.

---

## 1. Diagnóstico (auditoría inicial)

La capa de gestión ya estaba muy avanzada. Resumen de qué existe / qué faltaba:

| Área R8 | Estado previo en `main@da71bf7` |
| --- | --- |
| R8.2 Bots/versions/builds/artifacts | **Existe**: `apps/api/src/routes/bots.ts` (`listBots/getBot/updateBot/listBotVersions/submit/publish/suspend/retire/getBuild/getBotSource`), firma+digest en `artifacts`; UI `apps/web/src/pages/BotsPage.tsx` + `LoadoutEditor`. Estados reales: `draft/validating/rejected/validated/published/frozen/suspended/retired`. |
| R8.3 Teams | **Existe**: `routes/teams.ts`, `pages/TeamsPage.tsx`. |
| R8.4 Battle draft/create | **Parcial**: `createPracticeBattle` existe en API; **no** se añade UI de creación aquí para no inducir ejecución (ver §4). |
| R8.5 Histórico + replay | **Existe**: `pages/BattlesPage.tsx` (histórico con enlaces a replay/directo), `replay_ref`, `/replays/{id}/verify`. |
| R8.6 System/ops dashboard | **Faltaba** (solo `/healthz` simple). **Añadido.** |
| R8.7 Audit log | **Backend existía** (`listAuditLog`), faltaba pantalla. **Añadida.** |
| R8.8 Runtime policies read-only | **Faltaba** vista. **Añadida** como invariantes de seguridad (read-only). |
| R8.9 Roles/permissions read-only | **Faltaba** vista; RBAC de 7 roles ya en API. **Añadida** (matriz derivada del contrato). |

No se duplican modelos, migraciones ni endpoints existentes. **No se añaden
tablas ni migraciones.**

### Qué NO se toca (pertenece a #44 / B+ → A)

`apps/bot-manager/*`, `infrastructure/*`, `scripts/e2e-real-battle-smoke.ts`,
`tests/e2e/*`, `bots/s9-smoke-bot/*`, y las variables `S9_RUN_REAL_DOCKER_E2E`,
`SMOKE_BOT_DIGEST`, `ProxyContainerRunner`, la red Docker del runner. Solo se
**leen** banderas de entorno, nunca se modifican.

---

## 2. Qué se añadió en esta rama

### Backend (2 endpoints nuevos, solo lectura, solo admin)

Contrato OpenAPI **0.2.0 → 0.3.0** (añadir endpoint = MINOR, por su propia
`docs/compatibilidad.md`). Implementados en `apps/api/src/routes/system.ts`:

| Endpoint | operationId | Rol | Descripción |
| --- | --- | --- | --- |
| `GET /system/status` | `getSystemStatus` | `admin` | Estado agregado: `env`, `commit`, `databaseOk`, `realRunnerEnabled`, `smokeDigestConfigured`, conteos por estado (batallas/builds/versiones de bot), `readyBots`, `publishedMaps`, invariantes de runtime. |
| `GET /system/rbac` | `getRbacMatrix` | `admin` | Roles con rango + matriz endpoint→rol mínimo **derivada del contrato** (sin drift, sin datos de usuarios). |

Seguridad: **nunca** se expone el valor de un secreto — de `S9_RUN_REAL_DOCKER_E2E`
y `SMOKE_BOT_DIGEST` solo se publica un booleano (verificado en test).

### Frontend (3 pantallas nuevas, solo lectura, enlaces solo-admin)

- `#/system` (`SystemPage.tsx`): dashboard de ops. Si `realRunnerEnabled` es
  `false`, banner **"Battle execution unavailable in this environment"**.
- `#/audit` (`AuditPage.tsx`): registro de auditoría (`GET /admin/audit-log`).
- `#/roles` (`RolesPage.tsx`): roles + matriz de permisos, con filtro.

Cableadas en `App.tsx` (nav solo-admin vía `isAdmin`, patrón "la UI solo oculta,
la API autoriza"). Carga con `role="alert"` + reintento; nunca "lista vacía" ante
un fallo (patrón R3.7).

---

## 3. Acciones read-only vs. desactivadas

- **Read-only**: system status, audit log, roles/permisos, runtime policies.
- **Sin acción de escritura nueva**: no se reinician servicios, no se editan
  roles, no se relaja ninguna invariante de seguridad desde la UI.
- **Bots/teams**: la gestión de escritura ya existía (crear/publicar/suspender…)
  y no se modifica.

---

## 4. Ejecución real de batallas (por qué NO hay botón Run)

`createPracticeBattle` existe, pero **encolar/ejecutar** depende del runner real
(bloque B+ → A, aún en reintento en VM108). Para no fingir éxito operativo,
**esta rama no añade un flujo de creación/ejecución de batalla**. El dashboard de
sistema informa del estado (`realRunnerEnabled`) y, cuando esté validado A, se
podrá añadir la pantalla `#/battles/new` que cree la batalla en `prepared` sin
disparar ejecución hasta que el operador lo autorice.

---

## 5. Dependencias externas

- **Ejecución real** → `s9-docker-proxy` + arnés #43/#44 + `SMOKE_BOT_DIGEST` en
  VM108. R8 no lo instala ni lo dispara.
- **Visor de replay avanzado** → R7.

---

## 6. Pendiente (fuera de esta rama)

- `#/battles/new` (crear en `prepared`, sin ejecutar) cuando A esté validada.
- Rutas de detalle dedicadas `#/bot-builds/:id`, `#/artifacts/:id` (hoy el detalle
  vive en `BotsPage`/versión; el backend no expone listas globales de builds/artifacts).
- `audit_events` genérico: no se añade porque `audit_log` ya cubre el caso y crear
  otra tabla sería duplicar.
- Auth pública completa (`player`/`viewer`), streaming, matchmaking, torneos
  complejos, ranking, balance, editor visual de mapas — explícitamente fuera de R8.

---

## 7. Validaciones ejecutadas

- `tsc --noEmit` (raíz) y `-p apps/web`: **0 errores**.
- Backend: `system.test.ts` (5), `conformance.test.ts` (contrato = 57),
  `rbac-matrix`, `public-api`, `h6-public-routes` → verdes (132 tests de `apps/api`
  pasan). 3 archivos (`e6-integration`, `r25-cola-builds`, `r25-firma-lanzamiento`)
  fallan por un problema **de entorno preexistente** (`acorn` no resoluble desde el
  `node_modules` de este entorno), reproducible en la base sin cambios de R8; no
  guardan relación con esta rama.
- Frontend: `admin-ops-pages.test.tsx` (5) + suite web completa **208/208**.
- `npm run lint` (determinismo): OK. `prettier --check` sobre lo tocado: OK.
- greps de seguridad (footprint): sin `docker.sock`, `privileged: true`,
  `network_mode: host`, ni dominio antiguo.
