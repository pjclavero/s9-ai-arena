# Equipamiento: catálogo, loadout y efecto en el motor

## Resumen

El equipamiento de un vehículo es su **loadout**: un chasis y un módulo por ranura, más la munición asociada a cada arma. Los módulos salen del catálogo versionado `mvp@1`, con **31 definiciones** en `packages/module-catalog/data/*.json`. El loadout se valida en servidor, se guarda como revisión del bot y, al empezar una batalla, `resolveVehicle()` lo convierte en la ficha (`VehicleSpec`) que simula el motor.

Este documento dice qué hace **de verdad** cada campo en el motor. Varios campos del catálogo **no tienen efecto** (alcance de armas y de radio, terreno, detectabilidad de minas…).

**Lo decisivo, auditado en FC-C:** en el **camino real** de batalla (`battle-run-http-launcher.ts:141-146,638`), del loadout del usuario **sólo viaja la familia del chasis**, traducida a un arquetipo fijo. Los módulos elegidos **no llegan a la simulación**.

La clasificación ACTIVE / PARTIAL / FUTURE de cada propiedad vive en código (`packages/module-catalog/effect-status.ts`). La UI la muestra y la tabla de [efecto real](#efecto-real-en-batalla-active--partial--future) la resume ([TD-016](../roadmap/technical-debt.md#td-016), [TD-002](../roadmap/technical-debt.md#td-002)).

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Chasis](#chasis)
- [Módulos por categoría](#módulos-por-categoría)
- [Daño y estado de módulos](#daño-y-estado-de-módulos)
- [Validación del loadout](#validación-del-loadout)
- [Efecto real en batalla (ACTIVE / PARTIAL / FUTURE)](#efecto-real-en-batalla-active--partial--future)
- [Campos sin efecto en el motor](#campos-sin-efecto-en-el-motor)
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
2. `POST /bots/{id}/loadouts` vuelve a validar en servidor contra el ruleset `mvp-default` (presupuesto 1000). Responde `422 loadout_invalid` con `violations` o `201` con una nueva revisión.
3. Cada versión de código fija una `loadout_revision`. En torneo, la inscripción congela la pareja código+loadout.
4. Al empezar la batalla, el worker lee el loadout y llama a `resolveVehicle(loadout, catalog)`, que produce el `VehicleSpec`. La masa total es la del chasis más la de los módulos.

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

**Sin efecto**: `terrain` (ni lo pasa `resolveVehicle` ni lo lee el motor).

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

**Sin efecto**: `peakEUs`.

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

**Sin efecto**: `fovRad` del radar (el radar es siempre de 360°) y `refreshEveryNDecisions`.

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
- la torreta gira a `turretRateRads × perf` hacia el objetivo;
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
- el destino puede ser uno concreto (`to`) o difusión.

**Sin efecto**:

- **`rangeM`**: `radioReaches()` existe pero no se llama.
- **Equipo**: una difusión **llega también al equipo rival** a cualquier distancia.
- **`encrypted`**.

Hallazgo nuevo de esta consolidación, comunicado a A como parte de [TD-016](../roadmap/technical-debt.md#td-016).

### Minas (`mine_bay`, sólo chasis medio y pesado)

`mine.explosive@1`: 3 cargas, daño 90, activación a 2.5 m, explosión de 6 m, armado en 30 ticks, cooldown 90, vida 5400 ticks y 8 EU por uso.

**Efecto real**:

- la mina se pone donde está el vehículo y el motor valida la acción: estado del módulo, cooldown, cargas, energía, máximo **3 minas activas por vehículo** y que la posición no sea sólida;
- el retardo de armado es el mayor entre el del módulo y el del comando (0–300);
- detona con un vehículo enemigo dentro del radio de activación (o cualquiera, con fuego amigo);
- caduca al cumplir `lifetimeTicks`.

**Sin efecto**: `detectable`. Toda mina es detectable por proximidad.

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

`incompatible_chassis`, `duplicate_slot`, `unknown_slot` (p. ej. `mine_bay` en un chasis ligero), `slot_type_mismatch`, `slot_size_exceeded`, `category_forbidden_by_ruleset`, `incompatible_ammo`, `duplicate_limit_exceeded` (`maxPerVehicle`), `mass_exceeded` (`maxLoadKg`), `energy_deficit`, `budget_exceeded` y `module_cost_cap_exceeded` (ningún módulo puede costar más del 35 % del presupuesto).

El presupuesto en servidor es el del ruleset `mvp-default` (1000), venga el loadout de donde venga (`services/bots.ts:134-160`).

## Efecto real en batalla (ACTIVE / PARTIAL / FUTURE)

Auditoría FC-C sobre `0b8c12b`. Fuente única: `packages/module-catalog/effect-status.ts`, que leen el `LoadoutEditor` (insignias) y esta documentación. El test `effect-status.test.ts` exige que **toda** propiedad de juego del catálogo esté clasificada.

**Qué llega del loadout al motor en el camino real:**

1. `resolveBot` (`battle-run-http-launcher.ts:627-641`) lee el loadout, pero sólo usa `loadout.chassis` → `archetypeForChassis` (`:141-146`):
   - `chassis.light` → `scout`;
   - `chassis.heavy` → `heavy`;
   - cualquier otro → `gunner`.
2. Se descarta la versión: `chassis.light@2` juega como `@1`. El arquetipo `miner` no se alcanza nunca.
3. El cuerpo de `/run` lleva `{botId, version, archetype, imageDigest}` por bot (`:617-622,712-719`): ningún módulo.
4. `container-battle.ts:134-141` simula el loadout **fijo** del arquetipo (`packages/module-catalog/resolve/archetypes.ts`).

El tournament-worker (`engine-executor.ts:172`) sí transporta el loadout completo, pero conduce los vehículos con stubs `HunterBot`, no con el código del usuario.

| Estado | Significado | Propiedades |
|---|---|---|
| **ACTIVE** | Lo que elige el usuario cambia la batalla real | **Sólo la familia del chasis** (decide el arquetipo) |
| **PARTIAL** | El motor la sabe usar, pero en batalla real cuenta el valor del arquetipo, sólo cuenta en validación o el efecto es incompleto | `chassis.hullHp/radiusM/maxLoadKg/slots`; `movement.maxSpeedMs/accelerationMs2/turnRateRads/ratedLoadKg`; `power.capacityEU/generationEUs`; `sensor.*` (proximity y acoustic nunca llegan); `weapon.damage/cooldownTicks/projectileSpeedMs/spreadRad/turretRateRads/acceptsAmmo/power.perActionEU`; `ammo.*` (`explosionRadiusM` sólo en `ammo.he`, que ningún arquetipo monta); `mine.*` (ningún arquetipo alcanzable monta minas); `armor.reduction/sector` (sólo el frontal); `radio.maxMessageBytes/maxMessagesPerSecond`; las comunes `massKg`, `hp`, `power.passiveEUs`, y `costCredits`/`size`/`maxPerVehicle` (sólo validación) |
| **FUTURE** | Ningún código de simulación la lee | `movement.terrain`; `weapon.rangeM` (el alcance lo da el TTL de 90 ticks, `combat.ts:198`); `weapon.turretArcRad` (todos los datos valen 2π: la comprobación nunca actúa); `radio.rangeM` (`radioReaches` sin llamadas, `sensors.ts:227`); `utility.effect/magnitude/durationTicks` |

**Seguirían sin efecto aunque se transportara el loadout completo** (hace falta cambiar el motor): `weapon.rangeM`, `radio.rangeM` (y la radio sin filtro de equipo), `turretArcRad` con los datos actuales, `ammo.hp` como pérdida de capacidad, `movement.terrain`, `maxLoadKg`/`maxPerVehicle`/`size`/`costCredits` y `utility.*`.

## Campos sin efecto en el motor

| Campo | Categoría | Motivo |
|---|---|---|
| `terrain` | movimiento | `resolveVehicle` no lo pasa |
| `peakEUs` | energía | no se pasa |
| `fovRad` | radar | el radar no lo lee |
| `refreshEveryNDecisions` | sensor | no se pasa |
| `rangeM` | arma | el alcance real lo da la vida del proyectil (90 ticks) |
| `rangeM` | radio | `radioReaches` no se llama |
| `encrypted` | radio | no se pasa |
| `detectable` | mina | fijado a `true` |
| `effect`, `magnitude`, `durationTicks` | utilidad | no se pasan; no hay módulos `utility` |
| `costCredits`, `size`, `maxPerVehicle`, `requiresChassis`, `maxLoadKg`, ranuras | todas | sólo el validador |

## Persistencia y API

- **Tablas**: `catalog_versions` y `module_definitions` (PK catálogo+id+versión). `bot_loadouts` con `UNIQUE(bot_id, revision)`. `loadout_modules` con FK `RESTRICT` a `module_definitions`, para que no se pueda borrar un módulo en uso.
- **Endpoints**:
  - `GET /catalog/versions` y `GET /catalog/{v}/modules` (anónimos);
  - `POST /catalog/versions` (`admin`);
  - `POST /bots/{id}/loadouts` (dueño);
  - `GET /bots/{id}/loadouts` (extensión, rol `user`).

## Estado actual

- **FUNCIONA ACTUALMENTE**: catálogo, validación en cliente y servidor, revisiones, resolución a `VehicleSpec`. En el camino real de batalla, la elección de **familia de chasis**. La UI marca el efecto real de cada ranura y propiedad, sin presentar como funcional lo que el motor ignora.
- **PARCIAL**: todo módulo elegido por el usuario. El motor sabe simularlo, pero el camino real juega el loadout fijo del arquetipo (tabla de [efecto real](#efecto-real-en-batalla-active--partial--future)).
- **PARCIAL**: radio (sin alcance ni filtro de equipo) y minas, proximidad y acústica (simuladas, pero inútiles con `HunterBot`).
- **PENDIENTE**: módulos `utility`, efecto de los campos de la tabla anterior y ejecución del código del bot para que el equipamiento de percepción y comunicación importe.

## Documentación relacionada

- Usuario: [Equipamiento](../user/equipment.md), [Bots](../user/bots.md)
- Técnica: [engine.md](engine.md), [bots.md](bots.md), [game-modes.md](game-modes.md)
- Balance: [docs/balance/v1.md](../balance/v1.md) (fuente de los valores y del diseño de arquetipos)
- Decisión fundacional (modelo de daño D6, presupuesto D7): [ADR-000](../adr/ADR-000-decisiones-fundacionales.md)
- Deuda: [TD-016](../roadmap/technical-debt.md#td-016), [TD-002](../roadmap/technical-debt.md#td-002)

## Verificación

Verificado contra `27f70bb`. Las filas FC-C, en la rama `fc/dev-c-maps-teams` (base `0b8c12b`).

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
| Radio sin alcance ni filtro de equipo | CODE_VERIFIED | `sensors.ts:192-194,227-232` (`radioReaches` sin llamadas); `apps/arena-engine/tests/radio-regression.test.ts:99-100` |
| Validación en servidor con `mvp-default` | CODE_VERIFIED | `apps/api/src/services/bots.ts:134-160` |
| `mine_bay` en chasis ligero → 422 `unknown_slot` | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 §B4 |
| `HunterBot` sólo usa radar, lidar y `turret_main` | CODE_VERIFIED | `apps/arena-engine/src/stubs.ts:50-100` |
| Camino real: del loadout sólo viaja la familia del chasis (arquetipo) | CODE_VERIFIED | `apps/api/src/services/battle-run-http-launcher.ts:141-146,617-622,638,712-719`; `apps/arena-engine/src/service.ts:124-125`; `apps/bot-manager/src/container-battle.ts:134-141` |
| Toda propiedad del catálogo clasificada ACTIVE/PARTIAL/FUTURE | CODE_VERIFIED / RUNTIME_VERIFIED | `packages/module-catalog/effect-status.ts`; `packages/module-catalog/effect-status.test.ts` (rc=0) |
| La UI muestra el efecto real (chasis ACTIVE, arma PARTIAL, `rangeM` FUTURE) | RUNTIME_VERIFIED | `apps/web/src/pages/LoadoutEditor.tsx` (`EffectBadge`); `tests/browser/specs/golden-path.spec.ts` (Chromium 1.48.2, fase golden de `npm run test:browser`, rc=0) |
