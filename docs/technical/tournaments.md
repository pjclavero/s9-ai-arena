# Torneos, calendario y clasificación

## Resumen

Un torneo pasa por estos pasos:

1. Un usuario con rol `organizer` lo crea.
2. Los dueños inscriben versiones `published` de sus bots. Cada inscripción congela la pareja código+loadout.
3. El organizador cierra las inscripciones: las versiones pasan a `frozen` y se revelan las semillas.
4. El `tournament-worker` genera el calendario, juega las batallas (oficiales), resuelve las series y el cuadro, y actualiza el rating Elo y la clasificación.

**Hoy es la única vía de la web que llega a jugar batallas**, porque usa el ruleset `mvp-default` de la BD. Aun así:

- necesita bots publicados, que el build no produce ([TD-001](../roadmap/technical-debt.md#td-001));
- se juega con `HunterBot` ([TD-002](../roadmap/technical-debt.md#td-002));
- siempre en `mvp-arena-01`, porque la web no envía pool de mapas ([TD-015](../roadmap/technical-debt.md#td-015));
- la clasificación pública de la web lee otra temporada distinta de la que escribe el worker (hallazgo nuevo; ver [abajo](#clasificación-y-rating)).

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
2. **Inscribir** (`POST /tournaments/{id}/entries`, `user`). Sólo el dueño del bot (`403 Solo el dueño inscribe su bot`), sólo versiones `published` (`409 bot_not_published`) y una inscripción por bot (`409 already_entered`). Se copia `loadout_revision` de la versión.
3. **Cerrar inscripciones** (`POST …/actions/close-entries`, `organizer`):
   - marca `entries.frozen=true` y pasa cada versión inscrita de `published` a `frozen`;
   - aplica el commit-reveal de semillas: si el torneo publicó `seed_commitment`, el cierre debe traer `seeds` cuyo `sha256(seeds.join("|"))` coincida (`409 seeds_required` / `seed_reveal_mismatch`); si no, el servidor genera 8 semillas y su compromiso;
   - pone `state='closed'` y encola `generate_schedule`.
4. **Calendario** (worker, `scheduler.ts`): ver [abajo](#calendario-y-batallas). Al terminar, `state='running'`.
5. **Resultados** (worker, `results.ts`): `process_result` por batalla y `update_standings`. Al final, campeón y `finished`.
6. **Dry-run** (`POST …/actions/dry-run`, `organizer`): encola `tournament_dry_run` con bots de ejemplo. Sin pantalla en la web.

## Formatos

Generadores puros en `apps/tournament-worker/src/formats.ts`:

- `league` y `round_robin`: todos contra todos.
- `single_elimination` y `double_elimination`: cuadros.
- `swiss`: rondas suizas.
- `teams`: por equipos; **necesita `bots.team_id`**, que ningún endpoint ni pantalla rellena tras crear el bot ([TD-011](../roadmap/technical-debt.md#td-011)). Su clasificación propia la da `GET /tournaments/{id}/team-standings`; en cualquier otro formato responde `409 not_a_team_tournament`.

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
3. En formatos que no son `teams`, llama a `updateStandings(db, t.season_id, t.mode, …)`, que reescribe `standings` e invalida la caché de 60 s.

## Clasificación y rating

- `GET /standings?mode=&seasonId=` es anónimo y tiene caché de 60 s. **Si no se pasa `seasonId`, la API usa `"current"`** (`routes/standings.ts:17`).
- El worker escribe con `tournaments.season_id`, que por defecto es `'season-1'`. La web `#/ranking` nunca envía `seasonId`, así que **la clasificación pública sale vacía aunque haya torneos terminados**.
- Los tests de la API usan `"current"` en los dos extremos y no detectan el desajuste.

Es un hallazgo nuevo de esta consolidación: [TD-029](../roadmap/technical-debt.md#td-029). La auditoría vio la clasificación vacía, pero no encontró la causa.

`GET /bots/{id}/rating-history?seasonId=&mode=` usa `season-1` por defecto. Devuelve los eventos Elo y el rating actual, también de bots privados ajenos ([TD-005](../roadmap/technical-debt.md#td-005)).

## API

| Método y ruta | Rol |
|---|---|
| `GET /tournaments` | anónimo |
| `POST /tournaments` | `organizer` |
| `GET /tournaments/{id}` | anónimo (extensión) |
| `GET /tournaments/{id}/battles` | anónimo (extensión) |
| `POST /tournaments/{id}/entries` | `user` |
| `POST /tournaments/{id}/actions/close-entries` | `organizer` |
| `POST /tournaments/{id}/actions/dry-run` | `organizer` |
| `GET /tournaments/{id}/matches` | anónimo |
| `GET /tournaments/{id}/team-standings` | anónimo |
| `GET /standings` | anónimo |
| `GET /bots/{id}/rating-history` | anónimo |

## Persistencia

Tablas `tournaments`, `entries` (`UNIQUE(tournament_id, bot_id)`, FK a versión y loadout), `matches`, `battles` (con `official=true`), `ratings`, `rating_events` y `standings` (PK temporada+modo+bot). Esquema completo en [database.md](database.md).

## Errores / limitaciones

- **Pool de mapas**: la web no lo configura (ni presupuesto, fechas ni series). Siempre se juega en `mvp-arena-01` ([TD-015](../roadmap/technical-debt.md#td-015)).
- **Versiones congeladas**: tras un torneo, la versión queda `frozen` y no puede inscribirse en otro. Como el build rechaza toda versión nueva, en la práctica un bot sólo juega un torneo.
- **Botones sin rol**: «Cerrar inscripciones» se muestra a cualquiera y sin rol responde `403 Requiere rol organizer`.
- **Cierre concurrente**: `close-entries` en paralelo puede dar `200` + `500` ([TD-013](../roadmap/technical-debt.md#td-013)).
- **Fallos de infraestructura**: una batalla `failed (infrastructure)` deja su serie sin cerrar. Ver [TD-015](../roadmap/technical-debt.md#td-015).
- **Clasificación vacía** en la web por el desajuste de temporada (arriba).

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear, inscribir y cerrar (con `organizer`); generación del calendario; ejecución automática; cuadro; Elo; commit-reveal de semillas. Verificado de punta a punta en navegador real en un entorno aislado, con versiones publicadas forzadas en la BD (auditoría).
- **PARCIAL**: clasificación (se calcula y se guarda, pero la web lee otra temporada); formato `teams` (sin forma de asignar bots a equipos).
- **PENDIENTE**: pool de mapas y resto de parámetros en la web, clasificación por torneo en la web, inscripción de versiones nuevas tras un torneo.

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
| `GET /standings` usa `"current"` por defecto | CODE_VERIFIED | `apps/api/src/routes/standings.ts:17` |
| La web no envía `seasonId` | CODE_VERIFIED | `apps/web/src/pages/RankingPage.tsx:38` |
| Torneo `round_robin` completo desde la UI (organizer) | RUNTIME_VERIFIED | Auditoría 2026-10-15, B pasada 2 §1b (entorno aislado, versiones forzadas) |
| La clasificación sale vacía en la web | RUNTIME_VERIFIED (síntoma) / CODE_VERIFIED (causa propuesta) | Auditoría B p2 §1b («Todavía no hay clasificación»); causa por los ficheros anteriores |
| Versiones `frozen` no reinscribibles | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/tournaments.ts:184-187`; auditoría B p2 §5 |
