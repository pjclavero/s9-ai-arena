# R12 · Bracket de torneo — Slice 1 (read-only)

> Implementado en la rama `feature/r12-tournament-bracket`. Verificado leyendo directamente
> `apps/api/src/routes/tournaments.ts`, `apps/api/openapi.yaml`, `apps/web/src/pages/BracketPage.tsx`,
> `apps/web/src/App.tsx` y sus tests. Diseño de referencia:
> `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md` (dictamen R12-B); este documento describe lo que
> **existe de verdad** en código.

## Qué es

Primer slice del gap R12: **visualización read-only del cuadro** de un torneo. Un endpoint de
lectura (`GET /tournaments/{tournamentId}/matches`) y una página (`#/tournaments/:id/bracket`)
que pinta las rondas y los ganadores a partir de la estructura de `matches` que el
tournament-worker ya genera (E9). No inventa nada nuevo de dominio: expone lo que ya existe en BD.

## Qué NO es (reglas duras del bloque, verificadas por diseño y grep)

- **Cero ejecuciones de batalla**: ningún POST nuevo, nada encola jobs del worker
  (`generate_schedule`, `run_battle`, `dry_run` intactos y sin nuevos llamadores), sin auto-run.
- No toca `S9_ENABLE_REAL_BATTLE_RUNS` (sigue gateado a VM108/R6.2-R9-A, ver
  `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md`).
- No implementa `prepare-battle`, `#/ranking` ni matchmaking (slices posteriores del catálogo R12).
- Sin botones de acción en la página: solo lectura.

## Contrato del endpoint

`GET /tournaments/{tournamentId}/matches` — operación `listTournamentMatches` en
`apps/api/openapi.yaml` (contrato **0.5.0**, **60 operaciones**, verificado por
`conformance.test.ts`): `x-min-role: visitor`, `security: []` — público, exactamente el mismo
tratamiento que `listTournaments` y `getTeamStandings` (sin `anonQuota`, por consistencia con
los endpoints públicos de torneos existentes).

- Torneo inexistente → **404** con el shape de error estándar del router.
- Torneo existente → **200** con `{ "matches": [...] }`, ordenado `round asc, slot asc`.

Cada match (schema `TournamentMatch`, proyección explícita de columnas — sin `SELECT *`,
mapper `tournamentMatchToJson`):

```json
{
  "id": "m-...",
  "round": 1,
  "slot": 1,
  "pairing": { "...": "estructura de emparejamiento persistida por el scheduler" },
  "state": "scheduled | running | finished | failed",
  "winnerBotId": "b-... | null",
  "winnerTeamId": "t-... | null",
  "final": false
}
```

Excluido a propósito: `seed_commitment`/semillas del torneo (test explícito de que el valor
literal sembrado no aparece en el JSON serializado), `tournament_id` redundante y cualquier
columna no listada (test de claves exactas con `Object.keys(...).sort()`).

## Página `#/tournaments/:id/bracket`

- Reconocida por `matchPanelRoute()` en `apps/web/src/App.tsx` **antes** que el patrón de
  detalle (para que `#/tournaments/:id` no capture `/bracket`); id URL-decoded.
- `BracketPage` (`apps/web/src/pages/BracketPage.tsx`), patrón R3.7 (`useResource` +
  `ResourceView`): fallo de carga → `role="alert"` + reintento.
- Render por rondas (`Ronda N`), cada match con su `slot`, estado, ganador
  (`bracket-winner`) y marca de final (`bracket-final-mark`).
- Torneo sin cuadro generado → aviso claro `bracket-empty` ("El cuadro aún no se ha
  generado."), nunca una lista vacía engañosa.
- Enlace "Ver cuadro" desde `TournamentDetailPage` (que conserva su `BattlesBoard` de batallas
  por ronda: el bracket muestra la **estructura** del cuadro incluso sin batallas asociadas,
  el board muestra las batallas — son vistas complementarias).

## Tests y mutaciones

- **3 tests API** (`apps/api/src/r12-bracket.test.ts`): 404; 200 con orden round/slot, claves
  exactas, no-fuga del commitment, acceso sin autenticación; torneo sin matches → `{matches: []}`.
- **5 tests web** (`apps/web/tests/bracket-page.test.tsx`): routing bracket vs detalle (incl.
  URL-encoding), estado vacío, render con rondas/ganador/final, error con reintento.
- **6 mutaciones de no-vacuidad verificadas** (aplicar → ≥1 test falla → revertir → verde):
  handler vacío, sin 404, columna extra en select+mapper, orden invertido, ruta rota, estado
  vacío falso. Nota de la M3: una columna extra solo en el mapper (sin tocar el `select`) no es
  detectable porque `JSON.stringify` elimina `undefined` — la mutación válida es extremo a
  extremo (select + mapper), y esa sí la caza el test de claves exactas.

## Qué queda para slices posteriores (catálogo R12)

`prepare-battle` desde un match (crea batalla `prepared`, sin ejecutar), página `#/ranking`
sobre standings, matchmaking gateado (cola + tickets), botón de ejecución real —
**todo ello sigue gateado** a `S9_ENABLE_REAL_BATTLE_RUNS` y a la validación VM108 (R6.2/R9-A).
