# Funciones pendientes — S9 AI Arena

## Resumen

Este documento recoge lo que **falta por construir o por terminar** en el producto. Cada elemento se ha
comprobado contra `main` (`e3bf2fa`, revisión del 2026-11-02): código, contrato OpenAPI, migraciones,
tests y CI. La clasificación completa, con la evidencia de cada fila, está en
[la auditoría del roadmap](../audits/2026-11/PENDING-AUDIT.md).

Categorías:
- **PARCIAL:** hay piezas en el código y falta completarlas o activarlas. Se dice qué existe y qué falta.
- **PENDIENTE:** no existe. Cada fila lleva la búsqueda que lo demuestra.
- **DESCARTADA:** decisión registrada de no hacerla. Se lista para que nadie la reabra por error.

Lo que ya está hecho **no** está aquí: se anota en [el registro de completadas](../history/status/completadas-2026-11.md).
Lo que está roto **no** es una función pendiente: es deuda y está en [technical-debt.md](technical-debt.md).

## Índice

- [Parciales](#parciales)
- [Pendientes](#pendientes)
- [Descartadas por decisión](#descartadas-por-decisión)
- [Completadas (ya no son pendientes)](#completadas-ya-no-son-pendientes)
- [Reglas que siguen vigentes](#reglas-que-siguen-vigentes)
- [Verificación](#verificación)

## Parciales

| Función | Qué existe | Qué falta | Deuda / referencia |
|---|---|---|---|
| Autorización de `/run` | `POST /battles/{id}/run` ya no ejecuta: sólo asegura el trabajo `run_battle` en la cola, de forma idempotente (`apps/api/src/routes/battles.ts:827-847`); rol mínimo `user` y política de lectura única | restringir el encolado al dueño o a un rol de moderación (hoy puede pedirlo quien puede leer la batalla) | [TD-039](technical-debt.md#td-039) |
| Espectador público | capability `S9_PUBLIC_SPECTATE_ENABLED` apagada por defecto, `#/live`, `GET /public/battles/live`, WebSocket con ticket de un uso | decidir su activación y cumplir las condiciones del gate: superficie de `/api/v1/` en el borde, `limit_conn`/`limit_req` en `/ws/`, cuota anónima calibrada | [TD-028](technical-debt.md#td-028) (cerrada) |
| Replays públicos | capability `S9_PUBLIC_REPLAYS_ENABLED` apagada por defecto, rutas `/public/replays*` | activarla (decisión del operador) | [TD-004](technical-debt.md#td-004) (cerrada) |
| Observabilidad con alertas | perfil compose `observability` (Prometheus, Alertmanager, Grafana, Loki, Promtail, exporters) con 11 alertas, entre ellas las del backup; métricas de la API tras `S9_METRICS_ENABLED` | desplegar el perfil y probar que la alerta del backup se dispara; alerta sobre `streamer_up` (la actual mira sólo la presencia del contenedor) | [TD-007](technical-debt.md#td-007) |
| Streaming a plataformas (RTMPS) | servicio `streamer` (perfil `streaming`), `BroadcastPage`, cadena Chromium -> FFmpeg -> RTMPS y MP4 verificadas en local (2026-11-02) | emisión real a YouTube (BLOCKED: sin clave de prueba); la clave de emisión va en el argv de FFmpeg; sin retención de MP4; sin E2E en CI; perfil sin desplegar | [TD-066](technical-debt.md#td-066), [streaming.md](../operations/streaming.md) |
| 2FA en la web | operaciones `enable2fa`/`disable2fa` y TOTP en el inicio de sesión (la web pide el código) | pantallas para activarlo y desactivarlo | [TD-012](technical-debt.md#td-012) |
| Recuperación de cuenta | `POST /auth/recover` y `POST /auth/reset` (el reset revoca las sesiones) | el token se crea y se descarta: no hay canal de entrega (email) ni pantallas; hoy un usuario no puede recuperar su cuenta | [TD-012](technical-debt.md#td-012) |
| Formatos de torneo | los seis (`league`, `round_robin`, `single_elimination`, `double_elimination`, `swiss`, `teams`) en API y web; generadores con tests de oro y de propiedades | E2E de worker + API para los formatos distintos de `single_elimination`; CTF en torneos (bandos A/B frente a red/blue) rechazado con motivo | [TD-015](technical-debt.md#td-015), [TD-070](technical-debt.md#td-070) |
| Administración web de operación (sólo lectura) | roles, auditoría, hallazgos de seguridad, catálogo y estado del sistema | backup, restore, readiness y drift siguen sólo por CLI | [TD-023](technical-debt.md#td-023) |
| Fases visuales posteriores a R16.3 | R16.1 (sprites), R16.2 (efectos) y R16.3 (panel de estadísticas) hechas | R16.4 sonido, R16.5 texturas de terreno, R16.6 niebla y sombreado deterministas, R16.7 shaders, R16.8 CDN | — |
| Futuro de `map-service` | sigue en el compose; la API reutiliza su código como librería | decidir: retirarlo o hacerlo autoridad de mapas (ADR) | [TD-017](technical-debt.md#td-017) |

## Pendientes

| Función | Comprobado que no existe | Diseño |
|---|---|---|
| **prepare-battle** (puente match de torneo -> batalla preparada) | `git grep -niE "prepare-?battle\|matchmaking" -- apps packages infrastructure` sin resultados; ninguna de las 84 operaciones de `apps/api/openapi.yaml` se llama así | [R12_PREPARE_BATTLE_MATCHMAKING](../history/disenos/R12_PREPARE_BATTLE_MATCHMAKING.md) §1 |
| **Matchmaking** (tickets, estados, `#/matchmaking`) | misma búsqueda; ninguna tabla en `apps/api/src/db/migrations.ts` (001–016); ninguna página en `apps/web/src/pages/` | mismo documento, §2 |
| **Auto-run** de torneos y batallas desde la UI | `git grep -niE "auto-?run" -- apps infrastructure scripts` sin resultados; no hay operación de «arrancar torneo» (el calendario se genera en `closeEntries`) | bloqueado: exige autorización del operador y validación en el host |
| **Gestión de sesiones en la web** | `listSessions`/`revokeSession` existen en la API; `git grep "auth/sessions" -- apps/web/src` sin resultados | — |
| **SDK .NET** | `sdks/dotnet/` sólo contiene un `README.md` | — |
| **SDK Java** | `sdks/java/` sólo contiene un `README.md` de plantilla («post-MVP») | — |

Los SDK reales son JavaScript (`sdks/javascript`) y Python (`sdks/python`).

## Descartadas por decisión

| Función | Decisión | Dónde |
|---|---|---|
| WebRTC para espectadores | no se implementa; la alternativa es el fan-out por el gateway WS. Se reabre sólo con demanda medida y autorización de infraestructura. Comprobado: no hay código WebRTC en `apps/` ni `packages/` | [ADR-R14](../adr/ADR-R14-webrtc.md) |
| Sharding intra-batalla | rechazado; el sharding es inter-batalla por `battleId` | [R13_5_SAVE_SHARDING](../history/disenos/R13_5_SAVE_SHARDING.md) |
| Calor y recarga de armas | fuera del modelo por decisión fundacional | [ADR-000](../adr/ADR-000-decisiones-fundacionales.md) |
| Actualizar Rapier directamente | prohibido; sólo una rama de evaluación con golden replays. El motor fija Rapier 0.19.3 por sha256 y no arranca si no coincide (`apps/arena-engine/src/engine-deps.json`) | [R13_ENGINE_RUNTIME_QUALITY](../history/disenos/R13_ENGINE_RUNTIME_QUALITY.md) |

## Completadas (ya no son pendientes)

Estas funciones figuraban como pendientes en la versión anterior de este documento y ya existen en `main`.
Su evidencia está en [el registro de completadas](../history/status/completadas-2026-11.md):

- Cierre del ciclo de vida de la batalla en el camino real (PR #152).
- Gobernanza de la lectura anónima de replays (PR #158) y política única de lectura de batallas (PR #178).
- Guardado del editor de mapas: guardar, reabrir, publicar (PR #152, PR #196).
- Ejecución real de las batallas con el código de cada bot (PR #152).
- Onboarding en la web con enlace a las plantillas y a la ayuda (PR #175, PR #210).
- Pool de mapas de los torneos (PR #152).
- Reglas oficiales de batalla con copia inmutable, motor 0.4.0 (PR #201).

## Reglas que siguen vigentes

Estas reglas vienen del roadmap anterior y siguen aplicándose a toda función nueva:

- Las funciones experimentales están **apagadas por defecto** y se activan con su gate.
- Ningún servicio monta `docker.sock` ni corre `privileged`. El código no confiable sólo se ejecuta en contenedores aislados, a través del proxy Docker del host.
- No se declara terminado lo que sólo está diseñado. En la documentación, lo diseñado se marca DESIGN_ONLY.
- Un bloque funcional por PR, con tests y mutaciones de no-vacuidad.

## Documentación relacionada

- [current-status.md](current-status.md) · [technical-debt.md](technical-debt.md) · [known-issues.md](known-issues.md)
- [Auditoría de este documento](../audits/2026-11/PENDING-AUDIT.md)
- [Batallas](../technical/battles.md) · [Torneos](../technical/tournaments.md) · [ADR](../adr/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| prepare-battle y matchmaking no existen | CODE_VERIFIED (`e3bf2fa`) | `git grep -niE "prepare-?battle\|matchmaking" -- apps packages infrastructure` (vacío) |
| `/run` delega en la cola | CODE_VERIFIED | `apps/api/src/routes/battles.ts:827-847` |
| Recuperación sin canal de entrega | CODE_VERIFIED | `apps/api/src/routes/auth.ts:386-398` (descarta el token), `:440` |
| Seis formatos aceptados por la API | CODE_VERIFIED | `apps/api/src/routes/tournaments.ts:56` |
| SDK .NET/Java vacíos | CODE_VERIFIED | `sdks/dotnet/README.md`, `sdks/java/README.md` |
| Alertas del backup en el perfil de observabilidad | CODE_VERIFIED | `infrastructure/observability/prometheus/alerts.yml:74-100` |
| Clave RTMPS en argv de FFmpeg | CODE_VERIFIED | `apps/streamer/src/ffmpeg.ts:115-118` |
| Diseños citados | DESIGN_ONLY | documentos de diseño archivados |
