# E12 · QA e Integración (transversal) — entrega v1

Equipo transversal propuesto (dosier de tareas §E12): convierte los criterios
de éxito del MVP (dosier técnico 26.1) y de aceptación (cap. 28) en suites
ejecutables, automatiza pruebas de caos (game days) y detecta huecos de
integración REALES entre equipos. NO reimplementa lógica de otros equipos: la
importa y la ejercita de punta a punta. Rama `e12-qa` sobre `de61d79` (integra
E1–E10 + E8/E9).

## Estado de la suite (cifras reales)

Entorno: ia02, 2026-07-16, Node v20.19.2, sin grupo docker ni sudo, sin
navegador. PostgreSQL 18 embebido (harness de E7, ADR-E7-002); prohibido y no
usado ningún servicio de producción del homelab.

```bash
npm test -- --maxWorkers=2                    # suite completa del monorepo
npx vitest run tests/e2e                       # T12.1 (E2E MVP + sabotajes): 11
npx vitest run tests/acceptance                # T12.2 (criterio 'mapas'): 2
npx vitest run tests/gamedays                  # T12.3 (game day M3): 6
node acceptance/run-acceptance.mjs             # T12.2 pipeline completo cap. 28
```

- **Suite completa del repo: 611 pasan, 1 falla, 3 skipped** (615 tests, 66
  archivos, ~74 s). El único fallo es el PREEXISTENTE de entorno
  (`zstdCompressSync` no existe en Node 20, exige ≥22.15) en
  `apps/arena-engine/tests/replay-golden.test.ts`. Línea base de la rama antes
  de E12: **592 / 1 (zstd) / 3**. E12 añade **19 tests, todos verdes** (11 E2E,
  2 aceptación, 6 game day) y no rompe nada.
- **SDK Python (sdks/python): 45/45** con pytest (`python3 -m pytest tests/ -q`,
  ~61 s). No tocado por E12; verificado como parte del control transversal.
- **Pipeline de aceptación (T12.2): 10/10 criterios en VERDE** (~62 s),
  informe en `docs/aceptacion/ultimo-informe.md`.

## T12.1 — Suite E2E del criterio de éxito del MVP (26.1) · [EJECUTADO]

`tests/e2e/mvp-success.e2e.test.ts` (6 pasos con evidencia) +
`tests/e2e/mvp-sabotage.e2e.test.ts` (6 sabotajes, uno por paso). CI:
job `e2e-mvp` en `.github/workflows/ci.yml` (timeout 20 min = DoD; gatea
`deploy-staging`; sube la evidencia como artefacto).

Los 6 pasos, cada uno con aserciones propias y evidencia archivada en
`tests/e2e/evidence/mvp-success.json` (ids, hashes, cifras):

1. Registro → login → bot → loadout del catálogo MVP → subida de código, por la
   API REAL de E7.
2. Build y validación con el pipeline REAL de E6 (`E6PipelineBotManager`):
   versión `validated`, artefacto con firma criptográfica real (E6/signing).
3. Batalla CTF 2v2 con 4 bots en el mapa MVP REAL desde la BD (se COMPRUEBA
   que trae muros, destructibles y zona de daño), motor REAL de E2 con réplica.
4. Espectador ANÓNIMO en directo por el gateway WebSocket REAL de E8 (ticket
   firmado por la API): recibe init + snapshots + result; se verifica ausencia
   de información privada y de capas debug (D8).
5. El replay ingerido por el replay-service verifica por re-simulación del motor
   y por la operación pública `verifyReplay` de E8 (hashes coincidentes) y se
   descarga sin cuenta.
6. Estadísticas por bot, equipo y módulo (`runStatsJob` de E8 re-simulando el
   replay), expuestas por `getBattleStats`.

DoD de sabotaje: los 6 sabotajes (credenciales/contraseña débil; secreto en el
código; mapa vaciado; ticket falsificado/reutilizado; replay manipulado y
resultado oficial falso; replay borrado) son DETECTADOS — la detección es la
aserción, de modo que si un control se degrada, la suite se pone roja.

**[PENDIENTE de entorno, declarado]:** los 4 bots de la batalla son los stubs
deterministas del motor; ejecutar código de usuario en CONTENEDORES (E6/T6.2)
requiere Docker; las etapas containerizadas del pipeline quedan `skipped` y así
se afirma explícitamente en el paso 2. La ejecución de la MISMA suite contra un
staging desplegado por Compose (T10.1) es la parte que un runner con Docker
añade en la etapa 8 de la CI.

## T12.2 — Suite de criterios de aceptación del cap. 28 · [EJECUTADO]

`acceptance/criteria.mjs` (10 criterios) + `acceptance/run-acceptance.mjs`
(runner con resultado binario por criterio) + `tests/acceptance/` (criterio
`mapas` nuevo). CI: `.github/workflows/acceptance.yml` (bajo demanda + nightly,
`DETERMINISM_RUNS=1000`; artefacto `acceptance-report`).

Cada criterio reutiliza la suite REAL del equipo dueño; ninguno reimplementa
lógica. Un criterio en rojo hace salir el runner con código != 0 (regla de
promoción añadida a `docs/despliegue.md` §CI/CD: es la puerta del hito M5). El
informe legible por el operador se genera en `docs/aceptacion/ultimo-informe.md`.

Resultado de la ejecución real (10/10 VERDE): motor (determinismo), rendimiento
(ms/tick ≤ 50 % del presupuesto), bots (pipeline E6), mapas (query BD +
validador E4), web (reconexión + sin datos privados), torneos (caos E9), replay
(verify + keyframes), docker (compose lint), datos (backup/migraciones),
seguridad (scan-compose). La columna *cobertura* del informe declara con
honestidad qué criterios son "parciales" en un runner sin Docker (bots, web,
docker, datos) y dónde está implementada la parte containerizada.

**[PENDIENTE de entorno, declarado]:** las partes containerizadas / de staging
(escape en contenedor real, render Phaser, `docker compose up` con healthchecks,
simulacro de recuperación total) están implementadas por E6/E10 y se ejecutan en
la puerta M5 sobre staging; el runner las marca "parcial", no verde falso.

## T12.3 — Pruebas de caos y game days · [EJECUTADO]

`docs/gamedays/README.md` (7 guiones con comportamiento esperado predefinido) +
`tests/gamedays/gameday-m3.test.ts` (automatización) +
`docs/gamedays/acta-2026-07-16-m3.md` (acta con issues asignadas).

6/7 guiones ejecutados y conformes en proceso con piezas reales: GD-1 (matar
motor), GD-2 (matar worker con cola llena — motor y cola reales), GD-3 (disco de
replays lleno), GD-4 (caída de Redis → degradación a polling), GD-6 (latencia
extrema → DQ por timeouts, el motor no se detiene) y GD-7 (bot hostil NUEVO
escrito por E12, ajeno a E6, RECHAZADO por el pipeline). Cada guion fija su
esperado ANTES de ejecutarse, con referencia al dosier (9.4/19.2/24).

**[PENDIENTE de entorno, declarado]:** GD-5 (caída y recuperación de PostgreSQL)
exige matar el contenedor `postgres` del Compose → requiere staging con Docker;
queda documentado en el acta como pendiente.

## E12.M — Mantenimiento de staging y dashboard · [PENDIENTE]

Propuestas del dosier (E12.M) que quedan fuera de este entorno: mantener datos
de prueba/reseteo de staging en coordinación con E10, y el dashboard de Grafana
con el % de criterios del cap. 28 en verde. El `acceptance/report.json` que
genera T12.2 es la fuente de datos lista para ese panel.

---

## HALLAZGOS DE INTEGRACIÓN (priorizados)

Valor central de E12: huecos REALES entre equipos detectados ejercitando el
sistema de punta a punta. Cada uno indica equipo y si E12 lo cerró con un test
transversal o lo reporta para decisión del dueño (no se invade ámbito ajeno).

### P1 — Alta

- **H1 · [E6] Los builtins peligrosos de stdlib se señalan pero NO bloquean el
  análisis estático.** `static_analysis` (apps/bot-manager) rechaza imports de
  paquetes de terceros fuera de la allowlist, pero `socket`, `subprocess`,
  `ctypes`, `multiprocessing`, `asyncio` solo generan un hallazgo de auditoría
  (severidad media) — no fallan la etapa. Con las etapas containerizadas
  `skipped` (sin Docker), un bot hostil que use SOLO stdlib para red/procesos
  llega a `validated`. El bloqueo real recae íntegramente en el sandbox de
  runtime (E6/T6.2). **Detectado por:** GD-7 (game day). **Acción:** decisión de
  E6 — o `static_analysis` rechaza (no solo señala) un subconjunto de builtins
  peligrosos como defensa en profundidad independiente del contenedor, o se
  documenta formalmente que la contención de stdlib es responsabilidad exclusiva
  del sandbox. E12 lo reporta, no lo arregla (invadiría el ámbito de E6). Issue
  GD7-1 en el acta.

### P2 — Media

- **H2 · [E9→E8] La cadena "batalla → gateway de espectador en vivo → stats"
  no está cableada en el worker de producción.** El worker de E9
  (`battle-runner.ts`) persiste replay y `battle_stats` con el `statsPerBot`
  simple del ejecutor, pero NO llama a `gateway.attachBattle()` (espectador en
  directo, E8/T8.2) ni a `runStatsJob()` (stats ricas por módulo de E8/T8.4);
  ambos siguen declarados "pendiente de reconciliación con E9" en
  `docs/entrega-E8.md`. Hoy el visor EN VIVO de una batalla de torneo no tiene
  quién registre la batalla en el gateway. **Cerrado parcialmente por:** la
  suite E2E de T12.1 DEMUESTRA que las tres piezas encajan de verdad
  (attachBattle + verifyReplay + runStatsJob sobre una batalla real), pero
  compone el cableado en el test, no en el worker. **Acción:** E9 debe invocar
  `attachBattle` al arrancar cada batalla y encolar/ejecutar `runStatsJob` en
  `finishBattle` (E8 ya expone ambos puntos de entrada). Reportado.

- **H3 · [E8/E9] `battle_stats` se escribe con DOS formas distintas según el
  camino.** El worker de E9 guarda `{team, teamScore, ticks, disqualified}` por
  bot; el pipeline de stats de E8 (`runStatsJob`) reescribe la misma tabla con
  el objeto rico (`perModule`, `accuracy`, `damageDealt`, `winnerSide`…). Los
  agregados de E9 (`aggregateByBotVersion`) leen campos (`shotsFired`,
  `shotsHit`, `died`) que SOLO existen en la forma rica de E8. Si en producción
  corre el camino de E9 sin el job de E8, las clasificaciones por precisión y
  supervivencia salen a cero. **Detectado por:** lectura cruzada de
  `battle-runner.ts` y `stats.ts` al construir T12.1. **Acción:** ligada a H2 —
  al cablear `runStatsJob` en el worker, `battle_stats` queda siempre en la
  forma rica. Reportado a E8/E9.

- **H4 · [E10] La CI construye imágenes solo para 2 de 8 servicios.** El job
  `build-images` de `ci.yml` tiene matriz `[gateway, arena-engine]` y un
  PENDIENTE explícito para api/web/tournament-worker/bot-manager/map-service/
  replay-service. Hasta que sus entrypoints existan, ni la etapa 5 ni el
  despliegue por Compose cubren esos servicios. **Detectado por:** revisión de
  la CI para integrar el job `e2e-mvp`. **Acción:** E10 + cada equipo dueño del
  servicio. Reportado (ya estaba anotado en `ci.yml`; E12 lo eleva a hallazgo
  para que no se pierda).

### P3 — Baja / deuda declarada

- **H5 · [E2, hueco de esquema] `cpuMs: null` en `battle_stats`.** El motor no
  mide CPU por bot; el hueco es explícito y lo llenará el runner containerizado
  de E6/E9. Sin acción hasta que exista ese runner. Solo se registra para
  trazabilidad.
- **H6 · [E7/E1, contrato] `ratingHistory`/`ratingAt` y standings por EQUIPOS
  sin ruta HTTP.** Funciones listas y probadas en E9, pero no expuestas hasta
  que E1 fije el contrato. Sin impacto en el MVP; se hereda de la entrega de E9.
- **H7 · [tipos] 7 errores de `tsc --noEmit` preexistentes** (E2/E3/E4) mantienen
  `continue-on-error` en la etapa 1 de la CI. No es de E12; se reporta para que
  los dueños los limpien y se pueda bloquear la etapa.

## Límites de entorno (honestidad)

- Sin grupo docker ni sudo: todo lo containerizado/staging (contenedores de
  bots, `docker compose up`, matar contenedores en caliente, render Phaser en
  navegador) queda como [PENDIENTE de staging], nunca como verde falso.
- Node v20.19.2: el fallo `zstdCompressSync` de `replay-golden.test.ts` es de
  entorno (exige Node ≥22.15), preexistente y ajeno a E12 — no se arregla ni se
  cuenta como regresión.
- No se ha usado ninguna BD/servicio de producción del homelab.

## Ámbitos NO tocados (según encargo)

`apps/arena-engine/src/sim/` y `docs/estado-proyecto.md` intactos. No se
reimplementó lógica de ningún equipo: toda la integración importa las piezas
reales. `main` no se toca.
