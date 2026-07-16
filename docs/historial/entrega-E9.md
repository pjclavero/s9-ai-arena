# E9 · Torneos y Clasificación — entrega v1

Cola de trabajos durable + tournament-worker (T9.1), los seis formatos y el
flujo completo del 19.1 (T9.2), ratings Elo con libro mayor (T9.3) y justicia
competitiva con commit-reveal y auditoría re-simulable (T9.4), sobre las piezas
REALES de E7 (API/BD/standings), E6 (suspensiones/artefactos), E2 (motor y
replays), E4 (mapas) y E3 (catálogo). Rama `e9-torneos` sobre main `7a450ae`.

## Estado: suite en verde

```bash
npm test -- --maxWorkers=2                 # suite completa del monorepo
npx vitest run apps/tournament-worker      # solo E9: 48 tests, ~7 s
```

Cifras medidas en este entorno (2026-07-16, Node v20.19.2, ia02 sin docker/sudo):

- Suite completa del repo: **540 pasan, 1 falla, 3 skipped** (544 tests, 56
  archivos, 60 s). El único fallo es el PREEXISTENTE de entorno (`zstdCompressSync`
  no existe en Node 20; exige ≥22.15) en
  `apps/arena-engine/tests/replay-golden.test.ts`. La línea base antes de E9
  era 492 pasan / mismo fallo / 3 skipped: E9 añade 48 tests, todos verdes, y
  no rompe nada.
- Solo E9: **48 tests en 5 archivos** (`queue`, `formats`, `ratings`,
  `tournament-e2e`, `justice`), ~7 s con 4 clústeres PostgreSQL 18 reales
  embebidos (harness de E7, ADR-E7-002; prohibido y no usado ningún Postgres
  del homelab).
- Torneo eliminatorio de 8 bots (7 batallas REALES del motor E2 con réplica
  grabada) de principio a fin, incl. campeón+standings+replays: **~0,9 s**.
- Verificación por re-simulación (`verify()` del motor, hashes intermedios):
  4 batallas re-simuladas y verificadas en ~1,5 s dentro del test E2E de T9.4.

## Contenido

```
apps/tournament-worker/src/
  errors.ts           T9.1 · clasificación 19.2 formalizada (E9.M): deportivo vs infraestructura
  queue.ts            T9.1 · cola durable sobre jobs (E7): dedupe_key, claim FOR UPDATE SKIP LOCKED,
                              huérfanos por lock timeout, reintentos SOLO de infraestructura → needs_review
  redis-signal.ts     T9.1 · capa Redis fina (aviso LPUSH/BLPOP + candado SET NX PX), RESP sin dependencias
  worker.ts           T9.1 · bucle 9.4: una batalla por hueco, concurrencia por CPU/RAM configurada
  battle-runner.ts    T9.1 · run_battle: suspensiones E6 → DQ administrativa, walkover, replay a archivo (23.1)
  formats.ts          T9.2 · SEIS generadores PUROS + desempates documentados + anti-colusión E9.M + bracket reset
  scheduler.ts        T9.2/T9.4 · generate_schedule (validaciones 19.1, semillas commit-reveal por batalla,
                              lados alternados, final en modo visible) + dry-run E9.M
  results.ts          T9.2 · series, avance de brackets (byes en cascada, GF2 condicional), rondas suizas, campeón
  engine-executor.ts  T9.2 · ejecutor real: Battle/record (E2) + toEngineMap (E4) + resolveVehicle (E3, catálogo
                              congelado de BD) + budget del torneo (ADR-000)
  ratings.ts          T9.3 · RatingSystem/Elo K por liga, libro mayor rating_events, reversión, ratingAt()
  standings.ts        T9.3 · rating + tabla → updateStandings REAL de E7 (caché ≤60 s)
  testing/fixtures.ts        bots publicados con loadout E3 + artefacto firmado (builds/artifacts)
apps/api/src/db/migrations.ts   007_e9_queue y 008_e9_competition (up/down completos; el test up→down→up de E7 las cubre)
apps/api/src/routes/tournaments.ts  closeEntries con commit-reveal REAL (T9.4, reconciliación E7 prevista)
docs/decisiones/ADR-E9-001-cola-postgres-redis.md · ADR-E9-002-rating-elo.md
```

Commits (uno por tarea): `672c4f6` T9.1 · `3a580f5` T9.2 · `7282746` T9.3 ·
`522f30b` T9.4 (+ este documento).

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T9.1 | Matar el worker a mitad de un torneo de 20 batallas y reiniciar: se reanuda sin duplicadas ni perdidas | **[EJECUTADO]** test de caos: 7 procesadas + 1 secuestrada por worker "muerto" (lock huérfano) + reinicio; 20/20 terminadas, cada una ejecutada UNA vez |
| T9.1 | Derrota por timeout del bot queda como derrota y NO se reintenta | **[EJECUTADO]** job `done` con attempts=1, batalla `bot_timeout`, culpable DQ, rival gana |
| T9.1 | Fallo de infraestructura simulado se reintenta hasta el límite y marca revisión manual | **[EJECUTADO]** motor-que-muere: exactamente max_attempts=3 ejecuciones → job `needs_review`, batalla `failed/infrastructure` |
| T9.1 | Dos workers concurrentes nunca ejecutan la misma batalla | **[EJECUTADO]** 8 claims simultáneos → 1 ganador; 2 workers drenando 10 batallas → 1 ejecución/batalla |
| T9.2 | Golden brackets: cada formato con 4, 8 y 13 participantes | **[EJECUTADO]** calendarios exactos literales para 4 (los seis formatos) y 8/13 (estructura completa: byes exactos, slots, fuentes); ver "decisiones" |
| T9.2 | Propiedades: RR todos-contra-todos una vez; suizo sin repetir si evitable; doble elim nadie fuera con 1 derrota | **[EJECUTADO]** fast-check (2..16 participantes, torneos simulados; doble elim con bracket reset GF2 verificado eliminado⇒exactamente 2 derrotas) |
| T9.2 | El cierre congela versiones: un push posterior no afecta al torneo | **[EJECUTADO]** E2E por API E7 (17.1/17.2 reales): versión→frozen; nueva versión+loadout post-cierre no tocan la inscripción |
| T9.2 | Torneo eliminatorio de 8 bots corre de principio a fin sin intervención y publica campeón, clasificación y replays | **[EJECUTADO]** 7 batallas reales del motor; campeón=ganador de la final (modo visible); standings por API pública E7; replays descargables sin cuenta |
| T9.3 | Suma de Elo se conserva en sistema cerrado | **[EJECUTADO]** propiedad fast-check (1v1 y equipos, 200 runs) + sistema cerrado de 4 bots en BD |
| T9.3 | Reprocesar una batalla no aplica el rating dos veces | **[EJECUTADO]** segunda aplicación = no-op (candado + UNIQUE battle_id,bot_id) |
| T9.3 | Batalla anulada revierte su efecto | **[EJECUTADO]** deltas inversos + eventos marcados `reverted` (reversión idempotente) |
| T9.3 | El historial reconstruye el rating en cualquier fecha | **[EJECUTADO]** `ratingAt()` = replay del libro mayor; coincide con réplica manual y con la tabla materializada |
| T9.4 | Endpoint de auditoría con todos los artefactos/versiones y verify reproduce la batalla | **[EJECUTADO]** E2E: audit público (seed, commit, reveal-proof, versiones motor/Rapier/reglas/protocolo/catálogo, checksum de mapa, hash+firma por bot) + re-simulación `verify()` con hashes intermedios |
| T9.4 | Commit-reveal verificable: hash publicado antes del cierre == semillas reveladas | **[EJECUTADO]** por API: reveal ausente/falso ⇒ 409; semilla de CADA batalla re-derivable públicamente |
| T9.4 | Cada emparejamiento de liga juega el mismo número de veces por lado | **[EJECUTADO]** a nivel de calendario (propiedad: liga 2 vueltas ⇒ cada par ordenado UNA vez) y de BD (serie con lados alternados por juego) |
| T9.4 | Cambio de catálogo en curso no afecta al torneo | **[EJECUTADO]** mvp@2 importado a mitad; batallas usan module_definitions del mvp@1 congelado |

Mejoras E9.M: commit-reveal (hecho, T9.4); enumeración de códigos de fallo
(hecho, errors.ts); anti-colusión mismo dueño en ronda 1 (hecho, mejor
esfuerzo + test); modo simulacro dry-run del organizador (hecho: valida y
simula sin escribir batallas ni ratings, informe en el job).

## Decisiones (honestas) y desviaciones

- **Redis**: la cola es PostgreSQL-primero (ADR-E9-001): la tabla `jobs` es la
  verdad y el bloqueo distribuido es `FOR UPDATE SKIP LOCKED`; Redis queda
  como capa de aviso/candado opcional (`redis-signal.ts`, cliente RESP propio
  sin dependencias). **No hay Redis real en este entorno** (sin docker/sudo):
  la capa se prueba contra un stub RESP en proceso → **[PENDIENTE]** validar
  contra Redis real cuando E10 lo despliegue. Ningún requisito funcional
  depende de Redis (eso es exactamente lo que pide el dosier).
- **Agentes de batalla**: sin Docker no se ejecuta código de usuario en
  contenedores (misma limitación declarada por E6/E7). El ejecutor usa la
  interfaz `AgentResolver`; por defecto stubs deterministas REALES del motor
  (HunterBot). El resto del camino (mapa E4, catálogo E3 congelado, loadouts
  congelados, semillas, replay, verify) es 100 % real → **[PENDIENTE]**
  enchufar el runtime containerizado de E6 vía `AgentResolver`.
- **Golden 8/13**: para 4 participantes el calendario esperado está escrito
  literal en el test para los seis formatos; para 8 y 13 se fija la estructura
  completa (nº de matches, rondas, byes EXACTOS —P1/P2/P3 en eliminatoria de
  13—, slots y fuentes) más la ronda 1 literal en RR/eliminatorias/suizo.
  Escribir literales los ~30 matches de una doble eliminación de 13 no añade
  cobertura sobre las propiedades fast-check + estructura exacta.
- **Doble eliminación**: con bracket reset (GF2) condicional para cumplir
  LITERALMENTE "nadie queda fuera con una sola derrota" (si el invicto gana la
  GF, la GF2 se resuelve sin jugarse como formalidad).
- **Empate de serie en eliminatorias**: decide el mejor seed (orden de
  inscripción); en liga/RR/suizo el empate es empate (1 punto).
- **Elo, no Glicko-2** (ADR-E9-002): K configurable por liga
  (`tournaments.elo_k`); interfaz `RatingSystem` preparada para el cambio.
  En equipos, deltas por parejas cruzadas (suma exactamente conservada).
- **budgetCredits** (ADR-000/D7): del torneo (o su ruleset si es NULL), fijado
  al crear y NUNCA recalculado por el worker; el ejecutor lo propaga como
  override del ruleset del motor. Verificado en el E2E (900 créditos intactos).
- **Espectador con retardo** (E8.M): `battles.spectator_mode`
  ('delayed'|'visible'); la final se marca 'visible' (19.1). El retardo real
  del canal lo aplica el gateway (E8/E10).

## Pendiente de reconciliación (explícito)

| Con | Qué | Estado actual en E9 |
|---|---|---|
| E6 | Ejecución de bots reales en contenedores (protocol-server) | Interfaz `AgentResolver` lista; stubs del motor como agentes; suspensiones/DQ de E6 SÍ integradas (administrativeDisqualifications real) |
| E7 | `rulesets` de BD vs rulesets del motor (game-rules) | Mapeo modo→ruleset del motor con overrides (budget del torneo); unificar cuando E7/E1 fijen el contrato de ruleset completo |
| E7 | Standings por EQUIPOS (la tabla standings es por bot) | Clasificación por equipos calculada (leagueTable) pero no materializada en `standings`; decidir esquema con E7 |
| E8 | Compresión zstd de replays y stats ricas por módulo | Replay JSONL plano (formato T2.6 real, verify OK); zstd y battle_stats ricas son de E8 |
| E10 | Redis real, systemd/compose del worker, métricas | Worker es una clase con start/stop y concurrencia configurable; falta empaquetado de despliegue |
| E11 | Endpoint HTTP para `ratingHistory`/`ratingAt` (historial público) | Funciones listas y testeadas; exponer ruta cuando el contrato E1 la defina |

## Limitaciones de entorno asumidas

- Node 20 (el repo pide 22 para zstd): único test rojo preexistente
  (replay-golden, `zstdCompressSync`), NO tocado, NO es de E9.
- Sin docker/sudo: ni Redis real ni contenedores de bots (ver arriba).
- BD de tests: PostgreSQL 18 real embebido por archivo de test (harness E7).
