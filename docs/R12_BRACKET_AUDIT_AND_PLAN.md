# R12 · Auditoría del bracket de torneos y decisión de independencia

> Auditoría de solo lectura. Base: `origin/main@4505a54`. No se ha implementado bracket nuevo
> en este PR — es el entregable de FASE 1 (decisión fundamentada + plan), tal y como se pidió.
> Todo lo citado abajo se verificó leyendo el fichero y la línea indicados en el propio
> worktree, no de memoria ni de otros dosieres.

## 0. Resumen ejecutivo

**R12 (bracket) NO es greenfield.** Ya existe en `main` un slice 1 completo, mergeado
(PR #62, `feature/r12-tournament-bracket`) y documentado en `docs/R12_BRACKET_SLICE1.md`:
generación de emparejamientos, persistencia del cuadro y una página de lectura. Lo que falta
para "el bracket" en el sentido pleno (avance de ganador enlazado a ejecución real, acciones de
organizador) es el **puente `prepare-battle`**, ya diseñado en detalle en
`docs/R12_PREPARE_BATTLE_MATCHMAKING.md` (N6, PR #73) pero **no implementado**.

**Veredicto: `R12-INDEPENDENT`.** Ver sección 3 con evidencia fichero a fichero.

## 1. Estado actual real (verificado leyendo código)

### 1.1 Modelo de datos — `apps/api/src/db/migrations.ts`

- `m004_competition` (líneas 271-360): crea `tournaments`, `entries`, `matches`, `battles`,
  `participants`. `matches` nace con solo `id, tournament_id, round, state, created_at`
  (línea 309-315); `state` con `CHECK (state IN ('scheduled','running','finished','failed'))`
  (línea 313) — **no incluye `pending` ni `prepared`** (importante, ver 4.5).
- `m008_e9_competition` (líneas 520-579): añade a `matches` las columnas que hacen posible un
  bracket de verdad: `slot text`, `pairing jsonb`, `winner_bot_id`, `winner_team_id`, `final
  boolean` (líneas 534-539), con índice único `matches_tournament_slot_idx (tournament_id,
  slot)` (línea 540). También añade `tournaments.season_id/elo_k/champion_bot_id` y la tabla
  `rating_events` para Elo por temporada.
- No hay ninguna migración de bracket "pendiente de aplicar": las 8 migraciones están en
  `main` y activas.

### 1.2 Generación del cuadro — `apps/tournament-worker/src/formats.ts` (448 líneas)

- `generateSingleElimination` (con byes, línea ~85), `seedPositions` (línea 125, seeding tipo
  torneo estándar por posiciones), `generateDoubleElimination` (líneas 209-322, bracket de
  ganadores + perdedores + gran final con reset), Swiss (~línea 390) y selector por formato
  (línea 423-448: `league | round_robin | single_elimination | double_elimination | swiss |
  teams`).
- Esta lógica es pura (sin I/O), verificada según el propio código con **property-based
  testing** (fast-check, comentario línea 211) y ya cubre exactamente los formatos que acepta
  `tournaments.format` en la migración `m004` (línea 277).

### 1.3 Orquestación — `apps/tournament-worker/src/scheduler.ts` (374 líneas)

- Línea 233-234: `generate_schedule` es idempotente (`if (t.state === "running" ||
  t.state === "finished") return;`) y exige `t.state === "closed"`.
- Línea 278: siembra `matches` con `state: "scheduled"` (coincide con el CHECK real, no con
  `pending`).
- Línea 294-296: al resolver una ronda, escribe `winner_bot_id`/`winner_team_id` según
  `t.format === "teams"`.
- Línea 303: al cerrar el torneo entero, `tournaments.state` pasa a `"running"`.
- Se dispara vía job `generate_schedule` encolado por `closeEntries`
  (`apps/api/src/routes/tournaments.ts:260-264`), consumido por
  `apps/tournament-worker/src/worker.ts` (148 líneas) — **no** por la UI ni por ningún POST
  directo del panel.

### 1.4 API — `apps/api/src/routes/tournaments.ts` (345 líneas)

- `listTournaments`, `createTournament`, `getTournament` (extensión R3.7), `listTournamentBattles`,
  `enterTournament` (congela código+loadout, cap. 17.2), `closeEntries` (commit-reveal de
  semillas, líneas 234-264), `dryRunTournament`, `getTeamStandings` (importa `leagueTable` de
  `tournament-worker/results.ts`, línea 16 — no reimplementado, comentario H6 línea 15).
- **`listTournamentMatches`** (líneas 292-306): el endpoint de R12 slice 1.
  `GET /tournaments/{tournamentId}/matches`, proyección explícita de columnas
  (`select("id","round","slot","pairing","state","winner_bot_id","winner_team_id","final")`,
  línea 304) — sin `seeds`/`seed_commitment`, verificado también por test de no-fuga.
  `tournamentMatchToJson` (líneas 40-51) es el mapper.
- Contrato en `apps/api/openapi.yaml`: `listTournamentMatches` en línea 707-722,
  `x-min-role: visitor`, `security: []` (público, sin cuenta) — línea 713-714. `openapi.yaml`
  declara 63 `operationId:` (comprobado con grep) y `version: 0.7.0` (línea 21); el comentario
  de línea 8 dice "0.5.0" al añadir R12 — es un vestigio histórico del changelog inline, la
  versión real vigente es 0.7.0 (no bloquea nada, pero se anota para no repetir el dato viejo).

### 1.5 Web — `apps/web/src/App.tsx` (243 líneas relevantes revisadas) y `apps/web/src/pages/BracketPage.tsx` (82 líneas)

- Import de `BracketPage` en `App.tsx:26`.
- Parser de ruta `matchPanelRoute` (líneas 69-88): el patrón `/^#\/tournaments\/([^/?]+)\/bracket/`
  (línea 81) se comprueba **antes** que el patrón de detalle de torneo (línea 83), documentado
  en el propio comentario (líneas 79-80) para que `#/tournaments/<id>/bracket` no lo capture el
  detalle.
- Render condicional en el `<main>` (líneas 244-248): `panelRoute?.kind === "tournamentBracket"
  ? <BracketPage id={panelRoute.id} /> : ...`.
- `BracketPage.tsx`: usa el patrón `useResource`/`ResourceView` de R3.7 (líneas 9-10, 28-31),
  agrupa `matches` por `round` (líneas 52-53), estado vacío explícito `bracket-empty` (línea
  42) — nunca una lista vacía ambigua.
- Tests: `apps/api/src/r12-bracket.test.ts` (3 casos: 404, 200 con orden/claves exactas/no-fuga
  de commitment, torneo sin matches) y `apps/web/tests/bracket-page.test.tsx` (5 casos de
  routing/render/error, según `docs/R12_BRACKET_SLICE1.md:74-75`, confirmado por `find`).

### 1.6 Diseño ya escrito para el siguiente slice — `docs/R12_PREPARE_BATTLE_MATCHMAKING.md`

Documento de **solo diseño** (línea 3: "No implementa endpoints, tablas, migraciones ni
código"), producido en N6/PR #73, que detalla:

- `POST /tournaments/{tournamentId}/matches/{matchId}/prepare-battle` (líneas 44-76): crea una
  `Battle` `scheduled` + `official: true` enlazada al match, sin ejecutarla. Reusa el camino
  interno de `createPracticeBattle` (R9).
- Transición de `match.state` propuesta: `pending → prepared → running → completed` (líneas
  78-96) — **inconsistente con el CHECK real** `('scheduled','running','finished','failed')`
  de `migrations.ts:313`; hay que reconciliar nombres al implementar (ver 4.5).
- Matchmaking (cola nueva, tablas `matchmaking_queues`/`matchmaking_tickets`, líneas 118-138):
  concepto que no existe hoy en el código, fuera del alcance de "bracket" propiamente dicho.
- Regla dura repetida en el documento (líneas 9-19, 206-214): ningún diseño de este documento
  llega hasta `runBattle`; todo se detiene en `Battle prepared`. `runBattle` sigue gateado por
  `S9_ENABLE_REAL_BATTLE_RUNS` (`apps/api/src/battle-run.ts:43,54`, `apps/api/src/app.ts:66`,
  citado en el propio documento línea 14).

## 2. Qué NO hay en el código (verificado, no asumido)

- No hay endpoint de escritura para el bracket (`prepare-battle`, avance manual de match, etc.):
  grep de `prepare-battle` en `apps/api/src/routes/` no devuelve nada — solo aparece en el
  documento de diseño.
- No hay columna `matches.battle_id` en ninguna migración (grep en `migrations.ts` no la
  encuentra) — es una migración propuesta, no aplicada.
- No hay página `#/matchmaking` ni rutas de matchmaking en `App.tsx`.
- `matches.state` no admite hoy `pending`/`prepared`/`cancelled` — solo
  `scheduled|running|finished|failed` (constraint real, `migrations.ts:313`).

## 3. Veredicto de independencia: `R12-INDEPENDENT`

Pregunta central: ¿puede implementarse el siguiente slice de R12 (prepare-battle + avance de
match) sin depender de los contratos de R11 (spectator) ni de R13.1 (runtime inspector)?

**Sí, es independiente.** Evidencia:

- **Sin R11.** `apps/api/src/routes/tournaments.ts` no importa nada de spectate: no hay
  `import` de `spectate/gateway`, `getSpectateTicket` ni `S9_PUBLIC_SPECTATE_ENABLED` en ese
  fichero (grep vacío). `BracketPage.tsx` importa solo `../api.js` y `../resource.js` (líneas
  9-10) — nada de `LivePage`/`ViewerPage`/`ReplayPage`. El único acoplamiento de R12 con R11 es
  **superficial y compartido**: ambos tocan `apps/web/src/App.tsx` (rutas `#/live` línea 65 de
  R11 vs. `#/tournaments/:id/bracket` línea 81 de R12) y `apps/api/openapi.yaml` (conteo total
  de operaciones para `conformance.test.ts`) — es un conflicto de **fichero**, no de
  **contrato**: ninguna operación de R12 necesita ningún tipo, ticket o gateway de R11 para
  funcionar. El diseño de `prepare-battle` (sección 1.6) tampoco menciona spectate en ningún
  punto: crea una `Battle scheduled`, que ya es el mismo objeto que consume `runBattle`
  independientemente de si hay o no espectadores.
- **Sin R13.1.** `docs/R13_1_RUNTIME_INSPECTOR.md:153-157` dice explícitamente que R13.1 es
  "una herramienta de depuración local" y que el canal de observación en tiempo real para
  usuarios externos **no está implementado por R13.1** — es decir, ni siquiera R11 depende
  funcionalmente de R13.1 más allá de una futura reutilización de infraestructura de streaming;
  R12 no aparece mencionado en absoluto en ese documento (grep negativo). No hay ningún import
  cruzado entre `apps/tournament-worker/*` o `apps/api/src/routes/tournaments.ts` y cualquier
  módulo de "inspector"/"runtime" (grep vacío).
- **La única dependencia real de R12** (documentada y ya vigente en `main`, no nueva) es hacia
  `runBattle`/`S9_ENABLE_REAL_BATTLE_RUNS` (R6.2/R9-B, `apps/api/src/battle-run.ts`), que está
  **gateado y apagado**, y hacia la propia infraestructura de torneos de E9
  (`tournament-worker`), ya en `main`. Ninguna de las dos es R11 ni R13.1.

Conclusión: el trabajo de "completar el bracket" (prepare-battle, transición de match, UI de
acción) puede diseñarse e implementarse en una rama propia sin esperar a que R11 o R13.1
avancen. El único cuidado real es de **fichero compartido** (`App.tsx`, `openapi.yaml`), no de
contrato funcional — se gestiona con diffs pequeños y localizados (sección 6).

## 4. Modelo de datos propuesto para el siguiente slice (para el plan, no para implementar ahora)

### 4.1 Migración `matches.battle_id` + estado `prepared`

```sql
ALTER TABLE matches
  ADD COLUMN battle_id uuid REFERENCES battles(id) ON DELETE SET NULL;
ALTER TABLE matches DROP CONSTRAINT matches_state_check;  -- nombre real a confirmar en psql
ALTER TABLE matches ADD CONSTRAINT matches_state_check
  CHECK (state IN ('scheduled','prepared','running','finished','failed'));
```

Nota de corrección respecto al diseño N6: usar `scheduled` como estado inicial real (el que ya
usa `scheduler.ts:278`), no `pending` — el diseño previo asumió un valor que no existe en el
esquema. `prepared` se añade como nuevo valor intermedio entre `scheduled` (sembrado, sin
`Battle`) y `running` (la `Battle` enlazada se ejecutó). No se introduce `cancelled` en esta
migración: no hay ningún flujo que hoy cancele un match, y añadirlo sin un llamador real
violaría "nada conceptual" del encargo.

### 4.2 Contrato de API — `POST /tournaments/{tournamentId}/matches/{matchId}/prepare-battle`

Igual que lo ya detallado en `docs/R12_PREPARE_BATTLE_MATCHMAKING.md:44-76`, con la corrección
de estado de 4.1:

- 404 si el torneo o el match no existen.
- 409 si `match.state !== 'scheduled'` (evita re-preparar un match ya jugado).
- 409 si `match.pairing` no tiene ambos lados resueltos todavía (bracket con "TBD": el ganador
  de una ronda anterior aún no se decidió) — comprobación nueva no cubierta por el diseño N6,
  necesaria porque `pairing` puede contener referencias simbólicas (`homeSource`/`awaySource`,
  `formats.ts:199-200`) que solo se resuelven cuando `scheduler.ts` actualiza la siguiente
  ronda.
- Crea `Battle` reusando el camino de `createPracticeBattle`, con `official: true`,
  `tournamentId` relleno, `status: 'scheduled'`.
- Actualiza `match.state = 'prepared'`, `match.battle_id = battle.id`.
- Idempotente: reintento sobre `prepared` devuelve 200 con la `Battle` existente.
- `x-min-role: admin` (o el rol que gestione el torneo — a decidir contra el RBAC existente en
  `apps/api/src/registry.ts:20-35`; hoy `ROLE_RANK` ya distingue `visitor` de roles superiores,
  reusar esa tabla, no inventar una nueva).

### 4.3 Sincronización match↔battle tras ejecución (gateado)

Cuando `S9_ENABLE_REAL_BATTLE_RUNS` esté activo y validado (fuera de alcance de este bloque):
el worker refleja `battle.status → match.state` (`finished→finished`,
`failed→failed`) y copia `winner_bot_id`/`winner_team_id` desde `battle.result`. Esto **no se
implementa** en el slice propuesto; se deja el `battle_id` en el esquema para no requerir una
segunda migración cuando llegue la autorización.

### 4.4 UI — solo lectura + una acción gateada por rol

- `BracketPage.tsx`: añadir un botón "Preparar batalla" visible solo si `me?.role` es admin/
  organizador y `match.state === 'scheduled'` con `pairing` resuelto (ambos lados no nulos);
  tras `201/200`, enlace a `#/battles/{id}` (ya existe `BattlesPage`).
- Sin botón de "Lanzar": eso pertenece a `runBattle`, ya gateado en otra pantalla
  (`BattleNewPage`/`BattlesPage`), no se duplica aquí.

### 4.5 Corrección a documentar sobre el diseño N6

`docs/R12_PREPARE_BATTLE_MATCHMAKING.md:78-96` asume que el `state` inicial de un match es
`pending`. Verificado contra `migrations.ts:313` y `scheduler.ts:278`: el valor real es
`scheduled`. El plan de implementación debe usar `scheduled → prepared → running →
finished|failed`, no `pending → prepared → running → completed`. Se recomienda una nota de
una línea en ese documento (o en el PR que implemente el slice) señalando la corrección, sin
reescribir el documento entero (es un documento de diseño ya mergeado, con su propio historial).

## 5. Plan de tests reales (ejecutables, no conceptuales)

Todos verificables con `npx vitest run <fichero>` desde la raíz del repo, siguiendo el patrón
ya usado por `apps/api/src/r12-bracket.test.ts` (arranque de `startTestDb`, `seedDev`,
`createApp`).

1. **`apps/api/src/r12-prepare-battle.test.ts`** (nuevo):
   - `POST /tournaments/{id}/matches/{matchId}/prepare-battle` sin auth → 401/403 (según
     RBAC real, no visitor).
   - Match inexistente → 404.
   - Match en `finished` → 409 `illegal_transition` (o código equivalente ya usado en el
     router, ver `conflict()` en `apps/api/src/errors.ts`).
   - Match `scheduled` con `pairing` sin resolver (`home`/`away` symbolic o null) → 409.
   - Match `scheduled` con pairing resuelto → 201, `Battle` creada con `official: true`,
     `tournamentId` = el del torneo, `status: 'scheduled'`; `match.state` pasa a `prepared`,
     `match.battle_id` apunta a la `Battle`.
   - Reintento sobre el mismo match ya `prepared` → 200, misma `Battle` (idempotencia, no
     duplica filas — comprobar `count(*) from battles where tournament_id=...` no crece).
   - Verificar que NO se llama a `runBattle` (grep del test: sin `POST /battles/:id/run` en
     ningún paso) y que `battle.status` sigue `scheduled` tras el `prepare-battle`.
2. **`apps/api/src/db/schema.test.ts`** (extender el existente, no crear otro): añadir
   comprobación del `CHECK` de `matches.state` con el nuevo valor `prepared` y de la FK
   `matches.battle_id → battles.id`.
3. **`apps/web/tests/bracket-page.test.tsx`** (extender): botón "Preparar batalla" oculto para
   `visitor`/no-admin; visible y funcional (mock de API) para admin sobre un match `scheduled`
   resuelto; ausente sobre un match `prepared`/`finished`.
4. **Mutaciones de no-vacuidad** (mismo patrón que slice 1, `docs/R12_BRACKET_SLICE1.md:76-80`):
   quitar el chequeo de estado 409 → debe fallar un test; quitar la idempotencia → debe fallar
   un test de reintento; quitar la comprobación `official: true` → debe fallar un test que lo
   afirme explícitamente.
5. **Conformance**: `apps/api/src/conformance.test.ts` ya cuenta operaciones del contrato —
   añadir la operación nueva a `openapi.yaml` es obligatorio para que ese test siga en verde
   (mismo patrón que `listTournamentMatches`).

Ninguno de estos tests requiere `S9_ENABLE_REAL_BATTLE_RUNS=1` ni VM108: todos corren contra
`startTestDb` (Postgres efímero local), igual que el resto de la suite de torneos.

## 6. Lista exacta de ficheros a tocar (para el slice de `prepare-battle`, cuando se autorice)

- `apps/api/src/db/migrations.ts` — nueva migración `matches.battle_id` + ampliar CHECK de
  `state` (sección 4.1).
- `apps/api/src/routes/tournaments.ts` — nuevo `defineOperation(router, "prepareBattle", ...)`
  junto a `listTournamentMatches` (línea ~306, después de esa función).
- `apps/api/openapi.yaml` — nueva ruta
  `/tournaments/{tournamentId}/matches/{matchId}/prepare-battle` (`POST`), reusando el schema
  `Battle` existente; actualizar el conteo esperado en `conformance.test.ts` si ese test fija
  un número literal (a confirmar al implementar).
- `apps/api/src/r12-prepare-battle.test.ts` — nuevo fichero de tests (sección 5.1).
- `apps/api/src/db/schema.test.ts` — extensión (sección 5.2).
- `apps/web/src/pages/BracketPage.tsx` — botón condicional "Preparar batalla" (sección 4.4).
- `apps/web/tests/bracket-page.test.tsx` — extensión (sección 5.3).
- `apps/web/src/App.tsx` — **cero líneas nuevas de ruta**: la ruta `#/tournaments/:id/bracket`
  ya existe (línea 81) y el slice de `prepare-battle` es una acción dentro de `BracketPage`, no
  una página nueva. Si acaso, una línea de comentario junto al import de `BracketPage` (línea
  26) documentando que ahora tiene una acción de escritura gateada por rol. Esto es
  deliberado para minimizar el punto caliente de `App.tsx` que R11/R16 también tocan.
- `docs/R12_PREPARE_BATTLE_MATCHMAKING.md` — nota de corrección de estados (sección 4.5), sin
  reescribir el documento.
- `docs/R12_BRACKET_SLICE1.md` o un nuevo `docs/R12_PREPARE_BATTLE_SLICE2.md` — documento
  "esto es lo que existe de verdad" del nuevo slice, siguiendo el mismo patrón que slice 1.

**No se toca**: `apps/tournament-worker/src/formats.ts` ni `scheduler.ts` (la generación del
cuadro ya es correcta y no cambia), `apps/api/src/battle-run.ts` (el gateo de `runBattle` no se
toca), ningún fichero de `spectate/*`, `broadcast/*`, ni de mapas (R10/R16).

## 7. Conflictos con otros carriles

- **R11 (spectator)**: solapa en `apps/web/src/App.tsx` (rutas `#/live` vs. `#/tournaments/*`)
  y `apps/api/openapi.yaml` (recuento de operaciones para `conformance.test.ts`). Sin solape de
  contrato ni de lógica de negocio. Mitigación: el slice de R12 aquí propuesto no añade
  ninguna ruta nueva a `App.tsx` (sección 6) — solo una línea de comentario, no una entrada de
  routing — así que el diff de `App.tsx` es mínimo y fácil de rebasar contra cambios de R11.
- **R13.1 (runtime inspector)**: sin solape de ficheros detectado (grep negativo en ambos
  sentidos). Ningún conflicto esperado.
- **R16 (primitivas visuales)**: no se tocó ningún fichero de `packages/` de render/motor en
  esta auditoría ni en el plan; `BracketPage.tsx` es HTML/CSS de panel, no usa el motor 2D. Sin
  conflicto esperado.
- **Riesgo real más probable**: dos PRs concurrentes editando `openapi.yaml` cerca de la
  sección `/tournaments/*` (R12) vs. `/public/battles/*` (R11, línea 725 en adelante, contigua
  en el fichero) — mismo bloque de `paths:`, pero secciones separadas; conflicto de Git
  mecánico y trivial de resolver, no de contrato.

## 8. Autorización y límites respetados en esta auditoría

- No se ejecutó ningún comando de escritura contra BD real, VM108 ni VM104.
- No se activó `S9_ENABLE_REAL_BATTLE_RUNS` ni se propone activarlo en este documento.
- No se implementó código de `prepare-battle` ni de matchmaking — solo se audita y planifica,
  conforme al encargo de FASE 1.
- No se imprimieron secretos; no se tocó ningún fichero fuera de este worktree aislado.
