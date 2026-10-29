# Equipamiento (loadout)

## Resumen

El **loadout** es el vehículo de tu bot: un chasis y un módulo por ranura (movilidad, energía, sensores, arma con su munición, minas, radio y blindaje por lado). Lo configuras en el **«Editor de loadout»** de «Mis bots», que valida el coste y la energía en vivo. El servidor lo vuelve a validar al guardar. Cada guardado crea una revisión nueva.

**FUNCIONA ACTUALMENTE.** **El loadout es el vehículo que juega**: el chasis y los módulos que eliges son los que se simulan en las batallas y en la partida de humo del build. Cada versión de código queda ligada a la revisión de loadout con la que la subiste; guardar una revisión nueva no cambia las versiones ya subidas.

El editor lo indica en cada ranura ([Qué cambia de verdad](#qué-cambia-de-verdad-en-la-batalla)).

## Índice

- [Uso](#uso)
- [Qué cambia de verdad en la batalla](#qué-cambia-de-verdad-en-la-batalla)
- [Chasis y ranuras](#chasis-y-ranuras)
- [Módulos disponibles](#módulos-disponibles)
- [Reglas de validación](#reglas-de-validación)
- [Ejemplo](#ejemplo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Uso

1. «Mis bots» → pulsa el nombre del bot → «Editor de loadout».
2. Elige el **chasis**: aparecen sus ranuras.
3. En cada ranura elige un módulo. Si eliges un arma, aparece el selector de **munición compatible**.
4. Vigila **«Coste: X/1000 cr»** y **«Energía: ±N»**. Las violaciones aparecen debajo, con el motivo.
5. Pulsa **«Guardar revisión»**. Verás «Revisión de loadout guardada.». Al volver a entrar, el editor carga la revisión vigente y muestra los «Cambios respecto a la revisión N».
6. Para que una versión de código juegue con la revisión nueva, sube una versión nueva: la subida usa la revisión vigente («Subir como versión nueva»).

Junto a la masa total, el editor muestra la **carga de módulos** frente al límite del chasis («carga de módulos X/Y kg»). Esa es la cifra que limita `mass_exceeded`.

Si la sesión caduca mientras editas, al volver a entrar se recuperan los cambios sin guardar de esa pestaña, con el aviso «Recuperados los cambios sin guardar de esta sesión». Todavía no son una revisión: guárdalos o descártalos.

## Qué cambia de verdad en la batalla

El editor muestra, arriba, una nota sobre el efecto real. Junto al chasis y a cada ranura aparece una insignia:

| Insignia | Significa |
|---|---|
| **[ACTIVE · cambia la batalla]** | El motor usa el valor del módulo que eliges |
| **[PARTIAL · efecto parcial]** | Sólo cuenta para validar el loadout: coste, tamaño, carga máxima, límites por vehículo |
| **[FUTURE · sin efecto en batalla]** | Ningún código lo usa todavía: no cambia nada |

Al elegir un módulo, «Efecto real de cada propiedad» lista sus datos con su insignia y el motivo. Ejemplos FUTURE: el alcance del arma (`rangeM`), el alcance de la radio, el terreno de la movilidad y los módulos de utilidad.

## Chasis y ranuras

| Chasis | Vida | Masa | Carga máx. | Coste | Ranuras especiales |
|---|---|---|---|---|---|
| Ligero v1 / v2 | 180 / 280 | 700 kg | 1200 kg | 150 / 190 | sin bahía de minas, 1 sensor |
| Medio v1 / v2 | 300 / 350 | 1400 kg | 1600 kg | 220 / 240 | bahía de minas |
| Pesado v1 | 480 | 2600 kg | 2400 kg | 280 | bahía de minas, 2 sensores |

Todas tienen: movilidad (`drive`), energía (`power`), sensor (`sensor_a`), torreta (`turret_main`), munición (`ammo_main`), radio (`radio_a`) y blindaje frontal, izquierdo, derecho y trasero. Cada ranura admite un tamaño máximo de módulo (S, M, L, XL).

## Módulos disponibles

| Tipo | Módulos | Para qué |
|---|---|---|
| Movilidad | ruedas (rápidas, para cargas ligeras) · orugas (lentas, aguantan más peso) | Velocidad y giro. El exceso de peso te frena |
| Energía | batería (mucha reserva) · generador v1/v2 (mucha generación) | Todo consume energía; sin ella no disparas |
| Sensores | radar · lidar 360° · lidar frontal · proximidad · acústico | Lo único que tu bot «ve» |
| Armas | cañón (munición perforante o explosiva) · ametralladora v1/v2 (munición estándar) | Daño |
| Munición | estándar · perforante (más daño) · explosiva (daño en área) | Cargas y daño |
| Blindaje | acero (más protección, más pesado) · compuesto (más ligero, más caro), por lado | Reduce el daño de cada lado |
| Radio | radio corta | Mensajes de hasta 32 bytes, 2 por segundo |
| Minas | mina explosiva (3 cargas) | Sólo en chasis medio o pesado |

Valores exactos y su efecto en la simulación: [equipment.md técnico](../technical/equipment.md).

## Reglas de validación

| Mensaje (código) | Causa |
|---|---|
| `budget_exceeded` | El total supera el presupuesto (1000 créditos) |
| `module_cost_cap_exceeded` | Un solo módulo cuesta más del 35 % del presupuesto |
| `mass_exceeded` | Los módulos pesan más que la carga máxima del chasis |
| `energy_deficit` | El consumo supera a la generación |
| `unknown_slot` | La ranura no existe en ese chasis (p. ej. minas en un chasis ligero) |
| `slot_type_mismatch` / `slot_size_exceeded` | Módulo de otro tipo o demasiado grande para la ranura |
| `incompatible_ammo` | Un arma no tiene munición que pueda disparar (ninguna o de otro tipo), o hay munición que ningún arma usa. Vale igual si la munición va con el arma o en su propia ranura (`ammo_main`). El mensaje dice qué municiones admite el arma (p. ej. el cañón: `ammo.ap`, `ammo.he`) |
| `duplicate_limit_exceeded` | Más unidades de las permitidas de un módulo (p. ej. un lidar 360° por vehículo) |

## Ejemplo

Configuración válida usada en la auditoría:

- chasis ligero v2;
- ruedas;
- generador v2;
- radar;
- ametralladora v2 con munición estándar;
- radio corta.

Resultado: coste 680/1000 y energía +21,5.

## Errores / limitaciones

- La web no explica qué hace cada módulo ni qué significan créditos o EU.
- Las minas sólo actúan si tu bot las despliega (comando `deployMine`) y el chasis tiene bahía de minas.
- **PARCIAL**: la radio no se limita a tu equipo ni a su alcance ([equipment.md](../technical/equipment.md#radio-radio_a)).
- Algunos datos del catálogo no influyen en la simulación: el alcance del arma, el alcance de la radio, el terreno de la movilidad o la detectabilidad de la mina.
- Si el loadout de la versión no se puede resolver con el catálogo del build (otra versión de catálogo), la partida de humo juega el arquetipo del chasis como reserva y lo dice en el log de la etapa. La batalla juega siempre el loadout de la versión.
- No hay módulos de utilidad (humo, reparación…): **PENDIENTE**.

## Estado actual

**FUNCIONA ACTUALMENTE** (configuración, validación, indicación del efecto y loadout real en batalla y en la partida de humo) · **PARCIAL** (algunas propiedades sin efecto: [FUTURE](#qué-cambia-de-verdad-en-la-batalla)).

## Documentación relacionada

- Usuario: [Bots](bots.md), [Modos de juego](game-modes.md)
- Técnica: [equipment.md](../technical/equipment.md), [engine.md](../technical/engine.md)
- Balance: [docs/balance/v1.md](../balance/v1.md)
- Deuda: [TD-016](../roadmap/technical-debt.md#td-016) (histórico: el camino antiguo `/run` sólo enviaba el chasis)
