# 04 · Registro consolidado de deuda técnica

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: un único registro deduplicado de la deuda técnica de todas las áreas (histórica de `docs/roadmap/technical-debt.md` y `known-issues.md`, revalidada contra 8f380eb, más la deuda nueva no registrada), con prioridad revalidada, grupo de lanzamiento y propuesta de cierre o aceptación. Veredicto y contexto global: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

## 1. Cómo leer este registro

- **Prioridad**: P0 crítico-bloqueante · P1 importante (seguridad/fiabilidad/lanzamiento) · P2 relevante · P3 menor · P4 futuro. Regla de consolidación (DECISIONES-DIRECTOR): manda la severidad de REVISION-TECNICA cuando la ajusta; si no, la del autor del informe.
- **Grupo**: A bloqueante del lanzamiento · B necesaria para la versión objetivo · C poslanzamiento · D futuro · E descartar. Manda REVISION-PRODUCTO (opción A+), salvo los arbitrajes de DECISIONES-DIRECTOR. Severidad y grupo son ejes distintos.
- **Cierra versión**: «sí» = el elemento es condición del criterio de salida D1-D21 de REVISION-PRODUCTO (grupo A) o lo condiciona un gate; «no» = el resto.
- **Evidencia**: `fichero:línea@8f380eb` salvo indicación. Estados: CODE_VERIFIED, TEST_VERIFIED (run de CI citado), DOC_ONLY, UNKNOWN. Los informes MIG de producción son **evidencia de tercero (operador), no reverificada por la auditoría**.
- **Esfuerzo**: S ≤½ día · M 1-3 días · L 1-2 semanas · XL >2 semanas, con la incertidumbre que dio el informe origen. Cualquier suma es suma de estimaciones, no medición. Donde el informe no estimó, se dice «n/e».
- **Origen**: 01 arquitectura/motor · 02 backend · 03 frontend/UX · 04 devops/instalación · 05 seguridad · 06 streaming · 07 documentación · 08 QA; RT = REVISION-TECNICA; RP = REVISION-PRODUCTO; DD = DECISIONES-DIRECTOR.
- «Heredada» = ya registrada como TD-xxx antes de la auditoría; «actual» = descubierta o introducida por el estado de 8f380eb.

Los hallazgos de seguridad se detallan en [05-SECURITY-REVIEW.md](05-SECURITY-REVIEW.md), los de calidad de pruebas en [08-TEST-QUALITY.md](08-TEST-QUALITY.md), los de streaming en [09-STREAMING-REVIEW.md](09-STREAMING-REVIEW.md) y los de instalación en [07-INSTALLATION-OPERATIONS.md](07-INSTALLATION-OPERATIONS.md); aquí sólo se consolida la deuda.

## 2. Resumen cuantitativo

| Concepto | Valor | Fuente |
|---|---|---|
| Entradas TD en el índice del registro histórico | 71 (TD-001…TD-073, sin TD-050 ni TD-064 en el índice; recuento del índice con `grep`) | `docs/roadmap/technical-debt.md` @8f380eb (MAIN_SHA citado e3bf2fa, 586 commits atrás: DOC-01) |
| De ellas, marcadas CERRADA en el registro | 25 cerradas; 46 abiertas, parciales o mejoradas (recuento del índice; ver §5) | mismo fichero |
| Revalidadas por los agentes de la auditoría | TD-004, 006, 007, 008, 009, 012, 013, 015, 016, 017, 019, 020, 021, 022, 023, 024, 025, 026, 028, 031, 033, 038, 039, 041, 043, 047, 048, 051-053, 057, 059, 060, 061-063, 066, 067, 068, 071 | informes 01, 02, 03, 04, 05, 06, 07, 08 + RT §5 |
| No revalidadas (se conservan con su prioridad registrada, marcadas «sin revalidar») | TD-027, 035, 036, 037, 042, 046, 049, 054, 055, 058, 069, 070, 072, 073 | — |
| Deuda nueva no registrada | ver §4 (ARQ, BE, UX, OPS, SEC, STR, DOC, QA, REV) | informes + RT §6 |
| Propuestas de cierre por obsolescencia | TD-066 (reescribir como P4), TD-015 (sustituir por BE-01/BE-08), 3 filas de `known-issues.md` | §6 |

Los recuentos 71/25/46 salen del índice del registro histórico; la clasificación «revalidada / sin revalidar» es la de los informes de los agentes.

## 3. Deuda histórica (TD-xxx) revalidada y fusionada

Cada fila fusiona el TD con los hallazgos que lo tratan (duplicados resueltos: un mismo problema = una fila). Orden: seguridad y operación, instalación, CI/pruebas, API/torneos, motor/arquitectura, resto.

### 3.1 Seguridad y operación

| ID(s) | Sigue existiendo | Heredada / actual | Prioridad anterior → revalidada (motivo) | Cierra versión | Corrección o aceptación | Esfuerzo · riesgo | Grupo |
|---|---|---|---|---|---|---|---|
| <a id="td-008"></a>**TD-008** + [SEC-13](05-SECURITY-REVIEW.md#sec-13) + DOC (topología) + [OPS-04](07-INSTALLATION-OPERATIONS.md#ops-04) (parte) + V-04 | **Parcial.** Sin secretos; quedan en ficheros rastreados fuera de `docs/history` valores de la instalación del operador (cabecera de `nginx-behind-proxy.conf`, defecto de `S9_DOMAIN` y comentarios de `infrastructure/.env.example`, `smoke.sh`, scripts/tests de firewall). CODE_VERIFIED (SEC-13, RT D-06, V-04). El historial git lo conserva todo | Heredada (P0), reducida | P0 → **P2** (RT D-06; SEC proponía P3, DOC P1: ni P0 ni P3 ni P1) | **Sí** (D14), sólo la limpieza de ficheros | Sustituir por valores de ejemplo genéricos en ficheros rastreados; gate de CI que parsee direcciones privadas y nombres de host (hoy `NO_INTERNAL_TOPOLOGY` sólo mira docs). **Purga de historial: no** (grupo E, aceptado) | S (limpieza) · M (gate) · riesgo bajo; incertidumbre media | **A** (limpieza, DD) · **E** (purga) |
| <a id="td-012"></a>**TD-012** + [SEC-02](05-SECURITY-REVIEW.md#sec-02) + [SEC-03](05-SECURITY-REVIEW.md#sec-03) + [SEC-10](05-SECURITY-REVIEW.md#sec-10) + UX-02 + BE-11 (registro no atómico) | **Sí.** Registro abierto con rol `developer` sin interruptor (`auth.ts:147-175`); recuperación descarta el token (`auth.ts:386-396`); sin cambio de contraseña ni pantallas 2FA/sesiones; `TRUST_PROXY_HOPS` por defecto 1 (valor real UNKNOWN). CODE_VERIFIED | Heredada | P1 → **P2** (SEC) / **P1 condicional** (RT D-01: P1/A si el lanzamiento abre registro a externos, que es el valor por defecto actual; P2/B si es por invitación o cerrado). UX-02: P1→ integrado en este hallazgo | **Sí** (D6, D11) | Interruptor `REGISTRATION_MODE=open\|invite\|closed` con defecto cerrado/invitación; **cambio de contraseña + reset asistido por admin = grupo A** (DD); recuperación por email = B; limitadores del gateway y preflight de saltos de proxy = C | M (interruptor) · S-M (cambio+reset) · L (email); incertidumbre baja/media | **A** (interruptor, cambio, reset asistido) · **B** (email) · **C** (SEC-10) |
| <a id="td-031"></a>**TD-031** + [SEC-05](05-SECURITY-REVIEW.md#sec-05) | **Sí.** Base `node:22.15-alpine` por tag, `npm ci` sin `--omit=dev`, ningún job escanea imágenes de servicio (`ci.yml:878-880` sólo `fs`); 74 HIGH/CRITICAL medidos el 2026-10-16, **no re-medidos**. CODE_VERIFIED (Dockerfile) / UNKNOWN (recuento actual) | Heredada | P1 → P2 (SEC) → **P1 provisional** (RT §5: rebaja «NO JUSTIFICADA»; DD: P1/A hasta `trivy image` en FASE 2) | **Sí** (hasta medir) | Medir con `trivy image` sobre las 6 imágenes Node (FASE 2); base por digest, etapa final `--omit=dev`, job de Trivy sobre imágenes construidas con control negativo. Bajar prioridad sólo si el recuento lo respalda | M · incertidumbre media | **A** (DD) hasta medir; B después |
| <a id="td-033"></a>**TD-033** + [SEC-04](05-SECURITY-REVIEW.md#sec-04) + [REV-04](05-SECURITY-REVIEW.md#rev-04) + [REV-01](05-SECURITY-REVIEW.md#rev-01) | **Sí.** `tournament-worker` y `bot-build-worker` en `data` + `arena` con la red de los bots (`docker-compose.yml:360,535,855`; red `internal` única `:1229-1235`). Alcanzabilidad real NO VERIFICADA (FASE 2). CODE_VERIFIED el diseño | Heredada + actual (REV-01/04) | P1 → **P2** (SEC; RT: justificada **con condición**, pues la mitigación no tenía prueba que pudiera ponerse roja → REV-01) | No (la prueba REV-01 sí, ver más abajo) | Red por batalla o ICC desactivado + reglas por puerto; separar el anfitrión de sesión sin credenciales (L). Prueba E2E en la red real con control positivo (REV-01) | L (SEC-04) · M (REV-04) · incertidumbre alta/media | **B** (REV-04, DD) · **C** (SEC-04 aislado) |
| <a id="td-041"></a>**TD-041** + [SEC-06](05-SECURITY-REVIEW.md#sec-06) | Sí. 409 `email_taken`; alta inmediata a equipos (`auth.ts:158-160`, `teams.ts:187-199`). CODE_VERIFIED | Heredada | P2 → **P3** (RT: justificada) | No | Invitaciones aceptadas por el invitado; mensaje uniforme | M · baja | C |
| <a id="td-043"></a>**TD-043** | Sí. El worker monta `jwt_secret`; el ticket se deriva por HKDF (`tokens.ts:96-100`) y ya tiene la contraseña de BD | Heredada | P2 → **P3** (RT: justificada) | No | Aceptar hasta rediseñar el anfitrión (TD-033) | — | C |
| <a id="td-048"></a>**TD-048** | Sí (no reexaminada). `NODE_ENV` sin fijar; además `cli seed` no tiene guarda de entorno ([REV-05](05-SECURITY-REVIEW.md#rev-05)) | Heredada | P2 → P2 (sin cambio; SEC no la reexaminó) | No | Fijar `NODE_ENV=production` en las imágenes | S | C |
| <a id="td-060"></a>**TD-060** | **UNKNOWN** (requiere host) | Heredada | P2 → **P3** (SEC, no verificable sin host) | No | `stat` de `.env`/`secrets/` en FASE 2 | S | C · **BLOCKED (FASE 2)** |
| <a id="td-063"></a>**TD-063** | UNKNOWN (sin medir) | Heredada | P3 → P3 | No | Medir escuchas del host en FASE 2 | S | C · **BLOCKED (FASE 2)** |
| <a id="td-006"></a>**TD-006** | **Casi cerrable.** Evidencia de tercero: 13/13 contenedores en `sha-8f380eb` con `docker inspect .Config.Image` (informe-reinstalación). Estado de una instalación, no del producto | Heredada | P0 → **P3** (OPS; RT: justificada con matiz) | No | Cerrar sólo con `runtime-drift-scan` de lectura en FASE 2; no se cuenta como verificada por la auditoría | S | C · **BLOCKED (FASE 2)** |
| <a id="td-007"></a>**TD-007** + [OPS-06](07-INSTALLATION-OPERATIONS.md#ops-06) + [OPS-12](07-INSTALLATION-OPERATIONS.md#ops-12) + TD-054 | **Sí.** Alertas no probadas, `alertmanager` sólo en perfil `observability` con webhook de relleno (`docker-compose.yml:1016-1024`), poda incondicional (`backup.sh:771`); `postgres` sin `stop_grace_period` (sólo `tournament-worker`, `:354`). El backup funciona según evidencia de tercero | Heredada | P0 → **P1** (OPS; RT: justificada) | Parcial: aviso de «backup no configurado» = A (D12); resto B | Aviso el día 1 si `RESTIC_REPOSITORY` está vacío (A); poda desactivable, guía del lado servidor, `.env` en snapshot, alertas probadas, `stop_grace_period` de postgres (B) | M · media | **B** (con parte A: aviso) |
| <a id="td-025"></a>**TD-025** + [OPS-07](07-INSTALLATION-OPERATIONS.md#ops-07) | Sí. Restore: fases manuales; evidencia de tercero parcial (restore a PG temporal; informe-reinstalación sin restore completo en host nuevo). Sin ensayo cronometrado desde agosto | Heredada | P1 → P1 (sin cambio; RT: justificada) | **Sí** (D12: un ensayo completo con acta) | Ensayo completo en laboratorio con acta (A); `restore-all.sh` y automatización (B) | M · media | **B** (ensayo manual en A, RP) |
| <a id="td-062"></a>**TD-062**, TD-051, TD-052, TD-053, TD-061 | **Cerradas en código.** `docker-proxy.ts`, firewall como código, job `container-proxy-e2e` verde (run 44383512640, TEST_VERIFIED). La aplicación en el host es evidencia de tercero (informe-reinstalación). Coste restante de adopción: [OPS-03](07-INSTALLATION-OPERATIONS.md#ops-03) | Heredada | Sin cambio (CERRADA) | No | Mantener cerradas; la verificación en host es FASE 2 (`s9-firewall.sh check`) | — | — |
| <a id="td-057"></a>**TD-057**, TD-058, TD-027, TD-055, TD-054 | Sin revalidar salvo TD-057 (OPS: sin cambio) y TD-054 (ver OPS-06). TD-058 es de la instalación del operador | Heredada | P2/P3/P4 sin cambio; TD-054 P2 vigente (poda no desactivable, RT confirma `backup.sh:771`) | No | Operador; TD-054 se resuelve con OPS-06 | S | C |

### 3.2 Instalación y operación

| ID(s) | Sigue existiendo | Heredada / actual | Prioridad anterior → revalidada (motivo) | Cierra versión | Corrección o aceptación | Esfuerzo · riesgo | Grupo |
|---|---|---|---|---|---|---|---|
| <a id="td-024"></a>**TD-024** + [OPS-01](07-INSTALLATION-OPERATIONS.md#ops-01) + [OPS-03](07-INSTALLATION-OPERATIONS.md#ops-03) + [OPS-05](07-INSTALLATION-OPERATIONS.md#ops-05) + [OPS-13](07-INSTALLATION-OPERATIONS.md#ops-13) + OPS-14 + DOC-05 | **Sí.** La guía deja `DOCKER_PROXY_URL` vacío (`docker-compose.yml:308,368`) y la instalación «verde» no ejecuta batallas; `installation.md` describe runtimes y proxy como opcionales y sin el paso de `.env` ni el firewall. 0 tags, 0 releases. CODE_VERIFIED | Heredada + actual | P2 → **P1** (OPS; RT: justificada como paraguas de OPS-01/03). OPS-01 P1; OPS-03 P1; OPS-05 **P1→P2** y OPS-13 P3 (RT) | **Sí** (D1, D4, D15) | `install-host.sh` que encadene runtimes→red→firewall→proxy→`DOCKER_PROXY_URL` con preflight; bundle del proxy y sha256 como asset de release; tabla de requisitos; orden `postgres+queue → bootstrap → up` | M (+S) · media | **A** (OPS-01, OPS-05, OPS-13; OPS-03 y release mínima B en OPS, A en RP/D1, **sin arbitrar**) |
| <a id="td-020"></a>**TD-020** + **TD-059** + BE-03 (`/healthz`) + [OPS-04](07-INSTALLATION-OPERATIONS.md#ops-04) (`smoke.sh`) + OPS-12 | **Sí.** `/healthz` fijo `{status:"ok"}` (`server.ts:31`); `smoke.sh` espera 200 en `/replays/healthz`, que el gateway responde 404 (`gateway/nginx.conf:124-131`): **el humo no puede dar verde**; `/api/healthz` cae en la SPA. CODE_VERIFIED (RT) | Heredada + actual | TD-020 P2 → P2 (OPS proponía «P1 si no se arregla antes de ofrecer la guía»; RT: P2, arreglo S). TD-059 P2 → P2 (BE) | Parcial: `smoke.sh` que cree y termine una batalla = **sí** (D4, «doctor-lite»); `/healthz` con migraciones = no | Arreglar `smoke.sh` (batalla de humo); `/readyz` que compruebe BD, cola y migraciones | S-M · baja | **A** (smoke, OPS-04) · **B** (healthz/readyz, BE-03/OPS-12) |
| <a id="td-023"></a>**TD-023** + [OPS-02](07-INSTALLATION-OPERATIONS.md#ops-02) + UX-08 + [REV-06](05-SECURITY-REVIEW.md#rev-06) | **Sí.** Primer admin por `INSERT` SQL (`first-run.md:79-103`); sin `create-admin` en `cli.ts`; sin listado de usuarios; `setUserRoles` permite dejar la instalación sin admins (`users.ts:38-63`) | Heredada | P2 → P1 (OPS) → **P2** (RT: «NO JUSTIFICADA» la subida, D-05; OPS-02 P1→P2) | **Sí** (D5, sólo `create-admin`) | `cli.ts create-admin` (A, S); guarda «último admin» (REV-06, C); gestión de usuarios y selector en web (UX-08: B por RP, C por UX; sin arbitrar) | S · baja (create-admin); M (UI) | **A** (`create-admin`, DD) · B/C (UI, REV-06 C) |
| <a id="td-019"></a>**TD-019** + [QA-01](08-TEST-QUALITY.md#qa-01) + STR-09 + [QA-04](08-TEST-QUALITY.md#qa-04) + V-03/V-06 | **Sí, agravada.** Último verde del `nightly`: 2026-08-04; 111 fallos en las últimas 129 ejecuciones (V-06). Causa actual: `nightly.yml` sin ffmpeg ni userns (run 44519497401, TEST_VERIFIED). `deploy-staging`/`smoke-and-promote` son no-op | Heredada, agravada | TD-019 P3 → **P2** (nightly; RT: justificada y reforzada) / P3 (staging). QA-01 P2 | **Sí** (D13: 7 verdes consecutivas) | Copiar los dos pasos a `slow-suites` o restringir a ficheros `RUN_SLOW`; notificar fallo; fijar `ubuntu-24.04`. Staging: configurar o retirar los jobs | S · baja | **A** (nightly, DD) · **B** (staging) |

### 3.3 Pruebas y CI

| ID(s) | Sigue existiendo | Heredada / actual | Prioridad anterior → revalidada (motivo) | Cierra versión | Corrección o aceptación | Esfuerzo · riesgo | Grupo |
|---|---|---|---|---|---|---|---|
| <a id="td-018"></a>**TD-018** + [REV-01](05-SECURITY-REVIEW.md#rev-01) + [QA-02](08-TEST-QUALITY.md#qa-02) + ARQ-02 + QA-07 | **Sí.** La prueba de aislamiento de red del sandbox **no puede ponerse roja** (V-07: `run-escape-suite.sh:52,88`, `05_internal_network_scan.py`); mutantes (~20 scripts, `tests/mutants`), streaming real, perf y visual fuera de CI; 29 `.skip`/14 `runIf` | Heredada (MEJORADA) + actual | P3 → **P1** para REV-01 (DD, sobre P2 de RT); QA-02 P2; ARQ-02/QA-07 P3 | **Sí** (REV-01) | Rehacer la prueba en la red real con control positivo y mutante (REV-01); subconjunto de mutantes críticos a nightly (QA-02) | M (REV-01) · M (QA-02) · media | **A** (REV-01, DD) · **C** (QA-02, ARQ-02, QA-07) |
| <a id="td-045"></a>**TD-045** | **Cerrada confirmada.** `functional-e2e` (golden, docker-e2e, container-proxy-e2e) obligatorio en `main`, `enforce_admins=true`, strict (QA-06). TEST_VERIFIED run 44383512640 | Heredada | CERRADA → CERRADA | No | — | — | — |

### 3.4 API, torneos y datos

| ID(s) | Sigue existiendo | Heredada / actual | Prioridad anterior → revalidada (motivo) | Cierra versión | Corrección o aceptación | Esfuerzo · riesgo | Grupo |
|---|---|---|---|---|---|---|---|
| <a id="td-015"></a>**TD-015** + BE-01 + BE-08 + DOC-03 | **Parcial; la mitad registrada es obsoleta.** El cierre con batalla `failed` ya está resuelto (`results.ts:73,266-271,367-369`, #299); `known-issues.md` aún lo afirma. Queda BE-01 (torneo `closed` atascado: `battle-failure.ts:15-16`, `tournaments.ts:41`, `scheduler.ts:249-275`) y BE-08 (cancelación sólo `draft`/`open`) | Heredada | P1 PARCIAL → **P2 PARCIAL** (BE; BE-01 P1→P2 por RT) | BE-01: sí en forma mínima (D10) | **Proponer cerrar TD-015** y abrir BE-01/BE-08 con esos IDs (ver §6). Salida: cancelación administrativa desde `closed`; runbook SQL mientras tanto | S-M · media | **B** (BE-01, DD) con runbook en A · **C** (BE-08) |
| <a id="td-013"></a>**TD-013** + BE-11 | Sí. Registro no atómico (`auth.ts:158-171`), sin mapeo 23505, sin guarda de último admin | Heredada | P1 PARCIAL → **P2 PARCIAL** (RT: justificada, impacto acotado: 500 por carrera) | No | Transacción + captura de 23505 → 409 | S · baja | B |
| <a id="td-067"></a>**TD-067, TD-068, TD-069, TD-070, TD-071, TD-072, TD-073** | TD-071 confirmada sin cambio (STR); TD-067/068 no revalidadas (BE: paginación con cursor confirmada); TD-070 CTF rechazado con motivo, sin resultado erróneo; el resto sin revalidar | Heredada | P3 → P3 | No | Aceptadas (§7) | S cada una | C |
| <a id="td-042"></a>**TD-042** + BE-09 + BE-10 + BE-12 + BE-13 + BE-14 + BE-15 | Sin revalidar TD-042; BE-09/10/12/13/14/15 son deuda nueva (§4) | Heredada + actual | TD-042 P3 sin cambio | No | Ver §4 y §7 | S-M | C |
| <a id="td-022"></a>**TD-022** + UX-07 | Mejorada; residual: UX-07 (ruleset texto libre, `TournamentsPage.tsx:35,151`) y fallbacks TD-049 | Heredada | P2 MEJORADA → P2 | No | Selector de ruleset y error legible | S | B |

### 3.5 Motor, arquitectura y producto

| ID(s) | Sigue existiendo | Heredada / actual | Prioridad anterior → revalidada (motivo) | Cierra versión | Corrección o aceptación | Esfuerzo · riesgo | Grupo |
|---|---|---|---|---|---|---|---|
| <a id="td-016"></a>**TD-016** | Sí, PARCIAL. Campos FUTURE persisten en `effect-status.ts`; issues #197/#198 de munición | Heredada | P1 PARCIAL → sin cambio (ARQ: sin evidencia nueva) | No | Decisión de masa/coste de munición; efectos pendientes | M | C |
| <a id="td-017"></a>**TD-017** | Sí. `map-service` desplegado sin consumidor (compose) | Heredada | P2 PARCIAL → sin cambio | No | Retirar del compose por defecto o dar uso; aceptar mientras tanto | S-M | C |
| <a id="td-021"></a>**TD-021** + **TD-039** + [ARQ-09](#arq-09) | Sí. `match.ts`, `checkpoint.ts`, camino `POST /run` sin importadores no-test | Heredada | TD-021 P4 → P4; TD-039 P3 → P3 (ARQ: «borrar») | No | Borrar o mover a `dev/` | S-M | C |
| <a id="td-038"></a>**TD-038** + ARQ-10 | Sí. Checkpoints grabados, reanudación sin consumidor | Heredada | P3 → P4 (ARQ-10 P4) | No | Aceptada: promesa sólo en diseño | — | D |
| <a id="td-026"></a>**TD-026** | Sí. Canal Redis opcional; el worker degrada a polling | Heredada | P4 → P4 | No | Aceptada | — | C |
| <a id="td-009"></a>**TD-004**, TD-009, TD-028, TD-047 | Cerradas confirmadas en código (replays a anónimos 404 en gateway; reproductor; bots privados). TD-028 queda condicionada: `limit_conn/limit_req` ausentes en `/ws/` (STR) | Heredada | CERRADA → CERRADA (TD-028 con condición) | No | `limit_req` en `/api/v1/auth/` y `/ws/` (SEC-10/STR-07) | S | C |
| <a id="td-066"></a>**TD-066** | **Obsoleta.** Ver §6 | Heredada | P3 → **cerrar / reescribir a P4** (STR-11, DOC-03; RT: justificada) | No | Cerrar tres de cuatro defectos; reabrir «prueba E2E con YouTube documentada» P4 | S | E (cerrar) / D |

## 4. Deuda nueva no registrada (a registrar como TD con ID nuevo)

La auditoría no asigna números TD: se proponen al registrar. Prioridad = severidad final de la consolidación; entre paréntesis, la del informe cuando RT/DD la cambió.

| ID | Título | Prioridad final | Grupo | Cierra versión | Esfuerzo | Origen |
|---|---|---|---|---|---|---|
| [REV-01](05-SECURITY-REVIEW.md#rev-01) | Prueba de aislamiento de red del sandbox vacía | **P1** (P2 RT → P1 DD) | A | Sí | M | RT / V-07 |
| DOC-01 / OPS-11 | README y portada de docs declaran estado falso («no funcional») | P1 | A | Sí | S (README) + M (roadmap) | 07 / V-02 |
| DOC-02 (+ UX-09 licencia, OPS-14) | Repo público sin LICENSE | P1 | A | Sí | S (decisión del propietario) | 07 / RT |
| OPS-01 | Instalación no llega a ejecutar batallas | P1 | A | Sí | S+M | 04 |
| OPS-04 | `.env.example`, `smoke.sh`, enlaces muertos | P1 | A | Sí | S | 04 / V-04 |
| OPS-02 | `create-admin` ausente | P2 (P1 → P2 RT) | A | Sí | S | 04 |
| OPS-05 | Requisitos de hardware/SO ausentes | P2 (P1 → P2 RT) | A | Sí | S | 04 |
| OPS-13 | Orden up→bootstrap | P3 | A (RP) | Sí | S | 04 |
| [SEC-01](05-SECURITY-REVIEW.md#sec-01) | SPA sin cabeceras de seguridad | P2 | A (DD) | Sí | S (M si CSP del visor) | 05 |
| [SEC-02](05-SECURITY-REVIEW.md#sec-02) | Registro abierto sin interruptor | P2 | A (DD) | Sí | M | 05 |
| [SEC-03](05-SECURITY-REVIEW.md#sec-03) | Sin cambio de contraseña ni reset | P2 | A (cambio + reset asistido) / B (email) | Sí | S-M / L | 05 |
| [QA-01](08-TEST-QUALITY.md#qa-01) | Nightly roja crónica | P2 | A (DD) | Sí | S | 08 |
| DOC-13 | 29 PR «NO MERGEAR» abiertos (de 51 PR abiertos) | P3 | A (DD) | Sí | S (acción del operador) | 07 |
| DOC-10 | Sin capturas/demo | P3 | A (DD, «presentar») | Sí | S | 07 |
| UX-01 | Sin rival de práctica / instancia vacía | P2 (P1 → P2 RT) | A en forma barata (DD: bot «sparring» publicado por bootstrap o demo-teams documentado) | Sí | M | 03 / V-05 |
| DOC-07 / ARQ-08 | zip, docx y compose v1 sueltos en raíz (V-01: sin secretos) | P3 | A (RP, higiene de escaparate); V-01 lo califica de limpieza C (**discrepancia abierta**, §8) | Sí | S | 07 / 01 |
| OPS-03 | Bundle del proxy como asset de release | P1 | B (OPS, RT) / A en forma mínima (RP, no arbitrado) | Condicionado a D1 | M | 04 |
| OPS-14 / DOC-05 | Sin tags, releases ni CHANGELOG | P2 | B (04, 07) / A mínima (RP D1) | Sí (D1) | S-M | 04 / 07 |
| OPS-06 | Backup: sin guía servidor, poda incondicional, sin alertas | P1 | B (+ aviso en A) | Parcial (D12) | M | 04 |
| OPS-07 | Restore completo manual y sin ensayo | P1 | B (ensayo en A) | Parcial (D12) | M | 04 |
| OPS-08 | Upgrade/rollback sin comando único | P2 | B | No | M-L | 04 |
| OPS-09 | TLS sin emisión de certificados | P2 | B (receta con proxy en A, RP) | Parcial | S (receta) / M (ACME) | 04 |
| OPS-10 | Sin desinstalación | P2 | C | No | S-M | 04 |
| OPS-12 | Monitorización/readiness no certifican instalación real | P2 | B | No | M | 04 |
| OPS-15 | SO soportado sólo Debian | P3 | C | No | M | 04 |
| QA-03 | Sin prueba de instalación limpia/upgrade/rollback | P2 (P1 → P2 RT) | B (DD); en A basta ensayo manual D4 | Parcial | M-L | 08 |
| QA-04 | Staging/humo siempre «omitido» | P3 | B | No | M | 08 |
| [REV-02](05-SECURITY-REVIEW.md#rev-02) | `verifyReplay` sin cuota | P2 (P1 si >1 s en lab) | B (condicional → A si FASE 2 > 1 s con registro abierto, DD) | Condicional | S-M | RT |
| [REV-03](05-SECURITY-REVIEW.md#rev-03) | Prácticas sin cuota, sin autor, cola FIFO compartida | P2 | B | No | S-M | RT |
| [REV-05](05-SECURITY-REVIEW.md#rev-05) / SEC-14 | `cli seed` concede admin y crea cuentas con contraseña pública | P2 (SEC-14 P3 → P2 RT) | B | No | S | RT / 05 |
| [REV-04](05-SECURITY-REVIEW.md#rev-04) | Canal lateral entre bots (red `arena`) | P2 | B (A si hay competiciones públicas con premio, DD) | Condicional | M | RT |
| [REV-06](05-SECURITY-REVIEW.md#rev-06) | `setUserRoles` puede dejar sin administradores | P3 | C | No | S | RT |
| [REV-07](05-SECURITY-REVIEW.md#rev-07) | Handler 500 vuelca `detail` de errores de BD | P3 (HIPÓTESIS) | C | No | S | RT |
| BE-01 | Torneo `closed` atascado | P2 (P1 → P2 RT) | B (DD) + runbook en A | Parcial (D10) | S-M (M) | 02 |
| BE-02 | Jobs `needs_review` sin superficie operativa | P2 (P1 → P2 RT) | B (runbook en A) | No | M | 02 |
| BE-03 | `/healthz` ciego | P2 | B | No | S-M | 02 |
| BE-04 | Sin métricas de cola/torneos/workers | P2 | C | No | M | 02 |
| BE-05 | Validación de entrada manual, sin esquema | P2 | C | No | L | 02 |
| BE-06 | `.catch(() => null)` convierte fallos de BD en 404 (35 ocurrencias; #247) | P2 | C (RP) | No | M | 02 / RT |
| BE-07 | Límite 60 versiones/h sin `Retry-After`; bloquea migración | P2 | C (RP) | No | S | 02 |
| BE-08 | Cancelación de torneo sólo en `draft`/`open` | P2 | C | No | S-M | 02 |
| BE-09 | Migraciones: `down` con pérdida de datos | P3 | C | No | S-M | 02 |
| BE-10 | Sin retención de `jobs` ni `audit_log` | P3 | C | No | S-M | 02 |
| BE-11 | Registro no atómico, carreras 500 | P2 | B | No | S | 02 |
| BE-12 | Listados sin paginar con N+1 | P2 | C | No | n/e | 02 |
| BE-13 | Batalla `running` huérfana depende del job | P3 (HIPÓTESIS) | C | No | n/e | 02 |
| BE-14 | Lock de build de 10 min sin renovación | P3 | C | No | n/e | 02 |
| BE-15 | Rate limiter con 3 consultas por petición | P3 | C | No | n/e | 02 |
| UX-02 | Sin recuperación/2FA/sesiones en la web | P1 condicional → integrado en TD-012 | A (reset asistido) / B (email) | Sí | ver TD-012 | 03 / RT D-01 |
| UX-03 | Estados en inglés crudo | P3 | B (RP) | No | S | 03 |
| UX-04 | Editor textarea | P2 | C | No | M-L | 03 |
| UX-05 | `aria-label` con slugs | P3 | B | No | S | 03 |
| UX-06 | Tema único oscuro, contraste no medido | P3 | C | No | M | 03 |
| UX-07 | Ruleset de torneo como texto libre | P2 | B | No | S | 03 |
| UX-08 | Admin por UUID tecleado | P2 | B (RP) / C (03) | No | M | 03 |
| UX-09 | SDK sólo desde el repo | P2 | B (en A: quickstart, DOC-11) | No | M-L | 03 |
| UX-10 | Visor/replay a11y no verificada | P2 (HIPÓTESIS) | C | No | M | 03 |
| UX-11 | «Publicada≠elegible» sólo avisa al fallar | P2 (HIPÓTESIS) | B (A si FASE 2 lo confirma, RP) | Condicional | M | 03 |
| ARQ-01 | Job de stats re-simula sin comprobar versión de motor | P2 | B (obligatorio antes de la próxima subida de motor, RP) | No | S | 01 / RT |
| ARQ-02 | CI no vigila anclas me/ma/g2/g3 | P3 | C | No | S | 01 |
| ARQ-03 | Versión de motor escrita a mano | P3 | B | No | S | 01 |
| ARQ-04 | Prueba de resistencia sólo `dm_practice` | P3 | C | No | M | 01 |
| ARQ-05 | ADR-024: falta estado/índice | P4 | C | No | S | 01 |
| ARQ-06 | Ratings sin política ante cambio de motor | P3 | D | No | S + M | 01 |
| ARQ-07 | Regla arma↔munición en tres sitios | P3 | C | No | M | 01 |
| <a id="arq-09"></a>ARQ-09 | Código muerto del motor | P4 | C | No | S-M | 01 |
| ARQ-10 | Checkpoints sin reanudación | P4 | D | No | — | 01 |
| ARQ-11 | Determinismo entre plataformas (`Math.sin/cos`) | P3 (HIPÓTESIS) | D | No | M, incertidumbre alta | 01 |
| ARQ-12 | Sin presupuesto de coste por tick | P3 | C | No | medir en lab | 01 |
| DOC-03 | Roadmap/docs con afirmaciones obsoletas | P2 | B (en A: README, `current-status`, `known-issues`) | Parcial | L | 07 |
| DOC-04 | TD-064 sólo en el PR #169, sin registro en main | P3 | C | No | S | 07 |
| DOC-06 | Sin SECURITY.md ni plantillas | P2 | B | No | S | 07 |
| DOC-08 | PR documentales (#277, #286, #266, #258, #253, #174, #173, #168) | P3 | B | No | S-M | 07 |
| DOC-09 | Documentación sólo en español | P3 | C | No | M | 07 |
| DOC-11 | Sin quickstart de bots | P2 | B | No | S | 07 |
| DOC-12 | Sin referencia API renderizada | P3 | C | No | S-M | 07 |
| [QA-02](08-TEST-QUALITY.md#qa-02) | Mutantes y suites de alto valor fuera de CI | P2 | C | No | M | 08 |
| QA-05 | Aserción temporal en acceptance | P3 | C | No | S | 08 |
| QA-06 | Cobertura sin umbral; semáforo acepta amarillo | P3 | C | No | S | 08 |
| QA-07 | Skips por entorno | P3 | C | No | S-M | 08 |
| SEC-07 | Hardening desigual; Redis sin autenticación | P3 | C | No | M | 05 |
| SEC-08 | TOTP en claro en BD | P3 | C | No | S-M | 05 |
| SEC-09 | `/version` en :80 | P3 | C | No | S | 05 |
| SEC-11 | Workflows: acciones por tag, `permissions` sin fijar | P3 → **P4** (RT) | C | No | S | 05 / RT |
| SEC-12 | JWT sin longitud mínima ni rotación | P3 | C | No | S | 05 |
| STR-01 | Sesión larga de streaming no demostrada | P1 → **P2** (RT) | C (DD: streaming experimental) | No | M | 06 |
| STR-02 | Sin detección de imagen congelada | P2 (HIPÓTESIS) | C (RP) | No | S-M | 06 |
| STR-03 | Replays previos a v2 ilegibles sin explicación | P2 | B | No | S | 06 |
| STR-04 | Política de compatibilidad de replays «ninguna» | P3 | C | No | L (compat. real) | 06 |
| STR-05 | Color de bots blanco en emisión (no registrado) | P2 | C | No | S + S/M | 06 |
| STR-06 | Retardo fijo / spoiler | P3 | C | No | M | 06 |
| STR-07 | Dependencia de `S9_PUBLIC_SPECTATE_ENABLED` durante la emisión | P2 | C | No | n/e | 06 |
| STR-08 | Gateway de espectador en el proceso del worker | P3 | C | No | n/e | 06 |
| STR-10 | C3b y E2E de streaming fuera de CI | P2 | C | No | M | 06 |
| STR-11 / STR-12 | TD-066 obsoleta; docs de streaming desfasadas | P3 | B (docs) / E (TD-066) | No | S | 06 |
| STR-13 / STR-14 / STR-15 | Fuentes OBS, Streaming V2 (sólo diseño), identificación 4v4 | P4 / P4 / P3 | D / D / C | No | XL (V2) | 06 |
| STR-16 | Dropped frames 0,6-0,8 % sin diagnosticar | P3 | C | No | n/e | 06 |
| STR-17 | Claves de emisión no migradas a la instalación nueva | P2 | C (RP; RT: sale de A, es tarea operativa) | No | S | 06 / RT |

Nota de deduplicación: STR-09 = QA-01 = TD-019 (nightly); OPS-11 = DOC-01; DOC-02 = UX-09 (licencia) = OPS-14 (parte); UX-02 = SEC-03 = TD-012; ARQ-08 = DOC-07; SEC-13 = TD-008; STR-11 = TD-066; BE-03 = TD-059; SEC-04 ⊂ REV-04 (mismo recurso, distinto riesgo). Se conserva el ID de cada informe en las tablas para trazabilidad; ninguna fila se renumera.

## 5. Estado de las TD marcadas CERRADA en el registro

Los agentes confirmaron en código TD-004, TD-009, TD-028 (con condición), TD-045, TD-047, TD-051, TD-052, TD-053, TD-061 y TD-062 (en main). Las otras 15 cerradas del registro (TD-001, 002, 003, 005, 010, 011, 014, 029, 030, 032, 034, 040, 044, 056, 065) **no fueron revalidadas** por la auditoría y se mantienen como CERRADA en el registro. Las que dicen «cerrada en la integración» son afirmaciones de cierre en main; su despliegue en producción es evidencia de tercero. «CERRADA» no implica TEST_VERIFIED por esta auditoría salvo donde se cita el run de CI 44383512640.

## 6. Deuda que se propone cerrar como obsoleta

| ID | Motivo con evidencia | Acción propuesta |
|---|---|---|
| **TD-066** | Sus tres defectos ya no existen en 8f380eb: FLV por `pipe:3` sin clave en argv (`apps/streamer/src/ffmpeg.ts:10-13,33`), retención de grabaciones (`apps/streamer/src/recordings.ts`, #249), alertas `StreamerDown/RestartLoop/NoProgress` (`infrastructure/observability/alerts.yml:116-155`). CODE_VERIFIED por STR-11 y reconfirmado por RT §2.2 | Cerrar el registro y reabrir sólo «prueba E2E documentada con YouTube» como P4 (la emisión real de noviembre es afirmación del operador sin evidencia en el repo: DOC_ONLY) |
| **TD-015** | La parte «batalla `failed` bloquea el cierre» está resuelta (`results.ts:73,266-271,367-369`, #299); inscripción de equipos (#290) y cancelación (#289) en main | Cerrar TD-015 y sustituirla por BE-01 (torneo `closed` atascado, P2/B) y BE-08 (cancelación desde `closed`, P2/C); queda además E2E de formatos distintos de eliminación simple (DOC) |
| Filas de `known-issues.md` | «Un torneo con una batalla fallida no termina» (TD-015); «clave de emisión en argv…» (TD-066); causa del nightly «unshare + `backup:e2e-test`» y «40/40 / 5 de 5» (hoy: ffmpeg + userns, 111 fallos de las últimas 129) | Reescribir o retirar; `known-issues.md` y `technical-debt.md` anclan en e3bf2fa (DOC-01) |
| Issues #287, #288, #9, #14, #92 | #287/#288: backend en main (migración 022, `cancelTournament`), resto web; #9: el worker persiste `cpu_ms`; #14: ya hay CI y `main` protegida; #92: afecta al camino legado `/run` sin consumidor (TD-039) | Cerrar o redefinir tras confirmación (BE, DOC; acción del propietario) |
| PR documentales y «[REVIEW] NO MERGEAR» | 51 abiertos, 29 con «NO MERGEAR» (31 con REVIEW/NO MERGE) según RT (no «35 de 52»); #258, #153, #136 superados; #277 obsoleto como conjunto | Cerrar con referencia al PR integrador; cherry-pick selectivo de #277; verificar antes que sus tests de rotura existen en main (HIPÓTESIS, DOC-13) |

## 7. Deuda aceptada (se conserva abierta sin plan en esta versión)

| ID | Prioridad | Justificación de la aceptación |
|---|---|---|
| TD-026 (canal Redis sin productor) | P4 | El worker degrada a polling (~1 s) sin pérdida de funcionalidad (BE) |
| TD-027, TD-035, TD-036, TD-037, TD-042, TD-046, TD-049 | P3-P4 | Sin revalidar; impacto cosmético u operativo menor en el registro |
| TD-043 (secreto raíz en el worker) | P3 | El proceso ya tiene la contraseña de BD; aporta poco aislado (SEC-04 nota) |
| TD-038 / ARQ-10 (reanudación de batalla en vivo) | P4 · D | Promesa sólo de diseño |
| TD-067/068/069/070/071/072/073 | P3 | Sin resultado erróneo o con rechazo explícito (TD-070); sin revalidar |
| Purga del historial git (TD-008) | E | Coste/beneficio: el historial conserva datos de bajo valor (dominio ya público, IP privada); RP y SEC coinciden |
| ARQ-04, ARQ-07, ARQ-12, QA-05/06/07, SEC-07/08/09/12, BE-04/05/09/10/12-15, UX-04/06/10, DOC-09/12 | P3-P4 · C | Ninguno bloquea una versión presentable (RP §6); revisitar tras el lanzamiento |
| ARQ-06, ARQ-11, STR-13, STR-14, visuales FASE 0/1 | P3-P4 · D | Futuro; STR-14 y visuales sólo diseño (PR #275, #253), no condicionan (DD) |
| SEC-11 (acciones por SHA) | P4 | `default_workflow_permissions: read` y sin aprobación de PR (RT); queda fijar por SHA |
| Excepción `npm audit` GHSA-fc5q-39xc-vjpf (picomatch ≤ 4.0.7) | P3 | Sólo dependencias de desarrollo; caduca **2026-12-17**: si no hay versión corregida, renovar con motivo o sustituir, o `scan` se pone rojo y bloquea todos los PR (SEC §6) |

## 8. Dudas abiertas de consolidación

1. **DOC-07 / ARQ-08 (zip, docx, compose v1 en raíz)**: V-01 del director lo califica «limpieza P3 (grupo C)»; REVISION-PRODUCTO lo sube a A como higiene de escaparate (D14). Aquí se sigue la regla 3 de DD (grupo de RP) y se señala la discrepancia.
2. **OPS-03 y release mínima (OPS-14/DOC-05)**: OPS y RT los dejan en B; RP los sube a A en forma mínima (D1). No hay arbitraje de DD; D1 del criterio de salida los exige.
3. **UX-08**: C según 03, B según RP; sin arbitraje.
4. **TD-060, TD-063, TD-006, TD-031 (recuento)**: dependen de FASE 2 (`stat`, escaneo de escuchas, `runtime-drift-scan`, `trivy image`); BLOCKED (FASE 2) hasta que cierre la migración de producción en curso.
5. Los recuentos de tests por paquete y los «0 rotos de 2.311 enlaces» no son reproducibles por la auditoría (RT §8): no se usan como base de ninguna prioridad.
