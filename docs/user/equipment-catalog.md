# Catálogo de equipamiento

> GENERADO desde el catálogo de módulos (`packages/module-catalog/data`) con `npx tsx scripts/generate-equipment-doc.ts`. No editar a mano: `packages/module-catalog/equipment-doc.test.ts` falla si este fichero no coincide con el catálogo. Cómo se usa el equipamiento, en [Equipamiento](equipment.md).

Estas son **todas las piezas** que puedes montar hoy (catálogo `mvp@1`, 31 piezas). Las cifras son las que usa el simulador. Unidades: metros (m), kilos (kg), créditos (cr), energía (EU, y EU/s por segundo), radianes (rad) y ticks (el juego va a 30 ticks por segundo).

Un loadout no puede pasar de **1000 créditos** en una batalla de práctica (los torneos y las reglas personalizadas pueden fijar otro presupuesto), ninguna pieza puede costar más del 35 % del presupuesto, y el peso de las piezas no puede superar la **carga máxima** del chasis.

## Chasis

El chasis es la base del vehículo: fija su vida, su tamaño, el peso que puede cargar y qué ranuras tiene (y de qué tamaño máximo).

| Nombre | Casco (PV) | Radio (m) | Masa (kg) | Carga máxima (kg) | Coste (créditos) |
|---|---|---|---|---|---|
| Chasis pesado | 480 | 2 | 2600 | 2400 | 280 |
| Chasis ligero (versión 1) | 180 | 1,2 | 700 | 1200 | 150 |
| Chasis ligero (versión 2) | 280 | 1,2 | 700 | 1200 | 190 |
| Chasis medio (versión 1) | 300 | 1,6 | 1400 | 1600 | 220 |
| Chasis medio (versión 2) | 350 | 1,6 | 1400 | 1600 | 240 |

### Ranuras de cada chasis

| Chasis | Ranuras (entre paréntesis, el tamaño máximo de pieza: S pequeño, M mediano, L grande, XL muy grande) |
|---|---|
| Chasis pesado | Propulsión (XL) · Energía (L) · Sensor A (M) · Sensor B (S) · Torreta principal (XL) · Munición principal (L) · Compartimento de minas (M) · Radio (S) · Blindaje frontal (XL) · Blindaje izquierdo (L) · Blindaje derecho (L) · Blindaje trasero (L) |
| Chasis ligero (versión 1) | Propulsión (M) · Energía (M) · Sensor A (M) · Torreta principal (M) · Munición principal (M) · Radio (S) · Blindaje frontal (M) · Blindaje izquierdo (S) · Blindaje derecho (S) · Blindaje trasero (S) |
| Chasis ligero (versión 2) | Propulsión (M) · Energía (M) · Sensor A (M) · Torreta principal (M) · Munición principal (M) · Radio (S) · Blindaje frontal (M) · Blindaje izquierdo (S) · Blindaje derecho (S) · Blindaje trasero (S) |
| Chasis medio (versión 1) | Propulsión (L) · Energía (M) · Sensor A (M) · Torreta principal (L) · Munición principal (M) · Compartimento de minas (M) · Radio (S) · Blindaje frontal (L) · Blindaje izquierdo (M) · Blindaje derecho (M) · Blindaje trasero (M) |
| Chasis medio (versión 2) | Propulsión (L) · Energía (M) · Sensor A (M) · Torreta principal (L) · Munición principal (M) · Compartimento de minas (M) · Radio (S) · Blindaje frontal (L) · Blindaje izquierdo (M) · Blindaje derecho (M) · Blindaje trasero (M) |

## Movimiento

Decide la velocidad y el giro. Si el vehículo pesa más que la **carga nominal**, se frena (hasta un mínimo del 40 %). Con varios módulos de movimiento manda el mejor; no se suman.

| Nombre | Velocidad máxima (m/s) | Aceleración (m/s²) | Giro (rad/s) | Carga nominal (kg) | Masa (kg) | Coste (créditos) | Consumo pasivo (EU/s) | Tamaño |
|---|---|---|---|---|---|---|---|---|
| Orugas | 9 | 6 | 1,2 | 2600 | 400 | 120 | 2 | grande (L) |
| Ruedas todoterreno | 13 | 9 | 1,8 | 1600 | 200 | 90 | 1,5 | mediano (M) |

## Energía

Todo consume energía (EU). La reserva se carga con la generación menos el consumo; disparar y soltar minas gasta además un poco por acción. Sin energía, la acción se rechaza.

| Nombre | Capacidad (EU) | Generación (EU/s) | Masa (kg) | Coste (créditos) | Tamaño |
|---|---|---|---|---|---|
| Batería | 500 | 8 | 150 | 60 | mediano (M) |
| Generador básico (versión 1) | 150 | 22 | 130 | 70 | mediano (M) |
| Generador básico (versión 2) | 150 | 30 | 130 | 85 | mediano (M) |

## Sensores

Son los únicos ojos de tu bot: sin un sensor operativo, la observación no trae esa información. Cada tipo ve distinto (ver la [guía de sensores](bots/sensores.md)).

| Nombre | Tipo de sensor | Alcance (m) | Campo de visión | Rayos | Error de posición (m) | Masa (kg) | Coste (créditos) | Consumo pasivo (EU/s) | Tamaño |
|---|---|---|---|---|---|---|---|---|---|
| Escucha acústica | Acústico | 60 | — | — | — | 15 | 40 | 1 | pequeño (S) |
| Lidar frontal | Lidar (rayos) | 45 | 90° (1,571 rad) | 16 | — | 35 | 80 | 2 | pequeño (S) |
| Lidar 360 | Lidar (rayos) | 40 | 360° (6,283 rad) | 48 | — | 60 | 140 | 4 | mediano (M) |
| Detector de proximidad | Proximidad | 15 | — | — | — | 20 | 50 | 2 | pequeño (S) |
| Radar básico | Radar (contactos con error) | 50 | — | — | 2 | 50 | 130 | 5 | mediano (M) |

## Armas

El arma dispara la munición que le montes (columna «Munición compatible»). La recarga se cuenta en ticks (30 por segundo).

| Nombre | Daño | Recarga (ticks) | Velocidad del proyectil (m/s) | Dispersión (rad) | Giro de torreta (rad/s) | Consumo por acción (EU) | Masa (kg) | Coste (créditos) | Tamaño | Munición compatible |
|---|---|---|---|---|---|---|---|---|---|---|
| Cañón de 60 mm | 45 | 30 ticks (1 s) | 120 | 0,01 | 1 | 12 | 380 | 190 | grande (L) | Munición perforante, Munición explosiva |
| Ametralladora (versión 1) | 12 | 6 ticks (0,2 s) | 200 | 0,05 | 2,2 | 3 | 120 | 90 | mediano (M) | Munición estándar |
| Ametralladora (versión 2) | 18 | 5 ticks (0,167 s) | 200 | 0,05 | 2,2 | 2,5 | 120 | 115 | mediano (M) | Munición estándar |

## Munición

La munición se monta con el arma. Cada tipo cambia el daño y el número de disparos.

| Nombre | Disparos (proyectiles) | Multiplicador de daño (×) | Radio de explosión (m) | Masa (kg) | Coste (créditos) | Tamaño |
|---|---|---|---|---|---|---|
| Munición perforante | 40 | 1,2 | 0 | 80 | 50 | mediano (M) |
| Munición explosiva | 30 | 0,9 | 5 | 90 | 60 | mediano (M) |
| Munición estándar | 300 | 1 | 0 | 50 | 30 | pequeño (S) |

## Blindaje

Cada pieza protege un sector (frontal, izquierdo, derecho o trasero). Reduce el daño que entra por ese lado, nunca por debajo del 10 % del daño original, y se desgasta con lo que absorbe.

| Nombre | Sector | Reducción de daño (fracción) | Vida del módulo (PV) | Masa (kg) | Coste (créditos) | Tamaño |
|---|---|---|---|---|---|---|
| Blindaje compuesto frontal | frontal | 28 % | 150 | 220 | 160 | grande (L) |
| Blindaje compuesto lateral izquierdo | izquierdo | 20 % | 100 | 150 | 110 | mediano (M) |
| Blindaje compuesto trasero | trasero | 16 % | 90 | 140 | 95 | mediano (M) |
| Blindaje compuesto lateral derecho | derecho | 20 % | 100 | 150 | 110 | mediano (M) |
| Blindaje de acero frontal | frontal | 35 % | 200 | 420 | 120 | grande (L) |
| Blindaje de acero lateral izquierdo | izquierdo | 25 % | 140 | 280 | 80 | mediano (M) |
| Blindaje de acero trasero | trasero | 20 % | 120 | 260 | 70 | mediano (M) |
| Blindaje de acero lateral derecho | derecho | 25 % | 140 | 280 | 80 | mediano (M) |

## Radio

Permite enviar mensajes cortos a otros vehículos (ver la [guía de radio](bots/radio.md)). Hoy los oyen todos los vehículos, también los rivales.

| Nombre | Tamaño máximo de mensaje (bytes) | Mensajes por segundo | Masa (kg) | Coste (créditos) | Consumo pasivo (EU/s) | Tamaño |
|---|---|---|---|---|---|---|
| Radio corta | 32 | 2 | 20 | 40 | 1 | pequeño (S) |

## Minas

La mina se suelta con el comando `deployMine` y sólo cabe en la bahía de minas de los chasis medio y pesado.

| Nombre | Cargas | Daño | Radio de activación (m) | Radio de explosión (m) | Retardo de armado (ticks) | Recarga (ticks) | Duración (ticks) | Consumo por acción (EU) | Masa (kg) | Coste (créditos) | Tamaño |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Mina explosiva | 3 | 90 | 2,5 | 6 | 30 ticks (1 s) | 90 ticks (3 s) | 5400 ticks (180 s) | 8 | 120 | 100 | mediano (M) |

## Datos que no cambian la batalla

Algunos datos del catálogo existen pero **ningún código de la simulación los lee todavía**. No cuentes con ellos:

- **Movimiento · Terreno**: el terreno no influye en la velocidad.
- **Armas · Alcance**: el alcance real lo marca cuánto tiempo vive el proyectil en vuelo, no este dato.
- **Armas · Arco de torreta**: todas las torretas giran 360°, no hay límite de arco.
- **Radio · Alcance**: la radio no tiene alcance: llega a cualquier distancia.
- **Utilidades**: el catálogo no trae ninguna pieza de utilidad y el comando `utility` todavía no hace nada.

Estos otros sólo cuentan para **validar** el loadout (no cambian lo que pasa en la batalla):

- Carga máxima
- Coste
- Tamaño
- Máximo por vehículo
