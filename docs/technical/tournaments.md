# Torneos, calendario y clasificación

## Resumen

Un torneo pasa por estos pasos:

1. Un usuario con rol `organizer` lo crea.
2. Los dueños inscriben versiones `published` de sus bots. Cada inscripción congela la pareja código+loadout.
3. El organizador cierra las inscripciones: las versiones pasan a `frozen` y se revelan las semillas.
4. El `tournament-worker` genera el calendario, juega las batallas (oficiales), resuelve las series y el cuadro, y actualiza el rating Elo y la clasificación.

Las batallas de un torneo las juega el `tournament-worker` con el ruleset elegido al crearlo y, desde el PR #201, con una copia inmutable de las reglas (ADR-022). Notas vigentes:

- necesita bots publicados y elegibles (el build en el sandbox real los produce: [TD-001](../roadmap/technical-debt.md#td-001), cerrada);
- sus batallas las ejecuta el worker con el código de cada bot en contenedores ([TD-002](../roadmap/technical-debt.md#td-002), cerrada);
- sin pool de mapas se juega en `mvp-arena-01`: la API y el scheduler soportan el `mapPool` (`apps/tournament-worker/src/scheduler.ts:108-134`), pero la web no lo envía ([TD-015](../roadmap/technical-debt.md#td-015));
- la temporada de la clasificación tiene ya una sola fuente (`STAT_SEASON`, ver [abajo](#clasificación-y-rating)).

## Índice

- [Qué es](#qué-es)
- [Ciclo de vida](#ciclo-de-vida)
- [Formatos](#formatos)
- [Calendario y batallas](#calendario-y-batallas)
- [Resultados, cuadro y rating](#resultados-cuadro-y-rating)
- [Clasificación y rating](#clasificación-y-rating)
- [API](#api)
- [Persistencia](#persistencia)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Datos principales de `tournaments`:

| Campo | Valores / nota |
|---|---|
| `name` | ≤ 64 caracteres |
| `format` | `league`, `round_robin`, `single_elimination`, `double_elimination`, `swiss`, `teams` |
| `mode` | los 4 modos de plataforma ([game-modes.md](game-modes.md)) |
| `ruleset_id` | FK a la tabla `rulesets` de la BD |
| `budget_credits` | 200–5000 |
| Otros | `catalog_version`, `map_pool` (jsonb), `rounds_per_pairing`, `entries_close_at`, `seed_commitment`, `seeds_revealed` |
| Rating | `season_id` (por defecto `season-1`), `elo_k` (por defecto 24) |
| Resultado | `champion_bot_id` |
| `state` | `draft`, `open`, `closed`, `running`, `finished`, `cancelled` |

## Ciclo de vida

1. **Crear** (`POST /tournaments`, `organizer`). Se valida formato, modo, que `rulesetId` exista en la BD y el rango del presupuesto. Se inserta con `state='open'` (no pasa por `draft`).
2. **Inscribir** (`POST /tournaments/{id}/entries`, `user`). Sólo el dueño del bot (`403 Solo el dueño inscribe su bot`), sólo versiones `published` **o `frozen`** (`409 bot_not_published` con `currentState` si su estado es otro) y **elegibles** (`409 bot_version_not_eligible`, ELIG) y una inscripción por bot (`409 already_entered`). Se copia `loadout_revision` de la versión. Si el bot ya tenía una inscripción **pendiente** con una versión que hoy no es elegible, inscribir otra versión elegible la sustituye (`200`, `replacedVersion`, auditado como `tournament.entry.version_replaced`); nunca se sustituye sola.
3. **Cerrar inscripciones** (`POST …/actions/close-entries`, `organizer` **y** quien creó el torneo o staff; si no, `403` sin efectos, #291). Si alguna inscripción pendiente usa una versión no elegible → `409 entries_not_eligible` con sus `entryId` (sin motivo: es del dueño) y no se congela ni se cierra nada. Si no:
   - marca `entries.frozen=true` y pasa cada versión inscrita de `published` a `frozen`; una versión que ya llegó `frozen` (de un torneo anterior) no se toca: ni transición ni auditoría;
   - aplica el commit-reveal de semillas: si el torneo publicó `seed_commitment`, el cierre debe traer `seeds` cuyo `sha256(seeds.join("|"))` coincida (`409 seeds_required` / `seed_reveal_mismatch`); si no, el servidor genera 8 semillas y su compromiso;
   - pone `state='closed'` y encola `generate_schedule`.
4. **Calendario** (worker, `scheduler.ts`): ver [abajo](#calendario-y-batallas). Al terminar, `state='running'`.
5. **Resultados** (worker, `results.ts`): `process_result` por batalla y `update_standings`. Al final, campeón y `finished`.
6. **Dry-run** (`POST …/actions/dry-run`, `organizer` y quien creó el torneo o staff, #291): encola `tournament_dry_run` con bots de ejemplo. Sin pantalla en la web.
7. **Cancelar** (`POST …/actions/cancel`, `organizer` + dueño del torneo —`created_by`— o staff, `moderator`+; #289, mismo predicado `canManageTournament` de #291). Ver [abajo](#cancelación).

### Cancelación

| Estado | Resultado |
|---|---|
| `draft`, `open` | `200` → `cancelled` (terminal), auditado `tournament.cancelled` (`from`, `entries`, `by`: `owner`/`staff`, `reason` opcional ≤ 256) en la misma transacción |
| `cancelled` | `200` idempotente, sin otra auditoría (el permiso se comprueba igual: un ajeno recibe `403`) |
| `closed`, `running`, `finished` | `409 tournament_not_cancellable` con `currentState` y `allowedTransitions: []`; no cambia nada |

- **No borra nada**: sólo cambia `tournaments.state`. Inscripciones (con su `frozen`), versiones, matches, batallas, clasificación y `audit_log` se conservan.
- **`running` se rechaza** a propósito: sus batallas oficiales ya movieron Elo y clasificación (`official_played_not_reverted`); una cancelación parcial dejaría el cuadro a medias con ratings aplicados. Anular lo pendiente sería otra operación (revertir/archivar).
- **Carrera con `close-entries`**: las dos transiciones bloquean la fila del torneo (`SELECT … FOR UPDATE`) y la actualizan con condición de estado (`WHERE state = 'open'` / `IN ('draft','open')`). Gana exactamente una; la otra recibe `409`. El cierre va entero en una transacción: si falla (p. ej. `seeds_required`) ya no deja inscripciones ni versiones congeladas a medias. Dentro, el paso `published → frozen` es condicional (`UPDATE … WHERE state='published'`) y sólo se audita si transiciona: dos cierres concurrentes de torneos distintos que comparten versión dejan **una** auditoría `bot.version.freeze` (FROZEN-REUSE, `tournament-cancel.test.ts` TC-F1).
- **Torneos por equipos (#290 × #289)**: cancelar **no borra nada** tampoco aquí. Las inscripciones (`entries`, con su `team_id`) y las autorizaciones de dueño (`team_entry_consents`) se **conservan como historial**: ninguna se elimina ni se congela, y las versiones de los bots no cambian de estado. Las autorizaciones siguen siendo legibles por los miembros del equipo (`listTeamEntryConsents`), pero quedan inertes: darlas, retirarlas o inscribir un equipo exige un torneo `open`, así que sobre uno cancelado responden `409 entries_closed` (el cerrojo del torneo se toma antes que cualquier otro, en el mismo orden que el cierre). Test: `team-enrollment.test.ts`, `T289X_CANCEL_CONSENTS`.
- **Worker** (defensa en profundidad; por diseño un cancelado no tiene calendario): `generate_schedule` es un no-op limpio (`done`) si el torneo está `cancelled`; `materializeBattles` no crea batallas (cuadros y suizo incluidos); `claimBattle` no reserva una batalla de un torneo cancelado (en el mismo `UPDATE`) y su `run_battle` termina `done` sin ejecutarla ni tocarla (sigue `scheduled`: `battles.status` no tiene `cancelled` y no se inventa); `process_result` nunca pisa `cancelled` con `finished`.
- **`GET /tournaments/{id}`** añade `viewerCanManage` (dueño o staff) y responde `Cache-Control: private, no-store`.
- **Web**: «Cancelar» junto a «Crear torneo» limpia el formulario y vuelve al listado sin ninguna petición; «Cancelar torneo» en el detalle sólo para quien lo administra y en `draft`/`open`, con confirmación (`window.confirm`); en los demás estados se muestra el motivo.

## Formatos

Generadores puros en `apps/tournament-worker/src/formats.ts`:

- `league` y `round_robin`: todos contra todos.
- `single_elimination` y `double_elimination`: cuadros.
- `swiss`: rondas suizas.
- `teams`: por equipos; usa `bots.team_id`, que se asigna con `POST /teams/{teamId}/bots` (`addTeamBot`) o al crear el bot ([TD-011](../roadmap/technical-debt.md#td-011), cerrada); con reglas NvN exige exactamente N bots por equipo al cerrar inscripciones (`apps/api/src/routes/tournaments.ts`, `assertRostersFitRules`). Su clasificación propia la da `GET /tournaments/{id}/team-standings`; en cualquier otro formato responde `409 not_a_team_tournament`.

Las series de varios juegos (`rounds_per_pairing`) se desempatan así: victorias en la serie, después puntuación agregada y después mejor *seed*, que es el orden de inscripción.

## Calendario y batallas

`generate_schedule` (`scheduler.ts`):

1. Valida el ruleset de la BD y resuelve el **pool de mapas**: `tournaments.map_pool` o, si está vacío, `["mvp-arena-01"]`, tomando la última versión publicada de cada mapa.
2. Genera los emparejamientos y persiste `matches` (`round`, `slot`, `pairing`, `final`).
3. Crea las batallas con:
   - `official=true`, `tournament_id`, `match_id` y `ruleset_id`;
   - una semilla por batalla `sha256(lote|slot|juego)`, verificable públicamente;
   - cambio de lado en los juegos de una serie;
   - la final con `spectator_mode='visible'` (sin retardo anti-*coaching*).
4. Encola `run_battle` con `dedupe_key` por batalla.

La ejecución de cada batalla es la descrita en [battles.md](battles.md). El loadout usado es el congelado en `entries.loadout_revision` y el catálogo, el del torneo (`catalog_version`) o el último importado.

## Resultados, cuadro y rating

`process_result` (batallas de torneo; las de práctica no hacen nada):

1. Si la serie del *match* ha terminado, la resuelve y escribe `matches.winner_bot_id` (o `winner_team_id` en `teams`).
2. Resuelve los *matches* que dependían de este (cuadro y suizo).
3. Encola `update_standings`.

`update_standings` (`tournament-worker/src/standings.ts`):

1. Aplica el Elo de la batalla oficial, idempotente por batalla (`ratings`, `rating_events`; rating inicial 1000, K del torneo).
2. Recalcula la tabla de liga del torneo.
3. En formatos que no son `teams`, recalcula `standings` de (temporada, modo) con `seasonTable` (política `official_played_not_reverted`, [abajo](#política-de-clasificación)) y llama a `updateStandings(db, t.season_id, t.mode, …)`, que la escribe e invalida la caché de 60 s.

## Clasificación y rating

- **STAT_SEASON** (TD-029): la temporada activa es `ACTIVE_SEASON_ID = "season-1"` en `apps/tournament-worker/src/season.ts`, única fuente que usan API y worker; coincide con el `DEFAULT` de `tournaments.season_id` (un test lo compara).
- `GET /standings?mode=&seasonId=` es anónimo, con caché de 60 s. `seasonId` ausente, vacío o `"current"` ⇒ la temporada activa; la respuesta la indica en la cabecera `X-S9-Season`. La web `#/ranking` no envía `seasonId` y ya ve lo que escribe el worker.
- El worker puntúa en `tournaments.season_id` resuelto con la misma función (`ratings.ts`).

### Bye (D-OP-24)

El bye (descanso del round robin/liga/suizo con n impar, o hueco del cuadro inicial de una eliminatoria) es un **avance o descanso administrativo**, no un resultado jugado:

- No es victoria, derrota ni empate; **suma 0 puntos** (también en el suizo) y no cuenta como partida disputada.
- No genera batalla ni Elo (`applyBattleRating` además lo rechaza explícitamente si apareciera una batalla colgada de un match bye).
- En eliminatorias sigue permitiendo avanzar (el match se cierra con el que tiene rival como ganador administrativo).
- `leagueTable` y `GET /tournaments/{id}/team-standings` lo cuentan en su propia columna `byes`; `wins`/`losses`/`draws` son sólo lo jugado y `played = wins + draws + losses`. Los enfrentamientos sin resultado deportivo (match `failed` o sólo batallas de límite técnico) van en `technical` y no puntúan. La clasificación de temporada ya excluía el bye y los técnicos: **torneo y temporada usan ahora el mismo criterio** (V-D-E sólo de lo jugado).
- **Suizo, equidad:** (1) nadie repite descanso mientras alguien no haya descansado (el candidato es el de menos byes; a igualdad, el peor clasificado); (2) entre candidatos, se descarta el que obligaría a repetir rival si otro lo evita; (3) desempate de la clasificación: puntos y seed. **Buchholz no está implementado** (la cabecera de `formats.ts` lo documentaba por error; deuda).
- **Sin migración ni reinterpretación del histórico:** la producción tiene 0 byes (inventario de sólo lectura), así que ningún torneo existente cambia de resultado. La tabla del torneo se calcula al vuelo; cualquier torneo futuro con byes usa esta regla. `tournaments.champion_bot_id` no se recalcula.

### Política de clasificación

`STANDINGS_POLICY = official_played_not_reverted` (`apps/tournament-worker/src/standings.ts`): la clasificación de (temporada, modo) y su Elo dependen de resultados oficiales realmente disputados, no del estado administrativo del torneo. `seasonTable` parte de las **batallas**, no de las inscripciones ni de `matches.state`, y sólo cuenta las que son:

- oficiales (`battles.official`), terminadas (`status = finished`), del modo y de un torneo no `teams` de la temporada;
- de un torneo que no esté en `draft` (`open`, `closed`, `running`, `finished` y `cancelled` aportan lo ya disputado);
- no detenidas por la salvaguarda técnica (`technical_limit`, ADR-022) ni por el tope de grabación (`recording_limit`, V1 REPLAYS PR-5): sin resultado deportivo;
- no revertidas: `battles.reverted_at` (migración `018_battle_reverted`) o, además, una batalla cuyos eventos de `rating_events` están todos revertidos.

| Estado del torneo | Efecto |
|---|---|
| `draft` | no aporta: ni clasificación ni Elo |
| `open` sin batallas | nadie aparece (nada de 0-0-0) |
| `running` | cuenta al momento; una serie en juego cuenta lo ya disputado y, si va igualada, es empate (`seriesOutcome(..., { closed: false })` no aplica el desempate por seed) |
| `finished` | normal |
| `cancelled` | conserva lo jugado, salvo lo revertido |

- **Unidad de V-D-E:** el enfrentamiento, resuelto con `seriesOutcome` (`results.ts`, el mismo criterio que el cierre del match); 3/1/0 puntos. Un **bye no suma V-D-E** (decisión del operador) y, desde D-OP-24, **tampoco lo cuenta la tabla interna del torneo** (ver «Bye»).
- **Orden:** puntos, enfrentamientos directos, diferencia de puntuación, mejor seed de inscripción, id.
- **Reversión:** `revertOfficialBattle(db, battleId)` (transacción con la batalla bloqueada) pone `battles.reverted_at` y devuelve el Elo si lo tenía. No depende del Elo: si el job `update_standings` llega después, `applyBattleRating` ve la marca y no aplica Elo. Devuelve `reverted`, `already_reverted` o `nothing_to_revert` (no existe, no es oficial, no ha terminado o es técnica). Hoy ningún endpoint ni job la invoca; sólo los tests.
- **Concurrencia del Elo:** `applyBattleRating` bloquea la batalla y luego las filas de `ratings` (por `bot_id`); la reversión sigue el mismo orden de cerrojos.
- **Deuda conocida:** [TD-073](../roadmap/technical-debt.md#td-073) (`sortTable` no transitivo con ciclos de directos).
- Despliegue y vuelta atrás de la migración 018: [upgrades.md](../operations/upgrades.md).

Es un hallazgo nuevo de esta consolidación: [TD-029](../roadmap/technical-debt.md#td-029). La auditoría vio la clasificación vacía, pero no encontró la causa.

`GET /bots/{id}/rating-history?seasonId=&mode=` usa la temporada activa por defecto. Devuelve los eventos Elo y el rating actual; para un bot **no público** sólo al dueño, a un miembro de su equipo (`team`) o a un admin; al resto, `404` ([TD-005](../roadmap/technical-debt.md#td-005)).

## API

| Método y ruta | Rol |
|---|---|
| `GET /tournaments` | anónimo |
| `POST /tournaments` | `organizer` |
| `GET /tournaments/{id}` | anónimo (extensión) |
| `GET /tournaments/{id}/battles` | anónimo (extensión) |
| `POST /tournaments/{id}/entries` | `user` |
| `POST /tournaments/{id}/actions/close-entries` | `organizer` + dueño del torneo o staff (#291) |
| `POST /tournaments/{id}/actions/dry-run` | `organizer` + dueño del torneo o staff (#291) |
| `POST /tournaments/{id}/actions/cancel` | `organizer` + dueño del torneo o staff (#289, `canManageTournament`) |
| `POST /tournaments/{id}/entries/{entryId}/actions/exclude` | `user`: dueño del bot, o `organizer` + dueño del torneo o staff (#291) |
| `GET /tournaments/{id}/matches` | anónimo |
| `GET /tournaments/{id}/team-standings` | anónimo |
| `GET /standings` | anónimo |
| `GET /bots/{id}/rating-history` | anónimo |

## Persistencia

Tablas `tournaments`, `entries` (`UNIQUE(tournament_id, bot_id)`, FK a versión y loadout), `matches`, `battles` (con `official=true`), `ratings`, `rating_events` y `standings` (PK temporada+modo+bot). Esquema completo en [database.md](database.md).

## Errores / limitaciones

- **Pool de mapas**: la web no lo configura (ni presupuesto, fechas ni series). Siempre se juega en `mvp-arena-01` ([TD-015](../roadmap/technical-debt.md#td-015)).
- **Versiones congeladas (FROZEN-REUSE)**: tras un torneo, la versión queda `frozen`: **inmutable** (código, hash y loadout fijos para siempre, trigger `bot_version_immutable`), no «usada». La misma versión exacta puede inscribirse en otros torneos, sin clonarla, republicarla ni descongelarla, siempre que siga siendo elegible (`assertTournamentEligible` en `services/version-eligibility.ts`). Las inscripciones de los torneos A y B apuntan a la misma fila de `bot_versions`.
- **Botones sin rol**: «Cerrar inscripciones» se muestra a cualquiera y sin rol responde `403 Requiere rol organizer`.
- **Cierre concurrente**: `close-entries` bloquea la fila del torneo desde #289; un segundo cierre simultáneo espera y recibe `409 illegal_transition` (`tournament-cancel.test.ts`, TC-R4). El resto de [TD-013](../roadmap/technical-debt.md#td-013) no cambia.
- **Propiedad del torneo (#291)**: gestionar un torneo (cerrar inscripciones, dry-run, excluir inscripciones ajenas no elegibles) exige ser quien lo creó (`created_by`) o staff (moderator+), además del rol del contrato. La regla única es `canManageTournament` (`services/tournament-access.ts`); `GET /tournaments/{id}` la expone como `viewerCanManage` (`Cache-Control: private, no-store`) y la web sólo muestra «Cerrar inscripciones» si es `true`. Un torneo sin `created_by` (creador borrado) sólo lo gestiona el staff. Inscribir o retirar el propio bot sigue siendo del dueño del bot.
- **Fallos de infraestructura**: una batalla `failed (infrastructure)` ya no deja la serie sin cerrar. Con la política definitiva de `failed` (#299/#301, `apps/tournament-worker/src/results.ts`, `settleMatch`) el match se cierra cuando todos sus juegos son terminales: si todos fallaron queda `failed` sin puntos ni Elo (en eliminatoria avanza el mejor seed; si es la final, el torneo termina sin campeón) y el torneo llega siempre a `finished`. Test: `tournament-lifecycle-failed.test.ts`. **V1 REPLAYS PR-5**: lo mismo vale para una serie cuyos juegos no tienen resultado deportivo (`recording_limit`/`technical_limit`, lista única `battle-end-reasons.ts`). En doble eliminación, si la gran final (`GF`) termina sin resultado, `GF2` no se juega y se cierra `failed` (sin ganador ni batallas) y el torneo termina sin campeón; `GF2` sólo es una formalidad si la `GF` fue real. Nunca queda un match `finished` con ganador y sin batallas con resultado. Tests: `v1-replay-pr5-series.test.ts`.
- **CTF y control de zona (fuera de V1)**: B3 (D-OP-9): `POST /tournaments` responde 400 `tournament_mode_not_allowed` (con `mode` y `allowedModes`) para esos modos, con reglas clásicas, preset o personalizadas, y también si el `rulesetId` resuelve a un ruleset del motor de otro modo. La lista permitida (`deathmatch`, `team_deathmatch`) sale de una única fuente, `apps/tournament-worker/src/tournament-modes.ts` (la web la espeja con un test de deriva). No existe otra vía de alta (sin PATCH, clonado ni plantillas de torneo). Torneos ya creados: no se tocan y se leen igual; `closeEntries` responde 409 `tournament_mode_not_allowed` (no congela nada); un torneo ya `closed` con modo excluido puede cancelarse (única ampliación de `CANCELLABLE_TOURNAMENT_STATES`); y `generate_schedule` falla con `tournament_mode_not_allowed` (según la clase del fallo, reintenta hasta `max_attempts` o pasa directo a `needs_review`), sin batallas ni cambio de estado. Política propuesta y NO aplicada: guarda equivalente en `run_battle` para batallas de torneos antiguos ya programadas (toca `queue.ts`/claim, de #329). Antes el scheduler etiquetaba los bandos `A`/`B` y el motor exige bandera y base por equipo o zonas de captura, así que la única batalla fallaba al arrancar. Pruebas: `v1-b3-tournament-modes.test.ts`, `v1-tournament-ctf-zone.e2e.test.ts`.
- **Mínimo de inscritos**: `close-entries` responde `409 not_enough_participants` con menos de 2 inscritos (2 equipos en `teams`), con `required`, `current` y `unit` (`routes/tournaments.ts`).

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear, inscribir y cerrar (con `organizer`); generación del calendario; ejecución automática; cuadro; Elo; commit-reveal de semillas. Verificado de punta a punta en navegador real en un entorno aislado, con versiones publicadas forzadas en la BD (auditoría).
- **PARCIAL**: los formatos distintos de `single_elimination` solo tienen pruebas a nivel de generador (`formats.test.ts`); una batalla `failed` ya no bloquea el cierre (política #299, TD-015 mejorada); CTF y control de zona no son jugables en torneos, se rechazan al crear (B3) y quedan fuera de V1 ([TD-070](../roadmap/technical-debt.md#td-070)).
- **PENDIENTE**: selector de pool de mapas y resto de parámetros en la web, clasificación por torneo en la web.

## Documentación relacionada

- Usuario: [Torneos](../user/tournaments.md), [Clasificaciones](../user/rankings.md), [Equipos](../user/teams.md)
- Técnica: [battles.md](battles.md), [game-modes.md](game-modes.md), [api.md](api.md)
- Arquitectura (A): [queue.md](queue.md), [workers.md](workers.md), [database.md](database.md)
- Decisión: [ADR-E9-002 rating Elo](../adr/ADR-E9-002-rating-elo.md), [ADR-E9-001 cola](../adr/ADR-E9-001-cola-postgres-redis.md)
- Histórico absorbido: R12 (cuadro, preparación de batallas, torneos y ranking) (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| Formatos, modos, validaciones y `state='open'` al crear | CODE_VERIFIED | `apps/api/src/routes/tournaments.ts:18-19,72-127` |
| Reglas de inscripción | CODE_VERIFIED | `routes/tournaments.ts:170-209` |
| Congelado, commit-reveal y encolado de `generate_schedule` | CODE_VERIFIED | `routes/tournaments.ts:211-270` |
| Pool por defecto `mvp-arena-01` | CODE_VERIFIED | `apps/tournament-worker/src/scheduler.ts:107-108` |
| Batallas oficiales con semilla derivada | CODE_VERIFIED | `scheduler.ts:51-56,160-195` |
| `process_result` no hace nada en práctica | CODE_VERIFIED | `apps/tournament-worker/src/results.ts:328-333` |
| Elo y `updateStandings` con `t.season_id` | CODE_VERIFIED | `apps/tournament-worker/src/standings.ts:16-45` |
| `season_id` por defecto `season-1` | CODE_VERIFIED | `apps/api/src/db/migrations.ts:543` |
| `GET /standings` resuelve la temporada con STAT_SEASON | CODE_VERIFIED + test | `apps/api/src/routes/standings.ts:22`; `apps/tournament-worker/src/season.ts:24`; `apps/api/src/stat-season.test.ts` |
| La web no envía `seasonId` | CODE_VERIFIED | `apps/web/src/pages/RankingPage.tsx:38` |
| Torneo `round_robin` completo desde la UI (organizer) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1b (entorno aislado, versiones forzadas) |
| La clasificación sale vacía en la web | RUNTIME_VERIFIED (síntoma) / CODE_VERIFIED (causa propuesta) | Auditoría B p2 §1b («Todavía no hay clasificación»); causa por los ficheros anteriores |
| Versiones `frozen` reinscribibles tal cual (FROZEN-REUSE) | CODE_VERIFIED + test | `services/version-eligibility.ts` (`assertTournamentEligible`); `apps/api/src/frozen-reuse.test.ts` |
