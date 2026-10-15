# Deuda técnica — S9 AI Arena

## Resumen

Registro único de la **deuda técnica confirmada** del proyecto. Cada entrada tiene un id estable
(`TD-XXX`) que el resto de la documentación enlaza. Sólo entra aquí lo que está verificado
contra el código de `27f70bb` o contra el runtime medido. Las ideas y las funciones diseñadas que
nunca se implementaron van en [pending-features.md](pending-features.md). Los síntomas que ve el
usuario o el operador van en [known-issues.md](known-issues.md).

- **BASE COMMIT:** `27f70bb` (origin/main, 2026-09-13). Desde la auditoría del 2026-10-15 hay 0 commits nuevos.
- **LAST VERIFIED:** 2026-10-15.
- **Origen:** auditoría del 2026-10-15 ([resumen público](../audits/2026-10-15/README.md),
  [delta](../audits/2026-10-15/AUDIT-DELTA-2026-10.md)). Hay una excepción: TD-028 salió de la
  verificación de esta consolidación.

Prioridades:
- **P0:** bloquea el producto o es un riesgo de seguridad u operación grave.
- **P1:** la funcionalidad está rota o es incompleta.
- **P2:** UX o administración.
- **P3:** documentación o pruebas.
- **P4:** pulido.

Estados posibles:
- `ABIERTA`
- `MEJORADA` (avanza, pero no se cierra)
- `CERRADA`

## Índice

| Id | Título | Prioridad | Área | Estado |
|---|---|---|---|---|
| [TD-001](#td-001) | Build de bots sin sandbox real | P0 | Bots / build | ABIERTA |
| [TD-002](#td-002) | Stub HunterBot y doble camino de ejecución | P0 | Batallas | ABIERTA |
| [TD-003](#td-003) | Costura `rulesetId` web ↔ BD | P0 | Batallas | ABIERTA |
| [TD-004](#td-004) | Replays a anónimos por el gateway | P0 | Seguridad | ABIERTA |
| [TD-005](#td-005) | Autorización de participantes | P0 | Seguridad | ABIERTA |
| [TD-006](#td-006) | Runtime mezclado sin identidad de build | P0 | Runtime | ABIERTA |
| [TD-007](#td-007) | Backup sin alertas, sin snapshots de VM, apagado no limpio | P0 | Operación | MEJORADA |
| [TD-008](#td-008) | Topología en el repo público | P0 | Seguridad | ABIERTA |
| [TD-009](#td-009) | Reproductor y visor rotos (Phaser) | P1 | Web | ABIERTA |
| [TD-010](#td-010) | Editor de mapas sólo cliente | P1 | Mapas | ABIERTA |
| [TD-011](#td-011) | Equipos incompletos, listado anónimo | P1 | Equipos | ABIERTA |
| [TD-012](#td-012) | Autenticación incompleta | P1 | Seguridad | ABIERTA |
| [TD-013](#td-013) | Carreras de doble envío e integridad | P1 | API | ABIERTA |
| [TD-014](#td-014) | 301 a http en `/replays` | P1 | Gateway / web | ABIERTA |
| [TD-015](#td-015) | Torneos incompletos | P1 | Torneos | ABIERTA |
| [TD-016](#td-016) | Loadout con efecto parcial | P1 | Motor / equipamiento | ABIERTA |
| [TD-017](#td-017) | map-service sin uso | P2 | Arquitectura | ABIERTA |
| [TD-018](#td-018) | Pruebas que no detectan regresiones | P3 | Pruebas | ABIERTA |
| [TD-019](#td-019) | Nightly rojo, deploy-staging falso verde | P3 | CI | ABIERTA |
| [TD-020](#td-020) | Endpoints de salud/identidad engañosos | P2 | Operación | ABIERTA |
| [TD-021](#td-021) | Código muerto | P4 | Motor / ratings | ABIERTA |
| [TD-022](#td-022) | Errores y estados de la web | P2 | Web | ABIERTA |
| [TD-023](#td-023) | Administración sólo por SSH | P2 | Administración | ABIERTA |
| [TD-024](#td-024) | Instalación no reproducible | P2 | Instalación | ABIERTA |
| [TD-025](#td-025) | Restauración sin ensayo reciente | P1 | Operación | ABIERTA |
| [TD-026](#td-026) | Canal Redis sin productor | P4 | Cola | ABIERTA |
| [TD-027](#td-027) | Artefactos de despliegue fuera del repo | P4 | Operación | ABIERTA |
| [TD-028](#td-028) | Espectador en directo sin secreto en el worker | P1 | Espectador | ABIERTA |

---

<a id="td-001"></a>
## TD-001 — Build de bots sin sandbox real: ningún bot llega a published

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-1)
- **Área:** Bots / build (`bot-build-worker`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/bot-manager/src/build-worker-main.ts:31` construye `new E6PipelineBotManager(db, { signer })` sin `agentResolver`.
  - `apps/bot-manager/src/pipeline.ts:172` escribe el motivo del rechazo: «sandbox no verificado».
  - En producción hay 22 builds `failed` y 12 versiones `rejected`.
- **Problema:** el pipeline de validación necesita un resolutor de agente (sandbox en contenedor) para tres etapas: `protocol_test`, `smoke_battle` y `resource_limits`. El código de producción no lo inyecta en ningún sitio. Sin él, el pipeline **falla cerrado** por diseño y rechaza la versión como «no verificable».
- **Impacto:** ninguna versión pasa a `validated`, así que ninguna llega a `published`. Sin bots publicados no hay batallas ni torneos con bots de usuario. Ocurre en cualquier entorno y no depende de tener Docker.
- **Solución prevista:** cablear un `agentResolver` real que ejecute el bot en el sandbox de contenedor (a través del proxy Docker del host), manteniendo el comportamiento fail-closed si falta.
- **Condición de cierre:** un bot de ejemplo llega a `published` sin tocar la BD, y un E2E de build real en CI (con Docker) lo demuestra.

<a id="td-002"></a>
## TD-002 — Batallas ejecutadas con stub HunterBot y doble camino de ejecución

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-2)
- **Área:** Batallas (`api`, `tournament-worker`, `arena-engine`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/api/src/routes/battles.ts:441`: `POST /battles` siempre encola `run_battle`.
  - `apps/tournament-worker/src/engine-executor.ts:51`: `defaultAgentResolver = (botId) => new HunterBot(botId)`.
  - `apps/tournament-worker/src/main.ts:80`: no se pasa ningún `agentResolver`.
  - `apps/tournament-worker/src/battle-runner.ts:142`: `UPDATE status='running'` sin condición de estado.
  - `battles.ts:596-600`: `/run` responde 503 `real_battle_runs_disabled` si la flag está vacía.
- **Problema:** existen dos caminos de ejecución:
  - **Camino del worker:** usa el loadout completo del bot, pero con el **comportamiento** del stub HunterBot, no con el código del usuario. Es el único camino que cierra el ciclo de vida.
  - **Camino real** (`POST /battles/:id/run` → `arena-engine` → contenedores): está apagado. Lo impiden la flag `S9_ENABLE_REAL_BATTLE_RUNS` vacía y `DOCKER_PROXY_URL` vacío en `arena-engine`. Además, este camino no escribe el cierre (resultado, ganador, `replay_ref`, estadísticas).
- **Impacto:**
  - Ninguna batalla ejecuta el código del usuario.
  - Si se activara el camino real, una misma batalla se ejecutaría dos veces (contenedores reales y stub), y quedaría escrito el resultado del stub.
- **Solución prevista:**
  - Un único camino de ejecución con el código del usuario.
  - Sacar el stub de producción.
  - Que la transición de estado sea idempotente y condicionada al estado anterior.
- **Condición de cierre:** una batalla entre dos bots de usuario da el resultado de **su** código, se ejecuta una sola vez y queda `finished` con estadísticas. Un test de carrera lo demuestra.

<a id="td-003"></a>
## TD-003 — Costura rulesetId entre web y base de datos

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-3)
- **Área:** Batallas (`web` ↔ `api`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/web/src/pages/BattleNewPage.tsx:17-21` envía `dm_practice@1`, `tdm_mvp@1`, `ctf_mvp@1` o `zc_mvp@1`.
  - `apps/api/src/routes/battles.ts:400-401` responde `400 rulesetId desconocido` si el id no está en la tabla `rulesets`.
  - `apps/api/src/db/seeds/dev.ts:37`: el contenido base sólo siembra `mvp-default`.
  - En producción, `rulesets` = {`mvp-default`}.
- **Problema:** la web usa ids de ruleset del motor y la BD sólo conoce el ruleset del contenido base.
- **Impacto:** crear una batalla desde la web falla siempre, en los cuatro modos.
- **Solución prevista:** una de dos:
  - que el contenido base siembre los rulesets que usa la web;
  - que la web use ids que existan en la BD (a través de un catálogo servido por la API).
- **Condición de cierre:** crear una batalla desde la UI devuelve 202, y lo demuestra un test de contrato web ↔ API **sin mocks**.

<a id="td-004"></a>
## TD-004 — Replays servidos a anónimos por el gateway

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-4)
- **Área:** Seguridad (`gateway`, `replay-service`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `infrastructure/gateway/nginx.conf` y `nginx-behind-proxy.conf` (`location /replays/`) hacen proxy sin autenticación.
  - Las rutas de lectura de `apps/replay-service/src/server.ts:105-232` no exigen credencial.
  - El runtime medido respondió 200 a una petición anónima.
  - La mutación de auditoría M1a (cerrar el bloque) dejó todos los tests en verde.
- **Problema:** las rutas de lectura del replay-service quedan expuestas sin autenticación a través del gateway: inventario, contenido e índice/segmentos. También queda expuesta la re-verificación, que tiene coste de CPU. Esto ocurre al margen de la capability `S9_PUBLIC_REPLAYS_ENABLED`, que sólo gobierna la ruta pública de la API.
- **Impacto:** la política de visibilidad de replays no se aplica en el borde. Ningún test lo detectaría.
- **Solución prevista:** gobernar el acceso a `/replays/*` en el gateway o en el servicio, según la política de visibilidad, y cubrirlo con un test sobre la configuración real de nginx.
- **Condición de cierre:**
  - Un anónimo recibe 401/404.
  - El acceso autenticado sigue la política.
  - Hay un test sobre la config real que se pone rojo con la mutación M1a.

<a id="td-005"></a>
## TD-005 — Autorización de participantes y datos de bots ajenos

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-5)
- **Área:** Seguridad (`api`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/api/src/routes/battles.ts:411-419` sólo comprueba que la versión esté `published`/`frozen`. No comprueba propiedad ni visibilidad.
  - `getBotRatingHistory` (`apps/api/openapi.yaml:1000`) es público.
  - En un entorno aislado: batalla con bots privados ajenos → 202 → `finished`.
- **Problema:** un usuario puede inscribir en su batalla los bots privados de otro usuario, y puede leer el historial de rating de un bot privado ajeno.
- **Impacto:** se usa el trabajo de otros sin su consentimiento y se filtran metadatos de bots privados.
- **Solución prevista:** autorizar a cada participante por propiedad o visibilidad, y acotar `rating-history` a la visibilidad del bot.
- **Condición de cierre:** con un bot privado ajeno, la batalla responde 403/404 y `rating-history` también. Lo cubren tests negativos.

<a id="td-006"></a>
## TD-006 — Runtime con versiones mezcladas y sin identidad de build

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-6)
- **Área:** Runtime / despliegue
- **Detectado:** 2026-10-15
- **Evidencia (RUNTIME, medido en la auditoría):**
  - 9 servicios corren la imagen `4d469dc`, sin `BUILD_COMMIT` ni `/version` (404).
  - `tournament-worker` corre `0daa500`.
  - `backup` corre `ad0a42b`.
  - La etiqueta del gateway no identifica su imagen.
  - Las dependencias de la API en runtime son anteriores al parche de `multer`/`js-yaml` de main.
- **Problema:**
  - El runtime no corresponde a ningún commit único.
  - La identidad de build que exige ADR-016 no existe en producción.
  - El Carril I (reserva atómica y techo de concurrencia) y el Carril J (ticket anónimo marcado) de main no están desplegados. La mezcla api antigua + worker nuevo anula la segunda línea de defensa del Carril J.
- **Impacto:**
  - No se puede saber qué código corre.
  - Hay parches de seguridad sin desplegar.
  - Las garantías de main no aplican a producción.
- **Solución prevista:** alinear el runtime a un único commit con `BUILD_COMMIT` y `/version`. La ventana tiene que respetar la regla de no reiniciar PostgreSQL sin ventana de BD y el gate de activación.
- **Condición de cierre:** `/version` devuelve el commit esperado en 12/12 servicios y `runtime-drift-scan` sale limpio en producción.

<a id="td-007"></a>
## TD-007 — Copia de seguridad sin alertas, sin snapshots de VM y apagado no limpio

- **Estado:** MEJORADA (2026-10-15)
- **Prioridad:** P0 (auditoría P0-7)
- **Área:** Operación (`backup`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - **En la auditoría:**
    - Último éxito del backup: 2026-09-13.
    - Healthcheck `unhealthy`.
    - Sin perfil de observabilidad en marcha: nada consume `backup_metrics`.
    - Ningún snapshot de la VM.
    - El servicio `postgres` no declara `stop_grace_period`; en el arranque se recuperó el WAL.
  - **Re-medido el 2026-10-15** (RUNTIME, sólo lectura):
    - `backup SUCCESS` a las 04:15 UTC.
    - `restic check`: «no errors were found».
    - Healthcheck `healthy`.
- **Problema:** la copia vuelve a existir, pero tres cosas siguen sin resolver:
  - nada avisa si vuelve a fallar;
  - no hay snapshot de la VM como red de seguridad;
  - el apagado de PostgreSQL no está garantizado limpio.
- **Impacto:** un fallo de la copia puede pasar semanas sin detectarse, como ya pasó. No hay vuelta atrás rápida a nivel de VM.
- **Solución prevista:**
  - alerta activa sobre la métrica o el healthcheck del backup;
  - snapshot base de la VM;
  - `stop_grace_period` en `postgres` y prueba de apagado limpio.
- **Condición de cierre:** se cumplen los cuatro puntos:
  - copia nueva verificada;
  - alerta probada (que se dispara);
  - snapshot base existente;
  - apagado limpio probado.

<a id="td-008"></a>
## TD-008 — Topología de infraestructura en el repositorio público

- **Estado:** ABIERTA
- **Prioridad:** P0 (auditoría P0-8)
- **Área:** Seguridad / repositorio
- **Detectado:** 2026-10-15
- **Evidencia:**
  - Recuento por parseo en la auditoría: direcciones de red internas, de la VPN y WAN, e identificadores de máquinas virtuales, repartidos en documentos, tests, fixtures y en la configuración del gateway (`nginx-behind-proxy.conf`, comentario de cabecera).
  - La consolidación documental de 2026-10 limpia los documentos que mueve, pero no el código, los tests ni el historial de git.
- **Problema:** el repositorio es público y describe la infraestructura interna.
- **Impacto:** facilita el reconocimiento a un atacante.
- **Solución prevista:**
  - sacar la topología de documentos, fixtures y comentarios;
  - sustituirla por valores de documentación (`192.0.2.x`, `<host-arena>`);
  - añadir un gate de CI anti-topología que parsee direcciones.
- **Condición de cierre:** 0 direcciones privadas, de la VPN o WAN reales en `main`, medidas por parseo, con el gate en CI.

<a id="td-009"></a>
## TD-009 — Reproductor y visor rotos en navegador por arranque de Phaser

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-1)
- **Área:** Web (`apps/web`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/web/src/pages/ReplayPage.tsx:75`, `ViewerPage.tsx:38` y `BroadcastPage.tsx:228` llaman a `game.scene.getScene("viewer")` justo después de `new Phaser.Game(...)`.
  - En Phaser 4 las escenas se registran en el evento `READY`. Hasta entonces `getScene` devuelve `null`.
  - Reproducido con Chromium real, también contra producción.
- **Problema:** la escena no existe todavía cuando la página la usa. El error resultante es `TypeError ... setPlaybackClock`.
- **Impacto:**
  - Replay: el lienzo queda vacío y el contador se queda en «tick 0/N».
  - Visor en directo: se queda en «conectando…» sin pedir el ticket.
  - Los tests (jsdom con Phaser simulado) no lo ven.
- **Solución prevista:** esperar al evento `ready` del juego antes de obtener la escena en las tres páginas.
- **Condición de cierre:** un replay se reproduce en un navegador real y un E2E con Chromium en CI lo demuestra.

<a id="td-010"></a>
## TD-010 — Editor de mapas sólo en cliente e import incompatible

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-2)
- **Área:** Mapas (`web`, `api`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/web/src/pages/MapEditorPage.tsx:14-16` lo declara: «NO persiste en el servidor».
  - La API sí tiene `saveMapDraft` (`apps/api/openapi.yaml:518`), pero la web no lo usa.
  - Importar el JSON exportado por el editor da 500, porque el JSON no trae `map.layers`.
  - La propiedad de los mapas no se comprueba: un `organizer` puede añadir versiones al mapa de otro.
- **Problema:** el editor no guarda, F5 pierde la edición, no se puede reabrir ni duplicar un mapa, y su exportación no es compatible con el import. Tampoco se valida la compatibilidad modo ↔ mapa.
- **Impacto:** un usuario no puede tener un mapa propio en una batalla ni en un torneo.
- **Solución prevista:** cablear el editor a `saveMapDraft`, unificar el formato de exportación e import, permitir reabrir y duplicar, y comprobar la propiedad por mapa.
- **Condición de cierre:** el flujo editor → guardar → reabrir → publicar → usar en batalla funciona en navegador real.

<a id="td-011"></a>
## TD-011 — Equipos incompletos y listado anónimo con identificadores

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-3)
- **Área:** Equipos (`api`, `web`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/api/src/routes/bots.ts:148-164`: un bot sólo se asigna a un equipo (`teamId`) al crearlo. `updateBot` no lo acepta (`:178-191`) y la web no lo envía.
  - `listTeams` es `x-min-role: visitor` (`apps/api/openapi.yaml:239`) y devuelve los ids de capitán y miembros.
- **Problema:**
  - No se puede asignar ni quitar un bot de un equipo desde la UI.
  - No se puede borrar un equipo.
  - Para invitar hay que teclear un UUID.
  - El formato de torneo `teams` no es alcanzable.
  - El listado anónimo expone identificadores de usuarios.
- **Impacto:** los equipos sólo se pueblan por CLI (`demo-teams`) y se filtran identificadores.
- **Solución prevista:** gestión completa de miembros y bots desde la UI, borrado de equipos y un listado anónimo sin identificadores de usuarios.
- **Condición de cierre:** un usuario gestiona su equipo entero desde la web, y el listado anónimo no contiene UUID de usuarios.

<a id="td-012"></a>
## TD-012 — Autenticación: registro abierto, IP de cliente colapsada y gestión de cuenta incompleta

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-4)
- **Área:** Seguridad (`api`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/api/src/routes/auth.ts:147-175`: el registro está abierto, sin interruptor, y concede `user` + `developer`.
  - En producción `TRUST_PROXY_HOPS=1` (por defecto en `infrastructure/docker-compose.yml:191`), aunque detrás de un proxy inverso externo hay dos saltos. Las sesiones registran la IP del proxy.
  - No existe operación de cambio de contraseña. La recuperación no tiene canal (email) ni UI.
- **Problema:** los limitadores y el bloqueo de login usan la clave `req.ip` o `ip|email`. Con un salto de menos, todos los clientes externos comparten la misma IP, así que:
  - el bloqueo tras 20 fallos (`apps/api/src/middleware/shared-rate-limit.ts:118-119`) y el límite por minuto se aplican de forma global;
  - la auditoría por IP pierde valor.

  Nota de verificación: la auditoría observó 12 fallos de login sin 429. El umbral del código es 20, así que esa prueba no demuestra que falte el límite. La deuda real es que la clave colapsa.
- **Impacto:**
  - Cualquiera puede registrarse con el rol `developer`.
  - Un atacante puede bloquear el login de todos.
  - No hay gestión de cuenta.
- **Solución prevista:**
  - `TRUST_PROXY_HOPS` acorde al número real de saltos;
  - interruptor o invitación para el registro;
  - cambio de contraseña;
  - recuperación con canal;
  - alta del primer admin documentada (sin `seed`).
- **Condición de cierre:**
  - las sesiones registran la IP real del cliente;
  - el registro es configurable;
  - el cambio de contraseña existe y tiene test.

<a id="td-013"></a>
## TD-013 — Carreras de doble envío y reglas de integridad

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-5)
- **Área:** API
- **Detectado:** 2026-10-15
- **Evidencia (RT-ISO en la auditoría):**
  - Registro concurrente con el mismo email: 201 + 3×500.
  - `POST /bots` con el mismo nombre, o doble clic: 500 por violación de unicidad.
  - `close-entries` concurrente: 200 + 2×500.
- **Problema:**
  - Las violaciones de unicidad y las carreras se traducen en un 500 genérico, no en 409.
  - Una versión `frozen` tras un torneo no puede volver a inscribirse, pero `POST /battles` la acepta.
- **Impacto:** el usuario ve errores internos con un doble clic, y las reglas de ciclo de vida son incoherentes.
- **Solución prevista:** mapear las violaciones de unicidad a 409, hacer idempotentes las transiciones de torneo y decidir la política de `frozen`.
- **Condición de cierre:** los tests concurrentes devuelven 409 en lugar de 500 y la política de `frozen` es coherente en batallas y torneos.

<a id="td-014"></a>
## TD-014 — Redirección 301 a http en la lista de replays

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-6)
- **Área:** Gateway / web
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/web/src/pages/ReplaysPage.tsx:28` hace `fetch("/replays")`, sin barra final.
  - nginx sólo tiene `location /replays/` y redirige con 301 a una URL absoluta `http://`.
  - Detrás de TLS, el navegador bloquea la petición por contenido mixto (BROWSER contra producción).
- **Problema:** la página `#/replays` no carga cuando se sirve por HTTPS.
- **Impacto:** el usuario con sesión ve «Servicio de replays no disponible».
- **Solución prevista:** usar `/replays/` en el cliente, o una redirección relativa (o una `location` exacta) en el gateway.
- **Condición de cierre:** `#/replays` lista los replays detrás de TLS en navegador real.

<a id="td-015"></a>
## TD-015 — Torneos: sin pool de mapas, cierre bloqueado por failed y guardas no cableadas

- **Estado:** ABIERTA
- **Prioridad:** P1 (auditoría P1-7)
- **Área:** Torneos (`tournament-worker`, `web`)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/tournament-worker/src/results.ts:341,371`: una batalla que no está `finished` (incluida `failed`) impide cerrar el match o el torneo.
  - `battle-runner.ts:122-139`: las guardas `artifactGuard` y `suspensions` no se pasan en `main.ts:80`.
  - La web crea torneos con `mapPool: []`.
- **Problema:**
  - No se puede elegir mapa.
  - Un torneo con una batalla `failed` no termina nunca.
  - La verificación de firma de artefactos y las suspensiones administrativas no están activas en el camino del worker.
- **Impacto:** los torneos son frágiles y faltan las garantías documentadas de la Ronda 2.
- **Solución prevista:** selector de `mapPool`, tratamiento de `failed` en el cierre y cableado de las dos guardas.
- **Condición de cierre:** un torneo con una batalla fallida termina, y un artefacto manipulado queda descalificado en el camino del worker.

<a id="td-016"></a>
## TD-016 — Loadout y catálogo con efecto parcial en batalla

- **Estado:** ABIERTA
- **Prioridad:** P1
- **Área:** Motor / equipamiento
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/api/src/services/battle-run-http-launcher.ts:141-146,638`: el camino real traduce el chasis a uno de 3 arquetipos.
  - `apps/arena-engine/src/sim/combat.ts:198`: TTL fijo de 90 ticks; `rangeM` no se usa.
  - `apps/arena-engine/src/sim/sensors.ts:227`: `radioReaches` nunca se llama.
  - `radio-regression.test.ts:98` acepta que un enemigo intercepte la radio.
- **Problema:**
  - En el camino real sólo cuenta el chasis.
  - Algunos campos del catálogo no tienen efecto: `radio.rangeM`, `weapon.rangeM`, `movement.terrain`, `utility.*` y otros.
  - La radio no tiene alcance ni filtro de equipo, en contra de lo que decide ADR-000.
- **Impacto:** el usuario configura cosas que no cambian la batalla.
- **Solución prevista:** llevar el loadout completo al camino real, dar efecto a los campos o retirarlos del catálogo, e implementar el alcance y el filtro de la radio.
- **Condición de cierre:** hay un test por campo que demuestra su efecto en la simulación, y el test de radio exige el filtro de equipo.

<a id="td-017"></a>
## TD-017 — map-service desplegado sin uso

- **Estado:** ABIERTA
- **Prioridad:** P2
- **Área:** Arquitectura
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/map-service/src/main.ts:20-42` sirve un `MapService` en memoria, vacío y sólo de lectura.
  - Ningún componente llama al servicio: no existe `MAP_SERVICE_URL`.
  - La persistencia de mapas la hace la API, importando la librería (`apps/api/src/routes/maps.ts`).
- **Problema:** un contenedor consume recursos y aparenta una frontera de servicio que no existe.
- **Impacto:** confunde al operador y a quien desarrolla; el healthcheck verde no significa nada.
- **Solución prevista:** decidir entre retirarlo del perfil `production` o convertirlo en la autoridad real de mapas.
- **Condición de cierre:** decisión registrada en un ADR y compose coherente con ella.

<a id="td-018"></a>
## TD-018 — Pruebas que no detectan regresiones de producto y seguridad

- **Estado:** ABIERTA
- **Prioridad:** P3
- **Área:** Pruebas
- **Detectado:** 2026-10-15
- **Evidencia:**
  - No hay ningún E2E de navegador real del producto: `acceptance/visual/visor.spec.ts` sólo carga el login.
  - La suite web corre con la API mockeada.
  - Mutaciones de la auditoría:
    - M1a (cerrar `/replays/` en nginx): 0 tests rojos.
    - M3 (rebajar `x-min-role` en mapas): 0 tests rojos. `rbac-matrix.test.ts` se genera desde el OpenAPI, así que la comparación es tautológica.
- **Problema:** las suites están en verde y no ven ni TD-003, ni TD-009, ni TD-004, ni cambios de RBAC.
- **Impacto:** las regresiones de producto y de seguridad llegan a `main` sin aviso.
- **Solución prevista:**
  - E2E con Chromium del recorrido principal;
  - test sobre la configuración real de nginx;
  - test de autorización con expectativas independientes del contrato.
- **Condición de cierre:** las mutaciones M1a y M3 ponen al menos un test en rojo, y existe un E2E de navegador en CI.

<a id="td-019"></a>
## TD-019 — CI: nightly en rojo crónico y deploy-staging con verde falso latente

- **Estado:** ABIERTA
- **Prioridad:** P3
- **Área:** CI
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `nightly.yml`: 40/40 ejecuciones en `failure`. Hay dos causas: `unshare` no está disponible en el runner, y la imagen `backup:e2e-test` no se carga en el job.
  - `.github/workflows/ci.yml:945-947`: el `ssh … docker compose up` de `deploy-staging` está comentado.
- **Problema:**
  - Un rojo permanente que se ha normalizado.
  - Si se configurara `STAGING_HOST`, el job declararía «desplegado» sin desplegar.
- **Impacto:** se pierde la señal de CI, y queda un verde falso latente.
- **Solución prevista:** arreglar los dos fallos del nightly, y hacer que `deploy-staging` despliegue de verdad o falle cuando no despliega.
- **Condición de cierre:** el nightly pasa a verde, y `deploy-staging` no puede dar verde sin desplegar (lo demuestra un test o una mutación).

<a id="td-020"></a>
## TD-020 — Endpoints de salud e identidad engañosos

- **Estado:** ABIERTA
- **Prioridad:** P2
- **Área:** Operación / observabilidad
- **Detectado:** 2026-10-15
- **Evidencia:**
  - El gateway no tiene `location` para `/api/healthz`: cae en `location /` y devuelve la SPA con 200.
  - `apps/api/src/routes/system.ts:51`: `commit` se lee de `GIT_COMMIT`/`COMMIT_SHA`, que ningún despliegue fija, así que vale `unknown`. No usa `BUILD_COMMIT` (ADR-016).
  - `/grafana/` da 502 si el perfil de observabilidad no está activo.
- **Problema:** las sondas y las pantallas de estado dicen «ok» o «unknown» sin medir nada real.
- **Impacto:** el diagnóstico es falso; por ejemplo, `smoke.sh` no puede validar lo que dice validar.
- **Solución prevista:**
  - un healthcheck real de la API a través del gateway;
  - `/system/status` alimentado por la identidad de build;
  - no enrutar `/grafana/` si el perfil está apagado.
- **Condición de cierre:** la sonda a través del gateway falla cuando la API está caída, y `/system/status` muestra el commit real.

<a id="td-021"></a>
## TD-021 — Código muerto en motor y ratings

- **Estado:** ABIERTA
- **Prioridad:** P4
- **Área:** Motor / ratings
- **Detectado:** 2026-10-15
- **Evidencia:**
  - `apps/arena-engine/src/sim/sensors.ts:227` define `radioReaches`, sin llamadas.
  - `apps/tournament-worker/src/ratings.ts:162` define `revertBattleRating`, que sólo se usa en tests.
- **Problema:** hay código que aparenta garantías que no se ejercen.
- **Impacto:** quien lee el código se lleva una idea falsa de lo que hace el sistema.
- **Solución prevista:** cablear estas funciones (ver TD-016) o eliminarlas.
- **Condición de cierre:** cada función tiene un uso en producción o ya no existe.

<a id="td-022"></a>
## TD-022 — Errores y estados de la web sin resolver

- **Estado:** ABIERTA
- **Prioridad:** P2
- **Área:** Web
- **Detectado:** 2026-10-15
- **Evidencia (BROWSER en la auditoría; CODE en `BotsPage.tsx:374-384` frente a `:617-621`):**
  - No hay página 404: una ruta desconocida muestra «Mis bots».
  - El cliente no tiene timeout: «Cargando…» puede quedarse indefinidamente.
  - Los errores al crear un bot no se muestran.
  - Equipos se traga un 502 y aparece vacío.
  - F5 con la API caída lleva al login.
  - `failure_kind=none` se pinta como error.
  - La lista de batallas no muestra el ganador.
  - No hay onboarding ni enlace al SDK.
- **Problema:** la UI no informa de los fallos y muestra estados internos.
- **Impacto:** un usuario nuevo no sabe qué hacer ni qué ha fallado.
- **Solución prevista:** página 404, timeouts en el cliente, errores visibles, ganador y estadísticas por batalla, y onboarding.
- **Condición de cierre:** los estados de la tabla B12 de la auditoría se comportan como se espera en navegador real.

<a id="td-023"></a>
## TD-023 — Administración operativa sólo por SSH

- **Estado:** ABIERTA
- **Prioridad:** P2
- **Área:** Administración
- **Detectado:** 2026-10-15
- **Evidencia:**
  - La web cubre roles (por UUID), mapas, equipos y auditoría.
  - Sólo por SSH o CLI: primer admin, `bootstrap`, backup, restore, readiness, drift, logs y activación de la ejecución o del espectador. La suspensión o retirada de bots sólo existe por API.
  - No hay listado ni baja de usuarios.
- **Problema:** operar el sistema exige acceso al host.
- **Impacto:** el producto no se puede administrar sin conocer la infraestructura.
- **Solución prevista:** listado y baja de usuarios, y estado de backup, readiness, versión y drift visible en la web en modo sólo lectura.
- **Condición de cierre:** las operaciones de sólo lectura de estado son visibles desde la web de administración.

<a id="td-024"></a>
## TD-024 — Instalación no reproducible y readiness no desplegado

- **Estado:** ABIERTA
- **Prioridad:** P2
- **Área:** Instalación
- **Detectado:** 2026-10-15
- **Evidencia:**
  - Las referencias de imagen tienen por defecto `${…_TAG:-${TAG:-latest}}` (`infrastructure/docker-compose.yml`), y `latest` no existe en el registro.
  - No hay alta del primer admin sin `seed`.
  - `packages/readiness` y `packages/first-run` existen en `main`, pero no en las imágenes desplegadas.
- **Problema:** una instalación limpia siguiendo la documentación no es reproducible.
- **Impacto:** cada instalación depende de conocimiento tácito.
- **Solución prevista:** etiquetas explícitas obligatorias, alta del primer admin documentada y readiness ejecutado contra el despliegue.
- **Condición de cierre:** una instalación limpia desde [docs/operations/installation.md](../operations/installation.md) llega a readiness verde sin pasos fuera del documento.

<a id="td-025"></a>
## TD-025 — Restauración limitada y sin ensayo reciente

- **Estado:** ABIERTA
- **Prioridad:** P1
- **Área:** Operación (restore)
- **Detectado:** 2026-10-15
- **Evidencia:**
  - El último drill de restore es de agosto.
  - El job nightly de restore falla (ver TD-019).
  - `pg_dumpall -U postgres` de la documentación antigua falla, porque el único rol es `arena`.
  - El procedimiento de recuperación antiguo usaba nombres de volumen que no son los del proyecto real.
  - `restore.sh` sí permite `--snapshot <id>` tanto en `main` como en la imagen de backup desplegada. La afirmación «sólo `latest`» de la auditoría no se sostiene en el código.
- **Problema:** no hay evidencia reciente de que la copia se pueda restaurar en el entorno real.
- **Impacto:** el RPO/RTO es desconocido.
- **Solución prevista:** un drill de restore periódico en un entorno aislado, con procedimiento canónico en [docs/operations/restore.md](../operations/restore.md).
- **Condición de cierre:** un drill reciente verificado (checksums y arranque) y el job nightly de restore en verde.

<a id="td-026"></a>
## TD-026 — Canal de aviso Redis sin productor

- **Estado:** ABIERTA
- **Prioridad:** P4
- **Área:** Cola
- **Detectado:** 2026-10-15 (verificación de esta consolidación)
- **Evidencia:**
  - `apps/tournament-worker/src/redis-signal.ts:207-215`: `notify()` hace `LPUSH s9:wake:<cola>` y `wait()` hace `BLPOP`.
  - `notify()` sólo se llama en tests.
  - La API no usa Redis (no lee `REDIS_URL`), aunque el compose se lo pasa.
- **Problema:** la cola real es la tabla `jobs` de PostgreSQL. El aviso por Redis nunca se emite, así que el worker sólo avanza cuando vence el `BLPOP` (~1 s).
- **Impacto:** el impacto es bajo: añade una latencia de hasta ~1 s por trabajo. A cambio, el diseño aparenta un canal de aviso que no existe.
- **Solución prevista:** una de dos:
  - que la API (y el worker, al encolar trabajos derivados) llamen a `notify()` tras insertar en `jobs`;
  - retirar Redis y documentar el polling.
- **Condición de cierre:** un trabajo encolado despierta al worker sin esperar al vencimiento (lo demuestra un test con Redis real), o Redis ya no forma parte del stack.

<a id="td-027"></a>
## TD-027 — Artefactos de despliegue fuera del repositorio en el host

- **Estado:** ABIERTA
- **Prioridad:** P4
- **Área:** Operación
- **Detectado:** 2026-10-15
- **Evidencia (inventario interno de la auditoría):**
  - En el host hay clones usados para construir imágenes, scripts de rollout manual y copias de `.env` sin seguimiento.
  - Hay un volcado SQL con permisos laxos dentro de un directorio restringido.
- **Problema:** el procedimiento real de despliegue vive en parte fuera del repo, y quedan copias de datos y configuración sin gestionar.
- **Impacto:** el despliegue no es reproducible y hay riesgo de exposición si cambian los permisos del directorio padre.
- **Solución prevista:** llevar el procedimiento al repo (ver [docs/operations/upgrades.md](../operations/upgrades.md)), y retirar o asegurar las copias. Esto exige confirmación del operador.
- **Condición de cierre:** el inventario del host no contiene artefactos de despliegue sin justificar.

<a id="td-028"></a>
## TD-028 — Espectador en directo sin secreto de verificación en el worker

- **Estado:** ABIERTA
- **Prioridad:** P1
- **Área:** Espectador (`tournament-worker`)
- **Detectado:** 2026-10-15, en la verificación de esta consolidación; no figuraba en la auditoría.
- **Evidencia:**
  - El gateway WebSocket de espectador (`apps/api/src/spectate/gateway.ts`) se instancia dentro del `tournament-worker` (`apps/tournament-worker/src/main.ts:59-60`).
  - El gateway verifica los tickets con `verifySpectateTicket()` (`apps/api/src/auth/tokens.ts:165-177`). Esa función deriva su clave de `JWT_SECRET_FILE`/`JWT_SECRET` o de `SPECTATE_TICKET_SECRET_FILE` (`tokens.ts:73-97`).
  - En `infrastructure/docker-compose.yml`, `tournament-worker` sólo monta `postgres_password` y no define ninguna de esas variables.
  - CODE_VERIFIED. Además, los nombres de las variables del contenedor en runtime se leyeron sin valores el 2026-10-15: ninguna de las tres está presente.
- **Problema:** sin secreto, `sessionSecret()` lanza una excepción, `verifySpectateTicket()` la captura y devuelve `null`, y el gateway cierra con `4401 invalid_ticket` **todo** ticket, también los de sesión.
- **Impacto:**
  - El espectador en directo no puede funcionar en el stack tal como está declarado, aunque se corrija TD-009.
  - Falla cerrado: no es una fuga, sino una función inutilizable.
- **Solución prevista:** montar en el worker el mismo secreto (o un `SPECTATE_TICKET_SECRET_FILE` compartido con la API) y añadir un test de compose que exija la coherencia entre el emisor y el verificador del ticket.
- **Condición de cierre:** un ticket emitido por la API abre el canal del worker en el stack real, y hay un test de compose que se pone rojo si falta el secreto.

## Documentación relacionada

- [current-status.md](current-status.md): estado actual.
- [known-issues.md](known-issues.md): síntomas visibles para el usuario o el operador.
- [pending-features.md](pending-features.md): funciones pendientes.
- [AUDIT-DELTA-2026-10.md](../audits/2026-10-15/AUDIT-DELTA-2026-10.md): hallazgos de la auditoría frente al estado actual.
- [docs/technical/security.md](../technical/security.md): modelo de seguridad.
- [docs/technical/battles.md](../technical/battles.md): ciclo de batalla.

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Build sin `agentResolver` | CODE_VERIFIED | `apps/bot-manager/src/build-worker-main.ts:31`; `pipeline.ts:172` |
| Stub HunterBot en el worker | CODE_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:51`; `main.ts:80` |
| `UPDATE running` sin condición | CODE_VERIFIED | `apps/tournament-worker/src/battle-runner.ts:142` |
| `POST /battles` siempre encola | CODE_VERIFIED | `apps/api/src/routes/battles.ts:441` |
| 400 `rulesetId desconocido` | CODE_VERIFIED | `battles.ts:400-401`; `BattleNewPage.tsx:17-21`; `seeds/dev.ts:37` |
| Participantes sin comprobación de propiedad | CODE_VERIFIED | `battles.ts:411-419` |
| Phaser `getScene` antes de `READY` | CODE_VERIFIED | `ReplayPage.tsx:75`, `ViewerPage.tsx:38`, `BroadcastPage.tsx:228` |
| Umbral de bloqueo de login = 20 | CODE_VERIFIED | `apps/api/src/middleware/shared-rate-limit.ts:118-119` |
| `TRUST_PROXY_HOPS` por defecto 1 | CODE_VERIFIED | `infrastructure/docker-compose.yml:191` |
| `restore.sh --snapshot` existe | CODE_VERIFIED | `infrastructure/backup/restore.sh:5`; incluido en la imagen `ad0a42b` (`git merge-base --is-ancestor 2c72ff3 ad0a42b`) |
| `notify()` sólo en tests | CODE_VERIFIED | `grep -rn "notify(" apps packages` |
| Worker sin secreto de ticket | CODE_VERIFIED + RUNTIME_VERIFIED (sólo nombres de variables) | compose bloque `tournament-worker`; `docker inspect` de nombres de variables, 2026-10-15 |
| Backup healthy tras la copia de las 04:15 UTC | RUNTIME_VERIFIED | `docker inspect .State.Health` y logs del contenedor `backup`, 2026-10-15 21:01 UTC |
| `deploy-staging` con `ssh` comentado | CODE_VERIFIED | `.github/workflows/ci.yml:945-947` |
| Nightly 40/40 rojo | RUNTIME_VERIFIED (en la auditoría) | historial de GitHub Actions, sin cambios desde entonces |
