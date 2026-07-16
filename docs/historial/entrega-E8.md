# E8 · Visor y Replays — entrega v1

Cubre **T8.1 a T8.4** (cap. 20 del dosier técnico) y las mejoras E8.M, sobre main
`7a450ae` (E1-E7 + E10 integrados). Todo lo de E2 se **importa** (`replay.ts`:
`record`/`verify`/`toJsonl`/`fromJsonl`), nada se reimplementa; la integración con E7 es
sobre su código real (Express + Knex + contrato OpenAPI por `registry.ts`).

## Estado de la suite (medido en este entorno, Node v20.19.2, 2026-07-16)

```bash
npm test -- --maxWorkers=2
# 544 pasan · 1 falla · 3 skipped (548)
```

- El **único fallo** es el PREEXISTENTE de entorno: `zstdCompressSync` no existe en
  Node 20 (`apps/arena-engine/tests/replay-golden.test.ts`, exige Node ≥ 22.15). No es
  de E8 y no se ha tocado. Línea base antes de E8: 492 pasan / mismo fallo / 3 skipped.
- E8 añade **52 tests** en 5 archivos: `apps/replay-service/tests/{replay-service,stats}.test.ts`,
  `apps/web/tests/{viewer-logic,spectator.e2e,replay-player}.test.ts`, más
  `apps/api/src/e8-replay-verify.test.ts`.
- `npx vite build apps/web` compila: panel 220 kB (69 kB gzip) + visor Phaser en chunk
  perezoso separado de 1,38 MB (361 kB gzip) que el panel no carga hasta abrir el visor.

## Contenido

```
apps/replay-service/src/
  format.ts        T8.1 · compresión (zstd/gzip), sha256, índice de keyframes
  store.ts         T8.1 · validación de ingesta, verify (cap. 28), retención 23.1
  server.ts        T8.1 · HTTP: archivo con rango (206), /index, /segment, ingesta, verify
  cli.ts           T8.1 · replay-service verify <id> | ingest | sweep | serve
  stats.ts         T8.4 · métricas por bot/módulo/equipo/mapa + job idempotente + agregados
apps/api/src/
  routes/battles.ts   T8.1 · verifyReplay (la pendiente declarada de E7: 53/53 operaciones)
                      T8.2 · ticket de espectador con jti (un solo uso) y flag debug firmado
  spectate/gateway.ts T8.2 · canal WS de espectador (el otro pendiente declarado de E7)
apps/web/src/viewer/
  spectator-client.ts T8.2 · conexión/reconexión/estado (framework-agnóstico, probado)
  interpolation.ts    T8.2 · 10 Hz → 60 fps (arco corto, render un snapshot por detrás)
  overlay.ts          T8.2 · salud, módulos, FSM de bandera, marcador, feed
  camera.ts / fog.ts  T8.2 · global/follow/team · niebla opcional gateada por ruleset
  PhaserViewer.ts     T8.2/3 · capa de RENDER (Phaser); toda la lógica vive fuera
  replay-player.ts    T8.3 · play/pausa, 0,5×–8×, salto por keyframes, enlaces ?t=
apps/web/src/pages/ViewerPage.tsx · ReplayPage.tsx   rutas públicas #/viewer/<id>, #/replay/<id>?t=
apps/arena-engine/src/replay.ts   T8.4 · resimulateWithEvents() (añadido ADITIVO a E2)
packages/game-rules/index.ts      T8.2 · Ruleset.spectator {allowFogView, delaySeconds} (opcional)
```

## Cifras medidas reales (no estimadas)

| Métrica | Valor medido | Dónde |
|---|---|---|
| Replay 5 min (9000 ticks): JSONL → comprimido | 2,23 MB → **0,06 MB** (ratio 37×, gzip) | script de medición |
| Keyframes de un replay de 5 min | 101 (cada 30 snapshots ≈ 3 s) | índice real |
| `verify` de un replay de 5 min (re-simulación completa) | **390 ms** | script de medición |
| Pipeline de estadísticas de una batalla de 5 min (DoD < 10 s) | **313 ms** | test + script |
| Salto temporal en replay de 5 min (DoD < 1 s) | < 1 s afirmado por test; en la práctica pocos ms por salto | `replay-player.test.ts` |
| Ancho de banda de espectador (E8.M, objetivo < 100 KB/s) | **10,0 KB/s** (2 bots en combate) | test + script |
| 50 batallas de regresión record→verify (`NIGHTLY=1`) | **50/50 verificadas en ~2,4 s** | ejecutado aquí |
| Suite completa | 544/1/3 en ~62 s | `npm test` |

## Estado de la DoD por tarea

| Tarea | Criterio del dosier | Estado |
|---|---|---|
| T8.1 | verify reproduce el resultado oficial de 50 batallas de regresión (nightly) | **[EJECUTADO]** 50/50 con `NIGHTLY=1` (ejecutado en esta entrega); por PR corren 8 (misma constante que las 1000 batallas de E2: la CI nightly de E10 debe exportar `NIGHTLY=1`) |
| T8.1 | Salto a tick arbitrario de un replay de 5 min < 1 s | **[EJECUTADO]** medido en `replay-player.test.ts` sobre 9000 ticks reales, 4 saltos < 1 s cada uno |
| T8.1 | Replay manipulado (un byte) detectado y marcado inválido | **[EJECUTADO]** byte volteado ⇒ `checksum_mismatch`; y el ataque serio (comando alterado + checksum regenerado) lo caza la re-simulación con el tick de divergencia |
| T8.1 | Retención elimina temporales caducados y NUNCA oficiales (relojes simulados) | **[EJECUTADO]** reloj inyectado; oficial sobrevive a un barrido "10 años después" |
| T8.2 | Corte del WS 10 s a mitad de batalla ⇒ reconexión y recuperación sin recargar | **[EJECUTADO a nivel WS real]** socket terminado en servidor con la batalla viva: el MISMO objeto cliente pide ticket nuevo (el usado está quemado), reconecta y repone estado con el snapshot completo del init. **[PENDIENTE]** la variante E2E con navegador (no hay Playwright/navegador en este entorno) |
| T8.2 | Tráfico de espectador sin observaciones privadas ni debug sin autorización (cap. 28) | **[EJECUTADO]** barrido de fugas sobre el stream COMPLETO de una batalla real: vocabulario privado prohibido byte a byte + whitelist estructural del snapshot + ningún mensaje `debug` sin ticket firmado |
| T8.2 | 60 fps con 4 bots, 20 proyectiles y 50 obstáculos | **[PENDIENTE — manual guionizado]** sin navegador no se puede medir aquí. Presupuesto documentado en `PhaserViewer.ts` (~74 objetos reutilizados, cero allocs por frame, O(entidades)); guion manual abajo |
| T8.2 | FSM de bandera reflejada en el overlay con el CTF guionizado de E2 | **[EJECUTADO]** batalla CTF REAL de E2 (mismo guion que `modes.test.ts`): taken→captured en orden, marcador = resultado |
| T8.3 | Replay oficial se reproduce y su marcador final = BattleResult almacenado | **[EJECUTADO]** contra el replay-service HTTP real (supertest); el índice incluye el resultado oficial y coincide |
| T8.3 | Salto temporal aterriza en el tick pedido ±1 tick | **[EJECUTADO]** 6 saltos + salto desde enlace, todos ±1 |
| T8.3 | Enlace compartido abre el replay en el instante correcto | **[EJECUTADO a nivel lógico/HTTP]** `#/replay/<id>?t=` round-trip + init(t) ±1 tick; **[PENDIENTE]** clic real en navegador |
| T8.3 | 8× no desincroniza eventos y snapshots | **[EJECUTADO]** frames irregulares a 8×: todos los eventos, en orden, en su tick, snapshot nunca >3 ticks por detrás; ni pérdida ni duplicado contra el replay oficial |
| T8.4 | Reprocesar la misma batalla no duplica estadísticas | **[EJECUTADO]** contra PostgreSQL real embebido (harness de E7), filas bit a bit idénticas |
| T8.4 | Métricas de batalla guionizada = valores a mano (golden) | **[EJECUTADO]** CTF: 1 toma + 1 captura + lado ganador; bot mudo: EXACTAMENTE `maxConsecutiveTimeouts` turnos omitidos + descalificación; conservación exacta del daño (repartido = encajado) |
| T8.4 | Estadísticas por módulo alimentan el informe de balance de E3 | **[EJECUTADO parcialmente]** `aggregateByModule()` produce uso/daño/fallos/eficiencia/supervivencia por `moduleId` del catálogo REAL de E3 (test lo verifica contra `loadCatalog()`). **[PENDIENTE]** que E3 consuma este insumo en la próxima edición de su informe (el suyo actual usa su propio banco `balance/run.ts`) |
| T8.4 | Batalla de 5 min procesada < 10 s | **[EJECUTADO]** 313 ms medidos (re-simulación incluida) |

## Decisiones (las que alguien querrá discutir)

1. **zstd con gzip de reserva documentada.** El formato canónico es JSONL+zstd (E8.M),
   pero `node:zlib` solo trae zstd desde Node ≥ 22.15 y este entorno es Node 20 (es el
   mismo motivo del fallo preexistente de E2). `format.ts` usa zstd si existe y si no
   gzip, registra el algoritmo en el índice y detecta por bytes mágicos al leer. En
   cuanto E10 fije Node ≥ 22.15, zstd sin cambiar una línea. **No se maquilló**: los
   tests de esta entrega ejercitan la rama gzip; la rama zstd queda [PENDIENTE de runtime].
2. **verifyReplay se niega ante versión de motor distinta.** "Re-simular con la versión
   registrada" con un despliegue de motor único significa: si la cabecera registra otra
   versión, verificar con la actual sería mentir ⇒ `engine_version_mismatch` (multi-versión
   es asunto de E10).
3. **Ticket de espectador de UN SOLO USO** (jti quemado en el gateway) y **debug firmado
   por la API según rol** (`ROLE_RANK ≥ moderator`): el visor no puede autoconcederse capas
   de depuración. En replay, la depuración (comandos grabados) es **opt-in del dueño**
   (`debugOpen` en la ingesta): el segmento no la sirve en otro caso.
4. **La niebla de guerra del espectador es una aproximación client-side** por radio de
   visión, gateada por `ruleset.spectator.allowFogView`: el canal público NO transporta
   la visibilidad exacta por equipo (es privada, T2.4) y JAMÁS se enseña nada que el
   stream no traiga. Niebla exacta ⇒ pendiente de que E2 publique visibilidad por equipo.
5. **Estadísticas re-simulando el archivo** (política 23.1): los eventos privados no
   viajan en el replay (D8); `resimulateWithEvents()` (añadido aditivo en E2/replay.ts,
   con drenaje de la cola del último ciclo para no infracontar) los regenera exactos por
   determinismo. `cpuMs: null` es un hueco explícito: el motor no mide CPU por bot.
6. **Retardo anti-coaching** (`spectator.delaySeconds`, E8.M) implementado y medido en test.
7. **Snapshot público a 10 Hz** ya venía de E2 (snapshotEveryNTicks=3 a 30 Hz); el
   presupuesto E8.M (< 100 KB/s) se mide en test (10 KB/s con 2 bots): queda margen ~10×
   para 8 bots + proyectiles.

## Guion del test manual de rendimiento (60 fps, pendiente de navegador)

1. `npx tsx apps/replay-service/src/cli.ts serve --port 8082` con un replay ingerido de
   una batalla de 4 bots (`--official`).
2. `npx vite apps/web` y abrir `#/replay/<battleId>` en el portátil de referencia.
3. DevTools → Performance → grabar 30 s a 1× y a 8×; criterio: p95 de frame < 16,6 ms
   con 4 bots + 20 proyectiles + 50 obstáculos (mapa `mvp-arena-01` + destructibles).

## Pendiente de reconciliación (explícito)

| Con | Qué | Estado actual en E8 |
|---|---|---|
| E9 | Quién ejecuta batallas y llama a `gateway.attachBattle()` + ingesta del replay + `runStatsJob()` al terminar (job `run_battle`) | Los tres puntos de entrada existen y están probados con batallas reales; el worker de E9 debe invocarlos |
| E9 | `aggregateByBotVersion()` como insumo de ratings/standings | Función probada contra `battle_stats`+`participants` reales |
| E10 | Enrutar `/replay-service/*` → replay-service y fijar `SPECTATE_WS_URL`; `NIGHTLY=1` en la CI nocturna (50 batallas de regresión); Node ≥ 22.15 para zstd real | Variables/comandos documentados aquí y en el README del servicio |
| E3 | Consumir `aggregateByModule()` en la siguiente edición del informe de balance | Formato verificado contra el catálogo real |
| E2 | Visibilidad por equipo en el snapshot público (niebla exacta de espectador); dueño de la mina en `mine_triggered` (hoy se resuelve por posición) | Aproximaciones documentadas en `fog.ts` y `stats.ts` |
| E6/E9 | CPU por bot medida por el runner (hueco `cpuMs: null` en battle_stats) | Esquema listo |
| E11 | Público/embeds: el visor y el replay ya son rutas públicas sin cuenta | — |

## Qué NO está verificado en este entorno (honestidad)

- **Render Phaser y 60 fps**: no hay navegador ni Playwright. Cubierto con: lógica del
  visor 100 % probada fuera de Phaser, integración WS/HTTP real, `vite build` en verde y
  guion manual. El E2E de navegador queda para cuando la CI (E10) tenga navegador.
- **zstd real**: rama escrita pero no ejecutable en Node 20 (ver decisión 1).
- **Docker/producción**: ia02 no tiene docker ni sudo; nada se ha desplegado ni tocado
  en producción. Los tests de BD usan PostgreSQL embebido (ADR-E7-002), jamás el homelab.
