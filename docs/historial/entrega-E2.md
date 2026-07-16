# E2 · Motor de Simulación — entrega v0.1

Núcleo autoritativo y determinista de S9 AI Arena. Cubre las tareas **T2.1 a T2.6** del Dosier de tareas, contra los contratos publicados por E1 (ADR-000 y `@arena/protocol`).

Headless: no depende del protocolo (E5), ni de la plataforma (E7), ni del visor (E8). Usa BotStubs internos hasta que E5 entregue el servidor WebSocket; la interfaz `BotAgent` es la misma, así que el motor no notará el cambio.

## Estado: 81 pruebas, todas en verde

```bash
npm test                                          # 81 pruebas
node apps/arena-engine/scripts/lint-determinism.mjs --self-test
npx tsx apps/arena-engine/src/cli.ts run --seed demo --out replay.jsonl
npx tsx apps/arena-engine/src/cli.ts verify replay.jsonl
```

| Suite | Pruebas | Cubre |
|---|---|---|
| `determinism.test.ts` | 11 | T2.1 · 100 ejecuciones con hash idéntico, hashes intermedios, PRNG |
| `combat.test.ts` | 23 | T2.3 · matriz de daño por sector, estados de módulo, minas |
| `sensors-fog.test.ts` | 13 | T2.4 · fuga de niebla de guerra (fuzzing de 200 posiciones), radio |
| `modes.test.ts` | 11 | T2.5 · FSM de bandera completa, fuego amigo, zonas |
| `replay-golden.test.ts` | 10 | T2.2, T2.6 · goldens de física, round-trip, detección de manipulación |
| `robustness.test.ts` | 9 | D2 · timeouts, acción segura, comandos basura, presupuesto de tick |
| `deps-pin.test.ts` | 4 | D4 · checksum del WASM de Rapier |

## Cifras medidas (no estimadas)

- **Determinismo:** 100 ejecuciones de la misma semilla → mismo hash sha256, hasta el último tick. Semillas distintas divergen.
- **Rendimiento:** 8 vehículos a **1,01 ms/tick** = **3 % del presupuesto** de 33,3 ms de los 30 Hz. Headless: **~195× tiempo real** (100 s de juego en 0,5 s).
- **Replays:** 6,98 MB en crudo → **0,15 MB con zstd** (ratio 46,7×) para una batalla de 5 minutos.
- **Física:** Rapier 0.19.3, WASM fijado por sha256. Determinista en este entorno.

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T2.1 | 100 ejecuciones, mismo hash | ✅ (la CI nightly debe subirlo a 1000) |
| T2.1 | Lint anti-reloj / anti-Math.random que rompe el build | ✅ con autocomprobación |
| T2.1 | Batalla de 3000 ticks < 5 s | ✅ 0,5 s |
| T2.2 | Escenarios golden reproducen sus trazas | ✅ chase, head_on, slalom, combat |
| T2.2 | Checksum del WASM verificado en arranque | ✅ el motor se niega a arrancar si no coincide |
| T2.2 | No hay túnel a velocidad máxima | ✅ (CCD activado) |
| T2.3 | Matriz de daño contra la tabla de game-rules | ✅ |
| T2.3 | Movimiento destruido ⇒ inmóvil pero torreta y sensores vivos | ✅ |
| T2.3 | Mina inválida rechazada sin crear entidad | ✅ |
| T2.4 | Test de fuga con fuzzing | ✅ 200 posiciones |
| T2.4 | Sin lidar / lidar destruido ⇒ sin bloque lidar | ✅ |
| T2.4 | Sensores dentro del presupuesto de tick | ✅ 3 % |
| T2.5 | FSM de bandera: todas las transiciones | ✅ incluida la ilegal |
| T2.5 | Fuego amigo on/off cambia el resultado | ✅ |
| T2.6 | Round-trip: replay re-simulado = resultado oficial | ✅ hashes intermedios incluidos |
| T2.6 | Snapshots públicos sin datos privados | ✅ comprobación estructural |
| T2.6 | Frecuencia de snapshot no afecta al determinismo | ✅ |

## Dos bugs reales encontrados por las pruebas

Merece la pena dejarlos escritos, porque los dos habrían sido desastrosos en producción y ninguno se ve leyendo el código.

**1. Un bot podía tumbar el motor con una línea de JSON.** Un `{"throttle": NaN}` llegaba hasta Rapier y hacía abortar el WASM con `unreachable`, matando la batalla entera. El sandbox de E6 aísla el *proceso* del bot, pero no protege de un valor que el propio motor le pasa a la física. Solución: saneamiento en la frontera (`finite()` en `physics.ts`) aplicado a todo número que venga de un comando, más una última barrera dentro de `driveVehicle`. Sin el test de comandos basura, esto se habría descubierto en un torneo público.

**2. Las consultas de punto mentían en silencio.** El pipeline de consultas de Rapier solo se refresca en `step()`. Una consulta hecha tras añadir un cuerpo y antes del siguiente `step` miraba una escena obsoleta y devolvía "posición libre" sobre un muro. Dentro del bucle no ocurre (el paso 4 precede al 5), pero era una trampa para cualquiera que usara `PhysicsWorld` directamente. Solución: `syncQueries()` con un `step` de dt=0, que refresca sin integrar nada.

## Notas para otros equipos

**Para E5 (protocolo/SDK).** La interfaz que necesitáis es `BotAgent { decide(observation) → command | null }`. `Battle.observationFor(vehicleId)` ya devuelve observaciones que **validan contra `observation.schema.json` de E1** (hay un test que lo comprueba). Devolver `null` es exactamente lo que debe hacer el servidor cuando un bot no responde antes del deadline: el motor aplica la acción segura y cuenta el timeout. No hace falta que inventéis nada.

**Para E3 (módulos).** El motor consume `VehicleSpec` (chasis + `ModuleSpec[]`). Los `fixtures.ts` contienen un catálogo **provisional** con valores razonables pero sin balancear — es un andamio para poder construir el motor sin esperaros, no una propuesta de balance. Sustituidlo por el catálogo real y las pruebas del motor no deberían cambiar. La degradación por estado de módulo (`MODULE_STATE_PERFORMANCE`) ya está implementada y probada.

**Para E4 (mapas).** El motor consume `ArenaMap` (muros, destructibles, spawns, bases, banderas, zonas). El `mvpArena()` de `fixtures.ts` es provisional; el real llega importado de Tiled y validado. **Aviso útil:** al probar la FSM de bandera descubrí que un bot guionizado sin evitación de obstáculos se queda pegado al primer muro. Si el validador de navegación (T4.2) no garantiza rutas con clearance suficiente, los bots simples serán injugables en vuestros mapas.

**Para E9 (torneos).** `BattleResult` incluye `finalStateHash` y `versions` (motor, física, reglas, protocolo). `replay.verify()` re-simula y confirma que el resultado oficial es auténtico; **detecta la manipulación de un solo comando** y dice en qué tick empezó la mentira. Es la base de la auditoría pública de T9.4.

**Para E6 (seguridad).** El motor ya no confía en los comandos de los bots: todo se sanea en la frontera y un bot hostil no puede provocar NaN, disparar más rápido que su cadencia, ni desincronizar la simulación (hay un test que lo prueba: la batalla con un bot basura sigue siendo determinista).

## Lo que queda fuera de esta entrega

- **Servidor WebSocket del protocolo**: es T5.1, de E5. El motor expone `observationFor()` y acepta `BotAgent`; conectarlos es trabajo de E5.
- **1000 batallas de regresión en nightly**: la infraestructura de CI es T10.1, de E10. El test está escrito para 100 por PR; subirlo a 1000 es cambiar una constante.
- **Catálogo y mapas reales**: E3 y E4. Los fixtures son andamio.
