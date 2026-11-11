# VISUAL_COMPONENT_MATRIX — Matriz componente → representación

**Proyecto:** visuales componibles de bots ([MASTER-PLAN](MASTER-PLAN.md)) · **Fase:** FASE 0
**Estado:** borrador del AUTHOR, pendiente de revisión independiente.
**Base de la rama:** `mejoras-visuales` @ `983d2f5` (2026-11-09).
**Documentos hermanos:** [inventario](VISUAL_COMPONENT_INVENTORY.md) · [taxonomía de mounts](MOUNT_TYPE_DRAFT.md) ·
[ADR-VIS-001](adr/ADR-VIS-001-svg-vs-raster.md) · [ADR-VIS-002](adr/ADR-VIS-002-catalog-versioning.md) ·
[ADR-VIS-003](adr/ADR-VIS-003-mount-coordinate-system.md)

Esta fase es **documental**: no cambia reglas del motor, no añade assets ni renderer. Todo lo que se afirma del sistema
actual lleva su referencia de código; las propuestas se marcan como tales.

## 1. Propósito

Decidir, componente a componente, qué merece representación visual, en qué contexto, y qué información **no** debe
mostrarse nunca. La matriz es el contrato que FASE 1 (schema, resolver, composer) tiene que cumplir.

## 2. Fuentes

Las mismas del inventario (§1 de [VISUAL_COMPONENT_INVENTORY](VISUAL_COMPONENT_INVENTORY.md)). Los tests de
`packages/module-catalog/visual-contract.test.ts` leen el catálogo real (`loadCatalog()` y el `enum` de `category` de
`module.schema.json`) y comparan con estas tablas: si el catálogo cambia y la matriz no, la CI se pone en rojo.

## 3. Categorías reales frente a las del encargo

El encargo propone CHASSIS, WEAPON, ARMOR, SENSOR, RADIO, MOBILITY, AMMO, MINE, ACCESSORY y SPECIAL. El catálogo real
(`module.schema.json`, `types.ts`) tiene **diez** categorías, con dos diferencias: existe `power` (no prevista en el
encargo) y no existen ni ACCESSORY ni SPECIAL; lo más parecido es `utility`, que está en el schema pero sin módulos.

| REAL_CATEGORY | ENCARGO_CATEGORY | MODULES_IN_CATALOG | NOTES |
| --- | --- | --- | --- |
| chassis | CHASSIS | 5 (3 ids, 5 versiones) | `chassis.light@1/@2`, `chassis.medium@1/@2`, `chassis.heavy@1`. |
| weapon | WEAPON | 3 (2 ids) | `weapon.cannon@1`, `weapon.mg@1/@2`. Sólo armas de torreta. |
| armor | ARMOR | 8 | Acero y compuesto × 4 sectores (`front/left/right/rear`). |
| sensor | SENSOR | 5 | proximity, lidar_front, lidar360, radar, acoustic (ids verificados en `data/`). |
| radio | RADIO | 1 | `radio.short@1`. |
| movement | MOBILITY | 2 | El catálogo la llama `movement`, no `mobility`; la ranura es `drive`. |
| ammo | AMMO | 3 | En el loadout canónico la munición es propiedad del arma (`entry.ammo`); `resolveVehicle` la materializa en `ammo_main`. |
| mine | MINE | 1 | `mine.explosive@1`; sólo chasis con `mine_bay` (medio y pesado). |
| power | (no prevista: se añade) | 3 | Batería y generador. Interna: no se pinta en el vehículo. |
| utility | ACCESSORY / SPECIAL | 0 | En el schema (`effect: smoke/repair/jammer/drone`) y aceptada por `mine_bay`, pero sin módulos; todo FUTURE. |

ACCESSORY y SPECIAL quedan **sin categoría real**: si algún día se crean, entrarán por `utility` o por una categoría
nueva del catálogo, y esta tabla y su test lo detectarán.

## 4. Criterio de decisión

- **MUST_RENDER** — sin él no se cumple PRD-01 (distinguir chasis, arma principal y equipo de un vistazo).
- **SHOULD_RENDER** — físicamente visible y útil para reconocer el bot; puede llegar después que los MUST.
- **MAY_RENDER** — visible, pero pequeño o poco informativo; sólo en detalle/ficha y si sobra presupuesto.
- **DO_NOT_RENDER** — interno, invisible desde fuera, o su representación filtraría información (ver §12).

**VISIBILITY_CLASS** (en las tablas de decisión) clasifica **la identidad** del componente con las clases de §12. La
**presencia** de un módulo (que su ranura está ocupada) es PUBLIC para todos, porque el snapshot la publica
(`data.slot_occupancy`, §12.1). Cuando la presencia de la ranura más el catálogo dejan un único candidato, la identidad
también es pública de hecho, y la fila lo dice como «PUBLIC por inferencia» (§12.1). Lo mismo pasa con la
**cinemática** de los proyectiles: en cuanto un vehículo dispara, su arma queda identificada (§12.2), y la fila lo dice
como «PUBLIC por inferencia tras el primer disparo».

**Taxonomía de fugas.** `VISUAL_INFORMATION_LEAK = DIRECT_LEAK + DERIVED_LEAK + CROSS_VIEW_LEAK`:

- **DIRECT_LEAK**: el dato viaja tal cual en el canal que consume la vista (campo del snapshot, evento, nómina). Se
  marca en la columna `DIRECT_DISCLOSURE` de §12.
- **DERIVED_LEAK**: el dato no viaja, pero se **deduce** de lo que sí viaja más información pública (catálogo, reglas
  del validador, constantes del motor): ranuras ocupadas (§12.1), cinemática y daño de los proyectiles (§12.2),
  movimiento. Columna `DERIVED_DISCLOSURE` de §12.
- **CROSS_VIEW_LEAK**: una vista con más privilegio (dueño, equipo, replay crudo, admin) deja pasar su contenido a una
  vista con menos (caché compartida, captura, fichero servido sin proyección). §12.3.

No basta con ocultar los campos directos: cada fila de §12 se juzga por lo que el espectador **observa más lo que puede
inferir**, y lo que puede inferir es PUBLIC.

**Fuga visual frente a fuga de motor.** `ENGINE_INFORMATION_LEAK != VISUAL_CONTRACT_LEAK`. Hay cuatro clases de fuga:

| LEAK_CLASS | QUÉ ES | RESPONSABLE |
| --- | --- | --- |
| DIRECT | La vista expone el dato explícitamente (lo pinta o lo envía). | FASE 0 (contrato visual) |
| DERIVED | El dato se infiere de la **representación visual** (sprite, animación, color o forma que añade información). | FASE 0 (contrato visual) |
| CROSS_VIEW | El dato pasa de una vista o caché privilegiada a otra con menos privilegio (§12.3). | FASE 0 (contrato visual) |
| ENGINE_DERIVED | El dato se infiere del snapshot o de la telemetría que **ya entrega el motor**, sin que intervenga el renderer. | Motor: se documenta y se referencia a su issue (§12.4) |

Las columnas `DIRECT_DISCLOSURE` y `DERIVED_DISCLOSURE` de §12 describen lo que ya entrega el canal público del motor;
cuando `DERIVED_DISCLOSURE` no es `NO`, la columna `ENGINE_DERIVED` dice a qué issue o decisión de producto está atada esa
inferencia. La regla de la capa visual es que **no amplifica** una fuga del motor: no calcula ni pinta la parte deducible
de un dato privado, ni la anticipa antes de que el canal público la haga deducible. La FASE 0 no se bloquea esperando a
corregir toda inferencia posible del motor: eso va en las issues #261, #262 y #263 (§12.4).

## 5. Decisión por componente del catálogo

| DOMAIN_ID | DECISION | VISIBILITY_CLASS | WHY |
| --- | --- | --- | --- |
| `chassis.light@1` | MUST_RENDER | PUBLIC | Identidad base del bot; el chasis ya es público (`roster.chassis`). |
| `chassis.light@2` | MUST_RENDER | PUBLIC | Igual que @1; misma forma, otra versión de balance. |
| `chassis.medium@1` | MUST_RENDER | PUBLIC | Identidad base. |
| `chassis.medium@2` | MUST_RENDER | PUBLIC | Igual que @1. |
| `chassis.heavy@1` | MUST_RENDER | PUBLIC | Identidad base. |
| `weapon.cannon@1` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal (PRD-01). El `moduleId` no viaja en el directo, pero es PUBLIC por inferencia tras el primer disparo: el proyectil del cañón va a 120 m/s y el de la mg a 200 m/s, y nace en la boca del vehículo (§12.2). Antes del primer disparo, OBSERVER_DEPENDENT para el renderer (D-01, D-08), aunque el motor ya deja una pista con ruido: una torreta que nunca gira más deprisa que el cañón en su estado público lo sugiere (ENGINE_DERIVED, #262; §12.2). |
| `weapon.mg@1` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal. PUBLIC por inferencia en `chassis.light` (ranura, §12.1) y, en cualquier chasis, PUBLIC por inferencia tras el primer disparo (velocidad del proyectil, §12.2). Antes del primer disparo, también por la cinemática de la torreta: gira más deprisa de lo que puede el cañón en el mismo estado (ENGINE_DERIVED, #262; §12.2). La versión se infiere tras impactos por el daño (§12.2). |
| `weapon.mg@2` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal; misma forma que @1. PUBLIC por inferencia como @1 (ranura en el ligero; velocidad del proyectil tras el primer disparo; giro de la torreta antes, ENGINE_DERIVED, #262). La versión se distingue de @1 por el daño y, con el arma dañada, por la cadencia (§12.2). |
| `armor.steel_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa visible; dice qué sectores protege. Sin estado de daño público (H-01). El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.steel_left@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.steel_right@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible (mirror de left). El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.steel_rear@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa trasera visible. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.composite_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa visible; acabado distinto del acero. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.composite_left@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.composite_right@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `armor.composite_rear@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa trasera visible. El material (acero o compuesto) es ENGINE_DERIVED (#263): inferible con ruido tras impactos en el sector, porque la reducción es distinta por material (§12.4). |
| `movement.tracks@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Muy reconocible (orugas frente a ruedas); su estado público (`drive`) ya existe. Inferible con ruido por cinemática en medio y pesado: con carga ligera, una velocidad o un giro por encima del tope de las orugas delata las ruedas; con carga pesada no se distingue (escalado por `ratedLoadKg`, `vehicle.ts`). |
| `movement.wheels@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Muy reconocible. PUBLIC por inferencia en `chassis.light`: allí `drive` sólo admite las ruedas (§12.1). En medio y pesado, inferible con ruido por cinemática (ver orugas). |
| `sensor.lidar360@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Cúpula superior visible. |
| `sensor.radar@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Antena visible. |
| `sensor.lidar_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Lente frontal visible; orientada con el casco. |
| `sensor.proximity@1` | MAY_RENDER | OBSERVER_DEPENDENT | Pequeño; su forma no debe sugerir alcance ni detección (§7). |
| `sensor.acoustic@1` | MAY_RENDER | OBSERVER_DEPENDENT | Pequeño y pasivo; nunca animado (§7). |
| `radio.short@1` | SHOULD_RENDER | PUBLIC | Antena visible. PUBLIC por inferencia: `radio_a` sólo admite este módulo, así que la ranura en el snapshot ya dice cuál es (§12.1). Que transmita es ALLY_ONLY y el contenido NEVER_VISUALIZE (§12). |
| `power.battery@1` | DO_NOT_RENDER | SELF_ONLY | Interno; el estado energético es privado del bot. Ficha: sólo texto/icono. La presencia de la ranura `power` es PUBLIC (§12.1); cuál de los tres módulos, no. |
| `power.generator@1` | DO_NOT_RENDER | SELF_ONLY | Interno. |
| `power.generator@2` | DO_NOT_RENDER | SELF_ONLY | Interno. |
| `ammo.standard@1` | DO_NOT_RENDER | SELF_ONLY | Cargador interno; munición restante privada. PUBLIC por inferencia en `chassis.light`: la única arma que cabe es `weapon.mg`, que sólo acepta esta munición (§12.1). En medio y pesado el tipo sigue siendo privado. |
| `ammo.ap@1` | DO_NOT_RENDER | SELF_ONLY | Interno. Variante de proyectil = futuro, sujeta a D-02. Inferible con ruido tras impactos: ×1.2 de daño en el `hullHp` público y sin explosión (§12.2). |
| `ammo.he@1` | DO_NOT_RENDER | SELF_ONLY | Interno. Inferible con ruido tras impactos: ×0.9 de daño y daño de área (radio 5 m) en el `hullHp` público de los vecinos (§12.2). |
| `mine.explosive@1` | DO_NOT_RENDER | PUBLIC | PUBLIC por inferencia: `mine_bay` sólo admite este módulo (`utility` no tiene ninguno), así que la ranura en el snapshot ya dice que lleva minas (§12.1). Las cargas que quedan y las minas desplegadas siguen siendo SELF_ONLY para el renderer, pero el motor deja inferirlas en ciertas condiciones (ENGINE_DERIVED, #261; §12.4). Como mucho, una compuerta genérica (MAY); ver D-07. |

## 6. Decisión por elemento de batalla (runtime)

| DOMAIN_ID | DECISION | VISIBILITY_CLASS | WHY |
| --- | --- | --- | --- |
| `runtime.turret` | MUST_RENDER | PUBLIC | `turretHeading` es público y ya se pinta; soporte del arma. Su cinemática (ritmo de giro) delata el arma: ENGINE_DERIVED (#262). El sprite gira con el dato público, sin suavizar ni exagerar el ritmo. |
| `runtime.projectile` | MUST_RENDER | PUBLIC | Posición e `id` estable públicos en el snapshot; ya se pinta. Su cinemática identifica el arma (§12.2): el sprite no debe añadir información que el dato público no tenga (D-08). |
| `runtime.muzzle_flash` | SHOULD_RENDER | PUBLIC | Deducido de un proyectil nuevo (dato público). |
| `runtime.mine_deployed` | DO_NOT_RENDER | SELF_ONLY | El motor la excluye del snapshot público («información oculta hasta que explotan», battle.ts), pero su despliegue es inferible en ciertas condiciones a partir de la identidad u orden de las entidades públicas: ENGINE_DERIVED (#261). El renderer no la pinta ni la deduce. |
| `runtime.explosion` | SHOULD_RENDER | PUBLIC | Eventos públicos `vehicle_destroyed` / `mine_triggered`. |
| `runtime.smoke` | SHOULD_RENDER | PUBLIC | Derivado del casco público. |
| `runtime.wreck` | MUST_RENDER | PUBLIC | `alive=false` público. |
| `runtime.flag` | MUST_RENDER | PUBLIC | Objetivo público del modo. |
| `runtime.juggernaut_marker` | MUST_RENDER | PUBLIC | Marca pública del modo. |
| `runtime.team_color` | MUST_RENDER | PUBLIC | Identidad de bando (PRD-01). No debe ser el único canal (SRS-F10). |
| `runtime.bot_label` | SHOULD_RENDER | PUBLIC | Nombre de la nómina; COMPETITION_NOTE lo permite. |

## 7. Contrato visual de sensores (SENSOR_VISUAL_CONTRACT)

Ids verificados en `packages/module-catalog/data/`: los cinco del encargo existen tal cual. Hechos del motor que fijan el
contrato (`apps/arena-engine/src/sim/sensors.ts`):

- el lidar lanza sus rayos desde `pose.heading` (rumbo **del casco**), no desde la torreta;
- radar, proximidad y acústico no tienen `fovRad`: son omnidireccionales dentro de `rangeM`;
- un sensor `critical` falla de forma intermitente (`moduleActs`): si da lectura o no en un ciclo es **interno**;
- las ranuras de sensor son genéricas (`sensor_a` M en los tres chasis, `sensor_b` S sólo en el pesado): el **tipo de
  mount** lo decide el sensor, no la ranura (ver [MOUNT_TYPE_DRAFT](MOUNT_TYPE_DRAFT.md)).

| SENSOR_ID | VERSIONS | VISUAL_SHAPE | CHASSIS_ZONE (MOUNT_TYPE) | ORIENTED | ROTATES | FUTURE_ANIMATION | DAMAGED_LOOK | MUST_NOT_SHOW |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sensor.proximity` | @1 | Banda/anillo de emisores pequeños pegada al casco | Perímetro del casco (`sensor.omni`) | NO (omnidireccional) | NO | Ninguna en vistas públicas; pulso tenue sólo en vista SELF/ALLY | Emisores apagados o rotos según el `state` público del módulo | Radio real de 15 m, rumbos detectados, si está «disparado», minas detectadas |
| `sensor.lidar_front` | @1 | Caja baja con lente al frente | Proa del casco (`sensor.front`) | SÍ, con el rumbo del casco | NO (fijo al casco) | Destello de barrido dentro de la lente, sin proyectar fuera del casco | Lente agrietada (damaged/critical), lente negra (destroyed/offline) | Cono de 90° y alcance de 45 m, rayos, distancias, impactos |
| `sensor.lidar360` | @1 | Cúpula/cilindro en lo alto | Techo (`sensor.top`) | NO (cubre 360°) | Giro cosmético opcional, a velocidad FIJA | Giro de la cúpula; se detiene si el `state` público es destroyed/offline | Cúpula agrietada; sin giro si destroyed/offline | Rayos, alcance de 40 m, lo que detecta; la velocidad de giro no debe codificar nada interno |
| `sensor.radar` | @1 | Plato o placa sobre mástil | Techo (`sensor.top`) | NO (omnidireccional; el plato es estético) | Giro cosmético opcional, a velocidad FIJA | Giro del plato; se detiene si destroyed/offline | Plato doblado; mástil caído si destroyed | Contactos, error de posición, alcance de 50 m, confianza |
| `sensor.acoustic` | @1 | Par de micrófonos/vainas pequeñas | Flancos (`sensor.flank`) o techo (`sensor.top`) | NO | NO | Ninguna: es pasivo, cualquier animación sugeriría «está oyendo algo» | Vainas rotas o ausentes | Sonidos oídos, rumbos, intensidades |

Regla común: el único dato dinámico que un sensor puede mostrar en vistas públicas es su `state` público
(`operational/damaged/critical/destroyed/offline`). Lo que percibe es siempre NEVER_VISUALIZE para el espectador (§12).

## 8. Contrato visual de armas (WEAPON_VISUAL_CONTRACT)

Hechos del motor: todas las armas declaran `turretArcRad = 2π` (FUTURE: el chequeo de arco nunca actúa); hay **una**
`turretHeading` por vehículo (`vehicle.ts`), y gira al `turretRateRads` del mejor arma operativa; la boca del disparo está
a `radiusM + 0.3` m del centro a lo largo de `turretHeading` (`battle.ts`); el proyectil vive 90 ticks. El snapshot
público no trae un campo con el arma ni el dueño del proyectil, pero **no hace falta**: el `id` es estable y la velocidad
es la `projectileSpeedMs` del arma, así que con dos snapshots se sabe qué arma es, y por el punto de nacimiento qué
vehículo disparó. El propio visor ya estima esa velocidad (`ballistics.ts`). Es PUBLIC por inferencia tras el primer
disparo (§12.2). Antes del primer disparo, el ritmo de giro de la torreta (`turretRateRads` × rendimiento, con
`turretHeading` público en cada snapshot) también separa las armas base: ENGINE_DERIVED, #262 (§12.2, §12.4).

| WEAPON_ID | VERSIONS | MOUNT_TYPE | ORIENTATION_REQUIRED | TURRET_OR_HULL | PROJECTILE_VISUAL_RELEVANCE | MUZZLE_FLASH_POSSIBLE | RELOAD_COOLDOWN_VISUAL_RELEVANCE | AMMO_VISUAL_RELEVANCE | DESTROYED_STATE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `weapon.cannon` | @1 | `weapon.primary` (sólo `turret_main` L/XL: chasis medio y pesado) | SÍ (`turretHeading`) | Torreta, 360° | ALTA: 120 m/s, ~1 disparo/s; un proyectil público por disparo | SÍ (boca a `radiusM + 0.3` m) | Baja en público: el cooldown es SELF_ONLY; sólo vista SELF | Baja en público: rondas SELF_ONLY. El proyectil no lleva tipo, pero ap/he es inferible con ruido tras impactos (daño en el `hullHp` público; daño de área de HE). §12.2 | Cañón caído/atenuado y torreta bloqueada (el `turretLocked` actual: alfa 0.4, sin giro) |
| `weapon.mg` | @1, @2 | `weapon.primary` (`turret_main` M o mayor: los tres chasis) | SÍ (`turretHeading`) | Torreta, 360° | ALTA: 200 m/s, 5 disparos/s a pleno rendimiento (en las dos versiones: el disparo se resuelve cada 3 ticks); ojo con el coste de partículas (§11) | SÍ (fogonazo pequeño y frecuente) | Baja en público (SELF_ONLY) | Baja en público (SELF_ONLY) | Igual que el cañón |

Sin efectos nuevos en esta fase: el fogonazo y la explosión ya existen en el visor; esta tabla sólo dice qué es lícito.

## 9. Contrato de mounts por chasis (CHASSIS_MOUNT_CONTRACT)

Formato de cada mount (semántica en [MOUNT_TYPE_DRAFT](MOUNT_TYPE_DRAFT.md)):

- `SOURCE_SLOT`: ranura real del chasis de la que sale el módulo (`null` si la ranura no existe);
- `MOUNT_TYPE`: tipos de mount genéricos que admite (lista);
- `REQUIRED`: la definición visual del chasis **debe** declarar este mount (porque la ranura existe);
- `OPTIONAL`: la ranura puede ir vacía en un loadout válido (el validador no exige ninguna), así que el renderer tiene que
  saber pintar el chasis sin ese módulo;
- `MAX_COUNT`: módulos que puede pintar a la vez ese mount (0 = no existe);
- `ORIENTATION`: `turret` (sigue `turretHeading`), `hull` (sigue el casco), `per-module` (lo decide el mount type del
  módulo) o `none`;
- `LAYER_GROUP`: grupo de capa del MASTER-PLAN §10;
- `MAX_SIZE`: `maxSize` de la ranura en el catálogo (escala visual máxima).

Sin coordenadas: se fijan en FASE 1/2 con el sistema de [ADR-VIS-003](adr/ADR-VIS-003-mount-coordinate-system.md).
Como las versiones de cada chasis tienen las mismas ranuras, cada bloque cubre todas sus versiones (`appliesToVersions`).

### 9.1 chassis.light

```json
{
  "chassis": "chassis.light",
  "appliesToVersions": [1, 2],
  "mounts": {
    "primaryWeapon": { "SOURCE_SLOT": "turret_main", "MOUNT_TYPE": ["weapon.primary"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.primary", "MAX_SIZE": "M" },
    "secondaryWeapon": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["weapon.secondary"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.secondary", "MAX_SIZE": null },
    "sensorA": { "SOURCE_SLOT": "sensor_a", "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": "M" },
    "sensorB": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": null },
    "radio": { "SOURCE_SLOT": "radio_a", "MOUNT_TYPE": ["radio.top"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "radio", "MAX_SIZE": "S" },
    "armorFront": { "SOURCE_SLOT": "armor_front", "MOUNT_TYPE": ["armor.front"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "M" },
    "armorLeft": { "SOURCE_SLOT": "armor_left", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "S" },
    "armorRight": { "SOURCE_SLOT": "armor_right", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "S" },
    "armorRear": { "SOURCE_SLOT": "armor_rear", "MOUNT_TYPE": ["armor.rear"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "S" },
    "mobilityLeft": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.left"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "M" },
    "mobilityRight": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.right"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "M" },
    "mineBay": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["bay.rear"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "hull", "LAYER_GROUP": "chassis", "MAX_SIZE": null },
    "power": { "SOURCE_SLOT": "power", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "M" },
    "ammo": { "SOURCE_SLOT": "ammo_main", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "M" }
  }
}
```

Con el catálogo de hoy (cálculo de encaje del test, §12.1), en el ligero **ningún** blindaje cabe (`armor_front` M frente
a placas L; laterales y trasera S frente a placas M) ni caben las orugas (`movement.tracks@1` es L y `drive` es M), y el
cañón tampoco (L frente a `turret_main` M). Los mounts `armor*` se declaran REQUIRED porque la ranura existe, pero un
ligero **nunca** muestra placas ni orugas hasta que el catálogo tenga módulos que quepan. Afecta a la elección del
vertical slice.

### 9.2 chassis.medium

```json
{
  "chassis": "chassis.medium",
  "appliesToVersions": [1, 2],
  "mounts": {
    "primaryWeapon": { "SOURCE_SLOT": "turret_main", "MOUNT_TYPE": ["weapon.primary"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.primary", "MAX_SIZE": "L" },
    "secondaryWeapon": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["weapon.secondary"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.secondary", "MAX_SIZE": null },
    "sensorA": { "SOURCE_SLOT": "sensor_a", "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": "M" },
    "sensorB": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": null },
    "radio": { "SOURCE_SLOT": "radio_a", "MOUNT_TYPE": ["radio.top"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "radio", "MAX_SIZE": "S" },
    "armorFront": { "SOURCE_SLOT": "armor_front", "MOUNT_TYPE": ["armor.front"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "L" },
    "armorLeft": { "SOURCE_SLOT": "armor_left", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "M" },
    "armorRight": { "SOURCE_SLOT": "armor_right", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "M" },
    "armorRear": { "SOURCE_SLOT": "armor_rear", "MOUNT_TYPE": ["armor.rear"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "M" },
    "mobilityLeft": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.left"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "L" },
    "mobilityRight": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.right"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "L" },
    "mineBay": { "SOURCE_SLOT": "mine_bay", "MOUNT_TYPE": ["bay.rear"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "chassis", "MAX_SIZE": "M" },
    "power": { "SOURCE_SLOT": "power", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "M" },
    "ammo": { "SOURCE_SLOT": "ammo_main", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "M" }
  }
}
```

### 9.3 chassis.heavy

```json
{
  "chassis": "chassis.heavy",
  "appliesToVersions": [1],
  "mounts": {
    "primaryWeapon": { "SOURCE_SLOT": "turret_main", "MOUNT_TYPE": ["weapon.primary"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.primary", "MAX_SIZE": "XL" },
    "secondaryWeapon": { "SOURCE_SLOT": null, "MOUNT_TYPE": ["weapon.secondary"], "REQUIRED": false, "OPTIONAL": true, "MAX_COUNT": 0, "ORIENTATION": "turret", "LAYER_GROUP": "weapon.secondary", "MAX_SIZE": null },
    "sensorA": { "SOURCE_SLOT": "sensor_a", "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": "M" },
    "sensorB": { "SOURCE_SLOT": "sensor_b", "MOUNT_TYPE": ["sensor.front", "sensor.top", "sensor.omni", "sensor.flank"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "per-module", "LAYER_GROUP": "sensor", "MAX_SIZE": "S" },
    "radio": { "SOURCE_SLOT": "radio_a", "MOUNT_TYPE": ["radio.top"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "radio", "MAX_SIZE": "S" },
    "armorFront": { "SOURCE_SLOT": "armor_front", "MOUNT_TYPE": ["armor.front"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "XL" },
    "armorLeft": { "SOURCE_SLOT": "armor_left", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "L" },
    "armorRight": { "SOURCE_SLOT": "armor_right", "MOUNT_TYPE": ["armor.side"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "L" },
    "armorRear": { "SOURCE_SLOT": "armor_rear", "MOUNT_TYPE": ["armor.rear"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "armor", "MAX_SIZE": "L" },
    "mobilityLeft": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.left"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "XL" },
    "mobilityRight": { "SOURCE_SLOT": "drive", "MOUNT_TYPE": ["mobility.right"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "mobility", "MAX_SIZE": "XL" },
    "mineBay": { "SOURCE_SLOT": "mine_bay", "MOUNT_TYPE": ["bay.rear"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "hull", "LAYER_GROUP": "chassis", "MAX_SIZE": "M" },
    "power": { "SOURCE_SLOT": "power", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "L" },
    "ammo": { "SOURCE_SLOT": "ammo_main", "MOUNT_TYPE": ["internal"], "REQUIRED": true, "OPTIONAL": true, "MAX_COUNT": 1, "ORIENTATION": "none", "LAYER_GROUP": "none", "MAX_SIZE": "L" }
  }
}
```

Notas:

- `mobilityLeft` y `mobilityRight` salen de la **misma** ranura `drive`: un único módulo (orugas o ruedas) se pinta a
  ambos lados, el derecho como espejo del izquierdo.
- `secondaryWeapon` se declara con `MAX_COUNT: 0` en los tres para dejar constancia de que **no existe**; no es una
  invitación a pintarla.
- `power` y `ammo` se declaran `internal` para que la cobertura de ranuras sea completa y el renderer sepa que no las pinta.

## 10. Munición, radio y minas

- **Munición.** Interna. El tipo (`ammo.ap/he/standard`) y las rondas restantes son SELF_ONLY (`self.modules[].ammo` en la
  observación). En público sólo existe el proyectil, sin tipo, aunque ap/he es inferible con ruido tras impactos y las
  rondas restantes se estiman contando proyectiles (§12.2). Distinguir AP/HE en el sprite del proyectil exigiría
  publicar el tipo: decisión de producto (D-02), no de esta fase.
- **Radio.** La antena (presencia **e identidad**) es PUBLIC por inferencia: `radio_a` sólo admite `radio.short@1` (§12.1). La actividad no tiene evento público: los mensajes sólo se
  entregan al propio equipo (`radioDeliverableTo`). Un pulso de «transmitiendo» en el broadcast revelaría al rival el
  ritmo de comunicación del equipo: **ALLY_ONLY**, nunca en vistas públicas en directo. El contenido es NEVER_VISUALIZE.
- **Minas.** Las desplegadas no están en el snapshot público y sólo el dueño recibe `mine_deployed`; el único hecho
  público explícito es `mine_triggered` (posición de la explosión). Cargas restantes y posición: SELF_ONLY para el
  renderer. El motor deja inferir ambas en ciertas condiciones por la identidad u orden de las entidades públicas: es
  ENGINE_DERIVED (#261, §12.4), no una fuga de la capa visual, y el renderer no la amplifica. Que la bahía lleva minas es
  PUBLIC por inferencia (§12.1).
- **Fichero de replay crudo.** Todo lo anterior vale para lo que se **renderiza** en vistas públicas. El replay crudo lleva
  semilla, equipamiento y comandos de todos los participantes: es RAW_REPLAY, restringido, y el renderer público no lo
  consume nunca (política PRE-1 en §12; H-05; §12.3).

## 11. Qué datos tiene hoy cada contexto

| Contexto | Datos disponibles hoy | Render actual |
| --- | --- | --- |
| Ficha de bot | Loadout de la versión (API), según BOT_VISIBILITY (`private/team/public`) | React DOM, **sin** representación gráfica (`BotDetailPage.tsx`) |
| Editor de loadout | Catálogo + loadout en edición (dueño) | React DOM, **sin** representación gráfica (`LoadoutEditor.tsx`) |
| Mapa en directo | `init.meta.roster` (id, bot, equipo, **chasis**, nombre) + snapshots públicos + eventos públicos, con el retardo anti-coaching del ruleset | Phaser 3, atlas procedural de UNA textura, `setTint` por equipo (`atlas.ts`, `PhaserViewer.ts`) |
| Replay | Hoy, el fichero crudo: cabecera con `participants[].spec` (equipamiento completo) + snapshots + eventos públicos; el índice da al visor sólo chasis y nombre. Con la política PRE-1, el replay público pasa a ser una proyección saneada y el crudo queda restringido (§12) | El mismo visor Phaser |
| Broadcast | Lo mismo que el directo | `/broadcast` reutiliza el visor; el streamer lo captura en Chromium 1920×1080 con WebGL por software (`apps/streamer/src/ffmpeg.ts`) |

El presupuesto de rendimiento del visor ya se mide (draw calls y FPS, `render-stats.ts`); ver
[ADR-VIS-001](adr/ADR-VIS-001-svg-vs-raster.md).

## 12. Fog of war / fuga de información

Clases:

- **PUBLIC** — cualquier espectador puede verlo, y hoy ya se publica (o se deriva de lo publicado).
- **SELF_ONLY** — sólo el propio bot (su observación) o su dueño.
- **ALLY_ONLY** — el equipo del bot.
- **OBSERVER_DEPENDENT** — depende de quién mira y de la política de producto (visibilidad del bot, competición,
  vista con niebla del espectador, replay posterior).
- **NEVER_VISUALIZE** — no se representa en ninguna vista de espectador.

**Alcance de las clases y política de replay (PRE-1).** La política está decidida (su implementación de backend va en
otro PR, contra `main`, fuera de esta fase):

- **PUBLIC_REPLAY = proyección saneada de competición.** Sólo lleva lo aprobado para un espectador: estado visible de la
  competición, posiciones y acciones permitidas, identidad pública, resultado, eventos públicos y lo que ya recibe el
  canal de espectador o de broadcast. No lleva código, comandos, observaciones privadas, información interna no
  observable, nada que permita reconstruir lo que el espectador no debe saber, el equipamiento si la política pública lo
  oculta, ni metadatos internos.
- **RAW_REPLAY = restringido** al dueño, a administración o a un rol interno autorizado, con la autorización en el
  backend. El frontend **no** es un control de seguridad.

Implicaciones visuales, que son contrato de este documento:

1. El **renderer público** (visor en directo, replay en el visor, broadcast, miniaturas) consume **sólo** el canal de
   espectador o la proyección saneada, **nunca** el replay crudo. Ninguna vista pública lee `participants[].spec`, la
   `seed` ni los comandos.
2. Las clases de este apartado se juzgan contra ese canal público. El contrato tiene que ser seguro aunque se activen los
   replays públicos: que hoy estén apagados por configuración no cuenta como protección.
3. «RAW_REPLAY ⇒ dueño» se resuelve **por pareja** (visor, vehículo observado), no por batalla: en una batalla con
   varios participantes, el dueño de A sólo ve A con `view.owner`; a los demás vehículos los ve con el perfil público.
   La capa visual no alimenta `view.owner` con el crudo de varios participantes sin filtrarlo antes por vehículo
   (ADR-VIS-002, «Proyección por pareja»; §12.3 `cross.owner_to_rival`). La política PRE-1 no cambia.
4. Una vista pública tampoco recibe comandos ni observaciones de otros participantes aunque el formato de replay tenga
   abierta la depuración: el flag `debugOpen` del formato (`apps/replay-service/src/format.ts`) es un vector CROSS_VIEW
   **latente** (§12.3 `cross.debug_overlay`).
5. SELF_ONLY, ALLY_ONLY y NEVER_VISUALIZE **no** se aplican al **fichero de replay crudo**: lleva semilla, equipamiento y
   comandos de cada bot, y una re-simulación reconstruye lo privado (radio, minas, observaciones). Por eso es RAW_REPLAY
   y sólo lo abre una vista privilegiada; que llegue a una vista pública es un CROSS_VIEW_LEAK (§12.3, H-05).

**Columnas de divulgación.** `DIRECT_DISCLOSURE`: el dato viaja tal cual en el canal público. `DERIVED_DISCLOSURE`: se
deduce de lo que viaja más información pública (catálogo, validador, constantes del motor). Valores `YES`, `NO` o
`PARTIAL`. `ENGINE_DERIVED`: si `DERIVED_DISCLOSURE` no es `NO`, la inferencia la permite el motor y la columna dice a qué
está atada: una issue de motor (`#261`, `#262`, `#263`, §12.4), una decisión de producto (`D-01`…`D-08`) o `BY_DESIGN`
(el dato público existe a propósito, como el movimiento o el tramo de estado); si es `NO`, `—`. Reglas, que comprueba el
test:

- `YES` en cualquiera de las dos ⇒ la clase es PUBLIC (lo que se deduce siempre es público de hecho).
- `PARTIAL` ⇒ sólo una parte, o sólo en ciertas condiciones; la clase vale para el resto, y NOTES dice qué se deduce y
  dónde (§12.1, §12.2). El renderer **no** calcula ni dibuja la parte deducible de un dato privado: deducirla no es lo
  mismo que regalarla ya hecha (D-08).
- PUBLIC con `NO` en las dos es un error.
- `DERIVED_DISCLOSURE` = `NO` ⇔ `ENGINE_DERIVED` = `—`.

**Inferencia por ranuras ocupadas.** El snapshot público lista sólo las ranuras **con módulo** (`modules: [{slot, state}]`,
`Battle.publicSnapshot()`; el vehículo sólo crea entradas para los módulos de su spec, `vehicle.ts`). La nómina publica
el chasis. Cruzando ambas cosas con el catálogo (público) y las reglas del validador (categoría aceptada, tamaño,
sector, chasis requerido y compatibilidad arma↔munición), un espectador sabe **qué ranuras van ocupadas** y, cuando una
ranura admite un único módulo base, **qué módulo es**. La regla es:

> presencia de la ranura + catálogo ⇒ identidad, cuando sólo hay un candidato.

La tabla de encaje está en §12.1; la calcula el test a partir del catálogo real y del validador, no se escribe a mano.
La inferencia por cinemática de los proyectiles está en §12.2, y las fugas entre vistas en §12.3.

| DATA_ID | DATA | CLASSIFICATION | DIRECT_DISCLOSURE | DERIVED_DISCLOSURE | ENGINE_DERIVED | SOURCE | NOTES |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `data.chassis_identity` | Chasis del vehículo | PUBLIC | YES | NO | — | `init.meta.roster.chassis`; cabecera del replay | Ya se pinta por arquetipo. |
| `data.team_identity` | Equipo | PUBLIC | YES | NO | — | snapshot `team`, nómina | |
| `data.bot_name` | Nombre del bot | PUBLIC | YES | NO | — | nómina | COMPETITION_NOTE lo permite. |
| `data.pose` | Posición y rumbo del casco | PUBLIC | YES | NO | — | snapshot `position`, `heading` | La vista con niebla del espectador es una aproximación por radio (`fog.ts`). |
| `data.turret_heading` | Rumbo de la torreta | PUBLIC | YES | NO | — | snapshot `turretHeading` | |
| `data.hull_hp_exact` | Vida exacta del casco | PUBLIC | YES | NO | — | snapshot `hullHp`, `hullHpMax` (el HUD lo enseña) | Hoy es pública. Propuesta: el renderer del vehículo usa tramos; mantener o no la cifra exacta en el HUD es D-03. Su variación delata el daño de cada impacto (§12.2). |
| `data.module_state` | Estado de cada ranura (operational/damaged/critical/destroyed/offline) | PUBLIC | YES | NO | — | snapshot `modules[].state` | Incluye `offline` (apagado voluntario): ver D-04. |
| `data.module_health_exact` | Fracción de vida exacta de cada módulo | SELF_ONLY | NO | PARTIAL | BY_DESIGN | observación `self.modules[].healthFraction` | No está en el snapshot. El `state` público da el tramo (≥ 0.66, < 0.66, < 0.33, 0), no la cifra. |
| `data.armor_sector_hp` | Vida de blindaje por sector | SELF_ONLY | NO | PARTIAL | #263 | observación `self.armor` | Ni siquiera en el snapshot público (sólo en el hash). Con ruido: si un impacto en un sector con placa baja el `hullHp` como uno sin placa, la placa está agotada (`applyDamage`, §12.2): ENGINE_DERIVED, #263 (§12.4). |
| `data.armor_material` | Material de la placa de un sector (acero o compuesto) | OBSERVER_DEPENDENT | NO | PARTIAL | #263 | `hullHp` público tras impactos + sector por geometría + arma inferida (§12.2) + catálogo | El sector lo da la ranura (§12.1); el material no viaja, pero la reducción del daño es distinta por material, así que la caída del `hullHp` tras impactos en un sector lo sugiere con ruido (ENGINE_DERIVED, #263, §12.4). El renderer no lo deduce: placa genérica hasta D-01. |
| `data.slot_occupancy` | Qué ranuras del chasis llevan módulo | PUBLIC | YES | NO | — | snapshot `modules[].slot` (sólo las ocupadas) + `roster.chassis` | Regla de inferencia: presencia de ranura + catálogo ⇒ identidad cuando sólo hay un candidato (§12.1). Ver H-04 y D-07. |
| `data.module_identity` | Qué módulo concreto hay en cada ranura | OBSERVER_DEPENDENT | NO | PARTIAL | #262, #263, D-07, D-08 | loadout (ficha); cabecera del replay crudo | El `moduleId` no viaja en el directo, pero se infiere en varias ranuras (§12.1) y en el arma tras el primer disparo (§12.2); antes, por el giro de la torreta (#262); el material del blindaje tras impactos (#263); la tracción, con ruido, por cinemática. Ver D-01, H-04, H-05 y H-07. |
| `data.sensor_installed` | Que un sensor está montado, y cuál | OBSERVER_DEPENDENT | PARTIAL | NO | — | ranura en el snapshot (`sensor_a/b`) + identidad (D-01) | La presencia viaja (`data.slot_occupancy`); el tipo no se infiere: varias opciones en `sensor_a` y en `sensor_b` (§12.1). Ver la nota de §12.1 sobre restricciones conjuntas. |
| `data.sensor_destroyed` | Sensor destruido | PUBLIC | YES | NO | — | snapshot `modules[].state = destroyed` | |
| `data.radar_operating` | Radar funcionando (no destruido ni apagado) | PUBLIC | YES | NO | — | `modules[].state` de la ranura del sensor | Lo público es el estado de la ranura; que esa ranura sea un radar depende de `data.sensor_installed`. Si en un ciclo concreto dio lectura (`moduleActs`) es interno: `data.sensor_cycle_output`. |
| `data.sensor_cycle_output` | Si el sensor produjo lectura en un ciclo | NEVER_VISUALIZE | NO | NO | — | `moduleActs` en `sensors.ts` | |
| `data.sensor_readings` | Rayos, contactos, rumbos, sonidos percibidos | NEVER_VISUALIZE | NO | PARTIAL | BY_DESIGN | `buildObservation` (`sensors.ts`) | Es la observación privada del bot. El comportamiento del bot (giros, disparos) delata algo de lo que percibe; eso no se pinta. Re-simulable desde el replay crudo: H-05 (CROSS_VIEW, §12.3). |
| `data.sensor_range_fov` | Alcance y cono de un sensor concreto dibujados sobre ese bot | OBSERVER_DEPENDENT | NO | PARTIAL | D-01 | catálogo (público) + identidad (D-01) | Se deduce del catálogo si se conoce la identidad. Dibujarlo sobre un bot revela su capacidad real; nunca en directo público mientras D-01 no lo permita. |
| `data.radio_installed` | Lleva radio, y cuál | PUBLIC | PARTIAL | YES | D-07 | ranura `radio_a` en el snapshot + catálogo | La presencia viaja; la identidad es PUBLIC por inferencia: `radio_a` sólo admite `radio.short@1` (§12.1). |
| `data.radio_active` | Está transmitiendo | ALLY_ONLY | NO | NO | — | cola de radio del motor; sin evento público | Nunca en directo público. |
| `data.radio_content` | Contenido de los mensajes | NEVER_VISUALIZE | NO | NO | — | `RadioMessage.data` | En el canal público y en la proyección saneada. El replay crudo lo contiene (`radio[].data` de cada comando): H-05, PRE-1, CROSS_VIEW (§12.3). |
| `data.ammo_type` | Tipo de munición | SELF_ONLY | NO | PARTIAL | D-07, D-08 | loadout / spec | En el ligero es PUBLIC por inferencia (`data.light_ammo_type`). En medio y pesado, ap/he es inferible con ruido tras impactos (§12.2). El replay crudo lo lleva en el spec: H-05. |
| `data.ammo_installed` | Lleva munición | PUBLIC | YES | NO | — | ranura `ammo_main` en el snapshot | Presencia (§12.1). |
| `data.light_ammo_type` | Tipo de munición de un ligero | PUBLIC | NO | YES | D-07 | `roster.chassis` + ranuras + catálogo + regla arma↔munición | PUBLIC por inferencia: la única arma base que cabe en el ligero es `weapon.mg`, que sólo acepta `ammo.standard` (§12.1). |
| `data.ammo_remaining` | Munición restante | SELF_ONLY | NO | PARTIAL | D-08 | observación `self.modules[].ammo` | MASTER-PLAN §13: «no por defecto». Con el tipo conocido, `rounds` del catálogo menos los proyectiles contados da una estimación (cada disparo gasta una ronda, `combat.ts`; se escapa el que impacta antes del siguiente snapshot). §12.2. |
| `data.out_of_ammo` | Sin munición | SELF_ONLY | NO | PARTIAL | D-08 | rechazo privado `no_ammo` | Se sospecha cuando la cuenta de §12.2 llega a cero y el vehículo deja de disparar. |
| `data.weapon_cooldown` | Cooldown / recarga | SELF_ONLY | NO | PARTIAL | D-08 | observación `self.modules[].cooldownTicks` | Con el arma y la versión inferidas, el último proyectil más el intervalo de §12.2 da el cooldown restante. |
| `data.firing` | Ha disparado | PUBLIC | YES | YES | D-08 | proyectil nuevo en el snapshot | El dato no trae el vehículo, pero se atribuye por inferencia: el proyectil nace en la boca de quien dispara (§12.2). |
| `data.projectile_origin` | Qué vehículo y qué arma disparó el proyectil | PUBLIC | NO | YES | D-08 | `id` estable + posiciones del proyectil + `turretHeading` + catálogo | PUBLIC por inferencia tras el primer disparo: velocidad = `projectileSpeedMs`, origen = boca a `radiusM + 0.3` m (§12.2, H-07). D-08. |
| `data.weapon_identity` | Arma de un vehículo que ya ha disparado o ha girado la torreta a su ritmo máximo | PUBLIC | NO | YES | #262, D-08 | cinemática del proyectil + `turretHeading` + catálogo | PUBLIC por inferencia tras el primer disparo: cada arma base tiene su `projectileSpeedMs` (§12.2). Antes, la mg se delata por el giro de la torreta en cuanto supera el ritmo máximo del cañón en el mismo estado (ENGINE_DERIVED, #262, §12.2); hasta entonces, `data.module_identity`. |
| `data.weapon_version` | Versión del arma (`weapon.mg@1` o `@2`) | PUBLIC | NO | YES | D-03, D-08 | `hullHp` público tras impactos + `modules[].state` del arma + catálogo | PUBLIC por inferencia tras impactos: el daño al casco es `damage × multiplicador × rendimiento × 0.7`, exacto en un sector sin placa (siempre en el ligero). Con el arma dañada, también por la cadencia (§12.2). |
| `data.energy_state` | Energía almacenada y flujo | SELF_ONLY | NO | PARTIAL | BY_DESIGN | observación `self.energy` | En las vistas renderizadas. Con ruido: un vehículo que deja de disparar con munición y el arma sana puede ir sin energía (`no_energy`). Con el replay crudo se re-simula: H-05. |
| `data.power_installed` | Lleva módulo de energía | PUBLIC | YES | NO | — | ranura `power` en el snapshot | Presencia. Cuál de los tres, no (§12.1). |
| `data.mine_installed` | Lleva minas en la bahía | PUBLIC | PARTIAL | YES | D-07 | ranura `mine_bay` en el snapshot + catálogo | PUBLIC por inferencia: `mine_bay` sólo admite `mine.explosive@1` (§12.1). |
| `data.mine_bay_contents` | Cargas que quedan en la bahía | SELF_ONLY | NO | PARTIAL | #261 | observación `self.modules[].ammo` (cargas) | Que lleva minas es PUBLIC (`data.mine_installed`). Cuántas quedan es SELF_ONLY para el renderer, pero el motor deja inferir los despliegues en ciertas condiciones por la identidad u orden de las entidades públicas (ENGINE_DERIVED, #261, §12.4); `mine_triggered` no dice de quién es la mina. El renderer no lo cuenta ni lo pinta. |
| `data.mine_position` | Posición de una mina desplegada | SELF_ONLY | NO | PARTIAL | #261 | evento privado `mine_deployed` | Excluida del snapshot público, pero el motor deja inferir en ciertas condiciones el instante y la posición de un despliegue por la identidad u orden de las entidades públicas (ENGINE_DERIVED, #261, §12.4). El renderer no la calcula ni la pinta. En el replay crudo, los `deployMine` de cada comando permiten reconstruirla: H-05, CROSS_VIEW (§12.3). |
| `data.mine_triggered` | Explosión de mina | PUBLIC | YES | NO | — | evento público `mine_triggered` | |
| `data.light_weapon_identity` | Arma de un ligero | PUBLIC | NO | YES | D-07 | `roster.chassis` + ranura `turret_main` + catálogo | PUBLIC por inferencia: en el ligero `turret_main` sólo admite `weapon.mg` (§12.1), aun sin disparar. La versión, por `data.weapon_version`. |
| `data.light_drive_identity` | Tracción de un ligero | PUBLIC | NO | YES | D-07 | `roster.chassis` + ranura `drive` + catálogo | PUBLIC por inferencia: en el ligero `drive` sólo admite `movement.wheels@1`. §12.1. |
| `data.carrying_flag` | Lleva la bandera | PUBLIC | YES | NO | — | snapshot `carryingFlag` | |
| `data.juggernaut` | Es el juggernaut | PUBLIC | YES | NO | — | snapshot `juggernaut` | |
| `data.vehicle_alive` | Vivo o destruido | PUBLIC | YES | NO | — | snapshot `alive`, evento `vehicle_destroyed` | |
| `data.respawns_left` | Reapariciones restantes | PUBLIC | YES | NO | — | snapshot `respawnsLeft` (sólo con respawn limitado) | |
| `data.engine_activity` | Motor en marcha (el vehículo se mueve o gira) | PUBLIC | NO | YES | BY_DESIGN | cambio de `position` y `heading` entre snapshots | PUBLIC por inferencia: se deriva del movimiento público. El acelerador sin movimiento es `data.engine_throttle`. |
| `data.engine_throttle` | Acelerador pedido aunque el vehículo no se mueva (p. ej., contra un muro) | SELF_ONLY | NO | NO | — | `lastMove.throttle` interno (`battle.ts`); sonido «engine» | Sólo lo oye el acústico de otro bot; nunca se pinta. |
| `data.hit_details` | Sector impactado, daño recibido, atacante | SELF_ONLY | NO | PARTIAL | #263, D-08 | eventos privados `hit_taken` / `hit_dealt` | El daño al casco (variación de `hullHp`) y el atacante (origen del proyectil, §12.2) se deducen; el sector, por geometría y con ruido; el daño al módulo y al blindaje, no. |
| `data.full_loadout` | Ficha completa del bot | OBSERVER_DEPENDENT | NO | PARTIAL | #262, #263, D-07, D-08 | API, según BOT_VISIBILITY | Lo deducible está en §12.1 y §12.2. |

### 12.1 Encaje por ranura: qué revela la ranura ocupada

Calculado por `TEST 7 · SLOT_INFERENCE` de `packages/module-catalog/visual-contract.test.ts` con el catálogo real
(`loadCatalog()`) y el validador real (`validateLoadout`: categoría aceptada, tamaño, sector y chasis requerido; para
munición y arma, además, la regla arma↔munición contra lo que cabe en ese chasis). Si el catálogo cambia y esta tabla
no, la CI se pone en rojo. Las versiones de un mismo chasis admiten lo mismo (el test lo comprueba), así que hay una
fila por chasis y ranura.

- `IDENTITY`: un único módulo base candidato. Ver la ranura en el snapshot equivale a saber cuál es: PUBLIC por inferencia.
- `PRESENCE`: varios candidatos. Sólo es pública la presencia (`data.slot_occupancy`).
- `NEVER`: ningún módulo cabe; con el catálogo de hoy la ranura no aparece nunca en un loadout válido.

**Es una cota calculada ranura a ranura:** una cota superior de la privacidad que queda y, por tanto, un mínimo de lo que
se revela. El test ignora a propósito las restricciones
**conjuntas** del loadout (masa, presupuesto de energía, coste y tope de créditos): `PRESENCE` significa «la ranura sola no
basta», no «no se puede saber». La combinación de ranuras puede revelar más. Ejemplo con `data/*.json`: un ligero con
ruedas, mg, radio y radar consume 1.5 + 1 + 1 + 5 = 8.5 EU/s, más que los 8 EU/s de la batería, así que esa combinación
exige generador. La inferencia por cinemática, que no es de ranura, está en §12.2.

| CHASSIS_SLOT | CANDIDATES | INFERENCE | NOTES |
| --- | --- | --- | --- |
| `chassis.light/drive` | `movement.wheels@1` | IDENTITY | Tracción del ligero pública (las orugas son L y no caben). |
| `chassis.light/power` | `power.battery@1`, `power.generator@1`, `power.generator@2` | PRESENCE | Se sabe que lleva energía, no cuál. |
| `chassis.light/sensor_a` | `sensor.acoustic@1`, `sensor.lidar360@1`, `sensor.lidar_front@1`, `sensor.proximity@1`, `sensor.radar@1` | PRESENCE |  |
| `chassis.light/turret_main` | `weapon.mg@1`, `weapon.mg@2` | IDENTITY | Arma del ligero pública por la ranura (el tipo; la versión, sólo tras impactos: §12.2). El cañón es L y no cabe. |
| `chassis.light/ammo_main` | `ammo.standard@1` | IDENTITY | Regla arma↔munición: la única arma que cabe sólo acepta `ammo.standard`. |
| `chassis.light/radio_a` | `radio.short@1` | IDENTITY | Identidad de la radio pública. |
| `chassis.light/armor_front` | — | NEVER | Ninguna placa frontal cabe (L frente a M): la ranura nunca aparece. |
| `chassis.light/armor_left` | — | NEVER | Las placas laterales son M y la ranura es S. |
| `chassis.light/armor_right` | — | NEVER | Ídem. |
| `chassis.light/armor_rear` | — | NEVER | La placa trasera es M y la ranura es S. |
| `chassis.medium/drive` | `movement.tracks@1`, `movement.wheels@1` | PRESENCE |  |
| `chassis.medium/power` | `power.battery@1`, `power.generator@1`, `power.generator@2` | PRESENCE |  |
| `chassis.medium/sensor_a` | `sensor.acoustic@1`, `sensor.lidar360@1`, `sensor.lidar_front@1`, `sensor.proximity@1`, `sensor.radar@1` | PRESENCE |  |
| `chassis.medium/turret_main` | `weapon.cannon@1`, `weapon.mg@1`, `weapon.mg@2` | PRESENCE |  |
| `chassis.medium/ammo_main` | `ammo.ap@1`, `ammo.he@1`, `ammo.standard@1` | PRESENCE |  |
| `chassis.medium/mine_bay` | `mine.explosive@1` | IDENTITY | Que lleva minas es público (`utility` no tiene módulos). |
| `chassis.medium/radio_a` | `radio.short@1` | IDENTITY |  |
| `chassis.medium/armor_front` | `armor.composite_front@1`, `armor.steel_front@1` | PRESENCE | El sector lo da la ranura; acero o compuesto, la ranura sola no (tras impactos, ENGINE_DERIVED #263, §12.4). |
| `chassis.medium/armor_left` | `armor.composite_left@1`, `armor.steel_left@1` | PRESENCE |  |
| `chassis.medium/armor_right` | `armor.composite_right@1`, `armor.steel_right@1` | PRESENCE |  |
| `chassis.medium/armor_rear` | `armor.composite_rear@1`, `armor.steel_rear@1` | PRESENCE |  |
| `chassis.heavy/drive` | `movement.tracks@1`, `movement.wheels@1` | PRESENCE |  |
| `chassis.heavy/power` | `power.battery@1`, `power.generator@1`, `power.generator@2` | PRESENCE |  |
| `chassis.heavy/sensor_a` | `sensor.acoustic@1`, `sensor.lidar360@1`, `sensor.lidar_front@1`, `sensor.proximity@1`, `sensor.radar@1` | PRESENCE |  |
| `chassis.heavy/sensor_b` | `sensor.acoustic@1`, `sensor.lidar_front@1`, `sensor.proximity@1` | PRESENCE |  |
| `chassis.heavy/turret_main` | `weapon.cannon@1`, `weapon.mg@1`, `weapon.mg@2` | PRESENCE |  |
| `chassis.heavy/ammo_main` | `ammo.ap@1`, `ammo.he@1`, `ammo.standard@1` | PRESENCE |  |
| `chassis.heavy/mine_bay` | `mine.explosive@1` | IDENTITY |  |
| `chassis.heavy/radio_a` | `radio.short@1` | IDENTITY |  |
| `chassis.heavy/armor_front` | `armor.composite_front@1`, `armor.steel_front@1` | PRESENCE |  |
| `chassis.heavy/armor_left` | `armor.composite_left@1`, `armor.steel_left@1` | PRESENCE |  |
| `chassis.heavy/armor_right` | `armor.composite_right@1`, `armor.steel_right@1` | PRESENCE |  |
| `chassis.heavy/armor_rear` | `armor.composite_rear@1`, `armor.steel_rear@1` | PRESENCE |  |

### 12.2 Proyectiles: lo que delatan su cinemática y su daño (DERIVED_LEAK)

Hechos del motor:

- el snapshot público publica cada proyectil con un `id` estable (`proj_${seq}`, `combat.ts`) y su posición
  (`Battle.publicSnapshot()`), por defecto cada 3 ticks (`snapshotEveryNTicks`, `battle.ts`);
- la velocidad es exactamente la `projectileSpeedMs` del arma: la dispersión (`spreadRad`) cambia el rumbo, no el
  módulo (`combat.ts`); el proyectil va en línea recta (`resolveProjectiles`, `battle.ts`);
- nace en la boca, a `radiusM + 0.3` m del centro del vehículo a lo largo de su `turretHeading` público (`battle.ts`);
- vive 90 ticks (`ttlTicks`, `combat.ts`); el `rangeM` del arma no limita al proyectil;
- el disparo sólo se resuelve en ticks de decisión (cada `DECISION_EVERY_N_TICKS` = 3, `battle.ts`), y el cooldown es
  `round(cooldownTicks / max(0.25, rendimiento))` (`combat.ts`); el rendimiento sale del `state` público del módulo
  (`MODULE_STATE_PERFORMANCE`);
- cada disparo gasta una ronda (`fire`, `combat.ts`);
- la torreta gira como mucho `turretRate() × dt` por tick, con `turretRate()` = máximo de `turretRateRads × rendimiento`
  de las armas (`vehicle.ts`), y el `turretHeading` va en cada snapshot (`battle.ts`);
- el daño de un impacto es `damage × damageMultiplier × rendimiento`; al casco va el 70 % (`CHASSIS_DAMAGE_SHARE`) tras
  la reducción de la placa del sector, si la hay (`applyDamage`, `combat.ts`); el `hullHp` exacto es público.

**Regla de inferencia** (DERIVED, sin cambiar el motor):

> velocidad = `projectileSpeedMs` ⇒ arma base · punto de nacimiento = boca ⇒ vehículo · daño al casco ⇒ versión y,
> con ruido, munición · intervalo entre disparos con el arma dañada ⇒ versión.

Hoy, por tanto, en cuanto un vehículo dispara su arma es **PUBLIC por inferencia tras el primer disparo**, en cualquier
chasis; y tras impactos, también la versión. La tabla la calcula `TEST 8 · PROJECTILE_INFERENCE` con el catálogo y las
constantes reales: si el catálogo cambia y la tabla no, la CI se pone en rojo.

- `REACH_M`: distancia que recorre en vuelo libre (velocidad × 90 ticks).
- `INTERVAL_TICKS`: intervalo mínimo entre disparos con el arma operational / damaged / critical.
- `HULL_DAMAGE`: daño al casco por impacto, por munición compatible, a pleno rendimiento y en un sector sin placa (todos
  los del ligero).
- `IDENTITY_BY_SPEED`: `IDENTITY` si ninguna otra arma base comparte velocidad; si no, `AMBIGUOUS`.
- `TURRET_RATE_RADS`: ritmo máximo de giro de la torreta con el arma operational / damaged / critical.
- `IDENTITY_BY_TURRET` (ENGINE_DERIVED, #262): `IDENTITY` si, en cada estado, gira más deprisa que cualquier otra arma
  base en ese mismo estado (un giro a tope la delata antes del primer disparo); `EXCLUSION` si alguna otra base gira más
  deprisa (sólo una observación larga sin superarla lo sugiere, con ruido); `AMBIGUOUS` si comparte ritmo con otra base.
- `VERSION_SIGNAL`: qué distingue esta versión de las otras del mismo arma (`SPEED`, `INTERVAL`, `INTERVAL_DEGRADED`,
  `HULL_DAMAGE`), o `—`.

| WEAPON_KIN | SPEED_MS | REACH_M | INTERVAL_TICKS | HULL_DAMAGE | IDENTITY_BY_SPEED | TURRET_RATE_RADS | IDENTITY_BY_TURRET | VERSION_SIGNAL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `weapon.cannon@1` | 120 | 360 | 30 / 51 / 120 | ammo.ap 37.8; ammo.he 28.35 | IDENTITY | 1 / 0.6 / 0.25 | EXCLUSION | — |
| `weapon.mg@1` | 200 | 600 | 6 / 12 / 24 | ammo.standard 8.4 | IDENTITY | 2.2 / 1.32 / 0.55 | IDENTITY | HULL_DAMAGE, INTERVAL_DEGRADED |
| `weapon.mg@2` | 200 | 600 | 6 / 9 / 21 | ammo.standard 12.6 | IDENTITY | 2.2 / 1.32 / 0.55 | IDENTITY | HULL_DAMAGE, INTERVAL_DEGRADED |

A pleno rendimiento la cadencia **no** distingue `weapon.mg@1` de `@2` (5 frente a 6 ticks de cooldown, pero el disparo
sólo se resuelve cada 3, así que las dos disparan cada 6); el daño sí, y con el arma dañada o crítica también la cadencia.

**La autoridad es la tabla calculada, no la prosa.** Las frases cuantitativas de este apartado (la cadencia de arriba, los
ejemplos) son explicación: lo que el test vigila son las columnas de `WEAPON_KIN`, calculadas con el catálogo y las
constantes reales, y la premisa del motor de que el disparo sólo se resuelve en ticks de decisión (`battle.ts`).

Atributos del proyectil revisados (qué distingue el arma, hoy y con un sprite futuro):

| ATTRIBUTE | HOY | ¿DISTINGUE EL ARMA? | REGLA PARA EL RENDERER |
| --- | --- | --- | --- |
| Velocidad | 120 m/s el cañón, 200 m/s la mg; el visor ya la estima (`ballistics.ts`) | SÍ, inequívoco con dos snapshots | Puede usarla para interpolar: no añade nada. |
| Tamaño | Mismo punto de ~4 px para todos (`PhaserViewer.ts`) | NO | Un tamaño por arma base no añade (ya es PUBLIC); por versión o por munición, sí: D-02/D-08. |
| Color | Un solo tinte `tracer` para todos (`art-direction.ts`) | NO | Igual que el tamaño. El color de equipo ya es público. |
| Cadencia | 30 ticks el cañón, 6 la mg (operational) | SÍ (arma); la versión, sólo con el arma dañada | Ninguna animación de recarga en vistas públicas: el cooldown restante es SELF_ONLY aunque sea deducible. |
| Daño visible | Variación del `hullHp` público | SÍ (arma y versión); ap/he con ruido (placa desconocida, área de HE) | No pintar «número de daño» por impacto mientras D-03 no lo decida. |
| Trayectoria | Recta; dispersión 0.01 rad el cañón, 0.05 rad la mg | SÍ, estadísticamente, con varios disparos | Pintar la recta del dato, sin estela que extrapole más allá. |
| Alcance | 360 m frente a 600 m en vuelo libre | SÍ, si no impacta antes | Retirar el sprite donde desaparece del snapshot (`ballistics.ts`). |
| Lifetime | 90 ticks para todos | NO por sí solo (con la velocidad, es el alcance) | — |
| Efectos | Fogonazo deducido de un proyectil nuevo (`effects.ts`); sin evento público de la explosión de HE | La explosión de HE, con ruido, por el daño de área a los vecinos | No pintar explosión de impacto por munición: exigiría publicar el tipo (D-02). |
| Sprite futuro | No existe | Por arma base: no añade; por versión o munición: añadiría | Hasta D-08, sprite por arma base como mucho. |

Combinaciones inequívocas hoy: la **velocidad sola** identifica el arma base; velocidad más punto de nacimiento, qué
vehículo; el daño en un sector sin placa, la versión de la mg. Antes del primer disparo, un giro de torreta más rápido
que el del cañón en el mismo estado identifica la mg (ENGINE_DERIVED, #262). Tamaño, color y lifetime no aportan nada.

### 12.3 Fugas entre vistas (CROSS_VIEW_LEAK)

Una vista privilegiada no puede ser la fuente de una vista con menos privilegio. Vistas: `PUBLIC_VIEW` (directo,
broadcast, replay público saneado, miniaturas), `ALLY_VIEW` (equipo), `OWNER_VIEW` (dueño: ficha, editor, su replay),
`RAW_REPLAY` (fichero crudo, restringido) y `INTERNAL_VIEW` (administración y depuración).

| CROSS_VIEW_ID | FROM_VIEW | TO_VIEW | VECTOR | RULE |
| --- | --- | --- | --- | --- |
| `cross.raw_replay` | RAW_REPLAY | PUBLIC_VIEW | El renderer público se alimenta del replay crudo (equipamiento, semilla, comandos) | Prohibido: el renderer público consume sólo la proyección saneada (PRE-1). H-05. |
| `cross.composition_cache` | OWNER_VIEW | PUBLIC_VIEW | Una composición del vehículo hecha para el dueño se cachea por bot y se sirve al público; o una composición hecha en otro estado de visibilidad (después de que el arma se revele, D-08) se sirve antes de la revelación, al buscar hacia atrás en un replay o en otra batalla del mismo bot | Caché intrínseca separada de la proyección por audiencia; nunca se cachea una composición privilegiada reutilizable. ProjectedComposition cache MUST NOT survive a visibility transition that changes what the viewer may observe. La clave proyectada lleva `visibilityStateVersion` (ADR-VIS-002, «Transiciones de visibilidad»). |
| `cross.thumbnail` | OWNER_VIEW | PUBLIC_VIEW | Miniaturas o imágenes de la ficha generadas con el equipamiento completo y usadas en listados públicos | Se generan desde la proyección pública, con su `visibilityProfile` en la clave. |
| `cross.team_capture` | ALLY_VIEW | PUBLIC_VIEW | El broadcast captura una vista de equipo (actividad de radio, niebla del equipo) | El streamer captura sólo `PUBLIC_VIEW`. |
| `cross.debug_overlay` | INTERNAL_VIEW | PUBLIC_VIEW | Overlays de depuración (rayos, alcances, contactos) activables en el visor público; y, latente, el flag `debugOpen` del formato de replay, con el que un segmento llevaría los comandos de todos los participantes | No existen en la vista pública; su activación la autoriza el backend, no un flag de cliente. Una vista pública no recibe comandos ni observaciones ajenas aunque `debugOpen` esté activo (PRE-1). |
| `cross.owner_to_rival` | OWNER_VIEW | PUBLIC_VIEW | El perfil del dueño se resuelve por rol y no por pareja: el dueño de A ve también el vehículo rival B con SELF_ONLY, o una composición de dueño cacheada se sirve a otro dueño; en un replay crudo con varios participantes, «RAW_REPLAY ⇒ dueño» daría al dueño de A lo privado de B | Prohibido: el perfil se resuelve por pareja (visor, vehículo observado) y para los vehículos ajenos sólo llega la proyección saneada; el dueño de A ve B con el perfil público y el backend autoriza cada pareja (ADR-VIS-002, «Proyección por pareja»; PRE-1). |
| `cross.client_payload` | OWNER_VIEW | PUBLIC_VIEW | El cliente público recibe datos que no pinta (ocultos por CSS o por el renderer) | El frontend no es un control: lo que una audiencia no debe ver no se le envía. |

### 12.4 Fugas del motor (ENGINE_DERIVED)

Inferencias que permite **el motor** con lo que ya publica, sin que intervenga el renderer. La FASE 0 no las corrige: las
documenta, las ata a su issue y fija qué hace la capa visual para no amplificarlas. Cada issue describe la clase del
problema; este documento no da pasos para explotarlas.

| ENGINE_LEAK_ID | ISSUE | CLASS_OF_PROBLEM | DATA_IDS | DOMAIN_IDS | VISUAL_RULE |
| --- | --- | --- | --- | --- | --- |
| `engine.entity_identity_order` | #261 | La identidad u orden públicos de las entidades permite inferir despliegues no visibles (instante y posición de una mina, y con ello las cargas que quedan) | `data.mine_bay_contents`, `data.mine_position` | `mine.explosive@1`, `runtime.mine_deployed` | El renderer no pinta minas no públicas, no numera ni ordena entidades por su id y no deriva nada de los huecos o del orden de los ids. |
| `engine.turret_kinematics` | #262 | La cinemática pública de la torreta (ritmo de giro y precisión de `turretHeading`) permite inferir el arma antes del primer disparo | `data.full_loadout`, `data.module_identity`, `data.weapon_identity` | `runtime.turret`, `weapon.cannon@1`, `weapon.mg@1`, `weapon.mg@2` | La torreta gira con el `turretHeading` público, sin suavizado que cambie el ritmo; el sprite del arma no se anticipa a la inferencia (genérico hasta el primer disparo, D-08). |
| `engine.damage_response` | #263 | La respuesta pública al daño (variación exacta de `hullHp`) permite inferir el material del blindaje del sector | `data.armor_material`, `data.armor_sector_hp`, `data.full_loadout`, `data.hit_details`, `data.module_identity` | `armor.composite_front@1`, `armor.composite_left@1`, `armor.composite_rear@1`, `armor.composite_right@1`, `armor.steel_front@1`, `armor.steel_left@1`, `armor.steel_rear@1`, `armor.steel_right@1` | Placa genérica (sin acabado por material) en vistas públicas mientras D-01 no lo decida; ningún «número de daño» por impacto (D-03). |

Los `DATA_IDS` de cada fila son exactamente los de §12 cuya columna `ENGINE_DERIVED` cita esa issue, y los `DOMAIN_IDS`
los de §5 y §6 cuyo WHY la cita; el test lo comprueba en los dos sentidos.

## 13. Estados visuales

| STATE | STATUS | CODE_REFERENCE | NOTES |
| --- | --- | --- | --- |
| healthy | CURRENT | `MODULE_STATES` «operational» (`packages/game-rules/constants.ts`); casco > 60 % sin humo (`damage-visuals.ts`) | Por módulo y por casco. |
| damaged | CURRENT | `stateFromHealth` < 0.66 (`packages/game-rules/index.ts`); humo de casco (`smokeLevel`) | Los tramos de vida del vehículo del MASTER-PLAN §12 (>70/30-70/<30) NO existen en código. |
| critical | CURRENT | `stateFromHealth` < 0.33 y fallo intermitente `moduleActs` (`packages/game-rules/index.ts`), aplicado en `sensors.ts` | Sólo a nivel de módulo. |
| destroyed | CURRENT | `stateFromHealth` ≤ 0 → «destroyed»; `turretLocked`/`mobilityCrippled` (`damage-visuals.ts`) | Blindaje: nunca por daño (H-01). |
| offline | CURRENT | `ModuleRuntime.offline`, `Vehicle.stateOf` (`vehicle.ts`); snapshot `modules[].state` | Apagado voluntario, público hoy (D-04). |
| firing | CURRENT | Deducido de proyectil nuevo: `EffectsSystem.ingestProjectiles` (`apps/web/src/viewer/effects.ts`) | No hay evento de disparo en el motor; el dato no trae el vehículo, pero se atribuye por inferencia (§12.2). |
| reloading | FUTURE | Cooldown sólo en la observación privada (`sensors.ts`) | SELF_ONLY: no en vistas públicas. |
| out_of_ammo | FUTURE | Munición sólo en la observación privada; rechazo `no_ammo` privado | SELF_ONLY. |
| engine_active | FUTURE | Sin campo público; `lastMove.throttle` interno (`battle.ts`, sonido «engine») | Lo derivable del movimiento es PUBLIC (`data.engine_activity`); el acelerador sin movimiento, no (`data.engine_throttle`). |
| radio_active | FUTURE | Sin evento público; entrega sólo al equipo (`radioDeliverableTo`) | ALLY_ONLY. |
| sensor_active | FUTURE | Sólo el `state` del módulo es público; la actividad por ciclo es interna | |
| carrying_flag | CURRENT | snapshot `carryingFlag` (`battle.ts`); sprite `flag` (`PhaserViewer.ts`) | |
| destroyed_vehicle | CURRENT | snapshot `alive=false`; evento `vehicle_destroyed`; alfa 0.25 + explosión (`PhaserViewer.ts`, `effects.ts`) | |

## 14. Hallazgos y decisiones de producto pendientes

Hallazgos (hechos del repo, documentados sin cambiar nada):

- **H-01** — el blindaje no cambia de estado público por daño (ver inventario §6).
- **H-02** — la nómina en directo sólo trae el chasis; el snapshot no trae `moduleId`.
- **H-03** — la cabecera del replay sí lleva el equipamiento completo (`participants[].spec`).
- **H-04** — el snapshot público lista sólo las ranuras con módulo, con su estado. Junto con el chasis de la nómina y
  el catálogo, eso revela **qué** lleva el vehículo cuando la ranura admite un único módulo base: hoy, la mina
  (`mine_bay`), la radio (`radio_a`) y, en el ligero, la tracción (`drive`), el arma (`turret_main`) y el tipo de
  munición; y revela siempre la **presencia** de munición y de energía (§12.1). No es sólo «que lleva algo».
  La cinemática de los proyectiles amplía esta fuga a cualquier chasis en cuanto dispara: H-07.
- **H-05** — **el fichero de replay crudo se entrega sin proyección.** `getReplay` (`apps/api/src/routes/replays.ts`) y
  la descarga del replay público (`apps/api/src/routes/battles.ts`) envían el fichero tal cual. Ese fichero
  (`apps/arena-engine/src/replay.ts`, `replayFromBattle`) lleva:
  - la `seed` de la batalla;
  - `participants[].spec`: el equipamiento completo de cada bot, con ids versionados;
  - todos los comandos (`cmd`) tal como los entregó cada bot (`battle.ts`, `replayCommands`), incluidos `radio[].data`
    (contenido de los mensajes, `command.schema.json`) y `deployMine`;
  - además de los snapshots y eventos públicos.

  Con semilla y comandos, `verify()` re-simula la batalla entera, así que quien lea el fichero crudo puede reconstruir
  después de la batalla el contenido de la radio de cada bot, la posición de sus minas y sus observaciones privadas.
  Quién puede leerlo lo decide la política de acceso a replays (PRE-1); este contrato no describe el estado de acceso
  actual ni sus vías. Que el acceso anónimo dependa de una capability apagada por defecto **no** es la solución: el
  contrato tiene que ser seguro con ella activa. Las clases de §12 valen para el canal público y la proyección saneada,
  no para este fichero.
  Es la clase de problema «artefacto crudo servido sin proyección por audiencia»: **PRE-1, hallazgo de seguridad
  preexistente**. Su política ya está decidida (replay público = proyección saneada de competición; replay crudo =
  restringido, con autorización en el backend; §12) y su arreglo de backend va en otro PR contra `main`. Este PR sólo
  fija sus implicaciones visuales: el renderer público no consume nunca el crudo (§12, §12.3 `cross.raw_replay`).

- **H-06** — `visual-bots/MASTER-PLAN.md` no estaba enlazado desde `docs/README.md`: el test de alcanzabilidad
  `tests/acceptance/doc-c-integracion-docs.test.ts` fallaba ya en la base `983d2f5`. **Resuelto en esta fase** con una
  línea en `docs/README.md` que enlaza `visual-bots/`; el MASTER-PLAN enlaza los seis entregables desde su §22. Esa suite
  no corre en la CI de PR (sólo en la nocturna).
- **H-07** — **el arma es pública por cinemática.** Aunque el snapshot no trae ni el arma ni el dueño del proyectil, su
  `id` estable, su velocidad (la `projectileSpeedMs` del arma) y su nacimiento en la boca del vehículo que dispara
  identifican el arma base y el tirador desde el primer disparo, en cualquier chasis; el daño al casco público delata la
  versión de la mg y, con ruido, la munición del cañón (§12.2, calculado por el test). Es la misma clase que H-04 en
  dinámico: DERIVED_LEAK. Esta fase no toca el motor.

- **H-08** — **fugas del motor (ENGINE_DERIVED).** Además de H-04 y H-07, el motor deja inferir con lo que ya publica:
  despliegues de minas no visibles por la identidad u orden de las entidades públicas (#261), el arma antes del primer
  disparo por la cinemática de la torreta (#262) y el material del blindaje por la respuesta al daño (#263). Son
  `ENGINE_INFORMATION_LEAK`, no fugas del contrato visual: se documentan en §12.4 con su issue, y la capa visual se
  compromete a no amplificarlas. Esta fase no toca el motor.

Decisiones que necesitan validación de producto:

- **D-01 · ¿Se enseña el equipamiento en directo y en broadcast?** `COMPETITION_NOTE` (`apps/web/src/visibility.tsx`)
  dice que en una competición pública sólo se muestran nombre, versión, equipo y resultado. Pintar arma, sensores o
  blindaje en el visor público choca con esa frase, y además exige publicar `moduleId` en la nómina (H-02). Opciones:
  (a) sólo chasis en directo y equipamiento completo en ficha/replay; (b) equipamiento «físicamente visible» en directo
  y cambiar la nota; (c) según BOT_VISIBILITY de cada bot. Hasta decidir, todo lo marcado OBSERVER_DEPENDENT se
  trata como **no visible** en vistas públicas en directo.
- **D-02 · ¿Proyectil distinto por arma o munición?** Por arma base no añade información (ya es PUBLIC por inferencia
  tras el primer disparo, H-07). Por munición o versión sí: exigiría publicar el tipo (cambio de motor, fuera de esta
  fase).
- **D-03 · ¿Vida exacta en público?** Hoy el HUD la enseña. El MASTER-PLAN propone tramos para el renderer.
- **D-04 · ¿Debe ser público el `offline` voluntario?** Hoy lo es (snapshot) y delata una decisión táctica.
- **D-07 · ¿Debe el snapshot omitir las ranuras de módulos internos u ocultos?** Hoy el snapshot lista sólo las ranuras
  ocupadas y eso ya publica, por inferencia, la presencia de minas, munición y energía y la identidad de la radio y del
  equipo del ligero (H-04, §12.1). Opciones: (a) aceptarlo y documentarlo como público; (b) listar siempre todas las
  ranuras del chasis, ocupadas o no; (c) omitir del snapshot público las ranuras internas (`power`, `ammo_main`,
  `mine_bay`) y publicar sólo su estado agregado. Es una fuga **ya existente**: esta fase sólo la documenta y no toca
  el motor. Hasta decidir, el renderer trata como PUBLIC lo que §12.1 marca como inferible.
- **D-08 · ¿Qué resolución deben tener los proyectiles públicos?** Hoy el `id` estable, la posición exacta cada 3 ticks
  y el `hullHp` exacto bastan para saber arma, tirador, versión y, con ruido, munición, rondas y cooldown (H-07, §12.2).
  Opciones: (a) aceptarlo y documentar el arma como PUBLIC tras el primer disparo; (b) reducir la resolución pública
  (ids no correlacionables entre snapshots, posición cuantizada, velocidades iguales); (c) publicar el arma de forma
  explícita y dejar de fingir que es privada. Es una fuga **ya existente**; esta fase no cambia las reglas. Hasta
  decidir: el renderer trata el arma como PUBLIC desde el primer disparo y, antes, como OBSERVER_DEPENDENT, aunque el
  motor ya la deje inferir antes por el giro de la torreta (ENGINE_DERIVED, #262: el renderer no se adelanta a esa
  inferencia); no calcula ni pinta lo PARTIAL de §12 (cooldown, rondas, munición) y no distingue en el sprite ni la
  versión ni la munición. Ese primer disparo es una **transición de visibilidad** dentro de la batalla: la composición
  pública de antes («torreta genérica») y la de después («cañón») tienen `visibilityStateVersion` distinto y son
  entradas distintas de la caché proyectada; ninguna sobrevive a la transición (ADR-VIS-002, `reveal.weapon`).
- **D-05 · Arquetipo frente a versión.** El visor actual agrupa por chasis (`chassisKind`): dos versiones del mismo
  chasis se ven iguales. Se propone mantenerlo (la versión cambia balance, no forma).
