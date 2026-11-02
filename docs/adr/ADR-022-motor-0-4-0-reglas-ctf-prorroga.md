# ADR-022 · Motor 0.4.0: reglas de batalla, desempates, CTF con prórroga y verificación de replays 0.3.0

**Estado:** propuesto (2026-11-02, EQUIPO 2 · PR #201) · **Sustituye en parte a:** ADR-021 (la decisión «el motor sigue en 0.3.0», los criterios de desempate y el nombre `respawnsPerBot`) · **Ámbito:** `apps/arena-engine` (`engine-deps.json`, `engine-compat.ts`, `sim/modes.ts`, `sim/battle.ts`), `packages/game-rules` (`index.ts`, `battle-rules.ts`, `map-compat.ts`, `rules-doc.ts`), `apps/replay-service` (`store.ts`), `apps/api` (POST /battles, POST /tournaments, GET /maps, GET /rulesets, migración 015), `apps/tournament-worker` (`scheduler.ts`, `container-agents.ts`), `apps/web` (`BattleNewPage.tsx`, `BattleRulesPicker.tsx`)

## Contexto

El operador cerró estas decisiones (encargo EQUIPO 2, 2026-11-02):

1. Las semánticas nuevas usan **`engine.version = 0.4.0`**; no se reutiliza 0.3.0 para replays cuya semántica cambió; las batallas históricas conservan su versión.
2. Copia **inmutable** de las reglas en la batalla **y en el torneo**.
3. Presets oficiales **versionados e inmutables** (si cambia una regla, `v2`; nunca se edita `v1`).
4. `maxRespawns` = número de veces que un bot puede **reaparecer** (vidas = `maxRespawns + 1`), explícito en la UI.
5. CTF base = semántica de `ctf_mvp@1` con un preset concreto y **prórroga** sin reinicio de estado.
6. Desempates **exactos** por modo (sustituyen a «vidas → bajas → casco» de ADR-021).
7. Personalizado: sólo parámetros competitivos; presupuesto de equipo con reparto desigual.
8. Migración 015 sólo si es necesaria, con prueba de upgrade, rollback y backup/restore.
9. Compatibilidad de mapas por modo explicada en la UI; documentación consumible por el Centro de Ayuda.

## Decisión

### 1. Versión del motor y replays históricos

- `engine.version` pasa a **0.4.0** y `engine-deps.json` declara **`engine.reproduces: ["0.3.0"]`**.
- `engineCanVerify()` (`apps/arena-engine/src/engine-compat.ts`) decide cómo se verifica un replay:
  - versión actual ⇒ se re-simula;
  - versión de `reproduces` **y** ruleset de cabecera sin reglas de 0.4.0 (`respawn.maxRespawns`, `timeoutTiebreak`, `overtime`) ⇒ se re-simula con 0.4.0 y la respuesta lo dice (`verifiedWith: "0.4.0"`, `compat: true`; `POST /replays/{id}/verify` añade `recordedWith` y `verifiedWith`). La versión grabada **no se reescribe**;
  - versión de `reproduces` que declara reglas de 0.4.0 ⇒ `engine_rules_mismatch` (un 0.3.0 real no puede tenerlas: es un replay fabricado o corrupto); no se re-simula;
  - cualquier otra versión (0.2.0, 0.1.0…) ⇒ `engine_version_mismatch` como hasta ahora.
- **Por qué es correcto para 0.3.0:** todo camino nuevo del motor está detrás de un campo nuevo del ruleset (`maxRespawns`, `timeoutTiebreak`, `overtime`); el recuento de bajas por equipo (`teamKills`) no entra en el hash ni cambia la simulación. Evidencia:
  - `apps/replay-service/tests/engine-0.3.0-compat.test.ts`: tres replays **reales** grabados con el motor de producción (`main` a1a6c4e, engine 0.3.0, `git archive` en árbol temporal): DM 1v1 (`dm_practice@1`), TDM 4v4 con respawn (`tdm_mvp@1`, 8-7) y CTF 1v1 con 2 capturas (`ctf_mvp@1`). El motor 0.4.0 los re-simula **idénticos tick a tick** y la verificación es válida «con 0.4.0»;
  - `apps/arena-engine/tests/rules-respawn-tiebreak.test.ts`: hashes de 6 configuraciones fijados con el motor de 9aaad79 (= motor de producción, sin cambios en `apps/arena-engine/src` ni `packages/game-rules` entre 9aaad79 y a1a6c4e): idénticos;
  - los golden existentes (`replay-golden`, `determinism`, `spawn-4v4`, `fix-4v4-spawn-hash-identity`) siguen verdes sin regenerar.
- **Qué NO se garantiza:** checkpoints (`restoreCheckpoint`) guardados con 0.3.0 se rechazan con 0.4.0 (comprobación estricta de versión, sin cambios): una batalla en curso durante el despliegue no se reanuda desde checkpoint. Las batallas `running` en el momento del cambio deben terminar antes (procedimiento de `docs/operations/upgrades.md`).
- **Vuelta atrás a ≤ RC5.5:** un motor 0.3.0 da `engine_version_mismatch` a cualquier replay 0.4.0 (honesto: «otra versión», nunca «manipulado»). Las batallas `scheduled` con copia de reglas deben vaciarse antes (ver upgrades.md).

### 2. Reglas nuevas del motor

| Campo del `Ruleset` | Semántica | Ausente |
|---|---|---|
| `respawn.maxRespawns` | reapariciones por vehículo (ADR-021) | ilimitado |
| `timeoutTiebreak` | criterios en orden: `score`, `alive`, `lives`, `respawns_left`, `kills` (`hull` se conserva pero ningún preset lo usa) | más puntos, si no empate |
| `overtime: { kind: "next_score_wins" }` | **prórroga**: si al agotar `timeLimitTicks` los dos primeros empatan a puntos, la batalla sigue con el mismo estado y gana el primero que supere su marcador del final del tiempo. **Sin límite competitivo.** Evento público `overtime_started` (no va a los bots); `overtime` en el snapshot público y `ot` en el hash, sólo con el campo | sin prórroga |

**Salvaguarda técnica (no deportiva).** `OVERTIME_TECHNICAL_LIMIT_TICKS = 36 000` (20 min de prórroga). Si se agota sin captura, el motor DETIENE la batalla con `winner: null` y `endReason: "technical_limit"` (evento público `technical_limit`). `maxBattleTicks(ruleset) = timeLimitTicks + OVERTIME_TECHNICAL_LIMIT_TICKS` (con prórroga) alimenta el temporizador de contenedores (`container-agents.ts`).

### 3. Desempates (tabla única para presets y personalizado)

| Familia (la decide el respawn) | Orden |
|---|---|
| Eliminación (sin reaparición) | más bots vivos · más vidas/reapariciones restantes · más bajas · empate |
| Respawn limitado | más puntos · más bots vivos · más reapariciones restantes · más bajas · empate |
| Team Deathmatch / reaparición ilimitada | más puntos · más bajas · empate |
| CTF | más capturas · prórroga (mismo estado) · la siguiente captura gana · sin límite competitivo |

«Bajas» = vehículos enemigos destruidos por el equipo (fuego amigo y zonas de daño no cuentan).

**Prórroga de CTF sin tope competitivo (decisión del operador, 2026-11-02).** Sustituye al límite de 3 minutos ⇒ empate de la primera redacción de este ADR. Queda sólo la salvaguarda técnica global:

- **Valor:** 20 minutos de prórroga (36 000 ticks). Es 4 veces la duración de una CTF base de 5 minutos y está muy por encima de lo que tarda una captura (segundos o pocos minutos con bots reales). La duración máxima de una batalla queda en `timeLimitTicks + 36 000`: con el máximo del personalizado (30 min), 50 min = 90 000 ticks, por debajo del techo histórico del bucle en proceso (100 000).
- **Mecanismo, reutilizando lo que existe:**
  - `battles.status = finished` con su replay;
  - `battles.result.endReason`, el mismo campo que ya distinguía `walkover` y `sporting_failure`, con el valor nuevo `technical_limit`;
  - `result.winner = null` (nunca `"draw"`);
  - `participants.outcome = NULL`, que ya era el estado «sin resultado» de la columna;
  - `applyBattleRating` la ignora: no hay `rating_events` ni cambios en `ratings` (Elo, V-D-E).
- **Descartado:** el final `failed`/`infrastructure`, porque reintentaría una batalla determinista y perdería el replay.
- **Torneos:** no admiten prórroga, así que el caso no puede llegar a series ni clasificaciones.
- **Interfaz:** la UI y el visor dicen «Detenida por límite técnico (sin resultado deportivo)», nunca «Empate».


### 4. Presets (v1) y CTF

`duel`, `combat`, `endurance`, `team_elimination`, `team_limited_respawn`, `team_deathmatch`, `team_endurance` y **`ctf@1`** (2v2/3v3/4v4, 3 capturas, 5 min, reaparición ilimitada a los 5 s, retorno automático de 10 s, bandera propia en base, sin fuego amigo; motor `ctf_mvp@1` + prórroga). Registro congelado (`deepFreeze`), clave `id@versión`, `findPreset("id")` = versión vigente y `findPreset("id@N")` = exacta; `GET /rulesets` sólo ofrece las vigentes. `packages/game-rules/rules-040.test.ts` fija la huella de cada versión publicada: cambiar `X@1` pone el test en rojo (hay que crear `X@2`).

Los presets v1 se publicaron en la rama de PR #201 y **nunca se desplegaron**; sus textos y desempates se ajustan aquí a las decisiones del operador antes de su primera publicación. A partir del despliegue, `@1` queda congelado.

### 5. Personalizado

Parámetros: participantes (1v1–4v4), reaparición (ninguna / limitada con `maxRespawns` 0–10 / ilimitada), espera, tiempo, objetivo (bajas o capturas), victoria, créditos y masa por bot y por equipo, fuego amigo, y en CTF capturas (1–10), retorno de bandera (1–60 s) y bandera propia en base. **No** se exponen: daño, gravedad, velocidad, HP, sensores, munición infinita ni física interna; esas claves se rechazan con `forbidden_field` (no como «desconocidas»). El presupuesto de equipo admite reparto desigual (3500 cr = 1000 + 1000 + 600 + 900); un tope por bot mayor que el del equipo se rechaza.

### 6. Copia inmutable en torneos

Migración `015_battle_rules` añade `battles.rules` **y** `tournaments.rules` (jsonb, nullable; no rellena filas existentes). `POST /tournaments` acepta `rules` (mismo formato) y guarda SIEMPRE una copia (clásica si no hay `rules`, con el `budgetCredits` del torneo). El scheduler copia `tournaments.rules` tal cual en cada batalla; el worker juega esa copia. Torneos anteriores (`rules` NULL) siguen como antes. Las copias de torneo llevan además `engineRuleset.spectator.delaySeconds = 30` (`TOURNAMENT_SPECTATOR_DELAY_SECONDS`, escalado del EQ5: ningún ruleset declaraba el retardo anti-coaching y en torneos era siempre 0) salvo que el ruleset declare otro; la final (`spectator_mode = visible`) sigue sin retardo. No cambia la simulación: el motor no lee `spectator`. Límites de esta fase: en torneos no se aceptan topes de composición por bot/equipo (se usa `budgetCredits`) y el NvN del preset se comprueba al cerrar inscripciones (409 `rules_team_size`).

### 7. Mapas por modo

`packages/game-rules/map-compat.ts` es la única definición (la usan la validación de mapas, POST /battles, rules-check y GET /maps): CTF = base y bandera de ≥ 2 equipos; control de zona = ≥ 1 zona de captura; TDM = spawns de ≥ 2 bandos; DM = ≥ 2 spawns. `GET /maps` añade `modeCompatibility[modo] = { ok, declared, reasons[] }`; «Nueva batalla» sólo ofrece los compatibles y explica por qué los demás no salen. En CTF, cada bando de la batalla debe tener su base y bandera (409 `map_team_mismatch`).

### 8. Documentación canónica

`docs/user/rules.md` y `docs/user/rules.json` se **generan** del registro (`npx tsx scripts/generate-rules-doc.ts`); `packages/game-rules/rules-doc.test.ts` falla si no están al día. Es la fuente que debe consumir el Centro de Ayuda.

## Alternativas descartadas

- **Seguir en 0.3.0** (ADR-021): prohibido por la decisión 1; además, un motor 0.3.0 anterior verificaría mal (como «no coincide») un replay con reglas nuevas.
- **Subir a 0.4.0 sin `reproduces`:** todos los replays 0.3.0 de producción (RC5.2–RC5.5) pasarían a `engine_version_mismatch` sin necesidad: el motor 0.4.0 los reproduce exactamente.
- **Multi-motor (empaquetar 0.3.0 junto a 0.4.0):** duplica el motor y su WASM por una garantía que ya da la reproducción bit a bit probada con replays reales.
- **Prórroga sin límite:** una batalla podría no terminar; los temporizadores de contenedor y HTTP necesitan una cota.
- **Reiniciar posiciones en la prórroga:** contradice la decisión del operador.

## Consecuencias

- Toda batalla nueva graba `engine: "0.4.0"`. La verificación de un replay 0.3.0 dice «verificado con 0.4.0».
- `BATTLE_RULES_SCHEMA` pasa a 2 (`game`, `ctf`, `maxRespawns`); las copias de schema 1 (sólo existieron en entornos de prueba de la rama) se leen normalizadas y nunca se reescriben.
- Añadir una versión a `engine.reproduces` exige replays reales de esa versión en un test.
