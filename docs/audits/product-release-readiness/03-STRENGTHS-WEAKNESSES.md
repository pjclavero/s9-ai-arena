# 03 · Fortalezas y debilidades

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: lo que está bien hecho y se ha verificado, y lo que está mal, frágil o sobrevalorado, sin equilibrar artificialmente. Veredicto y plan en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md); inventario en [01-PROJECT-INVENTORY.md](01-PROJECT-INVENTORY.md); matriz en [02-FUNCTIONAL-MATRIX.md](02-FUNCTIONAL-MATRIX.md).

Reglas de este documento: una fortaleza sólo figura si tiene evidencia citada; se marca `CODE_VERIFIED` (leída en 8f380eb), `TEST_VERIFIED` (run de CI de 8f380eb) o **DOC_ONLY / no ejecutada** cuando sólo hay documentación o existe un test que nadie ha visto ponerse rojo. Nada de producción cuenta como verificado por la auditoría. El hecho de que un test exista y esté en CI **no** lo convierte en prueba de la propiedad que dice cubrir (véase REV-01).

---

## 1. Fortalezas verificadas

### 1.1 Motor y reproducibilidad

| Fortaleza | Evidencia | Estado |
|---|---|---|
| Determinismo por construcción y por lint, no por convención: todo `src/` vigilado, cuatro exentos justificados | `scripts/lint-determinism.mjs:6-48`; PRNG propio con flujos derivados por etiqueta (`rng.ts`) | `CODE_VERIFIED`. Que el lint corra en CI y que un mutante lo ponga rojo: no verificado (ARQ §2) |
| Hash de estado canónico por componente, explicable (un fallo de verificación dice qué parte divergió) | `sim/state-hash.ts:4-15,63,100-110` | `CODE_VERIFIED` |
| Verificador de replay que distingue «versión distinta» de «manipulado» y comprueba la versión antes que `rules_incomplete` | `replay.ts:329-360`; `engine-compat.ts`; ADR-024 cita `engine-version-ola2.test.ts` | `CODE_VERIFIED`; el paso del test en CI no verificado |
| Cabecera de replay que ata motor, física (paquete + wasm), protocolo, runtime, catálogo, esquema de hash/RNG | `replay.ts:329-360` | `CODE_VERIFIED` |
| Rapier fijado por sha256; el motor se niega a arrancar si cambia | `engine-deps.json`; `engine.md:159` | `CODE_VERIFIED`; el arranque con wasm alterado **no ejecutado** |
| Política de versionado clara y conservadora (una subida por OLA) | ADR-022/024 | `CODE_VERIFIED` (con la contrapartida de la debilidad 2.1) |
| Pasa `determinism-1000` en la nightly del 19-nov | run 44519497401 | `TEST_VERIFIED` (sólo ese job; la nightly como conjunto está roja) |

### 1.2 Backend, cola y datos

| Fortaleza | Evidencia | Estado |
|---|---|---|
| Cola en Postgres con `FOR UPDATE SKIP LOCKED`, `dedupe_key` única, fallo clasificado deportivo/infraestructura/no clasificado, topes por clase | `queue.ts:34-226`; `errors.ts` | `CODE_VERIFIED`; tests en `ci` 44383512640 |
| Doble cerrojo en batalla (lease 45 s bajo lock de job 60 s, renovados juntos), reserva condicionada al titular | `battle-runner.ts:173,228-280` | `CODE_VERIFIED` |
| Cierres de torneo con transacción y `FOR UPDATE`; cancelación idempotente y auditada | `tournaments.ts:853-895` | `CODE_VERIFIED` |
| Contrato OpenAPI como fuente de autorización (`x-min-role`); rutas y roles derivados del contrato; sin deriva ruta↔contrato | `registry.ts`; `conformance.test.ts` (corre en CI) | `CODE_VERIFIED`; el rc del test no se ha visto |
| Rate limit compartido en BD (sobrevive a reinicios); `audit_log` de sólo inserción por trigger | `shared-rate-limit.ts`; `migrations.ts:006` | `CODE_VERIFIED` |
| 22 migraciones con `down`, lista cerrada de rollback con tests por migración 016–022 | `db/migrations.ts`; `migration-0xx.test.ts` | `CODE_VERIFIED` (reversibilidad no sin pérdida: BE-09) |
| Timeout de batalla corregido en main; torneos zombis por batallas `failed` corregidos | PR #298/#299; `settleFailedBattle`, `rescueStuckTournaments` | `CODE_VERIFIED`; la medición real es evidencia de tercero |

### 1.3 Seguridad

| Fortaleza | Evidencia | Estado |
|---|---|---|
| Ningún servicio monta `docker.sock`; lo impone un escáner de compose en CI | job `scan` en `ci` 44383512640 | `CODE_VERIFIED` + `TEST_VERIFIED` |
| Proxy de Docker con lista de endpoints, imagen por digest, etiquetas de propiedad impuestas y límites obligatorios (CPU, memoria, pids, `MemorySwap==Memory`, usuario no root, `CapDrop ALL`, rootfs de sólo lectura, DNS `0.0.0.0`, una red); seccomp por allowlist | `docker-proxy.ts:316-450,926-936`; `compliance.mjs`; `seccomp-bot.json` | `CODE_VERIFIED`. La **postura** del contenedor; el aislamiento de **red** no está probado (debilidad 2.5) |
| El build del bot ya no ocurre en la API: la API encola; el worker construye en sandbox y firma el artefacto (ed25519) | `QueueBotManager`; verificación en el worker de batallas | `CODE_VERIFIED` |
| Sesión: access JWT de 15 min en memoria, refresh opaco con rotación por familias y detección de reutilización, tope de 30 días; JWT fail-closed sin secreto | `auth/tokens.ts:25-80`; `routes/auth.ts:228+` | `CODE_VERIFIED` |
| Anti-enumeración en login (hash señuelo); tickets de espectador de un solo uso con secreto, issuer y audiencia distintos | `routes/auth.ts`; `tokens.ts:96-100`; `gateway.ts` | `CODE_VERIFIED` |
| Secretos por fichero 0400, aleatorios, sin argv ni `.env`; sin secretos versionados | `init-secrets.sh`; `git ls-files` | `CODE_VERIFIED`; permisos reales en el host: `BLOCKED (FASE 2)` |
| Un solo servicio publica puertos (gateway); replays ya no pasan sin autorizar (TD-004) | `docker-compose.yml:100-112`; `gateway/nginx.conf` (404 en `/replays*`) | `CODE_VERIFIED` |
| Frontera de secretos del streamer: la clave de emisión va sellada (RSA-OAEP + AES-GCM) y ffmpeg no conoce ni destino ni clave (`pipe:3`) | `ffmpeg.ts:33`; `packages/stream-secrets`; `secret-surfaces.test.ts` | `CODE_VERIFIED` |
| Anti-fugas del canal en vivo: una proyección por audiencia firmada, `debug` sólo con ticket de staff, buffers acotados en cliente | `gateway.ts`; `packages/projection`; `interpolation.ts:189` | `CODE_VERIFIED`; prueba de fuga E2E real `BLOCKED (FASE 2)` (T11) |
| Sin `pull_request_target`; push a GHCR sólo en main; permisos por defecto del token = `read` | `.github/workflows/*`; `gh api …/actions/permissions/workflow` (REVISION-TECNICA) | `CODE_VERIFIED` |
| `main` protegida: 4 checks obligatorios, `strict`, administradores incluidos | API de protección (QA-06, verificada por REVISION-TECNICA) | verificado en lectura |

### 1.4 CI y calidad

| Fortaleza | Evidencia | Estado |
|---|---|---|
| El gate de `functional-e2e` es fail-closed: sin `if:` ni `continue-on-error`; «skipped / 0 tests / sin batalla real ⇒ falla». Golden con navegador real (registro → build real → batalla → replay), docker-e2e y container-proxy-e2e | `scripts/ci/assert-functional-e2e.mjs`; `functional-e2e.yml:104-108`; `ci` 44383512640 | `TEST_VERIFIED` (matiz: «incl. 2FA si aplica» no demostrado) |
| Tests de backup con mutaciones de efecto distinguible (red, huella, auth, repo, checksum, snapshot corrupto): evidencia de que pueden ponerse rojos | log de la nightly 44519497401 (6 «MUTACIÓN … PASS») | `TEST_VERIFIED` |
| Suite grande: 485 ficheros y 6.869 tests en la nightly (6.777 pasan) | salida real del run 44519497401 | `TEST_VERIFIED` |
| Gate de dependencias con semántica explícita (ADR-018), una excepción datada que caduca el 2026-12-17 | `scan-gate.mjs`; `npm-audit-excepciones.json` | `CODE_VERIFIED`; `scan` en `ci` success |
| Imágenes inmutables `sha-<commit>` en GHCR, `--no-build`, gates con mutantes (`release-gate`, `tag-override-gate`, `compose-canonical-check`) | `ci.yml:390-392`; compose | `CODE_VERIFIED` |

### 1.5 Operación y documentación

| Fortaleza | Evidencia | Estado |
|---|---|---|
| Backup bien diseñado: `pg_dump -Fc`, manifest sha256, secretos en snapshot aparte, healthcheck que mira la copia, `--init-repo` explícito | `backup.md`; `entrypoint.sh`; `backup.sh` | `CODE_VERIFIED`; `e2e-backup-sftp` y `e2e-restore-sftp-bootstrap` en `ci` (sintético) |
| Export/import portable idempotente y reanudable, verifica antes de escribir | `scripts/portable/*`; `portable-roundtrip.test.ts` | `CODE_VERIFIED`; el rc del test no verificado; 37/37 bots y 8/8 equipos = evidencia de tercero |
| Documentación de operaciones honesta con sus límites (FUNCIONA/PARCIAL/PENDIENTE, PRECONDITION/EFFECT/ROLLBACK) | `docs/operations/*` | `CODE_VERIFIED` (lectura) |
| Estructura de `docs/` por audiencia, ADR indexados, histórico separado; 12 páginas de programación de bots con ejemplos Python/JS | `docs/README.md`, `docs/adr`, `docs/user/bots` | `CODE_VERIFIED`. «0 de 2.311 enlaces rotos» es un script no conservado: **NO_VERIFICABLE** (REVISION-TECNICA §4) |
| Frontend con una sola carcasa, errores clasificados en una función, checklist con estado real de la API, borradores recuperables, axe en navegador real | `App.tsx`; `errors.ts`; `HomePage.tsx:computeFirstSteps`; `a11y-basics.spec.ts` | `CODE_VERIFIED`; usabilidad con personas **no medida** |
| Disciplina de evidencia: cada documento declara su estado y enlaza TD-xxx | `docs/**` | `CODE_VERIFIED` |

### 1.6 Streaming V1 (como herramienta de operador)

Implementado e integrado de punta a punta (admin web → API → streamer → Chromium+Xvfb → ffmpeg → relé RTMPS con TLS verificado y failover), con puerta de render, vigilante de blanco y alertas `StreamerDown/RestartLoop/NoProgress` (`supervisor.ts`, `alerts.yml:116-155`; `CODE_VERIFIED`, tests unitarios en `ci`). Los fallos históricos (pantalla blanca #256, «emisión vacía», director que cortaba antes del retardo #284, latidos #282) están corregidos en código. **La emisión real a una plataforma en noviembre es `DOC_ONLY`**; se presenta como experimental (DECISIONES-DIRECTOR).

---

## 2. Debilidades

Ordenadas por impacto en la presentación y la operación por terceros, no por área. Severidad y grupo finales entre paréntesis; el desarrollo de cada ID está en el informe de área y la fila correspondiente de [02-FUNCTIONAL-MATRIX.md](02-FUNCTIONAL-MATRIX.md).

### 2.1 Barreras de entrada (lo que ve un tercero antes de ejecutar nada)

1. **Sin LICENSE en un repositorio público** (DOC-02, P1, A; `license: null`). Nadie puede usar, redistribuir ni contribuir con garantías; los SDK no son consumibles. Hay dependencias con licencias propias sin inventario (sin NOTICE/SBOM) y un `.docx` y un zip en la raíz de procedencia no revisada para licenciar.
2. **El README dice «no es funcional de extremo a extremo»** (DOC-01, P1, A; `README.md:8-14`, V-02), con fecha 2026-10-18, una tabla de TD resueltos como «roto/bloqueado» y «12 servicios» (hay 13). La portada de `docs/` y todo `docs/roadmap/*` están anclados a un commit 586 por detrás. Es lo primero que lee un visitante y le dice que el producto no sirve.
3. **Escaparate**: 29 PR abiertos con «NO MERGEAR», de 51 abiertos (gh, 2026-11-19), nightly en rojo visible, un `.zip`/`.docx`/compose v1 en la raíz, 0 imágenes, 0 tags, sin SECURITY.md ni plantillas (DOC-13, DOC-07, DOC-10, DOC-05, DOC-06; P2–P3, A–B). Cada uno es barato; juntos dan imagen de proyecto abandonado.
4. **Sin release**: no existe «la versión estable» que instalar; el operador elige un SHA sin guía (OPS-14, P2, A en forma mínima).
5. **Sólo español**, incluida la API, los mensajes y el SDK (DOC-09, P3, C): barrera para programadores de bots fuera del ámbito hispano.
6. **Contribuir es caro**: `contributing.md` exige mutantes y controles negativos en cada PR, sin versión ligera para externos; CONTRIBUTING no está en la raíz; sin «good first issue» ni quickstart de 5 minutos (DOC-06, DOC-11; P2, B). `.changeset/` vacío y `pnpm-workspace.yaml` conviven con npm workspaces: ruido para el recién llegado.
7. **SDK sólo desde el repositorio** (UX-09, P2, B): `git clone`, Node 22 y `pip install -e`; .NET y Java son directorios con un README.
8. **El primer bot cuesta el doble**: no hay rival de práctica; hay que crear, equipar, validar y publicar un segundo bot antes de ver un combate (UX-01, P2, A en forma barata). En una instalación nueva el anónimo ve una portada y un ranking vacío, con replays y espectador públicos apagados por defecto: nadie ha recorrido esa primera impresión.

### 2.2 Instalación y operación por terceros

1. **El camino documentado produce un stack «verde» que no ejecuta batallas** (OPS-01, P1, A): `DOCKER_PROXY_URL` queda vacío, las batallas quedan `scheduled`, ningún bot llega a `published`. Para corregirlo hay que hacer una segunda instalación a nivel de host y como root (proxy, firewall, runtimes) escrita como *migración*. La prueba más contundente es la medición de la reinstalación de referencia: **11 intervenciones manuales** fuera del guion (informe de tercero), y ≈27–30 pasos discretos y ≈10 decisiones sin explicar según el recuento del autor OPS (no es un tiempo medido). Nota de coherencia del propio informe OPS: su resumen dice que «5 las sufriría un tercero», pero su tabla marca 8 como «SÍ» y 2 como «en parte»; se toma la tabla.
2. **El proxy exige construir un bundle con Node ≥22.15** (que Debian 12 no trae) y compararlo con un sha256 que sólo está en el resumen de un run de CI, cuyos artefactos exigen sesión y caducan (OPS-03, P1, B→A en forma mínima).
3. **Primer administrador por SQL** con registro abierto (OPS-02, P1→P2 (REVISION-TECNICA), A); si se pierde el único admin, la recuperación es la misma ruta SQL. REV-06 (P3, C): un admin puede dejar la instalación sin administradores. Sin recuperación ni cambio de contraseña, el operador tampoco puede resetear una cuenta sin escribir un hash Argon2 por SQL.
4. **Plantilla de configuración errónea**: `infrastructure/.env.example` con `TAG=latest` (el CI sólo publica `sha-<commit>` y `v<version>`), un enlace a `docs/despliegue.md` que no existe y valores por defecto de la instalación del operador (OPS-04, P1, A; V-04). `smoke.sh` espera 200 en una ruta que el gateway responde 404 y `/api/healthz` cae en la SPA: **el humo no puede dar verde con sentido** (TD-020).
5. **Sin requisitos de hardware, disco ni SO** (OPS-05, P1→P2, A); la única medida real es la de producción y la documentación admite que tres batallas simultáneas ahogaron una instancia de 4 vCPU (#185 abierta). Un tercero con un host pequeño repetirá el incidente.
6. **Backup que puede no existir sin que nadie lo sepa** (OPS-06, P1, B): sin repositorio externo el contenedor queda `unhealthy` y sólo avisa a las 26 h por una alerta que no existe si el perfil de observabilidad está apagado y el webhook vacío; `.env` no entra en la copia; `forget --prune` es incondicional. **Restore** completo manual y nunca ensayado de punta a punta en host limpio (OPS-07, P1, B; ensayo en A); restore real = evidencia de tercero parcial.
7. **Actualización y rollback artesanales** (OPS-08, P2, B): la API no migra al arrancar, así que entre `up` y `migrate` los servicios corren con esquema viejo (HIPÓTESIS); el rollback de datos es sólo restic; el de migraciones, una lista cerrada con la trampa de `rollback:1`. `down` de 011, 018 y 019 pierde datos o reescribe una función compartida (BE-09, P3, C).
8. **Sin observabilidad por defecto**: el perfil es opt-in, las 11 alertas están «NOT TESTED» en instalación real, `readiness` «nunca» da READY, `/healthz` devuelve un `{"status":"ok"}` fijo (BE-03, P2, B) y el heartbeat del worker es un `setInterval` independiente de los bucles: el healthcheck puede estar verde con el worker parado. `postgres` sin `stop_grace_period` (TD-007, P1).
9. **Operar la cola exige SQL**: jobs `needs_review` sin listado, reintento ni métrica (BE-02, P1→P2, B); torneo `closed` sin salida de producto (BE-01, P1→P2, B); sin retención de `jobs` ni de `audit_log` (BE-10); sin métricas de cola (BE-04). Gestión de usuarios sin listado ni baja (TD-023).
10. **TLS**: certificado autofirmado por defecto o proxy propio; sin emisión ni aviso de caducidad (OPS-09, P2, B). La primera impresión es un aviso de seguridad del navegador.
11. **Sin desinstalación** (OPS-10, P2, C).
12. **Ejecución en host compartido**: los límites del compose suman ≈19,5 CPU y ≈12,75 GiB en `production` (cálculo del autor, no reserva) y la propia instalación de referencia ya se vio afectada por carga en el hipervisor. Una demo con tráfico real sobre el mismo host puede degradarla (REVISION-PRODUCTO §8).
13. **Documentación operativa de producción desfasada**: «11 healthy + backup» (13 servicios), `installation.md` dice que el proxy es «opcional… hoy apagado en producción» y el orden `up → bootstrap` deja `bot-build-worker` en bucle de reinicio sin avisar (OPS-13, P3, A).

### 2.3 Complejidad y acoplamiento

- **Superficie grande para el tamaño del equipo**: 14 servicios de aplicación más 8 de observabilidad, 10 apps, 13 paquetes, 22 migraciones, 106–107 operaciones de API, 6 workflows, 71 TD registradas en 1.444 líneas (`technical-debt.md`), 18 ADR, ≈20 scripts de mutantes. Tres lenguajes en el producto (TypeScript, Python en SDK/runtimes/scripts, shell) más Docker/nginx/iptables.
- **Los paquetes no son paquetes**: sólo cinco declaran dependencias `@s9/*`; el resto se importa por rutas relativas entre apps (`replay-service` → `arena-engine/src/replay.js` y `api/src/db/connection.js`; la API importa `leagueTable` de `tournament-worker/src/results.ts`; BE §6). Cualquier extracción a servicio independiente exige deshacer eso.
- **El gateway de espectador vive en el proceso del motor** (STR-08, P3, C): el pico de espectadores compite con el tick; cada snapshot se proyecta tres veces aunque no haya clientes y cada mensaje retrasado crea un `setTimeout` sin comprobar `bufferedAmount`.
- **Los workers con credenciales de BD comparten red con los bots** (SEC-04, P2, C; REV-04, P2, B): `tournament-worker` y `bot-build-worker` están en `data` y `arena`; el bot sólo en `arena`, desde donde alcanza esos puertos y a otros bots.
- **Regla arma↔munición en tres sitios** (validador, motor, elegibilidad de la API) sin función compartida (ARQ-07, P3, C); coherente hoy, sostenida por tests y comentarios cruzados. El caso histórico RC5.3/5.4 ya salió mal una vez.
- **Versión del motor duplicada a mano** (`rules-doc.ts:68,149`, ejemplos de protocolo y SDK) sin test que la cruce con `engine-deps.json` (ARQ-03, P3, B); el test «repo al día» es autoconsistente y no la vería.
- **Cada subida de motor invalida todo el histórico verificable** (decisión consciente ADR-022/024; STR-04, P3, C) y, además, los consumidores que re-simulan sin pasar por la comprobación de versión producirían datos erróneos **en silencio**: el job de estadísticas ya es uno (ARQ-01, P2, B). Los ratings no tienen política ante un cambio de motor (ARQ-06, P3, D).
- **Código muerto** conservado en `src/` (ARQ-09, P4, C): `match.ts`, `checkpoint.ts`, `POST /run`; y un servicio, `map-service`, desplegado sin uso (TD-017).
- **Validación de entrada manual** en 106 operaciones, sin derivarla del esquema que el propio contrato ya declara (BE-05, P2, C); 35 `.catch(() => null)` convierten errores de BD en 404 y borran el contrato `db_unavailable` que el worker sí trata (BE-06, P2, C).

### 2.4 Inconsistencias

- **README/roadmap vs código vs CI**: la documentación de estado dice motor 0.4.0, migraciones 016, OpenAPI 0.12.0, 12 servicios; el código dice 0.5.0, 022, 0.25.0, 13. TD-066 afirma defectos que el código ya no tiene (clave en argv, sin retención, sin alertas; STR-11) y `known-issues.md` los repite; TD-015 declara bloqueado un cierre que el código ya resuelve (DOC-03).
- **Recuentos que variaban entre informes**, ya resueltos por el director: el contrato `apps/api/openapi.yaml` tiene 106 operaciones (DOC-12 decía 107), y hay 51 PR abiertos, 29 de ellos «NO MERGEAR» (DOC-13 decía ≈35 de ≈52). La variación refleja que no existe una cifra canónica publicada, no un defecto del producto.
- **Una «fortaleza» que no lo es**: la web interpreta `Retry-After` en los 429, pero la API **nunca lo emite** (`grep` vacío en `apps/api/src`; REVISION-TECNICA D-08). Es una fortaleza latente, no efectiva, y rompe el import portable de un operador (BE-07).
- **Verdes sin contenido**: `deploy-staging` y `smoke-and-promote` salen `success` siendo no-op, y el «Semáforo CI» queda neutral; el recuento «26/26 jobs verdes» incluye esos jobs (28 jobs en el run) (QA-04, P3).
- **Sin registrar**: el color blanco en emisión (STR-05) y TD-064 (corrección de `init-secrets.sh` perdida en una rama, DOC-04) no figuran en el registro de deuda de main.
- **Rutas de documentación inexistentes** citadas en comentarios de código y compose (el propio `docs/README` lo reconoce) y enlaces a `docs/despliegue.md`.
- **Streaming V1 en documentos**: la arquitectura aún marca YouTube «BLOCKED» mientras el operador afirma emisión real (STR-12).

### 2.5 Seguridad: lo que ni está probado ni se ha podido probar

<a id="rev-01"></a>
- **REV-01 — la prueba de aislamiento de red del sandbox está vacía** (P2 (REVISION-TECNICA) → **P1, grupo A (DECISIONES-DIRECTOR)**; V-07 `CODE_VERIFIED`). `tests/sandbox-escape/run-escape-suite.sh:52,88` crea una red `--internal` ad hoc **sin otros contenedores** y con `--dns 0.0.0.0`; `bots/05_internal_network_scan.py:7-8` prueba nombres que ni existen allí ni resuelven. El marcador «SANDBOX-BLOCKED» sale siempre. En el compose real, `tournament-worker` (L360, también en `data`) y `bot-build-worker` (L535) comparten la red `arena` con los bots. La suite figuraba como PASS de aislamiento en QA (B-10) y como respaldo de «sandbox conforme y con E2E en CI» en SEC: esa frase debe retirarse para la red. Consecuencia práctica: SEC-04, TD-033 y REV-04 **no tienen ningún control que pueda ponerse rojo**; la alcanzabilidad efectiva de los puertos es `NO VERIFICADA (FASE 2)`.
- **Canal entre bots que salta las reglas del juego** (REV-04, P2, B): la red `arena` es un único bridge `internal` para todas las batallas; DNS anulado no impide barrer la subred por IP. Dos bots del mismo dueño o equipo pueden hablar por TCP directo, eludiendo radio y visión (explotación no probada).
- **Agotamiento sin cuota** (REV-02, REV-03; P2, B): `POST /replays/{id}/verify` re-simula una batalla completa en el proceso de la API y la única limitación (`anonQuota`) no aplica a usuarios autenticados; las batallas de práctica no tienen cuota, ni autor registrado, y comparten la cola FIFO con los torneos. Con registro abierto cualquiera encadena verificaciones o encola miles de prácticas.
- **Registro abierto con rol `developer` y sin interruptor** (SEC-02, P2, A), sin verificación de email; **cuentas sin ciclo de vida** (UX-02/SEC-03/TD-012; P1 si registro a externos): `/auth/recover` crea el token y lo descarta (`auth.ts:386-448`); sin cambio de contraseña ni pantallas 2FA/sesiones.
- **Cuenta admin sembrable** (SEC-14/REV-05, P3→P2, B): `cli seed` sin guarda de entorno crea cuentas de desarrollo con contraseña pública y concede `admin` a una cuenta preexistente sin cambiarle la contraseña; con registro abierto, quien registre antes ese email se queda el rol.
- **Cabeceras** (SEC-01, P2, A): la SPA se sirve sin CSP, `X-Frame-Options`, `nosniff` ni `Referrer-Policy` (la API sí las emite); sin sumideros `innerHTML` en `apps/web/src`, el riesgo es sobre todo clickjacking sobre la consola de administración.
- **Imágenes de servicio sin escanear** (TD-031, **P1, A hasta medir**; SEC-05, P2, B): base por tag, `devDependencies` y CLI de npm en las seis imágenes Node; los 74 HIGH/CRITICAL de la medición anterior no se han re-medido; REVISION-TECNICA marca la rebaja a P2 como no justificada.
- **Hardening desigual**: sólo dos servicios con `cap_drop: [ALL]`, Redis sin autenticación en la red `platform` (SEC-07, P3, C); TOTP en claro en BD (SEC-08); JWT sin longitud mínima ni rotación (SEC-12); sin `limit_req/limit_conn` en el gateway y fallo de `TRUST_PROXY_HOPS` que podría hacer global el bloqueo de login (SEC-10).
- **Topología en el repositorio** (SEC-13 / TD-008, P3 → **P2**, A sólo limpieza de ficheros): sin secretos (V-01 descarta el zip y el docx), pero `infrastructure/.env.example`, la cabecera de `nginx-behind-proxy.conf`, `smoke.sh` y comentarios exponen la instalación del operador. Es la misma clase de incidente que ya ocurrió una vez. Sin gate de CI que lo detecte.

### 2.6 Fragilidad de tests y de la señal de calidad

- **Nightly muerta desde agosto** (QA-01, P2, A; V-03/V-06): último verde programado 2026-08-04; **111 fallos en las últimas 129 ejecuciones**. No es flaky: falla de forma determinista por falta de ffmpeg y de userns sin privilegios en `nightly.yml` (6 tests en 4 ficheros), preparación que `ci.yml` sí hace; además el job repite lo que `ci` ya cubre. El rojo diario normaliza el fallo y puede ocultar una regresión real en winrate, CTF 2v2 o el determinismo. Las cifras de racha de los distintos informes (29, 40, ≥107, 111/129) eran verdades parciales; manda la del director.
- **Prueba de aislamiento vacía** (REV-01, arriba): un E6 verde no demuestra lo que se creía.
- **Calibración por mutantes fuera de CI**: ≈20 scripts y `tests/mutants` no corren en ningún workflow; su eficacia es afirmación de documentación (`DOC_ONLY`) y la propia CI sólo vigila las anclas de cuatro de ocho matrices (QA-02, ARQ-02; P2/P3, C). La disciplina «una prueba cuenta cuando puede ponerse roja» no se aplica de forma continua.
- **Cuatro ámbitos con tests escritos y nunca ejecutados en CI**: streaming real (`tests/streaming-e2e`), visuales (`acceptance/visual`), rendimiento del visor 60 fps y mutantes; el streaming «sale bien en vídeo» depende de ejecuciones manuales (STR-10).
- **Sin instalación ni upgrade automatizados** (QA-03, P1→P2, B): hay arranque desde cero en `functional-e2e` y una reinstalación real (tercero), pero ningún test N-1→N con datos ni rollback.
- **Sin staging real** (QA-04): la promoción no pasa por un humo HTTP en un despliegue.
- **Skips y dependencia temporal**: 86 tests saltados en la nightly, 29 `.skip`, 14 `.runIf` (QA-07); 91 ficheros con `setTimeout/Date.now/waitFor/sleep`; una caída de `acceptance` el 16-nov por aserción de retardo (211 ≥ 250 ms, QA-05). Algunos specs de streaming y replay se saltan si no hay batalla/clave sembrada y pueden dar verde sin ejercer nada.
- **Cobertura sin umbral** y `main` mergeable sin revisión humana si CI está verde (0 aprobaciones requeridas; QA-06, P3, C).
- **Evidencia de tercero no reverificable**: todo lo declarado sobre producción (reinstalación, backup, restore parcial, emisión real) viene de informes del operador. Mientras FASE 2 siga bloqueada, esa parte permanece sin confirmar.

### 2.7 Riesgos operativos y de producto

- **Streaming**: no hay evidencia de sesión larga (máximo 12 min medidos; Chromium sobre una sola página durante horas, sin reciclado; en una medición de 120 s el RSS creció 600→802 MiB) ni detección de imagen congelada (sólo blanco/uniforme) (STR-01 P2 (REVISION-TECNICA, DD), STR-02 P2, grupo C). Defecto de color blanco sin diagnosticar (STR-05). V1 no sincroniza el arranque batalla↔emisión. Streaming V2 es un documento, no producto (STR-14).
- **Replays**: v1 y 0.4.0 ilegibles y el visor no lo explica (el mismo 404 que «no existe») (STR-03, P2, B); resultado público que puede adelantarse al feed retrasado (STR-06).
- **Torneos**: `closed` sin salida (BE-01); cancelación sólo en `draft/open` (BE-08); listados sin paginar con N+1 (BE-12); batalla `running` huérfana si su job reaparece distinto (BE-13, HIPÓTESIS).
- **Producto no cubierto por ningún informe**: moderación de nombres/contenido público, baja de cuenta y aviso de privacidad (A si se aloja una instancia con registro de terceros), notificaciones de build/batalla/torneo (REVISION-PRODUCTO §2), y la primera impresión de un visitante anónimo.
- **Dependencia de decisiones del propietario**: licencia, política de temporadas ante cambios de motor, destino de los PR documentales y de #295 (reset competitivo), alcance de «presentable».
- **Estado de producción no verificable ahora**: FASE 2 bloqueada; versión desplegada, replays conservados, jobs atascados y capacidad real siguen `UNKNOWN`.

### 2.8 Lo que no se debe sobrevalorar de la base técnica

El núcleo (motor, cola, sandbox, contrato de API) es sólido y no se ha encontrado ningún P0 ni ningún P1 con ruta de explotación concreta. Esa solidez es de **diseño y de camino feliz**; en esta auditoría no se ha ejecutado nada, y la parte que más se citaba como respaldo de seguridad de red (REV-01) resultó no medir lo que decía. «READY_WITH_CONDITIONS» en motor, backend, seguridad y streaming V1 significa «bien construido y con condiciones por cumplir», no «probado». Veredicto global de la auditoría: **NOT_READY para presentación pública hoy**; el camino es corto en código y largo en producto (DECISIONES-DIRECTOR).

---

## 3. Resumen de una página

| Pregunta | Respuesta honesta |
|---|---|
| ¿Funciona el producto? | El camino feliz sí en CI (golden de navegador real, batalla real en contenedor, backup/restore sintético), `TEST_VERIFIED` sobre 8f380eb. En producción: evidencia de tercero. |
| ¿Se puede instalar sin los autores? | No con la guía actual: el stack queda verde y no ejecuta batallas (OPS-01); 11 intervenciones manuales en la reinstalación de referencia. No medido con una persona ajena. |
| ¿Se puede presentar? | No hoy: licencia, README falso, instalación incompleta, `.env.example` erróneo, prueba de aislamiento vacía, nightly muerta, sin release. |
| ¿Dónde está el riesgo técnico real? | Aislamiento de red del sandbox no probado y canal entre bots (REV-01/04), agotamiento sin cuotas (REV-02/03), imágenes de servicio sin escanear (TD-031), consumidores que re-simulan sin comprobar versión (ARQ-01). |
| ¿Qué es más barato de arreglar y más visible? | README, LICENSE, cabeceras de la SPA, nightly, `.env.example`, cerrar PR «NO MERGEAR», capturas: todo S. |
| ¿Qué depende de FASE 2? | Instalación por tercero, restore completo, trivy de imágenes, alcance de red de los bots, coste de `verify`, sesión larga de streaming, color en emisión, estado real de producción. |
