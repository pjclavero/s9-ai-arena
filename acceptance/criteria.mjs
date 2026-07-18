/**
 * E12 · T12.2 — Los 10 criterios de aceptación del capítulo 28 del dosier
 * técnico como jobs ejecutables. Cada job reutiliza la suite REAL del equipo
 * dueño (no reimplementa nada) y produce un resultado binario.
 *
 * `cobertura` es honestidad operativa: qué parte del criterio queda demostrada
 * por el job en un runner SIN privilegios Docker (CI y entorno ia02). Las
 * partes que exigen contenedores reales están implementadas por E6/E10 y
 * quedan gateadas a un runner con Docker (ver docs/entrega-E6.md y
 * docs/entrega-E10.md); el informe las lista para que el operador las vea.
 */
export const CRITERIA = [
  {
    id: "motor",
    nombre: "Motor: batallas de regresión sin divergencia por semilla y versión",
    // DETERMINISM_RUNS=1000 en nightly (DoD E2/T2.1); 100 en ejecución local/PR.
    comando: ["npx", "vitest", "run", "apps/arena-engine/tests/determinism.test.ts", "--maxWorkers=2"],
    evidencia: "hashes de estado idénticos en N ejecuciones (N=DETERMINISM_RUNS, 1000 en nightly)",
    cobertura: "completa",
  },
  {
    id: "rendimiento",
    nombre: "Rendimiento: tick estable con los bots del MVP (umbral métrico)",
    comando: [
      "npx",
      "vitest",
      "run",
      "apps/arena-engine/tests/robustness.test.ts",
      "-t",
      "presupuesto",
      "--maxWorkers=2",
    ],
    evidencia: "ms/tick de una 4v4 completa ≤ 50 % del presupuesto de 30 Hz (cap. 9.4)",
    cobertura: "completa",
  },
  {
    id: "bots",
    nombre: "Bots: bot malicioso/bloqueado no detiene el motor ni accede a secretos (suite E6)",
    comando: ["npx", "vitest", "run", "apps/bot-manager/tests", "--maxWorkers=2"],
    evidencia: "pipeline E6 completo: análisis estático, secret-scan, suite de escape, launch-guard, suspensiones",
    cobertura:
      "parcial: las etapas containerizadas (protocol_test/smoke_battle/resource_limits y escape en contenedor real) requieren un runner con Docker (T6.2)",
  },
  {
    id: "mapas",
    nombre: "Mapas: todo mapa publicado pasó validación (query de verificación en BD)",
    comando: ["npx", "vitest", "run", "tests/acceptance/maps-published-validated.test.ts", "--maxWorkers=2"],
    evidencia:
      "query sobre map_versions publicadas + re-validación con el validador real de E4 + conversión a arena del motor",
    cobertura: "completa",
  },
  {
    id: "web",
    nombre: "Web: recuperación de conexión del visor y ausencia de información privada (tests E8)",
    comando: [
      "npx",
      "vitest",
      "run",
      "apps/web/tests/spectator.e2e.test.ts",
      "apps/web/tests/viewer-logic.test.ts",
      "--maxWorkers=2",
    ],
    evidencia: "reconexión por snapshot completo + stream de espectador sin observaciones privadas (D8)",
    cobertura: "parcial: render Phaser/60 fps requiere navegador (Playwright pendiente, ADR-E7-003)",
  },
  {
    id: "torneos",
    nombre: "Torneos: reanudables y auditables tras reinicio (caos E9)",
    comando: [
      "npx",
      "vitest",
      "run",
      "apps/tournament-worker/src/queue.test.ts",
      "apps/tournament-worker/src/justice.test.ts",
      "apps/tournament-worker/src/tournament-e2e.test.ts",
      "--maxWorkers=2",
    ],
    evidencia:
      "worker matado a mitad de torneo de 20 batallas: reanuda sin duplicar ni perder; commit-reveal de semillas auditable",
    cobertura: "completa",
  },
  {
    id: "replay",
    nombre: "Replay: reproduce el resultado oficial y permite salto temporal",
    comando: [
      "npx",
      "vitest",
      "run",
      "apps/api/src/e8-replay-verify.test.ts",
      "apps/replay-service/tests",
      "apps/web/tests/replay-player.test.ts",
      "--maxWorkers=2",
    ],
    evidencia: "verifyReplay re-simula y compara hashes; keyframes para salto temporal (T8.3)",
    cobertura: "completa",
  },
  {
    id: "docker",
    nombre: "Docker: instalación limpia por variables y compose up (T10.2)",
    comando: ["npx", "vitest", "run", "infrastructure/tests/compose.test.ts", "--maxWorkers=2"],
    evidencia: "12 servicios, 5 redes, perfiles, healthchecks, secretos por archivo y .env.example completos",
    cobertura:
      "parcial: el `docker compose up` real con healthchecks verdes requiere un host con Docker (checklist en docs/despliegue.md)",
  },
  {
    id: "datos",
    nombre: "Datos: copias restaurables y migraciones probadas (T10.4)",
    comando: ["npx", "vitest", "run", "infrastructure/tests/backup.test.ts", "--maxWorkers=2"],
    evidencia:
      "procedimiento de backup/restore verificado por la suite de E10; migraciones ejecutadas en cada arranque de test-db",
    cobertura: "parcial: el simulacro de recuperación total contra staging es la puerta M5 (docs/recuperacion.md)",
  },
  {
    id: "seguridad",
    nombre: "Seguridad: sin contenedores privilegiados ni docker.sock expuesto",
    comando: ["node", "infrastructure/scripts/scan-compose.mjs", "infrastructure/docker-compose.yml"],
    evidencia: "escaneo real del docker-compose.yml del repo (mismo escáner que la etapa 6 de la CI)",
    cobertura: "completa",
  },
];
