> Anexo de trazabilidad: informe de trabajo original, saneado para publicación (rutas locales sustituidas por marcadores y sección de anexo privado retirada; estaba vacía). Las severidades y grupos **finales** son los de los documentos 01-15, no los de este informe.

# Auditoría de producto S9 AI Arena — Agente 1: Arquitectura y motor

- Repo: pjclavero/s9-ai-arena · HEAD verificado (`git -C <árbol-auditado@8f380eb> rev-parse HEAD`): `8f380eb700c3e984691649b3449d2c543038dfb1` (main, merge #298; motor 0.5.0)
- Fecha: 2026-11-19 · Fase 1 (estática, sólo lectura). Prefijo de hallazgos: ARQ-
- Alcance mirado: estructura de apps/packages/runtimes/sdks/infrastructure, `apps/arena-engine/src` (rng, replay, engine-compat, state-hash, lint de determinismo, battle/combat), `packages/game-rules`, `packages/module-catalog` (validador), `apps/replay-service` (stats/store), `apps/tournament-worker` (puntos de contacto), ADR-000/021-024, `docs/technical/engine.md`, scripts de mutantes.
- NO se pudo mirar (prohibido en fase 1 o fuera de presupuesto): ejecución de tests, CI en vivo (no se citó ningún run id), producción, rendimiento medido, bucle completo de `battle.ts`/`physics.ts` línea a línea (sólo muestreo), `apps/web` y `apps/api` salvo contactos con el motor. Las afirmaciones de rendimiento son de lectura.

## 1. Resumen (veredicto: READY_WITH_CONDITIONS)

1. El motor está construido con una disciplina de determinismo poco común: PRNG propio (xoshiro128**) con flujos con nombre, hash de estado por componentes con canonicalización explícita de Map/Set/floats, lint que prohíbe `Math.random`/`Date`/`performance.now`/`hrtime` en todo `src/` salvo cuatro ficheros exentos y justificados, y verificador de replay de versión única que rechaza con motivo explícito (`engine_version_mismatch`, etc.) en vez de decir «manipulado». (CODE_VERIFIED)
2. La política de versionado es clara y conservadora: ADR-022/024, una sola subida por OLA, sin `engine.reproduces`; replays de otra versión no se re-simulan. Es honesta pero implica que **cada subida de motor invalida todo el histórico de replays verificables**.
3. El riesgo real para evolucionar sin romper replays/rankings no está en el motor sino en los consumidores que re-simulan sin pasar por `headerIncompatibility`: el job de estadísticas (ARQ-01) y `resimulateWithEvents`. Hoy sólo hay replays v2 de una versión en producción; en la próxima subida se vuelve real.
4. La CI vigila las anclas de mutantes de mc/md/mb/g1 pero no las de me/ma/g2/g3 (ARQ-02, P3 confirmado).
5. La versión del motor está escrita a mano en `rules-doc.ts` y en ejemplos del protocolo/SDK; ningún test la cruza con `engine-deps.json` (ARQ-03, P3 confirmado).
6. La prueba de resistencia usa sólo `dm_practice` (ARQ-04, P3 confirmado); ni CTF ni la prórroga (hasta 36 000 ticks extra) están bajo carga.
7. ADR-024 SÍ explica qué pasa con copias de reglas 0.4.0 (el P3 histórico queda refutado en lo sustancial); lo que falta es actualizar su estado/índice y decir qué pasa con ratings entre versiones (ARQ-05, ARQ-06).
8. Deuda arquitectónica: código muerto del motor (`match.ts`, `checkpoint.ts`, camino `/run`), duplicación de la regla arma↔munición en 3 sitios, artefactos sueltos en la raíz del repo público (`.zip`, `.docx`), docs técnicas parcialmente desfasadas respecto a 0.5.0.
9. Verificaciones que sólo caben en laboratorio: determinismo entre máquinas/versiones de Node, coste por tick, batería de replays cruzados, estrés por modo.
10. Veredicto: READY_WITH_CONDITIONS en motor y arquitectura; ningún hallazgo es bloqueante de lanzamiento, el más relevante a medio plazo es ARQ-01.

## 2. Matriz del área

| Elemento | Estado real | Evidencia | Qué falta | Prio | Esfuerzo | Bloquea lanzamiento |
|---|---|---|---|---|---|---|
| PRNG y flujos con nombre | Implementado, serializable, sin Math.random | `arena-engine/src/rng.ts`; `scripts/lint-determinism.mjs` · CODE_VERIFIED | Ejecutar `determinism*.test.ts` (fase 2) | - | - | No |
| Lint de determinismo | Carga invertida: todo `src/` vigilado, 4 exentos justificados + tests | `lint-determinism.mjs:30-48`; `package.json` script `lint` · CODE_VERIFIED | Confirmar que `lint` corre en CI y que un mutante lo pone rojo | P3 | S | No |
| Hash de estado | Por componentes, Map/Set ordenados, floats redondeados a 1e-5 | `sim/state-hash.ts:15,63,100-110` · CODE_VERIFIED | Prueba cruzada Node/CPU | P3 | M | No |
| Replay v2 y verificación | Versión única, rechazo con motivo | `replay.ts:329-360`; `engine-compat.ts` · CODE_VERIFIED | Ver ARQ-01 | P2 | S | No |
| Versionado motor/rulesets | ADR-022/024, `engine-deps.json` | `engine-deps.json` v0.5.0 · CODE_VERIFIED | Versión fuente única (ARQ-03) | P3 | S | No |
| Rapier fijado por sha256 | Motor no arranca si el wasm cambia | `engine-deps.json`; `engine.md:159` · CODE_VERIFIED (arranque: no ejecutado) | Probar arranque con wasm alterado | P3 | S | No |
| Anclas de mutantes en CI | Sólo mc/md/mb/g1 | `tests/hardening-mutant-anchors.test.ts:13` · CODE_VERIFIED | me/ma/g2/g3 (ARQ-02) | P3 | S | No |
| Contratos motor↔workers↔API↔visor | `@s9/protocol`, `engine-v2.ts`, `rules-doc` | `packages/protocol`, `module-catalog/contracts/engine-v2.ts` · PARTIAL | Revisión de consumidores (visor) fuera de alcance | P3 | M | No |
| Rendimiento (lectura) | Sin límites visibles de coste por tick; límite de ticks sí | `battle.ts:1093` (`run(maxTicks=100000)`); `game-rules/index.ts:320,328` · CODE_VERIFIED | Medición (fase 2) | P3 | M | No |
| Código muerto del motor | `match.ts`, `checkpoint.ts`, `/run` sin consumidor | TD-021, TD-039; grep sin importadores no-test · CODE_VERIFIED | Borrar o conectar | P4 | S | No |
| Docs técnicas vs código | Desfase parcial | `docs/technical/engine.md:193`, `docs/adr/index.md:25` · CODE_VERIFIED | Actualizar | P3 | S | No |

## 3. Fortalezas y debilidades

Fortalezas (con evidencia):
- Determinismo por construcción y por lint, no por convención: la lista de exentos es explícita y cualquier fichero nuevo queda vigilado (`lint-determinism.mjs:6-48`). CODE_VERIFIED.
- Flujos de RNG derivados por etiqueta con sha256 sin consumir del padre: añadir una tirada en un subsistema no desplaza a los demás (`rng.ts` cabecera). CODE_VERIFIED.
- Hash de estado canónico y explicable por componente: un fallo de verificación indica qué parte divergió (`state-hash.ts:4-15`). CODE_VERIFIED.
- Verificador que distingue «versión distinta» de «manipulado» y comprueba la versión antes que `rules_incomplete` (`replay.ts:329-360`; ADR-024 cita `engine-version-ola2.test.ts`). CODE_VERIFIED (el test existe; su paso en CI no verificado).
- Cabecera de replay que ata motor, física (paquete+wasm), protocolo, runtime, catálogo (versión+digest), esquema de hash/RNG/ids (`replay.ts:329-360`). CODE_VERIFIED.
- Disciplina de mutantes versionada con el código y con comprobación de anclas en CI para 4 matrices (`hardening-mutant-anchors.test.ts`). CODE_VERIFIED.

Debilidades: ver hallazgos (consumidores que re-simulan sin cabecera, versión duplicada, cobertura parcial de anclas, duplicación de reglas, residuos en raíz, docs desfasadas).

## 4. Hallazgos (por severidad)

### ARQ-01 · El job de estadísticas re-simula sin comprobar la versión del motor
- Área: replay-service / motor · Severidad: P2 (histórica: P3 en OLA 2; sube porque es el único camino que ya existe para que un replay antiguo produzca datos erróneos en silencio al próximo cambio de motor)
- Tipo: RIESGO (el defecto se materializa sólo con replays v2 de otra versión; hoy sólo existen en laboratorio/CI según ADR-024)
- Grupo: B necesaria versión
- Descripción e impacto: `runStatsJob` carga con `loadStored` y llama a `computeBattleStats`, que usa `resimulateWithEvents`. `loadStored`/`validateReplay` sólo comprueban `formatVersion === 2` y que existan las versiones en la cabecera, no que coincidan con el motor en ejecución. `resimulateWithEvents` reconstruye con `configFromHeader`, que sólo valida la política de rearme, no `headerIncompatibility`. Tras una subida de motor, un replay v2 de la versión anterior se re-simularía con la nueva física/reglas: las estadísticas por bot (daño, bajas, uso de módulos) saldrían de una simulación distinta a la jugada y se escribirían en `battle_stats` (DELETE+INSERT) sin error. Afecta a administradores y jugadores (estadísticas) y, si éstas alimentan agregados por versión de bot, a la lectura de rankings.
- Evidencia: `apps/replay-service/src/stats.ts:620-659`; `apps/replay-service/src/store.ts:189-218` y `:59-70`; `apps/arena-engine/src/replay.ts:309-326,422-429`. ADR-024 «Qué pasa con los replays» cubre sólo `verify`. CODE_VERIFIED. Si el flujo de ingesta verifica antes de encolar el job: UNKNOWN (no trazado).
- Reproducción (fase 2, lab): cargar un replay v2 con `header.versions.engine` alterado y ejecutar `runStatsJob`; esperado hoy: filas escritas; esperado tras corregir: error `engine_version_mismatch`.
- Causa probable: la comprobación de compatibilidad vive sólo en `verify()`/`verifyAndRecompute()`, no en la capa de carga ni en `resimulateWithEvents`.
- Solución: llamar a `headerIncompatibility()` en `resimulateWithEvents` (o en `loadStored` con opción) y propagar el motivo; test que lo ponga rojo con versión alterada.
- Esfuerzo: S (baja incertidumbre). Dependencias: ninguna. Validación: test calibrado (mutar la comprobación debe fallar).

### ARQ-02 · La CI no vigila las anclas de mutantes me/ma/g2/g3
- Área: calidad del motor · Severidad: P3 (histórica P3, confirmada)
- Tipo: DEUDA · Grupo: C poslanzamiento
- Descripción: el test de anclas fija `EXPECTED = { mc:17, md:22, mb:13, g1:57 }`. Existen además `ma-mutants.py`, `g2-mutants.py`, `g3-rearm-mutants.py`, `me-mutants.mjs/json` (y otras matrices fuera de `scripts/hardening`, p. ej. `mg-runtime-settings-mutants.py`) cuyas anclas pueden quedar ausentes/duplicadas tras un cambio de código sin que la CI lo note. Es exactamente el fallo que el propio test cita (M10 de MD tras merge de MA). `run-mutants.sh` documenta sólo mc|md|mb|g1.
- Evidencia: `apps/arena-engine/tests/hardening-mutant-anchors.test.ts:13`; `ls scripts/hardening` @8f380eb. CODE_VERIFIED. Que `ma/g2/g3` soporten `--dry-run`: PARTIAL (sólo `mutlib.py:129` y mc/md/mb lo documentan; ma/g2/g3 no verificados individualmente).
- Solución: extender la tabla de matrices (o descubrirlas por glob) y añadir `--dry-run` a las que no lo tengan; `me-mutants` necesita su propia comprobación (formato distinto). Esfuerzo: S-M, incertidumbre media.

### ARQ-03 · La versión del motor está escrita a mano en varios sitios sin cruce con `engine-deps.json`
- Área: versionado · Severidad: P3 (confirmada) · Tipo: DEUDA · Grupo: B
- Descripción: `engineVersion: "0.5.0"` literal en `rules-doc.ts:68` y en el texto Markdown generado (`rules-doc.ts:149`); ejemplos del protocolo y casos compartidos de SDK (`packages/protocol/examples/valid/welcome-*.json`, `sdks/shared-contract-tests/cases/*.json`) también llevan la versión. `generate-rules-doc.ts` regenera `docs/user/rules.*` desde `rules-doc.ts`, así que el test «repo al día» es autoconsistente: tras subir `engine-deps.json` a 0.6.0 el test de rules-doc seguiría verde con «0.5.0». (Los tests de contrato de SDK leen la versión de `engine-deps.json` según ADR-024, lo que cubre parcialmente los ejemplos; no verificado que cubra `rules-doc`.)
- Evidencia: `packages/game-rules/rules-doc.ts:68,149`; grep de `engine-deps` en `rules-doc.test.ts` sin resultados. CODE_VERIFIED.
- Solución: importar `engine-deps.json` en `rules-doc.ts` (o test que compare). Residuo de comentarios «motor 0.4.0» en `battle-rules.ts:26,1068` y `web/src/help/names.ts:140` es cosmético. Esfuerzo S, incertidumbre baja.

### ARQ-04 · La prueba de resistencia sólo ejercita `dm_practice`
- Área: rendimiento/fiabilidad · Severidad: P3 (confirmada) · Tipo: FALTA · Grupo: C
- Descripción: `mf-resistance-docker.test.ts:114` usa `loadRuleset("dm_practice@1", { timeLimitTicks: 120 })`. No se ejerce CTF, zone control, 4v4 ni la prórroga (hasta `OVERTIME_TECHNICAL_LIMIT_TICKS = 36 000` ticks extra, `game-rules/index.ts:320`), que son el camino de mayor coste por batalla y de más memoria (replay, hashes, checkpoints crecen con los ticks). Es un test Docker: si corre en CI no está verificado.
- Evidencia: fichero:línea anterior · CODE_VERIFIED. Solución: parametrizar por modo/ruleset en el lab de fase 2. Esfuerzo M, incertidumbre media.

### ARQ-05 · ADR-024 explica las copias de reglas 0.4.0; lo que falta es su estado y el índice
- Área: documentación de decisiones · Severidad: P4 (histórica: P3 «no explica»; revalidada a la baja porque la sección «Copias de reglas» existe) · Tipo: DEUDA · Grupo: C
- Descripción: ADR-024 cubre: son metadatos, el worker no los compara, una batalla `scheduled` se juega con 0.5.0, la copia sin `rearmPolicy` usa `self`. No dice (a) que el ADR sigue «propuesto» pese a estar en main (`docs/adr/index.md:25` aún habla de «rama … sin desplegar»), ni (b) qué hacer con una copia con `engineVersion` futura. En código, `engineVersion` de la copia sólo se escribe (`apps/api/src/services/battle-rules.ts:225,258,395,459`); no hallé ningún lector que decida con él. CODE_VERIFIED (grep).
- Solución: cerrar estado del ADR y actualizar índice y `engine.md:193-195`. Esfuerzo S.

### ARQ-06 · Ratings/ELO y estadísticas no tienen política declarada ante un cambio de motor
- Área: rankings · Severidad: P3 · Tipo: RIESGO/HIPÓTESIS · Grupo: D futuro
- Descripción: `battles.engine_versions` se graba por batalla (`tournament-worker/src/battle-runner.ts:601`), pero no hallé en `ratings.ts`/`season.ts` ninguna referencia al motor (grep de «engine» sin resultados). Una subida que altere la simulación (ADR-024: daño, alcance, HE) mezcla en el mismo ELO batallas jugadas con físicas distintas. Ninguna ADR decide si se reinicia temporada, se segmenta o se acepta. Es una decisión de producto, no un fallo de código.
- Evidencia: grep en `apps/tournament-worker/src/{ratings,season}.ts`; ADR-E9-002. CODE_VERIFIED (ausencia en esos dos ficheros; no se revisó la API de lectura). Solución: ADR de «cambios de motor y temporadas». Esfuerzo S (decisión) + M (si se segmenta).

### ARQ-07 · Regla arma↔munición con lógica en tres sitios
- Área: coherencia · Severidad: P3 · Tipo: DEUDA · Grupo: C
- Descripción: el validador (`module-catalog/validator/index.ts:303-390`, regla «tal como dispara el motor»), el motor (`arena-engine/src/sim/combat.ts:138-149`, `ammoFor`, que además usa `moduleId.split("@")[0]` y cae al primer compatible aunque esté a 0) y la elegibilidad de la API (`api/src/services/version-eligibility.ts:51-104`, que clasifica por la forma de la violación) deben coincidir. La coherencia depende de tests y de comentarios cruzados, no de una función compartida. Un cambio en un lado puede aceptar un loadout que el otro no dispara (el caso histórico de RC5.3/5.4). No se encontró incoherencia hoy (no se ejecutó nada).
- Evidencia: referencias anteriores · CODE_VERIFIED. Solución: exponer `ammoCompatible(weaponDef, ammoDef)` en `module-catalog` y usarla en motor y validador; test de propiedad que cruce ambos. Esfuerzo M, incertidumbre baja.

### ARQ-08 · Artefactos sueltos en la raíz de un repo público
- Área: higiene del repositorio · Severidad: P3 · Tipo: DEUDA · Grupo: B (antes de publicar) 
- Descripción: `s9-ai-arena-part2.zip` (≈25 KB, introducido el 2026-07-07, commit `4016d0ad`) y `Dosier_tecnico_S9_AI_Arena_motor_2D_modular.docx` (≈58 KB) están versionados en la raíz. No tienen consumidores en código; pueden contener contenido histórico o interno que un repo público no debería llevar. No se abrió su contenido (no hay `unzip` y no se pidió abrir documentos): su sensibilidad es UNKNOWN. Además `docker-compose.demo.yml` en raíz.
- Evidencia: `git ls-tree 8f380eb` raíz · CODE_VERIFIED (existencia). Solución: revisar contenido, mover a `docs/` o eliminar. Esfuerzo S.

### ARQ-09 · Código muerto del motor conservado dentro de `src/`
- Área: motor · Severidad: P4 · Tipo: DEUDA · Grupo: C (TD-021/TD-039 abiertos, prioridad anterior P4/P3, sin cambio)
- Descripción: `match.ts` (MatchRunner, 131 l.), `checkpoint.ts` (268 l.), camino HTTP `POST /run` de `service.ts` y parte de `fixtures.ts`/`stubs.ts` no tienen importadores en producción (grep sobre `apps`/`packages` sin tests: sólo `local-sim`, `container-battle` y `protocol-server` consumen otras piezas). Ocupan superficie de mantenimiento y entran en el lint y en cualquier cambio de versión. `engine.md:198` ya lo declara.
- Evidencia: grep de imports; `docs/technical/engine.md:197-198`. CODE_VERIFIED. Solución: eliminar o mover a `dev/`. Esfuerzo S-M.

### ARQ-10 · `checkpointEveryNTicks` se graba pero la reanudación no se usa
- Área: motor/replay · Severidad: P4 · Tipo: DESIGN_ONLY parcial · Grupo: D
- Descripción: el replay v2 graba checkpoints por componente (`battle.ts:199-200`), útiles para localizar divergencias; la reanudación de una batalla desde checkpoint (`checkpoint.ts`) no la consume ningún servicio, y ADR-024 indica que un checkpoint no se reanuda entre versiones. Coherente, pero la promesa de «reanudar batallas en vivo» está sólo en diseño. TD-038 (batalla en vivo no reproducible por semilla) sigue abierto.
- Evidencia: `battle.ts:77-78,199-200`; TD-038. CODE_VERIFIED/DESIGN_ONLY.

### ARQ-11 · Determinismo entre plataformas: pinned Rapier, pero `Math.sin/cos/atan2/hypot` y runtime sólo por major
- Área: motor · Severidad: P3 · Tipo: HIPÓTESIS · Grupo: D
- Descripción: el motor usa funciones trascendentes de V8 (≥34 llamadas en `sim/*.ts`) y la cabecera registra `runtime: "node22"` (sólo major, `ADR-000:84`). Los replays se re-simulan en el mismo despliegue, así que no hay evidencia de fallo; la protección es que Rapier está fijado por sha256 y el hash redondea a 1e-5. Un cambio de CPU/build de V8 dentro de node22 que alterase el último bit podría cambiar un hash sin que lo detecte `headerIncompatibility`. No hay prueba de que esto ocurra.
- Evidencia: `replay.ts:345`; grep de `Math.*` en `sim/` · CODE_VERIFIED (uso), HIPÓTESIS (efecto). Solución: lab de fase 2 con dos CPUs/ patches de Node; si diverge, fijar versión exacta en la cabecera. Esfuerzo M, incertidumbre alta.

### ARQ-12 · Rendimiento: bucle de tick sin presupuesto visible; límites sólo en ticks
- Área: motor · Severidad: P3 · Tipo: RIESGO · Grupo: C
- Descripción: `Battle.run(maxTicks = 100000)` y `TECHNICAL_LIMIT` acotan la duración en ticks, no en CPU. Hay ≤8 participantes (`MAX_BATTLE_PARTICIPANTS = 8`, `battle-rules.ts:110`), por lo que los bucles O(n²) de sensores/combate no explotan; los `for…of` sobre `Map.values()` (`vehicle.ts:267-443`) son por orden de inserción (determinista). El hash de estado hace `JSON.stringify` por ítem para ordenar Map/Set (`state-hash.ts:102,107`), coste proporcional a la cabecera de checkpoint cada `hashEveryNTicks`; no medido. No hay presupuesto de memoria documentado para batallas de 36 000+ ticks con replay en memoria.
- Evidencia: referencias · CODE_VERIFIED (código), rendimiento UNKNOWN. Solución: medir en lab (tiempo/tick, RSS) por modo.

## 5. Mapa de arquitectura (pregunta «¿qué tenemos?»)

Monorepo npm/pnpm (`pnpm-workspace.yaml`: `apps/*`, `bots/*`, `packages/*`; sólo `arena-server`, `arena-viewer`, `map-schema`, `protocol` y `sdks/javascript` declaran `package.json` con deps `@s9/*`; el resto se resuelve por imports relativos TS, lo que **no es un grafo de paquetes real**: p. ej. `replay-service` importa `../../arena-engine/src/replay.js` y `../../api/src/db/connection.js`).

Servicios (compose `infrastructure/docker-compose.yml`): gateway, web, api, arena-engine, tournament-worker, bot-manager, bot-build-worker, map-service, replay-service, queue (Redis), postgres, streamer, bot-runtime-template, backup, y pila de observabilidad (prometheus, alertmanager, grafana, loki, promtail, cadvisor, node-exporter, postgres-exporter).

Librerías: `packages/` (build-info, data-dir, first-run, game-rules, map-schema, module-catalog, projection, protocol, readiness, shared-types, stream-secrets, test-contracts, test-process). Núcleo de contrato: `game-rules` (reglas, ids de ruleset, límites) y `module-catalog` (catálogo, validador, contrato engine-v2) consumidos por motor, API y worker. `runtimes/` (node, python, `DIGESTS.lock`) y `sdks/` (dotnet, java, javascript, python, `shared-contract-tests`) para bots.

Dependencias reales: API → game-rules/module-catalog; worker → arena-engine (en proceso) + bot-manager (contenedores de bots); replay-service → arena-engine (re-simulación) + API DB; viewer/web → protocol/projection.

Huérfanos o de dudoso uso: `map-service` desplegado sin uso (TD-017, registrada); `arena-server`/`arena-viewer`/`bots/*` sólo en `docker-compose.demo.yml` (demo, no producción); `example-bots` (tests); `apps/arena-engine/src/{match,checkpoint}.ts` y `POST /run` (ARQ-09); `.zip`/`.docx` raíz (ARQ-08). Observación: `apps/api` expone el esquema de BD en un `migrations.ts` único (no detallado aquí).

## 6. Deuda técnica

Revalidada (registro `docs/roadmap/technical-debt.md`):
- TD-021 Código muerto motor/ratings (P4): sigue válida; añadir `match.ts`/`checkpoint.ts` → ARQ-09. Prioridad P4 sin cambio.
- TD-039 `/run` legado sin consumidor (P3): sigue; sube a «borrar» como parte de ARQ-09. Sin cambio de prioridad.
- TD-038 Batalla en vivo no reproducible por semilla (P3): sigue; ver ARQ-10.
- TD-016 Loadout con efecto parcial (P1→PARCIAL): campos FUTURE persisten en `effect-status.ts`; sin evidencia nueva para cambiar la prioridad en fase 1.
- TD-017 map-service sin uso: confirmado en compose; sigue.
Deuda nueva no registrada: ARQ-01 (stats sin versión), ARQ-02, ARQ-03, ARQ-06, ARQ-07, ARQ-08, ARQ-11. P3 abiertos de OLA 2 revalidados: anclas (confirmado), versión a mano (confirmado), resistencia (confirmado), runStatsJob (confirmado y subido a P2), ADR-024 copias (refutado en lo sustancial: sí lo explica).

## 7. Verificaciones para FASE 2 (laboratorio aislado)

1. Replays cruzados: generar un replay con motor 0.5.0, alterar `versions.engine`, ejecutar `verify` y `runStatsJob`. Confirma ARQ-01 si el job escribe filas; refuta si rechaza.
2. `npx vitest run apps/arena-engine/tests/determinism*.test.ts replay-golden.test.ts` y `node apps/arena-engine/scripts/lint-determinism.mjs --self-test`, rc=0 y salida adjunta (TEST_VERIFIED sólo con rc).
3. Mutar una ancla en `ma-mutants.py`/`g2-mutants.py` (duplicar o borrar) y comprobar que ninguna CI se pone roja (ARQ-02).
4. Cambiar `engine-deps.json` a 0.6.0 en una copia y ver si algún test se pone rojo por `rules-doc.ts` (ARQ-03).
5. Estrés por modo (dm, tdm, ctf, zona, 4v4 con prórroga): tiempo/tick, RSS pico, tamaño de replay (ARQ-04/12).
6. Mismo replay en dos CPUs/builds de node22 distintas: comparar `finalStateHash` y `stateHashesDigest` (ARQ-11).
7. Arranque con wasm de Rapier alterado: debe negarse a arrancar.
8. Test de propiedad cruzado validador↔`ammoFor`↔elegibilidad con el catálogo completo (ARQ-07).
9. Abrir con herramienta en lab el `.zip` y el `.docx` de la raíz para decidir sensibilidad (ARQ-08).

## 8. Respuestas cortas

- ¿Qué tenemos como arquitectura? Monorepo de TypeScript con un motor 2D determinista (Rapier fijado por hash) ejecutado en proceso por el worker; los bots corren en contenedores y hablan con el motor por WebSocket (`arena/1`); API, replay-service (re-simulación), gateway/web y observabilidad completa en compose. El acoplamiento entre paquetes es por imports relativos, no por dependencias declaradas.
- ¿Qué hace especialmente bien el motor? Determinismo defendido por diseño, lint y hash canónico; replays con cabecera que ata todas las versiones; rechazos explicativos; matrices de mutantes versionadas.
- ¿Dónde está la deuda real? Consumidores que re-simulan sin comprobar versión (ARQ-01), fuentes de verdad duplicadas (versión del motor, regla arma↔munición), cobertura parcial de las anclas de mutantes, código muerto dentro de `src/` y artefactos sueltos en la raíz.
- ¿Riesgos futuros para evolucionar sin romper replays/rankings? (1) cada subida invalida todo el histórico verificable (decisión consciente, ADR-022/024); (2) stats y cualquier consumidor que re-simule sin `headerIncompatibility` producirán datos erróneos en silencio; (3) ELO sin política de temporada ante cambios de simulación (ARQ-06); (4) runtime fijado sólo por major (ARQ-11); (5) sin presupuesto de CPU/memoria por batalla.
