# 05 · Revisión de seguridad

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: modelo de amenazas resumido, controles verificados con su evidencia, hallazgos de seguridad (SEC- y REV-) con severidad final, configuración por defecto de una instalación nueva y dependencias. Veredicto global: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Deuda asociada: [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md). Calidad de las pruebas de seguridad: [08-TEST-QUALITY.md](08-TEST-QUALITY.md).

## 1. Veredicto de seguridad

**READY_WITH_CONDITIONS, con condiciones más duras que las del informe 05 original** (REVISION-TECNICA §7).

- No se encontró ningún P0, ni un P1 con ruta de explotación concreta (informe 05, confirmado por la revisión técnica). Sí hay un **P1 de evidencia**: la prueba de aislamiento de red del sandbox está vacía (REV-01), de modo que una garantía de seguridad citada como PASS no puede fallar.
- Para una instalación nueva, lo abierto por defecto es el registro libre con rol `developer` (SEC-02), la SPA sin cabeceras (SEC-01) y la trampa de `cli seed` (SEC-14/REV-05). Lo cerrado por defecto: ejecución real de batallas, espectador y replays públicos, métricas, `DOCKER_PROXY_URL` vacío.
- Casi todo es CODE_VERIFIED. TEST_VERIFIED sólo para lo que cubre el run de CI 44383512640 sobre 8f380eb (jobs `scan`, `semaforo`, `functional-e2e / container-proxy-e2e`, `docker-e2e`, `golden`) y E6 security 44383512289. Nada es PROD_VERIFIED por esta auditoría. Firewall aplicado, permisos de `.env`/`secrets/` y estado de producción **no se miraron** (prohibido en FASE 1).
- No se ejecutó `rbac-matrix.test.ts` ni se revisó endpoint a endpoint: la autorización se revisó por muestreo (RT §8).

## 2. Modelo de amenazas resumido

| Activo | Actor | Vector principal | Control principal | Brecha conocida |
|---|---|---|---|---|
| Cómputo del host (builds y batallas) | Usuario registrado malicioso | Subir código de bot que escapa del contenedor o agota recursos | Sandbox: cap-drop ALL, rootfs de sólo lectura, seccomp por allowlist, límites obligatorios, usuario no root; proxy de Docker con allowlist | Registro abierto sin cuota global (SEC-02); verify y prácticas sin cuota (REV-02/03) |
| Credenciales de BD y secreto de sesión | Bot en ejecución | Alcanzar `tournament-worker`/`bot-build-worker` por la red `arena` | Redes `internal`, tokens por sesión, `maxPayload`, validación de envelope | Mismo segmento que los bots (SEC-04/REV-04); **prueba de red vacía (REV-01)** |
| Integridad competitiva | Bots del mismo dueño/equipo | Canal TCP lateral entre contenedores que salta las reglas de radio/visión | Reglas del motor | Sin ICC desactivado ni red por batalla (REV-04) |
| Cuentas y datos personales | Atacante externo | Fuerza bruta, enumeración, toma de cuenta | Argon2id, bloqueo a 20 fallos, JWT 15 min, refresh rotado con detección de reutilización | Sin cambio de contraseña ni recuperación (SEC-03); oráculo de emails (SEC-06) |
| Disponibilidad de la API | Usuario autenticado | `POST /replays/{id}/verify` repetido; encolar prácticas | Rate limit compartido en BD para auth | Sin cuota por usuario en verify ni prácticas (REV-02/03) |
| Superficie web | Visitante / atacante | Clickjacking, XSS, contenido de bots en la UI | CSP y XFO sólo en la API; sin sumideros `innerHTML`/`dangerouslySetInnerHTML`/`eval` en `apps/web/src` | SPA sin cabeceras (SEC-01) |
| Cadena de suministro | Dependencias e imágenes | CVE en bases y herramientas de desarrollo | `npm audit` + Trivy `fs` en CI; runtimes de bots escaneados (E6) | Imágenes de servicio sin escanear (SEC-05/TD-031) |
| Secretos de emisión | Insider / fuga de BD | Leer la clave de emisión o el TOTP | Claves selladas con RSA-OAEP+AES-GCM, sin argv/env/logs | TOTP en claro (SEC-08) |
| Repo público | Reconocimiento | Topología del operador en ficheros rastreados | Sin secretos commiteados | Valores de la instalación del operador en ficheros rastreados (SEC-13/TD-008) |

Fuera de modelo en FASE 1: compromiso del host, del hipervisor, del proxy inverso del operador y del almacenamiento de backup externo.

## 3. Controles verificados

Estado de evidencia por control. «CI» = ejecutado en un run citado de 8f380eb; que un test exista no lo hace TEST_VERIFIED aquí.

| Control | Qué se verificó | Evidencia | Estado |
|---|---|---|---|
| Sin `docker.sock` en servicios | Escáner de compose en CI | job `scan` en success, run 44383512640 | TEST_VERIFIED |
| Proxy de Docker acotado | Sólo crear/arrancar/parar/inspeccionar/borrar/listar; imagen de `DIGESTS.lock`; labels `s9.*` impuestas; cliente por IP de socket | `apps/bot-manager/src/docker-proxy.ts:1-100,316-450,926-936` | CODE_VERIFIED |
| Postura del contenedor del bot | Límites de CPU/memoria/pids con techo, `MemorySwap == Memory`, no root, `CapDrop ALL`, rootfs de sólo lectura, `/tmp` noexec, DNS `0.0.0.0`, una sola red; seccomp sin ptrace/mount/bpf/unshare | `docker-proxy.ts:316-450`, `compliance.mjs`, `seccomp-bot.json`; E2E `container-proxy-e2e` success (44383512640) | CODE_VERIFIED + TEST_VERIFIED (postura; **no la red**, ver REV-01) |
| Build fuera de la API | La API sólo encola; el worker corre el sandbox y firma el artefacto (ed25519) | `QueueBotManager`; verificación con clave pública en el worker de batallas | CODE_VERIFIED |
| JWT fail-closed | Sin secreto no arranca; sin longitud mínima ni `kid` | `apps/api/src/auth/tokens.ts:48-80` | CODE_VERIFIED (mínimo ausente: SEC-12) |
| Sesión | Access 15 min en memoria; refresh opaco rotado por familia, reutilización revoca la familia, tope 30 d, sesión comprobada en BD | `tokens.ts:25-40`, `routes/auth.ts:228+`, `apps/web/src/api.ts:7-70` | CODE_VERIFIED |
| Contraseñas y fuerza bruta | Mínimo 12 caracteres, Argon2id, hash señuelo anti-enumeración en login, bloqueo a 20 fallos por `ip\|email`, límites compartidos en BD | `routes/auth.ts`, `auth/passwords.ts`, `shared-rate-limit.ts` | CODE_VERIFIED |
| RBAC | Guard por rango desde el contrato OpenAPI; `safeLookup` contra `__proto__`; propiedad por dueño/equipo/staff | `registry.ts`, `middleware/authenticate.ts`, `routes/bots.ts:98-110,367-380,648`; RT revisó el registro de roles del contrato (106 operaciones) y muestreó usuarios, admin, equipos, torneos, bots, mapas | CODE_VERIFIED por muestreo; matriz **no ejecutada** |
| Replays a anónimos | Gateway devuelve 404 en `/replays*`; la API autoriza (TD-004) | `infrastructure/gateway/nginx.conf:124-131` + test sobre la conf real | CODE_VERIFIED; TEST_VERIFIED por el job de tests de CI (no se vio rojo) |
| Espectador en vivo | Ticket de un solo uso por subprotocolo, secreto/issuer/audiencia distintos, `maxPayload` 64 KiB, tope 100 clientes/batalla, proyección por audiencia | `apps/api/src/spectate/gateway.ts` | CODE_VERIFIED |
| Secretos | Aleatorios por fichero (0400); sin `.env`, `.pem` ni `secrets/*.txt` en `git ls-files` | `init-secrets.sh`; `git ls-files` | CODE_VERIFIED (permisos en host: UNKNOWN, TD-060) |
| Secretos de emisión | Clave sellada; ffmpeg no conoce destino ni clave (`pipe:3`) | `apps/streamer/src/ffmpeg.ts:33`, `packages/stream-secrets`, `secret-surfaces.test.ts` | CODE_VERIFIED |
| Superficie de red | Sólo el gateway publica 80/443; redes `internal`; `bot-control` con subred fija | `docker-compose.yml:100-112,1197-1245` | CODE_VERIFIED |
| Workflows | Sin `pull_request_target`; login/push a GHCR sólo en main; `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` | `.github/workflows/*`; `gh api …/actions/permissions/workflow` (RT, lectura) | CODE_VERIFIED + lectura de GitHub |
| Protección de `main` | 4 checks obligatorios (`semaforo` + 3 `functional-e2e`), `strict`, administradores incluidos, 0 revisiones requeridas | API de protección (QA-06, RT) | CODE_VERIFIED |
| XSS | No hay sumideros `dangerouslySetInnerHTML`/`innerHTML`/`eval` en `apps/web/src` (grep vacío, RT) | `apps/web/src` | CODE_VERIFIED |
| Gate de dependencias | `scan-gate.mjs` fail-closed con estados SCAN_ERROR/NOT_EXERCISED distintos de CLEAN; excepción datada | `infrastructure/scripts/scan-gate.mjs`; job `scan` success | TEST_VERIFIED |

Verificaciones que la revisión técnica retira o matiza:
- «Sandbox conforme y con E2E en CI» (informe 05 §8) y «B-10 PASS» (informe 08) **no valen para la red**: ver REV-01. Sí valen para la postura del contenedor.
- «Pruebas calibradas con mutaciones para proxy, firewall y gateway de replays» es afirmación: corren en el job de tests de CI, pero no se ejecutaron ni se vieron en rojo en esta auditoría.
- «429 con Retry-After» como fortaleza de la web es latente: la API nunca emite la cabecera (BE-07, RT D-08).

## 4. Hallazgo destacado: la prueba de aislamiento de red está vacía

<a id="rev-01"></a>
### REV-01 · La prueba de red del sandbox de bots es vacía: no puede ponerse roja

- **Severidad final: P1 · Grupo A** (RT: P2/B → **P1/A, DECISIONES-DIRECTOR**). Tipo: DEFECTO_CONFIRMADO (de la prueba). Origen: REVISION-TECNICA §4 y §6; verificación V-07 del director.
- **Estado de evidencia: CODE_VERIFIED** (director, V-07, y revisor técnico). La alcanzabilidad efectiva de puertos en la topología real es **NO VERIFICADA (FASE 2)**.
- **Qué pasa.** `tests/sandbox-escape/run-escape-suite.sh:52,88` crea una red Docker `--internal` ad hoc (`arena-escape`), vacía, y ejecuta los bots de ataque con `--dns 0.0.0.0`. `tests/sandbox-escape/bots/05_internal_network_scan.py:7-8` intenta conectar a `arena-api`, `postgres`, `redis` y `bot-manager`: nombres que no existen en esa red y que no se resuelven sin DNS. El marcador «SANDBOX-BLOCKED» sale siempre.
- **Topología real.** En `infrastructure/docker-compose.yml:292,360,535,855` el bot comparte la red `arena` con `tournament-worker` (L360, también en `data`, con credenciales de BD), `bot-build-worker` (L535) y con los demás bots. El workflow que la lanza es `.github/workflows/e6-security.yml:106`.
- **Impacto.** Una garantía de seguridad citada como PASS en CI (E6), en QA (B-10) y en SEC (§8) no está probada. Para SEC-04, TD-033 y REV-04 no hay ningún control que se ponga rojo. Invalida la evidencia de aislamiento de red, no la de postura del contenedor.
- **Corrección.** Ejecutar el escaneo dentro de la red `arena` del stack real (p. ej. en `container-proxy-e2e`), por IP de subred y puertos reales de los workers, con un **control positivo** que demuestre que la prueba ve un puerto abierto cuando lo hay. Esfuerzo M, incertidumbre media.
- **Validación.** Mutante «añadir un servicio con puerto abierto a `arena`» debe poner la prueba roja. FASE 2 (R1): barrido de la subred por IP y conexión a los puertos de los workers desde un bot real; cualquier conexión no prevista lo confirma.
- Estado de la batería: B-10 queda **corregido** en [08-TEST-QUALITY.md](08-TEST-QUALITY.md#7-batería-mínima-de-pruebas) (el PASS de red se retira).

## 5. Hallazgos SEC-

Severidad final según la regla de consolidación (DECISIONES-DIRECTOR §Reglas). Informe origen: 05 salvo indicación.

<a id="sec-01"></a>
### SEC-01 · La SPA se sirve sin ninguna cabecera de seguridad

- **P2 · Grupo A (DECISIONES-DIRECTOR; informe 05: B)** · DEFECTO_CONFIRMADO · CODE_VERIFIED.
- `infrastructure/docker/web/nginx.conf` sólo añade `Content-Type`/`Cache-Control` (líneas 58, 66, 72, 87); el gateway sólo HSTS (`gateway/nginx.conf:88`, `nginx-behind-proxy.conf:60,71`). CSP, `nosniff`, `X-Frame-Options` y `no-referrer` existen sólo en la API (`middleware/context.ts:29-31`). La consola de administración y el editor se pueden enmarcar.
- Atenuante: sin sumideros de XSS en `apps/web/src`; el clickjacking sigue.
- Corrección: `add_header … always` en el gateway (CSP con excepción del visor/`/broadcast`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) y test sobre la conf real; validar con el job `golden`. S (M si la CSP del visor/Phaser lo exige), incertidumbre media.
- No se comprobó si el proxy inverso del operador añade cabeceras (FASE 2, verificación 1).

<a id="sec-02"></a>
### SEC-02 · Registro abierto con rol `developer`, sin verificación ni interruptor

- **P2 · Grupo A (DECISIONES-DIRECTOR; informe 05: B)** · RIESGO · CODE_VERIFIED. Histórica P1 (TD-012).
- `apps/api/src/routes/auth.ts:147-175`: sin flag, inserta `user` y `developer`. Límites existentes: 30 registros/min/IP, 60 versiones/h por usuario, límites por contenedor. Nada impide registrar el email de otra persona. Es la principal puerta abierta por defecto para un tercero.
- Corrección: `REGISTRATION_MODE=open|invite|closed` en runtime-settings (existe `RuntimeSettingsStore`), por defecto cerrado o invitación; cuota global de builds en cola. M, baja. Criterio D6 de salida. Enlazado con SEC-03 y TD-012.

<a id="sec-03"></a>
### SEC-03 · Gestión de cuenta incompleta

- **P2 · Grupo A para cambio de contraseña y reset asistido por admin; B para recuperación autónoma por email (DECISIONES-DIRECTOR)** · FALTA · CODE_VERIFIED. Cruza UX-02 (P1 condicional, RT D-01) y TD-012.
- `POST /auth/recover` crea el token y lo descarta (`auth.ts:386-396,440-448`: no se loguea); sin cambio de contraseña ni pantallas 2FA/sesiones. Sin recuperación, el operador no tiene CLI para resetear: debe escribir un hash Argon2 por SQL.
- Condición: P1/A si el lanzamiento abre registro a externos (es el valor por defecto actual); P2/B con invitación o cerrado (RT D-01).
- Corrección: cambio con reautenticación (existe `requireStrongReauth`), reset asistido y auditado, pantallas. S-M (A); L el canal de email.

<a id="sec-04"></a>
### SEC-04 · El anfitrión de sesiones de bots (con credenciales de BD) comparte red con los bots

- **P2 (P1 → P2, TD-033; RT: justificada con condición) · Grupo C** (REV-04, mismo recurso, es B) · RIESGO · CODE_VERIFIED el diseño, explotación UNKNOWN.
- `docker-compose.yml:360,535,855`: `networks: [platform, data, arena, bot-control]`, con `postgres_password`, `jwt_secret`, `artifact_verify_key`. El bot alcanza esos puertos y a otros bots. Un fallo en el servidor de protocolo (WS) daría ejecución en un proceso con acceso a la BD. Mitigaciones reales: `maxPayload`, validación de envelope, tokens por sesión.
- Condición de la revisión técnica: la verificación 5 de FASE 2 pasa a **obligatoria**, porque la mitigación no tenía prueba que pudiera ponerse roja (REV-01).
- Corrección: separar el anfitrión de sesión sin credenciales o ICC desactivado/reglas por puerto en `arena`. L, incertidumbre alta. Nota TD-043: P2 → P3.

<a id="sec-05"></a>
### SEC-05 · Imágenes de servicio sin escaneo y con herramientas de desarrollo (TD-031)

- **P2 (informe 05) → TD-031 se mantiene P1 provisional (REVISION-TECNICA §5, DECISIONES-DIRECTOR) · Grupo A hasta medir** · DEUDA · CODE_VERIFIED; el recuento actual es UNKNOWN.
- `infrastructure/docker/node-service/Dockerfile:9,21`: base por tag, `npm ci --ignore-scripts` sin `--omit=dev`; `ci.yml:878-880`: el único `scan-type` es `fs`; E6 sólo cubre runtimes de bots. La cifra de 74 HIGH/CRITICAL es de 2026-10-16 y **no se re-midió**; la rebaja se apoyaba en «sin ruta de explotación» sin inventario.
- Corrección: base por digest, etapa final `--omit=dev`, job de Trivy sobre las imágenes construidas con control negativo. M. FASE 2 (R4): `trivy image --severity HIGH,CRITICAL` sobre las 6 imágenes Node; el recuento decide P1 o P2.

<a id="sec-06"></a>
### SEC-06 · Oráculo de cuentas por email

- **P3 (TD-041 P2 → P3, RT: justificada) · Grupo C** · DEFECTO_CONFIRMADO · CODE_VERIFIED. `auth.ts:158-160` (409 `email_taken`); `teams.ts:187-199` (201 frente a «Usuario no encontrado»; alta inmediata y sin consentimiento, con lectura del código del equipo). Corrección: invitaciones aceptadas; mensaje uniforme. M.

<a id="sec-07"></a>
### SEC-07 · Hardening desigual y Redis sin autenticación

- **P3 · Grupo C** · DEUDA · CODE_VERIFIED. Sólo `streamer` y la plantilla de bot usan `cap_drop: [ALL]`; los servicios Node arrancan como root un instante y bajan a `node` con `su-exec`; Redis (`queue`) sin contraseña en la red `platform` que comparten gateway, web, API y workers (`docker-compose.yml:664-698,834,861`). Reducción de superficie ante compromiso previo, sin ruta concreta. M.

<a id="sec-08"></a>
### SEC-08 · Secreto TOTP en claro en la base de datos

- **P3 · Grupo C** · HIPÓTESIS (almacenamiento en claro CODE_VERIFIED: `db/migrations.ts:43`, `auth.ts:126-128,210-212,348`). Una fuga de BD o de backup permitiría generar TOTP de todos los usuarios con 2FA; los códigos de recuperación sí van hasheados. No se miró cifrado de disco. S-M.

<a id="sec-09"></a>
### SEC-09 · `/version` servido en el puerto 80 publicado

- **P3 · Grupo C** · HIPÓTESIS. El comentario del gateway dice «sólo red interna» pero `HTTP_PORT:80` se publica en todas las interfaces (`gateway/nginx.conf:55-68`, `docker-compose.yml:110-112`). Expone commit y fecha de build. Alcance real UNKNOWN (depende de firewall y modo). S. FASE 2 (verificación 10).

<a id="sec-10"></a>
### SEC-10 · Sin límites a nivel de gateway; punto de fallo de `TRUST_PROXY_HOPS`

- **P3 · Grupo C** · RIESGO · CODE_VERIFIED; valor real UNKNOWN. nginx sin `limit_req`/`limit_conn` (ni `/grafana/`, `/ws/` ni web). Por defecto 1 salto; detrás de proxy externo hacen falta 2, o todos los clientes comparten IP y el bloqueo de 20 fallos pasa a ser global (DoS de login). `POST /auth/reset` sin limitador propio (el token de 24 bytes lo hace inviable por fuerza bruta). S. FASE 2 (verificación 6).

<a id="sec-11"></a>
### SEC-11 · Workflows: acciones por tag mutable, sin Dependabot

- **P3 → P4 (REVISION-TECNICA) · Grupo C** · DEUDA. La duda sobre permisos del token quedó resuelta por RT: `default_workflow_permissions: read` y `can_approve_pull_request_reviews: false`. Queda fijar acciones por SHA y añadir `.github/dependabot.yml` (no existe). S.

<a id="sec-12"></a>
### SEC-12 · Secreto JWT sin longitud mínima ni rotación

- **P3 · Grupo C** · FALTA. `resolveSecret` sólo exige no vacío (`tokens.ts:48-80`); rotar invalida sesiones y tickets (HKDF). Corrección: mínimo ≥32 al arrancar y runbook de rotación. S.

<a id="sec-13"></a>
### SEC-13 · Topología de la instalación del operador en ficheros rastreados (TD-008)

- **P3 (informe 05) → P2 como TD-008 (REVISION-TECNICA D-06) · Grupo A sólo para la limpieza de ficheros rastreados (DECISIONES-DIRECTOR); purga de historial grupo E.** DEUDA · CODE_VERIFIED.
- Sin secretos ni credenciales (V-01 y V-04 del director). Persisten valores de la instalación del operador en ficheros fuera de `docs/history`: cabecera de un conf de nginx, valores por defecto y comentarios en `infrastructure/.env.example`, referencias en docs y scripts de firewall, `smoke.sh` y tests. Misma clase que el incidente del PR #111. **Este documento no reproduce esos valores.**
- Seguridad: bajo valor (dominio ya público, direccionamiento privado). Producto: plantilla errónea para terceros (ver OPS-04). El historial git lo conserva todo.
- Corrección: sustituir por valores de ejemplo, gate de CI por parseo de direcciones y nombres de host (hoy `NO_INTERNAL_TOPOLOGY` sólo mira docs). S-M.

<a id="sec-14"></a>
### SEC-14 · `cli.ts seed` crea cuentas de desarrollo (incluida `admin`) con contraseña pública

- **P3 → P2 (REVISION-TECNICA D-02) · Grupo B** · RIESGO · CODE_VERIFIED. `apps/api/src/db/cli.ts:9-14,63-66`, `db/seeds/dev.ts:27,79-89`; `first-run.md:142` lo prohíbe y la doc de instalación no lo menciona. Sin guarda de `NODE_ENV`. Se funde con REV-05. Corrección: negarse fuera de desarrollo explícito (flag + BD local). S.

## 6. Hallazgos REV- de seguridad

Origen: REVISION-TECNICA §6. Todos CODE_VERIFIED salvo donde se indica.

<a id="rev-02"></a>
### REV-02 · `verifyReplay` re-simula una batalla completa en el proceso de la API sin cuota

- **P2 (P1 si FASE 2 mide >1 s por verificación de una batalla larga) · Grupo B, condicional: pasa a A si la medición de FASE 2 > 1 s con registro abierto (DECISIONES-DIRECTOR)** · RIESGO · coste por verificación UNKNOWN.
- `POST /replays/{id}/verify` → `verifyLoaded` → `resimulateReplay` en el proceso Node de la API (`routes/replays.ts:290-342`, `replay-service/src/store.ts:270-289`, `arena-engine/src/replay.ts:745-749`). La única limitación, `anonQuota`, no aplica a usuarios autenticados (`anon-quota.ts:15,20`); no hay limitador por usuario ni de concurrencia (`app.ts:155-213`). Con registro abierto, un usuario encadena verificaciones y satura el bucle de eventos: cae login, web y panel.
- Corrección: limitador por usuario y concurrencia global 1-2, caché por `battleId`+hash, o mover a un job de la cola. S-M.
- FASE 2 (R2): medir `verify` de una batalla CTF con prórroga; 10 en paralelo con un usuario y latencia de `/api/v1/users/me`.

<a id="rev-03"></a>
### REV-03 · Prácticas sin cuota por usuario, sin autor registrado, en cola FIFO compartida con torneos

- **P2 · Grupo B** · RIESGO. `routes/battles.ts:614-663` (sin limitador; `battles` sin `created_by`; sin auditoría); `tournament-worker/src/queue.ts:95-118` (`ORDER BY created_at, id`, sin prioridad); `app.ts:178-186` (limitadores sólo de versiones). Un usuario nuevo puede retrasar horas un torneo y el operador no puede atribuir el abuso. Corrección: cuota de prácticas activas por usuario, prioridad de `run_battle` oficiales, `created_by` + auditoría. S-M. FASE 2 (R3).

<a id="rev-04"></a>
### REV-04 · Canal lateral entre bots por la red `arena` compartida

- **P2 · Grupo B (A si la versión presume de competiciones públicas con premio; DECISIONES-DIRECTOR)** · RIESGO (diseño confirmado, explotación no probada). Red `arena` única `internal` (`docker-compose.yml:1229-1235`); el proxy fija `NetworkMode` a `arena` (`docker-proxy.ts:385-386,931`); sin `icc`/`enable_icc`. DNS anulado no impide barrer la subred por IP. Bots del mismo dueño o equipo pueden hablar por TCP, saltándose radio/visión del motor y el anti-coaching. Corrección: red por batalla o ICC desactivado + reglas bot→puerto de sesión; el proxy exige el nombre literal `arena`. M, incertidumbre media. FASE 2 (R1): dos bots, uno escucha y el otro barre la subred.

<a id="rev-05"></a>
### REV-05 · `cli seed` concede `admin` a una cuenta preexistente sin tocar su contraseña

- **P2 · Grupo B** · DEFECTO_CONFIRMADO. `seedDev` reutiliza la cuenta si el email ya existe y le inserta el rol (`onConflict…ignore`) sin cambiar su contraseña (`seeds/dev.ts:27-34,73-89`, `cli.ts:63-66`, `auth.ts:26`). Con registro abierto y `EMAIL_RE` permisivo, quien registre antes el email de la cuenta semilla obtiene `admin` cuando alguien ejecute `seed`. No exige explotación remota: exige un error del operador contra una prohibición documentada (por eso no P1). Corrección: ver SEC-14, y fallar si alguna cuenta semilla existe con otra contraseña. S. FASE 2 (R6).

<a id="rev-06"></a>
### REV-06 · `setUserRoles` puede dejar la instalación sin administradores

- **P3 · Grupo C** · DEFECTO_CONFIRMADO. `routes/users.ts:38-63`: sustituye todos los roles sin guarda de «último admin» ni de auto-degradación. Combinado con OPS-02 (sólo SQL para crear admin), un error en la web deja al operador sin panel. S.

<a id="rev-07"></a>
### REV-07 · El manejador de errores 500 vuelca el error de BD completo al log

- **P3 · Grupo C** · HIPÓTESIS (volcado CODE_VERIFIED en `app.ts:220-233`, contenido real UNKNOWN). Los errores de unicidad de PostgreSQL incluyen en `detail` el valor duplicado (p. ej. el email). No hay volcado de contraseñas ni tokens. Corrección: registrar `code`/`constraint`, no `detail`. S.

### Otros hallazgos de calidad que tocan seguridad

- QA-01, QA-02: [08-TEST-QUALITY.md](08-TEST-QUALITY.md). BE-06/BE-07/BE-11: [04-TECHNICAL-DEBT.md](04-TECHNICAL-DEBT.md) (BE-06 es el oráculo de existencia de bots del issue #247).

## 7. Seguridad de la configuración por defecto de una instalación nueva

Con `infrastructure/.env.example` y la guía de instalación:

| Aspecto | Valor por defecto | Estado | Referencia |
|---|---|---|---|
| Ejecución real de batallas | Apagada (`DOCKER_PROXY_URL` vacío; las batallas quedan en `scheduled`) | Cerrada, pero **la guía no explica cómo activarla** (OPS-01) | [OPS-01](07-INSTALLATION-OPERATIONS.md#ops-01) |
| Espectador público, replays públicos, métricas | Apagados | Cerrado | `.env.example:128-133` (RP) |
| Registro de cuentas | **Abierto**, rol `developer`, sin verificación | **Abierto** | SEC-02 |
| Primer administrador | `INSERT` SQL manual | Fricción documentada; sin `create-admin` | OPS-02 |
| SPA | Sin CSP/XFO/nosniff | **Abierto** | SEC-01 |
| `cli seed` | Disponible sin guarda; cuentas con contraseña pública | **Trampa** | SEC-14, REV-05 |
| Redis | Sin contraseña, red `platform` | Abierto (interno) | SEC-07 |
| `TRUST_PROXY_HOPS` | 1 (detrás de proxy externo hacen falta 2) | Riesgo de bloqueo global de login | SEC-10 |
| `TAG` | `latest` en `infrastructure/.env.example:57,79` (compose usa `${TAG:-latest}`); CI sólo publica `sha-<commit>` y `v<version>` | **Defecto: `latest` no se publica** (no se pudo comprobar si existe un `latest` antiguo en el registro de imágenes: R5, FASE 2) | [OPS-04](07-INSTALLATION-OPERATIONS.md#ops-04) |
| Valores del operador | Dominio y nombre de host proxy como defecto de `S9_DOMAIN` | Plantilla errónea para terceros (sin reproducir aquí) | SEC-13, OPS-04 |
| Certificado | Autofirmado por `init-secrets.sh` o proxy externo | Aviso del navegador en el primer arranque | OPS-09 |
| Cookie de refresh | httpOnly, SameSite=Lax, `Secure` según `req.secure` | Comprobar `Secure` tras el proxy real (FASE 2, verificación 7) | `auth.ts:54-66` |
| Secretos | Aleatorios por fichero 0400 | Bien; `.env` 0644 en el host del operador (TD-060, UNKNOWN) | `init-secrets.sh` |

Lo cerrado por defecto reduce el riesgo del día 0; lo abierto (registro, cabeceras, `seed`) es lo que un tercero hereda sin decidirlo.

## 8. Dependencias e imágenes

- **Excepción de `npm audit`**: GHSA-fc5q-39xc-vjpf (picomatch ≤ 4.0.7), `infrastructure/npm-audit-excepciones.json`, alta 2026-11-17, **caduca 2026-12-17** (28 días desde la fecha del informe). Motivo declarado: sólo herramientas de desarrollo (vite, vitest, herramientas de build); coherente con el lockfile; `scan-gate.mjs` la acota con el lockfile y compara la fecha de hoy, y se desactiva sola si pasa a dependencia de producción. Riesgo operativo: si no hay versión corregida antes del 17-12, `scan` se pone rojo y bloquea **todos** los PR; renovar con motivo o sustituir. No se verificó que `npm audit` hoy diga lo mismo (FASE 2, verificación 14). Sin hallazgo propio (P3).
- **Imágenes de servicio sin escanear (TD-031/SEC-05)**: P1 provisional hasta `trivy image` en FASE 2; las 6 imágenes Node; 74 HIGH/CRITICAL de 2026-10-16 sin re-medir.
- **Runtimes de bots**: E6 `runtime-vuln-scan` (Trivy, bloquea CRITICAL) en success en 8f380eb (run 44383512289); se salta si `DIGESTS.lock` tiene placeholders (hoy no).
- **Licencias de dependencias**: sin SBOM ni NOTICE (DOC-02): fuera de seguridad estricta, enlazado con la decisión de licencia.
- **Cadena de acciones**: por tag, sin Dependabot (SEC-11, P4).

## 9. Verificaciones de FASE 2 (todas BLOCKED (FASE 2))

FASE 2 está bloqueada hasta que cierre la migración de producción en curso y el operador confirme que no hay operaciones críticas. Nada de esta tabla se da por bueno.

| # | Qué | Prueba | Entorno | Confirma / refuta | Obligatoria |
|---|---|---|---|---|---|
| R1 (= verif. 5 del informe 05) | REV-01, REV-04, SEC-04 | Desde un bot real en `arena`: barrido de subred por IP, conexión a puertos de los workers y a otro bot que escucha; `nc -zv tournament-worker 8081` | Laboratorio aislado | Cualquier conexión no prevista confirma | **Sí** (RT) |
| R2 | REV-02 | Medir `verify` de una batalla larga y 10 en paralelo con latencia de `/users/me` | Laboratorio | >1 s o latencia degradada → P1/A | Sí |
| R3 | REV-03 | Encolar 200 prácticas y cerrar un torneo; medir espera de la primera batalla oficial | Laboratorio | Espera proporcional a la cola confirma | Sí |
| R4 (= verif. 9 del informe 05) | TD-031 | `trivy image --severity HIGH,CRITICAL [--ignore-unfixed]` sobre las 6 imágenes Node | Laboratorio | El recuento decide P1/P2 | **Sí** |
| R5 | OPS-04 | `docker manifest inspect` de `:latest` en el registro público | Lectura pública | Si existe, `TAG=latest` trae imagen antigua | Sí |
| R6 | REV-05 | Registrar el email semilla y ejecutar `seed` | Laboratorio | Rol admin con la contraseña del atacante confirma | Sí |
| 1 | SEC-01 | `curl -sI` a `/` y `/api/v1/healthz` | Producción sólo lectura | Faltan CSP/XFO/nosniff, salvo que el proxy del operador las añada | Sí |
| 2 | Firewall del host | `s9-firewall.sh check` (rc 0) y regla `S9-HOST-GUARD` primera en INPUT | Producción sólo lectura | Confirma TD-053 en el host | Sí |
| 3 | Alcance del proxy desde contenedor ajeno | Conexión al puerto del proxy desde un contenedor de `public` | Laboratorio | Timeout o 403 confirma | Sí |
| 4 | Sandbox real | Bot de prueba que intenta `connect` a otro contenedor, DNS, escribir fuera de `/tmp`, fork bomb, `mmap` exec en `/tmp` | Laboratorio | Todo denegado confirma | Sí |
| 6 | SEC-10 | 21 logins fallidos de una IP y probar otra IP | Laboratorio con la misma topología | Bloqueo de la segunda IP = salto erróneo | No |
| 7 | Cookie `Secure` | `curl -si -X POST …/auth/login` y revisar `Set-Cookie` | Laboratorio | Ausente = defecto | No |
| 8 | TD-060 | `stat -c '%a %U'` de `.env` y `secrets/` | Producción sólo lectura | 600/700 refuta | No |
| 10 | SEC-09 | `curl -s http://<host>:80/version` desde fuera de la LAN | Producción sólo lectura | Respuesta con commit confirma | No |
| 11 | RBAC | `npx vitest run apps/api/src/rbac-matrix.test.ts` + IDOR manual con dos cuentas | Laboratorio | rc 0 y sin acceso cruzado | Sí |
| 12 | Actions | `gh api …/actions/permissions/workflow` | Sólo lectura de GitHub | Ya resuelto por RT (`read`) | — |
| 13 | WS espectador | Conectar con `Origin` ajeno y ticket válido | Laboratorio | Si abre, falta la comprobación (P3) | No |
| 14 | `npm audit` | `npm audit --json` | Laboratorio | picomatch sigue siendo la única excepción | No |
| D | Visitante anónimo, privacidad | Recorrido anónimo con flags públicos en ambos valores; inventario de datos personales (email, IP en `audit_log`, sesiones) y retención | Laboratorio / lectura | Ver REVISION-PRODUCTO §9 | Sí (D3) |

La verificación 5 de SEC (alcance de bots al anfitrión) queda subsumida en R1 y es obligatoria (RT §5, TD-033).

## 10. Brechas de esta revisión

- No hay revisión endpoint a endpoint (14 operaciones de streaming de admin y `catalog/maps` de importación sin revisar, RT §8); migraciones 001-022 sólo por BE-09.
- Producción, firewall aplicado y permisos del host: no mirados.
- Los informes MIG del operador son evidencia de tercero no reverificada.
- Falta cubrir moderación de contenido público, baja de cuenta y aviso de privacidad (REVISION-PRODUCTO §2): no hay hallazgo SEC; condicionan la presentación de una instancia pública con registro de terceros.
