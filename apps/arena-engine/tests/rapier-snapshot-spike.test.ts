/**
 * SPIKE N3 · docs/R13_5_SLICE2_SPIKE.md
 *
 * Pregunta núcleo: si en el tick N tomamos `world.takeSnapshot()` y luego, en un
 * `World` NUEVO, hacemos `World.restoreSnapshot(bytes)` y seguimos simulando M
 * ticks más, ¿el estado resultante es BIT A BIT idéntico al de haber seguido
 * simulando M ticks en el world original? Esa es la única pregunta que importa
 * para decidir si un "checkpoint slice 2" (snapshot nativo de Rapier) podría
 * sustituir al checkpoint por resimulación (slice 1, `checkpoint.ts`).
 *
 * Esto es un experimento AISLADO de Rapier: no usa `Battle` ni `PhysicsWorld`
 * (cuyo `world` es privado). Replica la configuración real de cuerpos de
 * `physics.ts` (damping, restitución, fricción, timestep fijo, gravedad nula)
 * para que el resultado sea representativo del motor real, sin tocarlo.
 *
 * Método: mismo criterio de cuantización que `stateHash()` (`q()` en
 * `battle.ts`, redondeo a 1e-5) más el "solver fingerprint" ya existente en
 * `physics.ts::solverFingerprint()` (cuerpos despiertos + pares de contacto),
 * porque las poses cuantizadas por sí solas pueden coincidir mientras el
 * estado interno del solver (islas de sueño, warm-starting de contactos) ya
 * ha divergido — ese es justamente el fallo que ERR-ENG-04 saca a la luz.
 *
 * Si el resultado es "NO bit-exacto", este test lo ASERTA como hallazgo (no
 * queda rojo): la divergencia observada queda documentada en la aserción
 * misma, no oculta.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import { TICK_DT } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../src/sim/physics.js";

beforeAll(async () => {
  await initPhysics();
});

/** Mismo criterio de cuantización que `stateHash()` (battle.ts::q()). */
function q(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

interface BodySpec {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angvel: number;
}

/** Construye un world con la MISMA configuración física que PhysicsWorld (physics.ts). */
function buildWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: 0 });
  world.timestep = TICK_DT;
  return world;
}

function addVehicleLike(world: RAPIER.World, spec: BodySpec): RAPIER.RigidBody {
  const rbDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spec.x, spec.y)
    .setRotation(0)
    .setLinearDamping(0.8)
    .setAngularDamping(4.0)
    .setCcdEnabled(true)
    .setLinvel(spec.vx, spec.vy)
    .setAngvel(spec.angvel);
  const rb = world.createRigidBody(rbDesc);
  const colDesc = RAPIER.ColliderDesc.ball(0.9).setDensity(0).setMass(180).setRestitution(0.2).setFriction(0.5);
  world.createCollider(colDesc, rb);
  return rb;
}

function addWall(world: RAPIER.World, x: number, y: number): void {
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 6), rb);
}

/**
 * Escenario: 4 vehículos dinámicos convergiendo hacia el centro (garantiza
 * contactos activos), un muro fijo, y un quinto cuerpo en reposo total desde
 * el tick 0 (candidato a dormirse: Rapier duerme cuerpos con velocidad por
 * debajo del umbral tras varios steps consecutivos).
 */
function buildScenario(): { world: RAPIER.World; ids: string[]; handles: Map<string, number> } {
  const world = buildWorld();
  const handles = new Map<string, number>();
  const specs: BodySpec[] = [
    // Distancia y velocidad calibradas (probe.mjs) para que efectivamente SE TOQUEN
    // hacia el step 10-17 (contactPairs pasa de 0 a >0 y vuelve a 0): el punto más
    // interesante para el round-trip es tomar el snapshot EN PLENO CONTACTO, no
    // antes ni después.
    { id: "v-north", x: 0, y: -3, vx: 0, vy: 4, angvel: 0.4 },
    { id: "v-south", x: 0, y: 3, vx: 0, vy: -4, angvel: -0.3 },
    { id: "v-east", x: 3, y: 0, vx: -4, vy: 0, angvel: 0.2 },
    { id: "v-west", x: -3, y: 0, vx: 4, vy: 0, angvel: -0.5 },
    { id: "v-resting", x: 15, y: 15, vx: 0, vy: 0, angvel: 0 },
  ];
  for (const spec of specs) {
    const rb = addVehicleLike(world, spec);
    handles.set(spec.id, rb.handle);
  }
  // El muro se coloca lejos del punto de convergencia (origen): con las distancias
  // reducidas de los vehículos, un muro en el origen los interpenetraría desde
  // t=0 (contacto artificial, no representativo). Lo dejamos como elemento fijo
  // del world (representativo de un muro de arena) sin interferir con el choque
  // vehículo-vehículo que es lo que este experimento quiere ejercitar.
  addWall(world, 0, 20);
  return { world, ids: specs.map((s) => s.id), handles };
}

interface SolverFingerprint {
  awakeBodies: number;
  contactPairs: number;
}

/** Réplica exacta del criterio de physics.ts::solverFingerprint(), sobre un world "pelado". */
function solverFingerprint(world: RAPIER.World, handles: Map<string, number>): SolverFingerprint {
  let awakeBodies = 0;
  let contactPairs = 0;
  for (const handle of handles.values()) {
    const rb = world.getRigidBody(handle);
    if (rb.isDynamic() && !rb.isSleeping()) awakeBodies++;
  }
  // Pares de contacto: recorremos colliders vía cada cuerpo (mismo criterio que
  // PhysicsWorld: contactPairsWith por collider, contar cada par una sola vez).
  for (const handle of handles.values()) {
    const rb = world.getRigidBody(handle);
    const collider = rb.collider(0);
    if (!collider) continue;
    world.contactPairsWith(collider, (other) => {
      if (other.handle > collider.handle) contactPairs++;
    });
  }
  return { awakeBodies, contactPairs };
}

interface BodyState {
  id: string;
  pos: [number, number];
  rot: number;
  vel: [number, number];
  angvel: number;
  sleeping: boolean;
}

function captureState(world: RAPIER.World, handles: Map<string, number>): BodyState[] {
  return [...handles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, handle]) => {
      const rb = world.getRigidBody(handle);
      const t = rb.translation();
      const v = rb.linvel();
      return {
        id,
        pos: [q(t.x), q(t.y)],
        rot: q(rb.rotation()),
        vel: [q(v.x), q(v.y)],
        angvel: q(rb.angvel()),
        sleeping: rb.isSleeping(),
      };
    });
}

/**
 * Corre el experimento completo para un (N, M) dado.
 * Devuelve el estado cuantizado tras N+M steps por dos caminos:
 *  A) world continuo;
 *  B) snapshot en N → world nuevo → restore → M steps más.
 */
function runRoundTrip(nSteps: number, mSteps: number) {
  const { world: worldA, handles: handlesA } = buildScenario();
  for (let i = 0; i < nSteps; i++) worldA.step();

  // Snapshot en el tick N, ANTES de que A siga a N+M.
  const snapshot = worldA.takeSnapshot();
  const fingerprintAtN = solverFingerprint(worldA, handlesA);

  // Camino A: sigue en el mismo world.
  for (let i = 0; i < mSteps; i++) worldA.step();
  const stateA = captureState(worldA, handlesA);
  const fingerprintA = solverFingerprint(worldA, handlesA);

  // Camino B: world NUEVO restaurado desde el snapshot tomado en N.
  const worldB = RAPIER.World.restoreSnapshot(snapshot);
  // Los handles de cuerpo son estables (arena índice+generación): reusamos los
  // mismos handles capturados en worldA para leer worldB. Verificado abajo con
  // una aserción explícita de que el número de cuerpos coincide.
  const handlesB = handlesA;
  expect(countBodies(worldB)).toBe(countBodies(worldA));
  for (let i = 0; i < mSteps; i++) worldB.step();
  const stateB = captureState(worldB, handlesB);
  const fingerprintB = solverFingerprint(worldB, handlesB);

  worldA.free();
  worldB.free();

  return { stateA, stateB, fingerprintA, fingerprintB, fingerprintAtN };
}

function countBodies(world: RAPIER.World): number {
  let n = 0;
  world.forEachRigidBody(() => n++);
  return n;
}

describe("SPIKE N3 · snapshot nativo de Rapier vs. resimulación (docs/R13_5_SLICE2_SPIKE.md)", () => {
  it("nivel 1 · round-trip N=13,M=60 (snapshot EN PLENO CONTACTO): compara A (continuo) vs B (snapshot+restore) tras cuantizar como stateHash()", () => {
    // N=13 se eligió tras sondear el escenario (ver docs/R13_5_SLICE2_SPIKE.md): es
    // el tramo en que contactPairs > 0 (colisión vehículo-vehículo activa), el caso
    // más exigente para el snapshot nativo — es precisamente donde vive el estado
    // interno del solver (manifolds de contacto, impulsos acumulados) que NO está
    // en el hash de estado pero SÍ puede afectar a los steps siguientes.
    const { stateA, stateB, fingerprintA, fingerprintB, fingerprintAtN } = runRoundTrip(13, 60);

    // Constancia del hallazgo, se cumpla o no: quede constancia real de los números,
    // no solo de un booleano. (Ver docs/R13_5_SLICE2_SPIKE.md para el reporte completo.)
    // eslint-disable-next-line no-console
    console.log("[SPIKE N3] fingerprint en N:", fingerprintAtN);
    // eslint-disable-next-line no-console
    console.log("[SPIKE N3] estado A tras N+M:", JSON.stringify(stateA));
    // eslint-disable-next-line no-console
    console.log("[SPIKE N3] estado B tras N+M:", JSON.stringify(stateB));

    const identical = JSON.stringify(stateA) === JSON.stringify(stateB);
    const fingerprintIdentical = JSON.stringify(fingerprintA) === JSON.stringify(fingerprintB);

    // DICTAMEN DEL SPIKE: ver docs/R13_5_SLICE2_SPIKE.md. Esta aserción codifica el
    // resultado EMPÍRICO observado, sea cual sea — no una expectativa a priori. Si
    // Rapier deja de ser bit-exacto tras un round-trip de snapshot en una versión
    // futura del paquete, este test debe ponerse en rojo (señal real de regresión
    // del hallazgo), no seguir en verde con un resultado obsoleto.
    expect({ identical, fingerprintIdentical }).toEqual({ identical: true, fingerprintIdentical: true });
  });

  it("nivel 1 · varios N (incluye cuerpos dormidos): el resultado es consistente en todos los puntos de corte", () => {
    // N pequeño (contactos aún activándose), N grande (cuerpo v-resting ya debería
    // haberse dormido: Rapier duerme tras varios steps consecutivos por debajo del
    // umbral de velocidad angular/lineal).
    const cases = [
      { n: 1, m: 5 }, // arranque, sin contactos aún
      { n: 13, m: 1 }, // snapshot en pleno contacto vehículo-vehículo, M mínimo
      { n: 17, m: 45 }, // snapshot justo al final de la ventana de contacto observada
      { n: 200, m: 30 }, // suficientes steps para que v-resting se duerma antes del snapshot
    ];
    for (const { n, m } of cases) {
      const { stateA, stateB, fingerprintA, fingerprintB } = runRoundTrip(n, m);
      const identical = JSON.stringify(stateA) === JSON.stringify(stateB);
      const fingerprintIdentical = JSON.stringify(fingerprintA) === JSON.stringify(fingerprintB);
      expect({ n, m, identical, fingerprintIdentical }).toEqual({ n, m, identical: true, fingerprintIdentical: true });
    }
  });

  it("nivel 1 · v-resting se duerme antes de N=200 (confirma que el escenario ejercita islas de sueño)", () => {
    const { world, handles } = buildScenario();
    for (let i = 0; i < 200; i++) world.step();
    const rb = world.getRigidBody(handles.get("v-resting")!);
    expect(rb.isSleeping()).toBe(true);
    world.free();
  });
});
