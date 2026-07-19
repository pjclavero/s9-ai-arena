# Fase siguiente — R10 / R11 / R12 (dossier de coordinación)

> **Nota (2026-07-19):** este dossier cubre **R10/R11/R12**. El orden global del proyecto —que
> intercala **R13** (motor/runtime), **R16** (visual) y **R14** (WebRTC)— vive en `docs/ROADMAP.md`.
> Secuencia acordada: #50 → #51 → #52 → **R13.0** → R10 → R13.1 → R11 → R13.2 → R12 → R16 → R14 →
> R13.5 → save/load·latencia·sharding. R10/R11/R12 siguen en **PRs separadas** de R13/R14/R16.
>
> **Naturaleza:** documento de **coordinación y diseño**, NO de implementación. Prepara
> R10/R11/R12. **No toca VM108/VM104/runner/proxy/seguridad.**
> **Decisión de alcance del coordinador: Opción A (diseño/documentación).** No se implementa
> código de R10/R11/R12 en este PR.
>
> **Actualización 2026-07-19:** #50 (R7-A) y #51 (R6.2/R9-B) **ya están integradas en main**
> (`main@6373e19`); #51 se rebasó sobre #50 sin conflictos y con CI verde. Este dossier ya no
> depende de esas PRs como "en vuelo": sus dependencias descritas abajo están disponibles en main.

## 1. Estado base

- `main@6373e19`. CI verde. Hito A alcanzado (batalla E2E real + replay en VM108).
- **Integradas en main (2026-07-19):** **#50 R7-A** (ingesta operativa + `#/replays`) y
  **#51 R6.2/R9-B** (ejecución containerizada gateada desde UI, `runBattle`). **#41** (otro
  agente, e2e smoke) sigue en curso, no relacionado con este dossier.

## 2. Hallazgo clave: NO es greenfield

Las tres áreas ya están **muy construidas**; el trabajo es de **UI/glue + gating**, no de base:

| Área | Ya existe en `main` | Gap real (foundation) |
|---|---|---|
| **R10 mapas** | Esquema de mapa (`maps/*.json`: widthM/heightM/materials/layers/meta/checksum), **validación completa** (`apps/map-service/src/validate/*`: geometry, playability, mode, navigation, balance, destruction, shapes), endpoints `listMaps`/`getMapVersion`/`publishMapVersion`/`generateMap`, `MapsPage` | **Editor visual** (canvas/SVG, CRUD de objetos, draft-save), endpoints de draft/objetos, roundtrip import/export |
| **R11 spectator** | `spectate/gateway.ts`, `ViewerPage`, `ReplayPage`, `BroadcastPage`, ticket `getSpectateTicket`, `GET /replays` (R7-A #50), `matchPublicRoute` (#/viewer, #/replay públicos) | **Lista pública `#/live`** + endpoints `GET /public/battles/live|:id` **gateados** por `S9_PUBLIC_SPECTATE_ENABLED` (off) |
| **R12 torneos** | `routes/tournaments.ts` (**formatos** league/round_robin/single_elimination/double_elimination/swiss/teams; **estados** draft/open/closed/running/finished/cancelled), `enterTournament`, `dryRunTournament`, `routes/standings.ts` + `services/standings.ts` (**ranking**), `getBotRatingHistory`, `getTeamStandings`, `tournament-worker/formats.ts`, `TournamentsPage`/`TournamentDetailPage` | **Bracket UI** + `generate-bracket`/`prepare-battle` (glue con R6.2/R9-B), **matchmaking** (concepto nuevo, cola gateada), página `#/ranking` |

Consecuencia: **no reimplementar** modelos/endpoints existentes. R12 en particular está mucho
más avanzado de lo que sugiere el encargo.

## 3. Matriz de ficheros (probable) y solapes

| Bloque | Ficheros probables | Solape con | Riesgo |
|---|---|---|---|
| R10 | `apps/web/src/pages/MapEditorPage.tsx` (nuevo), `apps/api/openapi.yaml`, `apps/api/src/routes/maps.ts`, `App.tsx` (ruta/nav), docs | #45/#49 (MapsPage), OpenAPI, App.tsx | **medio** (App.tsx + OpenAPI) |
| R11 | `apps/web/src/pages/LivePage.tsx` (nuevo), `apps/api/src/routes/public.ts` (nuevo), `App.tsx`, OpenAPI, docs | R7-A #50 (GET /replays), App.tsx | **medio** |
| R12 | `apps/web/src/pages/{TournamentBracketPage,RankingPage,MatchmakingPage}.tsx` (nuevos), `apps/api/src/routes/{tournaments,matchmaking}.ts`, OpenAPI, `App.tsx`, docs | R6.2/R9-B #51 (prepare/run), R7-A #50, tournaments existentes, App.tsx | **medio/alto** |
| QA | tests/*, conformance, greps | todos | bajo |
| Docs | `docs/*` | ninguno | **nulo** |

**Punto caliente común: `apps/web/src/App.tsx`** (rutas/nav) y **`apps/api/openapi.yaml`**
(conformance cuenta operaciones). Cualquier implementación futura debe secuenciarse tras el
merge de #50/#51 y reconciliar App.tsx/OpenAPI en el mismo PR.

## 4. Matriz de dependencias

```text
R10 (editor) ── independiente de #50/#51. Depende de R8 maps (ya en main).
R11 (spectator) ── depende de R7-A (#50) para GET /replays y del listado; gate propio.
R12 (torneos/ranking) ── ranking/standings independientes; "prepare/run de match" DEPENDE de
                          R6.2/R9-B (#51, endpoint runBattle gateado) y de R6.2/R9-A (VM108)
                          para ejecución real. Matchmaking real DEPENDE de R6.2/R9-A.
```

**Regla dura:** ningún torneo/matchmaking puede **auto-lanzar** batallas reales hasta que
**R6.2/R9-A** esté validado en VM108. En esta fase todo eso queda **gateado y apagado**.

## 5. Orden recomendado de implementación (cuando se autorice)

1. ~~Mergear #50 (R7-A) y #51 (R6.2/R9-B)~~ — **hecho** (`main@6373e19`); base para R11 y R12 ya disponible.
2. **R10 Map Editor Foundation** — el más independiente; mejora mapas → batallas → replays.
3. **R11 Public Spectator Foundation** — sobre R7-A; gateado por defecto.
4. **R12 Tournaments/Ranking Foundation** — ranking/bracket UI sobre lo existente; matchmaking
   como cola **gateada**; `prepare-battle` enlaza al `runBattle` de #51 (gateado).

Cada uno en **PR independiente**, con su feature-flag **off por defecto**, tests y docs.

## 6. Estrategia de ramas propuesta

```text
feature/r10-map-editor-foundation
feature/r11-public-spectator-foundation
feature/r12-tournaments-bracket-ranking-foundation
```

(Este PR: `docs/next-phase-r10-r11-r12-planning` — solo docs.)

## 7. Detalle por bloque

- **R10** → `docs/R10_MAP_EDITOR_FOUNDATION.md`
- **R11** → `docs/R11_PUBLIC_SPECTATOR_FOUNDATION.md`
- **R12** → `docs/R12_TOURNAMENTS_RANKING_MATCHMAKING.md`
- Roadmap consolidado → `docs/ROADMAP.md`
- Checklist → `docs/CHECKLIST_VALIDACION_V4.md`

## 8. QA / Seguridad (preventivo)

Toda implementación futura debe: mantener flags experimentales **off** por defecto; no exponer
`DOCKER_PROXY_URL`/secretos al frontend (solo capabilities booleanas); no introducir
`docker.sock`/`privileged`/`network_mode: host`/`seccomp=unconfined`; no auto-run real; no
RTMP/YouTube/Twitch. Greps de seguridad obligatorios en cada PR.

## 9. Dictamen

- **R10 → R10-B** (diseño/contrato preparado; implementación pendiente).
- **R11 → R11-B** (diseño/contrato preparado; dependencia #50 ya en main).
- **R12 → R12-B** (diseño/contrato preparado; ranking implementable pronto sobre #51 ya en main;
  ejecución real de run/matchmaking gateada a VM108).
- **GLOBAL → GLOBAL-B**: diseño y plan multiequipo completos, implementación pendiente y
  secuenciada. #50/#51 **ya integradas en main** (`6373e19`); R10 es el siguiente en código.
  No GLOBAL-A (no hay código de estas foundations, por decisión).
