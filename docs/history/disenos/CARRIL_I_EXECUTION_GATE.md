# CARRIL I · Gate de ejecución real de batallas

**Estado: PREPARACIÓN. Este documento NO enciende nada.** `S9_ENABLE_REAL_BATTLE_RUNS`
sigue apagada por decisión del operador, y ninguna de las condiciones de más abajo la
enciende por sí sola.

El objetivo es que el día que se decida abrir esa puerta la decisión se tome con
evidencia, no con confianza: qué se ejecuta, con qué límites, qué escribe, qué queda
registrado y cómo se apaga.

---

## 1 · El camino de ejecución real, pieza a pieza

```
UI/cliente
   │  POST /battles/{id}/run          (api, x-min-role: user)
   ▼
apps/api/src/routes/battles.ts  ── runBattle
   │  valida: flag ON · batalla `scheduled` · mapa publicado ·
   │          bots published/frozen con digest firmado
   │  [CARRIL I] techo de concurrencia · reserva atómica · auditoría
   ▼
apps/api/src/services/battle-run-http-launcher.ts   (BattleRunLauncher inyectado)
   │  resuelve mapa real (map_versions) · ruleset · compatibilidad mapa↔modo
   │  resuelve archetype+imageDigest de cada bot desde su loadout en BD
   │  POST /run  con cabecera `x-arena-engine-auth`
   ▼
apps/arena-engine/src/service.ts   ── POST /run
   │  auth interna (timingSafeEqual) → 401 · runner cableado → 503 · cuerpo → 400
   ▼
apps/bot-manager/src/container-battle.ts ── runContainerBattle
   │  ProtocolServer (WebSocket) + un CONTENEDOR por bot
   ▼
ProxyContainerRunner → s9-docker-proxy (allowlist, fuera del Compose) → Docker
```

Vuelta: `{ result, replay, postures, cpuMsByBot }` → el launcher persiste `cpu_ms`,
comprueba la identidad del mapa jugado, verifica el replay y lo ingesta en el
replay-service (`POST /replays/:battleId`, autenticada desde B8).

### Dónde está el corte HOY (tres puertas independientes)

| # | Puerta | Evidencia | Método de comprobación |
|---|--------|-----------|------------------------|
| P1 | `S9_ENABLE_REAL_BATTLE_RUNS` vacía en el contenedor de la api | la ruta responde `503 real_battle_runs_disabled` | `docker inspect` del contenedor + `apps/api/src/battle-run.ts` exige `=== "1"` |
| P2 | `DOCKER_PROXY_URL` **vacía** en arena-engine | `serviceConfigFromEnv` no instancia `ProxyContainerRunner`; `/run` → `503 runner_unavailable` | `docker inspect` + `service.test.ts` (5 casos sobre valores vacíos/mal formados) |
| P3 | credencial interna de `/run` | `POST /run` sin cabecera responde **401** en producción, comprobado en vivo | petición GET/POST desde otro contenedor de la plataforma |

Las tres son independientes: encender P1 con P2 cerrada deja la ruta en
`503 runner_unavailable`. **Encender la ejecución no es tocar una variable, son tres.**

> Comprobado además en vivo: el `s9-docker-proxy` corre en el host (fuera del Compose)
> y **no es alcanzable** desde las redes de los servicios (`Network unreachable` desde
> api y desde arena-engine). Cablear P2 exige además abrir esa ruta, y eso reabre la
> pregunta de exposición: el proxy **no tiene autenticación**, solo una allowlist de
> operaciones y la validación de postura del sandbox.

---

## 2 · Límites y control de recursos

**Implementado (por contenedor de bot, `container-runner.ts::DEFAULT_LIMITS` +
`ProxyContainerRunner.buildCreateBody`):**

| Control | Valor |
|---|---|
| CPU | 0,5 núcleos (`NanoCpus`) |
| Memoria | 256 MiB, `MemorySwap` igual (sin swap extra) |
| PIDs | 64 (anti fork-bomb) |
| Sistema de ficheros | `ReadonlyRootfs`, `/tmp` en tmpfs de 32 MiB `noexec,nosuid,nodev` |
| Capabilities | `CapDrop: ALL`, `no-new-privileges` |
| Seccomp | perfil restrictivo propio, INLINE en el create |
| Usuario | `10001:10001`, nunca root |
| Red | red interna de la arena, `Dns: ["0.0.0.0"]` (sin salida a Internet) |
| Arranque | `startupDeadlineMs` 5 s |

Los campos de infraestructura (`limits`, `seccompProfilePath`, `network`, `engineHost`)
**no se aceptan del cuerpo de `/run`**: salen siempre de la config del servicio
(allowlist explícita en `checkRunBattleRequestBody`, cerrada en B9 tras un hallazgo del
supervisor que coló `limits: {memMb:99999, cpus:64}`).

**Implementado en este carril:** techo de batallas simultáneas
(`S9_MAX_CONCURRENT_REAL_BATTLE_RUNS`, por defecto **1**), contado sobre
`battles.status='running'` — global y compartido con el tournament-worker.

**NO implementado (queda como condición del gate):**

- Los contenedores de bot no llevan `AutoRemove`: al terminar se paran pero **no se
  borran**. En VM108 quedan contenedores `Exited` de pruebas de hace semanas.
- No hay cuota por usuario ni rate limit en la ruta (`runBattle` es la única ruta de
  escritura pesada sin `anonQuota`), y `x-min-role` es `user`: **cualquier usuario
  autenticado** puede lanzar la ejecución de cualquier batalla `scheduled`, no solo su
  dueño ni un moderador.
- No hay presupuesto agregado (nº de batallas por hora, CPU total del host).

---

## 3 · Tiempos de espera y aislamiento de fallos

| Escenario | Qué ocurre | ¿Contenido? |
|---|---|---|
| Un bot no conecta | `whenAllConnected(min(overallTimeoutMs, 15 s))` | Sí |
| Un bot se cuelga a mitad | guard global `overallTimeoutMs` (por defecto ticks×intervalo + 15 s, tope 1 h desde el cuerpo); el `finally` para TODOS los contenedores | Sí, salvo el contenedor sin borrar |
| El motor no responde | la API aborta con `AbortController` (plazo por batalla, calculado con los ticks reales) → `failed`, "arena-engine no respondió en N ms" | Sí |
| arena-engine devuelve 502 | `failed` con el mensaje, sin ingesta | Sí |
| La batalla se jugó en otro mapa | `map_identity_mismatch`: `failed` y **no se ingesta** (compara el `ArenaMap` entero, no la etiqueta) | Sí |
| La ingesta del replay falla | `replay.ingested: false` honesto; con `REPLAY_INGEST_REQUIRED=1` la batalla es `failed` | Sí |
| El launcher lanza una excepción | **[CARRIL I]** se libera la reserva y se audita `battle.run_error` | Sí |

El fallo deportivo/técnico **no** arrastra al servicio: la API no habla con Docker, el
motor corre dentro de arena-engine y el `finally` de `runContainerBattle` limpia siempre.
Lo que sí arrastra es el **hilo de petición**: `POST /run` es SÍNCRONO y la conexión HTTP
queda abierta toda la batalla (minutos). Con el techo en 1 eso está acotado; subirlo sin
convertir la ruta en asíncrona (202 + job) es una decisión de capacidad, no gratis.

---

## 4 · Efectos sobre la base de datos

Una batalla real por este camino escribe:

| Tabla | Qué | Cuándo |
|---|---|---|
| `battles.status/started_at` | `scheduled` → `running` **[CARRIL I]** | antes de lanzar |
| `participants.cpu_ms` | CPU medida en el cgroup de cada contenedor | al volver `200` de `/run` |
| `audit_log` | `battle.run_started` / `run_finished` / `run_rejected` / `run_error` **[CARRIL I]** | alrededor del lanzamiento |
| replays (fichero + índice del replay-service) | el replay verificado | tras la ingesta |

**Hueco conocido y BLOQUEANTE para activar (no se arregla aquí porque exige inventarse
semántica):** este camino **no cierra el ciclo de vida** de la batalla. No escribe
`result`, `winner`, `final_state_hash`, `engine_versions`, `replay_ref/replay_hash`, ni
pasa a `finished`, ni calcula `battle_stats`. Todo eso lo hace `finishBattle()` en
`apps/tournament-worker/src/battle-runner.ts`, **dentro de una transacción**, para el
otro camino de ejecución (el del worker). Consecuencias:

- una batalla lanzada desde la API queda en `running` para siempre;
- `battle_stats` no se calcula, así que el `cpu_ms` que sí se persiste **no llega a
  ninguna pantalla**;
- los agregados de E9 (ranking, resultados de torneo) no ven la batalla.

No hay transacción en el camino de la API porque no hay nada compuesto que escribir
todavía: `cpu_ms` se escribe fila a fila y en **best-effort** (un fallo de BD se registra
y no tumba la batalla, que ya ocurrió). Si se interrumpe a medias, el estado que queda es
`running` + `cpu_ms` parcial + replay ingerido o no; nada corrupto, pero sí incompleto.

---

## 5 · Efectos sobre los replays

- arena-engine devuelve el `Replay` real del motor; el launcher lo **verifica**
  (`verifyAndRecompute`) y solo ingesta si el hash oficial recomputado coincide.
- Guardas previas: el `header.battleId` debe ser el pedido (no se ingesta el replay de
  otra batalla bajo el id solicitado) y el mapa jugado debe ser el pedido.
- Se ingesta con `POST /replays/:battleId` y cabecera `x-replay-ingest-auth`
  (`REPLAY_INGEST_SECRET_FILE`, secreto Docker; montado ya en api y replay-service en
  producción). Sin credencial **ni se intenta**: se reporta `ingested: false`.
- Timeout de ingesta 10 s por defecto; un fallo nunca se presenta como éxito.

---

## 6 · Registro de auditoría

Antes de este carril, la acción más sensible del producto —ejecutar código de terceros
en el host— era la **única** ruta de escritura sin auditar. Ahora deja en `audit_log`
(tabla de solo inserción, con trigger que prohíbe UPDATE/DELETE):

- `battle.run_started` — actor, batalla, modo, mapa+versión y la lista de bots con su
  versión y equipo;
- `battle.run_finished` — desenlace (`completed`/`failed`), runner, `errorCode` y si el
  replay se ingestó;
- `battle.run_rejected` — rechazo por techo de concurrencia;
- `battle.run_error` — excepción del launcher.

**Suficiente para acotar un incidente** (quién, cuándo, qué bots, qué mapa, qué pasó).
Lo que aún NO queda registrado y sería deseable antes de activar: el `imageDigest`
exacto de cada bot lanzado (hoy se resuelve dentro del launcher) y la postura de
seguridad inspeccionada de cada contenedor, que arena-engine devuelve en `postures` y la
API descarta.

---

## 7 · Reversión

Orden de apagado, de menos a más agresivo. **Nada de esto reinicia PostgreSQL.**

1. `S9_ENABLE_REAL_BATTLE_RUNS` fuera → la ruta vuelve a `503`. Las batallas en vuelo
   siguen hasta su plazo; no se lanzan nuevas.
2. `DOCKER_PROXY_URL` fuera de arena-engine → aunque la flag siguiera puesta,
   `503 runner_unavailable`.
3. Parar el `s9-docker-proxy` del host → ningún contenedor de bot puede crearse.
4. Solo si hay contenedores de bot vivos: pararlos por nombre (`bot-<botId>-v<n>-<battleId>`).

**Qué queda sucio tras un apagado:**

- batallas en `running` que nadie va a cerrar (hoy no hay transición a `finished` por
  este camino) → hay que devolverlas a `scheduled` a mano;
- contenedores `Exited` de bots, porque no se crean con `AutoRemove`;
- `participants.cpu_ms` de batallas que no llegaron a completarse.

Un procedimiento de reversión probado (drill) es una de las condiciones del gate.

---

## 8 · Condiciones para activar — gate verificable

Cada condición dice **qué hay que ver**, no "revisar X". `[VERDE]` = ya demostrado.

| # | Condición | Evidencia exigida | Método |
|---|---|---|---|
| I-1 | La ruta falla cerrada sin flag, sin runner y sin credencial | 503/503/401 | `apps/api/src/battle-run.test.ts`, `apps/arena-engine/tests/service.test.ts` `[VERDE]` |
| I-2 | El cuerpo de `/run` no puede alterar infraestructura ni envenenar prototipos | 400 en todos los casos | `service.test.ts` (allowlist, `__proto__`, seccomp/limits colados) `[VERDE]` |
| I-3 | `cpu_ms` se escribe de verdad y solo con medidas válidas | escritura observada en Postgres real | `apps/api/src/services/battle-run-cpu-ms.test.ts` (6 casos, BD real) `[VERDE]` |
| I-4 | Dos lanzamientos no ejecutan dos batallas | el launcher se invoca UNA vez; la reserva es atómica con N intentos en paralelo | `apps/api/src/battle-run-gate.test.ts` G-1 `[VERDE]` |
| I-5 | Existe techo de concurrencia y la basura del entorno no lo desactiva | 429 sin lanzar nada; `parseMaxConcurrentRuns` rechaza 10 valores basura | `battle-run-gate.test.ts` G-2 `[VERDE]` |
| I-6 | Toda ejecución deja rastro investigable | `run_started` + `run_finished` con actor, bots y desenlace | `battle-run-gate.test.ts` G-3 `[VERDE]` |
| I-7 | Un fallo no deja la batalla atrapada | vuelve a `scheduled`, `started_at` a null, en fallo ordenado y en excepción | `battle-run-gate.test.ts` G-1 `[VERDE]` |
| I-8 | **El ciclo de vida se cierra**: una batalla ejecutada llega a `finished` con resultado, hashes, replay_ref y `battle_stats` | una batalla de prueba en entorno aislado pasa de `scheduled` a `finished` con `battle_stats.cpuMs` no nulo | **PENDIENTE — bloqueante.** Exige llevar `finishBattle()` (o equivalente transaccional) al camino de la API |
| I-9 | Autorización proporcionada al riesgo | solo el dueño de la batalla o rol ≥ moderador puede lanzar | **PENDIENTE.** Hoy `x-min-role: user`, sin comprobación de propiedad |
| I-10 | Cuota por actor | N lanzamientos por hora y actor | **PENDIENTE.** La ruta no tiene rate limit |
| I-11 | Los contenedores de bot no se acumulan | tras M batallas, 0 contenedores `Exited` de bots | **PENDIENTE.** Falta `AutoRemove` o barrido |
| I-12 | La exposición del docker-proxy está acotada tras cablear `DOCKER_PROXY_URL` | desde cada red de servicio, solo arena-engine alcanza el proxy | **PENDIENTE.** Hoy es inalcanzable desde todas (bien), pero cablearlo cambia eso; el proxy no autentica |
| I-13 | Reversión ensayada | drill: apagar con una batalla en vuelo y dejar el sistema consistente | **PENDIENTE** |
| I-14 | Copia de seguridad fresca antes de la primera ejecución real | copia verificada del día | **PENDIENTE.** Procedimiento existente |

### Lo que NO se puede demostrar sin activar

Con honestidad, y por construcción:

- que el `ProxyContainerRunner` real crea contenedores con la postura esperada **en este
  host** (los tests usan un runner mock; el arnés `scripts/e2e-real-battle-smoke.ts` sí
  usa Docker real pero es opt-in y exige `S9_RUN_REAL_DOCKER_E2E=1`);
- que `cpuMsFromDockerStats` devuelve una medida real del cgroup de esta máquina — los
  tests demuestran que un número válido se persiste y uno inválido no, no que la Engine
  local lo produzca;
- el comportamiento bajo carga concurrente real (el techo se demuestra en la lógica, no
  en el consumo del host);
- la latencia real de una batalla completa y si el plazo por batalla es suficiente.

Todo eso solo se cierra con **una ejecución real en un entorno aislado** (no producción),
que es exactamente lo que habilita el arnés opt-in ya existente. Ese es el siguiente paso
natural del carril, y sigue sin tocar `S9_ENABLE_REAL_BATTLE_RUNS` en producción.
