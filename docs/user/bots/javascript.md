# SDK de JavaScript

El SDK de JavaScript (`@arena/sdk`) es la versión en Node del mismo ciclo de vida que el de Python. Está en el repositorio, en `sdks/javascript`. El runtime de la plataforma ejecuta tu bot con **Node 20**.

> **Lo que subes es JavaScript de módulo ES, no TypeScript.** El runtime ejecuta `.js` o `.mjs` tal cual: un fichero con tipos, `private`, `override` o `import type` se rechaza al validar. El SDK está escrito en TypeScript y sus tipos sirven a tu editor, pero el bot que pegas es JavaScript.

## El contrato mínimo

Un módulo que **exporta por defecto una clase que extiende `ArenaBot`** (también vale `export class Bot`, o una única clase exportada) y que **implementa `onObservation(observation)`**, devolviendo la orden del ciclo (`{}` = sin cambios).

```javascript
import { ArenaBot } from "@arena/sdk";

export default class Bot extends ArenaBot {
  onObservation(observation) {
    return { move: { throttle: 0.8, steer: 0.2 } };
  }
}
```

- Si la clase no implementa `onObservation` —o lo escribes mal, por ejemplo `onObservaton`— la validación lo rechaza y te dice cómo se escribe. Un bot quieto a propósito implementa el hook y devuelve `{}`.
- Usa `import` / `export`, **no `require`**.
- No hace falta conectar nada: la plataforma instancia tu clase y llama a tus hooks. Al pegar un único fichero, se coloca como `src/bot.js` en un paquete con `"type": "module"`.

## Los hooks

```javascript
export default class MiBot extends ArenaBot {
  onWelcome(welcome) {
    // Una vez, antes del primer tick: reglas, tu vehículo y el mapa.
  }

  onObservation(observation) {
    // Cada ciclo de decisión (10 por segundo). OBLIGATORIO. Devuelve la orden.
    return {};
  }

  onEvent(event) {
    // Impactos, rechazos de órdenes, capturas...
  }

  onShutdown(shutdown) {
    // Último mensaje; shutdown.gracePeriodMs (500 ms por defecto) para guardar algo.
  }
}
```

Los cuatro reciben objetos con los campos de la guía ([ciclo](ciclo.md), [observación](observaciones.md), [eventos](eventos.md)). `this.welcome` conserva el `WELCOME`. El SDK calcula `forTick` por ti.

## Ayudas

```javascript
import { distance, angleTo, angleDiff } from "@arena/sdk";

const d = distance(me.position, blanco.position); // metros
const rumbo = angleTo(me.position, blanco.position); // ángulo absoluto hacia el blanco
const giro = angleDiff(me.heading, rumbo); // cuánto girar, en [-π, π]
```

Los tipos del protocolo (`WelcomePayload`, `ObservationPayload`, `CommandPayload`, `EventPayload`…) se generan desde los esquemas del contrato, así que nunca difieren de lo que recibes de verdad. Sirven en TypeScript para tu editor; el bot que subes sigue siendo JavaScript.

## Qué puedes importar

Puedes usar `@arena/sdk` y `ws`, y los módulos estándar de Node salvo los que dan acceso al sistema. Se rechazan, entre otros: `fs`, `child_process`, `net`, `http`, `https`, `worker_threads`, `vm`, `os`, `crypto`, `process` y los imports dinámicos. No puedes añadir dependencias desde la web. Más en [Probar tu bot](probar.md#qué-comprueba-la-validación).

## Probarlo en tu ordenador

Desde la raíz del repositorio, con Node.js 22 o superior y `npm install` hecho:

```bash
npx arena-sim mi_bot.js --archetype gunner --opponent idle --ticks 1800
```

Es el mismo simulador que el de Python (motor real, sin plataforma): las mismas opciones `--archetype`, `--opponent idle|hunter|circle|forward`, `--map empty|mvp|ctf`, `--ruleset`, `--ticks` y `--seed`, y escribe el resultado de la batalla en JSON. Más en [Probar tu bot](probar.md).

## Diferencias con Python

El ciclo de vida, las órdenes y los nombres de campo son los mismos. Cambia sólo la sintaxis (`snake_case` en los hooks de Python, `camelCase` en los de JavaScript; los **campos del protocolo** son iguales en los dos: `hullHp`, `targetPoint`…) y que el simulador de JavaScript corre motor y bot en el mismo proceso.

Siguiente: [La observación](observaciones.md).
