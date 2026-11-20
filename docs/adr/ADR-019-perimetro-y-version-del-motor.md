# ADR-019 · Perímetro de la arena: el motor pasa a 0.2.0

**Estado:** aceptado (2026-10-27) · **Ámbito:** `apps/arena-engine` (simulación), `apps/replay-service` (verify), `apps/api` (`verifyReplay`)

## Contexto

La arena no tenía perímetro (UX-07): un vehículo podía salir del mapa y seguir
moviéndose. La corrección (`apps/arena-engine/src/sim/battle.ts`:
`addArenaBoundary` y `clampInsideBox`) **cambia la simulación**: añade cuerpos
estáticos en el borde y acota la posición. Los hashes golden se regeneraron, pero
`engine-deps.json` siguió declarando `engine.version = "0.1.0"`.

`verifyLoaded` (`apps/replay-service/src/store.ts`) sólo rechaza un replay con
`engine_version_mismatch` si la versión de la cabecera difiere de la del motor; si
coincide, re-simula. Con la misma versión y otra simulación, **todos los replays ya
grabados** (motor sin perímetro) habrían re-simulado distinto desde el tick 0 y se
habrían declarado manipulados tras el despliegue. Comprobado con un replay real
grabado con el motor de `origin/main` (35a4fb9): `verify` → `matches=false`,
`divergedAtTick=0`.

El `$comment` de `engine-deps.json` (D4 de ADR-000) exige un ADR para cambiar
cualquier valor del fichero.

## Decisión

1. `engine.version` pasa de `0.1.0` a **`0.2.0`**. Regla: **todo cambio que altere
   el resultado de una simulación determinista sube la versión del motor**, aunque
   Rapier, el protocolo y el esquema de reglas no cambien. Regenerar los golden sin
   subirla es un error.
2. `physics`, `protocol` (`arena/1`) y `rulesSchema` (1) **no cambian**: el
   perímetro no toca la build de Rapier, ni los mensajes, ni el formato de reglas.
3. Un replay de otra versión del motor sigue siendo `valid=false` con
   `reason=engine_version_mismatch: replay=<v>, disponible=<v>` (despliegue de
   versión única, sin multi-versión todavía) y ahora lleva además un `message`
   para personas: «se grabó con otra versión del motor … eso NO significa que esté
   manipulado». La API (`POST /replays/{id}/verify`) lo devuelve tal cual.

## Qué depende de la versión del motor (revisado)

| Consumidor | Uso | Efecto del cambio |
|---|---|---|
| Cabecera del replay (`battle.ts`, `checkpoint.ts`) | `versions.engine` | los replays nuevos dicen `0.2.0` |
| WELCOME (`protocol-server.ts`) | `versions.engine` informativo | los SDK no lo comparan; el test de contrato de Python lee el fichero |
| `battles.engine_versions` (worker) | copia informativa | sin lógica que filtre por ella |
| `verifyLoaded` / `verifyReplay` | filtro de versión | replays 0.1.0 ⇒ `engine_version_mismatch` |
| Reanudar checkpoint | exige misma versión | una batalla interrumpida durante el despliegue no se reanuda con el motor nuevo (se rechaza, no se corrompe) |
| Bots, artefactos, builds | `SDK_VERSION` y `protocol`, **no** la versión del motor | los bots publicados siguen siendo elegibles y jugando |
| Temporadas y ranking (`ratings`, `standings`) | por temporada, modo y bot-versión | no dependen de la versión del motor; el historial no se recalcula |

## Alternativas descartadas

- **Mantener 0.1.0**: deja el falso «manipulado» para todos los replays anteriores.
- **Re-simular con el motor antiguo (multi-versión)**: exige empaquetar y cargar
  dos motores; sigue pendiente de E10, como ya declaraba `verifyLoaded`.
- **Desactivar el perímetro en replays antiguos** (bandera en la cabecera):
  multiplica los caminos de la simulación determinista; es multi-versión encubierta.

## Consecuencias

- Los replays anteriores al despliegue siguen reproduciéndose en el visor (los
  eventos y snapshots están grabados) pero no se pueden **verificar** por
  re-simulación con este motor; la respuesta lo explica.
- Regresión: `apps/replay-service/tests/engine-version-bump.test.ts` y
  `apps/api/src/e8-replay-verify.test.ts` usan un replay real del motor 0.1.0
  (`apps/replay-service/tests/fixtures/engine-0.1.0-sin-perimetro.replay.jsonl.gz`).
  Ambos se ponen rojos si se vuelve a `0.1.0`.
