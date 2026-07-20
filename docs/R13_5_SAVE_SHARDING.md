# R13.5 · Save/Sharding — Diseño (DESIGN-GATE)

**Estado**: diseño aprobado en DESIGN-GATE (CONFORME-CON-OBSERVACIONES, observaciones
incorporadas) y **slice 1 implementado** en `feature/r13-5-save-sharding-slice1`
(`apps/arena-engine/src/checkpoint.ts` + `tests/checkpoint.test.ts`). Nota de
implementación: la resimulación del restore itera `step()` a mano — `run(maxTicks)`
remata la batalla con `finish("draw")` al agotar el límite y la dejaría muerta.

**Alcance del bloque**: el "posterior por riesgo de determinismo" del roadmap
(save/load + sharding), no la evaluación de upgrade de Rapier — esa sigue siendo una
rama de evaluación separada sin merge (`docs/R13_ENGINE_RUNTIME_QUALITY.md` §4) y **no
se toca aquí**. Los prerequisitos que el plan exigía (R13.0 regression locks, R13.2
hardening) están en main.

## Restricción rectora

Cualquier reanudación debe reproducir **bit a bit** el mismo `stateHash()` /
`finalStateHash` que la ejecución continua. Un save/restore que produzca otro hash es
un fallo, no una variante: el hash canónico (`battle.ts`) incluye RNG, fingerprint del
solver Rapier, vehículos, proyectiles, minas, destructibles y marcador.

## Decisión 1 — Save/restore slice 1: **checkpoint por resimulación**, no
serialización del mundo físico

Dos estrategias posibles:

- **(A) Serializar el estado completo**, incluido el `RAPIER.World` (existe
  `takeSnapshot()/restoreSnapshot()` nativo, hoy sin usar). Riesgo alto: hay que
  demostrar que la restauración reproduce exactamente `solverFingerprint()` (islas de
  sueño y pares de contacto incluidos, que entran en el hash), a través del boundary
  WASM y con compatibilidad de versión de formato binario de Rapier. Si no es
  bit-exacta, todo el slice queda invalidado.
- **(B) Checkpoint = prefijo de replay + hash esperado; restore = resimulación
  determinista acotada.** El motor ya garantiza que cabecera (seed/ruleset/mapa) +
  comandos por tick reproducen la ejecución exacta (es la base de `verify()` en
  `replay.ts`), y `Battle.run(maxTicks)` ya permite parar en un tick arbitrario. Un
  checkpoint v1 es: cabecera de replay + `replayCommands` hasta el tick N + el
  `stateHash` observado en N. Restaurar = crear la batalla desde la cabecera, reproducir
  comandos hasta N con el mecanismo de `ReplayAgent`, verificar que `stateHash()`
  coincide con el guardado (si no, error explícito, nunca continuar en silencio), y
  devolver una `Battle` viva a la que se le pueden acoplar agentes para continuar.

  **Contrato del índice N** (fijado en el DESIGN-GATE): N es el valor de
  `battle.tick` en el momento del save — el estado *tras* ejecutar los ticks
  `0..N-1`, exactamente donde `run(N)` deja la batalla. Los comandos grabados en el
  checkpoint son estrictamente los de `tick < N`; la resimulación de restore usa
  `run(N)` y compara el hash en ese punto.

**Elegida: (B).** Coste: restaurar es O(N ticks) en vez de O(1) — irrelevante a la
escala del proyecto (batallas de ~10³–10⁵ ticks simulados muy por encima del tiempo
real). Beneficio: corrección garantizada por construcción sobre maquinaria ya blindada
(R13.0 + golden replays), cero superficie nueva en la física, cero formato binario
nuevo. La estrategia (A) queda como **slice 2 opcional**, gateado a un spike que
demuestre `solverFingerprint` bit-exacto tras `restoreSnapshot()`; no se promete.

## Slice 1 — entregable concreto

Todo en `apps/arena-engine` (cero cambios en API/web/servicios, cero despliegue):

1. **`src/checkpoint.ts` (nuevo)**: tipos + funciones puras.
   - `saveCheckpoint(battle, header): BattleCheckpoint` — requiere
     `recordReplay: true`; captura `formatVersion: 1`, `engineVersion`,
     `rulesetVersion`, cabecera de replay, `tick`, comandos hasta el tick actual y
     `stateHash()` actual. Falla con error claro si la batalla no grababa replay o ya
     terminó (`finished`) — reanudar una batalla terminada no tiene sentido.
   - `restoreCheckpoint(checkpoint, agents): Promise<Battle>` — valida
     `formatVersion`/`engineVersion`/`rulesetVersion` (rechazo estricto en mismatch,
     mensaje con ambos valores, sin "modo tolerante"), resimula hasta `tick` con los
     comandos grabados, compara `stateHash()` con el guardado (mismatch ⇒ throw con
     ambos hashes), acopla los agentes reales y devuelve la batalla lista para
     `step()/run()`.
   - Serialización a JSONL reutilizando los registros de `replay.ts` (mismo formato de
     línea + un registro nuevo `t: "ckpt"`), para no inventar un contenedor nuevo.
2. **Cero cambios en `battle.ts`** (corregido en el DESIGN-GATE): los agentes NO
   entran por `BattleConfig`; el método público existente `attachBot(vehicleId, agent)`
   ya permite acoplar agentes a una batalla construida (es lo que `record()` y
   `resimulateWithEvents()` hacen hoy). No se crea ningún método nuevo salvo que la
   implementación demuestre una necesidad real. Ningún cambio en el bucle de tick ni
   en `stateHash()`.
3. **Sin exponer nada**: ni CLI nueva, ni endpoint, ni flag. El consumo por
   protocol-server/torneos es un slice posterior con su propio diseño.

`checkpoint.ts` queda bajo `lint-determinism.mjs` por defecto (sin relojes, sin UUID
aleatorio; los ids siguen saliendo de `entitySeq`).

**Límites conocidos (explícitos tras el DESIGN-GATE):**

- La garantía de bit-exactitud cubre **el estado del motor en el tick N**. NO cubre la
  continuidad de comportamiento de bots externos stateful tras la reanudación: el
  estado "inteligente" de un bot vive en su proceso externo, y un bot reconectado en
  frío puede decidir distinto de como habría seguido sin interrupción — sin romper
  ningún hash (el hash no depende de la calidad de la decisión). El slice que exponga
  reanudación real a protocol-server/torneos deberá tratarlo.
- `observationFor()` consume el RNG canónico fuera del ciclo de decisión (hoy solo lo
  usan tests): ningún slice futuro puede exponerlo en vivo sin romper la premisa de
  resimulación — restricción anotada para consumidores futuros.
- Los `publicEvents`/`snapshots` se regeneran dentro del `Battle` nuevo durante la
  resimulación; no hay reemisión externa mientras el restore no esté conectado a
  consumidores en vivo (caso de este slice). Multi-ronda (`runMatch`): cada ronda es
  una `Battle` independiente con semilla derivada, así que su checkpoint es el caso
  normal, sin tratamiento especial.
- Sobre versiones: el ruleset ya embebe su versión en `rulesetId` (p.ej.
  `dm_practice@1`); la validación estricta usa los identificadores versionados reales
  de la cabecera de replay, no campos nuevos.

### Tests (con mutaciones de no-vacuidad)

- Propiedad central: correr batalla con seed fijo hasta el final grabando hashes
  intermedios; checkpoint en un tick intermedio; restaurar; continuar hasta el final;
  `finalStateHash` **idéntico** al de la ejecución continua, y hashes intermedios
  posteriores al checkpoint también.
- Restaurar y verificar en el propio tick del checkpoint (hash coincide sin avanzar).
- Rechazos: formatVersion desconocido, engineVersion/rulesetVersion distintos, hash
  guardado adulterado (mismatch ⇒ throw), batalla sin `recordReplay`, batalla
  `finished`.
- Round-trip JSONL (parse(serialize(ckpt)) equivalente).
- Los locks R13.0 (`acoustic`/`ammo`/`radio`), `determinism.test.ts` y
  `replay-golden.test.ts` deben seguir en verde sin regenerar goldens (este slice no
  cambia la simulación, así que ningún golden puede moverse).

## Decisión 2 — Sharding: **inter-batalla ya existe; partición intra-batalla
rechazada**

- El sharding operativo real del proyecto es **por `battleId`**: cada batalla es un
  proceso/contenedor independiente (runner containerizado) y el gateway/espectadores ya
  particionan por batalla (R13.2, ADR R14). Escalar = más batallas en paralelo, no
  partir una batalla. No requiere código nuevo en este bloque.
- La **partición espacial intra-batalla** (quadtree/grid, workers paralelos dentro de
  una simulación) se **rechaza**: el roadmap la marca de alto riesgo de determinismo,
  el motor es O(n) sobre un puñado de vehículos sin ningún problema de rendimiento
  medido, y romper el orden secuencial del tick pondría en riesgo el hash por orden de
  flotantes y de eventos. Reapertura solo con perfiles de rendimiento reales que lo
  exijan y un diseño específico con prueba de equivalencia de hash.
- Entregable de esta decisión: esta sección + actualización del roadmap (la línea
  "save/load, latencia simulada, sharding" pasa a reflejar: save/load slice 1 hecho,
  sharding resuelto por decisión, latencia simulada sigue pendiente con su nota de "no
  alterar el tick lógico").

## Fuera de alcance (explícito)

- Upgrade/evaluación de Rapier (sigue siendo rama de evaluación separada, sin cambios).
- Latencia simulada / pérdida de paquetes (pendiente, diseño propio).
- Serialización nativa del mundo Rapier (slice 2 opcional gateado a spike).
- Persistencia de checkpoints en servicios/BD, CLI o UI de reanudación.
- Cualquier cambio que mueva un solo hash de los golden replays.

## Criterio de éxito del bloque (R13.5-A)

Slice 1 mergeado con: propiedad de hash idéntico continua-vs-reanudada verde en CI,
locks R13.0 y goldens intactos, mutaciones de no-vacuidad demostradas, Supervisor
independiente conforme, y roadmap actualizado con las dos decisiones de este diseño.
