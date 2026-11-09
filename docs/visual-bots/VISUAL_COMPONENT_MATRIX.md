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

**VISIBILITY_CLASS** (en las tablas de decisión) clasifica **la presencia/identidad** del componente con las clases de §12.

## 5. Decisión por componente del catálogo

| DOMAIN_ID | DECISION | VISIBILITY_CLASS | WHY |
| --- | --- | --- | --- |
| `chassis.light@1` | MUST_RENDER | PUBLIC | Identidad base del bot; el chasis ya es público (`roster.chassis`). |
| `chassis.light@2` | MUST_RENDER | PUBLIC | Igual que @1; misma forma, otra versión de balance. |
| `chassis.medium@1` | MUST_RENDER | PUBLIC | Identidad base. |
| `chassis.medium@2` | MUST_RENDER | PUBLIC | Igual que @1. |
| `chassis.heavy@1` | MUST_RENDER | PUBLIC | Identidad base. |
| `weapon.cannon@1` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal (PRD-01). Físicamente visible, pero hoy NO se publica qué arma lleva cada vehículo (ver §14, D-01). |
| `weapon.mg@1` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal. |
| `weapon.mg@2` | MUST_RENDER | OBSERVER_DEPENDENT | Arma principal; misma forma que @1. |
| `armor.steel_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa visible; dice qué sectores protege. Sin estado de daño público (H-01). |
| `armor.steel_left@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. |
| `armor.steel_right@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible (mirror de left). |
| `armor.steel_rear@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa trasera visible. |
| `armor.composite_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa visible; acabado distinto del acero. |
| `armor.composite_left@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. |
| `armor.composite_right@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa lateral visible. |
| `armor.composite_rear@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Placa trasera visible. |
| `movement.tracks@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Muy reconocible (orugas frente a ruedas); su estado público (`drive`) ya existe. |
| `movement.wheels@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Muy reconocible. |
| `sensor.lidar360@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Cúpula superior visible. |
| `sensor.radar@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Antena visible. |
| `sensor.lidar_front@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Lente frontal visible; orientada con el casco. |
| `sensor.proximity@1` | MAY_RENDER | OBSERVER_DEPENDENT | Pequeño; su forma no debe sugerir alcance ni detección (§7). |
| `sensor.acoustic@1` | MAY_RENDER | OBSERVER_DEPENDENT | Pequeño y pasivo; nunca animado (§7). |
| `radio.short@1` | SHOULD_RENDER | OBSERVER_DEPENDENT | Antena visible. Que transmita es ALLY_ONLY (§12). |
| `power.battery@1` | DO_NOT_RENDER | SELF_ONLY | Interno; el estado energético es privado del bot. Ficha: sólo texto/icono. |
| `power.generator@1` | DO_NOT_RENDER | SELF_ONLY | Interno. |
| `power.generator@2` | DO_NOT_RENDER | SELF_ONLY | Interno. |
| `ammo.standard@1` | DO_NOT_RENDER | SELF_ONLY | Cargador interno; tipo y munición restante son privados. |
| `ammo.ap@1` | DO_NOT_RENDER | SELF_ONLY | Interno. Variante de proyectil = futuro, sujeta a D-02. |
| `ammo.he@1` | DO_NOT_RENDER | SELF_ONLY | Interno. |
| `mine.explosive@1` | DO_NOT_RENDER | SELF_ONLY | Lo que hay en la bahía y las cargas que quedan son privados; como mucho, una compuerta genérica en la ficha (MAY). |

## 6. Decisión por elemento de batalla (runtime)

| DOMAIN_ID | DECISION | VISIBILITY_CLASS | WHY |
| --- | --- | --- | --- |
| `runtime.turret` | MUST_RENDER | PUBLIC | `turretHeading` es público y ya se pinta; soporte del arma. |
| `runtime.projectile` | MUST_RENDER | PUBLIC | Posición pública en el snapshot; ya se pinta. |
| `runtime.muzzle_flash` | SHOULD_RENDER | PUBLIC | Deducido de un proyectil nuevo (dato público). |
| `runtime.mine_deployed` | DO_NOT_RENDER | SELF_ONLY | El motor la oculta del snapshot público («información oculta hasta que explotan», battle.ts). |
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
a `radiusM + 0.3` m del centro a lo largo de `turretHeading` (`battle.ts`); el proyectil vive 90 ticks; el snapshot
público no dice qué arma disparó.

| WEAPON_ID | VERSIONS | MOUNT_TYPE | ORIENTATION_REQUIRED | TURRET_OR_HULL | PROJECTILE_VISUAL_RELEVANCE | MUZZLE_FLASH_POSSIBLE | RELOAD_COOLDOWN_VISUAL_RELEVANCE | AMMO_VISUAL_RELEVANCE | DESTROYED_STATE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `weapon.cannon` | @1 | `weapon.primary` (sólo `turret_main` L/XL: chasis medio y pesado) | SÍ (`turretHeading`) | Torreta, 360° | ALTA: 120 m/s, ~1 disparo/s; un proyectil público por disparo | SÍ (boca a `radiusM + 0.3` m) | Baja en público: el cooldown es SELF_ONLY; sólo vista SELF | Baja en público: tipo y rondas SELF_ONLY; ap/he no se distinguen en el snapshot | Cañón caído/atenuado y torreta bloqueada (el `turretLocked` actual: alfa 0.4, sin giro) |
| `weapon.mg` | @1, @2 | `weapon.primary` (`turret_main` M o mayor: los tres chasis) | SÍ (`turretHeading`) | Torreta, 360° | ALTA: 200 m/s, 5-6 disparos/s; ojo con el coste de partículas (§11) | SÍ (fogonazo pequeño y frecuente) | Baja en público (SELF_ONLY) | Baja en público (SELF_ONLY) | Igual que el cañón |

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
  observación). En público sólo existe el proyectil, sin tipo. Distinguir AP/HE en el proyectil exigiría publicar el
  tipo: decisión de producto (D-02), no de esta fase.
- **Radio.** La antena (presencia) es OBSERVER_DEPENDENT. La actividad no tiene evento público: los mensajes sólo se
  entregan al propio equipo (`radioDeliverableTo`). Un pulso de «transmitiendo» en el broadcast revelaría al rival el
  ritmo de comunicación del equipo: **ALLY_ONLY**, nunca en vistas públicas en directo. El contenido es NEVER_VISUALIZE.
- **Minas.** Las desplegadas no están en el snapshot público y sólo el dueño recibe `mine_deployed`; el único hecho
  público es `mine_triggered` (posición de la explosión). Cargas restantes y contenido de la bahía: SELF_ONLY.

## 11. Qué datos tiene hoy cada contexto

| Contexto | Datos disponibles hoy | Render actual |
| --- | --- | --- |
| Ficha de bot | Loadout de la versión (API), según BOT_VISIBILITY (`private/team/public`) | React DOM, **sin** representación gráfica (`BotDetailPage.tsx`) |
| Editor de loadout | Catálogo + loadout en edición (dueño) | React DOM, **sin** representación gráfica (`LoadoutEditor.tsx`) |
| Mapa en directo | `init.meta.roster` (id, bot, equipo, **chasis**, nombre) + snapshots públicos + eventos públicos, con el retardo anti-coaching del ruleset | Phaser 3, atlas procedural de UNA textura, `setTint` por equipo (`atlas.ts`, `PhaserViewer.ts`) |
| Replay | Cabecera con `participants[].spec` (equipamiento completo) + snapshots + eventos públicos; el índice da al visor sólo chasis y nombre | El mismo visor Phaser |
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

| DATA_ID | DATA | CLASSIFICATION | SOURCE | NOTES |
| --- | --- | --- | --- | --- |
| `data.chassis_identity` | Chasis del vehículo | PUBLIC | `init.meta.roster.chassis`; cabecera del replay | Ya se pinta por arquetipo. |
| `data.team_identity` | Equipo | PUBLIC | snapshot `team`, nómina | |
| `data.bot_name` | Nombre del bot | PUBLIC | nómina | COMPETITION_NOTE lo permite. |
| `data.pose` | Posición y rumbo del casco | PUBLIC | snapshot `position`, `heading` | La vista con niebla del espectador es una aproximación por radio (`fog.ts`). |
| `data.turret_heading` | Rumbo de la torreta | PUBLIC | snapshot `turretHeading` | |
| `data.hull_hp_exact` | Vida exacta del casco | PUBLIC | snapshot `hullHp`, `hullHpMax` (el HUD lo enseña) | Hoy es pública. Propuesta: el renderer del vehículo usa tramos; mantener o no la cifra exacta en el HUD es D-03. |
| `data.module_state` | Estado de cada ranura (operational/damaged/critical/destroyed/offline) | PUBLIC | snapshot `modules[].state` | Incluye `offline` (apagado voluntario): ver D-04. |
| `data.module_health_exact` | Fracción de vida exacta de cada módulo | SELF_ONLY | observación `self.modules[].healthFraction` | No está en el snapshot. |
| `data.armor_sector_hp` | Vida de blindaje por sector | SELF_ONLY | observación `self.armor` | Ni siquiera en el snapshot público (sólo en el hash). |
| `data.module_identity` | Qué módulo concreto hay en cada ranura | OBSERVER_DEPENDENT | loadout (ficha); cabecera del replay | Hoy NO viaja en el directo. Ver D-01 y H-05. |
| `data.sensor_installed` | Que un sensor está montado, y cuál | OBSERVER_DEPENDENT | ranura en el snapshot (`sensor_a/b`) + identidad (D-01) | La presencia de la ranura ya es pública; el tipo, no. |
| `data.sensor_destroyed` | Sensor destruido | PUBLIC | snapshot `modules[].state = destroyed` | |
| `data.radar_operating` | Radar funcionando (no destruido ni apagado) | PUBLIC | derivado de `modules[].state` | Si en un ciclo concreto dio lectura (`moduleActs`) es interno: ver `data.sensor_cycle_output`. |
| `data.sensor_cycle_output` | Si el sensor produjo lectura en un ciclo | NEVER_VISUALIZE | `moduleActs` en `sensors.ts` | |
| `data.sensor_readings` | Rayos, contactos, rumbos, sonidos percibidos | NEVER_VISUALIZE | `buildObservation` (`sensors.ts`) | Es la observación privada del bot. |
| `data.sensor_range_fov` | Alcance y cono de un sensor concreto dibujados sobre ese bot | OBSERVER_DEPENDENT | catálogo (público) + identidad (D-01) | Dibujarlo sobre un bot revela su capacidad real; nunca en directo público mientras D-01 no lo permita. |
| `data.radio_installed` | Lleva radio (antena) | OBSERVER_DEPENDENT | ranura `radio_a` en el snapshot + identidad | |
| `data.radio_active` | Está transmitiendo | ALLY_ONLY | cola de radio del motor; sin evento público | Nunca en directo público. |
| `data.radio_content` | Contenido de los mensajes | NEVER_VISUALIZE | `RadioMessage.data` | |
| `data.ammo_type` | Tipo de munición | SELF_ONLY | loadout / spec | |
| `data.ammo_remaining` | Munición restante | SELF_ONLY | observación `self.modules[].ammo` | MASTER-PLAN §13: «no por defecto». |
| `data.out_of_ammo` | Sin munición | SELF_ONLY | rechazo privado `no_ammo` | |
| `data.weapon_cooldown` | Cooldown / recarga | SELF_ONLY | observación `self.modules[].cooldownTicks` | |
| `data.firing` | Ha disparado | PUBLIC | proyectil nuevo en el snapshot | Sin atribución al vehículo en el dato. |
| `data.projectile_origin` | Qué arma o munición disparó el proyectil | OBSERVER_DEPENDENT | no se publica hoy | Exigiría cambiar el snapshot (fuera de fase). D-02. |
| `data.energy_state` | Energía almacenada y flujo | SELF_ONLY | observación `self.energy` | |
| `data.mine_bay_contents` | Mina en la bahía y cargas restantes | SELF_ONLY | observación `self.modules[].ammo` (cargas) | La ranura `mine_bay` sí aparece en el snapshot (H-04). |
| `data.mine_position` | Posición de una mina desplegada | SELF_ONLY | evento privado `mine_deployed` | Excluida del snapshot público por diseño. |
| `data.mine_triggered` | Explosión de mina | PUBLIC | evento público `mine_triggered` | |
| `data.carrying_flag` | Lleva la bandera | PUBLIC | snapshot `carryingFlag` | |
| `data.juggernaut` | Es el juggernaut | PUBLIC | snapshot `juggernaut` | |
| `data.vehicle_alive` | Vivo o destruido | PUBLIC | snapshot `alive`, evento `vehicle_destroyed` | |
| `data.respawns_left` | Reapariciones restantes | PUBLIC | snapshot `respawnsLeft` (sólo con respawn limitado) | |
| `data.engine_activity` | Motor acelerando | OBSERVER_DEPENDENT | no se publica; derivable del cambio de posición | El sonido de motor del motor de juego es interno (sólo lo oye el acústico). |
| `data.hit_details` | Sector impactado, daño recibido, atacante | SELF_ONLY | eventos privados `hit_taken` / `hit_dealt` | |
| `data.full_loadout` | Ficha completa del bot | OBSERVER_DEPENDENT | API, según BOT_VISIBILITY | |

## 13. Estados visuales

| STATE | STATUS | CODE_REFERENCE | NOTES |
| --- | --- | --- | --- |
| healthy | CURRENT | `MODULE_STATES` «operational» (`packages/game-rules/constants.ts`); casco > 60 % sin humo (`damage-visuals.ts`) | Por módulo y por casco. |
| damaged | CURRENT | `stateFromHealth` < 0.66 (`packages/game-rules/index.ts`); humo de casco (`smokeLevel`) | Los tramos de vida del vehículo del MASTER-PLAN §12 (>70/30-70/<30) NO existen en código. |
| critical | CURRENT | `stateFromHealth` < 0.33; fallo intermitente `moduleActs` | Sólo a nivel de módulo. |
| destroyed | CURRENT | `stateFromHealth` ≤ 0 → «destroyed»; `turretLocked`/`mobilityCrippled` (`damage-visuals.ts`) | Blindaje: nunca por daño (H-01). |
| offline | CURRENT | `ModuleRuntime.offline`, `Vehicle.stateOf` (`vehicle.ts`); snapshot `modules[].state` | Apagado voluntario, público hoy (D-04). |
| firing | CURRENT | Deducido de proyectil nuevo: `EffectsSystem.ingestProjectiles` (`apps/web/src/viewer/effects.ts`) | No hay evento de disparo en el motor; no se atribuye al vehículo. |
| reloading | FUTURE | Cooldown sólo en la observación privada (`sensors.ts`) | SELF_ONLY: no en vistas públicas. |
| out_of_ammo | FUTURE | Munición sólo en la observación privada; rechazo `no_ammo` privado | SELF_ONLY. |
| engine_active | FUTURE | Sin campo público; `lastMove.throttle` interno (`battle.ts`, sonido «engine») | Derivable del movimiento. |
| radio_active | FUTURE | Sin evento público; entrega sólo al equipo (`radioDeliverableTo`) | ALLY_ONLY. |
| sensor_active | FUTURE | Sólo el `state` del módulo es público; la actividad por ciclo es interna | |
| carrying_flag | CURRENT | snapshot `carryingFlag` (`battle.ts`); sprite `flag` (`PhaserViewer.ts`) | |
| destroyed_vehicle | CURRENT | snapshot `alive=false`; evento `vehicle_destroyed`; alfa 0.25 + explosión (`PhaserViewer.ts`, `effects.ts`) | |

## 14. Hallazgos y decisiones de producto pendientes

Hallazgos (hechos del repo, documentados sin cambiar nada):

- **H-01** — el blindaje no cambia de estado público por daño (ver inventario §6).
- **H-02** — la nómina en directo sólo trae el chasis; el snapshot no trae `moduleId`.
- **H-03** — la cabecera del replay sí lleva el equipamiento completo (`participants[].spec`).
- **H-04** — el snapshot revela qué ranuras hay ocupadas (p. ej. `mine_bay`, `sensor_b`) y su estado.
- **H-05** — `GET /api/v1/replays/{battleId}` (`getReplay`) entrega el fichero de replay entero a quien pueda leerlo
  (incluido un anónimo si los replays públicos están activados), y ese fichero lleva el equipamiento y los comandos de
  cada participante. El equipamiento ya es, de hecho, visible después de la batalla para quien puede leer el replay.
- **H-06** — `visual-bots/MASTER-PLAN.md` no está enlazado desde `docs/README.md`: el test de alcanzabilidad
  `tests/acceptance/doc-c-integracion-docs.test.ts` falla en la base `983d2f5` (antes de esta fase). Arreglarlo exige
  tocar `docs/README.md`, fuera del ámbito `docs/visual-bots/**`.

Decisiones que necesitan validación de producto:

- **D-01 · ¿Se enseña el equipamiento en directo y en broadcast?** `COMPETITION_NOTE` (`apps/web/src/visibility.tsx`)
  dice que en una competición pública sólo se muestran nombre, versión, equipo y resultado. Pintar arma, sensores o
  blindaje en el visor público choca con esa frase, y además exige publicar `moduleId` en la nómina (H-02). Opciones:
  (a) sólo chasis en directo y equipamiento completo en ficha/replay; (b) equipamiento «físicamente visible» en directo
  y cambiar la nota; (c) según BOT_VISIBILITY de cada bot. Hasta decidir, todo lo marcado OBSERVER_DEPENDENT se
  trata como **no visible** en vistas públicas en directo.
- **D-02 · ¿Proyectil distinto por arma o munición?** Exige añadir dueño o tipo al proyectil público (cambio de motor,
  fuera de esta fase).
- **D-03 · ¿Vida exacta en público?** Hoy el HUD la enseña. El MASTER-PLAN propone tramos para el renderer.
- **D-04 · ¿Debe ser público el `offline` voluntario?** Hoy lo es (snapshot) y delata una decisión táctica.
- **D-05 · Arquetipo frente a versión.** El visor actual agrupa por chasis (`chassisKind`): dos versiones del mismo
  chasis se ven iguales. Se propone mantenerlo (la versión cambia balance, no forma).
