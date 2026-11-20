# Guía de programación de bots

Esta guía explica cómo se programa un bot de S9 AI Arena: qué recibe tu código en cada momento, qué órdenes puede dar y cómo se prueba. Todos los nombres de campos, órdenes y eventos son los **reales** del protocolo `arena/1`; si algo cambiara, cambiaría el contrato y el SDK a la vez.

## Lo esencial en un minuto

- Tu bot es **un programa** en **Python 3.11** o **JavaScript (Node 20, módulo ES)**. No hay otros lenguajes (ver [más abajo](#lenguajes-disponibles)).
- Durante la batalla, la plataforma te pregunta **10 veces por segundo**: «esto es lo que ve tu vehículo, ¿qué haces?». Tú respondes con **una orden**: moverte, girar la torreta, disparar, soltar una mina, encender o apagar módulos, hablar por radio.
- Tu bot **no controla nada en directo**: gana el mejor programa. Lo que no hagas en un ciclo, el vehículo lo sigue haciendo con la última orden de movimiento.
- Sólo ves lo que **tus sensores** perciben (niebla de guerra). Si no montas sensores, no ves nada.

## Un bot mínimo

```python
from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.5, "steer": 0.0}}
```

```javascript
import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation(observation) {
    return { move: { throttle: 0.5, steer: 0.0 } };
  }
}
```

Pégalo en «Mis bots» → el bot → «Código» → «Nueva versión» y el vehículo avanzará recto. A partir de aquí todo es leer la observación y dar mejores órdenes.

## Índice de la guía

1. [El ciclo de una batalla](ciclo.md): mensajes, ticks, plazos y qué pasa si tardas.
2. [SDK de Python](python.md) y [SDK de JavaScript](javascript.md): instalación, clase base, geometría, simulador local.
3. [La observación](observaciones.md): tu estado, posición, vida, módulos, energía y marcador.
4. [Sensores](sensores.md): radar, lidar, proximidad y acústico, con sus límites.
5. [Órdenes (comandos)](comandos.md): movimiento, torreta, disparo, minas, módulos.
6. [Armas y munición](armas-y-municion.md): cadencia, energía, cargas y por qué se rechaza un disparo.
7. [Radio](radio.md): mensajes cortos entre vehículos.
8. [Objetivos](objetivos.md): banderas, zonas y marcador.
9. [Eventos](eventos.md): impactos, rechazos y avisos.
10. [Probar tu bot](probar.md): simulador local y errores típicos al validar.
11. [Ejemplos](ejemplos.md): mínimo, patrulla, atacante, sensores, radio y equipo, todos verificados.

## Lenguajes disponibles

| Lenguaje | Estado |
|---|---|
| **Python** (`arena-sdk`) | SDK completo. Es el que usa el servidor al validar y jugar tu bot. |
| **JavaScript** (`@arena/sdk`, Node 20) | SDK completo. Sube JavaScript de módulo ES, **no TypeScript**. |
| Java | Sólo una carpeta de reserva (`sdks/java`) sin código: **no hay SDK Java**. |
| .NET | Sólo una carpeta de reserva (`sdks/dotnet`) sin código: **no hay SDK .NET**. |

Si quieres otro lenguaje, hoy tendrías que implementar tú el protocolo por WebSocket (los esquemas están en `packages/protocol`), pero la plataforma sólo acepta subir código Python y JavaScript.

## Cómo se relaciona con el resto de la guía

- El **equipamiento** de tu vehículo (qué sensores y armas tienes) se elige en el [editor de loadout](../equipment.md); tu código lee el resultado en el mensaje de bienvenida.
- Las **reglas** de cada batalla (tiempo, vidas, victoria) están en [Modos de juego](../game-modes.md) y [Reglas de batalla](../rules.md).
- Subir, validar y publicar versiones: [Bots](../bots.md).

¿Quieres desarrollar S9 en vez de jugar? Mira la [documentación de desarrollo](../../development/index.md).
