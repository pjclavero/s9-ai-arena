# Informe de aceptación — capítulo 28 del dosier técnico

**Fecha:** 2026-07-16T12:39:19.359Z · **Resultado global:** 🟢 VERDE (10/10 criterios en verde)
**Regla de promoción:** un criterio en rojo bloquea la promoción a producción (puerta del hito M5).

Este informe lo genera `node acceptance/run-acceptance.mjs` (equipo E12). No hace
falta conocer el código: la columna *Resultado* es la decisión, *Evidencia* dice qué
se comprobó y *Cobertura en este runner* declara honestamente qué parte del criterio
exige un entorno con Docker/staging y dónde está implementada.

| # | Criterio | Resultado | Duración | Evidencia | Cobertura en este runner |
|---|---|---|---|---|---|
| 1 | **motor** — Motor: batallas de regresión sin divergencia por semilla y versión | 🟢 VERDE | 14.9s | hashes de estado idénticos en N ejecuciones (N=DETERMINISM_RUNS, 1000 en nightly) | completa |
| 2 | **rendimiento** — Rendimiento: tick estable con los bots del MVP (umbral métrico) | 🟢 VERDE | 3.3s | ms/tick de una 4v4 completa ≤ 50 % del presupuesto de 30 Hz (cap. 9.4) | completa |
| 3 | **bots** — Bots: bot malicioso/bloqueado no detiene el motor ni accede a secretos (suite E6) | 🟢 VERDE | 13.8s | pipeline E6 completo: análisis estático, secret-scan, suite de escape, launch-guard, suspensiones | parcial: las etapas containerizadas (protocol_test/smoke_battle/resource_limits y escape en contenedor real) requieren un runner con Docker (T6.2) |
| 4 | **mapas** — Mapas: todo mapa publicado pasó validación (query de verificación en BD) | 🟢 VERDE | 3.4s | query sobre map_versions publicadas + re-validación con el validador real de E4 + conversión a arena del motor | completa |
| 5 | **web** — Web: recuperación de conexión del visor y ausencia de información privada (tests E8) | 🟢 VERDE | 6.2s | reconexión por snapshot completo + stream de espectador sin observaciones privadas (D8) | parcial: render Phaser/60 fps requiere navegador (Playwright pendiente, ADR-E7-003) |
| 6 | **torneos** — Torneos: reanudables y auditables tras reinicio (caos E9) | 🟢 VERDE | 7.7s | worker matado a mitad de torneo de 20 batallas: reanuda sin duplicar ni perder; commit-reveal de semillas auditable | completa |
| 7 | **replay** — Replay: reproduce el resultado oficial y permite salto temporal | 🟢 VERDE | 7.6s | verifyReplay re-simula y compara hashes; keyframes para salto temporal (T8.3) | completa |
| 8 | **docker** — Docker: instalación limpia por variables y compose up (T10.2) | 🟢 VERDE | 2.7s | 12 servicios, 5 redes, perfiles, healthchecks, secretos por archivo y .env.example completos | parcial: el `docker compose up` real con healthchecks verdes requiere un host con Docker (checklist en docs/despliegue.md) |
| 9 | **datos** — Datos: copias restaurables y migraciones probadas (T10.4) | 🟢 VERDE | 1.9s | procedimiento de backup/restore verificado por la suite de E10; migraciones ejecutadas en cada arranque de test-db | parcial: el simulacro de recuperación total contra staging es la puerta M5 (docs/recuperacion.md) |
| 10 | **seguridad** — Seguridad: sin contenedores privilegiados ni docker.sock expuesto | 🟢 VERDE | 0.3s | escaneo real del docker-compose.yml del repo (mismo escáner que la etapa 6 de la CI) | completa |

## Cómo re-ejecutar

- Bajo demanda: `node acceptance/run-acceptance.mjs` (o `--only=motor,replay`).
- Nightly y manual: workflow `acceptance` (.github/workflows/acceptance.yml), que
  sube este informe y `acceptance/report.json` como artefactos. En nightly,
  `DETERMINISM_RUNS=1000` para el criterio *motor* (DoD del cap. 28).

## Nota del entorno

Generado en un runner sin privilegios Docker: los criterios marcados "parcial"
ejecutan la parte lógica/configuración REAL de su suite; la verificación
containerizada correspondiente está implementada y documentada por E6/E10 y se
ejecuta en la puerta M5 sobre staging (docs/despliegue.md, docs/entrega-E6.md).
