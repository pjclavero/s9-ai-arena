# Historial del proyecto

## Resumen

Documentos **históricos** de S9 AI Arena: entregas, rondas, programas, planes, estados, runbooks y
diseños anteriores, reunidos aquí en la consolidación documental de 2026-10 con `git mv` (se
conserva su historial de git). **Nada de esta carpeta es documentación vigente.** Describen el
proyecto en su fecha y pueden contradecir el estado actual; donde un documento fue absorbido por
uno canónico (MERGE), la tabla lo indica.

- Estado actual: [../roadmap/current-status.md](../roadmap/current-status.md)
- Documentación vigente: [../README.md](../README.md)
- Mapa completo de la migración (de dónde viene cada fichero): [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md)

Las direcciones IP, identificadores de máquina virtual, nombres del hipervisor y de hosts
internos y el dominio real se han sustituido por marcadores (`192.0.2.x`, `198.51.100.x`,
`203.0.113.x`, `<host-arena>`, `<proxy-host>`, `<host-dev>`, `<hipervisor>`, `<backup-host>`,
`arena.example.internal`). Dos ficheros se renombraron para quitar el identificador de VM del
nombre: `OPERACION_HOST_ARENA.md` y `APAGADO_Y_ENCENDIDO.md`.

## Índice

- [Entregas E1-E12 del dosier original](#entregas)
- [Rondas](#rondas)
- [Programas](#programas)
- [Planes](#planes)
- [Estados anteriores](#status)
- [Runbooks y documentos de operación anteriores](#operaciones)
- [Diseños por bloque (R6-R17), puertas y guías anteriores](#disenos)

<a id="entregas"></a>

## Entregas E1-E12 del dosier original

Informes de cada una de las 12 entregas, la nota de fusión E1/E2 y la hoja de ruta del prototipo v1. Ya eran históricos antes de esta consolidación (`docs/historial/`).

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [entregas/FUSION.md](entregas/FUSION.md) | `docs/historial/FUSION.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/README.md](entregas/README.md) | `docs/historial/README.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/ROADMAP.md](entregas/ROADMAP.md) | `docs/historial/ROADMAP.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E1.md](entregas/entrega-E1.md) | `docs/historial/entrega-E1.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E10.md](entregas/entrega-E10.md) | `docs/historial/entrega-E10.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E11.md](entregas/entrega-E11.md) | `docs/historial/entrega-E11.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E12.md](entregas/entrega-E12.md) | `docs/historial/entrega-E12.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E2.md](entregas/entrega-E2.md) | `docs/historial/entrega-E2.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E3.md](entregas/entrega-E3.md) | `docs/historial/entrega-E3.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E4.md](entregas/entrega-E4.md) | `docs/historial/entrega-E4.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E5.md](entregas/entrega-E5.md) | `docs/historial/entrega-E5.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E6.md](entregas/entrega-E6.md) | `docs/historial/entrega-E6.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E7.md](entregas/entrega-E7.md) | `docs/historial/entrega-E7.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E8.md](entregas/entrega-E8.md) | `docs/historial/entrega-E8.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |
| [entregas/entrega-E9.md](entregas/entrega-E9.md) | `docs/historial/entrega-E9.md` | Informe histórico de entregas E1-E12 / prototipo v1 (ya era histórico). | — |

<a id="rondas"></a>

## Rondas

Registro de la Ronda 2 (bandas R-P0, R1-R6) con el informe de cada tarea, y el informe de integración de las Rondas 2 y 3 (PR #17-#31).

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [rondas/integracion-pr17-pr31.md](rondas/integracion-pr17-pr31.md) | `docs/informes/integracion-pr17-pr31.md` | Informe de integración de las Rondas 2/3. | — |
| [rondas/ronda2/README.md](rondas/ronda2/README.md) | `docs/ronda2/README.md` | Registro de ejecución de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.1-municion.md](rondas/ronda2/reportes/R1.1-municion.md) | `docs/ronda2/reportes/R1.1-municion.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.2-sensor-acustico.md](rondas/ronda2/reportes/R1.2-sensor-acustico.md) | `docs/ronda2/reportes/R1.2-sensor-acustico.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.3-sensores-catalogo.md](rondas/ronda2/reportes/R1.3-sensores-catalogo.md) | `docs/ronda2/reportes/R1.3-sensores-catalogo.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.4-secreto-jwt.md](rondas/ronda2/reportes/R1.4-secreto-jwt.md) | `docs/ronda2/reportes/R1.4-secreto-jwt.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.5-sandbox-fail-closed.md](rondas/ronda2/reportes/R1.5-sandbox-fail-closed.md) | `docs/ronda2/reportes/R1.5-sandbox-fail-closed.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.6-ci-sandbox.md](rondas/ronda2/reportes/R1.6-ci-sandbox.md) | `docs/ronda2/reportes/R1.6-ci-sandbox.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.7-docker-sock.md](rondas/ronda2/reportes/R1.7-docker-sock.md) | `docs/ronda2/reportes/R1.7-docker-sock.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.8-rate-limit-proxy.md](rondas/ronda2/reportes/R1.8-rate-limit-proxy.md) | `docs/ronda2/reportes/R1.8-rate-limit-proxy.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R1.9-zone-control-koth.md](rondas/ronda2/reportes/R1.9-zone-control-koth.md) | `docs/ronda2/reportes/R1.9-zone-control-koth.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.1-tipos-ci.md](rondas/ronda2/reportes/R2.1-tipos-ci.md) | `docs/ronda2/reportes/R2.1-tipos-ci.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.2-semaforo-ci.md](rondas/ronda2/reportes/R2.2-semaforo-ci.md) | `docs/ronda2/reportes/R2.2-semaforo-ci.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.3-split-suite.md](rondas/ronda2/reportes/R2.3-split-suite.md) | `docs/ronda2/reportes/R2.3-split-suite.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.4-ast-auth.md](rondas/ronda2/reportes/R2.4-ast-auth.md) | `docs/ronda2/reportes/R2.4-ast-auth.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.5-colas-firma.md](rondas/ronda2/reportes/R2.5-colas-firma.md) | `docs/ronda2/reportes/R2.5-colas-firma.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.6-subidas-cabeceras.md](rondas/ronda2/reportes/R2.6-subidas-cabeceras.md) | `docs/ronda2/reportes/R2.6-subidas-cabeceras.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.7-determinismo.md](rondas/ronda2/reportes/R2.7-determinismo.md) | `docs/ronda2/reportes/R2.7-determinismo.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R2.8-cli-arena-sim-js.md](rondas/ronda2/reportes/R2.8-cli-arena-sim-js.md) | `docs/ronda2/reportes/R2.8-cli-arena-sim-js.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R3.1-replay-interpolado.md](rondas/ronda2/reportes/R3.1-replay-interpolado.md) | `docs/ronda2/reportes/R3.1-replay-interpolado.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R3.2-interp-camara.md](rondas/ronda2/reportes/R3.2-interp-camara.md) | `docs/ronda2/reportes/R3.2-interp-camara.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R3.7-panel.md](rondas/ronda2/reportes/R3.7-panel.md) | `docs/ronda2/reportes/R3.7-panel.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R3.8-modos-baratos.md](rondas/ronda2/reportes/R3.8-modos-baratos.md) | `docs/ronda2/reportes/R3.8-modos-baratos.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R4-totp.md](rondas/ronda2/reportes/R4-totp.md) | `docs/ronda2/reportes/R4-totp.md` | Informe de tarea de la Ronda 2. | — |
| [rondas/ronda2/reportes/R6.1-runtimes-digests.md](rondas/ronda2/reportes/R6.1-runtimes-digests.md) | `docs/ronda2/reportes/R6.1-runtimes-digests.md` | Informe de tarea de la Ronda 2. | — |

<a id="programas"></a>

## Programas

Programas de trabajo cerrados (9 bloques, batallas reales) y los backlogs/planes de fase que dejaron. Lo pendiente lo recoge el roadmap.

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [programas/BACKLOG_POST_PROGRAMA.md](programas/BACKLOG_POST_PROGRAMA.md) | `docs/BACKLOG_POST_PROGRAMA.md` | Backlog: lo aún pendiente lo absorbe roadmap. | [roadmap/pending-features.md](../roadmap/pending-features.md) (A) |
| [programas/NEXT_PHASE_R10_R11_R12.md](programas/NEXT_PHASE_R10_R11_R12.md) | `docs/NEXT_PHASE_R10_R11_R12.md` | Plan de fase R10-R12. | [roadmap/pending-features.md](../roadmap/pending-features.md) (A) |
| [programas/PROGRAMA_9_BLOQUES.md](programas/PROGRAMA_9_BLOQUES.md) | `docs/PROGRAMA_9_BLOQUES.md` | Programa de 9 bloques (cerrado). | — |
| [programas/PROGRAMA_BATALLAS_REALES.md](programas/PROGRAMA_BATALLAS_REALES.md) | `docs/PROGRAMA_BATALLAS_REALES.md` | Programa de batallas reales (cerrado). | — |

<a id="planes"></a>

## Planes

Dosier de tareas original y la hoja de ruta v2 anterior.

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [planes/Dosier_tareas_S9_AI_Arena.md](planes/Dosier_tareas_S9_AI_Arena.md) | `docs/Dosier_tareas_S9_AI_Arena.md` | Dosier de tareas original (plan histórico). | — |
| [planes/ROADMAP.md](planes/ROADMAP.md) | `docs/ROADMAP.md` | Roadmap antiguo de v2. | [roadmap/pending-features.md](../roadmap/pending-features.md) (A) |

<a id="status"></a>

## Estados anteriores

Las dos «fuentes de verdad» de estado que convivían (julio-septiembre de 2026). Describen perfil `nucleo`, imágenes `:local`, nightly «reparada» y otras cosas que ya no son ciertas.

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [status/ESTADO_ACTUAL.md](status/ESTADO_ACTUAL.md) | `docs/ESTADO_ACTUAL.md` | Estado de 2026-07/09, obsoleto (perfil nucleo, :local, WAN). Topología enmascarada. | [roadmap/current-status.md](../roadmap/current-status.md) (A) |
| [status/estado-proyecto.md](status/estado-proyecto.md) | `docs/estado-proyecto.md` | Segunda 'fuente de verdad' de 2026-07-16 (pre-despliegue). | [roadmap/current-status.md](../roadmap/current-status.md) (A) |

<a id="operaciones"></a>

## Runbooks y documentos de operación anteriores

Runbooks de despliegue, recuperación, apagado, contrato y compose de la instalación de referencia. **Contienen comandos ROTOS o PELIGROSOS** (perfil `nucleo` con `down`, `qm rollback` a snapshots borrados, `pg_dumpall -U postgres`, volúmenes `s9-ai-arena_*`, `TAG=latest`). No ejecutar nada de aquí: usar [../operations/](../operations/index.md).

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [operaciones/APAGADO_Y_ENCENDIDO.md](operaciones/APAGADO_Y_ENCENDIDO.md) | `docs/ops/APAGADO_Y_ENCENDIDO_VM<id>.md` | Runbook de apagado; su §2 (cierre limpio de PG) está refutado. Renombrado sin VMID; hipervisor/IPs enmascarados. | [operations/shutdown.md](../operations/shutdown.md) |
| [operaciones/BACKUP_RUNTIME_ALIGNMENT.md](operaciones/BACKUP_RUNTIME_ALIGNMENT.md) | `docs/BACKUP_RUNTIME_ALIGNMENT.md` | Alineación del backup; contiene `restic forget --prune` (destructivo) como análisis. | [operations/backup.md](../operations/backup.md) |
| [operaciones/COMPOSE_CANONICO.md](operaciones/COMPOSE_CANONICO.md) | `docs/COMPOSE_CANONICO.md` | Estado 'propuesto, no aplicado' obsoleto. | [operations/docker.md](../operations/docker.md) + [operations/upgrades.md](../operations/upgrades.md) |
| [operaciones/CONTRATO_DESPLIEGUE.md](operaciones/CONTRATO_DESPLIEGUE.md) | `docs/CONTRATO_DESPLIEGUE.md` | Contrato de despliegue (deploy-contract.json). | [operations/upgrades.md](../operations/upgrades.md) + [operations/docker.md](../operations/docker.md) |
| [operaciones/DESPLIEGUE_DOMINIO.md](operaciones/DESPLIEGUE_DOMINIO.md) | `docs/DESPLIEGUE_DOMINIO.md` | Instalación concreta tras proxy (WAN obsoleta enmascarada). | [operations/networking.md](../operations/networking.md) |
| [operaciones/MIGRACION_V2.md](operaciones/MIGRACION_V2.md) | `docs/MIGRACION_V2.md` | Migración v1->v2 ya ejecutada; rollback por snapshot inexistente. | — |
| [operaciones/OPERACION_HOST_ARENA.md](operaciones/OPERACION_HOST_ARENA.md) | `docs/OPERACION_VM<id>.md` | Runbook de la instalación concreta con comandos PELIGROSOS/ROTOS (nucleo down, qm rollback, pg_dumpall -U postgres). Renombrado sin VMID; topología enmascarada. | [operations/diagnostics.md](../operations/diagnostics.md) + [operations/upgrades.md](../operations/upgrades.md) + [operations/docker.md](../operations/docker.md) |
| [operaciones/OVERRIDE_VERSION_POR_SERVICIO.md](operaciones/OVERRIDE_VERSION_POR_SERVICIO.md) | `docs/OVERRIDE_VERSION_POR_SERVICIO.md` | Override por servicio; estado obsoleto (82c74a8 vs 0daa500). | [operations/upgrades.md](../operations/upgrades.md) |
| [operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md](operaciones/R17_ASISTENTE_PRIMER_ARRANQUE.md) | `docs/R17_ASISTENTE_PRIMER_ARRANQUE.md` | Asistente de primer arranque (R17). | [operations/first-run.md](../operations/first-run.md) + [operations/readiness.md](../operations/readiness.md) |
| [operaciones/R17_INSTALACION_READINESS.md](operaciones/R17_INSTALACION_READINESS.md) | `docs/R17_INSTALACION_READINESS.md` | Readiness R17 con ids de checks y cifras obsoletos. | [operations/readiness.md](../operations/readiness.md) |
| [operaciones/contenido-base.md](operaciones/contenido-base.md) | `docs/ops/contenido-base.md` | bootstrap del contenido base (correcto); vigente en first-run.md. | [operations/first-run.md](../operations/first-run.md) |
| [operaciones/despliegue.md](operaciones/despliegue.md) | `docs/despliegue.md` | 'Instalación en tres pasos' no reproducible (TAG=latest); red s9-ai-arena_arena inexistente. | [operations/installation.md](../operations/installation.md) + [operations/upgrades.md](../operations/upgrades.md) + [operations/networking.md](../operations/networking.md) + [development/releases.md](../development/releases.md) |
| [operaciones/streaming-runbook.md](operaciones/streaming-runbook.md) | `docs/streaming-runbook.md` | Runbook de retransmisión (streamer fuera del perfil production). | [technical/websocket.md](../technical/websocket.md) (B) + [user/viewer.md](../user/viewer.md) (B) |

<a id="disenos"></a>

## Diseños por bloque (R6-R17), puertas y guías anteriores

Documentos de diseño e implementación por bloque, las puertas de ejecución (Carril I) y de espectador (Carril J), y guías sustituidas. Su contenido vigente lo absorben los documentos técnicos de `docs/technical/`.

| Documento | Antes en | Qué es | Contenido vigente en |
|---|---|---|---|
| [disenos/B11_PANEL_VERSIONES_VERDAD.md](disenos/B11_PANEL_VERSIONES_VERDAD.md) | `docs/B11_PANEL_VERSIONES_VERDAD.md` | Defecto del panel de versiones de bots (B11). | [technical/frontend.md](../technical/frontend.md) (B) + [technical/bots.md](../technical/bots.md) (B) |
| [disenos/CARRIL_I_EXECUTION_GATE.md](disenos/CARRIL_I_EXECUTION_GATE.md) | `docs/CARRIL_I_EXECUTION_GATE.md` | Puerta de ejecución real (I-8..I-14 pendientes). | [technical/battles.md](../technical/battles.md) (B) + [technical/security.md](../technical/security.md) (A) + [operations/readiness.md](../operations/readiness.md) |
| [disenos/CARRIL_J_GATE_SPECTATOR.md](disenos/CARRIL_J_GATE_SPECTATOR.md) | `docs/CARRIL_J_GATE_SPECTATOR.md` | Puerta de espectador/replays públicos (G0 /replays/ abierto). | [technical/replays.md](../technical/replays.md) (B) + [technical/security.md](../technical/security.md) (A) + [operations/networking.md](../operations/networking.md) |
| [disenos/R10_MAP_EDITOR_FOUNDATION.md](disenos/R10_MAP_EDITOR_FOUNDATION.md) | `docs/R10_MAP_EDITOR_FOUNDATION.md` | Editor de mapas (R10). | [technical/maps.md](../technical/maps.md) (B) |
| [disenos/R10_MAP_EDITOR_SLICE1.md](disenos/R10_MAP_EDITOR_SLICE1.md) | `docs/R10_MAP_EDITOR_SLICE1.md` | Editor de mapas slice 1 (sólo cliente). | [technical/maps.md](../technical/maps.md) (B) |
| [disenos/R11_PUBLIC_SPECTATOR_FOUNDATION.md](disenos/R11_PUBLIC_SPECTATOR_FOUNDATION.md) | `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md` | Espectador público (R11). | [technical/websocket.md](../technical/websocket.md) (B) + [technical/replays.md](../technical/replays.md) (B) |
| [disenos/R11_SPECTATOR.md](disenos/R11_SPECTATOR.md) | `docs/R11_SPECTATOR.md` | Espectador (R11). | [technical/websocket.md](../technical/websocket.md) (B) + [user/viewer.md](../user/viewer.md) (B) |
| [disenos/R12_BRACKET_SLICE1.md](disenos/R12_BRACKET_SLICE1.md) | `docs/R12_BRACKET_SLICE1.md` | Cuadro de torneo (R12). | [technical/tournaments.md](../technical/tournaments.md) (B) |
| [disenos/R12_PREPARE_BATTLE_MATCHMAKING.md](disenos/R12_PREPARE_BATTLE_MATCHMAKING.md) | `docs/R12_PREPARE_BATTLE_MATCHMAKING.md` | Preparación de batalla y emparejamiento (R12). | [technical/tournaments.md](../technical/tournaments.md) (B) + [technical/battles.md](../technical/battles.md) (B) |
| [disenos/R12_TOURNAMENTS_RANKING_MATCHMAKING.md](disenos/R12_TOURNAMENTS_RANKING_MATCHMAKING.md) | `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` | Torneos, ranking y emparejamiento (R12). | [technical/tournaments.md](../technical/tournaments.md) (B) |
| [disenos/R13_1_RUNTIME_INSPECTOR.md](disenos/R13_1_RUNTIME_INSPECTOR.md) | `docs/R13_1_RUNTIME_INSPECTOR.md` | Inspector de runtime del motor (R13.1). | [technical/engine.md](../technical/engine.md) (B) |
| [disenos/R13_2_HARDENING.md](disenos/R13_2_HARDENING.md) | `docs/R13_2_HARDENING.md` | Endurecimiento (R13.2). | [technical/security.md](../technical/security.md) (A) + [technical/engine.md](../technical/engine.md) (B) |
| [disenos/R13_5_SAVE_SHARDING.md](disenos/R13_5_SAVE_SHARDING.md) | `docs/R13_5_SAVE_SHARDING.md` | Save/sharding: diseño + slice 1. | [technical/engine.md](../technical/engine.md) (B) |
| [disenos/R13_ENGINE_RUNTIME_QUALITY.md](disenos/R13_ENGINE_RUNTIME_QUALITY.md) | `docs/R13_ENGINE_RUNTIME_QUALITY.md` | Plan de calidad del motor (R13). | [technical/engine.md](../technical/engine.md) (B) |
| [disenos/R14_WEBRTC_STREAMING.md](disenos/R14_WEBRTC_STREAMING.md) | `docs/R14_WEBRTC_STREAMING.md` | Diseño de streaming WebRTC no implementado (lo cierra el ADR R14). | [adr/ADR-R14-webrtc.md](../adr/ADR-R14-webrtc.md) |
| [disenos/R16_DESIGN_SYSTEM.md](disenos/R16_DESIGN_SYSTEM.md) | `docs/R16_DESIGN_SYSTEM.md` | Sistema de diseño de la web (R16). | [technical/frontend.md](../technical/frontend.md) (B) |
| [disenos/R16_VISUAL_SLICE1.md](disenos/R16_VISUAL_SLICE1.md) | `docs/R16_VISUAL_SLICE1.md` | Slice visual 1 (R16). | [technical/frontend.md](../technical/frontend.md) (B) |
| [disenos/R16_VISUAL_UPGRADE.md](disenos/R16_VISUAL_UPGRADE.md) | `docs/R16_VISUAL_UPGRADE.md` | Mejora visual (R16). | [technical/frontend.md](../technical/frontend.md) (B) |
| [disenos/R6_2_REAL_BATTLE_RUNS.md](disenos/R6_2_REAL_BATTLE_RUNS.md) | `docs/R6_2_REAL_BATTLE_RUNS.md` | Batallas reales /run (R6.2). | [technical/battles.md](../technical/battles.md) (B) |
| [disenos/R7A_OPERATIONAL_REPLAY_INGEST.md](disenos/R7A_OPERATIONAL_REPLAY_INGEST.md) | `docs/R7A_OPERATIONAL_REPLAY_INGEST.md` | Ingesta de replays; variables REPLAY_INGEST_ENABLED/RETRIES mal atribuidas a la API. | [technical/replays.md](../technical/replays.md) (B) |
| [disenos/R7_REPLAY_VIEWER.md](disenos/R7_REPLAY_VIEWER.md) | `docs/R7_REPLAY_VIEWER.md` | Visor de replays (R7). | [technical/replays.md](../technical/replays.md) (B) + [technical/frontend.md](../technical/frontend.md) (B) |
| [disenos/R8_ADMIN_MANAGEMENT.md](disenos/R8_ADMIN_MANAGEMENT.md) | `docs/R8_ADMIN_MANAGEMENT.md` | Gestión admin (R8), duplica parcialmente R8_GESTION_ADMIN. | [technical/frontend.md](../technical/frontend.md) (B) + [user/administration.md](../user/administration.md) (B) |
| [disenos/R8_GESTION_ADMIN.md](disenos/R8_GESTION_ADMIN.md) | `docs/R8_GESTION_ADMIN.md` | Gestión admin (R8), base distinta de main. | [technical/frontend.md](../technical/frontend.md) (B) + [user/administration.md](../user/administration.md) (B) |
| [disenos/R9_BATTLE_CREATION.md](disenos/R9_BATTLE_CREATION.md) | `docs/R9_BATTLE_CREATION.md` | Creación de batallas (R9). | [technical/battles.md](../technical/battles.md) (B) |
| [disenos/formato-tmx.md](disenos/formato-tmx.md) | `docs/mapas/formato-tmx.md` | Formato de importación TMX (Tiled). | [technical/maps.md](../technical/maps.md) (B) + [user/maps.md](../user/maps.md) (B) |
| [disenos/getting-started.md](disenos/getting-started.md) | `docs/getting-started.md` | Contradice engines (Node 20 'soportado'). | [development/setup.md](../development/setup.md) + [development/testing.md](../development/testing.md) |
| [disenos/sdk-paridad.md](disenos/sdk-paridad.md) | `docs/sdk-paridad.md` | Paridad SDK Python/JS (citado en comentarios de sdks/javascript). | [technical/bots.md](../technical/bots.md) (B) |

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Cada fichero se movió con `git mv` desde la ruta indicada | CODE_VERIFIED | `git log --follow <fichero>` en esta rama |
| Topología real enmascarada en todos los ficheros de la carpeta | CODE_VERIFIED | escaneo de la consolidación (IPs parseadas con `ipaddress`, VMID, hosts, dominios, emails, tokens): 0 hallazgos |
