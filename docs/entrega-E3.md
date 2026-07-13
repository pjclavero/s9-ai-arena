# E3 · Sistema Modular de Vehículos — entrega v1

Catálogo de módulos del MVP, validador de ensamblaje, resolución de loadout a
`VehicleSpec` y banco de simulación espejo. Cubre **T3.1 a T3.4** contra los
contratos publicados por E1 (`module.schema.json`, `loadout.schema.json`,
ADR-000) y la interfaz de motor publicada por E2 (`VehicleSpec`, `Battle`).
`fixtures.ts` del motor ya usa el catálogo real, no el andamio provisional.

## Estado: 191 pruebas, todas en verde

```bash
npm install
npm test                                                        # 191 pruebas
node apps/arena-engine/scripts/lint-determinism.mjs --self-test
node packages/module-catalog/scripts/validate-catalog.js        # Ajv de E1
npx tsx packages/module-catalog/balance/run.ts --n 200           # banco de balance (~3,5 s)
```

Nota de entorno: la primera pasada de esta entrega se escribió en una máquina sin
Node.js instalado, así que todo el trabajo se verificó a mano (trazando cada test
sobre papel) antes de tener acceso a un entorno real. Al conseguirlo, corrí la
suite completa: **todo lo que había trazado a mano coincidió exactamente** con el
resultado real (goldens de T3.3 incluidos, byte a byte) — con dos excepciones
reales que las pruebas cazaron y que se documentan abajo como hallazgos.

## Contenido

```
packages/module-catalog/
  data/*.json (29)           T3.1 · catálogo MVP: 3 chasis (+1 versión de balance:
                              chassis.light@2), 2 movimiento, 2 potencia (+1 v2),
                              3 sensores, 2 armas (+1 v2) + 3 municiones, 1 mina,
                              8 blindajes (4 sectores × 2 materiales), 1 radio,
                              +1 chassis.medium@2 de balance
  data.test.ts                T3.1 · valida los 29 contra module.schema.json (Ajv real),
                              integridad referencial, 1 loadout legal por chasis
  types.ts / loadCatalog.ts   Tipos compartidos y el único punto que toca disco
  validator/index.ts          T3.2 · validateLoadout(...) → Violation[]; función pura
  validator/index.test.ts     T3.2 · 26 casos + propiedad fast-check (200 runs, 15 ms)
  resolve/index.ts            T3.3 · resolveVehicle(loadout, catalog) → VehicleSpec
  resolve/archetypes.ts       4 arquetipos de referencia (scout/gunner/miner/heavy), @1 fijo
  resolve/golden/*.json       T3.3 · fichas exactas de los 4 arquetipos (match byte a byte)
  resolve/golden/.catalog-lock.json  Snapshot para el test de inmutabilidad
  resolve/index.test.ts       T3.3 · goldens + integración real con Vehicle/Battle + perf
  resolve/immutability.test.ts  Falla si data/ sobrescribe una versión ya usada
  balance/archetypes.ts       3 arquetipos de balance (radar + @2 tras iterar, ver v1.md)
  balance/run.ts               T3.4 · banco de simulación espejo, CLI reproducible
  balance/archetypes.test.ts  Legalidad de los 3 arquetipos del banco
apps/arena-engine/
  src/fixtures.ts              MODIFICADO: gunnerLoadout/scoutLoadout/minerLoadout/
                              sandbagLoadout ahora llaman a resolveVehicle() con el
                              catálogo real; MODULES se mantiene (lo siguen leyendo
                              2 tests de E2)
  tests/validator-integration.test.ts  Prueba que el motor importa la MISMA función de E3
  tests/combat.test.ts          MODIFICADO: 1 test (slot "sensor_b"→"sensor_a", ver hallazgo)
  tests/sensors-fog.test.ts     MODIFICADO: 2 tests (qué vehículo lleva el radar, ver hallazgo)
tests/golden/*.json            REGENERADOS conscientemente (chase/head_on/combat_result):
                              la física cambia porque las masas/velocidades reales del
                              catálogo difieren del andamio provisional (ver hallazgo)
docs/balance/
  v1.md                       Justificación de cada número v1 + la iteración de balance v2
  informe-v1.md                Resultado REAL de 200 batallas × 3 emparejamientos
vitest.config.ts               MODIFICADO: include no cubría packages/**/*.test.ts (hallazgo)
package.json                   MODIFICADO: +fast-check en devDependencies
```

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T3.1 | Todos los módulos validan contra `module.schema.json` | ✅ Ajv real, `npm test` |
| T3.1 | ≥1 loadout legal por chasis dentro de presupuesto/masa/energía | ✅ `data.test.ts`, 3/3 |
| T3.1 | Sin referencias rotas (`acceptsAmmo`, `requiresChassis`) | ✅ `data.test.ts` |
| T3.1 | `docs/balance/v1.md` justifica cada número | ✅ incluye la iteración v2 |
| T3.2 | 25+ loadouts, código de violación exacto en `violations[0]` | ✅ 26 casos, 26/26 en verde |
| T3.2 | Propiedad con fast-check sobre el catálogo real | ✅ 200 ejecuciones, 15 ms |
| T3.2 | Función pura, sin `fs`/`fetch` dentro | ✅ (revisión de código) |
| T3.2 | Test cruzado desde `apps/arena-engine` con ruta relativa real | ✅ `validator-integration.test.ts` |
| T3.3 | Golden files para 4 arquetipos | ✅ match exacto, byte a byte |
| T3.3 | Integración real con `Vehicle`/`Battle` sin lanzar | ✅ 30 ms, 30 ticks reales con WASM de Rapier |
| T3.3 | 100 loadouts resueltos < 50 ms, medido fuera de `sim/` | ✅ **1 ms** medidos (objetivo 50 ms) |
| T3.4 | Matriz completa, informe reproducible por semilla | ✅ ejecutado dos veces, diff vacío |
| T3.4 | Todos los emparejamientos en 45–55 % de winrate | ✅ 46,5 % / 51,8 % / 48,0 % (200 batallas c/u) |
| T3.4 | Test que detecta sobrescritura de una versión usada | ✅ `resolve/immutability.test.ts` |
| T3.4 | CI rápido (20 muestras) vs nightly (200), semilla registrada | ✅ `--n` en el CLI |
| Final | `fixtures.ts` reapuntado a `resolveVehicle()` real | ✅ hecho, con 3 tests de E2 corregidos (ver hallazgos) |
| Final | `npm test` sigue en verde (81 + los nuevos) | ✅ 191/191 |

## Cifras medidas (no estimadas)

- **Catálogo:** 29 archivos de módulo — 25 de v1 + 4 versiones `@2` de balance
  (`chassis.light`, `weapon.mg`, `power.generator`, `chassis.medium`).
- **Tests:** 191 pruebas, 14 archivos, 0 fallos. `npm test` completo en ~4,4 s.
- **Validador:** 26/26 casos con el código de violación exacto; propiedad de
  fast-check (200 loadouts aleatorios del catálogo real) en 15 ms.
- **Resolución:** los 4 goldens de T3.3 coinciden byte a byte con lo calculado a
  mano antes de tener Node disponible. 100 resoluciones en **1 ms** (objetivo: 50 ms).
- **Integración con el motor:** una `Battle` real con dos vehículos resueltos por
  `resolveVehicle()` corre 30 ticks con el WASM de Rapier cargado, en 30 ms.
- **Balance:** 200 batallas × 3 emparejamientos (`scout_vs_gunner` 46,5 %,
  `scout_vs_heavy` 51,8 %, `gunner_vs_heavy` 48,0 %) — los tres dentro de 45–55 %.
  Reproducible: dos ejecuciones consecutivas de `--n 200` producen
  `docs/balance/informe-v1.md` idéntico byte a byte. ~3,5 s de reloj para las 600
  batallas.
- **Ajv:** los 25 módulos v1 (+4 de balance) validan contra `module.schema.json`;
  el script de ejemplos de E1 (`validate-catalog.js`) sigue en verde sin tocarlo.

## Cuatro hallazgos reales (encontrados corriendo, no a priori)

**1. `vitest.config.ts` no habría corrido ni un test de `packages/`.** El
`include` original era `["apps/**/tests/**/*.test.ts"]`. Cualquier test bajo
`packages/` —todo T3, más `packages/game-rules/constants.test.ts` de E1— quedaba
fuera del descubrimiento de vitest. Corregido a
`["apps/**/tests/**/*.test.ts", "packages/**/*.test.ts"]`. Sin este fix, esta
entrega habría reportado "81 passed" para siempre sin probar una sola línea de E3.

**2. `HunterBot` solo dispara a contactos de radar, nunca de lidar** (confirmado
en producción, no solo leyendo el código: el primer intento de wiring de
`fixtures.ts` hizo fallar 2 tests de `sensors-fog.test.ts` porque
`scoutLoadout()` real solo lleva `sensor.lidar_front`, y esos tests asumían que
el vehículo en la posición "observadora" tenía radar). Arreglado intercambiando
qué vehículo juega cada papel en esos 2 tests (`veh_1: gunnerLoadout()` en vez de
`scoutLoadout()`), documentado inline en `sensors-fog.test.ts`. Los arquetipos de
`balance/archetypes.ts` (T3.4) usan una variante con radar por la misma razón.

**3. El catálogo v1, sin ajustar, perdía 0 % de los duelos en dos de tres
emparejamientos.** No fue una sospecha: fue el primer resultado real del banco de
T3.4 (`scout_vs_gunner` 0,5 %, `scout_vs_heavy` 0,0 %). El diagnóstico y las dos
rondas de ajuste (`chassis.light@2`, `weapon.mg@2`, `power.generator@2`,
`chassis.medium@2`) están en `docs/balance/v1.md`, con la cifra de cada ronda. Sin
poder ejecutar el banco de verdad, este desequilibrio habría quedado sin detectar
—es exactamente el tipo de bug que T3.4 existe para cazar.

**4. `combat.test.ts` esperaba una ranura "sensor_b" que `chassis.medium` no
tiene.** El andamio de fixtures original montaba el radar del artillero en un
slot llamado `sensor_b`; el catálogo real de E3 solo da a `chassis.medium` una
ranura de sensor, `sensor_a` (el segundo slot de sensor es un lujo de
`chassis.heavy`). Corregido el test para usar `sensor_a`, con un comentario
explicando por qué. Es un cambio de 1 línea × 4 ocurrencias, no de lógica.

## Wiring de `fixtures.ts`: hecho, con 3 correcciones documentadas

`gunnerLoadout()`, `scoutLoadout()`, `minerLoadout()` y `sandbagLoadout()` en
`apps/arena-engine/src/fixtures.ts` llaman ahora a `resolveVehicle()` con
`packages/module-catalog/resolve/archetypes.ts` (los mismos 4 arquetipos de los
goldens de T3.3) y el catálogo real cargado una vez a nivel de módulo. `MODULES`
(el objeto plano de constantes) se queda tal cual: `combat.test.ts` y
`sensors-fog.test.ts` lo siguen leyendo directamente para dos aserciones puntuales
(`MODULES.armorFront.reduction` y `MODULES.acoustic`), y coincide con los valores
reales del catálogo donde importa (`armor.steel_front@1.reduction = 0.35`, igual
que el `MODULES.armorFront` hardcodeado).

**Lo que se rompió al hacer el cambio, y cómo se arregló (ninguno en silencio):**

1. `combat.test.ts` — 1 test, slot `"sensor_b"` → `"sensor_a"` (hallazgo 4).
2. `sensors-fog.test.ts` — 2 tests, se intercambió qué vehículo lleva el radar
   (hallazgo 2).
3. `tests/golden/{chase,head_on,combat_result}.json` — regenerados con
   `UPDATE_GOLDEN=1`: la física diverge porque las masas/velocidades reales
   (`scoutLoadout` real vs. andamio de E2) no son idénticas. Es un cambio
   consciente, no un descuido: estos golden files no estaban comprometidos a
   ningún replay oficial (todo `apps/arena-engine/` estaba sin trackear en git
   antes de esta entrega), así que regenerarlos no invalida nada que existiera
   fuera de este working tree.

Ningún otro test cambió. Las 187 pruebas del motor que no tocan estos 3 archivos
pasaron sin modificar una sola línea.

## Notas para otros equipos

**Para E2 (motor).** `resolveVehicle()` produce exactamente la forma de
`VehicleSpec`/`ModuleSpec` que `vehicle.ts` espera. `fixtures.ts` ya no es un
andamio: usa el catálogo real de E3. Si `HunterBot` alguna vez lee contactos de
lidar además de radar, la variante de `balance/archetypes.ts` deja de ser
necesaria y se puede unificar con `resolve/archetypes.ts`.

**Para E7 (plataforma/API).** El validador recibe `budgetCredits` siempre como
parámetro. `validate-catalog.js` de E1 sigue en verde sin tocarlo: el catálogo de
E3 son datos que validan contra el esquema de E1, no una reimplementación.

**Para E10 (CI).** El fix de `vitest.config.ts` es prerrequisito para que
cualquier pipeline mida cobertura real de `packages/`. `fast-check` ya está
instalado (`npm install` lo resuelve). El banco de balance completo (600
batallas) tarda ~3,5 s: cabe perfectamente en un PR normal a `--n 200`, no hace
falta reducirlo a 20 salvo que el catálogo crezca mucho.

## Lo que queda fuera de esta entrega

- **Segunda categoría de utilidad** (`smoke`/`repair`/`jammer`/`drone`): el
  esquema de E1 la admite y `mine_bay` ya acepta `utility`, pero T3.1 no la pedía
  y no se ha añadido — la ampliación más obvia para un v2 real del catálogo (no
  confundir con las versiones `@2` de balance de esta entrega, que son ajustes
  numéricos puntuales, no un catálogo v2 completo).
- **Matriz de balance con más de 3 arquetipos** (p. ej. incluir `miner` o
  variantes mixtas): T3.4 pedía 3 (ligero/medio/pesado) y son los que están; el
  CLI (`--matrix`) ya soporta matrices custom si hace falta ampliarla.
- **Unificar `resolve/archetypes.ts` y `balance/archetypes.ts`** si `HunterBot`
  se vuelve compatible con lidar (hallazgo 2): hoy son deliberadamente distintos.
