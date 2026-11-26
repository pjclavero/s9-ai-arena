> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

repo pjclavero/s9-ai-arena · HEAD verificado `8f380eb700c3e984691649b3449d2c543038dfb1` (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`)

# Revisión técnica hostil · Auditoría de producto S9 AI Arena (FASE 1)

- Fecha: 2026-11-19 · Revisor: revisor técnico hostil (no autor de ningún informe).
- Alcance: informes `agents/01..08`, `DIRECTOR-NOTAS.md`, código de `src` @8f380eb, CI de 8f380eb y GitHub (sólo lectura con `gh`).
- Método: para cada hallazgo revisado se abrió el `fichero:línea` citado en 8f380eb o se consultó el run/issue citado. Nada se ejecutó en esta máquina salvo lectura (`git`, `grep`, `gh ... view/list/api` de lectura). Sin SSH, sin tests, sin docker.
- Informe de tercero consultado como afirmación (no verificado por mí): informe de reinstalación limpia del 19-nov (informe-reinstalación).
- Privacidad: no se reproducen IPs, nombres de host, dominio del operador ni identificadores de backup. Cuando un hallazgo depende de ellos se dice «valor de la instalación del operador».

## 1. Resumen para el director

1. La mayoría de las evidencias P1/grupo A existen y dicen lo que afirman. Ningún P1 queda REFUTADO, pero varios están **inflados** (OPS-02, OPS-05, UX-01, STR-01, QA-03) y uno está **mal fundamentado** en parte (OPS-01: la guía sí menciona proxy e imágenes de runtime; lo que falta es `DOCKER_PROXY_URL` y el firewall, y que lo presenta como «opcional»).
2. **Falso PASS relevante:** la suite `sandbox-escape` (E6, citada como PASS de aislamiento de red por QA B-10 y como respaldo por SEC) prueba el escaneo de red interna contra nombres de host que no existen, en una red Docker aislada vacía y con DNS anulado: no puede ponerse roja frente a la topología real, donde los bots sí alcanzan a `tournament-worker`, `bot-build-worker` y `arena-engine` (REV-01).
3. **Omisiones nuevas de mayor peso:** `POST /replays/{id}/verify` re-simula una batalla completa dentro del proceso de la API sin ninguna cuota para usuarios autenticados (REV-02); creación de batallas de práctica sin cuota por usuario, sin registrar quién la creó y en cola FIFO compartida con torneos (REV-03); bots de todas las batallas comparten la red `arena` con comunicación entre contenedores: canal lateral entre bots que salta las reglas de radio/visión del juego (REV-04); `cli seed` con cuenta preexistente concede `admin` a quien registró antes ese email (REV-05, resuelve D-02 al alza).
4. **Nightly:** no son 29 ni 40 ejecuciones rojas: el último verde es del 2026-08-04; desde entonces todas las ejecuciones programadas fallan (≥107). QA-01 queda CONFIRMADO y agravado.
5. Reclasificaciones de deuda: TD-006, TD-007, TD-041, TD-043, TD-066 justificadas; **TD-031 P1→P2 no justificada** (no re-medido); TD-008 queda en P2 (ni P0, ni P3, ni P1); TD-012 P1 condicional al alcance del lanzamiento; TD-023 P2 (la subida a P1 se apoya en un argumento que no aguanta).

## 2. Tabla de veredictos por hallazgo

Leyenda: CONF = CONFIRMADO · CONF/M = CONFIRMADO_CON_MATIZ · AJUST = SEVERIDAD_AJUSTADA · REF = REFUTADO · NV = NO_VERIFICABLE.

### 2.1 P0/P1 y grupo A (todos)

| ID | Sev. informe | Veredicto | Evidencia comprobada por el revisor | Motivo |
|---|---|---|---|---|
| OPS-01 | P1/A | CONF/M | `docker-compose.yml:308,368` `DOCKER_PROXY_URL:-` vacío en arena-engine y tournament-worker; `:474,543` defecto a un proxy inexistente; `configuration.md:52-53`; `installation.md:46` («Opcional… hoy apagado en producción») | El efecto (instalación «verde» que no ejecuta batallas) se sostiene. Pero es **falso** que `installation.md` no mencione proxy e imágenes de runtime: los secciones «Imágenes de runtime de los bots» (`installation.md:129-147`) y «Proxy de Docker del host» (`:149-169`) existen. Lo que falta: fijar `DOCKER_PROXY_URL` en `.env` (0 menciones en `installation.md`/`first-run.md`), el firewall (sólo un enlace en `:256`) y que el prerrequisito diga «opcional». P1/A se mantiene. |
| OPS-02 | P1/A | AJUST P1→P2 (Grupo A se mantiene) | `first-run.md:79-103` (INSERT por `psql`); `cli.ts` sin `create-admin`; `auth.ts:167-171` | La subida «sin ventana segura con registro abierto» no aguanta: que otros se registren no hace insegura la promoción por email exacto. Es fricción de instalación con paliativo documentado, PRECONDITION/ROLLBACK y verificado; arreglo S. P2, en A por coste/beneficio. |
| OPS-03 | P1/B | CONF/M | `installation.md:149-169`; `upgrades.md#td-062`; informe-reinstalación (tercero) | Cierto. Matiz: que los artefactos de Actions exijan sesión y caduquen es conocido de GitHub; el informe lo marca HIPÓTESIS correctamente. |
| OPS-04 | P1/A | CONF | `infrastructure/.env.example:57,79` `TAG=latest`/`BACKUP_TAG=latest`; `ci.yml:390-392` sólo publica `sha-<commit>` y `v<version>`; `:5,19` remiten a `docs/despliegue.md` (no existe en 8f380eb); `:14` dominio de la instalación del operador como defecto; `smoke.sh` comprueba `/replays/healthz` esperando 200, cuando el gateway devuelve 404 en `/replays/*` (`gateway/nginx.conf:124-131`): **el humo no puede dar verde nunca** (además `/api/healthz` cae en la SPA). Compose también usa `${TAG:-latest}` | NV parcial: no pude comprobar si existe un `:latest` antiguo en GHCR (sin permiso de paquetes); si existiera, `TAG=latest` traería una imagen vieja en silencio, peor que fallar. |
| OPS-05 | P1/A | AJUST P1→P2 (A como tarea S) | Ausencia de tabla de requisitos confirmada (`installation.md:35-46`) | Es una tabla de documentación; los incidentes citados son de producción, no del producto. P2. Las sumas de límites del compose no las rehice. |
| OPS-06 | P1/B | CONF | `backup.sh:771` `forget … --prune` incondicional; `entrypoint.sh` tolera config incompleta; `alertmanager` sólo en perfil `observability` con webhook de relleno (`docker-compose.yml:1016-1024`) | — |
| OPS-07 | P1/B | CONF | `restore.md` fases manuales; informe-export-b/informe-reinstalación son evidencias de tercero parciales | TD-025 P1 se mantiene. |
| OPS-11 | P2/A | CONF | `README.md:8-14` | Duplicado de DOC-01: consolidar. |
| BE-01 | P1/B | AJUST P1→P2 | `battle-failure.ts:15-16` (sale si `kind !== "run_battle"`); `results.ts:549-558` (rescate sólo `running`); `tournaments.ts:41` (`CANCELLABLE = draft,open`); `scheduler.ts:249-275` lanza `Error` genérico (→ `needs_review` sin reintentos, `queue.ts:213-226`) | La rama existe y es real. Baja porque los disparadores conocidos (ruleset/catálogo/semillas ausentes) son precondiciones que `closeEntries` y `bootstrap` ya cubren, y no hay ruta desde entrada de usuario. Sigue siendo grupo B (necesita salida de producto). |
| BE-02 | P1/B | AJUST P1→P2 | `grep needs_review apps/api/src apps/web/src scripts` sólo en `migrations.ts` y tests | Falta real de superficie operativa; no es fiabilidad del producto sino operabilidad. P2. |
| UX-01 | P1/B | AJUST P1→P2 | `BattleNewPage.tsx:421-422` rechaza el mismo bot en ambos bandos; **`:285,298` lista bots publicados ajenos** (`latestPublishedVersion != null`) | Con una instancia poblada hay rivales. El problema es la instancia vacía / primer usuario. P2, mejora de onboarding. |
| UX-02 | P1/B | CONF/M → ver D-01 | `auth.ts:386-396` (token creado y descartado); `auth.ts:440-448` no lo loguea; sin pantallas en `apps/web` | P1 condicional al alcance (ver D-01). |
| STR-01 | P1/B | AJUST P1→P2 | `supervisor.ts` sin vigilancia de RSS/uptime de página (grep vacío); mediciones sólo en docs | Streaming está desactivado por defecto y es opcional; no hay evidencia de fallo, sólo de ausencia de prueba. P1 sólo si el lanzamiento incluye emisiones largas sin supervisión. |
| STR-17 | P2/A | CONF/M (Grupo A→B, y es operación, no producto) | Mecanismo de sellado en `packages/stream-secrets`; estado real UNKNOWN | Es una tarea operativa de la instalación del operador, no un defecto del producto; no debe contar como bloqueante de lanzamiento del producto. |
| DOC-01 | P1/A | CONF | `README.md:8-14`; `git rev-list --count e3bf2fa..8f380eb` = 586 | — |
| DOC-02 | P1/A | CONF | `git ls-tree` sin LICENSE; `gh api` → `license: null`, `visibility: public` | Consolidar con UX-09/OPS-14 (director ya lo prevé). |
| QA-03 | P1/A | AJUST P1→P2, A→B | `infrastructure/tests/` sin upgrade/install; `functional-e2e/container-proxy-e2e` levanta el stack Compose real desde cero (run 44383512640) | «Sin prueba de instalación limpia» es parcialmente falso: hay arranque desde cero en CI y una reinstalación manual real (informe-reinstalación, tercero). Lo que falta de verdad es upgrade N-1→N con datos y rollback; eso se cubre con el ensayo de laboratorio de FASE 2 (sí condición), no necesariamente con automatización. |

### 2.2 Muestreo de P2/P3 (≥3 por informe)

| ID | Sev. | Veredicto | Comprobación |
|---|---|---|---|
| ARQ-01 | P2 | CONF/M | `stats.ts:620-659` llama a `loadStored`+`computeBattleStats` sin `headerIncompatibility`; el propio `replay.ts:311` lo reconoce en un comentario. Sólo se materializa al reprocesar replays de otra versión. |
| ARQ-02 | P3 | CONF | `hardening-mutant-anchors.test.ts:13` `EXPECTED = { mc, md, mb, g1 }`. |
| ARQ-07 | P3 | CONF (no re-trazado línea a línea) | Tres implementaciones citadas existen; no se comprobó divergencia. |
| ARQ-08 | P3 | CONF | Resuelto por V-01 del director: sin secretos. |
| BE-03 | P2 | CONF | `server.ts:31` `/healthz` devuelve `{status:"ok"}` fijo. |
| BE-06 | P2 | CONF | 35 `.catch(() => null/undefined)` fuera de tests (mi recuento con variantes: 35; sólo `=> null`: 33). Oráculo de #247 abierto (`gh issue view 247` OPEN; `tournaments.ts:340-345`). Matiz: dentro de `db.transaction` un `catch` deja la transacción abortada; no cambia la conclusión. |
| BE-07 | P2 | CONF | `grep Retry-After apps/api/src` vacío. Ver «falsas fortalezas» UX. |
| BE-11 | P2 | CONF | `auth.ts:158-171` sin transacción; `users.ts:39-63` sin guarda de último admin ni de auto-degradación. |
| UX-05 | P3 | CONF | 23 `aria-label` tipo slug únicos (el informe dice 26 ocurrencias; compatible). |
| UX-07 | P2 | CONF | `TournamentsPage.tsx:35,151` `mvp-default` en `<input>` libre. |
| UX-09 | P2 | CONF/M | Duplica DOC-02/DOC-11 en lo de licencia. |
| SEC-01 | P2 | CONF | `docker/web/nginx.conf` sólo `Content-Type`/`Cache-Control`; gateway sólo HSTS (`nginx.conf:88`, `nginx-behind-proxy.conf:60`); CSP/XFO sólo en API (`context.ts:29-31`). No hay sumideros `dangerouslySetInnerHTML`/`innerHTML`/`eval` en `apps/web/src` (grep vacío): baja probabilidad de XSS, el clickjacking sigue. |
| SEC-04 | P2 | CONF/M | `docker-compose.yml:360,535,855`. Ver REV-01 y REV-04: el riesgo es mayor de lo que dice porque la única prueba de red del sandbox es vacía. |
| SEC-05 | P2 | CONF/M | `node-service/Dockerfile:9,21`; `ci.yml:880` sólo `fs`; E6 sólo runtimes de bots. La rebaja de TD-031 no está medida (ver §5). |
| SEC-06 | P3 | CONF | `auth.ts:158-160`; `teams.ts:187-199` (201 vs 400 «Usuario no encontrado»; cualquiera puede ser capitán creando un equipo). |
| SEC-11 | P3 | CONF/M → P4 | Resuelvo su UNKNOWN: `gh api …/actions/permissions/workflow` → `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`. Queda sólo fijar acciones por SHA. |
| SEC-14 | P3 | AJUST P3→P2 | Ver D-02 y REV-05. |
| OPS-08 | P2 | CONF | `server.ts` no migra al arrancar; `upgrades.md`. |
| OPS-13 | P3 | CONF | `installation.md:172,189` (up antes de bootstrap), `:218` «11 healthy + backup», `:120` «12 servicios»; compose de 0.5.0 tiene 13 con `streamer`. |
| STR-03 | P2 | CONF | `apps/web/src` sin `format_version_mismatch`/`formatVersion`. |
| STR-02 | P2 | CONF | `frame-check.ts:69` clasifica por luma de un frame. |
| STR-11 | P3/E | CONF | `ffmpeg.ts:10-13` (pipe:3), `recordings.ts` existe, `alerts.yml:116-155` `Streamer*`. TD-066 debe cerrarse/reescribirse. |
| DOC-03 | P2 | CONF (muestreo TD-066/TD-015) | Coincide con STR-11 y BE. |
| DOC-13 | P3 | CONF/M | `gh pr list` hoy: 51 abiertos, 29 con «NO MERGEAR» (31 con REVIEW/NO MERGE), no 35 de 52. |
| DOC-05 | P2 | CONF | `git tag` = 0. |
| QA-01 | P2 | CONF, agravado | Run 44519497401 (8f380eb): `determinism-1000` success, `slow-suites` failure; fallos `ffmpeg ENOENT` y `unshare -rm no funciona` comprobados en `--log-failed`. Racha real: último success programado 2026-08-04; 110 fallos programados en las últimas 126 ejecuciones listadas, todos los posteriores a esa fecha. |
| QA-04 | P3 | CONF/M | En el run 44383512640 `deploy-staging` y `smoke-and-promote` tienen conclusión `success` aunque sean no-op («omitido»): el conteo «26/26 success» de OPS (son 28 jobs) incluye esos verdes vacíos. |
| QA-06 | P3 | CONF | Protección de `main` verificada: 4 checks obligatorios, `strict`, admins incluidos, 0 revisiones. |

## 3. Discrepancias entre informes y resolución

| # | Discrepancia | Resolución | Estado |
|---|---|---|---|
| D-01 | UX-02 P1 vs SEC-03 P2 (TD-012 P1→P2) | Un único hallazgo «ciclo de vida de cuenta» (registro abierto sin interruptor + sin recuperación ni cambio de contraseña + sin pantallas 2FA/sesiones). Código confirmado: `auth.ts:147-175,386-448`. **P1/Grupo A si el lanzamiento abre registro a externos; P2/B si es por invitación o cerrado.** Hoy no existe ni interruptor de registro (SEC-02), así que el valor por defecto de una instalación de tercero es el caso P1. Nota: sin recuperación, el operador ni siquiera tiene CLI para resetear una contraseña (hay que escribir un hash Argon2 por SQL). | RESUELTA (condicional) |
| D-02 | SEC-14 `cli seed` P3; historia de incidente | Código: `cli.ts:63-66` sin guarda de entorno; `seeds/dev.ts:27-34,73-89`. La doc de instalación **no** indica `seed` y `first-run.md:142` lo prohíbe; no hay guarda `NODE_ENV`. Además (nuevo, REV-05): si la cuenta `admin@…` de desarrollo ya existe, `seedDev` **no cambia su contraseña** y le añade el rol: con registro abierto, quien registre antes ese email con su propia contraseña se queda con `admin` cuando alguien ejecute `seed`. **P2/B** (no P1: exige error del operador contra una prohibición explícita; no P3: el arreglo es S y el modo de fallo ya ocurrió en la historia del proyecto). | RESUELTA |
| D-03 | TD-007 P0→P1, TD-006 P0→P3, TD-008 P0→P3 | Ver §5. TD-006 P3 justificada por evidencia de tercero (cerrar con `runtime-drift-scan` en FASE 2). TD-007 P1 justificada; queda abierto además el apagado limpio: `postgres` sigue sin `stop_grace_period` (sólo lo tiene `tournament-worker`, `docker-compose.yml:354`). TD-008 → **P2** (ver §5). | RESUELTA |
| D-04 | OPS-01: `DOCKER_PROXY_URL` vacío y batallas en `scheduled` | Confirmado en compose y `configuration.md:52`. La guía sí describe proxy e imágenes de runtime pero como opcionales y sin el paso de `.env` ni firewall. Ver OPS-01 arriba. | RESUELTA |
| D-05 | TD-023: OPS P2→P1 vs UX «mantengo P2» | P2. El primer admin por SQL es fricción documentada (A por coste S); la gestión de usuarios en web es P2/C. | RESUELTA |
| D-06 | TD-008: SEC P0→P3 vs DOC «debería ser P1 bloqueante» | P2/B. Lo que queda en main fuera de `docs/history` es poco (cabecera de `nginx-behind-proxy.conf`, defecto de `S9_DOMAIN` y comentarios en `infrastructure/.env.example`, `smoke.sh`, una config de Playwright visual, tests). Las IP privadas en tests son en su mayoría genéricas de ejemplo. Seguridad: bajo valor (dominio público, IP privada). Producto: es plantilla equivocada para terceros (ya en OPS-04). El historial git lo conserva todo. | RESUELTA |
| D-07 | Racha nightly: QA 29/29, director 40/40, DOC «40/40 en known-issues» | ≥107 fallos programados consecutivos desde 2026-08-05 (último verde 2026-08-04). Causas actuales: ffmpeg y userns ausentes en `nightly.yml` (confirmado en log). | RESUELTA |
| D-08 | UX «fortaleza: 429 con Retry-After» vs BE-07 «la API no emite Retry-After» | Ambos ciertos: la web lo interpreta (`web/src/errors.ts:18,123`) pero la API nunca lo envía (`grep` vacío en `apps/api/src`). La fortaleza es latente, no efectiva. | RESUELTA |
| D-09 | SEC «sandbox conforme y con E2E en CI» / QA B-10 PASS vs SEC-04 «los bots alcanzan al anfitrión» | La E2E de red no prueba la topología real (REV-01). La postura del contenedor (cap-drop, seccomp, rootfs) sí está cubierta; el aislamiento de red no. | RESUELTA |
| D-10 | TD-012: SEC P1→P2, OPS P1, DOC «bloqueante si se abre» | Igual que D-01. | RESUELTA |
| D-11 | Número de servicios: README «12», installation «12»/«11 healthy + backup», informe-reinstalación «13» | 13 con perfil `streaming` en 0.5.0 (compose). Doc desfasada (DOC-01/OPS-13). | RESUELTA |

## 4. Falsos PASS, falsas verificaciones y fortalezas sólo documentales

1. **Suite `sandbox-escape` (E6) como prueba de aislamiento de red** — QA B-10 «PASS … sin acceso a red/secretos»; SEC §8 «conforme en diseño y con E2E en CI». `tests/sandbox-escape/run-escape-suite.sh:26,87-88` corre cada bot en una red `--internal` propia (`arena-escape`) vacía y con `--dns 0.0.0.0`; `bots/05_internal_network_scan.py:7-8` intenta conectar a `arena-api`, `postgres`, `redis`, `bot-manager` (nombres que ni existen en esa red ni resuelven sin DNS). El marcador «SANDBOX-BLOCKED» sale siempre. En la topología real (`docker-compose.yml:292,360,535,855`) el bot comparte red con tres procesos de plataforma y con los demás bots. Es una prueba que no puede ponerse roja → REV-01.
2. **«Nightly 29/29»** (QA) — evidencia real pero mal acotada: la ventana elegida esconde que la señal está muerta desde agosto.
3. **«ci 26/26 jobs success»** (OPS §1) — el run tiene 28 jobs; `deploy-staging` y `smoke-and-promote` figuran `success` siendo no-op. Verde sin contenido; no invalida el run, pero no debe citarse como evidencia de despliegue o humo.
4. **«429 con Retry-After»** como fortaleza de la web (UX §3) — la API no emite la cabecera (D-08).
5. **TD-062 «CERRADA verificable» y TD-006 «casi cerrable»** (OPS) — etiquetados honestamente como PROD_VERIFIED de tercero; acepto el etiquetado, pero el cierre formal exige la medición de FASE 2 (no la cuento como verificada por la auditoría).
6. **«0 rotos de 2.311 enlaces»** (DOC) — script propio no conservado; no reproducible por el revisor → NO_VERIFICABLE (no bloquea).
7. **B-02/B-03 «PASS en CI»** (QA) — razonable: el `golden` de `functional-e2e` hace registro → build real → batalla → replay (`tests/browser/run.sh` cabecera) y está en success en 44383512640. Matiz: «incl. 2FA si aplica» no está demostrado.
8. **No encontré** ningún TEST_VERIFIED atribuido a un run que no sea de 8f380eb: los tres runs citados (44383512640 `ci`, 44383512289 `E6 security`, 44537834319 `acceptance`) tienen `headSha` 8f380eb y conclusión `success`; 44519497401 `nightly` es 8f380eb y `failure`.

## 5. Reclasificaciones de deuda histórica

| TD | Propuesta | Veredicto | Motivo |
|---|---|---|---|
| TD-006 P0 → P3 (OPS) | JUSTIFICADA con matiz | informe-reinstalación (tercero) declara 13/13 con `docker inspect .Config.Image` en `sha-8f380eb`. Es estado de una instalación, no del producto; cerrar sólo con `runtime-drift-scan` de FASE 2. |
| TD-007 P0 → P1 (OPS) | JUSTIFICADA | Backup funciona (tercero) pero: alertas no probadas, perfil `observability` opcional, y `postgres` sin `stop_grace_period` (compose). P1. |
| TD-008 P0 → P3 (SEC) / P1 (DOC) | AJUSTADA a P2 | D-06. |
| TD-012 P1 → P2 (SEC) | CONDICIONAL | D-01: P1/A con registro abierto a externos (valor por defecto actual); P2 en otro caso. |
| TD-013 P1 → P2 (BE-11) | JUSTIFICADA | Impacto acotado (500 por carrera, usuario sin roles). |
| TD-019 P3 → P2 (QA) | JUSTIFICADA y reforzada | D-07. |
| TD-020 P2 → «P1 si…» (OPS) | P2 | Arreglo S; el defecto está confirmado (humo siempre rojo por `/replays/healthz`, verde falso en `/api/healthz`). |
| TD-023 P2 → P1 (OPS) | NO JUSTIFICADA → P2 | D-05; el argumento de «ventana insegura» no aguanta. |
| TD-024 P2 → P1 (OPS) | JUSTIFICADA | Paraguas de OPS-01/03. |
| TD-025 P1 (sin cambio) | JUSTIFICADA | — |
| TD-031 P1 → P2 (SEC) | **NO JUSTIFICADA con la evidencia actual** | El único dato (74 HIGH/CRITICAL) no se re-midió; la rebaja se apoya en «sin ruta de explotación» sin inventario. Mantener P1 provisional hasta `trivy image` en FASE 2; bajar sólo si el recuento lo respalda. |
| TD-033 P1 → P2 (SEC) | JUSTIFICADA con condición | Hipótesis de encadenamiento sin explotación conocida; pero su mitigación no tiene prueba que pueda ponerse roja (REV-01). La verificación FASE 2 #5 de SEC pasa a obligatoria. |
| TD-041 P2 → P3, TD-043 P2 → P3 | JUSTIFICADAS | Argumentos coherentes con el código. |
| TD-066 → cerrar/reescribir (STR-11, DOC-03) | JUSTIFICADA | Código lo refuta (§2.2). |

## 6. Hallazgos nuevos (omisiones)

### REV-01 · La prueba de red del sandbox de bots es vacía: no puede detectar la conectividad real
- Área: Seguridad / QA · Severidad: P2 · Tipo: DEFECTO_CONFIRMADO (de la prueba) · Grupo: B
- Descripción e impacto: `tests/sandbox-escape/run-escape-suite.sh` ejecuta los bots de ataque en una red Docker interna creada ad hoc (`arena-escape`, sin otros contenedores) y con `--dns 0.0.0.0`; `bots/05_internal_network_scan.py` prueba nombres (`arena-api`, `postgres`, `redis`, `bot-manager`) que no existen allí. El resultado «SANDBOX-BLOCKED» está garantizado. La topología real pone al bot en `arena` junto a `tournament-worker` y `bot-build-worker` (ambos con credenciales de BD) y `arena-engine`. Para el equipo: una garantía de aislamiento que aparece como verde en CI (E6) y en los informes sin estar probada. Para un administrador: SEC-04/TD-033 no tiene control que se ponga rojo.
- Evidencia: `tests/sandbox-escape/run-escape-suite.sh:26,57,87-88`; `tests/sandbox-escape/bots/05_internal_network_scan.py:7-8`; `infrastructure/docker-compose.yml:292,360,535,855`; `.github/workflows/e6-security.yml:106`. CODE_VERIFIED.
- Solución: ejecutar el escaneo dentro de la red `arena` del stack real (p. ej. en `container-proxy-e2e`), por IP de la subred y puertos reales de los workers, con un control positivo que demuestre que la prueba ve un puerto abierto cuando lo hay. Esfuerzo M · incertidumbre media.
- Validación: mutante «añadir un servicio con puerto abierto a `arena`» debe poner la prueba roja.

### REV-02 · `verifyReplay` re-simula una batalla completa en el proceso de la API sin cuota para usuarios autenticados
- Área: Backend / disponibilidad · Severidad: P2 (sube a P1 si FASE 2 mide >1 s por verificación de una batalla larga) · Tipo: RIESGO · Grupo: B (A si se abre registro público)
- Descripción e impacto: `POST /replays/{battleId}/verify` llama a `verifyLoaded` → `verify` → `resimulateReplay` (motor y Rapier) dentro del propio proceso Node de la API. La única limitación es `anonQuota`, que **no aplica a usuarios autenticados** (`anon-quota.ts:20`) y para anónimos es 300/h por IP. No hay limitador por usuario ni de concurrencia. Con registro abierto, cualquiera crea una cuenta, genera una batalla de práctica larga (o usa un replay público) y encadena verificaciones: el bucle de eventos de la API se satura y cae todo (login, web, panel). Afecta a todos los usuarios y al administrador.
- Evidencia: `apps/api/src/routes/replays.ts:290-342`; `apps/replay-service/src/store.ts:270-289`; `apps/arena-engine/src/replay.ts:745-749`; `apps/api/src/middleware/anon-quota.ts:15,20`; `app.ts:155-213` (ningún `SharedRateLimiter` para replays). CODE_VERIFIED; coste por verificación UNKNOWN.
- Solución: limitador por usuario y global de concurrencia (1-2 verificaciones simultáneas), caché del resultado por `battleId`+hash, o mover la verificación a un job de la cola.
- Esfuerzo S-M · incertidumbre baja. Validación FASE 2: medir tiempo de `verify` de una batalla CTF con prórroga y lanzar N=10 verificaciones paralelas con un usuario midiendo la latencia de `/api/v1/users/me`.

### REV-03 · Batallas de práctica sin cuota por usuario, sin autor registrado y en cola FIFO compartida con los torneos
- Área: Backend / equidad de servicio · Severidad: P2 · Tipo: RIESGO · Grupo: B
- Descripción e impacto: `createPracticeBattle` no tiene limitador (sólo los builds lo tienen: 60/h), no guarda quién la creó (la tabla `battles` no tiene `created_by`; no hay `audit`), y encola `run_battle` en la misma tabla `jobs` que los torneos, reclamada por `ORDER BY created_at, id` sin prioridad. Un usuario recién registrado puede encolar miles de batallas de práctica con bots publicados (suyos o ajenos visibles) y retrasar horas las batallas de un torneo; el operador no puede atribuir el abuso. Afecta a organizadores y jugadores de torneos.
- Evidencia: `apps/api/src/routes/battles.ts:614-663`; `apps/tournament-worker/src/queue.ts:95-118`; `apps/api/src/app.ts:178-186` (limitadores sólo de versiones de bot). CODE_VERIFIED.
- Solución: cuota de batallas de práctica activas por usuario, prioridad de los `run_battle` oficiales en el claim, `created_by` + auditoría.
- Esfuerzo S-M · incertidumbre baja. Validación: test de claim con 100 prácticas encoladas antes de una oficial.

### REV-04 · Los bots de todas las batallas comparten la red `arena` con tráfico entre contenedores permitido: canal lateral que salta las reglas de comunicación del juego
- Área: Integridad competitiva / aislamiento · Severidad: P2 · Tipo: RIESGO (diseño confirmado, explotación no probada) · Grupo: B
- Descripción e impacto: la red `arena` es un bridge `internal` único (`docker-compose.yml:1229-1235`), el proxy fija `NetworkMode` a esa red para cada bot (`docker-proxy.ts:385-386,931`) y no hay configuración de aislamiento entre contenedores ni red por batalla (grep de `icc`/`enable_icc` vacío). DNS anulado no impide escanear la subred por IP. Bots del mismo dueño o equipo, en la misma batalla o en batallas simultáneas, pueden hablar por TCP directo, eludiendo las restricciones de radio/visión que el motor impone (y que son parte de las reglas competitivas, incluido el anti-coaching). Afecta a la integridad de torneos y rankings. SEC-04 menciona de pasada que el bot alcanza otros bots, pero sólo como vector hacia la BD, no como problema de juego limpio.
- Evidencia: referencias anteriores; `tests/sandbox-escape` no lo prueba (REV-01). CODE_VERIFIED el diseño; explotación UNKNOWN.
- Solución: red por batalla (o `com.docker.network.bridge.enable_icc=false` + reglas que sólo permitan bot→puerto del anfitrión de la sesión), y prueba E2E con dos bots que intenten conectarse entre sí.
- Esfuerzo M · incertidumbre media (el proxy exige el nombre literal `arena`). Dependencias: SEC-04.
- Validación FASE 2 (lab): dos bots en batallas simultáneas; uno escucha en un puerto, el otro barre la subred y conecta. Conexión = confirmado.

### REV-05 · `cli seed` concede `admin` a una cuenta preexistente sin tocar su contraseña
- Área: Seguridad por defecto · Severidad: P2 · Tipo: DEFECTO_CONFIRMADO · Grupo: B
- Descripción: además de crear cuentas con la contraseña pública del repositorio (SEC-14), `seedDev` reutiliza la cuenta si el email ya existe y le inserta el rol (`onConflict…ignore`), sin cambiar su contraseña. Con registro abierto y `EMAIL_RE` permisivo (`auth.ts:26`), quien registre antes el email de la cuenta de desarrollo de rol admin obtiene `admin` con su propia contraseña en cuanto alguien ejecute `seed` contra esa BD. No hay guarda de entorno en `cli.ts`.
- Evidencia: `apps/api/src/db/seeds/dev.ts:27-34,73-89`; `apps/api/src/db/cli.ts:63-66`; `apps/api/src/routes/auth.ts:26,147-171`. CODE_VERIFIED.
- Solución: `seed` se niega fuera de entorno de desarrollo explícito (flag + BD local) y falla si alguna cuenta semilla ya existe con otra contraseña. Esfuerzo S · incertidumbre baja. Validación: test que registre el email y ejecute `seedDev` esperando rechazo.

### REV-06 · `setUserRoles`: un admin puede dejar la instalación sin administradores
- Área: Administración · Severidad: P3 · Tipo: DEFECTO_CONFIRMADO · Grupo: C
- Descripción: `PUT /users/{id}/roles` sustituye todos los roles sin comprobar que quede al menos un admin ni impedir la auto-degradación. Combinado con OPS-02 (sólo SQL para crear admin), un error en la web deja al operador sin panel. BE-11 lo cita en una línea; lo separo porque su arreglo es independiente.
- Evidencia: `apps/api/src/routes/users.ts:38-63`. CODE_VERIFIED. Solución: guarda «último admin» en transacción. Esfuerzo S.

### REV-07 · El manejador de errores 500 vuelca el error de BD completo al log
- Área: Privacidad / logs · Severidad: P3 · Tipo: HIPÓTESIS · Grupo: C
- Descripción: `app.ts:231` hace `console.error(err)` de cualquier error no clasificado. Los errores de PostgreSQL por unicidad incluyen en `detail` el valor duplicado (p. ej. el email en la carrera de registro de BE-11). No hallé volcado de contraseñas ni tokens (el token de recuperación no se loguea, `auth.ts:440-448`). Evidencia: `apps/api/src/app.ts:220-233`. CODE_VERIFIED el volcado; contenido real UNKNOWN. Solución: registrar `code`/`constraint` y no `detail`. Esfuerzo S.

## 7. Veredictos de área ajustados

| Área | Veredicto del autor | Veredicto revisado | Motivo |
|---|---|---|---|
| 01 Arquitectura/motor | READY_WITH_CONDITIONS | Se mantiene | Afirmaciones prudentes y verificables. |
| 02 Backend/API/datos | READY_WITH_CONDITIONS | Se mantiene, con condiciones nuevas | Añadir REV-02/REV-03 a las condiciones; BE-01/BE-02 bajan a P2. |
| 03 Frontend/UX | READY_WITH_CONDITIONS | Se mantiene | UX-01 baja a P2; UX-02 se integra en el hallazgo consolidado de cuentas (D-01). |
| 04 DevOps/instalación | NOT_READY | **Se mantiene NOT_READY**; la frase «camino a READY_WITH_CONDITIONS: cerrar OPS-01..05 (todo documentación y dos scripts pequeños)» es **optimista**: OPS-03 requiere publicar bundle en releases (depende de OPS-14) y OPS-06/07 siguen P1. |
| 05 Seguridad | READY_WITH_CONDITIONS | **READY_WITH_CONDITIONS con condiciones más duras**: el aislamiento de red del sandbox no está probado (REV-01, REV-04), existen vectores de agotamiento sin cuota (REV-02/03) y TD-031 no se puede bajar sin medir. «No encontré P0 ni P1 con ruta de explotación» se sostiene, pero la frase «sandbox … con E2E en CI» debe retirarse para la red. |
| 06 Streaming/visor | READY_WITH_CONDITIONS (V1 operador) / NOT_READY (largas, V2) | Se mantiene | STR-01 a P2; STR-17 sale de grupo A. |
| 07 Documentación | NOT_READY | Se mantiene | DOC-01/02 confirmados. |
| 08 QA | READY_WITH_CONDITIONS | Se mantiene con matiz | La señal nocturna está muerta desde agosto (no 29 días) y hay al menos una prueba de seguridad vacía (REV-01); «CI sólida y real» es cierto para el `ci` de PR, no para la cobertura de red del sandbox. |

## 8. Lo que no pude verificar

- Existencia de un tag `:latest` antiguo en GHCR (afecta a la gravedad de OPS-04).
- El recuento de 2.311 enlaces sin roturas (DOC) y los recuentos de tests por paquete (QA): scripts no conservados; no los repetí.
- Contenido de informe-export/informe-export-b/informe-reinstalación más allá de las líneas citadas: evidencia de tercero, no verificada.
- Sumas de límites de CPU/memoria del compose (OPS-05) y cifras de coste del streamer (STR).
- Causa del color blanco en la emisión (STR-05), crecimiento de memoria de Chromium (STR-01), imagen congelada (STR-02): requieren ejecución.
- Coste real de `verifyReplay` (REV-02) y explotabilidad del canal entre bots (REV-04): requieren laboratorio.
- Autorización endpoint a endpoint: revisé el registro completo de roles del contrato (106 operaciones + extensiones) y, por muestreo, las comprobaciones de objeto de usuarios, admin, equipos, torneos (`tournament-access.ts`, `excludeTournamentEntry`), bots (artefacto, visibilidad de código, metadatos) y mapas (publicación). No ejecuté `rbac-matrix.test.ts`. No revisé una a una las 14 operaciones de streaming de admin ni `catalog/maps` de importación.
- Migraciones 001-022 línea a línea (sólo las afirmaciones de BE-09 sobre `down`).
- Contenido de los `.docx`/`.zip` de la raíz: me apoyo en V-01 del director.
- Protección efectiva de secretos en el host, firewall aplicado y estado de producción: prohibido en FASE 1.

## 9. Verificaciones adicionales propuestas para FASE 2

| # | Qué | Prueba | Entorno | Confirma / refuta |
|---|---|---|---|---|
| R1 | REV-01/REV-04 | Desde un bot real en `arena`: barrido de la subred por IP y conexión a los puertos de los workers y a otro bot que escucha | Lab aislado | Cualquier conexión no prevista confirma |
| R2 | REV-02 | Medir `POST /replays/{id}/verify` de una batalla larga; 10 en paralelo con un usuario; latencia de `/users/me` | Lab | >1 s por verificación o latencia degradada → P1 |
| R3 | REV-03 | Encolar 200 prácticas y luego cerrar un torneo; medir espera de la primera batalla oficial | Lab | Espera proporcional a la cola confirma |
| R4 | TD-031 | `trivy image --severity HIGH,CRITICAL` sobre las 6 imágenes Node de 8f380eb | Lab | Recuento decide P1/P2 |
| R5 | OPS-04 | `docker manifest inspect ghcr.io/<repo>/api:latest` | Lectura pública | Si existe, `TAG=latest` trae una imagen antigua |
| R6 | REV-05 | Registrar el email semilla de admin y ejecutar `seed` | Lab | Rol admin con la contraseña del atacante confirma |
