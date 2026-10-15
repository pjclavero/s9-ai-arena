# Mapa de migración documental (consolidación 2026-10)

## Resumen

Destino de **cada uno de los 138 ficheros Markdown** que había en `origin/main` (`27f70bb`) antes de
la consolidación documental de 2026-10, con la acción aplicada y su razón. Los movimientos se
hicieron con `git mv` (se conserva el historial: `git log --follow <ruta nueva>`). Ningún documento
se ha borrado. Este mapa es la referencia para encontrar un documento antiguo y para saber qué
documento canónico lo sustituye.

## Índice

- [Acciones](#acciones)
- [Recuento](#recuento)
- [Tabla completa](#tabla-completa)
- [Ficheros anclados por el código](#ficheros-anclados-por-el-código)
- [Topología enmascarada](#topología-enmascarada)
- [Referencias del código a rutas antiguas](#referencias-del-código-a-rutas-antiguas)
- [Otros artefactos](#otros-artefactos)
- [Verificación](#verificación)

## Acciones

| Acción | Significado |
|---|---|
| KEEP | se queda donde está, sin cambios de contenido |
| UPDATE | se queda donde está y se modifica (o lo reescribe su propietario) |
| MERGE | su contenido vigente lo absorbe un documento canónico nuevo; el original se **archiva** en `docs/history/`, `docs/testing/` o `docs/audits/anteriores/` |
| MOVE | se reubica tal cual (ADR, auditorías previas, evidencias de pruebas) o como documento vigente de `operations/`/`development/` |
| ARCHIVE | histórico sin documento canónico que lo sustituya; a `docs/history/` |
| DELETE | eliminado (duplicado puro o relleno sin información). **No se ha usado**: los placeholders de 4 líneas de paquetes se conservan por la regla de READMEs de paquete y ningún duplicado era puro |

## Recuento

| KEEP | UPDATE | MERGE | MOVE | ARCHIVE | DELETE | Total |
|---|---|---|---|---|---|---|
| 21 | 2 | 49 | 22 | 44 | 0 | 138 |

Carpetas de evidencia, cada una con su índice razonado: [adr/](adr/index.md),
[testing/](testing/index.md), [history/](history/index.md), [audits/anteriores/](audits/anteriores/index.md).

## Tabla completa

Rutas relativas a la raíz del repositorio. «Canónico» = documento vigente que absorbe el contenido
(entre paréntesis, el agente propietario en la consolidación: A estado/arquitectura, B producto, SUP supervisor;
sin paréntesis, operación/desarrollo).

| # | Documento en 27f70bb | Acción | Ruta actual | Canónico | Razón |
|---|---|---|---|---|---|
| 1 | `README.md` | UPDATE | `README.md` | README.md (SUP) | Portada del repo; la reescribe el supervisor (estado honesto + enlaces al árbol nuevo). |
| 2 | `docs/recuperacion.md` | UPDATE | [`docs/recuperacion.md`](recuperacion.md) | operations/backup.md + operations/restore.md | ANCLADO: infrastructure/tests/backup.test.ts:1841 lee esta ruta. Se queda en su sitio con aviso HISTÓRICO/PELIGROSO al principio; el runbook vigente es operations/restore.md. Deuda: reapuntar el test. |
| 3 | `apps/bot-manager/README.md` | KEEP | `apps/bot-manager/README.md` | — | Placeholder de 4 líneas; se conserva (regla de READMEs de paquete). Documentación real: docs/technical/services.md y bots.md. |
| 4 | `apps/replay-service/README.md` | KEEP | `apps/replay-service/README.md` | — | README de paquete con contenido real. |
| 5 | `apps/tournament-worker/README.md` | KEEP | `apps/tournament-worker/README.md` | — | README de paquete con contenido real. |
| 6 | `apps/web/README.md` | KEEP | `apps/web/README.md` | — | Placeholder de 4 líneas; se conserva. Documentación real: docs/technical/frontend.md. |
| 7 | `bots/s9-smoke-bot/README.md` | KEEP | `bots/s9-smoke-bot/README.md` | — | README del bot de humo. |
| 8 | `docs/aceptacion/ultimo-informe.md` | KEEP | [`docs/aceptacion/ultimo-informe.md`](aceptacion/ultimo-informe.md) | — | Artefacto GENERADO: acceptance/run-acceptance.mjs:90 lo escribe y .github/workflows/acceptance.yml:38 lo sube. Moverlo rompería el flujo. |
| 9 | `docs/balance/informe-v1.md` | KEEP | [`docs/balance/informe-v1.md`](balance/informe-v1.md) | — | Artefacto GENERADO: packages/module-catalog/balance/run.ts:217 lo escribe byte a byte. |
| 10 | `docs/balance/v1.md` | KEEP | [`docs/balance/v1.md`](balance/v1.md) | technical/equipment.md (B, fuente) | Pareja del informe generado; citado desde packages/module-catalog/balance/archetypes.ts. B lo usa como fuente de technical/equipment.md. |
| 11 | `example-bots/javascript/README.md` | KEEP | `example-bots/javascript/README.md` | — | Guía del bot de ejemplo JS. |
| 12 | `example-bots/python/README.md` | KEEP | `example-bots/python/README.md` | — | Guía del bot de ejemplo Python. |
| 13 | `infrastructure/secrets/README.md` | KEEP | `infrastructure/secrets/README.md` | — | Nota breve pero correcta junto a los secretos (no versionados). |
| 14 | `packages/protocol/README.md` | KEEP | `packages/protocol/README.md` | — | README de paquete con contenido real (menor: cita `npm run build` inexistente en raíz). |
| 15 | `packages/shared-types/README.md` | KEEP | `packages/shared-types/README.md` | — | Placeholder de 4 líneas; se conserva (el directorio sólo tiene el README). |
| 16 | `runtimes/README.md` | KEEP | `runtimes/README.md` | — | Placeholder de 4 líneas; se conserva. |
| 17 | `runtimes/node/ALLOWED-PACKAGES.md` | KEEP | `runtimes/node/ALLOWED-PACKAGES.md` | — | Lista de paquetes permitidos del runtime (referencia de usuario). |
| 18 | `runtimes/python/ALLOWED-PACKAGES.md` | KEEP | `runtimes/python/ALLOWED-PACKAGES.md` | — | Lista de paquetes permitidos del runtime (referencia de usuario). |
| 19 | `sdks/dotnet/README.md` | KEEP | `sdks/dotnet/README.md` | — | Placeholder de SDK post-MVP; se conserva (el directorio sólo tiene el README). |
| 20 | `sdks/java/README.md` | KEEP | `sdks/java/README.md` | — | Placeholder de SDK post-MVP; se conserva (el directorio sólo tiene el README). |
| 21 | `sdks/javascript/README.md` | KEEP | `sdks/javascript/README.md` | — | README del SDK JS (referencia de autor de bots). |
| 22 | `sdks/python/README.md` | KEEP | `sdks/python/README.md` | — | README del SDK Python (referencia de autor de bots). |
| 23 | `tests/sandbox-escape/README.md` | KEEP | `tests/sandbox-escape/README.md` | — | README de la suite de escape del sandbox. |
| 24 | `docs/CHECKLIST_VALIDACION_V2.md` | MOVE | [`docs/testing/validacion/CHECKLIST_VALIDACION_V2.md`](testing/validacion/CHECKLIST_VALIDACION_V2.md) | — | Checklist de validación de un despliegue concreto (topología enmascarada). |
| 25 | `docs/CHECKLIST_VALIDACION_V4.md` | MOVE | [`docs/testing/validacion/CHECKLIST_VALIDACION_V4.md`](testing/validacion/CHECKLIST_VALIDACION_V4.md) | — | Checklist de validación V4. |
| 26 | `docs/CHECKLIST_VALIDACION_V5.md` | MOVE | [`docs/testing/validacion/CHECKLIST_VALIDACION_V5.md`](testing/validacion/CHECKLIST_VALIDACION_V5.md) | — | Checklist de validación V5. |
| 27 | `docs/R13_5_SLICE2_SPIKE.md` | MOVE | [`docs/testing/spikes/R13_5_SLICE2_SPIKE.md`](testing/spikes/R13_5_SLICE2_SPIKE.md) | — | Informe de spike experimental (snapshot Rapier). |
| 28 | `docs/R14_ADR_WEBRTC.md` | MOVE | [`docs/adr/ADR-R14-webrtc.md`](adr/ADR-R14-webrtc.md) | — | ADR que vivía fuera de la carpeta de decisiones (decisión de NO implementar WebRTC). |
| 29 | `docs/auditoria-2026-07-16.md` | MOVE | [`docs/audits/anteriores/auditoria-2026-07-16.md`](audits/anteriores/auditoria-2026-07-16.md) | — | Auditoría previa. |
| 30 | `docs/auditoria-consolidada-2026-07-16.md` | MOVE | [`docs/audits/anteriores/auditoria-consolidada-2026-07-16.md`](audits/anteriores/auditoria-consolidada-2026-07-16.md) | — | Auditoría previa consolidada. |
| 31 | `docs/compatibilidad.md` | MOVE | [`docs/development/contract-compatibility.md`](development/contract-compatibility.md) | — | Política de versionado de contratos; vigente para desarrollo. |
| 32 | `docs/decisiones/ADR-000-decisiones-fundacionales.md` | MOVE | [`docs/adr/ADR-000-decisiones-fundacionales.md`](adr/ADR-000-decisiones-fundacionales.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 33 | `docs/decisiones/ADR-010-devops-ci-observabilidad-backup.md` | MOVE | [`docs/adr/ADR-010-devops-ci-observabilidad-backup.md`](adr/ADR-010-devops-ci-observabilidad-backup.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 34 | `docs/decisiones/ADR-016-identidad-de-build.md` | MOVE | [`docs/adr/ADR-016-identidad-de-build.md`](adr/ADR-016-identidad-de-build.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 35 | `docs/decisiones/ADR-017-contrato-de-release.md` | MOVE | [`docs/adr/ADR-017-contrato-de-release.md`](adr/ADR-017-contrato-de-release.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 36 | `docs/decisiones/ADR-018-semantica-del-scan.md` | MOVE | [`docs/adr/ADR-018-semantica-del-scan.md`](adr/ADR-018-semantica-del-scan.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 37 | `docs/decisiones/ADR-E7-001-migraciones-knex.md` | MOVE | [`docs/adr/ADR-E7-001-migraciones-knex.md`](adr/ADR-E7-001-migraciones-knex.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 38 | `docs/decisiones/ADR-E7-002-postgres-embebido-en-tests.md` | MOVE | [`docs/adr/ADR-E7-002-postgres-embebido-en-tests.md`](adr/ADR-E7-002-postgres-embebido-en-tests.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 39 | `docs/decisiones/ADR-E7-003-panel-react-vite.md` | MOVE | [`docs/adr/ADR-E7-003-panel-react-vite.md`](adr/ADR-E7-003-panel-react-vite.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 40 | `docs/decisiones/ADR-E9-001-cola-postgres-redis.md` | MOVE | [`docs/adr/ADR-E9-001-cola-postgres-redis.md`](adr/ADR-E9-001-cola-postgres-redis.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 41 | `docs/decisiones/ADR-E9-002-rating-elo.md` | MOVE | [`docs/adr/ADR-E9-002-rating-elo.md`](adr/ADR-E9-002-rating-elo.md) | — | ADR: a docs/adr/ conservando número y nombre. |
| 42 | `docs/gamedays/README.md` | MOVE | [`docs/testing/drills/gamedays/README.md`](testing/drills/gamedays/README.md) | — | Guiones de game day (pruebas de caos). Evidencia/procedimiento de pruebas. |
| 43 | `docs/gamedays/acta-2026-07-16-m3.md` | MOVE | [`docs/testing/drills/gamedays/acta-2026-07-16-m3.md`](testing/drills/gamedays/acta-2026-07-16-m3.md) | — | Acta de game day M3. |
| 44 | `docs/ops/docker-proxy.md` | MOVE | [`docs/operations/docker-proxy.md`](operations/docker-proxy.md) | — | Runbook correcto del s9-docker-proxy (DOC_CORRECT en auditoría); pasa a operations/ con cabecera de estado. |
| 45 | `docs/ops/runtime-drift-scanner.md` | MOVE | [`docs/operations/runtime-drift-scanner.md`](operations/runtime-drift-scanner.md) | — | Herramienta de deriva de runtime; pasa a operations/ (enlazada desde upgrades/diagnostics). |
| 46 | `docs/B11_PANEL_VERSIONES_VERDAD.md` | MERGE | [`docs/history/disenos/B11_PANEL_VERSIONES_VERDAD.md`](history/disenos/B11_PANEL_VERSIONES_VERDAD.md) | technical/frontend.md (B) + technical/bots.md (B) | Defecto del panel de versiones de bots (B11). |
| 47 | `docs/BACKLOG_POST_PROGRAMA.md` | MERGE | [`docs/history/programas/BACKLOG_POST_PROGRAMA.md`](history/programas/BACKLOG_POST_PROGRAMA.md) | roadmap/pending-features.md (A) | Backlog: lo aún pendiente lo absorbe roadmap. |
| 48 | `docs/BACKUP_RUNTIME_ALIGNMENT.md` | MERGE | [`docs/history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md`](history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md) | operations/backup.md | Alineación del backup; contiene `restic forget --prune` (destructivo) como análisis. |
| 49 | `docs/CARRIL_I_EXECUTION_GATE.md` | MERGE | [`docs/history/disenos/CARRIL_I_EXECUTION_GATE.md`](history/disenos/CARRIL_I_EXECUTION_GATE.md) | technical/battles.md (B) + technical/security.md (A) + operations/readiness.md | Puerta de ejecución real (I-8..I-14 pendientes). |
| 50 | `docs/CARRIL_J_GATE_SPECTATOR.md` | MERGE | [`docs/history/disenos/CARRIL_J_GATE_SPECTATOR.md`](history/disenos/CARRIL_J_GATE_SPECTATOR.md) | technical/replays.md (B) + technical/security.md (A) + operations/networking.md | Puerta de espectador/replays públicos (G0 /replays/ abierto). |
| 51 | `docs/COMPOSE_CANONICO.md` | MERGE | [`docs/history/operaciones/COMPOSE_CANONICO.md`](history/operaciones/COMPOSE_CANONICO.md) | operations/docker.md + operations/upgrades.md | Estado 'propuesto, no aplicado' obsoleto. |
| 52 | `docs/CONTRATO_DESPLIEGUE.md` | MERGE | [`docs/history/operaciones/CONTRATO_DESPLIEGUE.md`](history/operaciones/CONTRATO_DESPLIEGUE.md) | operations/upgrades.md + operations/docker.md | Contrato de despliegue (deploy-contract.json). |
| 53 | `docs/DESPLIEGUE_DOMINIO.md` | MERGE | [`docs/history/operaciones/DESPLIEGUE_DOMINIO.md`](history/operaciones/DESPLIEGUE_DOMINIO.md) | operations/networking.md | Instalación concreta tras proxy (WAN obsoleta enmascarada). |
| 54 | `docs/ENGINE_REGRESSION_LOCKS.md` | MERGE | [`docs/testing/engine/ENGINE_REGRESSION_LOCKS.md`](testing/engine/ENGINE_REGRESSION_LOCKS.md) | development/testing.md + technical/engine.md (B) | Candados de regresión del motor; cita un fichero que nunca existió (regression-locks.test.ts). |
| 55 | `docs/ESTADO_ACTUAL.md` | MERGE | [`docs/history/status/ESTADO_ACTUAL.md`](history/status/ESTADO_ACTUAL.md) | roadmap/current-status.md (A) | Estado de 2026-07/09, obsoleto (perfil nucleo, :local, WAN). Topología enmascarada. |
| 56 | `docs/NEXT_PHASE_R10_R11_R12.md` | MERGE | [`docs/history/programas/NEXT_PHASE_R10_R11_R12.md`](history/programas/NEXT_PHASE_R10_R11_R12.md) | roadmap/pending-features.md (A) | Plan de fase R10-R12. |
| 57 | `docs/OPERACION_VM<id>.md` | MERGE | [`docs/history/operaciones/OPERACION_HOST_ARENA.md`](history/operaciones/OPERACION_HOST_ARENA.md) | operations/diagnostics.md + operations/upgrades.md + operations/docker.md | Runbook de la instalación concreta con comandos PELIGROSOS/ROTOS (nucleo down, qm rollback, pg_dumpall -U postgres). Renombrado sin VMID; topología enmascarada. |
| 58 | `docs/OVERRIDE_VERSION_POR_SERVICIO.md` | MERGE | [`docs/history/operaciones/OVERRIDE_VERSION_POR_SERVICIO.md`](history/operaciones/OVERRIDE_VERSION_POR_SERVICIO.md) | operations/upgrades.md | Override por servicio; estado obsoleto (82c74a8 vs 0daa500). |
| 59 | `docs/R10_MAP_EDITOR_FOUNDATION.md` | MERGE | [`docs/history/disenos/R10_MAP_EDITOR_FOUNDATION.md`](history/disenos/R10_MAP_EDITOR_FOUNDATION.md) | technical/maps.md (B) | Editor de mapas (R10). |
| 60 | `docs/R10_MAP_EDITOR_SLICE1.md` | MERGE | [`docs/history/disenos/R10_MAP_EDITOR_SLICE1.md`](history/disenos/R10_MAP_EDITOR_SLICE1.md) | technical/maps.md (B) | Editor de mapas slice 1 (sólo cliente). |
| 61 | `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md` | MERGE | [`docs/history/disenos/R11_PUBLIC_SPECTATOR_FOUNDATION.md`](history/disenos/R11_PUBLIC_SPECTATOR_FOUNDATION.md) | technical/websocket.md (B) + technical/replays.md (B) | Espectador público (R11). |
| 62 | `docs/R11_SPECTATOR.md` | MERGE | [`docs/history/disenos/R11_SPECTATOR.md`](history/disenos/R11_SPECTATOR.md) | technical/websocket.md (B) + user/viewer.md (B) | Espectador (R11). |
| 63 | `docs/R12_BRACKET_SLICE1.md` | MERGE | [`docs/history/disenos/R12_BRACKET_SLICE1.md`](history/disenos/R12_BRACKET_SLICE1.md) | technical/tournaments.md (B) | Cuadro de torneo (R12). |
| 64 | `docs/R12_PREPARE_BATTLE_MATCHMAKING.md` | MERGE | [`docs/history/disenos/R12_PREPARE_BATTLE_MATCHMAKING.md`](history/disenos/R12_PREPARE_BATTLE_MATCHMAKING.md) | technical/tournaments.md (B) + technical/battles.md (B) | Preparación de batalla y emparejamiento (R12). |
| 65 | `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` | MERGE | [`docs/history/disenos/R12_TOURNAMENTS_RANKING_MATCHMAKING.md`](history/disenos/R12_TOURNAMENTS_RANKING_MATCHMAKING.md) | technical/tournaments.md (B) | Torneos, ranking y emparejamiento (R12). |
| 66 | `docs/R13_1_RUNTIME_INSPECTOR.md` | MERGE | [`docs/history/disenos/R13_1_RUNTIME_INSPECTOR.md`](history/disenos/R13_1_RUNTIME_INSPECTOR.md) | technical/engine.md (B) | Inspector de runtime del motor (R13.1). |
| 67 | `docs/R13_2_HARDENING.md` | MERGE | [`docs/history/disenos/R13_2_HARDENING.md`](history/disenos/R13_2_HARDENING.md) | technical/security.md (A) + technical/engine.md (B) | Endurecimiento (R13.2). |
| 68 | `docs/R13_5_SAVE_SHARDING.md` | MERGE | [`docs/history/disenos/R13_5_SAVE_SHARDING.md`](history/disenos/R13_5_SAVE_SHARDING.md) | technical/engine.md (B) | Save/sharding: diseño + slice 1. |
| 69 | `docs/R13_ENGINE_RUNTIME_QUALITY.md` | MERGE | [`docs/history/disenos/R13_ENGINE_RUNTIME_QUALITY.md`](history/disenos/R13_ENGINE_RUNTIME_QUALITY.md) | technical/engine.md (B) | Plan de calidad del motor (R13). |
| 70 | `docs/R14_WEBRTC_STREAMING.md` | MERGE | [`docs/history/disenos/R14_WEBRTC_STREAMING.md`](history/disenos/R14_WEBRTC_STREAMING.md) | adr/ADR-R14-webrtc.md | Diseño de streaming WebRTC no implementado (lo cierra el ADR R14). |
| 71 | `docs/R16_DESIGN_SYSTEM.md` | MERGE | [`docs/history/disenos/R16_DESIGN_SYSTEM.md`](history/disenos/R16_DESIGN_SYSTEM.md) | technical/frontend.md (B) | Sistema de diseño de la web (R16). |
| 72 | `docs/R16_VISUAL_AUDIT.md` | MERGE | [`docs/audits/anteriores/R16_VISUAL_AUDIT.md`](audits/anteriores/R16_VISUAL_AUDIT.md) | technical/frontend.md (B) | Auditoría visual de la web (R16); sus conclusiones vigentes las absorbe frontend.md. |
| 73 | `docs/R16_VISUAL_SLICE1.md` | MERGE | [`docs/history/disenos/R16_VISUAL_SLICE1.md`](history/disenos/R16_VISUAL_SLICE1.md) | technical/frontend.md (B) | Slice visual 1 (R16). |
| 74 | `docs/R16_VISUAL_UPGRADE.md` | MERGE | [`docs/history/disenos/R16_VISUAL_UPGRADE.md`](history/disenos/R16_VISUAL_UPGRADE.md) | technical/frontend.md (B) | Mejora visual (R16). |
| 75 | `docs/R17_ASISTENTE_PRIMER_ARRANQUE.md` | MERGE | [`docs/history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md`](history/operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md) | operations/first-run.md + operations/readiness.md | Asistente de primer arranque (R17). |
| 76 | `docs/R17_INSTALACION_READINESS.md` | MERGE | [`docs/history/operaciones/R17_INSTALACION_READINESS.md`](history/operaciones/R17_INSTALACION_READINESS.md) | operations/readiness.md | Readiness R17 con ids de checks y cifras obsoletos. |
| 77 | `docs/R6_2_REAL_BATTLE_RUNS.md` | MERGE | [`docs/history/disenos/R6_2_REAL_BATTLE_RUNS.md`](history/disenos/R6_2_REAL_BATTLE_RUNS.md) | technical/battles.md (B) | Batallas reales /run (R6.2). |
| 78 | `docs/R7A_OPERATIONAL_REPLAY_INGEST.md` | MERGE | [`docs/history/disenos/R7A_OPERATIONAL_REPLAY_INGEST.md`](history/disenos/R7A_OPERATIONAL_REPLAY_INGEST.md) | technical/replays.md (B) | Ingesta de replays; variables REPLAY_INGEST_ENABLED/RETRIES mal atribuidas a la API. |
| 79 | `docs/R7_REPLAY_VIEWER.md` | MERGE | [`docs/history/disenos/R7_REPLAY_VIEWER.md`](history/disenos/R7_REPLAY_VIEWER.md) | technical/replays.md (B) + technical/frontend.md (B) | Visor de replays (R7). |
| 80 | `docs/R8_ADMIN_MANAGEMENT.md` | MERGE | [`docs/history/disenos/R8_ADMIN_MANAGEMENT.md`](history/disenos/R8_ADMIN_MANAGEMENT.md) | technical/frontend.md (B) + user/administration.md (B) | Gestión admin (R8), duplica parcialmente R8_GESTION_ADMIN. |
| 81 | `docs/R8_GESTION_ADMIN.md` | MERGE | [`docs/history/disenos/R8_GESTION_ADMIN.md`](history/disenos/R8_GESTION_ADMIN.md) | technical/frontend.md (B) + user/administration.md (B) | Gestión admin (R8), base distinta de main. |
| 82 | `docs/R9_BATTLE_CREATION.md` | MERGE | [`docs/history/disenos/R9_BATTLE_CREATION.md`](history/disenos/R9_BATTLE_CREATION.md) | technical/battles.md (B) | Creación de batallas (R9). |
| 83 | `docs/ROADMAP.md` | MERGE | [`docs/history/planes/ROADMAP.md`](history/planes/ROADMAP.md) | roadmap/pending-features.md (A) | Roadmap antiguo de v2. |
| 84 | `docs/despliegue.md` | MERGE | [`docs/history/operaciones/despliegue.md`](history/operaciones/despliegue.md) | operations/installation.md + operations/upgrades.md + operations/networking.md + development/releases.md | 'Instalación en tres pasos' no reproducible (TAG=latest); red s9-ai-arena_arena inexistente. |
| 85 | `docs/estado-proyecto.md` | MERGE | [`docs/history/status/estado-proyecto.md`](history/status/estado-proyecto.md) | roadmap/current-status.md (A) | Segunda 'fuente de verdad' de 2026-07-16 (pre-despliegue). |
| 86 | `docs/getting-started.md` | MERGE | [`docs/history/disenos/getting-started.md`](history/disenos/getting-started.md) | development/setup.md + development/testing.md | Contradice engines (Node 20 'soportado'). |
| 87 | `docs/mapas/formato-tmx.md` | MERGE | [`docs/history/disenos/formato-tmx.md`](history/disenos/formato-tmx.md) | technical/maps.md (B) + user/maps.md (B) | Formato de importación TMX (Tiled). |
| 88 | `docs/ops/APAGADO_Y_ENCENDIDO_VM<id>.md` | MERGE | [`docs/history/operaciones/APAGADO_Y_ENCENDIDO.md`](history/operaciones/APAGADO_Y_ENCENDIDO.md) | operations/shutdown.md | Runbook de apagado; su §2 (cierre limpio de PG) está refutado. Renombrado sin VMID; hipervisor/IPs enmascarados. |
| 89 | `docs/ops/acceptance-visual.md` | MERGE | [`docs/testing/acceptance/acceptance-visual.md`](testing/acceptance/acceptance-visual.md) | development/testing.md | Cómo correr la aceptación visual Playwright; lo vigente va a development/testing.md. |
| 90 | `docs/ops/backup-evidencia.md` | MERGE | [`docs/testing/drills/backup-evidencia.md`](testing/drills/backup-evidencia.md) | operations/backup.md | Evidencia de backup; lo vigente pasa a operations/backup.md. |
| 91 | `docs/ops/batalla-smoke-containerizada.md` | MERGE | [`docs/testing/smoke/batalla-smoke-containerizada.md`](testing/smoke/batalla-smoke-containerizada.md) | technical/battles.md (B) | Smoke de batalla con contenedores (R6.2). |
| 92 | `docs/ops/contenido-base.md` | MERGE | [`docs/history/operaciones/contenido-base.md`](history/operaciones/contenido-base.md) | operations/first-run.md | bootstrap del contenido base (correcto); vigente en first-run.md. |
| 93 | `docs/sdk-paridad.md` | MERGE | [`docs/history/disenos/sdk-paridad.md`](history/disenos/sdk-paridad.md) | technical/bots.md (B) | Paridad SDK Python/JS (citado en comentarios de sdks/javascript). |
| 94 | `docs/streaming-runbook.md` | MERGE | [`docs/history/operaciones/streaming-runbook.md`](history/operaciones/streaming-runbook.md) | technical/websocket.md (B) + user/viewer.md (B) | Runbook de retransmisión (streamer fuera del perfil production). |
| 95 | `docs/Dosier_tareas_S9_AI_Arena.md` | ARCHIVE | [`docs/history/planes/Dosier_tareas_S9_AI_Arena.md`](history/planes/Dosier_tareas_S9_AI_Arena.md) | — | Dosier de tareas original (plan histórico). |
| 96 | `docs/MIGRACION_V2.md` | ARCHIVE | [`docs/history/operaciones/MIGRACION_V2.md`](history/operaciones/MIGRACION_V2.md) | — | Migración v1->v2 ya ejecutada; rollback por snapshot inexistente. |
| 97 | `docs/PROGRAMA_9_BLOQUES.md` | ARCHIVE | [`docs/history/programas/PROGRAMA_9_BLOQUES.md`](history/programas/PROGRAMA_9_BLOQUES.md) | — | Programa de 9 bloques (cerrado). |
| 98 | `docs/PROGRAMA_BATALLAS_REALES.md` | ARCHIVE | [`docs/history/programas/PROGRAMA_BATALLAS_REALES.md`](history/programas/PROGRAMA_BATALLAS_REALES.md) | — | Programa de batallas reales (cerrado). |
| 99 | `docs/historial/FUSION.md` | ARCHIVE | [`docs/history/entregas/FUSION.md`](history/entregas/FUSION.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 100 | `docs/historial/README.md` | ARCHIVE | [`docs/history/entregas/README.md`](history/entregas/README.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 101 | `docs/historial/ROADMAP.md` | ARCHIVE | [`docs/history/entregas/ROADMAP.md`](history/entregas/ROADMAP.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 102 | `docs/historial/entrega-E1.md` | ARCHIVE | [`docs/history/entregas/entrega-E1.md`](history/entregas/entrega-E1.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 103 | `docs/historial/entrega-E10.md` | ARCHIVE | [`docs/history/entregas/entrega-E10.md`](history/entregas/entrega-E10.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 104 | `docs/historial/entrega-E11.md` | ARCHIVE | [`docs/history/entregas/entrega-E11.md`](history/entregas/entrega-E11.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 105 | `docs/historial/entrega-E12.md` | ARCHIVE | [`docs/history/entregas/entrega-E12.md`](history/entregas/entrega-E12.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 106 | `docs/historial/entrega-E2.md` | ARCHIVE | [`docs/history/entregas/entrega-E2.md`](history/entregas/entrega-E2.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 107 | `docs/historial/entrega-E3.md` | ARCHIVE | [`docs/history/entregas/entrega-E3.md`](history/entregas/entrega-E3.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 108 | `docs/historial/entrega-E4.md` | ARCHIVE | [`docs/history/entregas/entrega-E4.md`](history/entregas/entrega-E4.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 109 | `docs/historial/entrega-E5.md` | ARCHIVE | [`docs/history/entregas/entrega-E5.md`](history/entregas/entrega-E5.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 110 | `docs/historial/entrega-E6.md` | ARCHIVE | [`docs/history/entregas/entrega-E6.md`](history/entregas/entrega-E6.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 111 | `docs/historial/entrega-E7.md` | ARCHIVE | [`docs/history/entregas/entrega-E7.md`](history/entregas/entrega-E7.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 112 | `docs/historial/entrega-E8.md` | ARCHIVE | [`docs/history/entregas/entrega-E8.md`](history/entregas/entrega-E8.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 113 | `docs/historial/entrega-E9.md` | ARCHIVE | [`docs/history/entregas/entrega-E9.md`](history/entregas/entrega-E9.md) | — | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). |
| 114 | `docs/informes/integracion-pr17-pr31.md` | ARCHIVE | [`docs/history/rondas/integracion-pr17-pr31.md`](history/rondas/integracion-pr17-pr31.md) | — | Informe de integración de las Rondas 2/3. |
| 115 | `docs/ronda2/README.md` | ARCHIVE | [`docs/history/rondas/ronda2/README.md`](history/rondas/ronda2/README.md) | — | Registro de ejecución de la Ronda 2. |
| 116 | `docs/ronda2/reportes/R1.1-municion.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.1-municion.md`](history/rondas/ronda2/reportes/R1.1-municion.md) | — | Informe de tarea de la Ronda 2. |
| 117 | `docs/ronda2/reportes/R1.2-sensor-acustico.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.2-sensor-acustico.md`](history/rondas/ronda2/reportes/R1.2-sensor-acustico.md) | — | Informe de tarea de la Ronda 2. |
| 118 | `docs/ronda2/reportes/R1.3-sensores-catalogo.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.3-sensores-catalogo.md`](history/rondas/ronda2/reportes/R1.3-sensores-catalogo.md) | — | Informe de tarea de la Ronda 2. |
| 119 | `docs/ronda2/reportes/R1.4-secreto-jwt.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.4-secreto-jwt.md`](history/rondas/ronda2/reportes/R1.4-secreto-jwt.md) | — | Informe de tarea de la Ronda 2. |
| 120 | `docs/ronda2/reportes/R1.5-sandbox-fail-closed.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.5-sandbox-fail-closed.md`](history/rondas/ronda2/reportes/R1.5-sandbox-fail-closed.md) | — | Informe de tarea de la Ronda 2. |
| 121 | `docs/ronda2/reportes/R1.6-ci-sandbox.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.6-ci-sandbox.md`](history/rondas/ronda2/reportes/R1.6-ci-sandbox.md) | — | Informe de tarea de la Ronda 2. |
| 122 | `docs/ronda2/reportes/R1.7-docker-sock.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.7-docker-sock.md`](history/rondas/ronda2/reportes/R1.7-docker-sock.md) | — | Informe de tarea de la Ronda 2. |
| 123 | `docs/ronda2/reportes/R1.8-rate-limit-proxy.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.8-rate-limit-proxy.md`](history/rondas/ronda2/reportes/R1.8-rate-limit-proxy.md) | — | Informe de tarea de la Ronda 2. |
| 124 | `docs/ronda2/reportes/R1.9-zone-control-koth.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R1.9-zone-control-koth.md`](history/rondas/ronda2/reportes/R1.9-zone-control-koth.md) | — | Informe de tarea de la Ronda 2. |
| 125 | `docs/ronda2/reportes/R2.1-tipos-ci.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.1-tipos-ci.md`](history/rondas/ronda2/reportes/R2.1-tipos-ci.md) | — | Informe de tarea de la Ronda 2. |
| 126 | `docs/ronda2/reportes/R2.2-semaforo-ci.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.2-semaforo-ci.md`](history/rondas/ronda2/reportes/R2.2-semaforo-ci.md) | — | Informe de tarea de la Ronda 2. |
| 127 | `docs/ronda2/reportes/R2.3-split-suite.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.3-split-suite.md`](history/rondas/ronda2/reportes/R2.3-split-suite.md) | — | Informe de tarea de la Ronda 2. |
| 128 | `docs/ronda2/reportes/R2.4-ast-auth.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.4-ast-auth.md`](history/rondas/ronda2/reportes/R2.4-ast-auth.md) | — | Informe de tarea de la Ronda 2. |
| 129 | `docs/ronda2/reportes/R2.5-colas-firma.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.5-colas-firma.md`](history/rondas/ronda2/reportes/R2.5-colas-firma.md) | — | Informe de tarea de la Ronda 2. |
| 130 | `docs/ronda2/reportes/R2.6-subidas-cabeceras.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.6-subidas-cabeceras.md`](history/rondas/ronda2/reportes/R2.6-subidas-cabeceras.md) | — | Informe de tarea de la Ronda 2. |
| 131 | `docs/ronda2/reportes/R2.7-determinismo.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.7-determinismo.md`](history/rondas/ronda2/reportes/R2.7-determinismo.md) | — | Informe de tarea de la Ronda 2. |
| 132 | `docs/ronda2/reportes/R2.8-cli-arena-sim-js.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R2.8-cli-arena-sim-js.md`](history/rondas/ronda2/reportes/R2.8-cli-arena-sim-js.md) | — | Informe de tarea de la Ronda 2. |
| 133 | `docs/ronda2/reportes/R3.1-replay-interpolado.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R3.1-replay-interpolado.md`](history/rondas/ronda2/reportes/R3.1-replay-interpolado.md) | — | Informe de tarea de la Ronda 2. |
| 134 | `docs/ronda2/reportes/R3.2-interp-camara.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R3.2-interp-camara.md`](history/rondas/ronda2/reportes/R3.2-interp-camara.md) | — | Informe de tarea de la Ronda 2. |
| 135 | `docs/ronda2/reportes/R3.7-panel.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R3.7-panel.md`](history/rondas/ronda2/reportes/R3.7-panel.md) | — | Informe de tarea de la Ronda 2. |
| 136 | `docs/ronda2/reportes/R3.8-modos-baratos.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R3.8-modos-baratos.md`](history/rondas/ronda2/reportes/R3.8-modos-baratos.md) | — | Informe de tarea de la Ronda 2. |
| 137 | `docs/ronda2/reportes/R4-totp.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R4-totp.md`](history/rondas/ronda2/reportes/R4-totp.md) | — | Informe de tarea de la Ronda 2. |
| 138 | `docs/ronda2/reportes/R6.1-runtimes-digests.md` | ARCHIVE | [`docs/history/rondas/ronda2/reportes/R6.1-runtimes-digests.md`](history/rondas/ronda2/reportes/R6.1-runtimes-digests.md) | — | Informe de tarea de la Ronda 2. |

## Ficheros anclados por el código

No se movieron porque el código los lee o los genera en su ruta:

| Fichero | Quién depende de la ruta | Tratamiento |
|---|---|---|
| `docs/recuperacion.md` | `infrastructure/tests/backup.test.ts:1841` lo **lee** y comprueba su contenido | se queda, con aviso HISTÓRICO/PELIGROSO al principio; vigente: [operations/restore.md](operations/restore.md). Deuda: reapuntar el test |
| `docs/aceptacion/ultimo-informe.md` | `acceptance/run-acceptance.mjs:90` lo **escribe**; `.github/workflows/acceptance.yml:38` lo sube | KEEP |
| `docs/balance/informe-v1.md` | `packages/module-catalog/balance/run.ts:217` lo **escribe** | KEEP |
| `docs/balance/v1.md` | citado junto al anterior en `packages/module-catalog/balance/archetypes.ts` | KEEP |

## Topología enmascarada

En los documentos movidos se sustituyeron, con un script y revisión: IPs LAN → `192.0.2.x`
(proxy `192.0.2.4`, hipervisor `192.0.2.2`, host de la plataforma `192.0.2.10`, host de desarrollo
`192.0.2.5`, otro proyecto `192.0.2.7`), IP Tailscale → `198.51.100.10`, IPs públicas → `203.0.113.x`,
IP de `docker0` → `<ip-docker0>`, VMIDs → `<host-arena>`, `<proxy-host>`, `<host-dev>`,
`<host-otro-proyecto>`, `<vm-otra>`, `qm <op> <vmid>`; hipervisor → `<hipervisor>`; hosts internos →
`<host-dev>`, `<backup-host>`, `<host-arena>`; usuario del host de desarrollo → `<usuario-dev>`; dominio
real → `arena.example.internal` / `otro-proyecto.example.internal` / `*.example.internal`; repositorio
privado de infraestructura → `<repo-infra-privado>`. Ficheros con más sustituciones:

| Fichero (ruta actual) | Qué se enmascaró |
|---|---|
| [`docs/history/status/ESTADO_ACTUAL.md`](history/status/ESTADO_ACTUAL.md) | IP LAN, Tailscale y WAN; VMIDs; `qm rollback <vmid>`; hostname; dominio |
| [`docs/history/operaciones/OPERACION_HOST_ARENA.md`](history/operaciones/OPERACION_HOST_ARENA.md) | IP LAN y Tailscale; VMIDs; `qm snapshot/rollback`; hostnames; dominio; **renombrado** (antes `OPERACION_VM<id>.md`) |
| [`docs/history/operaciones/APAGADO_Y_ENCENDIDO.md`](history/operaciones/APAGADO_Y_ENCENDIDO.md) | IP LAN; VMIDs; nombre del hipervisor; **renombrado** (antes `ops/APAGADO_Y_ENCENDIDO_VM<id>.md`) |
| [`docs/history/operaciones/DESPLIEGUE_DOMINIO.md`](history/operaciones/DESPLIEGUE_DOMINIO.md) | IP LAN y WAN; VMIDs; dominio |
| [`docs/history/operaciones/despliegue.md`](history/operaciones/despliegue.md) | IP LAN; VMIDs; dominio |
| [`docs/history/operaciones/MIGRACION_V2.md`](history/operaciones/MIGRACION_V2.md) | IP LAN; VMIDs; `qm rollback <vmid>` |
| [`docs/history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md`](history/operaciones/BACKUP_RUNTIME_ALIGNMENT.md) | hostname de la VM y del host de respaldo |
| [`docs/testing/validacion/CHECKLIST_VALIDACION_V2.md`](testing/validacion/CHECKLIST_VALIDACION_V2.md) | IP LAN y Tailscale; VMIDs; dominio |
| [`docs/history/status/estado-proyecto.md`](history/status/estado-proyecto.md) | IP LAN; VMIDs; host de desarrollo y su usuario |
| [`docs/history/planes/Dosier_tareas_S9_AI_Arena.md`](history/planes/Dosier_tareas_S9_AI_Arena.md) | VMIDs; nombre del hipervisor |
| [`docs/testing/acceptance/acceptance-visual.md`](testing/acceptance/acceptance-visual.md) | IP LAN; VMIDs; dominio |
| [`docs/testing/smoke/batalla-smoke-containerizada.md`](testing/smoke/batalla-smoke-containerizada.md) | IP de `docker0`; VMIDs |
| [`docs/history/programas/PROGRAMA_BATALLAS_REALES.md`](history/programas/PROGRAMA_BATALLAS_REALES.md) | IP de `docker0`; VMIDs |
| [`docs/history/rondas/ronda2/reportes/R1.8-rate-limit-proxy.md`](history/rondas/ronda2/reportes/R1.8-rate-limit-proxy.md) | IPs públicas de ejemplo → 203.0.113.x; VMIDs; dominio |
| [`docs/operations/docker-proxy.md`](operations/docker-proxy.md) | IP de `docker0`; VMIDs |

Además se enmascararon identificadores de VM y hosts sueltos en ADR-016/017, auditorías previas, diseños
R6-R16, entregas, programas e informes de la Ronda 2. Los IDs de VM de los nombres de fichero se quitaron
(dos renombrados). El escaneo final da 0 hallazgos en todo `docs/` (ver [Verificación](#verificación)).

La topología **sigue** en ficheros que no son documentación de esta consolidación (fuera de su alcance):
`README.md` raíz (supervisor), `infrastructure/.env.example`, `infrastructure/gateway/nginx-behind-proxy.conf`,
`infrastructure/deploy-contract.json`, `infrastructure/scripts/smoke.sh` y tests/fixtures de
`infrastructure/tests` ([TD-008](roadmap/technical-debt.md#td-008)).

## Referencias del código a rutas antiguas

Comentarios y mensajes de código, workflows y configuración que citan rutas de `docs/` que ya no
existen (ninguno lee el fichero; sólo `backup.test.ts`, que se respetó). No se tocaron porque están
fuera de `docs/`; quedan como deuda menor para un PR de código:

| Ruta citada | Ruta actual | Citada en |
|---|---|---|
| `docs/COMPOSE_CANONICO.md` | `docs/history/operaciones/COMPOSE_CANONICO.md` | `.github/workflows/ci.yml` |
| `docs/ESTADO_ACTUAL.md` | `docs/history/status/ESTADO_ACTUAL.md` | `docker-compose.demo.yml` |
| `docs/R13_5_SAVE_SHARDING.md` | `docs/history/disenos/R13_5_SAVE_SHARDING.md` | `apps/arena-engine/src/checkpoint.ts`, `apps/arena-engine/tests/checkpoint.test.ts` |
| `docs/R13_5_SLICE2_SPIKE.md` | `docs/testing/spikes/R13_5_SLICE2_SPIKE.md` | `apps/arena-engine/tests/rapier-snapshot-spike.test.ts` |
| `docs/R16_DESIGN_SYSTEM.md` | `docs/history/disenos/R16_DESIGN_SYSTEM.md` | `apps/web/src/ui/primitives.tsx` |
| `docs/R16_VISUAL_UPGRADE.md` | `docs/history/disenos/R16_VISUAL_UPGRADE.md` | `apps/web/tests/viewer-r16-3.test.tsx` |
| `docs/compatibilidad.md` | `docs/development/contract-compatibility.md` | `apps/api/openapi.yaml`, `apps/api/src/h6-public-routes.test.ts` |
| `docs/decisiones/ADR-000-decisiones-fundacionales.md` | `docs/adr/ADR-000-decisiones-fundacionales.md` | `packages/game-rules/constants.ts` |
| `docs/decisiones/ADR-016-identidad-de-build.md` | `docs/adr/ADR-016-identidad-de-build.md` | `infrastructure/docker/arena-engine/Dockerfile`, `infrastructure/docker/backup/Dockerfile`, `infrastructure/docker/bot-manager/Dockerfile`, `infrastructure/docker/bot-runtime/Dockerfile`, `infrastructure/docker/gateway/Dockerfile`, `infrastructure/docker/node-service/Dockerfile`, `infrastructure/docker/streamer/Dockerfile`, `infrastructure/docker/web/Dockerfile` |
| `docs/decisiones/ADR-018-semantica-del-scan.md` | `docs/adr/ADR-018-semantica-del-scan.md` | `infrastructure/scripts/scan-gate.mjs` |
| `docs/despliegue.md` | `docs/history/operaciones/despliegue.md` | `.github/CODEOWNERS`, `.github/workflows/acceptance.yml`, `.github/workflows/ci.yml`, `acceptance/criteria.mjs`, `acceptance/run-acceptance.mjs`, `apps/api/src/middleware/proxy-trust.ts`, `apps/bot-manager/src/docker-proxy.ts`, `infrastructure/.env.example`, `infrastructure/docker-compose.yml`, `infrastructure/docker/gateway/Dockerfile`, `infrastructure/gateway/nginx-behind-proxy.conf`, `infrastructure/scripts/init-secrets.sh`, `infrastructure/scripts/smoke.sh` |
| `docs/entrega-E10.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `.github/workflows/ci.yml`, `acceptance/criteria.mjs`, `infrastructure/observability/prometheus/alerts.yml`, `infrastructure/observability/promtail/promtail-config.yml`, `infrastructure/tests/observability.test.ts` |
| `docs/entrega-E11.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `apps/streamer/src/supervisor.ts` |
| `docs/entrega-E12.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `tests/e2e/mvp-success.e2e.test.ts` |
| `docs/entrega-E3.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `apps/arena-engine/src/fixtures.ts` |
| `docs/entrega-E6.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `acceptance/criteria.mjs`, `acceptance/run-acceptance.mjs` |
| `docs/entrega-E7.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `apps/api/src/services/e6-bot-manager.ts`, `apps/api/src/spectate/gateway.ts` |
| `docs/entrega-E8.md` | ya no existía en 27f70bb (cita a `docs/` raíz de antes de 2026-07-17; hoy en `docs/history/entregas/`) | `apps/web/src/viewer/PhaserViewer.ts` |
| `docs/gamedays/README.md` | `docs/testing/drills/gamedays/README.md` | `tests/gamedays/gameday-m3.test.ts` |
| `docs/getting-started.md` | `docs/history/disenos/getting-started.md` | `apps/api/src/testing/test-db.ts`, `vitest.db.config.ts` |
| `docs/mapas/formato-tmx.md` | `docs/history/disenos/formato-tmx.md` | `apps/map-service/src/import-tiled.ts` |
| `docs/ops/acceptance-visual.md` | `docs/testing/acceptance/acceptance-visual.md` | `acceptance/visual/playwright.config.ts` |
| `docs/ops/docker-proxy.md` | `docs/operations/docker-proxy.md` | `infrastructure/systemd/docker-proxy.env.example`, `infrastructure/systemd/s9-docker-proxy.service` |
| `docs/ronda2/reportes/R2.2-semaforo-ci.md` | `docs/history/rondas/ronda2/reportes/R2.2-semaforo-ci.md` | `.github/workflows/ci.yml` |
| `docs/ronda2/reportes/R3.7-panel.md` | `docs/history/rondas/ronda2/reportes/R3.7-panel.md` | `apps/api/src/conformance.test.ts` |
| `docs/ronda2/reportes/R4-totp.md` | `docs/history/rondas/ronda2/reportes/R4-totp.md` | `apps/api/src/auth/totp.ts` |
| `docs/sdk-paridad.md` | `docs/history/disenos/sdk-paridad.md` | `sdks/javascript/src/arena-sim.ts`, `sdks/javascript/src/local-simulator.ts` |
| `docs/streaming-runbook.md` | `docs/history/operaciones/streaming-runbook.md` | `apps/streamer/src/ffmpeg.ts`, `infrastructure/docker/streamer/Dockerfile` |

También: `apps/api/openapi.yaml:1706` dice «ver docs/ops» (hoy [operations/](operations/index.md)).

## Otros artefactos

- `Dosier_tecnico_S9_AI_Arena_motor_2D_modular.docx` y `s9-ai-arena-part2.zip` (raíz): material
  histórico no Markdown; se quedan donde están (decisión del supervisor si se archivan).
- Enlaces rotos que quedan: `README.md` raíz (13 enlaces a rutas antiguas de `docs/`; lo reescribe el
  supervisor). Los enlaces de los documentos movidos y de los README de paquetes se corrigieron.

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| 138 ficheros `.md` en `27f70bb`, todos en la tabla, sin duplicados | CODE_VERIFIED | `git ls-files '*.md'` contra el mapa (script de la consolidación) |
| Movimientos con `git mv` | CODE_VERIFIED | commits `docs: mover …` de la rama de consolidación |
| Enlaces relativos de los movidos resuelven | CODE_VERIFIED | comprobador de enlaces de la consolidación: 0 rotos salvo `README.md` raíz y destinos de otros agentes aún no integrados |
| 0 IPs reales, VMIDs, hipervisor, hosts internos, dominio, emails y tokens en `docs/` | CODE_VERIFIED | escáner de la consolidación (IPs con `ipaddress`; patrones de VMID/host/email/token) |
| Ficheros anclados | CODE_VERIFIED | rutas:línea de la tabla anterior |
