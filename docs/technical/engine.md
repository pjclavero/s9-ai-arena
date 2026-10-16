# Motor de simulación 2D

## Resumen

`apps/arena-engine` es un motor 2D cenital y **determinista**:

- física Rapier2D (`@dimforge/rapier2d-compat` 0.19.3, con el WASM fijado por sha256);
- 30 ticks/s y decisiones de bot a 10 Hz;
- PRNG propio (xoshiro128**);
- reglas como datos (`packages/game-rules`).

Una batalla se define por su semilla, ruleset, mapa y participantes, más los comandos de los bots. Con eso se reproduce bit a bit. Esa propiedad es la base de los replays y de su verificación ([replays.md](replays.md)).

El motor no tiene servicio propio en el camino activo: lo ejecuta **dentro de su proceso** el `tournament-worker` ([battles.md](battles.md)), que también aloja el `ProtocolServer` (protocolo arena/1) al que se conectan los contenedores de los bots. El servicio HTTP `POST /run` (`service.ts`) es un camino **legado** que la API ya no usa. `ProtocolServer.connectedVehicleIds()` (nuevo) permite al worker distinguir «ningún bot conectó» (infraestructura) de «uno no conectó» (derrota deportiva).

## Índice

- [Arquitectura](#arquitectura)
- [Entidades](#entidades)
- [El bucle de un tick](#el-bucle-de-un-tick)
- [Movimiento y colisión](#movimiento-y-colisión)
- [Daño](#daño)
- [Sensores y niebla de guerra](#sensores-y-niebla-de-guerra)
- [Observaciones y comandos](#observaciones-y-comandos)
- [Determinismo](#determinismo)
- [Replay, snapshot y hash](#replay-snapshot-y-hash)
- [Herramientas](#herramientas)
- [Tests](#tests)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Arquitectura

| Fichero | Contenido |
|---|---|
| `src/sim/battle.ts` | `Battle`: creación, `step()` (9 pasos), combate, snapshots, hash, resultado |
| `src/sim/physics.ts` | `PhysicsWorld` sobre Rapier, *raycast*, línea de visión, punto dentro de sólido |
| `src/sim/vehicle.ts` | Estado de un vehículo: salud, módulos, energía, armadura, respawn |
| `src/sim/combat.ts` | Disparo, proyectiles, minas, explosiones, modelo de daño |
| `src/sim/sensors.ts` | Construcción de observaciones (único sitio), radio |
| `src/sim/modes.ts` | Modos de juego y registro de compatibilidad ([game-modes.md](game-modes.md)) |
| `src/rng.ts` | PRNG determinista |
| `src/replay.ts` | Formato JSONL, `record`, `verify`, `resimulateWithEvents` |
| `src/match.ts` | `MatchRunner` (varias rondas); no lo usa la plataforma |
| `src/checkpoint.ts` | Guardado y restauración del estado de una batalla (R13.5) |
| `src/inspector.ts`, `src/cli.ts` | Inspector HTTP de sólo lectura y CLI |
| `src/protocol-server.ts`, `src/service.ts` | Protocolo `arena/1` con bots externos y servicio `POST /run` |
| `src/stubs.ts` | Bots internos deterministas (`HunterBot`, `SeekBot`…). **Sólo tests/demo**: el worker de producción no los usa |
| `src/engine-deps.json` | Versión del motor, versión de Rapier y sha256 del WASM, protocolo |

Constantes globales (`packages/game-rules/constants.ts`):

| Constante | Valor |
|---|---|
| Arena MVP | 120×80 m (`PIXELS_PER_METER` 10, sólo para dibujar) |
| `TICK_HZ` | 30 |
| `DECISION_HZ` | 10 (cada 3 ticks) |
| `DECISION_DEADLINE_MS` | 80 |
| `MAX_CONSECUTIVE_TIMEOUTS` | 20 |
| Protocolo | `arena/1`, codificación JSON |

## Entidades

| Entidad | Representación |
|---|---|
| Vehículo | Cuerpo dinámico de Rapier, una **bola** de radio `radiusM` con masa total |
| Muro | Collider fijo **cuboide** (caja); los polígonos llegan aproximados por su caja ([maps.md](maps.md#conversión-al-motor)) |
| Destructible | Cuboide con vida; se elimina al llegar a 0 |
| Proyectil | Lista propia; se mueve con *raycast* por tick, vive 90 ticks |
| Mina | Lista propia; armado, activación por radio y caducidad |
| Zona | Círculo `damage` (daño por segundo directo al chasis, sin blindaje) o `capture` (objetivo de modo) |
| Base y bandera | Círculo y punto (CTF) |

## El bucle de un tick

`Battle.step()` sigue siempre los mismos 9 pasos (`battle.ts:219-504`):

1. **Comandos**. Sólo en tick de decisión. Se construye la observación de cada bot, se le entregan sus eventos y se llama a `decide()`.
2. **Acción segura**. Si un bot no responde (`null`), repite su último movimiento sin disparar. Tras 20 *timeouts* seguidos queda descalificado.
3. **Validación y aplicación**:
   - energía del tick;
   - movimiento, con el *throttle* y el giro saneados a [-1, 1];
   - objetivo de torreta;
   - encendido y apagado de módulos;
   - radio, con límite de ritmo y de cola.
4. **Física**. Se conduce cada vehículo con los límites de su movilidad, gira la torreta y Rapier avanza un paso.
5. **Combate**: disparos, proyectiles, minas y daño de zonas.
6. **Reglas del modo**: banderas, zonas y puntuación.
7. **Respawn**, si el ruleset lo permite, tras `delayTicks`.
8. **Snapshot público** (cada 3 ticks por defecto) y **hash de estado** (cada 30 ticks o `hashEveryNTicks`).
9. **Condición de fin** (`mode.winner`). La CLI y `run()` cortan en 100 000 ticks como techo.

## Movimiento y colisión

- **Mundo**: gravedad nula y unidades SI (metros, radianes, kg).
- **Movilidad**: velocidad máxima, aceleración y giro salen del mejor módulo de movilidad operativo, degradados por estado y por exceso de masa ([equipment.md](equipment.md#movilidad-drive)).
- **Colisiones**: entre vehículos y estáticos las resuelve Rapier.
- **Proyectiles e impactos**: usan `castRay`, que excluye al propio emisor.
- **Línea de visión**: radar y explosiones usan `hasLineOfSight`; los muros bloquean.
- **Minas**: `isPointInsideSolid` impide ponerlas dentro de un muro o destructible.

## Daño

Única puerta: `applyDamage` (`combat.ts:75-120`). Es el modelo D6 del [ADR-000](../adr/ADR-000-decisiones-fundacionales.md):

1. Se calcula el **sector** del impacto respecto al morro.
2. Se aplica la reducción del blindaje de ese sector, con un suelo del 10 %. El blindaje se desgasta con lo que absorbe.
3. El 70 % va al chasis y el 30 % a un módulo no blindaje, elegido por sorteo del RNG ponderado por masa.
4. Los módulos degradan su rendimiento por estado: `damaged` 0.6, `critical` 0.25 con un 35 % de fallo y `destroyed` 0.

El fuego amigo se filtra en proyectiles, explosiones y minas si el ruleset lo desactiva.

## Sensores y niebla de guerra

Regla D8: la observación de un bot contiene **sólo** lo que perciben sus sensores operativos, además de su propio estado. Sin sensores, no aparece la clave `sensors`. Detalle por tipo en [equipment.md](equipment.md#sensores-sensor_a-sensor_b).

El snapshot público para espectadores es otro objeto, con su propia lista cerrada de campos (`battle.ts:749-778`):

- por vehículo: id, equipo, vivo, posición, rumbo, torreta, vida, bandera portada, marca de juggernaut y estado de cada módulo;
- los proyectiles;
- marcador y objetivos.

**Las minas no aparecen** hasta que explotan. La cubre el test de fugas `sensors-fog.test.ts`.

Limitación conocida: la radio no aplica alcance ni filtra por equipo ([equipment.md](equipment.md#radio-radio_a), [TD-016](../roadmap/technical-debt.md#td-016)).

## Observaciones y comandos

Esquemas JSON en `packages/protocol/schemas/*.schema.json` (`hello`, `welcome`, `observation`, `command`, `event`, `shutdown`, `envelope`).

- **Observación** (`buildObservation`):
  - `tick`;
  - `self`: posición, rumbo, velocidades, torreta, vida, energía (reserva, capacidad y flujo neto), módulos con estado, salud, cooldown y munición, armadura por sector, bandera portada y respawn pendiente;
  - `sensors`: `lidar`, `radar`, `proximity` y `acoustic`;
  - `radio`;
  - `score` y `objectives`, que son públicos.
- **Comando**:
  - `move:{throttle, steer}`;
  - `turret:{targetHeading | targetPoint}`;
  - `fire:[slot…]`;
  - `modules:[{slot, enabled}]`;
  - `radio:[{slot, data(base64), to?}]`;
  - `deployMine:{slot, armDelayTicks}`.

  Todo valor recibido se sanea: un `NaN`, un `Infinity` o un texto no mueven nada.
- **Rechazos**: `canFire` y `canDeployMine` devuelven el motivo (`cooldown`, `no_ammo`, `no_energy`, `out_of_arc`, `critical_failure`, `limit_exceeded`…). El bot lo recibe como evento `rejected_action`.

## Determinismo

- `Math.random` está prohibido en `src/sim/` (`scripts/lint-determinism.mjs`). Toda aleatoriedad pasa por `Rng(seed)`: dispersión, error de radar, sorteo de módulo dañado y fallos críticos.
- Rapier se verifica al arrancar: si el sha256 del WASM no coincide con `engine-deps.json`, **el motor no arranca**.
- Las observaciones y los snapshots se redondean a 6 decimales.
- En el worker, la semilla es `battles.seed` o, si falta, el propio `battleId`. En torneo se deriva del lote de semillas revelado ([tournaments.md](tournaments.md)).
- Latencia simulada opcional (`simulatedLatency`, desactivada por defecto). Sólo consume RNG si se activa.

## Replay, snapshot y hash

- **Replay** (`replay.ts`): JSONL con `header` (semilla, ruleset completo, mapa, participantes y versiones), `cmd`, `evt`, `snap`, `hash` y `result`. La verdad es la cabecera más los comandos; eventos y snapshots son redundantes y sirven al visor.
- **Verificación**: `verify(replay)` re-simula con `ReplayAgent` (reproduce los comandos grabados) y compara los hashes de estado y el `finalStateHash`. Si diverge, informa del tick.
- **Estadísticas**: `resimulateWithEvents` regenera los eventos privados para el cálculo de estadísticas.

Almacén, índice y API: [replays.md](replays.md).

## Herramientas

- **CLI** (`src/cli.ts`): `arena-engine run --seed <s> [--ruleset id] [--map mvp|ctf|empty] [--ticks N]`, `arena-engine verify <replay.jsonl>` y `arena-engine deps`. Las órdenes de desarrollo están en [testing.md](../development/testing.md).
- **Inspector** (R13.1): HTTP de sólo lectura sobre el snapshot público. Escucha en *loopback* por defecto; exponerlo exige `--inspect-allow-remote`. No tiene autenticación, por diseño.
- **Checkpoint** (R13.5): `saveCheckpoint`/`restoreCheckpoint` para reanudar una batalla. Sin uso en la plataforma.

## Tests

`apps/arena-engine/tests/` incluye:

- determinismo y replays *golden*: `determinism*.test.ts`, `replay-golden.test.ts`;
- niebla: `sensors-fog.test.ts`;
- candados de regresión R13 de radio, acústica y munición;
- modos: `modes.test.ts`, `modes-r38.test.ts`;
- robustez frente a valores basura;
- fijación de dependencias: `deps-pin.test.ts`.

El catálogo de candados está en el histórico `ENGINE_REGRESSION_LOCKS`; ver [testing.md](../development/testing.md) y [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md).

## Estado actual

- **FUNCIONA ACTUALMENTE**: simulación determinista, 7 modos, replays verificables y estadísticas por re-simulación.
- **PARCIAL**: radio (sin alcance ni equipo) y campos del catálogo sin efecto ([equipment.md](equipment.md#campos-sin-efecto-en-el-motor)). En la plataforma los vehículos los conduce el código de cada bot en su contenedor; la activación en producción está pendiente ([TD-002](../roadmap/technical-debt.md#td-002)). Ojo: `BattleResult.disqualified` lista **vehículos** (`veh_N`), no bots; el worker los traduce. `MatchRunner` y `checkpoint` no se usan.
- **PENDIENTE**: ejecución de bots reales por `protocol-server` dentro de la plataforma (camino `/run`, apagado).

## Documentación relacionada

- Técnica: [game-modes.md](game-modes.md), [equipment.md](equipment.md), [battles.md](battles.md), [replays.md](replays.md), [bots.md](bots.md)
- Decisiones: [ADR-000](../adr/ADR-000-decisiones-fundacionales.md)
- Desarrollo (C): [testing.md](../development/testing.md)
- Histórico absorbido: R13 (calidad de runtime, inspector, hardening, *save sharding*) y candados de regresión (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| Rapier 0.19.3 fijado por sha256; el motor no arranca si no coincide | CODE_VERIFIED | `apps/arena-engine/src/engine-deps.json`; `src/sim/physics.ts:23-45` |
| 30 Hz, decisión cada 3 ticks, 20 timeouts | CODE_VERIFIED | `packages/game-rules/constants.ts:17-24` |
| Los 9 pasos del bucle | CODE_VERIFIED | `apps/arena-engine/src/sim/battle.ts:219-504` |
| Vehículo como bola con masa; muros como cuboides | CODE_VERIFIED | `physics.ts:84-112` |
| Modelo de daño D6 | CODE_VERIFIED | `src/sim/combat.ts:75-120` |
| Observación construida sólo en `sensors.ts` | CODE_VERIFIED | `src/sim/sensors.ts:40-203` |
| Snapshot público cada 3 ticks y hash cada 30 | CODE_VERIFIED | `battle.ts:479-489` |
| PRNG xoshiro128** y prohibición de `Math.random` | CODE_VERIFIED | `src/rng.ts:1-25`; `scripts/lint-determinism.mjs` |
| Formato JSONL y `verify` | CODE_VERIFIED | `src/replay.ts:16-60,310-350` |
| El worker ejecuta el motor en proceso con agentes en contenedor (`containerAgents`) | CODE_VERIFIED + RUNTIME_VERIFIED (aislado) | `apps/tournament-worker/src/container-agents.ts:97`; `container-battle-e2e.test.ts` |
| Inspector en loopback por defecto | CODE_VERIFIED | `src/inspector.ts:1-20`; `src/cli.ts:24-42` |
| Los tests del motor pasan en main | RUNTIME_VERIFIED | Auditoría 2026-10-15, A pasada 1 (suite completa con rc=0) |
