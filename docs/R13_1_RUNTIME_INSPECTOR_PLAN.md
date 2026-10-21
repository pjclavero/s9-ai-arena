# R13.1 · Runtime Inspector — Auditoría (hallazgo: ya implementado en `main`)

> Encargo original: auditar y diseñar el CONTRATO de un inspector HTTP de solo lectura para
> `apps/arena-engine`, sin implementarlo, porque la PR #87 (`feat/b9-catalog-map-resolution`,
> abierta) tocaría archivos en conflicto. Este documento reporta lo que se encontró leyendo el
> código real en `origin/main` (`4505a54`): **el bloque R13.1 ya está implementado, testeado y
> mergeado**, junto con un endurecimiento adicional (R13.2) que ya cubre buena parte de lo que el
> encargo pedía diseñar. No se ha escrito ni una línea de implementación nueva en esta ejecución.

## Verificación hecha

- `git log --oneline -- apps/arena-engine/src/inspector.ts` en `origin/main`:
  - `69cfde5` — "R13.1: inspector HTTP read-only del motor + --speed (cadencia de pared)"
  - `ecc1050` — "R13.2: hardening de runtime y espectador"
  - Ambos commits son ancestros de `4505a54` (`main` actual), es decir: **ya están en `main`**, no
    en una rama aparte.
- `npx vitest run apps/arena-engine/tests/inspector.test.ts --config vitest.pure.config.ts` →
  **15/15 tests en verde** (ejecutado en este worktree, base `origin/main`).
- `gh pr view 87 --json files` → la PR #87 toca únicamente `apps/arena-engine/src/arena-map.ts`,
  `apps/arena-engine/src/service.ts` y sus tests. **No toca** `inspector.ts`, `cli.ts`,
  `sim/battle.ts` ni `tests/inspector.test.ts`. **No hay conflicto real con R13.1/R13.2.**
- Ya existe `docs/R13_1_RUNTIME_INSPECTOR.md` (161 líneas) documentando el contrato tal cual está
  implementado, y `docs/R13_2_HARDENING.md` documentando el endurecimiento.

## Qué pedía el encargo vs. qué existe ya (con cita fichero:línea)

| Requisito del encargo | Estado real en `main` |
|---|---|
| Servidor `node:http` de solo lectura | `apps/arena-engine/src/inspector.ts:20,78-113` — `createServer`, solo rutas `GET`/`HEAD`, sin mutación de estado |
| Apagado por defecto, bind `127.0.0.1` | `apps/arena-engine/src/inspector.ts:64` (`host = opts.host ?? "127.0.0.1"`); solo arranca si se pasa `--inspect` en `apps/arena-engine/src/cli.ts:113,140-149` |
| `GET /health` y `GET /snapshot` | `apps/arena-engine/src/inspector.ts:89-109` |
| `publicSnapshot()` como única fuente | `apps/arena-engine/src/sim/battle.ts:866` `getPublicSnapshot()` → llama a `this.publicSnapshot(this.poses())` (privado); `inspector.ts:101` usa exactamente `battle.getPublicSnapshot()`, sin transformar el resultado |
| Soporte `--inspect` | `apps/arena-engine/src/cli.ts:113,140-149` (flag), más `--inspect-host`, `--inspect-port`, `--inspect-allow-remote` |
| `--speed` solo altera reloj de pared, no `TICK_DT` ni determinismo | `apps/arena-engine/src/cli.ts:51-62` (`runPaced`): `tickIntervalMs = (TICK_DT * 1000) / speed`; `TICK_DT` se importa sin modificar desde `packages/game-rules/constants.ts:18` y nunca se reasigna |
| Ciclo de vida limpio (arranque/cierre sin handles colgados) | `apps/arena-engine/src/inspector.ts:76,115-118,139-146` — set de sockets rastreados, destruidos en `close()`; cubierto por test dedicado |
| Test de determinismo con `--speed`/pacing | `apps/arena-engine/tests/inspector.test.ts:259-278` — compara `finalStateHash` entre `battle.run()` normal y ejecución tick-a-tick pausada, deben coincidir |
| Test de no-filtración de estado privado | `apps/arena-engine/tests/inspector.test.ts:105-118` — comprueba explícitamente que el JSON servido no contiene `seed`, `rng`, `mines`, `velocity`, `energyEU` |

Todo lo que el encargo pedía "diseñar sin implementar" ya está implementado, con tests que cubren
exactamente los riesgos señalados en el encargo (fuga de estado interno, determinismo bajo
`--speed`, limpieza de handles).

## Superficie de seguridad ya cubierta (R13.2, más allá del alcance mínimo de R13.1)

- Sin CORS ni autenticación por diseño, aceptable solo por estar en loopback
  (`apps/arena-engine/src/inspector.ts:11-19`); exponerlo fuera de loopback exige el flag explícito
  `--inspect-allow-remote`, validado en `apps/arena-engine/src/cli.ts:43-49`
  (`validateInspectHost`).
- Límites de servidor contra agotamiento de handles/slowloris: `requestTimeout`, `headersTimeout`,
  `keepAliveTimeout`, `maxConnections` (`apps/arena-engine/src/inspector.ts:67-72,124-127`),
  cubiertos por tests en `tests/inspector.test.ts:164-257`.
- `Cache-Control: no-store` en ambas rutas (`inspector.ts:92,96,103,107`) para que un proxy
  intermedio no cachee snapshots vivos.
- `HEAD` soportado con el mismo contrato de status/cabeceras que `GET` pero sin cuerpo.

## Lo único que el propio código señala como pendiente (no pedido en este encargo)

`docs/R13_1_RUNTIME_INSPECTOR.md:153-161` documenta dos bloques **distintos y no implementados**,
que no forman parte de R13.1 ni de este encargo:

- R11 (spectator público en tiempo real, WebSocket/streaming) — bloque aparte, no HTTP polling.
- Métricas Prometheus (`/metrics`) — mencionadas como "R13.2" en ese documento con un alcance
  distinto al R13.2 de hardening ya mergeado (`ecc1050`); si se retoma, aclarar la numeración para
  no confundir ambos "R13.2".

## Conflictos con PR #87

Ninguno verificado. `gh pr view 87 --json files` no devuelve solapamiento con
`inspector.ts`, `cli.ts`, `sim/battle.ts` ni `tests/inspector.test.ts`. La preocupación del
encargo (que #87 tocara el temporizado de batallas o el launcher HTTP de forma que chocara con el
inspector) no se confirma con los archivos reales de la PR.

## Recomendación

No hay contrato que diseñar ni implementación pendiente para R13.1 tal como está descrito en el
encargo: ya existe, ya está testeado (15/15) y ya está documentado. Si el equipo quiere ampliar el
inspector (streaming, métricas), eso es trabajo nuevo fuera del alcance de R13.1 y debería
encargarse como bloque explícito (p. ej. retomar R11 o clarificar el `/metrics` pendiente),
no como continuación de "R13.1".
