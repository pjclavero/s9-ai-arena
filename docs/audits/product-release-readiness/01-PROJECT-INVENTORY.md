# 01 · Inventario del proyecto S9 AI Arena

Sujeto: main 8f380eb · Fecha: 2026-11-19 · Estado: FASE 1 (estática) — FASE 2 pendiente

Propósito: describir qué es S9 AI Arena hoy (arquitectura, servicios, versiones, infraestructura genérica, estado de ramas/PR/CI/releases) y separar con claridad lo comprobado en código de lo declarado por terceros o no verificado. Veredicto y plan en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md). Matriz funcional en [02-FUNCTIONAL-MATRIX.md](02-FUNCTIONAL-MATRIX.md); fortalezas y debilidades en [03-STRENGTHS-WEAKNESSES.md](03-STRENGTHS-WEAKNESSES.md).

Convención de evidencia (contrato de la auditoría): `CODE_VERIFIED` (leído en el árbol de 8f380eb), `TEST_VERIFIED` (run de CI sobre 8f380eb con conclusión citada), `DOC_ONLY` (afirmado en documentación, no contrastado), `PROD_VERIFIED` no se concede en esta fase: lo declarado sobre producción es **evidencia de tercero (operador), no reverificada por la auditoría**. `BLOCKED (FASE 2)` = depende de laboratorio o de lectura de producción, aún no autorizados.

---

## 1. Qué es

S9 AI Arena es una plataforma autoalojable de competición de bots: los participantes escriben bots (Python o JavaScript), los equipan con módulos de un catálogo, los validan en un sandbox y los hacen combatir en un motor 2D determinista (individual y por equipos 4v4), en batallas de práctica y en torneos, con replays verificables, ranking, espectador en vivo y emisión por streaming. Se opera con una web de administración. Está en un monorepo TypeScript (npm workspaces) con SDK de bots en JavaScript y Python.

Estado de producto, en una frase: **el núcleo técnico (motor, cola, sandbox, contrato de API) está implementado e integrado en main con CI verde en el camino de PR; lo que falta para presentarlo es producto y empaquetado** (licencia, README veraz, instalación que llegue a ejecutar batallas, release, escaparate del repositorio). Detalle en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md).

## 2. Arquitectura

### 2.1 Vista general

```
Navegador ──> gateway (nginx, único publicador de puertos)
                ├─> web (SPA React + visor Phaser)
                ├─> api  (REST /api/v1, OpenAPI 0.25.0, JWT + refresh opaco)
                │      └─ Postgres (datos, cola `jobs`, auditoría), Redis (señal opcional)
                ├─> replay-service (almacén y re-simulación de replays)
                └─> ws espectador (gateway WS dentro del proceso del worker)

tournament-worker ── ejecuta el motor EN PROCESO (arena-engine) y reclama jobs `run_battle`
bot-build-worker  ── valida/construye bots en sandbox y firma el artefacto (ed25519)
bot-manager       ── API de sesiones/sandbox; habla con el proxy de Docker del host
Bots (contenedores efímeros) ── protocolo WebSocket `arena/1` hacia el worker, red `arena`
streamer (perfil streaming) ── Chromium + Xvfb + ffmpeg → relé RTMPS
backup (restic) ── copia periódica a almacenamiento externo
```

Evidencia: estructura de `apps/`, `packages/`, `infrastructure/docker-compose.yml`, ADR-000/021-024, `docs/technical/engine.md`. `CODE_VERIFIED` (informe ARQ, §5).

Observaciones de arquitectura que condicionan el resto del documento:

- El motor **no es un servicio independiente en producción**: lo ejecuta el worker en proceso; el servicio `arena-engine` del compose existe en los perfiles `development/production/external-db`. Los bots sí corren en contenedores separados y hablan con el motor por WebSocket.
- El gateway de espectador corre **dentro del proceso del worker** (mismo proceso que el motor): STR-08 y SEC-04.
- El monorepo declara `apps/*`, `bots/*`, `packages/*` en `pnpm-workspace.yaml`, pero se opera con npm workspaces; sólo `arena-server`, `arena-viewer`, `map-schema`, `protocol` y `sdks/javascript` declaran dependencias `@s9/*`. El resto se resuelve por imports relativos TypeScript (p. ej. `replay-service` importa `arena-engine/src/replay` y `api/src/db/connection`; la API importa `leagueTable` de `tournament-worker/src/results.ts`). No es un grafo de paquetes real. Origen: ARQ §5, BE §6. `CODE_VERIFIED`.

### 2.2 Servicios (compose)

`infrastructure/docker-compose.yml` @8f380eb define 14 servicios de aplicación/datos y 8 de observabilidad, repartidos por perfiles. La cifra «13» de la instalación de referencia corresponde a los perfiles `production` + `streaming` (12 + `streamer`); README e `installation.md` dicen «12» y «11 healthy + backup» (desfasado, OPS-13/DOC-01). `CODE_VERIFIED`.

| Servicio | Perfiles | Función |
|---|---|---|
| gateway | nucleo, development, production, external-db | Único publicador de puertos 80/443; TLS propio o detrás de proxy inverso del operador |
| web | ídem | SPA (consola de jugador y de administración, visor) |
| api | ídem | REST `/api/v1`, auth, RBAC desde el contrato OpenAPI, cola `jobs` |
| arena-engine | development, production, external-db | Motor determinista (en producción lo usa el worker en proceso) |
| tournament-worker | nucleo, development, production, external-db | Cola `run_battle`, ejecución de batallas, torneos, ratings, gateway WS espectador |
| bot-manager | development, production, external-db | Sesiones de sandbox vía proxy de Docker |
| bot-build-worker | ídem | Validación/construcción de versiones de bot |
| map-service | ídem | Mapas; desplegado sin uso conocido (TD-017, ARQ §5) |
| replay-service | nucleo, development, production, external-db | Almacén y re-simulación de replays |
| queue (Redis) | ídem | Señal opcional; el worker degrada a polling |
| postgres | nucleo, development, production | Datos y cola |
| streamer | streaming | Emisión RTMPS (Chromium + ffmpeg) |
| backup | production, external-db | Copia restic a repositorio externo |
| bot-runtime-template | bots | Plantilla de contenedor de bot |
| prometheus, alertmanager, grafana, loki, promtail, cadvisor, node-exporter, postgres-exporter | observability | Pila opcional; sin ella las alertas no llegan a nadie (OPS-06/OPS-12) |

Redes: `public`, `platform`, `arena`, `build`, `data`, `bot-control`. Los bots y los workers comparten la red `arena` ([REV-01](03-STRENGTHS-WEAKNESSES.md#rev-01), REV-04).

### 2.3 Módulos y paquetes

| Grupo | Contenido |
|---|---|
| `apps/` | api, arena-engine, bot-manager (incluye build-worker), map-service, replay-service, streamer, tournament-worker, web; `arena-server` y `arena-viewer` son del prototipo v1 (sólo `docker-compose.demo.yml`) |
| `packages/` (13) | build-info, data-dir, first-run, game-rules, map-schema, module-catalog, projection, protocol, readiness, shared-types, stream-secrets, test-contracts, test-process |
| Núcleo de contrato | `game-rules` (reglas, rulesets, límites) y `module-catalog` (catálogo, validador, contrato `engine-v2`) lo consumen motor, API y worker |
| `runtimes/` | runtimes de bot Node y Python fijados por digest (`DIGESTS.lock`) |
| `sdks/` | JavaScript y Python reales (versión 0.1.0, con simulador local en JS); .NET y Java sólo README |
| `infrastructure/` | compose, gateway, web, backup, firewall, observabilidad, scripts de operación, proxy de Docker del host |
| `docs/` | portada por audiencia, ADR (18 + índice), operaciones, técnico, roadmap, histórico |
| Raíz | `s9-ai-arena-part2.zip`, `Dosier_tecnico_...docx` y `docker-compose.demo.yml` (artefactos de la génesis; V-01: sin secretos, limpieza P3) |

Código muerto o sin consumidor declarado: `match.ts`, `checkpoint.ts` y `POST /run` del motor (ARQ-09); `map-service` (TD-017).

## 3. Versiones

| Componente | Valor @8f380eb | Evidencia |
|---|---|---|
| Motor | 0.5.0 (`engine-deps.json`; una sola subida por OLA, ADR-022/024) | `CODE_VERIFIED` |
| Física | Rapier 0.19.3, wasm fijado por sha256; el motor se niega a arrancar si cambia | `CODE_VERIFIED` (el arranque con wasm alterado no se ha ejecutado) |
| Protocolo bot↔motor | `arena/1` | `CODE_VERIFIED` |
| Formato de replay | v2 (JSONL + gzip/zstd, hashes por componente); verificador de versión única | `CODE_VERIFIED` |
| API | prefijo `/api/v1`, `info.version` 0.25.0; 106 operaciones según BE (DOC-12 cuenta 107: discrepancia menor sin resolver) | `CODE_VERIFIED` |
| Migraciones | 001–022, todas con `down`; rollback por nombre acotado a una lista cerrada (016–022) | `CODE_VERIFIED` |
| Node | ≥22.15 (`engines`; CI usa 22.15); Debian 12 no lo trae de serie | `CODE_VERIFIED` |
| SDK JavaScript / Python | 0.1.0 / 0.1.0; no publicados en registros; sin licencia declarada | `CODE_VERIFIED` |
| Documentación de estado | Anclada a `e3bf2fa` (2026-11-02): 586 commits por detrás de 8f380eb, motor 0.4.0, migraciones 016 | V-02, DOC-01 |
| Versión del paquete raíz | sin versión de producto; imágenes `sha-<commit>` y un `v0.0.0` móvil | OPS-14 |

Tests (salida real de la nightly del 19-nov sobre 8f380eb, run 44519497401): 485 ficheros y 6.869 tests, 6.777 pasan, 86 saltados, 6 fallan (por entorno, ver §6). `TEST_VERIFIED` para ese run; no hay cifras de cobertura con umbral (QA-06).

## 4. Infraestructura (genérica)

Modelo de despliegue soportado: **un host Debian 12 con Docker Compose**.

- **Proxy de Docker del host**: los servicios no montan el socket de Docker (lo impone un escáner de compose en CI). Un proxy con lista de endpoints, imagen por digest, etiquetas de propiedad y control de cliente atiende la creación de contenedores de bot. Se instala como root desde un bundle construido con Node ≥22.15 y verificado por sha256. Sin él, las batallas quedan en `scheduled` y los builds se rechazan ([OPS-01](07-INSTALLATION-OPERATIONS.md#ops-01), [OPS-03](07-INSTALLATION-OPERATIONS.md#ops-03)).
- **Firewall del host**: reglas iptables-nft con unidad systemd; la persistencia con systemd real figura como `DESIGN_ONLY` en la documentación (OPS-15).
- **Secretos**: ficheros 0400 generados por `init-secrets.sh`; JWT fail-closed; sin secretos versionados (`git ls-files`).
- **TLS**: certificado autofirmado por defecto o proxy inverso del operador; sin emisión automática (OPS-09).
- **Backup**: contenedor `backup` con `restic` a un repositorio **externo** que el operador debe aportar (almacenamiento de backup externo, p. ej. SFTP confinado); `.env` no entra en la copia; poda incondicional (OPS-06).
- **Observabilidad**: perfil opt-in (Prometheus/Grafana/Loki, 11 alertas «NOT TESTED» en instalación real); sin el perfil, un backup fallido sólo se detecta mirando el healthcheck (OPS-06/OPS-12).
- **Actualización**: procedimiento manual y seguro (`TAG` → `config --hash` → `pull` → `up` por grupos → `migrate` a mano); la API no migra al arrancar (OPS-08).
- **Export/import portable**: scripts para mover bots y equipos entre instalaciones; idempotente y reanudable, con límite de 60 versiones/h por usuario que penaliza a operadores con muchas versiones (BE-07).

## 5. Repositorio: ramas, PR, issues, releases

| Elemento | Estado | Evidencia |
|---|---|---|
| Visibilidad / licencia | repositorio **público**, `license: null` (sin LICENSE) | DOC-02, `gh api` (director) |
| Protección de `main` | 4 checks obligatorios, `strict`, administradores incluidos, 0 revisiones requeridas | QA-06 (verificada por REVISION-TECNICA) |
| PR abiertos | ≈52 según DOC-13; REVISION-TECNICA contó 51 abiertos de los que 29 llevan «NO MERGEAR» en el título (31 con REVIEW/NO MERGE). El brief del director usa ≈35 drafts de revisión: el recuento exacto depende del criterio y debe fijarse al limpiar | DOC-13 (P3, grupo A, DECISIONES-DIRECTOR) |
| PR `[REVIEW] … NO MERGEAR` (#182–#248) | drafts de pruebas de rotura de PR ya mergeados (verificado MERGED en una muestra de 6); no se comprobó que todos sus tests entraran en main | DOC-13 |
| PR vivos relevantes | #295 reset competitivo (draft), #275 Streaming V2 (sólo diseño), #286 próxima ola web/streaming (docs), #266 Module Catalog v2 (diseño), #253 mejoras visuales (docs + test de contrato), #277 refresco de docs (superada), #169 corrección de `init-secrets.sh` (TD-064 sin registrar), #174/#173/#168 informes antiguos | DOC-08 |
| Issues relevantes abiertas | #185 (RAM/swap del host), #107 (`restore.sh --verify`), #247 (oráculo de bots privados), #287/#288 (backend ya en main), #232/#233 (motor), #261–#263 | BE §6, DOC §3 |
| Tags / releases / CHANGELOG | **ninguno** (0 tags, 0 releases, sin CHANGELOG; `.changeset/` sólo con `config.json`) | DOC-05, OPS-14 |
| Ficheros de comunidad | sin SECURITY.md, plantillas de issue/PR ni CONTRIBUTING en raíz | DOC-06 |
| Capturas / demo | 0 imágenes en el repositorio | DOC-10 |

## 6. CI sobre 8f380eb

Seis workflows: `ci`, `functional-e2e` (reutilizable, obligatorio en main), `e6-security`, `acceptance`, `nightly`, `runtimes-publish`.

| Workflow | Run | Conclusión | Notas | Estado |
|---|---|---|---|---|
| `ci` | 44383512640 | success | 28 jobs; incluye `functional-e2e` (golden con navegador, docker-e2e, container-proxy-e2e), e2e de backup SFTP y restore. `deploy-staging` y `smoke-and-promote` son no-op («omitido») con conclusión `success`; el check «Semáforo CI» queda neutral | `TEST_VERIFIED` (sólo lo que esos jobs ejercen); REVISION-TECNICA §4 (punto 3) advierte que «26/26 verdes» incluye verdes vacíos |
| `E6 security` | 44383512289 | success | escáner de compose, digests-gate, Trivy de runtimes de bot, `sandbox-escape` | `TEST_VERIFIED`; **la prueba de red de `sandbox-escape` no puede ponerse roja** ([REV-01](03-STRENGTHS-WEAKNESSES.md#rev-01)) |
| `acceptance` | 44537834319 | success | 28 de 29 ejecuciones programadas verdes; una caída por aserción temporal (QA-05) | `TEST_VERIFIED` |
| `nightly` | 44519497401 | **failure** | `determinism-1000` pasa; `slow-suites` falla 6 tests por falta de ffmpeg y de userns sin privilegios (`nightly.yml` no los prepara, `ci.yml` sí). **Último verde programado: 2026-08-04; 111 fallos en las últimas 129 ejecuciones (V-03/V-06, DECISIONES-DIRECTOR)** | `TEST_VERIFIED` (QA-01, REVISION-TECNICA §2.2) |

Sin ejecución en ningún workflow: mutantes (≈20 scripts), `tests/streaming-e2e`, `acceptance/visual`, rendimiento del visor (QA-02). Staging nunca configurado (QA-04). Cobertura sin umbral (QA-06).

## 7. Estado desplegado: declarado (tercero) frente a no verificado

La auditoría **no** ha tocado producción ni laboratorio (FASE 2 bloqueada por una migración de producción en curso). Lo que sigue procede de informes del operador y no ha sido reverificado.

| Afirmación | Fuente | Estado de evidencia |
|---|---|---|
| Reinstalación limpia en host Debian 12 con 13 contenedores sobre `sha-8f380eb`, comprobada con `docker inspect .Config.Image`; proxy, firewall y runtimes instalados; 8 operaciones reales vía proxy | informe de reinstalación (informe-reinstalación) | evidencia de tercero; **no verificada** |
| Copia de seguridad desde la instalación nueva con `restic check` correcto; restore real del dump a una BD temporal con 40/40 tablas idénticas; export portable 37/37 bots y 8/8 equipos | informes informe-export/informe-export-b | evidencia de tercero; **no verificada**; restore del procedimiento completo en host limpio **no ensayado** (OPS-07) |
| Streaming V1 emitiendo a una plataforma real en noviembre | brief del operador; documentación | `DOC_ONLY`; el propio documento de arquitectura del repositorio aún dice «BLOCKED» (STR-12) |
| Streaming desactivado y claves de emisión no migradas en la instalación nueva | brief del operador | operativo, `UNKNOWN` (STR-17) |
| Host de producción con incidencia abierta de swap/RAM; tres batallas simultáneas ahogaron una instancia de 4 vCPU | #185, `configuration.md:58` | `DOC_ONLY` |
| Qué replays v1/0.4.0 conserva producción | — | `UNKNOWN` (STR-03) |

Pruebas que lo resolverían: ver «Pruebas pendientes» en [FINAL-PRODUCT-AUDIT.md](FINAL-PRODUCT-AUDIT.md) y los apartados «Verificaciones para FASE 2» de cada informe. Todo lo anterior es `BLOCKED (FASE 2)` hasta que se autorice lectura de producción o laboratorio.

## 8. Qué no se midió

Rendimiento y coste por tick (ARQ-12), determinismo entre CPU/versiones de Node (ARQ-11), carga del gateway de espectador (STR-08), sesión larga de streaming (STR-01), imagen congelada (STR-02), tiempo de `verify` (REV-02), vulnerabilidades de imágenes de servicio (74 HIGH/CRITICAL de una medición anterior, TD-031, no remedida), firewall aplicado y permisos reales en el host, usabilidad con personas (UX §7.1), instalación por una persona ajena (D4). Cada una figura con su prueba en los informes de área.

