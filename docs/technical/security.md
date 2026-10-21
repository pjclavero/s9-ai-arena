# Seguridad

## Resumen

Modelo de seguridad **real** de S9 AI Arena en `27f70bb`:
- autenticación y sesiones;
- roles RBAC;
- aislamiento del código no confiable;
- secretos, mencionados sólo por nombre;
- funciones gateadas;
- superficies conocidas que siguen abiertas.

Las superficies abiertas se describen por su clase y se enlazan a su deuda, sin receta de
explotación. Los gates de activación de la ejecución real (Carril I) y del espectador público
(Carril J) se resumen aquí. Sus documentos de diseño originales están archivados en
`docs/history/disenos/`.

## Índice

- [Autenticación](#autenticación)
- [Sesiones y refresh](#sesiones-y-refresh)
- [Roles y RBAC](#roles-y-rbac)
- [Límites de tasa y bloqueo](#límites-de-tasa-y-bloqueo)
- [Cabeceras HTTP](#cabeceras-http)
- [Código no confiable: pipeline y sandbox](#código-no-confiable-pipeline-y-sandbox)
- [Secretos](#secretos)
- [Funciones gateadas](#funciones-gateadas)
- [Autorización de replays](#autorización-de-replays)
- [Superficies abiertas conocidas](#superficies-abiertas-conocidas)
- [Tests de seguridad](#tests-de-seguridad)
- [Verificación](#verificación)

## Autenticación

| Pieza | Implementación |
|---|---|
| Contraseñas | Argon2id (`apps/api/src/auth/passwords.ts`) |
| Token de acceso | JWT HS256, `iss = s9-ai-arena`, `aud = s9-arena/session`; caduca en **15 min**; enviado como `Authorization: Bearer` |
| 2FA | TOTP (`otplib`) con códigos de recuperación hasheados. Sólo está disponible por API (`enable2fa`, `disable2fa`) |
| Registro | `POST /auth/register`, abierto a `visitor`, **sin interruptor ni invitación**; concede `user` + `developer` ([TD-012](../roadmap/technical-debt.md#td-012)) |
| Recuperación | `POST /auth/recover` crea un token de un solo uso, con la misma respuesta exista o no la cuenta; `POST /auth/reset` lo consume (contraseña ≥ 12). **No hay canal** que entregue el token al usuario |
| Cambio de contraseña | **no existe** |

## Sesiones y refresh

| Pieza | Implementación |
|---|---|
| Refresh | token opaco en una cookie `httpOnly`, `SameSite=Lax`, `Secure` cuando la conexión es segura; también se acepta en el body (contrato) |
| Caducidad | 14 días deslizantes, **30 días absolutos** por sesión |
| Rotación | cada refresh rota el token. Si se reutiliza un token ya rotado, se revoca **toda la familia** y queda registrado en la auditoría (`rotated_token_replayed`) |
| Gestión | `listSessions` y `revokeSession` por API; no hay pantalla web |
| IP de sesión | `req.ip`, que depende de `TRUST_PROXY_HOPS` ([TD-012](../roadmap/technical-debt.md#td-012)) |

## Roles y RBAC

Los roles son jerárquicos (rango = posición en la lista):

`visitor` (0) < `user` (1) < `developer` (2) < `team_captain` (3) < `organizer` (4) < `moderator` (5) < `admin` (6)

- Cada operación del contrato `apps/api/openapi.yaml` declara `x-min-role`. `defineOperation` aplica el guard, de modo que un usuario pasa si **su rango máximo** ≥ el exigido.
- Un `x-min-role` desconocido hace que el arranque falle (fallo cerrado contra `__proto__` y erratas).
- Reparto actual en el contrato:

  | `x-min-role` | Operaciones |
  |---|---|
  | `visitor` | 29 |
  | `user` | 16 |
  | `developer` | 5 |
  | `team_captain` | 2 |
  | `organizer` | 5 |
  | `moderator` | 1 |
  | `admin` | 7 |

- Además del rol, las rutas de bots, loadouts, versiones y código fuente comprueban la **propiedad**: con un recurso ajeno responden 404, sin revelar que existe.
- **Excepción conocida:** la composición de participantes de una batalla no comprueba la propiedad ni la visibilidad ([TD-005](../roadmap/technical-debt.md#td-005)).
- Las rutas fuera del contrato se declaran explícitamente con `defineExtension` (8 operaciones: claves, auxiliares de bots, recuperación y cierre de sesión, auxiliares de torneos).
- **Limitación de las pruebas:** `rbac-matrix.test.ts` genera sus expectativas a partir del propio contrato, así que no detecta que se rebaje un `x-min-role` ([TD-018](../roadmap/technical-debt.md#td-018)).

## Límites de tasa y bloqueo

Todos se guardan en PostgreSQL (`api_usage`), así que se comparten entre réplicas y sobreviven a
reinicios:

| Límite | Valor | Clave |
|---|---|---|
| Registro | 30/min | IP |
| Login | 60/min | IP |
| Refresh | 60/min | IP |
| Recuperación | usa el limitador de login | IP |
| Crear versión / enviar a validación | 60/h cada uno | — |
| Bloqueo de login | **20 fallos** ⇒ bloqueo de 15 min; los fallos caducan en 1 h | `ip\|email` |
| Cuota anónima (lecturas públicas, re-verificación de replays) | `anon-quota` | IP |

Todas las claves usan `req.ip`. Con un salto de proxy sin contar, colapsan en una única IP
([TD-012](../roadmap/technical-debt.md#td-012)).

## Cabeceras HTTP

- **API:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
- **CORS:** sólo se refleja un origen que coincida **exactamente** con `CORS_ORIGIN`. La SPA es del mismo origen.
- **Gateway:** `Strict-Transport-Security`. Ver [gateway.md](gateway.md).

## Código no confiable: pipeline y sandbox

| Capa | Implementación | Estado |
|---|---|---|
| Análisis | estructura, análisis estático y AST (`acorn` para JS, `python3` para Python), dependencias permitidas (`runtimes/*/ALLOWED-PACKAGES.md`), detección de secretos (`secret-scan.ts`) | FUNCIONA |
| Ejecución de validación | `protocol_test`, `smoke_battle`, `resource_limits` en sandbox de contenedor | **PENDIENTE**: falta el `agentResolver`, y el build falla cerrado ([TD-001](../roadmap/technical-debt.md#td-001)) |
| Firma | artefactos firmados con `artifact_signing_key`; sin clave, el worker no arranca | FUNCIONA (sin artefactos todavía) |
| Verificación antes de lanzar | `artifactGuard` en el worker | **no cableado** ([TD-015](../roadmap/technical-debt.md#td-015)) |
| Contenedores de bot | sólo la red `arena` (sin ruta a BD, Redis ni API), `read_only`, `cap_drop: ALL`, `no-new-privileges`, límites de CPU, memoria y `pids`; imágenes de runtime fijadas por digest | definido; no se ejecuta hoy |
| Acceso a Docker | ningún contenedor monta `docker.sock`. El proxy del host (`s9-docker-proxy`) sólo permite crear, arrancar, parar, inspeccionar y ver estadísticas, y rechaza `privileged`, bind-mounts, red del host y cambio de usuario. RC2 añade: bind obligatorio (nunca comodín, `docker0` ni `host-gateway`), **control del cliente por IP de origen** (`DOCKER_PROXY_ALLOWED_CLIENTS`, sólo la subred de `bot-control`), **allowlist de imágenes** (3.ª columna de `runtimes/DIGESTS.lock`), **propiedad por labels impuestas** (`s9.managed`, `s9.proxy.instance`; un contenedor ajeno como `postgres` → 403) y límites obligatorios. Ver [docker-proxy.md](../operations/docker-proxy.md#política-rc2) | código y tests (en proceso y Docker real); despliegue pendiente |
| Alcance del proxy (RC2, tres capas independientes) | (a) red `bot-control` (`internal`, sólo los tres consumidores; [networking.md](../operations/networking.md#red-de-control-del-docker-proxy-bot-control)); (b) firewall de host `S9-HOST-GUARD`: 2375 sólo desde `s9-botctl0` + `10.89.250.0/24`, y DROP de sshd desde los bridges de Docker ([firewall.md](../operations/firewall.md)); (c) control de cliente en el proxy, que además excluye la IP de bind y las direcciones locales del host | integrado; medido en el stack Compose real por `container-proxy-e2e` (gateway/backup ⇒ 403 sin firewall, TIMEOUT con él); sin aplicar en producción ([TD-053](../roadmap/technical-debt.md#td-053)) |
| Frontera de privilegio del proxy (TD-062) | el proxy tiene el grupo `docker` (= root): todo lo que ejecuta o lee como política es de root y no lo escribe nadie más, con sus padres hasta `/`. Bundle autocontenido en `/usr/local/lib/s9-docker-proxy/` (root:root 0644, sólo importa `node:*`) ejecutado por `/usr/bin/node --no-addons`; allowlist en `/etc/s9-docker-proxy/DIGESTS.lock`; la unidad no usa `npx`/`tsx` ni `WorkingDirectory` y el árbol de despliegue le es inaccesible. El instalador corre desde un clon de root fijado al SHA revisado (nunca desde el árbol: se niega con rc 2) y el preflight instalado (`/usr/local/sbin/s9-docker-proxy-preflight`) falla con cualquier ruta, padre, unidad, entorno o proceso que no cumpla. Ver [docker-proxy.md](../operations/docker-proxy.md#frontera-de-privilegio-td-062) | código + tests (propietarios reales, EACCES, 20 mutaciones) + CI (`container-proxy-e2e` R11, unidad systemd real); **producción: unidad de RC1, abierta hasta migrar** ([TD-062](../roadmap/technical-debt.md#td-062)) |
| Seccomp de los bots | `apps/bot-manager/security/seccomp-bot.json`, `defaultAction` ERRNO; desde RC2 incluye `sendmmsg` (sin él glibc no resuelve nombres y el bot no descarga su artefacto, [TD-061](../roadmap/technical-debt.md#td-061)) | integrado; test estático + Docker real por nombre |
| Verificación de no-privilegios | `infrastructure/scripts/scan-compose.mjs` en CI; `sandbox-escape-suite.test.ts`; job `sandbox-escape` en `e6-security.yml` | FUNCIONA en CI |

**Señal `ready` del sandbox ([TD-034](../roadmap/technical-debt.md#td-034)).** `SandboxHost` expone, además de
`GET /s9/artifact/<id>` y `POST …/report`, `POST /s9/artifact/<id>/ready`. Exige el mismo token aleatorio de
la oferta (32 bytes, comparación en tiempo constante): sin token o con un token ajeno responde 403; con la
oferta revocada, 404. No tiene cuerpo, registra sólo la primera señal y no concede nada: sólo marca el paso
del reloj de plataforma al del bot. Como la envía el bootstrap de la plataforma antes de ejecutar código del
usuario, ese código no puede adelantarla ni retrasarla en su favor.

**Informes falseados.** El código del usuario ve `ARTIFACT_URL`/`ARTIFACT_TOKEN` y puede hacer POST a
`/report`; por eso, tras `ready`, todo informe se atribuye al bot y no puede disfrazar su fallo de
infraestructura. Riesgo residual: si la señal `ready` se pierde, un informe falseado con `kind` de plataforma
antes del HELLO contaría como infraestructura; aun así falla cerrado (nunca `validated` ni victoria).

## Secretos

Todos los secretos son ficheros de Docker secrets bajo `infrastructure/secrets/`, que git ignora.
El código los lee por la variable `*_FILE` y falla cerrado si el fichero no existe o está vacío.
Sólo se listan por nombre:

| Secreto | Lo consumen |
|---|---|
| `postgres_password` | postgres, api, tournament-worker, bot-build-worker, map-service, replay-service, backup |
| `jwt_secret` | api (sesión; de él se deriva por HKDF la clave de los tickets de espectador si no hay una explícita) |
| `arena_engine_internal_secret` | api y arena-engine (`POST /run`) |
| `replay_ingest_secret` | api y replay-service (escrituras de replay) |
| `artifact_signing_key` | bot-build-worker |
| `restic_password`, `restic_ssh_key`, `restic_ssh_known_hosts` | backup |
| `stream_key` | streamer (perfil `streaming`) |
| `grafana_admin_password` | grafana (perfil `observability`) |

Hay que tener en cuenta dos cosas:
- `ARENA_DEV_INSECURE_SECRETS=1` genera secretos efímeros. Es **sólo** para desarrollo y tests.
- El `tournament-worker` verifica tickets de espectador pero no recibe `jwt_secret` ni `SPECTATE_TICKET_SECRET_FILE` ([TD-028](../roadmap/technical-debt.md#td-028)).

Procedimientos: [docs/operations/configuration.md](../operations/configuration.md).

## Funciones gateadas

| Flag | Por defecto | Gate | Estado |
|---|---|---|---|
| `S9_ENABLE_REAL_BATTLE_RUNS` | apagada ⇒ `/run` responde 503 `real_battle_runs_disabled` | Carril I: reserva atómica `scheduled→running`, techo de concurrencia (`S9_MAX_CONCURRENT_REAL_BATTLE_RUNS`, por defecto 1), auditoría y liberación en caso de error. **Pendientes:** I-8 (cierre del ciclo de vida) e I-9 (autorización por propiedad) | **no activar** antes de resolver [TD-002](../roadmap/technical-debt.md#td-002) |
| `S9_PUBLIC_SPECTATE_ENABLED` | apagada | Carril J: la API no emite tickets anónimos y el gateway de espectador rechaza los marcados `anon` | en `main`; **no desplegado** ([TD-006](../roadmap/technical-debt.md#td-006)) |
| `S9_PUBLIC_REPLAYS_ENABLED` | apagada | encendida, hace públicos (anónimos incluidos) **sólo** los replays de batallas `finished` cuyos bots son todos `public`, en todas las rutas de replay de la API; el gateway ya no sirve `/replays/*` ([TD-004](../roadmap/technical-debt.md#td-004)) | integración `integration/production-readiness`, **no desplegado** |
| `S9_METRICS_ENABLED` | apagada ⇒ `/metrics` no existe | — | — |

La activación es una decisión de operación con sus precondiciones. Ver
[docs/operations/readiness.md](../operations/readiness.md).

## Autorización de replays

[TD-004](../roadmap/technical-debt.md#td-004), integración `integration/production-readiness`, **sin desplegar**.

- **Una autoridad**: la API (`apps/api/src/replay-access.ts`) decide **antes** de leer el fichero. Leen el replay de una batalla: staff (rol ≥ `organizer`), el dueño de un bot participante, los miembros del equipo de un bot participante no `private`, y cualquiera sólo si `S9_PUBLIC_REPLAYS_ENABLED` está encendida y todos los bots de la batalla son públicos.
- **Sin enumeración**: «no autorizado», «no existe» e «id inválido» responden el mismo 404 (código, `error` y mensaje).
- **Borde cerrado**: el gateway responde 404 en `/replays` y `/replays/*` (cualquier método). El replay-service sólo es alcanzable por la red interna `platform`; su ingesta sigue autenticada con `replay_ingest_secret`.
- **Sin caché compartida**: las respuestas autorizadas llevan `Cache-Control: private, no-store`.
- **Riesgo residual**: las lecturas del replay-service no exigen credencial dentro de `platform`.

Detalle en [replays.md](replays.md#autorización-de-acceso-td-004).

## Superficies abiertas conocidas

| Clase de problema | Estado | Deuda |
|---|---|---|
| Lectura anónima de replays a través del borde, al margen de la política de visibilidad | CERRADO en la integración `integration/production-readiness`; abierto en producción hasta desplegar | [TD-004](../roadmap/technical-debt.md#td-004) |
| Autorización de participantes en batallas y lectura de datos de bots privados ajenos | ABIERTO | [TD-005](../roadmap/technical-debt.md#td-005) |
| Runtime con versiones anteriores a parches de seguridad y a los gates I/J | ABIERTO | [TD-006](../roadmap/technical-debt.md#td-006) |
| Registro abierto con rol de desarrollador; límites por IP debilitados; sin cambio de contraseña | ABIERTO | [TD-012](../roadmap/technical-debt.md#td-012) |
| Listado anónimo de equipos con identificadores de usuarios | ABIERTO | [TD-011](../roadmap/technical-debt.md#td-011) |
| Información de infraestructura en el repositorio público | ABIERTO | [TD-008](../roadmap/technical-debt.md#td-008) |
| Garantías documentadas no cableadas (verificación de firma y suspensiones) | ABIERTO | [TD-015](../roadmap/technical-debt.md#td-015) |
| Pruebas que no detectan regresiones de seguridad | ABIERTO | [TD-018](../roadmap/technical-debt.md#td-018) |

Las vulnerabilidades se reportan al responsable del repositorio, no en issues públicos.

## Tests de seguridad

| Qué cubren | Ficheros |
|---|---|
| Autenticación | `apps/api/src/r24-auth.test.ts`, `auth.test.ts`, `proxy-trust.test.ts` |
| Límites compartidos | `r25-rate-limit-compartido.test.ts` |
| Fallo cerrado del ticket | `j-fail-closed-ticket.test.ts` |
| Rutas públicas | `h6-public-routes.test.ts` |
| Autorización de replays (matriz actor × batalla × recurso, enumeración, bandera pública) | `apps/api/src/td004-replay-access.test.ts` |
| Bypass del gateway con nginx real (conf del repo, API y replay-service reales) | `infrastructure/gateway/tests/replay-gateway.test.ts` (opt-in `S9_RUN_GATEWAY_SECURITY_E2E=1`, Docker; obligatorio en el job `functional-e2e / docker-e2e` de CI) |
| Sandbox | `apps/bot-manager/tests/sandbox-escape-suite.test.ts` y `tests/sandbox-escape/` |
| Análisis estático y secretos | `static-analysis`, `secret-scan` |
| Proxy de Docker y lanzamiento | `docker-proxy`, `cpu-ms`, `launch-guard`, `digest-guard`; contra Docker real `docker-proxy-docker.test.ts` (opt-in `S9_RUN_DOCKER_SANDBOX_E2E=1`) |
| Aislamiento de bot-manager | `infrastructure/tests/bot-manager-isolation.test.ts` |
| Escaneo del compose | `scan-compose.test.ts` |

Mutaciones medidas en la auditoría:
- cerrar `/replays/` en nginx: **0 rojos** (en la base; desde TD-004 la mutación pertinente es la inversa, re-exponerlo con `proxy_pass`: **5 rojos**, rc=1, en `replay-gateway.test.ts` y `replay-page-gateway-path.test.ts`);
- rebajar el rol de mapas: **0 rojos**;
- reserva y techo del Carril I: con rojos.

## Documentación relacionada

- [gateway.md](gateway.md) · [api.md](api.md) · [bots.md](bots.md) · [websocket.md](websocket.md) · [replays.md](replays.md) · [battles.md](battles.md)
- [docs/operations/readiness.md](../operations/readiness.md) · [docs/operations/docker-proxy.md](../operations/docker-proxy.md)
- [docs/roadmap/technical-debt.md](../roadmap/technical-debt.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Argon2id | CODE_VERIFIED | `apps/api/src/auth/passwords.ts:5` |
| JWT HS256, iss/aud, 15 min | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:25,35-39,105-110` |
| Refresh de 14 d y 30 d absoluto | CODE_VERIFIED | `tokens.ts:26,32` |
| Cookie `httpOnly`, `Lax` | CODE_VERIFIED | `apps/api/src/routes/auth.ts:59-62` |
| Revocación de la familia al reutilizar | CODE_VERIFIED | `routes/auth.ts:234-257` |
| Registro con `user` + `developer` | CODE_VERIFIED | `routes/auth.ts:147-175` |
| Recuperación sin canal | CODE_VERIFIED | `routes/auth.ts:384-420` |
| Roles y rango | CODE_VERIFIED | `apps/api/src/db/migrations.ts:20`; `openapi.ts:37`; `middleware/authenticate.ts:47`; `registry.ts:20-30` |
| Reparto de `x-min-role` | CODE_VERIFIED | `grep -o "x-min-role: [a-z_]*" apps/api/openapi.yaml \| sort \| uniq -c` |
| 8 `defineExtension` | CODE_VERIFIED | `grep -rn "defineExtension(" apps/api/src/routes` |
| Límites y bloqueo | CODE_VERIFIED | `apps/api/src/app.ts:126-151`; `middleware/shared-rate-limit.ts:118-121` |
| Cabeceras de la API | CODE_VERIFIED | `apps/api/src/middleware/context.ts:28-31` |
| Contenedor de bot restringido | CODE_VERIFIED | `infrastructure/docker-compose.yml`, servicio `bot-runtime-template` |
| Proxy de Docker: bind obligatorio que falla cerrado, control de cliente, allowlist de imágenes y propiedad por labels | CODE_VERIFIED + TEST (mutación: cada control retirado ⇒ rojo) | `apps/bot-manager/src/docker-proxy.ts`, `docker-proxy-config.ts`; `apps/bot-manager/tests/docker-proxy.test.ts`, `docker-proxy-docker.test.ts` |
| Frontera de privilegio del proxy: artefacto de root, preflight que falla ante cualquier pieza escribible por no root | TEST + CI | `infrastructure/tests/docker-proxy-privilege.test.ts`; `scripts/ci/assert-container-proxy-e2e.mjs` R11 |
| Secretos y consumidores | CODE_VERIFIED | `infrastructure/docker-compose.yml` (`secrets:` de cada servicio y bloque `secrets:`) |
| Clave HKDF de tickets | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:92-97` |
| `/run` 503 con la flag apagada | CODE_VERIFIED | `apps/api/src/routes/battles.ts:595-600` |
| Autorización de replays (TD-004) | TEST_VERIFIED / RUNTIME_VERIFIED (entorno aislado) | `apps/api/src/replay-access.ts`; `td004-replay-access.test.ts`; `infrastructure/gateway/tests/replay-gateway.test.ts` |
| Mutaciones | RUNTIME_VERIFIED (en la auditoría) | auditoría del 2026-10-15, pasada 2 (evidencia interna; [resumen](../audits/2026-10-15/README.md)) |
