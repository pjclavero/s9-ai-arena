# 15 · Revisiones independientes

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: dejar constancia de cómo se revisaron los informes de los especialistas, qué cambió por esa revisión y qué discrepancias quedan abiertas. Documento maestro: [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

## 1. Organización

| Función | Quién | Independencia |
|---|---|---|
| Autores | 8 especialistas: arquitectura y motor (ARQ), backend/API/datos (BE), frontend/UX (UX), DevOps/instalación (OPS), seguridad (SEC), streaming/visor (STR), documentación/roadmap (DOC), QA/pruebas (QA) | Cada uno con un área disjunta y un contrato común (estados de evidencia, formato de hallazgo, privacidad). |
| Revisor técnico hostil | Agente distinto de los autores | No escribió ningún informe. Abrió cada `fichero:línea` y run citado en 8f380eb; no auditó a partir de resúmenes. |
| Revisor de producto | Agente distinto de los autores y del revisor técnico | Evaluó si los informes responden a «¿puede un tercero instalarlo, usarlo, mantenerlo y lo podemos presentar?». |
| Director | Coordinador | Verificaciones propias V-01…V-07 y arbitraje de discrepancias. No redactó informes de área. |

Todo el trabajo de FASE 1 fue estático: lectura de código en 8f380eb, `git`, y `gh` en modo lectura. Sin ejecución de tests, builds ni contenedores, y sin acceso a producción ni al laboratorio (ver [FINAL §Limitaciones](FINAL-PRODUCT-AUDIT.md#153-limitaciones)).

## 2. Resultado de la revisión técnica hostil

**Ningún hallazgo P0/P1 quedó refutado.** Siete estaban inflados y uno estaba parcialmente mal fundamentado.

### 2.1 Severidades ajustadas

| ID | Antes | Después | Motivo resumido |
|---|---|---|---|
| OPS-01 | P1/A | P1/A, **con matiz** | La guía sí describe el proxy y las imágenes de runtime, pero como «opcionales». Faltan el paso `DOCKER_PROXY_URL` en `.env` y el firewall. El efecto se mantiene: una instalación «verde» que no ejecuta batallas. |
| OPS-02 | P1 | P2 (grupo A se mantiene) | Promover el primer admin por SQL es fricción documentada, no una ventana insegura. |
| OPS-05 | P1 | P2 | Falta una tabla de requisitos; es documentación. |
| BE-01 | P1 | P2 | La rama de torneo `closed` atascado es real, pero sus disparadores conocidos son precondiciones ya cubiertas. |
| BE-02 | P1 | P2 | Es operabilidad (jobs `needs_review` sólo vía SQL), no fiabilidad. |
| UX-01 | P1 | P2 | La web sí lista bots publicados de otros como rivales; el problema es la instancia vacía. |
| STR-01 | P1 | P2 | El streaming es opcional y está desactivado por defecto: hay ausencia de prueba, no evidencia de fallo. |
| QA-03 | P1/A | P2/B | La CI ya levanta el stack desde cero. Lo que falta es upgrade N-1→N con datos y rollback. |
| STR-17 | grupo A | grupo B | Es una tarea operativa de una instalación concreta, no un defecto del producto. |
| SEC-14 | P3 | P2 | `cli seed` sin guarda de entorno; ver REV-05. |
| SEC-11 | P3 | P4 | Los permisos por defecto de los workflows ya son de sólo lectura. |

### 2.2 Falsos PASS y verificaciones sin contenido

1. **Prueba de aislamiento de red vacía (REV-01). Es la corrección más importante de la revisión.** La suite `sandbox-escape` del workflow E6 corre cada bot en una red Docker interna vacía y con el DNS anulado, e intenta conectar con nombres que allí no existen. No puede ponerse roja. En la topología real, los bots comparten red con procesos de plataforma. El director lo comprobó en V-07. Detalle en [05-SECURITY-REVIEW](05-SECURITY-REVIEW.md) y [08-TEST-QUALITY](08-TEST-QUALITY.md).
2. **Nightly**. No eran 29 ni 40 fallos: el último verde es del 2026-08-04. El director lo comprobó en V-06: 111 fallos en las últimas 129 ejecuciones listadas.
3. **«ci 26/26 success»**. Dos de los 28 jobs (`deploy-staging`, `smoke-and-promote`) son no-op en verde. No sirven como evidencia de despliegue ni de humo.
4. **«429 con Retry-After»**. La web interpreta la cabecera, pero la API nunca la envía. Es una fortaleza latente, no efectiva.
5. **`smoke.sh`** no puede dar verde nunca: espera 200 en una ruta que el gateway responde con 404.
6. **TD-062 / TD-006 «cerradas»** según evidencia de tercero. El etiquetado se acepta, pero el cierre formal exige la medición de FASE 2.

Se comprobó que **ningún** TEST_VERIFIED se apoya en un run que no sea de 8f380eb.

### 2.3 Omisiones encontradas (hallazgos nuevos)

| ID | Severidad final | Resumen |
|---|---|---|
| REV-01 | **P1 / grupo A** (arbitraje del director; el revisor proponía P2) | Prueba de aislamiento de red vacía; alcance real bot→plataforma sin verificar. |
| REV-02 | P2 / B, **pasa a A** si en laboratorio cuesta >1 s con registro abierto | `POST /replays/{id}/verify` re-simula una batalla entera en el proceso de la API, sin cuota. |
| REV-03 | P2 / B | Batallas de práctica sin cuota ni autor, en la misma cola FIFO que los torneos. |
| REV-04 | P2 / B | Canal lateral entre bots por la red compartida que salta las reglas de radio y visión. |
| REV-05 | P2 / B | `cli seed` concede `admin` a una cuenta preexistente con ese email sin cambiarle la contraseña. |
| REV-06 | P3 / C | Un admin puede dejar la instalación sin administradores. |
| REV-07 | P3 / C | Los 500 vuelcan al log el detalle de PostgreSQL. |

## 3. Resultado de la revisión de producto

1. **Cobertura.** Los informes responden bien a «instalar» y a la calidad interna, razonablemente a «usar» y mal a «presentar» y al «día 2». Hay **cuatro recorridos que nadie evaluó**: visitante anónimo, instancia recién instalada y vacía, día 2 del administrador, y moderación/legal (sin términos, sin privacidad, sin baja de cuenta). Se tratan en [06-UX-PRODUCT-REVIEW](06-UX-PRODUCT-REVIEW.md) como UX-12…UX-16 (severidad propuesta por el redactor, sin revisión técnica) y se añaden a FASE 2.
2. **Instalación.** El NOT_READY de OPS es correcto y **OPS-01 es el hallazgo clave de la auditoría**. Un CLI completo (`s9ctl`) es más de lo mínimo; para A basta con un instalador de host, `create-admin`, plantillas y README corregidos, un «doctor» que juegue una batalla de humo, una release con el bundle del proxy y una receta de TLS.
3. **Sobrevalorados** (no deben bloquear A): sesión larga de streaming, automatizar el restore (sí ensayarlo), BE-02, re-auditar el roadmap completo, purgar el historial git, ARQ-01 y SEC-04.
4. **Infravalorados** (deben condicionar la presentación): interruptor de registro, cabeceras de la SPA, rival de práctica, nightly roja, falta de release, escaparate del repo (PR «NO MERGEAR» y ficheros sueltos), capturas y BE-01.
5. **Recomendación: opción A+**. Ver [11-RELEASE-GAP-ANALYSIS](11-RELEASE-GAP-ANALYSIS.md).

El director verificó una aportación propia del revisor de producto: el comando `demo-teams` existe (V-05). Lo había omitido el informe de UX y mitiga UX-01 para demostraciones del operador.

## 4. Discrepancias y resolución

| # | Discrepancia | Resolución | Por evidencia | Estado |
|---|---|---|---|---|
| D-01 | Ciclo de vida de cuenta: UX-02 P1 frente a SEC-03 P2 | P1/A si se abre el registro a externos, que hoy es el valor por defecto porque no hay interruptor; P2/B si es por invitación. El director fija para A+ el cambio de contraseña y el reset asistido por admin; el email queda en B. | `auth.ts:147-175,386-448` | RESUELTA |
| D-02 | `cli seed` P3 | P2/B (REV-05). La guía lo prohíbe, pero no hay guarda en código. | `cli.ts:63-66`, `seeds/dev.ts` | RESUELTA |
| D-03 | TD-006 P0→P3, TD-007 P0→P1, TD-008 P0→P3 | TD-006 P3 (cierre en FASE 2), TD-007 P1, TD-008 **P2** (limpieza de ficheros rastreados en A; purga de historial en E) | compose, `infrastructure/.env.example` | RESUELTA |
| D-04 | OPS-01 | Confirmado con matiz (§2.1) | `docker-compose.yml:308,368`; `installation.md:46,129-169` | RESUELTA |
| D-05 | TD-023 P1 frente a P2 | P2; el `create-admin` va en A por coste | — | RESUELTA |
| D-06 | TD-008 P3 (SEC) frente a P1 (DOC) | P2, con el arreglo de plantilla dentro de OPS-04 | — | RESUELTA |
| D-07 | Racha de la nightly | Último verde 2026-08-04 | V-06 | RESUELTA |
| D-08 | Retry-After | Fortaleza latente | `web/src/errors.ts`; `grep` vacío en API | RESUELTA |
| D-09 | «Sandbox conforme» frente a SEC-04 | La postura del contenedor está cubierta (cap-drop, seccomp, rootfs de sólo lectura); el aislamiento de red no | REV-01, V-07 | RESUELTA |
| D-10 | TD-012 | Igual que D-01 | — | RESUELTA |
| D-11 | Número de servicios (12, 11+1 o 13) | 13 con el perfil `streaming` en 0.5.0 | compose | RESUELTA |
| D-12 | UX-01: el técnico dice P2 y el de producto, grupo A | P2, grupo A en su forma barata (bot sparring del sistema o `demo-teams` documentado) | V-05 | RESUELTA (director) |
| D-13 | BE-01: el técnico dice P2/B y el de producto, A | P2/B, más un runbook de salida en A | — | RESUELTA (director) |
| D-14 | REV-01: el técnico propone P2 | **P1/A**: invalida la única evidencia automatizada de aislamiento de red | V-07 | RESUELTA (director) |
| D-15 | TD-031: SEC dice P2 y el técnico, P1 provisional | P1/A hasta pasar `trivy image` en FASE 2 | — | **ABIERTA hasta FASE 2** |
| D-16 | REV-02: coste real de `verify` | Depende de la medición en laboratorio | — | **ABIERTA hasta FASE 2** |
| D-17 | REV-01/REV-04: ¿es explotable el alcance bot→worker y bot→bot? | La conectividad L3 es CODE_VERIFIED; la explotabilidad (puertos que escuchan) no está verificada | — | **ABIERTA hasta FASE 2** |
| D-18 | Nº de intervenciones manuales en la reinstalación real del operador (el informe de OPS dice 5 y «≥6»; el recuento sobre su propia tabla da 8 de tercero, 2 condicionales y 1 específica) | Se medirá en el escenario S01 de FASE 2, con una persona ajena siguiendo sólo la documentación | — | **ABIERTA hasta FASE 2** |

Ningún hallazgo importante se cerró por consenso sin evidencia. Las cuatro discrepancias abiertas tienen asignada su prueba de FASE 2 en [08-TEST-QUALITY](08-TEST-QUALITY.md) y [05-SECURITY-REVIEW](05-SECURITY-REVIEW.md).

## 5. Lo que ningún revisor pudo verificar

- Producción: versión desplegada, contenedores, backups programados, alertas, firewall.
- La existencia de una imagen `:latest` antigua en el registro de contenedores (sin permiso de lectura de paquetes).
- El recuento de enlaces sin roturas y los recuentos de tests por paquete (script no conservado; recuentos estáticos).
- El contenido de los informes de migración del operador, citados como evidencia de tercero.
- El coste de `verify`, la explotabilidad de la red compartida y las operaciones de administración de streaming una a una.
- Cualquier medición de tiempo, recursos o usabilidad real.
