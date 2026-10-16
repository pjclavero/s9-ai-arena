# E7 · Plataforma Web y API — entrega v1

API de plataforma conforme al contrato OpenAPI de E1 (`apps/api/openapi.yaml`), modelo de
datos PostgreSQL del capítulo 23 con migraciones, autenticación con RBAC real leído del
contrato, gestión de bots con la máquina de estados 17.1 delegando en el pipeline REAL de
E6, panel web React y API pública de espectador. Cubre **T7.1 a T7.5** y las mejoras E7.M.

## Estado: suite en verde

```bash
npm test -- --maxWorkers=2      # suite completa del monorepo
npx vitest run apps/api apps/web # solo E7: 60 tests, ~14 s
```

Cifras medidas en este entorno (2026-07-16, Node v20.19.2):

- Suite completa del repo: **436 pasan, 1 falla, 3 skipped** (440). El único fallo es el
  PREEXISTENTE de entorno (`zstdCompressSync` no existe en Node 20; exige ≥22.15) en
  `apps/arena-engine/tests/replay-golden.test.ts`. No es de E7: la línea base antes de E7
  era 310 pasan / mismo fallo.
- Solo E7: **60 tests en 9 archivos** (52 en `apps/api`, 8 en `apps/web`), ~14 s.
- Panel web: `npx vite build apps/web` compila a producción (208 kB js, 65 kB gzip),
  con el validador de E3 incluido para navegador.

## Base de datos: qué se usó y por qué (honestidad)

- **Producción:** PostgreSQL real vía `DATABASE_URL` (cap. 6.2). Migraciones en SQL de
  PostgreSQL con Knex Migrate programático (**ADR-E7-001**). CLI:
  `DATABASE_URL=… npx tsx apps/api/src/db/cli.ts <migrate|rollback|seed>`.
- **Tests:** el entorno no tiene Postgres local, ni psql, ni sudo, ni Docker, y está
  prohibido tocar bases del homelab. Se usa **PostgreSQL 18.4 REAL embebido** (paquete
  npm `embedded-postgres`, binarios oficiales a nivel de usuario, verificado aquí:
  initdb+start ≈ 2 s por archivo de test) — **ADR-E7-002**. No se usó pg-mem ni SQLite:
  los tests ejercitan el mismo SQL que producción (triggers plpgsql, FKs compuestas,
  jsonb, identity). Diferencia asumida: la versión exacta del Postgres del servidor la
  fijará E10.

## Contenido

```
apps/api/src/
  db/migrations.ts           T7.1 · 26 tablas en 6 migraciones (up/down completo)
  db/seeds/dev.ts            T7.1 · 7 usuarios (uno por rol), ruleset MVP (D7), catálogo E3, mapa MVP
  db/cli.ts                  T7.1 · migrate/rollback/seed contra DATABASE_URL
  services/catalog.ts        T7.1 · importación E3 idempotente e inmutable
  openapi.ts                 T7.2 · contrato E1: x-min-role (RBAC) y x-private (fugas)
  registry.ts                T7.2 · método/ruta/rol derivados del contrato por construcción
  auth/, middleware/         T7.2 · Argon2id, JWT 15min + refresh rotado, TOTP, rate limit, CORS
  routes/auth|users|teams.ts T7.2 · sesiones revocables en BD, 2FA, recuperación, equipos
  services/bots.ts           T7.3 · máquina de estados 17.1 + validador E3 en servidor
  services/e6-bot-manager.ts T7.3 · adaptador al BuildPipeline REAL de E6 (apps/bot-manager)
  routes/bots.ts             T7.3 · CRUD, loadouts (422 con violaciones E3), acciones de estado
  routes/catalog|admin.ts    T7.4 · catálogo público; hallazgos y auditoría (solo admin)
  routes/battles|standings|tournaments|maps.ts   T7.5
  services/standings.ts      T7.5 · caché ≤60 s con invalidación inmediata
  middleware/anon-quota.ts   T7.5 · cuotas anónimas persistidas en api_usage
  testing/test-db.ts         PostgreSQL embebido por archivo de test
  *.test.ts                  schema, auth, rbac-matrix, bots, e6-integration, public-api, conformance
apps/web/                    T7.4 · React+Vite (ADR-E7-003)
  src/pages/LoadoutEditor.tsx  editor con presupuesto/masa/energía EN VIVO (validador E3 real)
  src/pages/{Login,Bots,Teams,Admin}Page.tsx
  tests/*.test.tsx           jsdom: bloqueo en cliente + visibilidad del panel admin
docs/decisiones/ADR-E7-00{1,2,3}.md
```

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T7.1 | Migraciones aplican y revierten limpiamente (up→down→up) | ✅ test contra Postgres real embebido |
| T7.1 | Seeds: entorno funcional con un usuario por rol | ✅ 7 roles, idempotente |
| T7.1 | No se borra módulo referenciado por loadout congelado ni usuario con bots publicados | ✅ FKs `ON DELETE RESTRICT`, tests |
| T7.1 | Importación del catálogo E3 idempotente y versiones inmutables | ✅ reimport=no-op; mutación ⇒ `CatalogImmutableError` |
| T7.2 | Matriz rol×endpoint GENERADA del OpenAPI (insuficiente⇒401/403, mínimo⇒éxito) | ✅ `rbac-matrix.test.ts` itera el registro |
| T7.2 | Token revocado/expirado rechazado en todos los endpoints | ✅ sesión comprobada en BD por petición |
| T7.2 | 20 intentos fallidos ⇒ bloqueo temporal y registro | ✅ 429 + fila en `audit_log` |
| T7.2 | 2FA E2E; la recuperación no elude el 2FA | ✅ activación, TOTP real, recovery codes de un uso, reset que exige TOTP después |
| T7.3 | Máquina de estados exhaustiva: ilegal⇒409 (con `currentState`/`allowedTransitions`), legal auditada | ✅ unit exhaustivo estado×acción + E2E por API |
| T7.3 | Versión Publicada/Congelada inmutable incluso para admin | ✅ dueño⇒409; admin⇒403 (autorización de objeto del contrato); `codePublic` irreversible (D9) |
| T7.3 | Cambio de loadout crea revisión nueva sin alterar inscripciones congeladas | ✅ test del 17.2 |
| T7.3 | Loadout inválido devuelve violaciones EXACTAS del validador E3 | ✅ importado de `packages/module-catalog` (no reescrito), 422 |
| T7.4 | E2E Playwright registro→bot→loadout→código→build Validado en CI | ⚠️ **pendiente de entorno** (sin navegador/CI aquí); el MISMO flujo está verificado a nivel HTTP con el pipeline E6 real (`e6-integration.test.ts`) + tests de componentes jsdom |
| T7.4 | El editor impide en cliente superar presupuesto/masa/energía; el servidor re-verifica | ✅ componente con validador E3 real (bloquea `budget_exceeded`/`energy_deficit`); test de bypass manual ⇒ 422 |
| T7.4 | Un usuario no ve bots privados ajenos ni logs de builds ajenos (objeto, no solo rol) | ✅ 404 para bots invisibles; logs solo dueño/staff |
| T7.4 | Panel admin inaccesible e invisible para roles menores | ✅ componente ni se monta ni hace peticiones; API 403 por matriz |
| T7.5 | Barrido de fugas por contrato: ningún endpoint público expone campos x-private | ✅ autogenerado desde el OpenAPI |
| T7.5 | Visitante anónimo ve batalla en directo y replay sin cuenta | ✅ listado + ticket WS + descarga de replay (archivo, política 23.1) |
| T7.5 | Cuotas anónimas ⇒ 429 y registro en api_usage | ✅ persistidas por actor/ruta/ventana |
| T7.5 | La caché no sirve clasificaciones obsoletas >60 s | ✅ TTL 60 s + invalidación INMEDIATA en `updateStandings` |

## Conformidad con el contrato de E1

`conformance.test.ts`: de las **53 operaciones** del contrato, **52 implementadas** y
**1 pendiente declarada** (`verifyReplay`: exige re-simulación con el replay-service de
E8). Método, ruta y `x-min-role` no pueden divergir del contrato: `registry.ts` los
deriva del YAML al registrar cada operación (una operación fuera de contrato ni se puede
montar). Extensiones documentadas fuera de contrato: `POST /auth/recover` y
`POST /auth/reset` (recuperación de cuenta exigida por T7.2; no estaba en el YAML).

## Mejoras E7.M

- **Argon2id + rate limiting + CORS restrictivo**: hechos en T7.2 (cabeceras de seguridad
  incluidas; CORS de un solo origen `CORS_ORIGIN`).
- **Herramienta de migraciones por ADR**: ADR-E7-001 (Knex Migrate programático).
- **Autorización a nivel de objeto**: implementada y testeada más allá del rol (bots
  privados ⇒ 404 para terceros; admin sin propiedad ⇒ 403 en acciones de dueño; capitán
  del equipo concreto; logs de build solo dueño/staff).
- **/api/v1 con política de deprecación**: el contrato ya publica `servers: /api/v1`; el
  gateway (E10) debe enrutar `api/v1/* → api:8080`. Política propuesta: cambios rompientes
  solo con `/api/v2` + 6 meses de convivencia; pendiente de que E10 exista para fijarla.

## Pendiente de reconciliación (explícito)

| Con | Qué | Estado actual en E7 |
|---|---|---|
| E6 | Ejecución containerizada de `protocol_test`/`smoke_battle`/`resource_limits` (T6.2 exige Docker) | El adaptador usa el `BuildPipeline` REAL de E6 en proceso; esas 3 etapas quedan `skipped` con motivo (comportamiento propio de E6 sin `agentResolver`) |
| E6 | E6 marca `botVersionState=published` al acabar su pipeline; 17.1 dice `validated` + publicación explícita | E7 aplica 17.1: `passed ⇒ validated`; documentado en `e6-bot-manager.ts` |
| E6 | Formato real del paquete subido (zip). MVP: JSON `{files:[…]}` o archivo único envuelto en esqueleto estándar | Decodificador en `decodePackage()`; cambiar allí cuando E6 fije el formato |
| E8 | `verifyReplay` (re-simulación) y el canal WebSocket que consume el ticket de espectador | Ticket JWT firmado 60 s emitido; canal y verificación en E8/E10 |
| E9 | Calendario tras `close-entries`, ejecución de batallas (jobs `run_battle`, `generate_schedule`, `tournament_dry_run`) y escritura de ratings/standings | E7 encola en `jobs` y expone `updateStandings()` como punto de entrada |
| E10 | Playwright E2E en CI contra el stack de desarrollo; gateway con caché HTTP (las respuestas ya emiten `Cache-Control`); versión exacta de Postgres | Tests HTTP+componentes como sustituto documentado (ADR-E7-003) |

## Limitaciones de entorno asumidas

- Sin navegador/Playwright: DoD E2E de T7.4 verificado por capas (HTTP + jsdom), no en navegador.
- Sin Docker: las etapas containerizadas del pipeline E6 quedan `skipped` (igual que en la
  propia entrega de E6).
- Node 20 local (el motor exige Node 22 por D4): el único test rojo del repo es ese
  preexistente de zstd; ninguno de E7 depende de zstd.
- Tickets de espectador: de un solo uso REAL solo cuando el gateway (E8/E10) los consuma;
  hoy expiran a los 60 s.
