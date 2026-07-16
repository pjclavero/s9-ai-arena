# Paridad entre `arena-sdk` (Python) y `@arena/sdk` (JavaScript/TypeScript)

Ambos SDKs implementan el mismo ciclo de vida (`on_welcome`/`onWelcome`,
`on_observation`/`onObservation`, `on_event`/`onEvent`, `on_shutdown`/`onShutdown`),
el mismo cálculo de `forTick` a partir de `WELCOME.timing.decisionEveryNTicks`
(nunca una constante hardcodeada), la misma regla de "ignora lo que no conoces" y
la misma ausencia deliberada de reconexión automática. La tabla de abajo documenta
**diferencias reales**, no imaginadas — cada fila viene de algo que tuve que
resolver de forma distinta en cada lenguaje, no de una comparación especulativa.

| Capacidad | Python (`arena-sdk`) | JavaScript (`@arena/sdk`) | Diferencia real |
|---|---|---|---|
| Sistema de tipos | `TypedDict` (`arena_sdk/types.py`) | `interface`/`type` generados con `json-schema-to-typescript` (`generated-types.ts`) | Python usa `TypedDict` a mano porque no hay generador de esquema→Python en el pipeline de este proyecto; TS sí lo tiene (`generate-types.mjs`), así que sus tipos son literalmente el esquema de E1 compilado, no una copia mantenida a mano. Si E1 cambia un campo, TS lo nota en el próximo `generate-types.mjs`; Python solo lo nota si alguien actualiza `types.py` a mano. |
| Validación en tiempo de ejecución | Ninguna (ni `TypedDict` ni el SDK validan; confían en el servidor) | Ninguna (mismo diseño) | Sin diferencia real: los dos SDKs son deliberadamente "tontos" en esto — el motor (T5.1) es la única autoridad que valida de verdad. |
| Reconexión | No | No | Sin diferencia: los dos DoD lo piden explícitamente así. |
| Versión de protocolo soportada | `arena/1` únicamente | `arena/1` únicamente | Sin diferencia. Ningún SDK negocia versión; un `WELCOME`/`SHUTDOWN` con otro `proto` ni se procesa (regla D5). |
| Transporte | `websocket-client` (síncrono, bloqueante, un hilo por bot) | `ws` (basado en eventos, cooperativo dentro del *event loop* de Node) | Real: en Python, correr **N** bots locales a la vez exige **N hilos** (`LocalSimulator` los lanza con `threading.Thread`); en JS, corren todos en el mismo hilo sin coordinación extra porque `ws` ya es asíncrono. No es una limitación de diseño del SDK, es la diferencia de modelo de concurrencia entre los dos lenguajes. |
| Simulador local | `LocalSimulator`: lanza `apps/arena-engine/src/local-sim.ts` como **subproceso** Node (necesita `npx` en el `PATH`) y conecta los bots Python por WebSocket a `localhost`. | `startLocalBattle()` (en `tests/helpers.ts`): importa `Battle`/`ProtocolServer` **directamente**, en el mismo proceso — no hace falta un subproceso porque el bot de JS y el motor ya corren en el mismo runtime (Node). | Real y notable: el SDK de JS puede probarse sin volver a arrancar Node; el de Python siempre paga el coste de un `subprocess.Popen` (unas décimas de segundo). A cambio, el SDK de Python es el único que demuestra de verdad que el protocolo cruza un límite de proceso (y de lenguaje) real, que es más parecido a cómo correrá un bot en producción. |
| CLI de un solo bot | `arena-sim <bot.py> --archetype ... --opponent idle` (instalado como *entry point* de `pip`) | No se ha construido un CLI equivalente en esta entrega | Real, es una carencia: nada en el diseño lo impide (el helper `startLocalBattle` ya hace el trabajo pesado), simplemente no se ha escrito el envoltorio de CLI. Ver "Lo que queda fuera" en `docs/historial/entrega-E5.md`. |
| Publicación de tipos para terceros | El paquete es instalable (`pip install -e .`) pero no publica *stubs* `.pyi` separados; los tipos viven en el propio código gracias a `from __future__ import annotations`. | `tsc --noEmit` sobre un proyecto consumidor mínimo (`consumer-typecheck-example/`) que importa `@arena/sdk` por su nombre de paquete compila sin errores. | Real: TS tiene una prueba explícita de que un tercero puede consumir los tipos; Python no tiene el equivalente (`mypy` sobre un consumidor) en esta entrega. |

## Lo que NO es diferente (y podría parecerlo)

- **Cálculo de `forTick`.** Los dos SDKs leen `decisionEveryNTicks` de `WELCOME.timing`
  la primera vez y lo cachean; ninguno asume `3`. Compruébalo en
  `arena_sdk/bot.py::_handle_observation` y `src/index.ts::handleObservation`.
- **Ningún SDK implementa el temporizador de deadline.** Los dos simplemente
  responden tan rápido como pueden a cada `OBSERVATION`; es el servidor (T5.1)
  quien decide si la respuesta llegó a tiempo. Ninguno de los dos necesita saber
  la hora del reloj real para nada.
- **Los dos pasan la MISMA suite de contract tests** de
  `sdks/shared-contract-tests/cases/*.json` (generada una única vez por
  `sdks/shared-contract-tests/generate-cases.mjs` a partir de
  `packages/protocol/examples/` de E1) — no hay una versión de los casos por
  lenguaje.
