# ADR-000 — Decisiones fundacionales

- **Estado:** Aceptado (verificado por implementación: E2, E3 y E5 construyeron contra estas decisiones y sus tests las cubren — ver tabla de firmas)
- **Fecha:** 2026-07-13 · aceptado 2026-07-16
- **Autor:** E1 · Equipo de Contratos y Especificación
- **Cierra:** capítulo 27.1 del Dosier técnico v1.0 ("Decisiones a cerrar antes de programar")

## Contexto

El Dosier técnico v1.0 deja nueve decisiones abiertas que bloquean al motor (E2), al catálogo de módulos (E3) y al protocolo (E5). Este ADR las cierra con valores concretos. Cada decisión es citable como una constante exportada por `packages/game-rules/constants.ts`.

**Regla de cambio:** ninguna de estas decisiones se modifica editando este documento. Un cambio exige un ADR nuevo que declare cuál supersede, y un *bump* de versión de los paquetes afectados según `docs/compatibilidad.md`.

## Firmas requeridas

| Equipo | Revisor | Estado |
|---|---|---|
| E2 · Motor | verificado por implementación y tests (`docs/historial/entrega-E2.md`, `packages/game-rules/constants.test.ts`) | ☑ 2026-07-16 |
| E3 · Módulos | verificado por implementación y tests (`docs/historial/entrega-E3.md`; el validador recibe `budgetCredits` como parámetro, D7) | ☑ 2026-07-16 |
| E5 · Protocolo/SDK | verificado por implementación y tests (`docs/historial/entrega-E5.md`; `arena/1`, deadline D2, envelope D5) | ☑ 2026-07-16 |

> Nota 2026-07-16: no hubo firma humana por equipo; los "equipos" son agentes. La aceptación
> se basa en que E2/E3/E5 (y después E6/E7/E10) implementaron y testean estas decisiones sin
> pedir cambios. La regla de cambio sigue vigente: cualquier modificación exige un ADR nuevo.

---

## D1 · Escala y unidades del mundo

**Decisión.** El mundo es métrico: 1 unidad de simulación = 1 metro. Ángulos en radianes, sentido antihorario, 0 rad = eje +X. Masas en kilogramos, fuerzas en newtons, energía en unidades de energía abstractas (EU) y potencia en EU/s. Tiempo en ticks (ver D2); ningún campo del protocolo expresa tiempo en segundos.

La arena del MVP mide **120 × 80 m** (equivalente jugable a los 1200×800 px del capítulo 26 con una escala de 10 px/m para el visor).

**Justificación.** Rapier trabaja mejor con magnitudes en el rango 0,1–100; usar píxeles como unidad física produce inestabilidad numérica y constantes sin significado. La conversión a píxeles es responsabilidad exclusiva del visor (E8), que aplica `PIXELS_PER_METER = 10`.

**Alternativas descartadas.** Píxeles como unidad de simulación (acopla física y presentación); unidades arbitrarias adimensionales (imposibilita razonar sobre el balance).

**Impacto.** E2 configura Rapier en metros. E3 expresa todas las propiedades del catálogo en unidades SI. E8 escala en el render. Los mapas de Tiled se importan con una escala declarada en el mapa (D‑extra: `metersPerTile`).

**Constantes.** `WORLD_UNIT = "m"`, `ARENA_MVP_WIDTH_M = 120`, `ARENA_MVP_HEIGHT_M = 80`, `PIXELS_PER_METER = 10`.

---

## D2 · Frecuencia de tick y frecuencia de decisión de bots

**Decisión.** Tick de simulación fijo a **30 Hz** (`TICK_HZ = 30`, `TICK_DT = 1/30 s`). Los bots deciden a **10 Hz**: reciben una `OBSERVATION` y pueden enviar un `COMMAND` cada **3 ticks** (`DECISION_EVERY_N_TICKS = 3`). El `COMMAND` recibido se aplica en los tres ticks siguientes hasta la próxima decisión.

El *deadline* de decisión es de **80 ms** desde la emisión de la observación (`DECISION_DEADLINE_MS = 80`), holgado frente a los 100 ms del ciclo para permitir bots en lenguajes con arranque lento sin bloquear el tick.

**Justificación.** 30 Hz da física estable con proyectiles rápidos sin coste excesivo. 10 Hz de decisión reduce a un tercio el tráfico y el coste de cómputo de observaciones (el paso más caro del bucle), y sigue siendo suficiente para combate táctico. Desacoplar ambas frecuencias permite subir el tick sin renegociar el protocolo.

**Alternativas descartadas.** Decisión a 30 Hz (triplica coste de sensores y penaliza a Python sin ganancia táctica real); tick variable (rompe determinismo).

**Impacto.** `DECISION_EVERY_N_TICKS` debe dividir exactamente el tick; un test en `game-rules` lo verifica. E5 implementa el deadline y la política de timeout. E2 aplica la acción segura (D-extra abajo) si no llega comando.

**Constantes.** `TICK_HZ = 30`, `DECISION_HZ = 10`, `DECISION_EVERY_N_TICKS = 3`, `DECISION_DEADLINE_MS = 80`.

**Decisión asociada (acción segura y desconexión).** Si no llega un comando válido a tiempo: se mantiene la última orden de movimiento y torreta, y el disparo se pone a `false`. Tres decisiones consecutivas perdidas generan un evento de aviso; `MAX_CONSECUTIVE_TIMEOUTS = 20` (2 s) provoca descalificación por ruleset. Una desconexión de transporte abre una ventana de gracia de `DISCONNECT_GRACE_TICKS = 60` (2 s) durante la cual se aplica la acción segura; superada, el vehículo queda inerte y el bot descalificado. Ningún timeout altera el orden de simulación: se registra como evento.

---

## D3 · Modelo de movimiento: arcade o físico

**Decisión.** **Arcade con inercia**, implementado sobre cuerpos rígidos de Rapier: el `COMMAND` expresa intención normalizada (`throttle ∈ [-1,1]`, `steer ∈ [-1,1]`), y el motor la traduce a velocidad objetivo y velocidad angular objetivo, aproximadas mediante aceleración y aceleración angular limitadas por el módulo de movimiento y la masa total. Sin simulación de neumáticos, deriva, suspensión ni tracción por rueda.

**Justificación.** El principio central del proyecto es que *el hardware determina lo que el código puede hacer*, no que la conducción sea difícil. Un modelo físico completo desplaza la competición desde la estrategia hacia el control de bajo nivel y multiplica el riesgo de no determinismo.

**Alternativas descartadas.** Físico completo (aplazado al capítulo 29); cinemático puro sin inercia (elimina el valor táctico de la masa y del módulo de movimiento).

**Impacto.** E3 define `maxSpeed`, `acceleration`, `turnRate` por módulo de movimiento, degradados por masa total según la fórmula publicada en `game-rules`. Las colisiones sí son físicas (Rapier resuelve el impacto).

---

## D4 · Lenguaje principal del motor

**Decisión.** **TypeScript sobre Node.js LTS 22**, con `@dimforge/rapier2d-compat` (build WASM) para la física. La versión exacta de Rapier y el **sha256 del binario WASM** se fijan en `packages/game-rules/engine-deps.json`; el motor verifica el checksum al arrancar y se niega a ejecutar si no coincide. Las batallas oficiales solo corren dentro de la imagen Docker oficial del motor.

**Justificación.** Comparte tipos, esquemas y herramientas con API, workers, SDK JS y visor (capítulo 8). Rapier expone una build determinista para JS/WASM. Rust daría más rendimiento pero duplica el ecosistema y frena las fases 1–5.

**Alternativas descartadas.** Rust (reconsiderable en el capítulo 29 si el perfil de tick lo exige); Python (rendimiento insuficiente para 30 Hz con sensores).

**Impacto.** Riesgo asumido: el determinismo de Rapier depende de la build y de la plataforma. Se mitiga con checksum del WASM, imagen oficial única y las batallas golden de regresión de E2.

**Constantes.** `ENGINE_RUNTIME = "node22"`, `PHYSICS = "rapier2d-compat"` (versión y hash en `engine-deps.json`).

---

## D5 · Formato del protocolo: JSON o binario

**Decisión.** **JSON sobre WebSocket** en el protocolo `arena/1`. Todo mensaje viaja dentro de un envelope común (`{ proto, type, tick, seq, payload }`) que reserva la migración a un transporte binario sin cambiar la semántica: la codificación es negociable en el `HELLO` mediante `encodings: ["json"]`, y una versión futura podrá anunciar `["msgpack","json"]`.

Se **medirá** en el hito M2 el coste de serialización y el tamaño de las observaciones con lidar 360; si supera el 15 % del presupuesto de tick, se abre un ADR para adoptar MessagePack o Protobuf en `arena/2`.

**Justificación.** JSON permite escribir un bot con la librería estándar en cualquier lenguaje, depurar leyendo el tráfico, y validar con JSON Schema (que ya es el contrato). El coste probablemente sea aceptable a 10 Hz de decisión con 4 bots.

**Alternativas descartadas.** Protobuf desde el inicio (fricción alta para el usuario objetivo, herramientas obligatorias en cada SDK, y optimiza un cuello de botella no demostrado).

**Impacto.** E1 mantiene el envelope y el campo `encodings`. E5 rechaza versiones de protocolo desconocidas. E2 expone la métrica de coste de serialización para la medición de M2.

**Constantes.** `PROTO_ID = "arena/1"`, `PROTO_ENCODING_DEFAULT = "json"`.

---

## D6 · Modelo de daño: simplificado o penetración por materiales

**Decisión.** **Daño simplificado por sectores** en el MVP. El vehículo tiene cuatro sectores (frontal, izquierdo, derecho, trasero) con blindaje independiente. Fórmula:

```
dañoEfectivo = max(DMG_MIN_FRACTION * dañoBase,
                   dañoBase * (1 - reducciónBlindajeSector))
```

con `DMG_MIN_FRACTION = 0.10` (el blindaje nunca anula el daño por completo). El daño efectivo se reparte: `CHASSIS_DAMAGE_SHARE = 0.7` a la integridad del chasis y `MODULE_DAMAGE_SHARE = 0.3` a un módulo del sector impactado, elegido por sorteo ponderado con el PRNG del motor.

Sin penetración por ángulo, sin tipos de material frente a tipos de munición, sin gestión de calor. La munición sí modifica `dañoBase`, radio de explosión y efecto (EMP fuera del MVP).

**Justificación.** El interés táctico procede de la pérdida de capacidades (quedar inmóvil, ciego o desarmado), no de una tabla de penetración. Una matriz munición×material es una fuente enorme de desequilibrio y de trabajo de balance que el MVP no puede absorber.

**Alternativas descartadas.** Penetración por ángulo y material (capítulo 29); daño puramente global sin sectores (elimina el juego posicional y la razón de ser del blindaje direccional).

**Impacto.** E3 define el blindaje solo por `sector` y `reducción`. E2 implementa los cinco estados de módulo del capítulo 12.2 con la tabla de degradación en `game-rules`. El calor queda **explícitamente excluido** del MVP.

---

## D7 · Presupuesto, peso y energía del MVP

**Decisión.**

- **Créditos:** el presupuesto de créditos **es un parámetro del ruleset, no una constante fija del motor**. Cada ruleset declara `budgetCredits`; si no lo declara, se aplica el valor por defecto `BUDGET_CREDITS_MVP = 1000`. El chasis consume entre el 15 % y el 30 % del presupuesto *efectivo* de la batalla; el resto se reparte entre movilidad, potencia de fuego, percepción y protección. Ningún módulo individual puede costar más del `MAX_MODULE_COST_FRACTION` (35 %) del presupuesto **efectivo** — es una fracción, así que escala junto con el presupuesto sin necesidad de retocar el catálogo (regla del catálogo, verificada en CI por E3).

  **Por qué es del ruleset y no del motor.** El presupuesto es, en la práctica, la principal perilla de dificultad y de identidad de un modo de juego: una liga "skirmish" puede correr con 600 créditos (partidas rápidas, chasis ligeros forzados) y una liga "asedio" con 2000 (todo el mundo con blindaje pesado), sin que el motor, el catálogo ni el protocolo cambien una sola línea. `WELCOME.rules.budgetCredits` informa al bot del presupuesto real de esa batalla, y el validador de ensamblaje de E3 (T3.2) recibe el presupuesto como parámetro en lugar de leer una constante global.

  **Igualdad dentro de una misma competición.** Todos los participantes de una misma ronda de torneo juegan bajo el **mismo** `budgetCredits`: es un campo más que se congela al cerrar inscripciones (cap. 17.2, E9/T9.4), igual que `catalogVersion`. Cambiar el presupuesto a mitad de un torneo no afecta a sus batallas en curso.

  **Fuera de alcance por ahora, explícitamente.** Esto NO es progresión de cuenta ni campaña: el presupuesto de una batalla oficial nunca depende de cuánto ha jugado un bot o su dueño, solo del ruleset elegido por el organizador. Cualquier mecanismo de progresión (créditos ganados en campaña, desbloqueo de módulos) es una decisión fundacional distinta, pendiente y fuera del MVP — de aparecer, debe afectar como mucho a qué módulos son *elegibles*, nunca al `budgetCredits` de una batalla oficial, para no romper la comparabilidad del rating (E9/T9.3).
- **Masa:** cada chasis declara `maxLoadKg`. La suma de masas de los módulos instalados no puede superarlo. La masa total (chasis + módulos) degrada velocidad y giro según la fórmula publicada en `game-rules` (`speedFactor = clamp(massRatio ≤ 1 ? 1 : 1/massRatio, 0.4, 1)`).
- **Energía:** modelo de **pool con recarga**. Batería (`capacityEU`) + generación (`generationEUs`). Cada módulo tiene consumo pasivo (EU/s) y coste puntual por acción (disparo, mina, utilidad). El validador exige que la generación cubra el **consumo pasivo total**; los picos los absorbe la batería. Con la batería a 0, los módulos con consumo puntual no pueden actuar y los pasivos entran en estado *crítico* intermitente.

**Justificación.** Tres presupuestos ortogonales (créditos, masa, energía) generan compromisos reales de diseño sin ser opacos: un pesado con blindaje total no puede llevar sensores caros ni mantener el consumo.

**Alternativas descartadas.** Solo créditos (permite el loadout "óptimo" único); ranuras sin presupuesto (elimina la decisión económica).

**Impacto.** `WELCOME.rules.budgetCredits` (esquema de protocolo, E1/T1.2) informa al bot del presupuesto efectivo. El validador de E3 (T3.2) y el endpoint de creación de loadout de E7 reciben `budgetCredits` como parámetro de entrada, nunca lo leen de una constante. `TournamentInput.rulesetConfig.budgetCredits` (OpenAPI, E1/T1.4) permite a un organizador fijarlo por competición. Un torneo sin ese campo usa `BUDGET_CREDITS_MVP`.

**Constantes.** `BUDGET_CREDITS_MVP = 1000` (valor por defecto, no obligatorio), `MAX_MODULE_COST_FRACTION = 0.35`, `MASS_SPEED_FLOOR = 0.4`.

---

## D8 · Alcance de la niebla de guerra y de las comunicaciones

**Decisión.** **Niebla de guerra total y por bot.** Cada bot recibe una `OBSERVATION` que contiene exclusivamente: su propio estado (pose, energía, estado de módulos, inventario) y las detecciones producidas por sus sensores instalados y operativos. Ninguna entidad no percibida aparece en la observación, ni siquiera marcada como oculta. La visión compartida **no** es automática: es una opción del ruleset (`sharedTeamVision`, por defecto `false`).

**Radio de equipo:** mensajes opacos para el motor (blob de bytes). Límites del MVP: `RADIO_MAX_MESSAGE_BYTES = 32`, `RADIO_MAX_MESSAGES_PER_SECOND = 2`, entrega solo si emisor y receptor tienen radio en estado operativo o dañado y están dentro del alcance del módulo. Los mensajes se entregan en la siguiente observación del receptor (latencia de un ciclo de decisión). Los excedentes se descartan con evento.

**Justificación.** La niebla es el núcleo del valor de los sensores; cualquier fuga la anula. Un límite pequeño de banda obliga a diseñar un código de equipo (el interés está en *qué* se decide comunicar), y hace barato el coste de simulación.

**Alternativas descartadas.** Mensajes de texto libre sin límite (convierte la radio en telepatía y elimina el valor del módulo); visión compartida por defecto (anula la especialización de exploradores).

**Constantes.** `RADIO_MAX_MESSAGE_BYTES = 32`, `RADIO_MAX_MESSAGES_PER_SECOND = 2`, `RADIO_DELIVERY_DELAY_DECISIONS = 1`.

---

## D9 · Nivel de acceso público al código de los bots

**Decisión.** El código de un bot es **privado por defecto**. El propietario puede marcar una versión publicada como `codePublic: true`, decisión irreversible para esa versión (una versión publicada es inmutable, capítulo 17.1). Siempre son públicos, para cualquier bot que participe en una batalla oficial: nombre, propietario, **loadout completo**, estadísticas y hash del artefacto. Los replays y la auditoría de batalla (E9) son públicos, y permiten verificar el resultado sin revelar el código.

**Justificación.** Obligar a publicar el código desincentiva la participación y permite el copiado trivial; ocultar el loadout haría el espectáculo incomprensible y la auditoría inútil. El hash del artefacto basta para probar que el bot que jugó es el que se inscribió.

**Alternativas descartadas.** Código siempre público (barrera de entrada); loadout oculto (el visor y el análisis pierden sentido, y el balance no es auditable).

**Impacto.** E7 modela `visibility` en bot y `codePublic` en bot_version. E7/T7.5 verifica por contrato que ningún endpoint público filtre código privado.

---

## Constantes derivadas

Todas las constantes citadas viven en `packages/game-rules/constants.ts` y están cubiertas por tests de coherencia:

- `TICK_HZ % DECISION_HZ === 0` y `DECISION_EVERY_N_TICKS === TICK_HZ / DECISION_HZ`.
- `DECISION_DEADLINE_MS < 1000 / DECISION_HZ` (el deadline cabe en el ciclo).
- `0 < DMG_MIN_FRACTION < 1` y `CHASSIS_DAMAGE_SHARE + MODULE_DAMAGE_SHARE === 1`.
- `MASS_SPEED_FLOOR ∈ (0,1)`.
- `RADIO_MAX_MESSAGE_BYTES > 0` y `RADIO_MAX_MESSAGES_PER_SECOND ≤ DECISION_HZ`.
