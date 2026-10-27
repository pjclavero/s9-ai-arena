# @arena/sdk (JavaScript)

SDK de [S9 AI Arena](../../README.md) para bots en JavaScript, protocolo `arena/1`.

> **Lo que sube a la plataforma es JavaScript ESM, no TypeScript.** El runtime de
> bots es Node 20 y ejecuta `.js`/`.mjs` tal cual: un fichero TypeScript (tipos,
> `private`, `override`, `import type`…) se rechaza en el análisis estático del
> build. El SDK está escrito en TypeScript y sus tipos sirven para tu editor, pero
> el bot que pegas o subes es JS.

## Contrato mínimo del bot

- Un módulo ES que **exporta por defecto** una clase que extiende `ArenaBot` de
  `"@arena/sdk"` (también vale `export class Bot`, o una única clase exportada).
- La clase **implementa `onObservation(observation)`** y devuelve la intención del
  ciclo (`{}` = sin cambios). Si no lo implementa —o lo escribe mal, p. ej.
  `onObservaton`— el build lo rechaza: «tu clase … no implementa onObservation;
  ¿quisiste decir …?». Un bot quieto a propósito implementa el hook y devuelve `{}`.
- Si pegas un único fichero en la web, la plataforma lo envuelve en un paquete
  estándar (`package.json` con `"type": "module"` y `@arena/sdk` 0.1.0, y el
  código en `src/bot.js`).

## Instalar (para probar en local)

Este paquete vive dentro del monorepo (aún no está publicado en npm). Desde la raíz:

```bash
npm install     # ya trae ws, @types/ws, typescript
```

Los tipos se generan desde los esquemas de E1 con `json-schema-to-typescript` (igual
mecanismo que documenta `packages/protocol/README.md`):

```bash
node sdks/javascript/generate-types.mjs   # regenera src/generated-types.ts
```

## Tu primer bot, en 25 líneas (JavaScript, copiable tal cual)

```javascript
import { ArenaBot, angleDiff, angleTo } from "@arena/sdk";

export default class TutorialBot extends ArenaBot {
  onObservation(observation) {
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);

    if (contacts.length === 0) {
      return { move: { throttle: 0.8, steer: 0.2 } }; // sin nadie a la vista: patrulla
    }

    const d2 = (c) => (c.position.x - me.position.x) ** 2 + (c.position.y - me.position.y) ** 2;
    const target = contacts.reduce((a, b) => (d2(a) < d2(b) ? a : b));
    const turn = angleDiff(me.heading, angleTo(me.position, target.position));

    return {
      move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, turn * 1.5)) },
      turret: { targetPoint: target.position },
      fire: ["turret_main"],
    };
  }
}

export { TutorialBot };
```

Es exactamente `sdks/javascript/tests/tutorial-bot.js`: `tests/contract.test.ts` lo
ejecuta contra una batalla real en cada `npm test`, `tests/readme-js.test.ts`
comprueba que este bloque es idéntico al fichero y que pasa el análisis estático
del build, y el E2E del sandbox (`apps/bot-manager/tests/build-sandbox-docker.test.ts`)
lo construye en la imagen de runtime real hasta `validated`. Si el README miente, un
test falla.

Más ejemplos subibles: [`example-bots/javascript/gunner.js`](../../example-bots/javascript/gunner.js)
y [`miner.js`](../../example-bots/javascript/miner.js).

## Simulador local por CLI: `arena-sim` (R2.8)

El equivalente del `arena-sim` del SDK de Python: corre tu bot contra un stub del
motor, con el motor REAL de E2 y el protocolo real de T5.1, sin Docker ni
plataforma. Guarda tu bot (un `.js` que exporte una subclase de `ArenaBot`, como
el de arriba) y, desde la raíz del repo:

```bash
npx arena-sim example-bots/javascript/gunner.js --archetype gunner --opponent idle --ticks 1800
# o equivalente, sin el bin del workspace:
npx tsx sdks/javascript/src/arena-sim.ts mi_bot.js --archetype gunner --opponent idle
```

Mismos flags que el de Python (`--archetype`, `--opponent idle|hunter|circle|forward`,
`--opponent-archetype`, `--map empty|mvp|ctf`, `--ruleset`, `--ticks`, `--seed`) y la
misma salida: el `BattleResult` en JSON por stdout. Extra solo de JS:
`--tick-interval-ms` acelera el bucle (por defecto corre a ritmo real, ~33 ms/tick).
A diferencia de Python no hay subproceso: motor y bot comparten el proceso Node
(ver `docs/sdk-paridad.md`).

## Simulador local sin la CLI

Para correrlo tú mismo contra el motor real, en el mismo proceso (sin necesitar
Docker ni una plataforma — ver `src/local-simulator.ts::startLocalBattle`, que es
lo que usan tanto la CLI como los tests):

```javascript
import { startLocalBattle } from "./tests/helpers.js"; // envoltorio con defaults rápidos de test
import TutorialBot from "./tests/tutorial-bot.js";

const bot = new TutorialBot("bot_mio01");
const battle = await startLocalBattle({
  externalBots: [{ botId: "bot_mio01", archetype: "gunner" }],
  stubBots: [{ botId: "bot_rival01", archetype: "scout", kind: "hunter" }],
  ticks: 1800,
});
await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_mio01"));
console.log(await battle.waitForResult());
```

## El ciclo de vida

```javascript
import { ArenaBot } from "@arena/sdk";

export default class MiBot extends ArenaBot {
  onWelcome(welcome) {
    // Una vez, al aceptar la batalla. welcome.timing trae los valores REALES de
    // esta batalla — nunca asumas constantes hardcodeadas. welcome.vehicle.modules
    // es TU loadout: ranuras y propiedades de lo que montaste.
  }

  onObservation(observation) {
    // OBLIGATORIO. Se llama cada ciclo de decisión. No hace falta rellenar forTick:
    // el SDK lo calcula solo a partir de observation.tick + welcome.timing.decisionEveryNTicks.
    return {};
  }

  onEvent(event) {
    // Impactos, capturas, rechazos de acción... solo lo que tu bot podía percibir (D8).
  }

  onShutdown(shutdown) {
    // Último mensaje. shutdown.gracePeriodMs (500 ms por defecto) es tu ventana
    // para persistir algo antes de que el proceso se corte.
  }
}
```

Conectar contra una batalla real (plataforma, no simulador local):

```javascript
const bot = new MiBot("bot_mio01");
await bot.run("wss://arena.example/ws", "el-token-que-te-dio-la-plataforma");
```

`run()` **no reconecta**: si el transporte cae, la promesa se resuelve y el
proceso termina. Reconectar es decisión de quien opera el bot.

## Tipos

`src/generated-types.ts` se genera desde `packages/protocol/schemas/*.json` — no
se escribe a mano, para que nunca diverja del contrato real de E1. `src/types.ts`
re-exporta esos tipos con nombres limpios (`WelcomePayload`, `ObservationPayload`...
en vez de los nombres que produce el generador a partir del `title` del esquema) y
añade las tres funciones de geometría: `distance`, `angleTo`, `angleDiff`.

## Verificar que los tipos publicados compilan para un tercero

```bash
npx tsc --noEmit -p sdks/javascript/consumer-typecheck-example/tsconfig.json
```

`consumer-typecheck-example/consumer.ts` importa `@arena/sdk` por su nombre de
paquete (no por ruta relativa a `src/`), igual que lo haría un proyecto externo.

## Tests

```bash
npx vitest run sdks/javascript/tests/contract.test.ts
```

Misma suite compartida que el SDK de Python
(`sdks/shared-contract-tests/cases/*.json`) más mensajes reales de una batalla
real, todos validados contra `packages/protocol/schemas/*.json`.

## Diferencias reales con el SDK de Python

Ver [`docs/sdk-paridad.md`](../../docs/history/disenos/sdk-paridad.md).
