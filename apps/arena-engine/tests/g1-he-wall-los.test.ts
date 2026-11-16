/**
 * OLA 2 · G1.5 · Gate HE_WALL_EXPLOSION_LOS: la onda de un proyectil HE que impacta
 * contra un MURO (o destructible) daña a quien la cara del muro deja ver, y sólo a él.
 *
 * Defecto (P2 de la integración OLA 2): el punto de impacto P se calcula con el tiempo de
 * impacto de Rapier (f32) y cae a ±1e-5 m de la cara, muchas veces DENTRO del muro. La
 * línea de visión de la onda, `hasLineOfSight(P, víctima)`, lanzaba un rayo sólido que
 * nace dentro del collider y lo «golpea» a distancia 0: el propio muro tapaba la onda y
 * las víctimas a la vista no recibían daño.
 *
 * Arreglo (physics.ts `hasLineOfSightFromSurface`, con la demostración en su comentario):
 * los sólidos cuya frontera pasa por P se deciden por el semiplano de su cara (hiperplano
 * soporte de un convexo), sin alejar P ni usar un épsilon; el resto, con el rayo de
 * siempre. Casos de este fichero:
 *   F  física (sin batalla): impacto JUSTO en la cara, P empujado dentro por el redondeo,
 *      P ligeramente separado (espacio libre), muros coplanarios y muro girado;
 *   B  batalla real (proyectil HE del catálogo, puerta única de daño):
 *      víctima visible · parcialmente oculta · totalmente oculta (por el propio muro y por
 *      otro obstáculo) · perímetro implícito coplanario con el muro de borde del mapa ·
 *      el `hit_taken` de la onda revela el origen a quien la ve.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { PhysicsWorld, initPhysics, type ImpactSurface, type Vec2 } from "../src/sim/physics.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";
import { emptyArena, sandbagLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const CATALOG = loadCatalog();

// ------------------------------------------------------------------ F · geometría pura

/** Muro de prueba: cuboide de x ∈ [60, 62], y ∈ [28, 52]; su cara oeste es x = 60. */
function worldWithWall(): PhysicsWorld {
  const w = new PhysicsWorld();
  w.addWall("wall_x", { x: 61, y: 40 }, 1, 12);
  return w;
}

/** Superficie del impacto de un rayo que viene del oeste hacia (60, y). */
function shoot(w: PhysicsWorld, y: number): { surface: ImpactSurface; P: Vec2 } {
  const from = { x: 20, y };
  const hit = w.castRay(from, 0, 80);
  expect(hit?.entityId).toBe("wall_x");
  const surface = w.impactSurface(from, 0, 80, "wall_x", hit!.point)!;
  return { surface, P: hit!.point };
}

describe("HE_WALL_EXPLOSION_LOS · F · geometría de la cara", () => {
  it("la normal de la cara golpeada es la exterior (-1, 0)", () => {
    const w = worldWithWall();
    const { surface } = shoot(w, 40);
    expect(surface.normal.x).toBeCloseTo(-1, 6);
    expect(surface.normal.y).toBeCloseTo(0, 6);
    w.free();
  });

  it("impacto JUSTO en el borde (P exacto sobre la cara): visible sí, detrás del muro no", () => {
    const w = worldWithWall();
    const surface: ImpactSurface = { point: { x: 60, y: 40 }, entityId: "wall_x", normal: { x: -1, y: 0 } };
    expect(w.hasLineOfSightFromSurface(surface, { x: 57.5, y: 43 })).toBe(true);
    expect(w.hasLineOfSightFromSurface(surface, { x: 55, y: 40 })).toBe(true);
    expect(w.hasLineOfSightFromSurface(surface, { x: 64.5, y: 40 })).toBe(false);
    w.free();
  });

  it("P DENTRO del muro por el redondeo: el rayo de siempre decía «tapado»; la cara no", () => {
    const w = worldWithWall();
    // El caso real: f32 deja P 1e-5 m dentro de la cara.
    const P = { x: 60 + 1e-5, y: 40 };
    const surface: ImpactSurface = { point: P, entityId: "wall_x", normal: { x: -1, y: 0 } };
    const V = { x: 57.5, y: 43 };
    // Caracterización del defecto: el rayo sólido nace dentro del collider.
    expect(w.hasLineOfSight(P, V)).toBe(false);
    expect(w.hasLineOfSightFromSurface(surface, V)).toBe(true);
    expect(w.hasLineOfSightFromSurface(surface, { x: 64.5, y: 40 })).toBe(false);
    w.free();
  });

  it("P del impacto REAL de un rayo: mismo veredicto que con P exacto, en 41 alturas de la cara", () => {
    const w = worldWithWall();
    for (let i = 0; i <= 40; i++) {
      const y = 30 + i * 0.5 + i * 1e-3; // alturas no redondas: P sale con ruido f32
      const { surface, P } = shoot(w, y);
      const exact: ImpactSurface = { point: { x: 60, y: P.y }, entityId: "wall_x", normal: { x: -1, y: 0 } };
      for (const V of [
        { x: P.x - 3, y: P.y + 2 },
        { x: P.x - 4, y: P.y - 1 },
        { x: P.x + 4.5, y: P.y },
      ]) {
        expect(w.hasLineOfSightFromSurface(surface, V), `y=${y} V=${V.x},${V.y}`).toBe(
          w.hasLineOfSightFromSurface(exact, V),
        );
      }
    }
    w.free();
  });

  it("impacto LIGERAMENTE SEPARADO (P en espacio libre): coincide con la línea de visión de siempre", () => {
    const w = worldWithWall();
    const P = { x: 59.99, y: 40 };
    const surface: ImpactSurface = { point: P, entityId: "wall_x", normal: { x: -1, y: 0 } };
    for (const V of [
      { x: 57.5, y: 43 },
      { x: 56, y: 36 },
      { x: 64.5, y: 40 },
      { x: 63, y: 45 },
    ]) {
      expect(w.hasLineOfSightFromSurface(surface, V), `V=${V.x},${V.y}`).toBe(w.hasLineOfSight(P, V));
    }
    expect(w.hasLineOfSight(P, { x: 57.5, y: 43 })).toBe(true);
    expect(w.hasLineOfSight(P, { x: 64.5, y: 40 })).toBe(false);
    w.free();
  });

  it("otro obstáculo entre P y la víctima SIGUE tapando (sólo se decide por cara el sólido que toca P)", () => {
    const w = worldWithWall();
    w.addWall("pillar", { x: 59.5, y: 39.125 }, 0.2, 0.2);
    const surface: ImpactSurface = { point: { x: 60 + 1e-5, y: 40 }, entityId: "wall_x", normal: { x: -1, y: 0 } };
    expect(w.hasLineOfSightFromSurface(surface, { x: 58, y: 36.5 })).toBe(false);
    expect(w.hasLineOfSightFromSurface(surface, { x: 57.5, y: 43 })).toBe(true);
    w.free();
  });

  it("muros COPLANARIOS (borde del mapa + perímetro implícito): ninguno de los dos tapa hacia dentro", () => {
    const w = new PhysicsWorld();
    // Dos cuboides con la misma cara x = 120 (como emptyArena + addArenaBoundary).
    w.addWall("wall_e", { x: 120.5, y: 40 }, 0.5, 41);
    w.addWall("boundary_e", { x: 125, y: 40 }, 5, 40);
    const from = { x: 80, y: 40.3 };
    const hit = w.castRay(from, 0, 60)!;
    const surface = w.impactSurface(from, 0, 60, hit.entityId!, hit.point)!;
    const P = { x: 120 + 1e-5, y: 40.3 };
    const inside: ImpactSurface = { point: P, entityId: "wall_e", normal: { x: -1, y: 0 } };
    expect(w.hasLineOfSight(P, { x: 117.5, y: 42.5 })).toBe(false); // el defecto
    expect(w.hasLineOfSightFromSurface(inside, { x: 117.5, y: 42.5 })).toBe(true);
    expect(w.hasLineOfSightFromSurface(surface, { x: 117.5, y: 42.5 })).toBe(true);
    expect(w.hasLineOfSightFromSurface(inside, { x: 123, y: 40 })).toBe(false);
    w.free();
  });

  it("muro GIRADO: la normal es la de la cara girada y el semiplano se respeta", () => {
    const w = new PhysicsWorld();
    const th = Math.PI / 6;
    w.addWall("rot", { x: 60, y: 40 }, 1, 10, th);
    const from = { x: 20, y: 40 };
    const hit = w.castRay(from, 0, 80)!;
    const s = w.impactSurface(from, 0, 80, "rot", hit.point)!;
    // Cara local -x girada 30°: n = (-cos30, -sin30).
    expect(s.normal.x).toBeCloseTo(-Math.cos(th), 5);
    expect(s.normal.y).toBeCloseTo(-Math.sin(th), 5);
    const P = hit.point;
    expect(w.hasLineOfSightFromSurface(s, { x: P.x - 3 * Math.cos(th), y: P.y - 3 * Math.sin(th) })).toBe(true);
    expect(w.hasLineOfSightFromSurface(s, { x: P.x + 3 * Math.cos(th), y: P.y + 3 * Math.sin(th) })).toBe(false);
    w.free();
  });
});

// ------------------------------------------------------------------ B · batalla real

/** Artillero con munición HE del catálogo y SIN dispersión (P determinista en la cara). */
function heGunnerNoSpread(): VehicleSpec {
  const spec = resolveVehicle(
    {
      ...ARCHETYPES.gunner,
      modules: ARCHETYPES.gunner.modules.map((m) => (m.slot === "turret_main" ? { ...m, ammo: "ammo.he@1" } : m)),
    },
    CATALOG,
  );
  return { ...spec, modules: spec.modules.map((m) => (m.slot === "turret_main" ? { ...m, spreadRad: 0 } : m)) };
}

/**
 * Apunta a `aim` desplazado en vertical por una secuencia fija de ±5 cm: cada impacto cae
 * en una altura distinta de la cara y el redondeo f32 deja P a veces dentro y a veces fuera
 * del muro (el caso del defecto), sin salir de la geometría del escenario.
 */
// 7 valores (primo con los 10 ciclos de decisión de la cadencia del cañón): cada disparo, otra altura.
const AIM_JITTER_M = [0, 0.0137, -0.0291, 0.0418, -0.0053, 0.0329, -0.0461];
class AimFireBot implements BotAgent {
  private d = 0;
  constructor(
    readonly botId: string,
    private target: Vec2,
  ) {}
  decide(obs: any) {
    const j = AIM_JITTER_M[this.d++ % AIM_JITTER_M.length]!;
    return {
      forTick: obs.tick,
      turret: { targetPoint: { x: this.target.x, y: this.target.y + j } },
      fire: ["turret_main"],
    };
  }
}
class RecordingBot extends IdleBot {
  events: any[] = [];
  onEvent(e: any) {
    this.events.push(e);
  }
}

interface Outcome {
  wallImpacts: number;
  splash: Map<string, number>;
  events: Map<string, any[]>;
}

/** Batalla: el artillero dispara HE contra `aim` (un muro); las víctimas no se mueven. */
function run(
  shooterAt: Vec2,
  aim: Vec2,
  victims: Record<string, Vec2>,
  extraWalls: { id: string; position: Vec2; halfW: number; halfH: number }[],
): Outcome {
  const map = emptyArena();
  map.walls.push(...extraWalls);
  const ids = Object.keys(victims);
  map.spawns = [
    { team: "red", position: shooterAt, heading: 0 },
    ...ids.map((k) => ({ team: "blue", position: victims[k]!, heading: Math.PI })),
  ];
  const b = new Battle({
    battleId: "g1_he_wall",
    seed: "g1-he-wall",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 400, respawn: { enabled: false, delayTicks: 0 } }),
    map,
    participants: [
      { id: "veh_0", botId: "b0", team: "red", spec: heGunnerNoSpread() },
      ...ids.map((k, i) => ({ id: `veh_${i + 1}`, botId: k, team: "blue", spec: sandbagLoadout() })),
    ],
  });
  b.attachBot("veh_0", new AimFireBot("b0", aim));
  const bots = ids.map((k, i) => {
    const bot = new RecordingBot(k);
    b.attachBot(`veh_${i + 1}`, bot);
    return bot;
  });
  const splash = new Map(ids.map((k) => [k, 0]));
  let wallImpacts = 0;
  for (let t = 0; t < 400 && !b.isFinished(); t++) {
    const before = b.getInternalFrame().projectiles.length;
    b.step();
    if (b.getInternalFrame().projectiles.length < before) wallImpacts++;
    for (const r of b.damageRecordsOfLastTick()) {
      const i = Number(r.target.replace("veh_", "")) - 1;
      if (i < 0) continue;
      expect(r.sourceKind, `${ids[i]} sólo puede recibir la onda`).toBe("explosion");
      splash.set(ids[i]!, splash.get(ids[i]!)! + 1);
    }
  }
  // Ninguna víctima se ha movido (el defecto no puede esconderse en la física).
  for (const [i, k] of ids.entries()) {
    const p = b.getPhysics().pose(`veh_${i + 1}`)!.position;
    expect(Math.hypot(p.x - victims[k]!.x, p.y - victims[k]!.y), `${k} se movió`).toBeLessThan(0.05);
  }
  const events = new Map(ids.map((k, i) => [k, bots[i]!.events]));
  b.free();
  return { wallImpacts, splash, events };
}

// Muro interior: x ∈ [60, 62], y ∈ [28, 52]. El artillero en (20, 40) dispara a (60, 40).
const WALL = { id: "wall_x", position: { x: 61, y: 40 }, halfW: 1, halfH: 12 };
// Obstáculo pequeño que corta P → (58, 36.5) (a t = 0,25 del segmento) sin tocar la trayectoria.
const PILLAR = { id: "pillar", position: { x: 59.5, y: 39.125 }, halfW: 0.2, halfH: 0.2 };
// Obstáculo que tapa PARTE del disco de la víctima (57.5, 43) pero no la línea a su centro.
const SHADE = { id: "shade", position: { x: 59.09, y: 41.79 }, halfW: 0.2, halfH: 0.2 };
/** Radio del chasis del saco de arena (chassis.light@1). */
const SANDBAG_RADIUS_M = 1.2;

describe("HE_WALL_EXPLOSION_LOS · B · onda de un HE contra un muro, en batalla", () => {
  let out: Outcome;
  beforeAll(() => {
    out = run(
      { x: 20, y: 40 },
      { x: 60, y: 40 },
      {
        visible: { x: 57.5, y: 43 },
        behindWall: { x: 64.5, y: 40 },
        hiddenByPillar: { x: 58, y: 36.5 },
      },
      [WALL, PILLAR],
    );
  });

  it("hay impactos contra el muro (el escenario ejerce el caso)", () => {
    expect(out.wallImpacts).toBeGreaterThan(3);
  });

  it("víctima VISIBLE desde el punto de explosión: recibe la onda en cada impacto", () => {
    expect(out.splash.get("visible")).toBe(out.wallImpacts);
  });

  it("víctima TOTALMENTE oculta por el propio muro (detrás de la cara golpeada): nada", () => {
    expect(out.splash.get("behindWall")).toBe(0);
  });

  it("víctima TOTALMENTE oculta por otro obstáculo entre P y ella: nada (y sin el obstáculo, sí)", () => {
    expect(out.splash.get("hiddenByPillar")).toBe(0);
    const control = run({ x: 20, y: 40 }, { x: 60, y: 40 }, { hiddenByPillar: { x: 58, y: 36.5 } }, [WALL]);
    expect(control.splash.get("hiddenByPillar")).toBe(control.wallImpacts);
  });

  it("el hit_taken de la onda revela el origen a quien la ve (misma geometría de cara)", () => {
    const hits = out.events.get("visible")!.filter((e) => e.kind === "hit_taken");
    // Los eventos privados se entregan en el siguiente tick de decisión: el del último
    // impacto puede quedar sin entregar al cortar la batalla.
    expect(hits.length).toBeGreaterThanOrEqual(out.wallImpacts - 1);
    expect(hits.length).toBeLessThanOrEqual(out.wallImpacts);
    for (const h of hits) expect(h.sourceId).toBe("veh_0");
  });
});

describe("HE_WALL_EXPLOSION_LOS · B · víctima PARCIALMENTE oculta", () => {
  it("con la línea a su centro libre, recibe la onda (modelo de visión al centro del vehículo)", () => {
    // Comprobación del escenario: SHADE corta la línea a un punto del borde del disco.
    const w = worldWithWall();
    w.addWall("shade", SHADE.position, SHADE.halfW, SHADE.halfH);
    const near = { x: 59.99, y: 40 };
    const center = { x: 57.5, y: 43 };
    expect(w.hasLineOfSight(near, center)).toBe(true);
    // Punto del disco de la víctima en la recta que pasa por el centro de SHADE.
    const dir = { x: SHADE.position.x - near.x, y: SHADE.position.y - near.y };
    const len = Math.hypot(dir.x, dir.y);
    const u = { x: dir.x / len, y: dir.y / len };
    const k = (center.x - near.x) * u.x + (center.y - near.y) * u.y;
    const rim = { x: near.x + k * u.x, y: near.y + k * u.y };
    expect(Math.hypot(rim.x - center.x, rim.y - center.y)).toBeLessThan(SANDBAG_RADIUS_M);
    expect(w.hasLineOfSight(near, rim)).toBe(false);
    w.free();
    const out = run({ x: 20, y: 40 }, { x: 60, y: 40 }, { partial: { x: 57.5, y: 43 } }, [WALL, SHADE]);
    expect(out.wallImpacts).toBeGreaterThan(3);
    expect(out.splash.get("partial")).toBe(out.wallImpacts);
  });
});

describe("HE_WALL_EXPLOSION_LOS · B · muro de borde del mapa (coplanario con el perímetro implícito)", () => {
  it("la víctima junto al borde este recibe la onda de los impactos en él", () => {
    const out = run({ x: 80, y: 40 }, { x: 120, y: 40 }, { nearBorder: { x: 117.5, y: 42.5 } }, []);
    expect(out.wallImpacts).toBeGreaterThan(3);
    expect(out.splash.get("nearBorder")).toBe(out.wallImpacts);
  });
});
