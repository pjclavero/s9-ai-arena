# Tabla de auditoría documental (§26) — ficheros de DOC-B

- **MAIN_SHA:** `e3bf2fa83650559267ef269994c667fabfb29e46` (2026-11-02).
- **Alcance:** todos los `.md` de `docs/` salvo `docs/user/` (DOC-A). Incluye `operations/` (reorganización y enlaces), `overview/` y los ficheros sueltos para que DOC-C vea el panorama.
- **Acciones:** KEEP, UPDATE, MOVE, MERGE, ARCHIVE, DELETE_DUPLICATE, GENERATE. Ninguna historia se borra.
- **Sin re-auditar línea a línea** (honestidad): los documentos de `technical/` (salvo los de la lista de cambios), `operations/` y `development/` conservan su verificación original (`27f70bb`/`0b8c12b`). Se comprobaron hechos de alto riesgo (versión del motor, migraciones, rutas del contrato, estado de TD-001/002/004/005/047, scripts npm, jobs de CI) pero no cada frase.

## Recuento por acción

| Acción | Ficheros |
|---|---|
| GENERATE | 4 |
| KEEP | 162 |
| MOVE | 4 |
| UPDATE | 26 |
| **Total** | 196 |

## Tabla

| Archivo | Tipo actual | Tipo correcto | Vigente / obsoleto | Acción | Nota |
|---|---|---|---|---|---|
| `DOC-MIGRATION-MAP.md` | Mapa de migración | Auditoría | HISTÓRICO (evidencia) | KEEP | de DOC-C |
| `README.md` | Portada | Portada | — | KEEP | de DOC-C |
| `aceptacion/ultimo-informe.md` | Informe generado | Informe generado | GENERADO | KEEP | lo escribe acceptance/run-acceptance.mjs; no se mueve |
| `adr/ADR-000-decisiones-fundacionales.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-010-devops-ci-observabilidad-backup.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-016-identidad-de-build.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-017-contrato-de-release.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-018-semantica-del-scan.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-019-perimetro-y-version-del-motor.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-020-spawns-4v4-y-version-del-motor.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-021-reglas-de-batalla-presets-y-copia.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-022-motor-0-4-0-reglas-ctf-prorroga.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-E7-001-migraciones-knex.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-E7-002-postgres-embebido-en-tests.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-E7-003-panel-react-vite.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-E9-001-cola-postgres-redis.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-E9-002-rating-elo.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/ADR-R14-webrtc.md` | ADR | ADR | VIGENTE según el índice | KEEP | no se reescribe una ADR; vigencia en adr/index.md |
| `adr/index.md` | ADR (índice) | ADR (índice) | VIGENTE | UPDATE | notas de vigencia al día (ADR-016/020/021/022) |
| `audits/2026-10-15/AUDIT-DELTA-2026-10.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `audits/2026-10-15/README.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `audits/2026-10-cierres/functional-closure-report.md` | Informe (en development/) | Auditoría | HISTÓRICO (evidencia) | MOVE | movido desde development/ (git mv); enlaces corregidos |
| `audits/2026-10-cierres/production-readiness-report.md` | Informe (en development/) | Auditoría | HISTÓRICO (evidencia) | MOVE | movido desde development/ (git mv); enlaces corregidos |
| `audits/2026-11/DOCS-AUDIT.md` | — | Auditoría | VIGENTE | GENERATE | esta tabla (§26) |
| `audits/2026-11/PENDING-AUDIT.md` | — | Auditoría | VIGENTE | GENERATE | clasificación DONE/PARTIAL/PENDING/DESCARTED con evidencia |
| `audits/DOCUMENTATION-CONSOLIDATION-REPORT.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | informe de la consolidación de 2026-10 |
| `audits/README.md` | Auditorías (índice) | Auditorías (índice) | VIGENTE | UPDATE | secciones nuevas: auditoría del roadmap 2026-11 e informes de cierre |
| `audits/anteriores/R16_VISUAL_AUDIT.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `audits/anteriores/auditoria-2026-07-16.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `audits/anteriores/auditoria-consolidada-2026-07-16.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `audits/anteriores/index.md` | Auditoría | Auditoría | HISTÓRICO (evidencia) | KEEP | evidencia de su fecha |
| `balance/informe-v1.md` | Informe generado | Informe generado | GENERADO | KEEP | lo escribe packages/module-catalog/balance/run.ts; no se mueve |
| `balance/v1.md` | Diseño de balance | Desarrollo/técnica | VIGENTE (sin re-verificar) | KEEP | la cifra del catálogo la verifica el generador |
| `development/ci.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/contract-compatibility.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/contributing.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/conventions.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/index.md` | Desarrollo (índice) | Desarrollo (índice) | VIGENTE | UPDATE | público, mapa del material de desarrollo, E2E de navegador ya existe |
| `development/releases.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/repository.md` | Desarrollo | Desarrollo | VIGENTE | UPDATE | añadido packages/test-process |
| `development/setup.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/testing.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `development/workflow.md` | Desarrollo | Desarrollo | VIGENTE (verificación original) | KEEP | scripts npm y jobs de CI comprobados el 2026-11-02; resto con su tabla de verificación |
| `history/disenos/B11_PANEL_VERSIONES_VERDAD.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/CARRIL_I_EXECUTION_GATE.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/CARRIL_J_GATE_SPECTATOR.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R10_MAP_EDITOR_FOUNDATION.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R10_MAP_EDITOR_SLICE1.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R11_PUBLIC_SPECTATOR_FOUNDATION.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R11_SPECTATOR.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R12_BRACKET_SLICE1.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R12_PREPARE_BATTLE_MATCHMAKING.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R13_1_RUNTIME_INSPECTOR.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R13_2_HARDENING.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R13_5_SAVE_SHARDING.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R13_ENGINE_RUNTIME_QUALITY.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R14_WEBRTC_STREAMING.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R16_DESIGN_SYSTEM.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R16_VISUAL_SLICE1.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R16_VISUAL_UPGRADE.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R6_2_REAL_BATTLE_RUNS.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R7A_OPERATIONAL_REPLAY_INGEST.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R7_REPLAY_VIEWER.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R8_ADMIN_MANAGEMENT.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R8_GESTION_ADMIN.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/R9_BATTLE_CREATION.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/formato-tmx.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/getting-started.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/disenos/sdk-paridad.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/FUSION.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/README.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/ROADMAP.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E1.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E10.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E11.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E12.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E2.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E3.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E4.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E5.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E6.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E7.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E8.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/entregas/entrega-E9.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/index.md` | Historia (índice) | Historia (índice) | VIGENTE | UPDATE | aviso literal «DOCUMENTACIÓN HISTÓRICA» y 3 entradas nuevas |
| `history/operaciones/APAGADO_Y_ENCENDIDO.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/COMPOSE_CANONICO.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/CONTRATO_DESPLIEGUE.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/DESPLIEGUE_DOMINIO.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/MIGRACION_V2.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/OPERACION_HOST_ARENA.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/OVERRIDE_VERSION_POR_SERVICIO.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/R17_INSTALACION_READINESS.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/contenido-base.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/despliegue.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/operaciones/streaming-runbook.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/planes/Dosier_tareas_S9_AI_Arena.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/planes/ROADMAP.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/programas/BACKLOG_POST_PROGRAMA.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/programas/NEXT_PHASE_R10_R11_R12.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/programas/PROGRAMA_9_BLOQUES.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/programas/PROGRAMA_BATALLAS_REALES.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/integracion-pr17-pr31.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/README.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.1-municion.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.2-sensor-acustico.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.3-sensores-catalogo.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.4-secreto-jwt.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.5-sandbox-fail-closed.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.6-ci-sandbox.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.7-docker-sock.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.8-rate-limit-proxy.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R1.9-zone-control-koth.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.1-tipos-ci.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.2-semaforo-ci.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.3-split-suite.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.4-ast-auth.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.5-colas-firma.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.6-subidas-cabeceras.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.7-determinismo.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R2.8-cli-arena-sim-js.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R3.1-replay-interpolado.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R3.2-interp-camara.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R3.7-panel.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R3.8-modos-baratos.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R4-totp.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/rondas/ronda2/reportes/R6.1-runtimes-digests.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/status/ESTADO_ACTUAL.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/status/completadas-2026-11.md` | — | Historia | VIGENTE (registro) | GENERATE | funciones completadas que figuraban como pendientes, con PR y evidencia |
| `history/status/current-status-2026-10-21.md` | Estado (en roadmap/) | Historia | OBSOLETO | MOVE | movido desde roadmap/current-status.md (git mv) con aviso y enlaces corregidos |
| `history/status/estado-proyecto.md` | Historia | Historia | OBSOLETO (histórico) | KEEP | archivado; el índice lleva el aviso |
| `history/status/known-issues-2026-10.md` | Síntomas (en roadmap/) | Historia | OBSOLETO | MOVE | movido desde roadmap/known-issues.md (git mv) con aviso y enlaces corregidos |
| `operations/backup.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/configuration.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/diagnostics.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/docker-proxy.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/docker.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/firewall.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/first-run.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/index.md` | Operación (índice) | Operación (índice) | VIGENTE | UPDATE | sección operador vs administrador del juego; fila de observabilidad; enlace a recuperacion.md histórico |
| `operations/installation.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/networking.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/observability.md` | — | Operación | VIGENTE | GENERATE | nuevo: perfil, alertas y canal de avisos (§19) |
| `operations/readiness.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/restore.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/runtime-drift-scanner.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/shutdown.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/streaming.md` | Operación | Operación | VIGENTE (ajeno) | KEEP | no se toca: otro equipo lo está cambiando |
| `operations/troubleshooting.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `operations/upgrades.md` | Operación | Operación | VIGENTE (verificación original) | KEEP | sólo reorganización y enlaces; el contenido conserva su verificación |
| `overview/architecture.md` | Visión general | Visión general | VIGENTE | UPDATE | FICHERO AJENO: una línea del diagrama (stub HunterBot) |
| `overview/glossary.md` | Visión general | Visión general | VIGENTE | UPDATE | FICHERO AJENO: sólo se quitaron afirmaciones falsas (stub HunterBot, build sin sandbox) |
| `overview/index.md` | Visión general | Visión general | VIGENTE (verificación original) | KEEP | no es de DOC-B |
| `overview/project.md` | Visión general | Visión general | VIGENTE (verificación original) | KEEP | no es de DOC-B |
| `overview/technologies.md` | Visión general | Visión general | VIGENTE (verificación original) | KEEP | no es de DOC-B |
| `recuperacion.md` | Runbook (histórico, anclado por un test) | Historia | OBSOLETO (con aviso) | KEEP | no se mueve: lo lee infrastructure/tests/backup.test.ts y acceptance/criteria.mjs; DOC-C debe decidir reapuntar el test |
| `roadmap/current-status.md` | Estado (histórico, RC2) | Estado actual | OBSOLETO -> VIGENTE | UPDATE | reescrito: sólo estado de hoy; el anterior se archivó en history/status/ |
| `roadmap/index.md` | Estado | Estado | VIGENTE | UPDATE | enlaces a la auditoría y al registro de completadas; reglas de mantenimiento |
| `roadmap/known-issues.md` | Síntomas (octubre) | Síntomas vigentes | OBSOLETO -> VIGENTE | UPDATE | sólo vigentes; resueltos archivados en history/status/ |
| `roadmap/pending-features.md` | Pendientes (SHA 27f70bb) | Pendientes | OBSOLETO -> VIGENTE | UPDATE | 28 elementos auditados; 7 DONE salen; PARCIAL/PENDIENTE con evidencia |
| `roadmap/technical-debt.md` | Deuda | Deuda | PARCIAL -> VIGENTE | UPDATE | 31 TD con nota de auditoría 2026-11-02 (tres cerradas por esta pasada: TD-001, TD-047, TD-065; el resto, estado confirmado o matizado), 7 TD nuevas (066-072); el resto conserva su evidencia original, marcada como tal |
| `technical/api.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | sección con las 23 rutas del contrato 0.12.0 que faltaban |
| `technical/architecture.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/battles.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | estado de despliegue y pendientes |
| `technical/bot-versioning.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/bots.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | TD-047 y TD-001 cerrados; despliegue |
| `technical/data-flow.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/database.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | migraciones 012–016 (16 en total) |
| `technical/engine.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | motor 0.4.0; estado actual corregido (ejecución real hecha, radio sin alcance ni equipo comprobada) |
| `technical/equipment.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/frontend.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/game-modes.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | POST /battles ya valida contenido; stub HunterBot ya no juega |
| `technical/gateway.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | TD-004 ya no «sin desplegar» |
| `technical/index.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | frase del editor visual |
| `technical/maps.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | POST /battles ya valida contenido |
| `technical/queue.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/replays.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | TD-004 ya no «sin desplegar» |
| `technical/security.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | tabla de superficies abiertas al día |
| `technical/services.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/tournaments.md` | Técnica | Técnica | VIGENTE (parcialmente re-verificado) | UPDATE | teams alcanzable, mapPool, TD-001/002 cerradas |
| `technical/websocket.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `technical/workers.md` | Técnica | Técnica | VIGENTE (verificación original 27f70bb/0b8c12b; sin re-auditar línea a línea) | KEEP | no se ha vuelto a verificar; contradicciones conocidas arriba |
| `testing/acceptance/acceptance-visual.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/drills/backup-evidencia.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/drills/gamedays/README.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/drills/gamedays/acta-2026-07-16-m3.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/engine/ENGINE_REGRESSION_LOCKS.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/index.md` | Pruebas (histórico) | Pruebas (evidencia) | HISTÓRICO (evidencia) | UPDATE | público declarado; enlace a audits/ |
| `testing/smoke/batalla-smoke-containerizada.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/spikes/R13_5_SLICE2_SPIKE.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/validacion/CHECKLIST_VALIDACION_V2.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/validacion/CHECKLIST_VALIDACION_V4.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
| `testing/validacion/CHECKLIST_VALIDACION_V5.md` | Pruebas (evidencia) | Pruebas (evidencia) | HISTÓRICO (evidencia) | KEEP | describe lo probado en su fecha |
