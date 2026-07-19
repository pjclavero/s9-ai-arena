# R12 · Torneos / ranking / matchmaking (foundation — diseño)

## Estado actual / qué existe (mucho)

- **Torneos**: `apps/api/src/routes/tournaments.ts` — **formatos** `league, round_robin,
  single_elimination, double_elimination, swiss, teams`; **estados** `draft, open, closed,
  running, finished, cancelled`; `createTournament`, `enterTournament`, `dryRunTournament`.
- **Ranking/standings**: `routes/standings.ts` + `services/standings.ts`; `getStandings`,
  `getBotRatingHistory`, `getTeamStandings`.
- **Worker**: `tournament-worker/formats.ts`, `scheduler.ts`, `queue.ts`, `engine-executor.ts`
  (ejecuta batallas de torneo sobre el motor E2 con agentes internos).
- **UI**: `TournamentsPage`, `TournamentDetailPage`.

> **No reimplementar** modelos/formatos/estados/standings: ya existen. R12 es sobre todo
> **UI (bracket, ranking) + glue de preparación de match + matchmaking nuevo**.

## Qué falta (gap R12)

- **Bracket UI** (`#/tournaments/:id/bracket`): visualizar/generar el cuadro.
- **`prepare-battle` desde match**: crear la batalla `prepared` de un match (enlaza con R9
  `createPracticeBattle`) y, si procede, lanzarla vía **R6.2/R9-B `runBattle`** (gateado).
- **Página de ranking** (`#/ranking`) consumiendo standings existentes.
- **Matchmaking** (concepto NUEVO): cola + tickets + status, **gateada y sin auto-run**.

## Separación conceptual (obligatoria)

`Tournaments` (estructura) · `Ranking` (histórico) · `Matchmaking` (emparejamiento) — tablas y
páginas separadas, no un monolito.

## Modelos (reusar existentes + nuevos para matchmaking)

Existentes: Tournament, TournamentEntrant, formatos, standings, rating. Nuevos (foundation):

```text
MatchmakingQueue { id, mode, criteria, enabled }
MatchmakingTicket { id, userId, botId, version, status: queued|matched|cancelled, createdAt }
```

Estados match: `pending → prepared → running → completed → failed → cancelled`.

## Endpoints (revisar existencia; NO duplicar)

Existentes: `GET/POST /tournaments`, `/tournaments/:id`, `enterTournament`, `dryRunTournament`,
`getStandings`, `getTeamStandings`, `getBotRatingHistory`. A añadir (foundation):

```text
POST /tournaments/:id/generate-bracket          (si no existe; el worker ya siembra vía scheduler)
GET  /tournaments/:id/matches
POST /tournaments/:id/matches/:matchId/prepare-battle   → crea battle prepared (NO auto-run)
GET  /leaderboards | /leaderboards/:scope        (mapear a standings existentes)
GET  /matchmaking/status                          (gateado)
POST /matchmaking/tickets                         (gateado; sin auto-run)
DELETE /matchmaking/tickets/:id
```

## Reglas de seguridad de esta fase (duras)

- **No auto-run real**: ni torneo ni matchmaking lanzan batallas reales automáticamente.
- `prepare-battle` crea `prepared`; la ejecución real usa `POST /battles/:id/run` (**#51,
  gateado por `S9_ENABLE_REAL_BATTLE_RUNS`, hoy off**) y requiere **R6.2/R9-A validado en VM108**.
- Matchmaking: cola **disabled por defecto**; botón "Run tournament" **disabled** hasta que
  la ejecución real esté habilitada. Ranking oficial irreversible: NO (el motor aún cambia).

## Rutas UI propuestas

```text
#/tournaments            (existe)
#/tournaments/new        (existe parcial)
#/tournaments/:id        (existe: TournamentDetailPage)
#/tournaments/:id/bracket
#/ranking
#/matchmaking
```

Botones: Generate bracket · Prepare matches · Create prepared battles · **Run tournament —
disabled hasta que la ejecución real esté habilitada (R6.2/R9-A)**.

## Ranking inicial (métricas simples desde standings)

battles played, wins, losses, draws, win rate, avg ticks survived, last battle, replay link.
**ELO opcional** — no implementarlo mientras los resultados del motor cambien.

## Tests esperados

Crear torneo draft; añadir entrants; generar bracket single_elim/round_robin; preparar match
sin ejecutar; leaderboard calcula wins/losses/draws; matchmaking disabled por defecto; RBAC
admin para crear torneo; público read-only para ranking; **no auto-run si
`S9_ENABLE_REAL_BATTLE_RUNS=0`**.

## Riesgos / dependencias

- **Depende de R6.2/R9-B (#51, ya en main)** para `prepare/run` y de **R6.2/R9-A (VM108)** para
  ejecución real. Depende de R7-A (#50, ya en main) para replays de match. Solape App.tsx/OpenAPI.
  Riesgo **medio/alto**.

## Primer PR recomendado

`feature/r12-tournaments-bracket-ranking-foundation` (#50/#51 ya en main): bracket UI + página ranking
(sobre standings) + `prepare-battle` (sin auto-run) + matchmaking gateado + tests + docs.

## Dictamen

**R12-B** — diseño/contrato preparado; ranking/bracket implementables pronto (#51 ya en main);
**la ejecución real de run/matchmaking sigue gateada a VM108 (R6.2/R9-A)**.
