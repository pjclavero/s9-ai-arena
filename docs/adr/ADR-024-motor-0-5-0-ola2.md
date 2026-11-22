# ADR-024 · Motor 0.5.0: una sola subida de versión para la OLA 2 (engine hardening)

**Estado:** aceptado e implementado en `main` (PR #293 y #294; motor 0.5.0) (propuesto el 2026-11-17, integración de la OLA 2 en `hardening/contracts`) · **Sustituye en la versión a:** ADR-022 (la regla «las semánticas nuevas usan una versión nueva» sigue vigente) · **Ámbito:** `apps/arena-engine/src/engine-deps.json`, `packages/game-rules/rules-doc.ts` (y `docs/user/rules.{md,json}` generados), ejemplos del protocolo y casos compartidos de los SDK.

## Contexto

La OLA 2 integra en un único SHA varios cambios que alteran la simulación o lo que `verify()` acepta, todos con el motor todavía en `0.4.0`:

| Frente | Cambio | Efecto sobre un replay v2 anterior |
|---|---|---|
| MB | contrato de daño | trayectoria y daño distintos |
| MC | `weapon.rangeM` real (sin la regla fija de 90 ticks) | vida de proyectil distinta |
| G1 (H-4) | la onda HE contra un muro sale de la cara del collider (también si la boca del arma nace dentro del muro) y daña a quien la cara deja ver | divergencia de hash en cualquier batalla con ese caso |
| G3 (H6) | `respawn.rearmPolicy` es parte de la cabecera; una cabecera con respawn y sin política da `rules_incomplete` | deja de verificarse |

Las reglas del proyecto lo exigen: ADR-022, decisión 1 del operador («no se reutiliza una versión para replays cuya semántica cambió»), y `packages/game-rules/index.ts` («cambiar la simulación exige versión de motor»). Además, las dos revisiones (G1-REVIEW P3-1 y G3-REVIEW P3-3) dejaron la subida a la integración, y las notas de integración registran «subir la versión del motor una única vez».

## Decisión

- `engine.version` pasa a **`0.5.0`**, **una sola vez** para toda la OLA 2. No hay versiones intermedias por frente.
- No se recupera `engine.reproduces` (enmienda de ADR-022, BACKWARD_COMPATIBILITY_REQUIRED=NO): el verificador sigue siendo de versión única.
- El hash de estado **no** incluye la versión del motor. Por eso no se reancla ningún golden de simulación. El único golden que cambia es el campo `versions.engine` de `apps/arena-engine/tests/baseline/golden/reference-hashes.json`: el golden registra las versiones y el cambio de versión es, precisamente, lo que se decide aquí. `finalStateHash`, `stateHashesDigest` y `snapshotsDigest` no cambian.

## Qué pasa con los replays y datos existentes

- **Producción (`main`):** guarda replays `formatVersion: 1` (motores 0.2.0, 0.3.0 y 0.4.0). Desde MD, la base ya no los lee (`format_version_mismatch`, «NO significa que esté manipulado»). La subida no cambia nada ahí. Los checkpoints de producción no tienen `formatVersion: 2` y ya se rechazaban.
- **Replays v2 de 0.4.0** (sólo existen en builds de hardening: laboratorio y CI; nunca en producción): pasan a dar `engine_version_mismatch: replay=0.4.0, motor=0.5.0` **antes** de re-simular. Sin la subida, el caso HE-muro habría divergido en silencio (`matches=false`, que se lee como manipulado). Lo prueba `apps/replay-service/tests/engine-version-ola2.test.ts`, que también fija que la versión se comprueba antes que `rules_incomplete`.
- **Copias de reglas** (`battles.rules.engineVersion`, `tournaments.rules.engineVersion`) guardadas con `0.4.0`: son metadatos. El worker no los compara y una batalla `scheduled` de un torneo anterior al despliegue se juega con 0.5.0. Su copia, sin `rearmPolicy`, sigue con `self` (G3). Las copias nuevas se graban con `0.5.0`.
- **`battles.engine_versions`:** las batallas nuevas registran `0.5.0`. El histórico distingue así las batallas anteriores y posteriores a la OLA 2, que con la misma etiqueta serían indistinguibles.
- **Bots:** el WELCOME informa `versions.engine = "0.5.0"`. El protocolo sigue siendo `arena/1`. Los tests de contrato de los SDK leen la versión de `engine-deps.json`.

## Alternativas descartadas

- **Seguir en 0.4.0:** la misma etiqueta cubriría dos simulaciones distintas (la desplegada y la de la OLA 2). Un replay v2 previo con HE contra muro se declararía «no coincide», y la regla de ADR-022 lo prohíbe.
- **Una versión por frente (0.5.0 para G1 y 0.6.0 para G3…):** no aporta nada. Ninguna build intermedia se desplegó, y la OLA 2 se integra y se despliega como un único SHA.
- **`reproduces: ["0.4.0"]`:** falso. MB, MC y G1 cambian la trayectoria, y G3 cambia la cabecera.

## Consecuencias

- Toda batalla nueva graba `engine: "0.5.0"`.
- Al desplegar, se aplican las mismas precauciones que en ADR-022: sin batallas `running` (un checkpoint no se reanuda entre versiones) y decisión sobre los replays v1 (archivar o borrar). Ver `docs/operations/upgrades.md`.
- **Vuelta atrás al motor desplegado (0.4.0, replay v1):** no re-simula los replays 0.5.0, que son v2 y de otra versión. Antes de volver atrás hay que vaciar las batallas `scheduled` con copia de reglas (procedimiento de ADR-022).
