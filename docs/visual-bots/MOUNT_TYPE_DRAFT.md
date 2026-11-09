# MOUNT_TYPE_DRAFT — Taxonomía genérica de puntos de montaje

**Proyecto:** visuales componibles de bots ([MASTER-PLAN](MASTER-PLAN.md)) · **Fase:** FASE 0 · **Estado:** BORRADOR
**Base de la rama:** `mejoras-visuales` @ `983d2f5` (2026-11-09).
**Relacionados:** [VISUAL_COMPONENT_MATRIX §9](VISUAL_COMPONENT_MATRIX.md) (mounts por chasis) ·
[ADR-VIS-003](adr/ADR-VIS-003-mount-coordinate-system.md) (coordenadas).

## 1. Qué es un mount type

Un **mount type** es un *tipo de sitio* del casco donde puede ir una pieza visual: «arma en torreta», «sensor en la
proa», «blindaje lateral». Es **genérico**: no existe un mount por módulo (no hay `mount.cannon` ni `mount.radar`).

- El **chasis visual** declara qué mounts tiene, cuántos y dónde (coordenadas en FASE 1/2, ADR-VIS-003).
- El **componente visual** declara qué mount types acepta (p. ej. el lidar frontal sólo `sensor.front`).
- El **resolver** cruza la ranura real del loadout (`turret_main`, `sensor_a`…) con el mount del chasis y con lo que
  acepta el componente. Si no encaja, aplica el fallback (SRS-F06), **nunca** inventa otra posición.

Por qué no basta con la ranura: las ranuras del catálogo son genéricas por categoría (`sensor_a` acepta cualquier
sensor). Un lidar frontal y un lidar 360 en la misma ranura van en sitios distintos del casco. La ranura dice **qué**
hay; el mount type dice **dónde** se pinta.

## 2. Taxonomía

| MOUNT_TYPE | Para qué | Categorías del catálogo que lo usan | ORIENTATION | MIRROR | LAYER_GROUP | Hoy en el catálogo |
| --- | --- | --- | --- | --- | --- | --- |
| `hull.base` | El propio casco (ancla del chasis) | chassis | hull | NO | chassis | Los tres chasis |
| `weapon.primary` | Arma principal en torreta | weapon | turret | NO | weapon.primary | `turret_main` en los tres chasis |
| `weapon.secondary` | Arma secundaria | weapon | turret o hull (por decidir) | NO | weapon.secondary | **No existe** ninguna ranura (`MAX_COUNT: 0`) |
| `sensor.front` | Sensor fijo mirando a proa | sensor | hull | NO | sensor | Lo usaría `sensor.lidar_front` |
| `sensor.top` | Sensor en el techo, sin dirección propia | sensor | none (giro cosmético opcional) | NO | sensor | `sensor.lidar360`, `sensor.radar`, opcional `sensor.acoustic` |
| `sensor.omni` | Sensor perimetral (anillo/banda) | sensor | none | NO | sensor | `sensor.proximity` |
| `sensor.flank` | Pareja de piezas en los costados | sensor | hull | SÍ (derecha = espejo de izquierda) | sensor | `sensor.acoustic` |
| `radio.top` | Antena | radio | none | NO | radio | `radio_a` en los tres chasis |
| `armor.front` | Placa frontal | armor | hull | NO | armor | `armor_front` |
| `armor.side` | Placa lateral | armor | hull | SÍ (`armorRight` = espejo de `armorLeft`) | armor | `armor_left`, `armor_right` |
| `armor.rear` | Placa trasera | armor | hull | NO | armor | `armor_rear` |
| `mobility.left` | Tren de rodaje izquierdo | movement | hull | NO | mobility | `drive` |
| `mobility.right` | Tren de rodaje derecho | movement | hull | SÍ (espejo de `mobility.left`) | mobility | `drive` (mismo módulo) |
| `bay.rear` | Compuerta de bahía (minas o utility) | mine, utility | hull | NO | chassis | `mine_bay` en medio y pesado |
| `internal` | Módulo interno, no se pinta | power, ammo | none | NO | none | `power`, `ammo_main` |
| `fx.muzzle` | Punto derivado en la boca del arma (efectos) | (ninguna; deriva de `weapon.primary`) | turret | NO | effects | Hoy: `radiusM + 0.3` m a lo largo de `turretHeading` (motor) |
| `ui.overhead` | Indicadores sobre el vehículo (nombre, bandera, juggernaut) | (runtime) | none (siempre en pantalla) | NO | ui | Ya los pinta el visor |

`ORIENTATION`:

- **turret**: gira con `turretHeading` (público). Todos los mounts `turret` comparten ese ángulo: el motor tiene **una**
  torreta por vehículo (`Vehicle.turretHeading`).
- **hull**: gira con el rumbo del casco (`heading`).
- **none**: no tiene dirección; si gira, es cosmético a velocidad fija y no codifica ningún dato (ver matriz §7).

## 3. Grupos de capa (LAYER_GROUP)

Se alinean con la convención del MASTER-PLAN §10. Los números son de esa convención; FASE 1 los centraliza en un único
módulo (no se reparten por la UI).

| LAYER_GROUP | z (MASTER-PLAN §10) | Contenido |
| --- | --- | --- |
| shadow | 0 | Sombra |
| mobility | 10 | Orugas/ruedas |
| chassis | 20 | Casco, compuerta de bahía |
| armor | 30 | Placas |
| weapon.primary | 40 | Torreta y arma principal |
| weapon.secondary | 45 | Reservado (no existe hoy) |
| sensor | 50 | Sensores |
| radio | 60 | Antena |
| effects | 70 | Fogonazo, humo, chispas |
| damage | 80 | Marcas de daño |
| ui | 90 | Nombre, bandera, marcadores |
| none | — | Interno: no se dibuja |

Riesgo abierto: con `sensor` (50) y `radio` (60) por encima de `weapon.primary` (40), un sensor o antena de techo puede
tapar la torreta en vista cenital. ADR-VIS-003 lo trata con zonas reservadas (los mounts `top` no se colocan sobre el
círculo de la torreta).

## 4. Reglas de compatibilidad (borrador)

1. Un componente sólo se dibuja en un mount cuyo tipo esté en su lista de aceptados **y** cuya ranura de origen lo
   contenga en el loadout/snapshot. Nada de pintar equipamiento que no esté (principio 8 del MASTER-PLAN).
2. La escala visual máxima la limita el `MAX_SIZE` de la ranura (S/M/L/XL del catálogo); un componente nunca se dibuja
   más grande de lo que su ranura admite.
3. `MAX_COUNT` limita cuántos componentes pinta un mount. Hoy siempre es 1 (o 0 si no existe).
4. Un mount `MIRROR: SÍ` reutiliza el asset del lado izquierdo reflejado; no hace falta un asset por lado.
5. Un mount de una ranura vacía no se dibuja (las ranuras son opcionales en el validador).
6. Un mount desconocido o sin asset cae al fallback: asset genérico compatible → marcador genérico → nunca vacío ni error.

## 5. Fuera de este borrador

- Coordenadas, anclas y transformaciones: ADR-VIS-003 (decisión) y FASE 1/2 (valores).
- Mounts específicos por módulo: explícitamente prohibidos.
- Utility, accesorios y arma secundaria: los mounts quedan reservados, sin uso hasta que el catálogo los tenga.
