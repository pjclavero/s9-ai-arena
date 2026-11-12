# Equipamiento: catálogo, loadout y efecto en el motor

## Resumen

El equipamiento de un vehículo es su **loadout**: un chasis y un módulo por ranura, más la munición asociada a cada arma. Los módulos salen del catálogo versionado `mvp@1`, con **31 definiciones** en `packages/module-catalog/data/*.json`. El loadout se valida en servidor, se guarda como revisión del bot y, al empezar una batalla, `resolveVehicle()` lo convierte en la ficha (`VehicleSpec`) que simula el motor.

Este documento dice qué hace **de verdad** cada campo en el motor. Varios campos del catálogo **no tienen efecto** (alcance de armas y de radio, terreno, detectabilidad de minas…).

**Lo decisivo (UX-01, recalibrado):** las batallas las ejecuta el tournament-worker, y su `engine-executor` resuelve el loadout **persistido** de la versión (`bot_loadouts` de su `loadout_revision`, o la congelada en la inscripción de torneo) con `resolveVehicle` y lo simula tal cual, conducido por el código del bot (`containerAgents()`). La partida de humo del build juega también ese loadout (`apps/bot-manager/src/smoke-vehicle.ts`); el arquetipo fijo del chasis queda sólo como **reserva** y se dice en el log de la etapa. El camino antiguo API → arena-engine `/run` (`battle-run-http-launcher.ts`), que sólo enviaba la familia del chasis, ya no ejecuta batallas.

La clasificación ACTIVE / PARTIAL / FUTURE de cada propiedad vive en código (`packages/module-catalog/effect-status.ts`). La UI la muestra y la tabla de [efecto real](#efecto-real-en-batalla-active--partial--future) la resume ([TD-016](../roadmap/technical-debt.md#td-016), [TD-002](../roadmap/technical-debt.md#td-002)).

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Chasis](#chasis)
- [Módulos por categoría](#módulos-por-categoría)
- [Daño y estado de módulos](#daño-y-estado-de-módulos)
- [Validación del loadout](#validación-del-loadout)
- [Efecto real en batalla (ACTIVE / PARTIAL / FUTURE)](#efecto-real-en-batalla-active--partial--future)
- [Campos eliminados en la OLA 2 y campos sólo de validación](#campos-eliminados-en-la-ola-2-y-campos-sólo-de-validación)
- [Persistencia y API](#persistencia-y-api)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

- **Catálogo**: definiciones de módulo con `id`, `version`, `category`, `massKg`, `costCredits`, `hp`, `size` y campos propios de cada categoría (esquema en `packages/module-catalog/schema/module.schema.json`). Se importa a la BD (`catalog_versions`, `module_definitions`) con `seedContent` o `POST /catalog/versions` (rol `admin`).
- **Loadout**: `{catalogVersion, chassis, modules:[{slot, moduleId, ammo?}]}`. La munición va como propiedad del arma (`ammo`). `resolveVehicle` la materializa como módulo de categoría `ammo` en la bahía `ammo_main`.
- **Categorías**: `chassis, movement, power, sensor, weapon, ammo, mine, armor, radio, utility`. El catálogo `mvp@1` **no trae ningún módulo `utility`**.

## Cómo funciona

1. La web (`LoadoutEditor`) usa el validador compilado al navegador para mostrar coste, energía y violaciones en vivo.
2. `POST /bots/{id}/loadouts` vuelve a validar en servidor contra el ruleset `mvp-default` (presupuesto 1000). Responde `422 loadout_invalid` con `violations` o `201` con una nueva revisión. Las revisiones guardadas son inmutables: si una antigua ya no valida (p. ej. cañón con munición estándar), se conserva, pero crear, clonar, enviar a build o publicar una versión con ella responde `422 loadout_invalid`; el pipeline también la para en `structure`.
3. Cada versión de código fija una `loadout_revision`. En torneo, la inscripción congela la pareja código+loadout.
4. **Elegibilidad** (ELIG): ver [abajo](#elegibilidad-de-versiones-históricas).
5. Al empezar la batalla, el worker lee el loadout y llama a `resolveVehicle(loadout, catalog)`, que produce el `VehicleSpec`. La masa total es la del chasis más la de los módulos.

## Elegibilidad de versiones históricas

Publicada y elegible son conceptos distintos. Una versión `published`/`frozen` es inmutable (trigger `bot_version_immutable`) y se conserva con su loadout, su build, sus batallas y sus replays. Que pueda entrar en una competición **nueva** se **calcula** (no se guarda ni cambia su estado) en `apps/api/src/services/version-eligibility.ts`: loadout histórico exacto + su catálogo inmutable + validador actual (`validateLoadout`).

- Clases (`VIOLATION_CLASS`, exhaustiva por tipo): `functional` (`incompatible_ammo`, `slot_type_mismatch`, `slot_size_exceeded`, `incompatible_chassis`) y `malformed` (`unknown_slot`, `duplicate_slot`, JSON ilegible) **bloquean**; `balance` (`budget_exceeded`, `module_cost_cap_exceeded`, `mass_exceeded`, `energy_deficit`, `duplicate_limit_exceeded`, `category_forbidden_by_ruleset`) sólo avisa: si una competición lo exige, lo aplica su ruleset. Un código desconocido falla cerrado.
- Categorías del inventario: `VALID`, `INVALID_AMMO`, `MISSING_AMMO`, `ORPHAN_AMMO`, `OTHER_INVALID`, `UNKNOWN` (catálogo o revisión ausentes).
- Dónde se aplica: `POST /battles` (409 `bot_version_not_eligible`), inscripción y cierre de torneos (409 `bot_version_not_eligible` / `entries_not_eligible`), y el worker antes de lanzar (descalificación administrativa de una batalla agendada antes del fix). La UI lo muestra como «Publicada · No elegible» (deshabilitada, con motivo), a partir del campo `battleEligibility` de `GET /bots/{id}/versions`.
- Caché en memoria por (reglas, catálogo, huella del loadout); ambos son inmutables, así que no hay invalidación salvo despliegue (`ELIGIBILITY_RULES_VERSION`).
- Inventario: `GET /admin/bot-version-eligibility` (admin, transacción `READ ONLY`, acceso en el log estructurado) y `scripts/ops/eligibility-inventory.mjs` (`S9_API_URL`, token en `S9_ADMIN_TOKEN_FILE` 0600 o `--token-stdin`; `--summary` para agregados).

## Chasis

| Chasis | hullHp | radiusM | masa | maxLoadKg | coste | Ranuras |
|---|---|---|---|---|---|---|
| `chassis.light@1` | 180 | 1.2 | 700 | 1200 | 150 | drive M, power M, sensor_a M, turret_main M, ammo_main M, radio_a S, armor_front M, armor_left/right/rear S |
| `chassis.light@2` | 280 | 1.2 | 700 | 1200 | 190 | igual que light@1 |
| `chassis.medium@1` | 300 | 1.6 | 1400 | 1600 | 220 | drive L, power M, sensor_a M, turret_main L, ammo_main M, **mine_bay M**, radio_a S, armor_front L, resto M |
| `chassis.medium@2` | 350 | 1.6 | 1400 | 1600 | 240 | igual que medium@1 |
| `chassis.heavy@1` | 480 | 2.0 | 2600 | 2400 | 280 | drive XL, power L, sensor_a M, **sensor_b S**, turret_main XL, ammo_main L, mine_bay M, radio_a S, armor_front XL, resto L |

Efecto real en el motor:

- **`hullHp`**: la vida del vehículo; a 0, el vehículo muere.
- **`radiusM`**: el radio del cuerpo físico (bola de Rapier) y el desplazamiento de la boca del arma.
- **Masa total**: entra en la física (`setMass`) y en el factor de masa de la movilidad.
- **`maxLoadKg`, ranuras, `costCredits`**: sólo los usa el validador.

## Módulos por categoría

`perf` es el multiplicador de prestaciones según el estado del módulo: 1, 0.6, 0.25 o 0 ([ver abajo](#daño-y-estado-de-módulos)).

### Movilidad (`drive`)

| Módulo | vel. máx. | acel. | giro | ratedLoadKg | consumo pasivo |
|---|---|---|---|---|---|
| `movement.wheels@1` | 13 m/s | 9 | 1.8 rad/s | 1600 | 1.5 EU/s |
| `movement.tracks@1` | 9 m/s | 6 | 1.2 rad/s | 2600 | 2 EU/s |

**Efecto real**:

- velocidad, aceleración y giro × `perf` × factor de masa (`masa/ratedLoadKg`; si es >1 se aplica la inversa, con suelo 0.4);
- con varios módulos de movilidad manda el mejor; no se suman;
- sin movilidad operativa, el vehículo queda inmóvil, pero la torreta sigue funcionando.

`terrain` se **eliminó** del esquema en la OLA 2 (P-2): el mapa no tiene tipos de terreno.

### Energía (`power`)

| Módulo | capacidad | generación |
|---|---|---|
| `power.battery@1` | 500 EU | 8 EU/s |
| `power.generator@1` | 150 EU | 22 EU/s |
| `power.generator@2` | 150 EU | 30 EU/s |

**Efecto real**:

- la capacidad es la suma de todos los módulos de energía;
- la generación es la suma de cada `generationEUs × perf`;
- cada tick se suma (generación − consumo pasivo) y la reserva se acota entre 0 y la capacidad;
- los módulos apagados no consumen;
- disparar y poner minas gasta `perActionEU`; si no hay energía, la acción se rechaza (`no_energy`).

`peakEUs` se **eliminó** en la OLA 2 (no hay modelo de potencia de pico).

### Sensores (`sensor_a`, `sensor_b`)

| Módulo | Tipo | Alcance | Otros |
|---|---|---|---|
| `sensor.radar@1` | radar | 50 m | `errorM` 2 |
| `sensor.lidar360@1` | lidar | 40 m | 360°, 48 rayos, máx. 1 por vehículo |
| `sensor.lidar_front@1` | lidar | 45 m | 90°, 16 rayos |
| `sensor.proximity@1` | proximidad | 15 m | — |
| `sensor.acoustic@1` | acústico | 60 m | — |

**Efecto real** (`sensors.ts`). El alcance efectivo es `rangeM × perf`. Un sensor crítico puede no dar lectura en un ciclo.

- **Radar**:
  - detecta vehículos vivos con línea de visión (los muros lo bloquean) a 360°;
  - la posición lleva un error aleatorio de `±errorM/perf` en cada eje;
  - el `entityId` sólo aparece por debajo de la mitad del alcance;
  - el equipo sólo se revela si es aliado (IFF).
- **Lidar**: rayos en el cono `fovRad` con distancia y tipo de impacto. Dañado, usa la mitad de rayos.
- **Proximidad**: rumbos de vehículos y minas dentro del alcance, **sin comprobar línea de visión**.
- **Acústico**: rumbo, tipo e intensidad de disparos, motores y explosiones del ciclo anterior. Nunca da posición.

El esquema es condicional por `sensorType` (OLA 2): `fovRad` y `rays` sólo se admiten (y son obligatorios) en lidar; `errorM`, sólo en radar. `refreshEveryNDecisions` se **eliminó** (exigiría observación en caché por sensor dentro del hash, sin diseño en los contratos).

### Armas (`turret_main`) y munición (`ammo_main`)

| Arma | daño | cooldown | vel. proyectil | dispersión | EU/disparo | munición |
|---|---|---|---|---|---|---|
| `weapon.cannon@1` | 45 | 30 ticks | 120 m/s | 0.01 rad | 12 | ap, he |
| `weapon.mg@1` | 12 | 6 ticks | 200 m/s | 0.05 rad | 3 | standard |
| `weapon.mg@2` | 18 | 5 ticks | 200 m/s | 0.05 rad | 2.5 | standard |

| Munición | cargas | × daño | radio de explosión |
|---|---|---|---|
| `ammo.standard@1` | 300 | 1.0 | 0 |
| `ammo.ap@1` | 40 | 1.2 | 0 |
| `ammo.he@1` | 30 | 0.9 | 5 m |

**Efecto real** (`combat.ts`):

- el disparo es una intención; el motor lo rechaza si el módulo está destruido o apagado, por fallo crítico, por cooldown, sin munición, sin energía o fuera de arco;
- daño = `damage × damageMultiplier × perf`;
- el cooldown se divide por `perf` (con mínimo 0.25);
- la dispersión sale del RNG del motor;
- la torreta gira a `turretRateRads × perf` hacia el objetivo, donde `turretRateRads` (y `turretArcRad`) son de la **montura de la ranura del chasis** (`slots[].mount`, leída con `Vehicle.mountOf(slot)`), no del arma: dos armas en la misma ranura giran igual (OLA2-MB, D-B2);
- el proyectil vive **90 ticks** e impacta por *raycast*;
- con radio de explosión, el daño cae linealmente con la distancia y la explosión no atraviesa muros;
- sin fuego amigo, el proyectil atraviesa a los aliados.

**Sin efecto**: `rangeM` del arma. El alcance lo da la vida del proyectil: unos 360 m para el cañón y 600 m para la ametralladora, más que la arena de 120×80 m.

### Blindaje (`armor_front/left/right/rear`)

Acero (`steel_*`): reducción 0.35 frontal, 0.25 lateral y 0.20 trasera; más pesado y más barato. Compuesto (`composite_*`): reducción 0.28, 0.20 y 0.16; más ligero y más caro.

**Efecto real**:

- el sector se calcula con el ángulo del impacto respecto al morro: ±45° frontal, ±135° trasero, el resto lateral;
- daño efectivo = `max(0.1·base, base·(1−reducción))`;
- el blindaje se desgasta con lo que absorbe y, a 0 de vida, deja de reducir;
- la vida del blindaje no cuenta como módulo dañable.

### Radio (`radio_a`)

`radio.short@1`: `rangeM` 80, 32 bytes por mensaje, 2 mensajes/s y 1 EU/s de consumo pasivo.

**Efecto real**:

- el mensaje es base64 opaco, con un tope de `min(maxMessageBytes, 32)` bytes;
- se limita a `maxMessagesPerSecond` por vehículo;
- se entrega con 1 ciclo de decisión de retraso;
- el destino puede ser uno concreto (`to`) o difusión;
- sólo la reciben los vehículos del **mismo equipo** que el emisor (`radioDeliverableTo`, `sensors.ts`), según el equipo del estado de batalla; el emisor no se oye a sí mismo, y un `to` a un rival o a un id inexistente no se entrega a nadie.
- el replay sí guarda la radio de los dos bandos (son comandos grabados): tras la batalla la ve quien pueda leer el replay, un participante incluido ([replays.md](replays.md#autorización-de-acceso-td-004)).

- **alcance real** (OLA 2, P-2): al emitir, el motor fija en el mensaje la posición del emisor y su alcance efectivo `rangeM × perf` (`radioRangeOf`); en la entrega sólo lo reciben los compañeros que estén dentro de ese círculo (`radioDeliverableTo`). Fuera de alcance el mensaje no llega y el emisor no recibe aviso.

`encrypted` se **eliminó** en la OLA 2: sin escucha enemiga (RADIO_SCOPE=TEAM) no tiene sentido.

Hallazgo nuevo de esta consolidación, comunicado a A como parte de [TD-016](../roadmap/technical-debt.md#td-016).

### Minas (`mine_bay`, sólo chasis medio y pesado)

`mine.explosive@1`: 3 cargas, daño 90, activación a 2.5 m, explosión de 6 m, armado en 30 ticks, cooldown 90, vida 5400 ticks y 8 EU por uso.

**Efecto real**:

- la mina se pone donde está el vehículo y el motor valida la acción: estado del módulo, cooldown, cargas, energía, máximo **3 minas activas por vehículo** y que la posición no sea sólida;
- el retardo de armado es el mayor entre el del módulo y el del comando (0–300);
- detona con un vehículo enemigo dentro del radio de activación (o cualquiera, con fuego amigo);
- caduca al cumplir `lifetimeTicks`.

`detectable` se **eliminó** en la OLA 2 (nunca se copiaba). Toda mina es detectable por proximidad; la firma por canal de un deployable (`DeployableVisibilityDef.signature`) lo sustituirá con su consumidor.

## Daño y estado de módulos

- **Reparto**: el 70 % del daño efectivo va al chasis y el 30 % a **un módulo no blindaje**, elegido por sorteo del RNG ponderado por masa (no se limita al sector del impacto).
- **Estados por salud del módulo**:

  | Estado | Umbral de salud | `perf` |
  |---|---|---|
  | `operational` | ≥ 66 % | 1 |
  | `damaged` | 33 % – 66 % | 0.6 |
  | `critical` | < 33 % | 0.25; falla el 35 % de los ciclos |
  | `destroyed` | 0 | 0 |

- **Apagado voluntario**: un módulo `offline` se apaga al instante y tarda 15 ticks en poder encenderse.
- **Respawn**: restaura la salud de todos los módulos y del blindaje, la munición y las cargas.

## Validación del loadout

Códigos de violación del validador (`packages/module-catalog/validator/index.ts`):

`incompatible_chassis`, `duplicate_slot`, `unknown_slot` (p. ej. `mine_bay` en un chasis ligero), `slot_type_mismatch`, `slot_size_exceeded`, `category_forbidden_by_ruleset`, `incompatible_ammo` (regla arma ↔ munición igual que `combat.ammoFor`: todo arma con `acceptsAmmo` necesita al menos una munición montada de un tipo base que acepte, tanto embebida en el arma (`ammo:`) como montada como módulo aparte; la munición embebida la tiene que admitir su arma; un módulo de munición que ningún arma usa también se rechaza; la violación trae `ammoId` y `acceptedAmmo`), `duplicate_limit_exceeded` (`maxPerVehicle`), `mass_exceeded` (`maxLoadKg`), `energy_deficit`, `budget_exceeded` y `module_cost_cap_exceeded` (ningún módulo puede costar más del 35 % del presupuesto).

El presupuesto en servidor es el del ruleset `mvp-default` (1000), venga el loadout de donde venga (`services/bots.ts:134-160`).

## Efecto real en batalla (ACTIVE / PARTIAL / FUTURE)

Recalibrado en UX-01 (la auditoría FC-C sobre `0b8c12b` (octubre de 2026) se midió en el camino `/run`, que ya no ejecuta batallas). Fuente única: `packages/module-catalog/effect-status.ts`, que leen el `LoadoutEditor` (insignias) y esta documentación. El test `effect-status.test.ts` exige que **toda** propiedad de juego del catálogo esté clasificada.

**Qué llega del loadout al motor:**

1. `engine-executor.ts:193-227` toma la `loadout_revision` de la inscripción del torneo (congelada) o, fuera de torneo, la de la versión; lee esa fila de `bot_loadouts` y la resuelve con `resolveVehicle(loadout, catalog)`. Si la revisión no existe, la batalla falla con ese motivo; no se inventa un vehículo.
2. Chasis **con su versión** y todos los módulos elegidos llegan a la simulación. Demostrado de extremo a extremo (loadout persistido = WELCOME del bot = vehículo simulado) en `apps/tournament-worker/src/ux01-loadout-welcome.test.ts`.
3. Partida de humo del build: `smokeVehicle()` (`apps/bot-manager/src/smoke-vehicle.ts`) juega el mismo loadout. Sólo si la versión no trae loadout o es de otra versión de catálogo, juega el arquetipo del chasis (`light→scout`, `heavy→heavy`, resto `gunner`) y lo dice en el log.

| Estado | Significado | Propiedades |
|---|---|---|
| **ACTIVE** | Lo que elige el usuario cambia la batalla | El chasis elegido (con versión); `chassis.hullHp/radiusM/slots`; `movement.maxSpeedMs/accelerationMs2/turnRateRads/ratedLoadKg`; `power.capacityEU/generationEUs`; `sensor.*` (lidar, radar, proximidad y acústico); `weapon.damage/cooldownTicks/projectileSpeedMs/rangeM/spreadRad/acceptsAmmo/power.perActionEU`; `chassis.slots[].mount.turretRateRads/turretArcRad` (montura de la ranura, D-B2); `armor.hp` (hp del módulo de blindaje, fuente única); `ammo.*`; `mine.*` (si el bot despliega la mina con `deployMine`); `armor.reduction/sector`; `radio.rangeM/maxMessageBytes/maxMessagesPerSecond`; las comunes `massKg`, `hp`, `power.passiveEUs` |
| **PARTIAL** | Sólo cuenta para validar el loadout | `chassis.maxLoadKg`; las comunes `costCredits`, `size`, `maxPerVehicle` |
| **FUTURE** | Ningún código de simulación la lee | Ninguna propiedad del catálogo (OLA 2). La categoría `utility` no tiene campos propios ni piezas; el comando `utility` no hace nada |

**Gate CATALOG_CONTRACT (OLA 2).** `packages/module-catalog/field-status.ts` clasifica cada campo del esquema (ACTIVE / VALIDATION_ONLY / FUTURE / REMOVE) con su consumidor y una mutación; `catalog-contract.test.ts` lo demuestra con una batalla de sonda (`catalog-probe.ts`) que pasa por `resolveVehicle`: un campo ACTIVE mutado tiene que cambiar la batalla, uno VALIDATION_ONLY tiene que cambiar el veredicto del validador y no la batalla. Un campo declarado sin consumidor pone el gate en rojo.

**`weapon.rangeM` es el alcance real** (OLA 2, P-2): `resolveVehicle` lo convierte en la vida del proyectil, `rangeM · TICK_HZ / projectileSpeedMs` ticks (entero, o el loadout no resuelve). Los datos se fijaron al alcance que ya tenían con el TTL fijo de 90 ticks (cañón 360 m, ametralladoras 600 m): mismo comportamiento, caracterizado en `range-characterization.test.ts`. Hay una sola regla: una spec sin `rangeM`/velocidad o con una vida incoherente no se simula (fail-closed); la regla heredada de 90 ticks se eliminó y los replays anteriores al contrato (0.2.0/0.3.0/0.4.0 previos) dejaron de reproducirse (integración OLA 2).

## Campos eliminados en la OLA 2 y campos sólo de validación

| Campo | Categoría | Decisión (OLA 2) |
|---|---|---|
| `terrain` | movimiento | REMOVE (P-2) |
| `peakEUs` | energía | REMOVE |
| `refreshEveryNDecisions` | sensor | REMOVE |
| `encrypted` | radio | REMOVE |
| `detectable` | mina | REMOVE (lo sustituirá `DeployableVisibilityDef.signature`) |
| `effect`, `magnitude`, `durationTicks`, `charges`, `cooldownTicks` | utilidad | REMOVE (lo sustituirá `actions`) |
| `slots[].offsetM` | chasis | REMOVE (sin datos ni consumidor) |
| `costCredits`, `size`, `maxPerVehicle`, `requiresChassis`, `maxLoadKg`, ranuras | todas | VALIDATION_ONLY: sólo el validador |

Los bloques v2 (`actions`, efectos, deployables, guidance) se validan y resuelven en `packages/module-catalog/v2/` y sólo existen como fixtures `test.fixture_*` (`test-fixtures/`): el esquema de módulo no los admite hasta que el motor los consuma.

## Persistencia y API

- **Tablas**: `catalog_versions` y `module_definitions` (PK catálogo+id+versión). `bot_loadouts` con `UNIQUE(bot_id, revision)`. `loadout_modules` con FK `RESTRICT` a `module_definitions`, para que no se pueda borrar un módulo en uso.
- **Endpoints**:
  - `GET /catalog/versions` y `GET /catalog/{v}/modules` (anónimos);
  - `POST /catalog/versions` (`admin`);
  - `POST /bots/{id}/loadouts` (dueño);
  - `GET /bots/{id}/loadouts` (extensión, rol `user`).

## Estado actual

- **FUNCIONA ACTUALMENTE**: catálogo, validación en cliente y servidor, revisiones, resolución a `VehicleSpec`. La batalla y la partida de humo del build juegan el **loadout real** de la versión. La UI marca el efecto real de cada ranura y propiedad, sin presentar como funcional lo que el motor ignora, y enseña la carga de módulos frente a `maxLoadKg`.
- **PARCIAL**: radio (sin alcance; sí limitada al propio equipo).
- **PENDIENTE**: módulos `utility` y efecto de los campos FUTURE de la tabla anterior.

## Documentación relacionada

- Usuario: [Equipamiento](../user/equipment.md), [Bots](../user/bots.md)
- Técnica: [engine.md](engine.md), [bots.md](bots.md), [game-modes.md](game-modes.md)
- Balance: [docs/balance/v1.md](../balance/v1.md) (fuente de los valores y del diseño de arquetipos)
- Decisión fundacional (modelo de daño D6, presupuesto D7): [ADR-000](../adr/ADR-000-decisiones-fundacionales.md)
- Deuda: [TD-016](../roadmap/technical-debt.md#td-016), [TD-002](../roadmap/technical-debt.md#td-002)

## Verificación

Verificado contra `27f70bb`; las filas del loadout real, contra `integration/ux-acceptance` (ronda UX-R). Las filas FC-C, la integración del cierre funcional (`integration/functional-closure`) (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| 31 módulos, valores de la tabla | CODE_VERIFIED | `packages/module-catalog/data/*.json` (volcado con un script de lectura) |
| Campos que pasa `resolveVehicle` | CODE_VERIFIED | `packages/module-catalog/resolve/index.ts:15-70` |
| Movilidad: mejor módulo, factor de masa, suelo 0.4 | CODE_VERIFIED | `apps/arena-engine/src/sim/vehicle.ts:254-279`; `packages/game-rules/constants.ts:80` |
| Energía: suma, generación × perf, pasivo | CODE_VERIFIED | `vehicle.ts:213-247` |
| Sensores: radar con LOS, error e IFF; lidar; proximidad; acústico | CODE_VERIFIED | `apps/arena-engine/src/sim/sensors.ts:91-187` |
| Rechazos de disparo, daño y cooldown del arma | CODE_VERIFIED | `apps/arena-engine/src/sim/combat.ts:130-200` |
| Proyectil de 90 ticks; el `rangeM` del arma no se lee | CODE_VERIFIED | `combat.ts:198`; búsqueda de `rangeM` (sólo `sensors.ts`) |
| Daño D6: suelo 10 %, 70/30, sorteo por masa | CODE_VERIFIED | `combat.ts:75-120`; `packages/game-rules/constants.ts:40-42` |
| Estados de módulo y rendimientos | CODE_VERIFIED | `packages/game-rules/constants.ts:47-66`; `packages/game-rules/index.ts:42-49` |
| Minas: máximo 3, `detectable` fijo | CODE_VERIFIED | `apps/arena-engine/src/sim/battle.ts:37,536-560`; `combat.ts:209-260` |
| Radio sin alcance (`radioReaches` sin llamadas) | CODE_VERIFIED | `sensors.ts` (`radioReaches`) |
| Radio limitada al propio equipo | CODE_VERIFIED | `sensors.ts` (`radioDeliverableTo`); `apps/arena-engine/tests/radio-team-isolation.test.ts` |
| Validación en servidor con `mvp-default` | CODE_VERIFIED | `apps/api/src/services/bots.ts:134-160` |
| `mine_bay` en chasis ligero → 422 `unknown_slot` | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 §B4 |
| `HunterBot` sólo usa radar, lidar y `turret_main` | CODE_VERIFIED | `apps/arena-engine/src/stubs.ts:50-100` |
| La batalla juega el loadout persistido de la versión (no el arquetipo) | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:193-227`; `apps/tournament-worker/src/ux01-loadout-welcome.test.ts` (rc=0, ronda UX-R) |
| La partida de humo juega el mismo loadout; el arquetipo es reserva declarada en el log | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/bot-manager/src/smoke-vehicle.ts`; `apps/bot-manager/tests/smoke-vehicle.test.ts` (rc=0, ronda UX-R) |
| Toda propiedad del catálogo clasificada ACTIVE/PARTIAL/FUTURE | CODE_VERIFIED / RUNTIME_VERIFIED | `packages/module-catalog/effect-status.ts`; `packages/module-catalog/effect-status.test.ts` (rc=0) |
| La UI muestra el efecto real (chasis y arma ACTIVE, `rangeM` FUTURE) | RUNTIME_VERIFIED | `apps/web/src/pages/LoadoutEditor.tsx` (`EffectBadge`); `tests/browser/specs/golden-path.spec.ts` (Chromium 1.48.2, fase golden de `npm run test:browser`, rc=0) |
