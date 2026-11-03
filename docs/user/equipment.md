# Equipamiento (loadout)

El **loadout** es el vehículo de tu bot: un **chasis** y una **pieza por ranura** (movimiento, energía, sensores, arma con su munición, minas, radio y blindaje por lado). Lo configuras en el **«Editor de loadout»** de «Mis bots», que calcula el coste y la energía en directo; el servidor lo vuelve a validar al guardar. Cada guardado crea una **revisión** nueva.

**El loadout es el vehículo que juega**: el chasis y las piezas que eliges son los que se simulan en las batallas y en la partida de prueba de la validación. Cada versión de código queda ligada a la revisión con la que la subiste; guardar una revisión nueva no cambia las versiones ya subidas.

Todas las piezas, con sus cifras exactas, están en el **[Catálogo de equipamiento](equipment-catalog.md)**, que se genera del propio catálogo del juego.

## Cómo se usa el editor

1. «Mis bots» → pulsa el nombre del bot → «Editor de loadout».
2. Elige el **chasis**: aparecen sus ranuras.
3. En cada ranura elige una pieza. Si eliges un arma, aparece el selector de **munición compatible**.
4. Vigila **«Coste: X/1000 cr»** y **«Energía: ±N»**. Los problemas aparecen debajo, con el motivo.
5. Pulsa **«Guardar revisión»**: verás «Revisión de loadout guardada.». Al volver, el editor carga la revisión vigente y muestra los «Cambios respecto a la revisión N».
6. Para que una versión de código juegue con la revisión nueva, sube una versión nueva: la subida usa la revisión vigente.

Junto a la masa total, el editor muestra la **carga de piezas** frente al límite del chasis. Si la sesión caduca mientras editas, al volver se recuperan los cambios sin guardar de esa pestaña.

## Las ranuras

Cada ranura es un hueco para una categoría de pieza, con un tamaño máximo (S pequeño, M mediano, L grande, XL muy grande):

| Ranura | Para qué |
|---|---|
| Propulsión | Orugas o ruedas: velocidad máxima, aceleración y giro. |
| Energía | Generador o batería que alimenta sensores, armas y radio. |
| Sensor A / Sensor B | Lo que el bot ve (radar, lidar, acústico, proximidad). El Sensor B sólo existe en el chasis pesado. |
| Torreta principal | El arma. |
| Munición principal | La munición del arma. |
| Compartimento de minas | Minas. Sólo en chasis medio y pesado. |
| Radio | Enviar mensajes al resto del equipo. |
| Blindaje frontal / izquierdo / derecho / trasero | Reducen el daño por ese lado. |

El nombre que usa **tu código** para cada ranura es su identificador (`turret_main`, `sensor_a`, `radio_a`…): lo ves en el mensaje de bienvenida, en `welcome.vehicle.modules`. Ver [Guía de programación](bots/ciclo.md#el-mensaje-de-bienvenida-welcome).

## Qué cambia de verdad en la batalla

Junto a cada ranura y a cada propiedad, el editor muestra una insignia:

| Insignia | Significa |
|---|---|
| **ACTIVE · cambia la batalla** | El motor usa el valor de la pieza que eliges. |
| **PARTIAL · efecto parcial** | Sólo cuenta para validar el loadout (coste, tamaño, carga máxima, límites por vehículo). |
| **FUTURE · sin efecto en batalla** | Ningún código lo usa todavía: no cambia nada. |

Al elegir una pieza, «Efecto real de cada propiedad» lista sus datos con su insignia. El catálogo declara datos que **todavía no hacen nada** (el alcance del arma, el alcance de la radio, el terreno, las utilidades): la [lista actualizada](equipment-catalog.md#datos-que-no-cambian-la-batalla) está al final del catálogo.

## Presupuesto, peso y energía

- **Presupuesto.** Cada pieza cuesta créditos y la suma no puede pasar del presupuesto de la batalla (1000 créditos en una práctica por defecto). Las reglas de un torneo o de una batalla personalizada pueden fijar otro, y ninguna pieza puede costar más del 35 % del presupuesto.
- **Peso.** Las piezas no pueden superar la carga máxima del chasis. Pasarte de la **carga nominal** del movimiento te frena.
- **Energía.** Todo consume energía (EU) cada segundo, y disparar o soltar minas gasta más. Si el consumo supera a la generación, te quedas sin energía para disparar.

## Equipamientos de referencia

Cuatro combinaciones válidas que usan los bots de ejemplo (y el simulador local):

| Equipamiento | Chasis | Idea | Coste |
|---|---|---|---|
| Explorador (`scout`) | Ligero | Rápido, lidar frontal, ametralladora, radio. | 540 |
| Artillero (`gunner`) | Medio | Radar y cañón con blindaje frontal. | 940 |
| Minador (`miner`) | Medio | Siembra minas, ametralladora de apoyo. | 780 |
| Pesado (`heavy`) | Pesado | Lidar 360, cañón, mucho casco, muy lento. | 970 |

## Reglas de validación

| Mensaje (código) | Causa |
|---|---|
| `budget_exceeded` | El total supera el presupuesto. |
| `module_cost_cap_exceeded` | Una sola pieza cuesta más del 35 % del presupuesto. |
| `mass_exceeded` | Las piezas pesan más que la carga máxima del chasis. |
| `energy_deficit` | El consumo supera a la generación. |
| `unknown_slot` | La ranura no existe en ese chasis (por ejemplo, minas en un chasis ligero). |
| `slot_type_mismatch` / `slot_size_exceeded` | Pieza de otro tipo, o demasiado grande para la ranura. |
| `incompatible_ammo` | Un arma no tiene munición que pueda disparar (ninguna o de otro tipo), o hay munición que ningún arma usa. El mensaje dice qué municiones admite el arma. |
| `duplicate_limit_exceeded` | Más unidades de las permitidas de una pieza (por ejemplo, un lidar 360 por vehículo). |

## Consejos para elegir

- **Sin sensores no ves nada.** Un bot sin sensor no puede apuntar a nadie; elige al menos uno ([Sensores](bots/sensores.md)).
- **Radar o lidar.** El radar tiene más alcance pero da la posición con error; el lidar es exacto pero de menor alcance y no distingue bandos. Para esquivar muros, el lidar.
- **Cañón o ametralladora.** El cañón hace mucho daño por disparo pero recarga despacio; la ametralladora, poco daño muy seguido. Las cifras, en el [catálogo](equipment-catalog.md#armas).
- **Orugas o ruedas.** Las ruedas son más rápidas; las orugas aguantan más peso sin frenarse.
- **Blindaje.** Pon el grueso en el frente si tu bot ataca de cara.
- **Radio.** Sólo vale la pena en equipo, y [hoy la oyen también los rivales](bots/radio.md#lo-que-tienes-que-saber-limitaciones-de-hoy).

Siguiente: [Bots](bots.md) · [Guía de programación](bots/index.md).
