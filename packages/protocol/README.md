# @arena/protocol

Contrato de comunicación entre el motor y los bots. Familia `arena/1`.

Fuente de verdad de las decisiones que lo sustentan: [`docs/decisiones/ADR-000`](../../docs/decisiones/ADR-000-decisiones-fundacionales.md).
Política de versionado: [`docs/compatibilidad.md`](../../docs/compatibilidad.md).

## Ciclo de vida de una conexión

```
bot                                    motor
 │──────────── HELLO ──────────────────▶│   versión, SDK, botId, battleToken
 │◀─────────── WELCOME ─────────────────│   reglas, timing, vehículo resuelto, mapa, versiones
 │                                       │
 │◀─────────── OBSERVATION (tick N) ────│   cada DECISION_EVERY_N_TICKS
 │──────────── COMMAND (forTick N+3) ──▶│   antes del deadline (80 ms)
 │◀─────────── EVENT ───────────────────│   en cualquier momento
 │                    ... bucle ...      │
 │◀─────────── SHUTDOWN ────────────────│   final, error o descalificación
```

## Las cinco reglas que no se negocian

1. **El motor es autoritativo.** Un `COMMAND` es una *intención*. El motor valida energía, munición, cooldown, arco de torreta e inventario, y puede rechazarla con un `EVENT` de `rejected_action`. Un bot nunca modifica estado.
2. **Niebla de guerra sin puertas traseras (D8).** La `OBSERVATION` contiene solo lo percibido. Los `EVENT` aplican la misma regla: un disparo recibido desde un enemigo no detectado no revela su `entityId`. No existe ningún campo "oculto pero presente".
3. **Un `COMMAND` por ciclo de decisión.** Los siguientes se descartan con evento. Si no llega ninguno a tiempo, se aplica la acción segura (mantener movimiento y torreta, no disparar) y se registra un timeout, sin alterar el orden de simulación.
4. **Todo mensaje se valida contra el esquema.** Un mensaje inválido se trata como *ausente*: se descarta, se registra, y la simulación no diverge. Un bot no puede tumbar el motor con basura.
5. **Ignora lo que no conoces.** Un campo desconocido en un mensaje entrante nunca debe hacer fallar a un SDK. Es lo que permite que un bot antiguo siga jugando tras un release minor.

## Los seis mensajes

| Mensaje | Dirección | Esquema |
|---|---|---|
| `HELLO` | bot → motor | [`hello.schema.json`](schemas/hello.schema.json) |
| `WELCOME` | motor → bot | [`welcome.schema.json`](schemas/welcome.schema.json) |
| `OBSERVATION` | motor → bot | [`observation.schema.json`](schemas/observation.schema.json) |
| `COMMAND` | bot → motor | [`command.schema.json`](schemas/command.schema.json) |
| `EVENT` | motor → bot | [`event.schema.json`](schemas/event.schema.json) |
| `SHUTDOWN` | motor → bot | [`shutdown.schema.json`](schemas/shutdown.schema.json) |

Todos viajan dentro del [envelope](schemas/envelope.schema.json):

```json
{ "proto": "arena/1", "type": "COMMAND", "tick": 303, "seq": 41, "payload": { "...": "..." } }
```

## Uso

```bash
# Suite completa: 18 ejemplos válidos deben pasar, 21 inválidos deben ser rechazados
node scripts/validate.js

# Validar un documento concreto
node scripts/validate.js examples/valid/command-full.json

# Regenerar los ejemplos versionados
node scripts/gen-examples.js
```

Los ejemplos de `examples/invalid/` llevan un campo `_why` que explica qué regla violan. **No son basura: son el test.** Cada uno protege una invariante concreta (fuga de niebla de guerra, comando sin `forTick`, blindaje que anula el daño...). Añadir un campo al protocolo sin añadir su caso inválido correspondiente es dejar la puerta abierta.

## Generación de tipos

Los tipos TypeScript se generan desde los esquemas en tiempo de build (`json-schema-to-typescript`); no se escriben a mano. Duplicar el contrato a mano es la forma más rápida de que el esquema y el código diverjan en silencio.

```bash
npm run build   # schemas/*.json → dist/types.d.ts
```
