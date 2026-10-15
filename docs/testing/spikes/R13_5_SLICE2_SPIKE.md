# R13.5 · Slice 2 — Spike de snapshot nativo de Rapier (N3)

**Estado**: spike cerrado. Ver `docs/R13_5_SAVE_SHARDING.md` (Decisión 1): el slice 2
quedó "gateado a un spike que demuestre `solverFingerprint` bit-exacto tras
`restoreSnapshot()`". Este documento es ese spike.

**Test reproducible**: `apps/arena-engine/tests/rapier-snapshot-spike.test.ts` (3 casos,
ejecutable con `npx vitest run apps/arena-engine/tests/rapier-snapshot-spike.test.ts`).
No toca `Battle`/`PhysicsWorld` ni cambia comportamiento del motor: es aditivo.

## Pregunta

El slice 1 (`apps/arena-engine/src/checkpoint.ts`, ya en `main`) hace checkpoint por
**resimulación**: O(N ticks). Un slice 2 con `World.takeSnapshot()` /
`World.restoreSnapshot()` de Rapier prometería O(1), pero solo tiene sentido si el
mundo restaurado, al seguir simulando, produce **exactamente** los mismos resultados
que el mundo original habría producido. La pregunta a responder:

> Tras tomar `world.takeSnapshot()` en el tick N y `World.restoreSnapshot()` en un
> `World` nuevo, ¿seguir simulando M ticks más en el world restaurado da el MISMO
> estado (cuantizado igual que `stateHash()`) que seguir simulando M ticks en el
> world original?

## Corrección sobre el contexto de partida de la tarea

El encargo de este spike asumía que `stateHash()` (`battle.ts`) no contenía ningún
"fingerprint del solver". Al inspeccionar el código actual, **sí lo contiene**:
`PhysicsWorld.solverFingerprint()` (`apps/arena-engine/src/sim/physics.ts:286`) ya
existe y ya entra en `stateHash()` (`battle.ts:791`, campo `solver`) — cuenta cuerpos
despiertos y pares de contacto. Esto no cambia la pregunta del spike (las poses
cuantizadas + ese fingerprint agregado siguen sin cubrir el estado interno completo
del solver — manifolds de contacto, impulsos acumulados de warm-starting — que no
está en el hash pero sí puede influir en los pasos siguientes), pero sí la hace más
fácil de responder: el spike reutiliza el mismo criterio de fingerprint que ya usa el
motor en producción, en vez de inventar uno nuevo.

## Método (Nivel 1)

Script/test aislado de Rapier (no usa `Battle`/`PhysicsWorld`, cuyo `RAPIER.World` es
privado; replica su configuración real: gravedad nula, `timestep = TICK_DT`, cuerpos
dinámicos con el mismo damping/restitución/fricción/CCD que `physics.ts::addVehicle`).

Escenario: 4 vehículos convergiendo hacia el origen (garantiza contacto
vehículo-vehículo real, verificado por sondeo previo con `contactPairsWith`) + 1
vehículo en reposo total desde el tick 0 (para forzar una isla de sueño) + 1 muro fijo
alejado del punto de choque (para no interpenetrar en t=0).

Para varios `(N, M)`:
1. Construir el world, dar `N` steps.
2. Tomar `snapshot = world.takeSnapshot()` en ese punto. Medir el
   `solverFingerprint` en N (para saber si el snapshot se tomó con contactos activos).
3. **Camino A**: seguir `M` steps más en el MISMO world.
4. **Camino B**: `World.restoreSnapshot(snapshot)` → world nuevo; seguir `M` steps
   más ahí. Los handles de cuerpo (índice+generación) se verifican estables tras el
   restore (mismo número de cuerpos, mismos handles reutilizables).
5. Comparar el estado final de A vs B: posición/rotación/velocidad/velocidad angular
   de cada cuerpo, cuantizados con el MISMO `q()` que usa `stateHash()`
   (`Math.round(n * 1e5) / 1e5`), más `solverFingerprint` (despiertos + pares de
   contacto) con el mismo criterio que `physics.ts`.

Casos cubiertos:
- `N=1` (arranque, sin contactos).
- `N=13, M=60` y `N=13, M=1` — snapshot **en pleno contacto** (`contactPairs=4`
  medido en N): el caso más exigente, porque es donde vive el estado interno del
  solver que no está en el hash.
- `N=17, M=45` — snapshot justo al final de la ventana de contacto observada.
- `N=200, M=30` — snapshot con un cuerpo (`v-resting`) ya dormido (confirmado con
  una aserción aparte: `rb.isSleeping() === true` a N=200), para ejercitar el caso
  de islas de sueño explícitamente mencionado como riesgo en
  `docs/R13_5_SAVE_SHARDING.md`.

## Resultado empírico

Todos los casos dan **coincidencia bit a bit** (tras la cuantización de `stateHash()`)
entre el camino A (continuo) y el camino B (snapshot + restore + continuar), incluida
la coincidencia exacta del `solverFingerprint`.

Ejemplo real (`N=13, M=60`, snapshot tomado con `contactPairs=4`, es decir en pleno
choque entre los cuatro vehículos):

```
fingerprint en N: { awakeBodies: 5, contactPairs: 4 }

estado A tras N+M=73 steps:
[{"id":"v-east","pos":[1.77667,-0.00713],"rot":0.04592,"vel":[0.11854,-0.00164],"angvel":-0.00001,"sleeping":false},
 {"id":"v-north","pos":[0.00159,-1.77452],"rot":0.10299,"vel":[0.00037,-0.11802],"angvel":0.00001,"sleeping":false},
 {"id":"v-resting","pos":[15,15],"rot":0,"vel":[0,0],"angvel":0,"sleeping":true},
 {"id":"v-south","pos":[-0.00413,1.77654],"rot":-0.07182,"vel":[-0.00098,0.11851],"angvel":0,"sleeping":false},
 {"id":"v-west","pos":[-1.77413,0.00511],"rot":-0.12807,"vel":[-0.11793,0.00116],"angvel":-0.00002,"sleeping":false}]

estado B tras N+M=73 steps: IDÉNTICO CARÁCTER A CARÁCTER al de A.
```

Los otros tres casos (`N=1,M=5`; `N=13,M=1`; `N=17,M=45`; `N=200,M=30` con
`v-resting` dormido) dan el mismo resultado: identidad exacta de estado cuantizado y
de fingerprint. El test que lo codifica
(`apps/arena-engine/tests/rapier-snapshot-spike.test.ts`) pasa en Node 20 local:

```
$ npx vitest run apps/arena-engine/tests/rapier-snapshot-spike.test.ts
 ✓ nivel 1 · round-trip N=13,M=60 (snapshot EN PLENO CONTACTO) ...
 ✓ nivel 1 · varios N (incluye cuerpos dormidos): el resultado es consistente ...
 ✓ nivel 1 · v-resting se duerme antes de N=200 (confirma islas de sueño) ...
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

No se observó ningún caso, entre los probados, en el que A y B divergieran — ni en
posición/velocidad ni en el fingerprint del solver (cuerpos despiertos, pares de
contacto).

### Qué NO cubre esta evidencia

- Solo se probaron ~5 cuerpos y unos pocos cientos de steps por caso; una batalla real
  tiene más cuerpos, más tipos de collider (proyectiles, minas, destructibles) y corre
  miles de ticks. No se puede descartar una divergencia rara en escenarios mucho más
  grandes o largos sin más pruebas — pero no hay ninguna razón, ni en la documentación
  de Rapier ni en el resultado obtenido, para esperar una: `takeSnapshot()` está
  documentado como "estado idéntico" y el resultado empírico lo confirma en todos los
  casos con contacto/sueño activo que se probaron.
- No se probó con proyectiles a alta velocidad con CCD activado en el instante
  exacto de un impacto (túnel), aunque el propio experimento ya usa `setCcdEnabled(true)`
  como en producción.
- No se probó bajo distintas versiones de Rapier: el resultado es válido para la build
  fijada por checksum en `engine-deps.json` (D4), no una garantía perpetua.

## Nivel 2 — qué haría falta para integrar (evaluación sin implementar)

Dado que el nivel 1 es positivo, esto es lo que un slice 2 real tendría que resolver:

1. **Re-mapeo de handles.** `PhysicsWorld` (`physics.ts`) mantiene `Map<string,
   BodyHandle>` con referencias a `RAPIER.RigidBody`/`Collider` del world viejo. Tras
   `restoreSnapshot()` el world es nuevo; el spike confirma que los *handles*
   (índice+generación) se conservan, pero los objetos JS `RigidBody`/`Collider` de
   `PhysicsWorld.bodies` seguirían apuntando al world viejo y hay que reconstruirlos
   con `world.getRigidBody(handle)` / iterar colliders del nuevo world y volver a
   poblar `bodies`, `colliderToId`, `kinds` — mecánico pero no trivial: exige que
   `PhysicsWorld` exponga un método de restauración que reconstruya sus tres mapas
   internos a partir del world nuevo, no solo sustituir `this.world`.
2. **Estado no-físico.** El slice 1 ya resuelve esto (comandos + cabecera +
   verificación de hash); un slice 2 seguiría necesitando serializar aparte HP,
   módulos, munición, proyectiles, minas, destructibles, marcador, RNG — nada de eso
   vive en el `RAPIER.World`. El snapshot de Rapier solo sustituye la parte física.
3. **`world.timestep`/gravedad tras restore.** No verificado explícitamente en este
   spike (el experimento vuelve a fijar `world.timestep` en el world nuevo antes de
   step() solo implícitamente porque no se tocó tras `restoreSnapshot`); a confirmar
   en una implementación real si `restoreSnapshot` preserva `timestep`/gravedad o hay
   que reasignarlos tras restaurar. Riesgo bajo (son campos simples), pero es un
   detalle de la integración, no del núcleo del spike.
4. **Formato binario y compatibilidad de versión.** El snapshot de Rapier es un
   blob opaco atado a la versión exacta de Rapier (ya gestionado por D4/checksum de
   WASM). Un checkpoint slice 2 persistido a disco quedaría atado a esa versión: si
   Rapier se actualiza, los checkpoints viejos dejan de poder restaurarse. El slice 1
   no tiene este problema (resimula desde comandos, agnóstico de la versión del motor
   de física, siempre que el propio ruleset/replay siga siendo compatible).
5. **Coste real evitado.** El beneficio de slice 2 es pasar de O(N) a O(1) en el
   restore. A la escala de este proyecto (batallas de 10³–10⁵ ticks, resimulación ya
   confirmada rápida en `checkpoint.test.ts`), ese ahorro es marginal frente al coste
   de mantenimiento y de riesgo de (4).

## Dictamen

**Nivel 1 (la pregunta núcleo del spike): POSITIVO.** El snapshot nativo de Rapier
2D-compat 0.19.3, en la build fijada por `engine-deps.json`, es bit-exacto (bajo la
cuantización de `stateHash()`) en un round-trip snapshot→restore→continuar, incluso
con contactos activos y con cuerpos dormidos.

**Slice 2 completo: NO SE RECOMIENDA implementar ahora mismo**, no porque no sea
viable técnicamente (el nivel 1 dice que SÍ lo es), sino porque el coste de
integración (1)-(4) — sobre todo el re-mapeo de `PhysicsWorld` y el acoplamiento a la
versión exacta de Rapier de los checkpoints persistidos (4) — no está justificado por
el beneficio (O(1) vs. O(N) en un dominio donde N ya es barato, según demuestra el
propio slice 1 en producción). Si en el futuro N crece lo bastante como para que la
resimulación deje de ser barata (checkpoints a decenas de miles de ticks con overhead
medido), este spike deja la puerta técnica abierta: la premisa que lo bloqueaba
(bit-exactitud) queda demostrada, y el trabajo pendiente es de ingeniería de
integración conocida, no de riesgo de determinismo.

**Slice 2 queda cerrado como spike, sin implementación, hasta que haya presión de
rendimiento real que lo justifique.**
