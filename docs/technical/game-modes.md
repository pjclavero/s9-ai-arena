# Modos de juego y rulesets

## Resumen

El motor implementa **7 modos** (`GameModeId`), configurados por **9 rulesets** del motor (`RULESETS`). La plataforma (API, BD, web y validador de mapas) sólo conoce **4** de esos modos: `deathmatch`, `team_deathmatch`, `capture_the_flag` y `zone_control`. `last_man_standing`, `domination` y `juggernaut` existen sólo en el motor (tests, CLI, simulador local y SDK). No hay forma de jugarlos desde la API ni desde la web.

Además, la plataforma tiene un **segundo catálogo de rulesets**: la tabla `rulesets` de la BD. Desde FC-C, el contenido base siembra **uno por cada modo de plataforma**, enlazado explícitamente con el motor (`config.engineRulesetId`) y con su modo (`config.mode`).

La web ya **no tiene ids de ruleset**: los pide a `GET /rulesets`. Eso cierra el `400 rulesetId desconocido` de la web ([TD-003](../roadmap/technical-debt.md#td-003)).

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
- [Inventario de modos](#inventario-de-modos)
- [Inventario de rulesets del motor](#inventario-de-rulesets-del-motor)
- [Los dos catálogos de rulesets](#los-dos-catálogos-de-rulesets)
- [Compatibilidad con mapas](#compatibilidad-con-mapas)
- [Estado de implementación por capa](#estado-de-implementación-por-capa)
- [Errores / limitaciones](#errores--limitaciones)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

- **Modo**: lógica de puntuación, objetivos y fin de partida (clase `GameMode` en `apps/arena-engine/src/sim/modes.ts`).
- **Ruleset del motor**: datos que parametrizan el modo, como límite de tiempo, puntos para ganar, respawn, fuego amigo y presupuesto (`packages/game-rules/index.ts`). Lo que haga cada ruleset se lee del ruleset, no del código del modo.
- **Registro de modos** (`MODE_REGISTRY`): equipos mínimos y máximos, política de respawn, requisitos del mapa y desempate. `createMode()` lo aplica siempre: una combinación incompatible **no crea la batalla**.

## Cómo funciona

Ruleset base que heredan todos (`packages/game-rules/index.ts:124-133`):

| Campo | Valor base | ¿Lo aplica el motor? |
|---|---|---|
| `timeLimitTicks` | 9000 (5 min a 30 Hz) | Sí (fin por tiempo) |
| `scoreToWin` | 3 | Sí (salvo LMS) |
| `friendlyFire` | false | Sí (proyectiles, explosiones, minas) |
| `respawn` | `{enabled:true, delayTicks:150}` | Sí (paso 7 del bucle) |
| `maxConsecutiveTimeouts` | 20 | Sí (descalifica) |
| `budgetCredits` | 1000 | Lo valida el validador de loadout. El motor sólo lo propaga |
| `sharedTeamVision` | false | **No lo aplica la simulación**. Sólo se pasa al protocolo de bots (`protocol-server.ts:444`) |
| `disconnectGraceTicks` | 60 | **Ningún código lo lee** |
| `spectator` | — | Lo usa el gateway de espectador (niebla y retardo) |
| `match` | — | Sólo lo lee `MatchRunner` (`match.ts`), que **no usa la plataforma** |

Ganador por defecto (`BaseMode.winner`):

1. Un equipo alcanza `scoreToWin`.
2. Se agota el tiempo: gana la mayor puntuación, con empate si hay igualdad.
3. Sin respawn y con un solo equipo vivo, gana ese equipo; si no queda nadie vivo, empate.

## Inventario de modos

### `deathmatch`

- **Objetivo**: destruir vehículos rivales. Cada vehículo es su propio equipo.
- **Puntuación**: +1 al equipo del autor por cada kill de otro equipo (`onKill`).
- **Victoria**: `scoreToWin`, tiempo o último vivo (si no hay respawn).
- **Restricción**: si dos participantes comparten `team`, el constructor lanza un error: «deathmatch exige que cada vehículo sea su propio equipo…».
- **Mapa**: sin requisitos en el motor. El validador de mapas exige al menos 2 spawns.

### `team_deathmatch`

- **Objetivo**: kills por equipos.
- **Puntuación**: +1 por kill. Con fuego amigo, matar a un compañero da el punto a los rivales.
- **Victoria**: regla por defecto.
- **Mapa**: el validador exige spawns de al menos 2 equipos.

### `capture_the_flag`

- **Objetivo**: llevar la bandera rival a la base propia.
- **Reglas**: máquina de estados por bandera (`at_base`, `carried`, `dropped`, `returning`, `captured`):
  - se toma tocándola (2 m);
  - cae al morir el portador;
  - vuelve sola tras `flagReturnTicks`, o al tocarla su equipo;
  - con `requireOwnFlagAtBase`, no se puntúa si la bandera propia no está en base.
- **Puntuación**: +1 por captura.
- **Victoria**: regla por defecto.
- **Mapa**: exactamente 2 equipos y **una bandera y una base por equipo**.

### `zone_control` (incluye King of the Hill)

- **Objetivo**: ocupar zonas de captura.
- **Reglas**:
  - sólo puntúa una zona con **un único equipo dentro**; vacía o disputada, no puntúa nadie;
  - suma `zone.pointsPerTickHeld` por tick;
  - KotH es este mismo modo con una sola zona.
- **Victoria**: `scoreToWin` (500 en `zc_mvp@1`, 100 en `koth_mvp@1`) o tiempo.
- **Mapa**: mínimo 2 equipos y **al menos 1 zona `capture`**.

### `last_man_standing` (sólo motor)

- **Objetivo**: eliminación.
- **Reglas**: respawn **prohibido**. Las kills sólo sirven de desempate.
- **Victoria**: último equipo con vivos. Si se agota el tiempo, gana quien tenga más vivos y, después, más kills.
- **Rondas**: el nivel de varias rondas con cambio de lado (`lms_bo3@1`) vive en `MatchRunner`. **Ni el worker ni la API lo usan**: una batalla de plataforma sería una sola ronda.
- **Mapa**: mínimo 2 equipos.

### `domination` (sólo motor)

- **Objetivo**: mantener la propiedad de varias zonas permanentes.
- **Reglas**: la zona se toma estando solo dentro y **la propiedad persiste** al salir.
- **Puntuación**: `pointsPerTickPerZone` × zonas en propiedad.
- **Mapa**: mínimo 2 equipos y **al menos 2 zonas `capture`**.

### `juggernaut` (sólo motor)

- **Objetivo**: un vehículo marcado al que el resto puntúa destruir.
- **Reglas**: la marca rota al equipo que lo derriba; respawn **obligatorio**.
- **Puntuación**: 3 por derribar al marcado y 1 por cada kill del equipo del marcado (`jugg_mvp@1`).
- **Mapa**: mínimo 2 equipos.

## Inventario de rulesets del motor

| Id | Modo | Diferencias con la base |
|---|---|---|
| `dm_practice@1` | deathmatch | `scoreToWin` 5, **sin respawn** |
| `tdm_mvp@1` | team_deathmatch | `scoreToWin` 8 |
| `ctf_mvp@1` | capture_the_flag | `scoreToWin` 3; `ctf:{requireOwnFlagAtBase:true, flagReturnTicks:300}` |
| `zc_mvp@1` | zone_control | `scoreToWin` 500; 1 punto/tick |
| `koth_mvp@1` | zone_control | `scoreToWin` 100; 1 punto/tick |
| `lms_bo3@1` | last_man_standing | sin respawn, 6000 ticks, `match:{rounds:3, swapSides:true}` |
| `dom_mvp@1` | domination | `scoreToWin` 300; 1 punto/tick/zona |
| `jugg_mvp@1` | juggernaut | `scoreToWin` 3 |
| `skirmish_low@1` | team_deathmatch | presupuesto 600, 4500 ticks, `scoreToWin` 5 |

Correspondencia **modo → ruleset por defecto** usada por la plataforma (`MODE_DEFAULT_ENGINE_RULESET`, `apps/api/src/services/battle-ruleset-resolver.ts:53-61`):

| Modo | Ruleset |
|---|---|
| `deathmatch` | `dm_practice@1` |
| `team_deathmatch` | `tdm_mvp@1` |
| `capture_the_flag` | `ctf_mvp@1` |
| `zone_control` | `zc_mvp@1` |
| `last_man_standing` | `lms_bo3@1` |
| `domination` | `dom_mvp@1` |
| `juggernaut` | `jugg_mvp@1` |

`koth_mvp@1` y `skirmish_low@1` no son accesibles por modo en la plataforma.

## Los dos catálogos de rulesets

| | Rulesets del motor | Tabla `rulesets` (BD) |
|---|---|---|
| Dónde | `packages/game-rules/index.ts` | Migración `002`. El modo y el enlace al motor van en `config` (jsonb); no hace falta migración nueva |
| Contenido base | 9 ids `*@1` | `deathmatch-mvp`, `team-deathmatch-mvp`, `capture-the-flag-mvp`, `zone-control-mvp` (con `config.mode` + `config.engineRulesetId` = `dm_practice@1`, `tdm_mvp@1`, `ctf_mvp@1`, `zc_mvp@1`) y `mvp-default` (agnóstico, `mode: null`) |
| Quién lo siembra | — | `seedContent` = `cli.ts bootstrap`. Es idempotente (`onConflict ignore`), **no crea usuarios** y no sobrescribe un ruleset que un operador haya ajustado |
| Quién lo usa | Worker (por modo) y launcher real | La API: `GET /rulesets` (web), `POST /battles` y `POST /tournaments` (el id debe existir), `resolveBattleRuleset` (`config.engineRulesetId`) y `checkBattleContent` (`config.mode`) |

Los ids de la BD son **de la plataforma** y, a propósito, distintos de los del motor. El enlace va en `config.engineRulesetId`. Así, si la web volviera a enviar un id del motor, la API respondería `400` y el E2E se pondría rojo (mutación comprobada).

### `GET /rulesets`

`x-min-role visitor`, anónimo. Acepta `?mode=<modo>` (con un modo que no es de plataforma, `400`).

```json
{ "modes": ["deathmatch","team_deathmatch","capture_the_flag","zone_control"],
  "items": [ { "id": "deathmatch-mvp", "name": "Deathmatch (práctica)", "mode": "deathmatch",
               "engineRulesetId": "dm_practice@1", "budgetCredits": 1000, "forbiddenCategories": [] } ] }
```

Con `?mode=X` devuelve los de ese modo y los agnósticos (`mode: null`).

### `checkBattleContent` (para quien crea batallas)

`apps/api/src/routes/catalog.ts`: `checkBattleContent(db, {mode, rulesetId, mapId, mapVersion?})`. Es fail-closed y devuelve:

| Código | Estado | Cuándo |
|---|---|---|
| `mode_invalid` | 400 | El modo no es de plataforma |
| `ruleset_unknown` | 400 | El ruleset no existe en la BD |
| `ruleset_mode_mismatch` | 409 | `config.mode` es otro modo |
| `map_not_published` | 400 | El mapa o la versión no están publicados |
| `map_mode_unsupported` | 409 | El modo no está en `supported_modes` |

**Pendiente de B:** `createPracticeBattle` (`battles.ts`, área de B) todavía hace sus propias consultas y no comprueba ni el modo del ruleset ni el del mapa. La propuesta está en COORD y en el informe DEV-C.

## Reglas de batalla: presets, personalizado y copia inmutable (ADR-021)

- **Modelo:** `packages/game-rules/battle-rules.ts` (`RulesParams`, `RULES_PRESETS`, `RULES_LIMITS`, `resolveRulesRequest`, `engineRulesetFor`, `checkComposition`, `statsProfileOf`). Puro: lo usan API, worker, stats y web.
- **Motor:** dos campos opcionales del `Ruleset`: `respawn.maxRespawns` (reapariciones por vehículo; agotadas, eliminado) y `timeoutTiebreak` (`score`/`lives`/`hull`). Sin ellos, 0.3.0 tal cual (hashes fijados en `apps/arena-engine/tests/rules-respawn-tiebreak.test.ts`). `vehicle_eliminated` es público (replay/espectador) y no se reparte a los bots.
- **API:** `POST /battles` acepta `rules: { preset | "custom", teamSize, params? }` y guarda la copia en `battles.rules` (migración `015_battle_rules`); 400 `rules_invalid`/`rules_team_size`, 409 `rules_mode_mismatch`, 422 `composition_invalid`. `POST /battles/rules-check` hace lo mismo sin crear. `GET /rulesets` añade `presets` y `custom.limits`.
- **Worker:** con copia juega `rules.engineRuleset` con `rules.catalogVersion`; sin copia (anteriores, torneos), el camino de siempre.
- **Stats:** con respawn limitado, `lives`, `respawnsRemaining`, `eliminated` por bot y `respawnsRemaining` por bando; `respawns` por bando siempre. `GET /battles/{id}/stats` añade `profile` (`elimination`, `limited_respawn`, `deathmatch`, `time`, `classic`).

## Compatibilidad con mapas

Hay tres comprobaciones distintas, que no se coordinan entre sí:

1. **Validador de mapas** (`apps/map-service/src/validate/mode.ts`). Revisa cada modo de `meta.supportedModes`, pero **sólo conoce los 4 modos de plataforma**.
2. **Motor** (`modeMapIncompatibilities`). Al crear la batalla comprueba equipos, respawn, banderas y bases, y número de zonas `capture`.
3. **API**: `checkBattleContent` comprueba `supported_modes` y el modo del ruleset, pero `POST /battles` y los torneos **aún no la llaman** (B). La web de nueva batalla sólo ofrece los mapas que soportan el modo elegido.

Mapas del repositorio:

| Mapa | `meta.supportedModes` | Banderas/bases | Zonas `capture` | Juega en (motor) |
|---|---|---|---|---|
| `maps/mvp-arena-01.json` (v1) | capture_the_flag, team_deathmatch | 2/2 | 0 (2 zonas de daño) | deathmatch, team_deathmatch, capture_the_flag. **No** zone_control ni domination |
| `mvp-arena-02` v1 (contenido base, misma geometría) | deathmatch, team_deathmatch, capture_the_flag | 2/2 | 0 | Igual que la fila anterior |

Corregido en FC-C: el seed guardaba `supported_modes=["deathmatch"]` para `mvp-arena-01`, porque leía de la raíz del documento. Ahora lo deriva de `meta.supportedModes`, y `bootstrap` corrige esa columna en BD ya sembradas.

Ningún mapa de serie soporta `zone_control`. Para jugarlo hay que crear un mapa con una zona de captura en el editor.

## Estado de implementación por capa

| Modo | Motor | API práctica | Torneos (API/BD) | Web (crear batalla) | Web (torneo) | Validador mapas |
|---|---|---|---|---|---|---|
| deathmatch | Sí | Sí | Sí | Sí (202, E2E de navegador) | Sí | Sí |
| team_deathmatch | Sí | Sí | Sí | Sí (ruleset de la BD) | Sí | Sí |
| capture_the_flag | Sí | Sí | Sí | Sí (ruleset de la BD) | Sí | Sí |
| zone_control | Sí | Sí | Sí | Sí, con un mapa que tenga zona de captura | Sí | Sí |
| last_man_standing | Sí | No (`400 mode inválido`) | No (CHECK de BD) | No | No | No |
| domination | Sí | No | No | No | No | No |
| juggernaut | Sí | No | No | No | No | No |

En el visor, el HUD reconoce objetivos de bandera, zona y juggernaut (`apps/web/src/viewer/hud-model.ts`). El visor está roto en navegador ([TD-009](../roadmap/technical-debt.md#td-009)).

## Errores / limitaciones

- **El stub ignora los objetivos**: los vehículos de plataforma los conduce `HunterBot`, que caza por radar y no persigue banderas ni zonas. Una CTF en `mvp-arena-01` suele agotar los 9 000 ticks y acabar en empate (observado en la auditoría). Ver [battles.md](battles.md) y [TD-002](../roadmap/technical-debt.md#td-002).
- **Incompatibilidad tratada como fallo técnico**: una batalla `zone_control` en un mapa sin zonas de captura se acepta en la API. El motor lanza en `createMode` y el worker lo trata como fallo técnico: 3 reintentos y `failed (infrastructure)`. Derivado del código; no ejecutado en esta consolidación.
- **Deathmatch por equipos**: la web asigna `red`/`blue` a 2 bots, así que nunca choca con la regla de equipos de deathmatch. Por API, 3 bots en 2 equipos fallan igual que el caso anterior.

## Documentación relacionada

- Usuario: [Modos de juego](../user/game-modes.md), [Batallas](../user/battles.md), [Mapas](../user/maps.md)
- Técnica: [engine.md](engine.md), [battles.md](battles.md), [maps.md](maps.md), [tournaments.md](tournaments.md)
- Decisión fundacional: [ADR-000](../adr/ADR-000-decisiones-fundacionales.md)

## Verificación

Verificado contra `27f70bb`. Las filas FC-C, la integración del cierre funcional (`integration/functional-closure`) (base `0b8c12b`).

| Afirmación | Estado | Evidencia |
|---|---|---|
| 7 modos en el motor | CODE_VERIFIED | `packages/game-rules/index.ts:55-62`; `apps/arena-engine/src/sim/modes.ts:575-635,682-699` |
| 9 rulesets del motor y sus valores | CODE_VERIFIED | `packages/game-rules/index.ts:124-215` |
| Requisitos por modo (equipos, respawn, banderas, zonas) | CODE_VERIFIED | `modes.ts:575-668` |
| Deathmatch rechaza equipos compartidos | CODE_VERIFIED | `modes.ts:126-147` |
| API práctica: 4 modos | CODE_VERIFIED | `apps/api/src/routes/battles.ts:394` |
| Torneos: 4 modos en API y CHECK de BD | CODE_VERIFIED | `apps/api/src/routes/tournaments.ts:19`; `apps/api/src/db/migrations.ts:280` |
| Web de nueva batalla: modos y rulesets desde `GET /rulesets`, sin ids hardcodeados | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/web/src/pages/BattleNewPage.tsx` (`/rulesets`, `effectiveRuleset`); `tests/browser/specs/golden-path.spec.ts` (Chromium 1.48.2, fase golden de `npm run test:browser`, rc=0) |
| `GET /rulesets` y los 4 rulesets sembrados, resolubles por `resolveBattleRuleset` | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/routes/catalog.ts:133-140`; `apps/api/src/db/seeds/dev.ts:48`; `apps/api/src/routes/fc-c-content.test.ts:233` |
| `checkBattleContent` rechaza ruleset y mapa incompatibles | CODE_VERIFIED / RUNTIME_VERIFIED | `catalog.ts:71-130`; `fc-c-content.test.ts:253` |
| Web de torneo: campo de ruleset de texto libre | CODE_VERIFIED | `TournamentsPage.tsx:20` (área de B/D) |
| Validador de mapas: 4 modos | CODE_VERIFIED | `apps/map-service/src/validate/mode.ts:13-63`; `apps/map-service/src/types.ts:11` |
| Worker: modo → ruleset, sin leer `rulesets.config` | CODE_VERIFIED | `apps/tournament-worker/src/engine-executor.ts:101-117` |
| `MatchRunner` sólo lo usa el banco de balance | CODE_VERIFIED | búsqueda de `runMatch`: `apps/arena-engine/src/match.ts`, `packages/module-catalog/balance/run.ts` |
| `disconnectGraceTicks` sin lector; `sharedTeamVision` sólo en protocolo | CODE_VERIFIED | búsqueda en `apps/` y `packages/`; `apps/arena-engine/src/protocol-server.ts:444` |
| `mvp-arena-01` tiene banderas/bases y 0 zonas capture | CODE_VERIFIED | `maps/mvp-arena-01.json` (`layers.flags`, `layers.bases`, `layers.zones[].zoneType`) |
| `supported_modes` del seed derivado de `meta` (corregido) | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/db/seeds/dev.ts:150,158`; `fc-c-content.test.ts:276` |
| CTF en mvp-arena-01 termina en empate por tiempo | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 1 §B6 (entorno aislado) |
| `zone_control` en mapa sin zonas acaba `failed (infrastructure)` | DESIGN_ONLY (derivado del código, no ejecutado) | `modes.ts:661-680`; `engine-executor.ts:271-274`; `battle-runner.ts:190-193` |
