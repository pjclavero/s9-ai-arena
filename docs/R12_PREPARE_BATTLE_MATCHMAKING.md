# R12 · Diseño de `prepare-battle` (desde match de torneo) y matchmaking (N6, entrega B)

> Este documento es SOLO DISEÑO. No implementa endpoints, tablas, migraciones ni código.
> Profundiza el gap ya identificado en `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` (léelo
> primero: aquí no se repite el inventario de lo que ya existe — torneos, standings, worker,
> UI de bracket/ranking — solo se referencia). Este doc da shapes de endpoint concretos,
> estados/transiciones, tablas nuevas propuestas para matchmaking y el criterio de gating.

## 0. Frontera dura (léela antes de lo demás)

**La EJECUCIÓN real de batallas (`runBattle` / `POST /battles/:id/run`, R6.2/R9-B) y de
torneos/matchmaking (auto-run) está GATEADA a `S9_ENABLE_REAL_BATTLE_RUNS` (hoy `0`/apagado,
ver `apps/api/src/battle-run.ts:43,54` y `apps/api/src/app.ts:66`) y a la validación en
**VM108**. Ninguna pieza de este diseño se implementa en este bloque (N6) ni en ningún bloque
posterior de este programa de continuación sin una autorización explícita y separada que
active esa validación.** Todo lo que sigue —prepare-battle y matchmaking— se diseña para
llegar exactamente hasta la creación de recursos en estado `prepared` / tickets en cola, nunca
más allá. Donde el diseño toca `runBattle`, se marca como **(gateado, fuera de alcance de
implementación)**.

## 1. Prepare-battle desde un match de torneo

### 1.1 Qué existe hoy (reuso, no reimplementación)

- `matches` (migración `008_e9_competition`): filas con `tournament_id, round, slot, pairing,
  state, winner_bot_id, winner_team_id, final` — ya expuestas de solo lectura vía
  `GET /tournaments/:id/matches` (`apps/api/src/routes/tournaments.ts`, R12 slice 1).
- `createPracticeBattle` (`POST /battles`, R9): crea una `Battle` en estado `scheduled` a
  partir de `{ mode, rulesetId, mapId, mapVersion?, seed?, participants[] }`
  (`PracticeBattleInput`, `apps/api/openapi.yaml:1364`). Hoy siempre no oficial
  (`official: false`, no afecta rating).
- `runBattle` (`POST /battles/:battleId/run`, R6.2/R9-B, `apps/api/src/battle-run.ts`): lanza
  la ejecución containerizada real de una batalla `scheduled`. Gateado por
  `S9_ENABLE_REAL_BATTLE_RUNS`; sin ella responde `503`. Valida estado `scheduled`, mapa
  publicado y bots publicados antes de lanzar (409 si no).

### 1.2 El hueco: no hay puente entre "match de torneo" y "battle preparada"

Hoy un `match` (par de bots/equipos + ronda) y una `Battle` (partida ejecutable) son entidades
sin enlace. `prepare-battle` es ese puente: toma un `match` en estado `pending` y crea (o
reutiliza) la `Battle` que ese match debe correr, marcándola como oficial (afecta rating) y
enlazada al match — sin lanzarla.

### 1.3 Endpoint propuesto (diseño, no implementado)

```text
POST /tournaments/{tournamentId}/matches/{matchId}/prepare-battle
x-min-role: admin  (o el rol que gestione el torneo; a decidir con RBAC existente — no visitor)
```

Cuerpo: vacío (todos los datos —mode, mapId, participants— se derivan del propio match y del
`ruleset` del torneo; NO se piden en el request, para que no se pueda "colar" un mapa/ruleset
distinto al del torneo).

Comportamiento:

1. Carga el `match` por `tournamentId + matchId`. 404 si no existe.
2. 409 si `match.state !== "pending"` (evita duplicar `prepared` sobre un match ya jugado o
   cancelado).
3. Deriva `participants` de `match.pairing` (bot/equipo A vs B), `mode`/`mapId`/`rulesetId` del
   `tournament.ruleset` (D7, `BUDGET_CREDITS_MVP` y demás ya resueltos a nivel de torneo).
4. Crea la `Battle` reusando el mismo camino interno que `createPracticeBattle` (R9), pero con
   `official: true` y `tournamentId` relleno (el schema `Battle` ya tiene `tournamentId`,
   `apps/api/openapi.yaml:1389` — hoy sin escritor; este es el primer escritor real de ese
   campo). Estado inicial de la `Battle`: `scheduled` (el mismo estado que ya consume
   `runBattle`; no se introduce un estado de `Battle` nuevo).
5. Marca `match.state = "prepared"` y guarda `match.battle_id` (columna nueva, ver 1.4).
6. Responde `201` con el `Battle` creado. Idempotencia: si se reintenta sobre un match ya
   `prepared`, `200` devolviendo la battle existente (no crea una segunda).

Respuesta (reusa `Battle` existente, sin campos nuevos en el schema):

```json
{ "id": "...", "tournamentId": "...", "status": "scheduled", "official": true, "mode": "...",
  "mapId": "...", "participants": [...] }
```

### 1.4 Estados y transición de `match` (extiende el `state` ya existente en la tabla `matches`)

```text
pending → prepared → running → completed
                    ↘ failed
pending → cancelled          (torneo cancelado / bye)
prepared → cancelled         (rehacer emparejamiento antes de correr)
```

- `pending`: estado inicial de siembra (ya existe hoy, sin cambios).
- `prepared`: **nuevo** — `prepare-battle` lo puso aquí; `match.battle_id` apunta a una
  `Battle` en `scheduled`. Última parada de este diseño sin `S9_ENABLE_REAL_BATTLE_RUNS`.
- `running` / `completed` / `failed`: reflejan el estado de la `Battle` enlazada cuando
  **(gateado, fuera de alcance de implementación)** `runBattle` la ejecuta y el worker
  actualiza `match.state` en espejo de `battle.status` (`running`→`running`,
  `finished`→`completed`, `failed`→`failed`) y rellena `winner_bot_id`/`winner_team_id` desde
  `battle.result` — este último paso de sincronización tampoco se implementa aquí; se deja
  dibujado porque condiciona el shape de la migración (columna `battle_id` en `matches`).
- `cancelled`: gestión manual/torneo cancelado, sin relación con el gateo de ejecución.

Cambio de esquema propuesto (solo diseño): columna `matches.battle_id` (FK nullable a
`battles.id`), y ampliar el enum de `matches.state` con `prepared` (hoy previsiblemente
`pending|running|completed|...`; a confirmar contra la migración `008_e9_competition` al
implementar).

### 1.5 UI (fuera de alcance de N6, dibujado para R12 completo)

En `TournamentDetailPage`/`BracketPage` (hoy solo lectura), un botón "Preparar batalla" por
match `pending` (visible solo a admin), que tras `201/200` enlaza a `#/battles/{id}` (ya
existe `BattlesPage`). Un botón "Lanzar" junto al match `prepared` queda **deshabilitado** con
tooltip explicando el gateo, hasta que `S9_ENABLE_REAL_BATTLE_RUNS=1` + VM108 estén validados
— igual que ya hace el flag de `runBattle` a nivel de API (belt-and-braces: la UI no debe ser
la única barrera).

## 2. Matchmaking (concepto nuevo)

No hay hoy ningún concepto de "cola de emparejamiento" en el código — es fuera-de-torneo (dos
bots que quieren jugar sin pertenecer a un torneo activo). Se diseña desde cero, gateado y sin
auto-run.

### 2.1 Modelo de datos (nuevo, propuesto — NO se crea la migración en este bloque)

```text
matchmaking_queues
  id            uuid PK
  mode          text   -- deathmatch | team_deathmatch | capture_the_flag | zone_control
  criteria      jsonb  -- p.ej. { ratingBandInitial: 100, ratingBandGrowthPerSec: 5, teamSize: 1 }
  enabled       boolean not null default false   -- disabled por defecto (regla dura)
  created_at    timestamptz

matchmaking_tickets
  id            uuid PK
  queue_id      uuid FK -> matchmaking_queues.id
  user_id       uuid FK -> users.id
  bot_id        uuid FK -> bots.id
  bot_version   integer
  status        text   -- queued | matched | cancelled | expired
  matched_battle_id  uuid FK -> battles.id, nullable
  created_at    timestamptz
  updated_at    timestamptz
```

Un ticket representa "este bot quiere entrar en cola para este modo". El emparejador
(scheduler, análogo al `tournament-worker/scheduler.ts` existente pero para matchmaking) empareja
tickets `queued` compatibles (mismo `mode`, rating dentro de banda que crece con el tiempo de
espera — patrón estándar de banda expansiva) y, al encontrar pareja, los pasa a `matched` +
crea la `Battle` correspondiente vía el mismo camino de 1.3 (`official: true`, `scheduled`) —
**sin lanzarla** (mismo límite que prepare-battle).

### 2.2 Estados del ticket

```text
queued → matched → (battle preparada, gateado hasta aquí)
queued → cancelled     (el usuario retira el ticket)
queued → expired       (TTL sin pareja; a definir, p.ej. 5 min)
```

### 2.3 Endpoints propuestos (diseño, no implementado)

```text
GET  /matchmaking/status
  x-min-role: visitor, security: []
  → { enabled: boolean, queues: [{ mode, ticketsQueued: number }] }
  # Público y de solo lectura: permite a la UI decidir si mostrar el botón "Buscar partida"
  # sin filtrar detalles de otros usuarios (solo agregados por modo).

POST /matchmaking/tickets
  x-min-role: user
  body: { mode, botId, botVersion }
  → 201 { id, status: "queued", mode, botId, botVersion, createdAt }
  → 503 si la cola de ese modo tiene enabled=false (mismo patrón 503 que runBattle)
  → 409 si el bot no está publicado (mismo chequeo que ya hace runBattle sobre bots)

GET  /matchmaking/tickets/{ticketId}
  x-min-role: user (solo el dueño del ticket, o admin)
  → el ticket con su status actual; si status=matched, incluye matchedBattleId

DELETE /matchmaking/tickets/{ticketId}
  x-min-role: user (solo el dueño, o admin)
  → 204; pasa el ticket a cancelled si estaba queued (idempotente si ya no lo está)
```

Nótese que `POST /matchmaking/tickets` **crea el ticket y, si hay pareja, la `Battle`
`prepared`**, pero en ningún punto llama a `runBattle`. El emparejador es un proceso batch
(análogo al patrón ya usado por `tournament-worker`), no un disparador de ejecución.

### 2.4 UI (`#/matchmaking`, fuera de alcance de N6)

Página nueva, análoga a `BattleNewPage` (R9) pero para "unirse a cola": selector de bot +
modo, botón "Buscar partida" (deshabilitado si `GET /matchmaking/status` dice `enabled:
false` para ese modo, con el mismo mensaje de "desactivado en este entorno" que ya usa
`LivePage` para `S9_PUBLIC_SPECTATE_ENABLED`), estado del ticket propio con opción de
cancelar. Sin lanzar nada: al emparejar, enlaza a `#/battles/{id}` como estado `prepared`,
igual que el flujo de prepare-battle de la sección 1.

### 2.5 Reglas de seguridad de esta fase (duras, heredadas de
`docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` y reafirmadas aquí)

- `matchmaking_queues.enabled` es `false` por defecto: sin activación explícita por cola/modo,
  `POST /matchmaking/tickets` responde `503`, igual que `runBattle` responde `503` sin
  `S9_ENABLE_REAL_BATTLE_RUNS`. Dos gates independientes, ninguno implícito en el otro.
- Emparejar tickets crea una `Battle prepared`; **nunca** llama a `runBattle`. La ejecución
  real de una battle nacida de matchmaking pasa por el mismo camino gateado que cualquier
  otra `Battle` `scheduled` (sección 1.3/0) — no hay atajo de "auto-run" para matchmaking.
- RBAC: crear/cancelar ticket = `user` dueño del bot; ver agregados de cola = público
  (`visitor`, sin datos personales); nada de `matchmaking` es accesible sin rol salvo el
  agregado de `GET /matchmaking/status`.

## 3. Criterio de gating (resumen para el Supervisor/Organizador)

| Pieza                                   | Estado tras este diseño        | Qué falta para activarla                        |
|------------------------------------------|---------------------------------|--------------------------------------------------|
| `prepare-battle` (match → `Battle prepared`) | Diseñado, no implementado  | Migración `matches.battle_id` + endpoint + tests |
| `runBattle` sobre esa battle              | Ya existe, gateado (`503` hoy) | `S9_ENABLE_REAL_BATTLE_RUNS=1` + validación VM108 |
| Matchmaking (colas/tickets)               | Diseñado, no implementado      | Migraciones nuevas + endpoints + scheduler + tests |
| Auto-emparejar → `Battle prepared`        | Diseñado, no implementado      | Igual que matchmaking; sigue sin tocar `runBattle` |
| Auto-run de matchmaking/torneo            | **Fuera de alcance permanente de este programa** | Autorización explícita separada, no cubierta aquí |

Ninguna fila de esta tabla se implementa en N6. La entrega B de N6 es este documento.
