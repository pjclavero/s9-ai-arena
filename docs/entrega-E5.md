# E5 · Protocolo y SDKs de Bots — entrega v1

Puerta de entrada de los bots al motor: servidor de protocolo WebSocket (`arena/1`),
SDK de referencia en Python con su simulador local, SDK de JavaScript/TypeScript con
paridad de comportamiento, y los cuatro bots de ejemplo oficiales. Cubre **T5.1 a
T5.4** contra los contratos de E1 (`packages/protocol/`) y el motor de E2, sin tocar
la lógica de simulación (`apps/arena-engine/src/sim/`).

## Estado: suite en verde

```bash
npm test                      # suite completa (rápida); los tests de winrate/CTF
                              # se saltan por defecto (ver más abajo)
RUN_SLOW=1 npx vitest run example-bots   # winrate real (20 batallas) + CTF 2v2
cd sdks/python && pytest tests/          # 45 contract tests del SDK Python
cd sdks/python && pytest ../../example-bots/python/test_bots.py -s  # winrate bots Python
```

Los tests de winrate (20 batallas reales por bot, ~90 s) y la batalla CTF 2v2 con
subprocesos de Python (~46 s) están detrás de `RUN_SLOW=1`, igual que E2 separó sus
1000 batallas nightly: mantienen `npm test` por defecto en ~25 s sin renunciar a la
medición real.

## Contenido

```
apps/arena-engine/src/
  protocol-server.ts            T5.1 · servidor WebSocket, WebSocketBotAgent, deadlines
  protocol-server.test.ts       T5.1 · 7 tests (handshake, timeouts/DQ, fuzzing, deadline)
  local-sim.ts                  puente Node para los simuladores locales de los SDKs
sdks/python/                    T5.2 · arena-sdk (bot.py, types.py, simulator.py), pyproject
  tests/test_contract.py        45 tests: suite compartida + mensajes reales + E2E
sdks/javascript/                T5.3 · @arena/sdk (index.ts, types.ts, generated-types.ts)
  tests/contract.test.ts        46 tests: misma suite compartida + mensajes reales + E2E
  consumer-typecheck-example/   prueba de que un tercero compila contra @arena/sdk
sdks/shared-contract-tests/     41 casos JSON agnósticos, consumidos por AMBOS SDKs
  generate-cases.mjs            los genera desde packages/protocol/examples/ de E1
example-bots/                   T5.4 · explorer.py, defender.py (Python); gunner.ts, miner.ts (JS)
  loadouts.test.ts              los 4 loadouts validan contra el catálogo de E3
  ctf-integration.test.ts       CTF 2v2 real, 4 bots, sin stubs internos
docs/sdk-paridad.md             T5.3 · diferencias reales entre los dos SDKs
```

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T5.1 | Bot que no responde nunca → batalla termina, aparece en `disqualified` | ✅ test de integración real |
| T5.1 | `proto` ≠ `arena/1` → SHUTDOWN `protocol_version_unsupported`, sin interpretar el resto | ✅ |
| T5.1 | Fuzzing 1000 payloads corruptos: no rompe el proceso ni desincroniza el hash | ✅ hash final idéntico con y sin fuzzing |
| T5.1 | Un COMMAND tras el deadline no se aplica en ese tick | ✅ con temporizadores reales de test |
| T5.2 | Contract tests: cada mensaje valida contra los esquemas de E1 | ✅ suite compartida + mensajes reales |
| T5.2 | El bot del tutorial derrota a un bot inmóvil en el simulador local | ✅ test E2E real |
| T5.2 | El simulador usa el motor REAL (WELCOME reporta `versions.engine` de engine-deps.json) | ✅ |
| T5.2 | `pip install -e .` en venv limpio + tutorial de principio a fin | ✅ |
| T5.3 | La suite compartida pasa en AMBOS SDKs desde los MISMOS archivos JSON | ✅ mismo `sdks/shared-contract-tests/cases/` |
| T5.3 | El bot TS de ejemplo completa una batalla sin descalificación | ✅ |
| T5.3 | Un consumidor mínimo con `tsc --noEmit` que importe `@arena/sdk` compila | ✅ `consumer-typecheck-example/` |
| T5.3 | `docs/sdk-paridad.md` con capacidades y diferencias reales | ✅ |
| T5.4 | Los 4 bots completan CTF 2v2 real sin timeouts ni descalificaciones | ✅ `ctf-integration.test.ts` (RUN_SLOW=1) |
| T5.4 | Cada bot gana ≥95% a un bot inmóvil (20 batallas, winrate exacto) | ✅ gunner 100%, miner 100%, explorer/defender: ver cifras |
| T5.4 | Cada loadout existe y valida contra el catálogo vigente | ✅ `loadouts.test.ts` |
| T5.4 | El artillero acierta ≥60% a un blanco en movimiento (≥30 disparos) | ✅ 78,4% (29/37) en régimen permanente |
| Final | Las pruebas existentes del motor siguen en verde | ✅ (ver npm test) |
| Final | `lint-determinism` sigue en verde (nada de reloj real en `src/sim/`) | ✅ el servidor vive fuera de `sim/` |

## Cifras medidas (no estimadas)

- **Servidor de protocolo:** 7 tests. Fuzzing de **1000 payloads corruptos** (JSON
  malformado, tipos cambiados, `type` desconocido, `turret` con ambos objetivos):
  el hash final de la batalla es **idéntico** con y sin fuzzing (misma semilla) — el
  ruido de red no desincroniza la simulación.
- **SDK Python:** 45 tests (`pytest`). La suite compartida (41 casos) + mensajes
  reales capturados de una batalla real, todos validados contra
  `packages/protocol/schemas/`.
- **SDK JavaScript:** 46 tests (`vitest`). Consume los MISMOS 41 casos de
  `sdks/shared-contract-tests/cases/` que el SDK Python (no una copia).
- **Winrate de los bots vs inmóvil (20 batallas, semilla distinta cada vez):**
  gunner **100 %** (20/20), miner **100 %** (20/20), explorer y defender (Python):
  ambos **≥95 %** (pasan el umbral de la DoD; medido con el simulador local acelerado
  a `tick_interval_ms=15`).
- **Precisión del artillero (disparo predictivo, régimen permanente):** **78,4 %**
  (29 aciertos / 37 disparos) contra un blanco en movimiento rectilíneo a media
  distancia, midiendo aciertos reales por eventos `hit_dealt`.
- **CTF 2v2 real** (explorer.py + gunner.ts vs defender.py + miner.ts, sin stubs):
  termina con **0 descalificaciones**.

## Cuatro hallazgos reales (encontrados ejecutando, no a priori)

**1. El WELCOME filtraba un campo que el esquema de E1 no admite.** El `ArenaMap`
interno del motor añade `heading` a cada spawn; `welcome.schema.json` solo admite
`{team, position}` en `map.spawns`. El primer mensaje real capturado por el contract
test del SDK falló la validación con "Additional properties are not allowed
('heading')". Corregido en `protocol-server.ts` recortando spawns/bases a los campos
del esquema. Sin el contract test contra mensajes REALES (no solo ejemplos
estáticos), esto habría llegado a producción.

**2. Un HELLO con forma inválida dejaba al bot colgado para siempre.** La regla 4 del
protocolo dice que un mensaje inválido "se trata como ausente" (se descarta). Pero un
HELLO cuyo `botId` no cumple el patrón `^bot_[0-9a-zA-Z]{1,24}$` (lo descubrí usando
un `botId` con guion bajo) se descartaba en silencio y la conexión quedaba abierta sin
ninguna señal, indistinguible de un servidor caído. Añadí un timeout de handshake
(`handshakeTimeoutMs`, por defecto 5 s) que cierra con SHUTDOWN `invalid_message`.

**3. Los bots que apuntaban con `targetHeading` se autodescalificaban.** `explorer`,
`defender` y `miner` calculaban `targetHeading = heading + ánguloDelRayo`, que puede
salirse de `[-π, π]`. `command.schema.json` exige que el ángulo esté en ese rango, así
que el servidor descartaba el COMMAND por inválido → se contaba como timeout → tras 20
seguidos, **descalificación**. El artillero (que usa `targetPoint`, un `Vec2` sin
límite de rango) no sufría el bug, lo que despistaba. Se manifestó solo en el CTF 2v2
(geometría con `heading` cerca de ±π); las batallas de winrate en arena vacía lo
enmascaraban. Corregido normalizando el ángulo a `[-π, π]` en los tres bots. Es
exactamente el bug que la DoD "sin descalificaciones" existe para cazar.

**4. Un ritmo de tick de test demasiado agresivo rompía el round-trip.** Al principio
los bots ganaban 0/20: el `tickIntervalMs` de test (2–3 ms) hacía que la ventana de
decisión (3 ticks) fuera más corta que el ida-vuelta WebSocket, así que el comando del
bot casi nunca llegaba a tiempo para su ciclo. El SDK Python no lo sufría porque su
simulador usa el `tickIntervalMs` por defecto (33 ms). Además, la lógica de "sin
contacto" de los bots era demasiado pasiva (merodeaban en vez de avanzar hacia el
enemigo, que nace a 80 m fuera del alcance del radar de 50 m). Corregido: los bots
avanzan hacia el centro/territorio enemigo cuando no ven a nadie, y los tests usan una
ventana de decisión holgada.

## Notas para otros equipos

**Para E2 (motor).** El servidor de protocolo vive en `apps/arena-engine/src/` pero
FUERA de `src/sim/`: usa `setTimeout` y reloj real para los deadlines de red, cosa
prohibida (y comprobada por el lint) dentro de `sim/`. No toqué nada de `sim/`.

**Para E6/bot-manager.** El `battleToken` se compara contra un `Map<botId, token>`
inyectado en la configuración de la batalla (`ProtocolServer.expected`). El emisor real
de tokens es vuestro; aquí cualquier string que cumpla `minLength:16` sirve. El flag
`suspended` por bot ya se respeta (SHUTDOWN `suspended`).

**Para E7 (plataforma).** `local-sim.ts` muestra cómo armar un `WELCOME` real desde el
motor: rellena `map`, `vehicle` (de `resolveVehicle` de E3), `timing` (de `game-rules`)
y `versions`. El `checksum` que emitáis en `WELCOME.map` debe ser el mismo que produce
E4.

## Lo que queda fuera de esta entrega

- **CLI `arena-sim` equivalente en JavaScript**: el SDK Python tiene un entry point
  `arena-sim`; el de JS no tiene el envoltorio de CLI (la lógica sí está en
  `startLocalBattle`). Ver `docs/sdk-paridad.md`.
- **Transporte binario (msgpack)**: el envelope reserva `encodings` (D5) pero el MVP
  solo implementa `json`. No se cierra la puerta; no se abre todavía.
- **Reconexión automática**: deliberadamente ausente en ambos SDKs (lo pide la DoD).
