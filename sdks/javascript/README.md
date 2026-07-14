# @arena/sdk (JavaScript / TypeScript)

SDK de referencia en TypeScript para bots de [S9 AI Arena](../../README.md), protocolo `arena/1`.

## Instalar

Este paquete vive dentro del monorepo (aún no está publicado en npm). Desde la raíz:

```bash
npm install     # ya trae ws, @types/ws, typescript
```

Los tipos se generan desde los esquemas de E1 con `json-schema-to-typescript` (igual
mecanismo que documenta `packages/protocol/README.md`):

```bash
node sdks/javascript/generate-types.mjs   # regenera src/generated-types.ts
```

## Tu primer bot, en 30 líneas

```typescript
import { ArenaBot, angleTo, angleDiff, type ObservationPayload, type CommandIntent } from "@arena/sdk";

export class TutorialBot extends ArenaBot {
  onObservation(observation: ObservationPayload): CommandIntent {
    const me = observation.self;
    const contacts = (observation.sensors?.radar ?? []).flatMap((r) => r.contacts);

    if (contacts.length === 0) {
      return { move: { throttle: 0.8, steer: 0.2 } }; // sin nadie a la vista: patrulla
    }

    const target = contacts.reduce((a, b) =>
      (a.position.x - me.position.x) ** 2 + (a.position.y - me.position.y) ** 2 <
      (b.position.x - me.position.x) ** 2 + (b.position.y - me.position.y) ** 2 ? a : b,
    );
    const bearing = angleTo(me.position, target.position);
    const turn = angleDiff(me.heading, bearing);

    return {
      move: { throttle: 0.6, steer: Math.max(-1, Math.min(1, turn * 1.5)) },
      turret: { targetPoint: target.position },
      fire: ["turret_main"],
    };
  }
}
```

Es exactamente `sdks/javascript/tests/tutorial-bot.ts`, y
`tests/contract.test.ts` lo ejecuta contra una batalla real en cada `npm test`: si
el README miente, el test falla.

Para correrlo tú mismo contra el motor real, en el mismo proceso (sin necesitar
Docker ni una plataforma — ver `tests/helpers.ts::startLocalBattle` para el
patrón completo):

```typescript
import { startLocalBattle } from "./tests/helpers.js";
import { TutorialBot } from "./tests/tutorial-bot.js";

const bot = new TutorialBot("bot_mio01");
const battle = await startLocalBattle({
  externalBots: [{ botId: "bot_mio01", archetype: "gunner" }],
  stubBots: [{ botId: "bot_rival01", archetype: "scout", kind: "hunter" }],
  ticks: 1800,
});
await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get("bot_mio01")!);
console.log(await battle.waitForResult());
```

## El ciclo de vida

```typescript
class MiBot extends ArenaBot {
  onWelcome(welcome: WelcomePayload): void {
    // Una vez, al aceptar la batalla. welcome.timing trae los valores REALES de
    // esta batalla — nunca asumas constantes hardcodeadas.
  }

  onObservation(observation: ObservationPayload): CommandIntent {
    // Se llama cada ciclo de decisión. No hace falta rellenar forTick: el SDK lo
    // calcula solo a partir de observation.tick + welcome.timing.decisionEveryNTicks.
    return {};
  }

  onEvent(event: EventPayload): void {
    // Impactos, capturas, rechazos de acción... solo lo que tu bot podía percibir (D8).
  }

  onShutdown(shutdown: ShutdownPayload): void {
    // Último mensaje. shutdown.gracePeriodMs (500 ms por defecto) es tu ventana
    // para persistir algo antes de que el proceso se corte.
  }
}
```

Conectar contra una batalla real (plataforma, no simulador local):

```typescript
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

Ver [`docs/sdk-paridad.md`](../../docs/sdk-paridad.md).
