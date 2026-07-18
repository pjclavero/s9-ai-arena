/**
 * R3.5 · ERR-VIS-05 — Efectos, daño visible y objetivos dibujados.
 *
 * Regla de oro de la Ronda 2: la verificación VISUAL en canvas NO es ejecutable
 * en este entorno (sin navegador). Aquí se prueba la LÓGICA pura, que es lo que
 * el Definition of Done exige que sea testeable:
 *  - mapeo EVENTO→EFECTO (tipo de partícula, vida, cantidad) y su reproducibilidad;
 *  - NO-INTERFERENCIA con la simulación: la capa de efectos sólo LEE sus entradas,
 *    nunca las muta (probado por inmutabilidad/identidad — proxy del "no cambia el
 *    hash de la batalla");
 *  - CORRESPONDENCIA daño-visible ↔ estado público del motor;
 *  - PRESENCIA y ESTADO de los objetivos derivados del overlay público, con la
 *    visibilidad de minas gobernada por permisos de espectador.
 *
 * La parte de "se pinta en el canvas" queda declarada NO EJECUTADA (sin infra).
 */
import { describe, expect, it } from "vitest";
import { EffectSystem, effectProgress, sampleEffect, eventPosition, MAX_LIVE_EFFECTS } from "../src/viewer/effects.js";
import {
  slotKind,
  smokeLevel,
  moduleDisabled,
  damageVisualFor,
  type ModuleState,
} from "../src/viewer/damage-visuals.js";
import { buildObjectivesLayer } from "../src/viewer/objectives-overlay.js";
import { OverlayState, type VehicleOverlay } from "../src/viewer/overlay.js";

/** Congela en profundidad para que CUALQUIER escritura accidental lance en test. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

// ───────────────────────────── efectos: evento → efecto ─────────────────────

describe("EffectSystem: cada evento produce su efecto (mapa evento→partícula)", () => {
  it("un proyectil NUEVO (disparo) genera un fogonazo en su origen", () => {
    const fx = new EffectSystem();
    fx.ingestProjectiles([{ id: "p1", x: 10, y: 20 }], 1000);
    const live = fx.active(1000);
    expect(live.length).toBe(1);
    expect(live[0].kind).toBe("muzzle_flash");
    expect(live[0].x).toBe(10);
    expect(live[0].y).toBe(20);
  });

  it("el mismo proyectil no vuelve a fogonar; uno nuevo sí", () => {
    const fx = new EffectSystem();
    const flashes = (t: number) => fx.active(t).filter((e) => e.kind === "muzzle_flash").length;
    fx.ingestProjectiles([{ id: "p1", x: 0, y: 0 }], 100); // fogonazo 1 (vive 100..190)
    fx.ingestProjectiles([{ id: "p1", x: 5, y: 0 }], 130); // mismo proyectil: NO refogona
    expect(flashes(130)).toBe(1); // sólo el fogonazo 1
    fx.ingestProjectiles([{ id: "p2", x: 9, y: 1 }], 160); // otro proyectil: fogonazo 2
    expect(flashes(160)).toBe(2); // fogonazo 1 (aún vivo) + fogonazo 2
  });

  it("vehicle_destroyed produce EXPLOSIÓN (chispas + humo) y un decal persistente", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "vehicle_destroyed", targetId: "v1", position: { x: 30, y: 40 } }, 500);
    const live = fx.active(500);
    expect(live.some((e) => e.kind === "explosion")).toBe(true);
    expect(live.some((e) => e.kind === "smoke")).toBe(true);
    const decals = fx.drainDecals();
    expect(decals.length).toBe(1);
    expect(decals[0]).toMatchObject({ x: 30, y: 40 });
    // Los decals se drenan una sola vez (los hornea el render): la segunda vez, nada.
    expect(fx.drainDecals().length).toBe(0);
  });

  it("mine_triggered produce explosión + decal en la posición de la mina", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "mine_triggered", position: { x: 7, y: 8 } }, 0);
    expect(fx.active(0).some((e) => e.kind === "explosion")).toBe(true);
    expect(fx.drainDecals()[0]).toMatchObject({ x: 7, y: 8 });
  });

  it("hit_dealt/hit_taken producen chispas de impacto en el objetivo", () => {
    const fx = new EffectSystem();
    const posOf = (id: string) => (id === "v2" ? { x: 1, y: 2 } : undefined);
    fx.ingestEvent({ kind: "hit_dealt", targetId: "v2", damage: 12 }, 300, posOf);
    const live = fx.active(300);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((e) => e.kind === "impact")).toBe(true);
    expect(live[0].x).toBe(1);
    expect(live[0].y).toBe(2);
  });

  it("resuelve la posición del evento por posición propia o por el vehículo", () => {
    expect(eventPosition({ position: { x: 5, y: 6 } })).toEqual({ x: 5, y: 6 });
    expect(eventPosition({ targetId: "v1" }, (id) => (id === "v1" ? { x: 9, y: 9 } : undefined))).toEqual({
      x: 9,
      y: 9,
    });
    expect(eventPosition({ kind: "nada" })).toBeNull();
  });

  it("un evento sin tipo o irrelevante no genera partículas ni decals", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "score_changed", score: { red: 1 } }, 0);
    fx.ingestEvent(null, 0);
    fx.ingestEvent({}, 0);
    expect(fx.active(0).length).toBe(0);
    expect(fx.drainDecals().length).toBe(0);
  });

  it("es DETERMINISTA: el mismo evento produce el mismo efecto (directo = replay)", () => {
    const a = new EffectSystem();
    const b = new EffectSystem();
    const ev = { kind: "vehicle_destroyed", position: { x: 12.5, y: -3.25 } };
    a.ingestEvent(ev, 1000);
    b.ingestEvent(ev, 1000);
    const la = a.active(1000).map((e) => ({ k: e.kind, x: e.x, y: e.y, vx: e.vx, vy: e.vy, life: e.lifeMs }));
    const lb = b.active(1000).map((e) => ({ k: e.kind, x: e.x, y: e.y, vx: e.vx, vy: e.vy, life: e.lifeMs }));
    expect(la).toEqual(lb);
    expect(la.length).toBeGreaterThan(1);
  });
});

// ────────────────── efectos: NO-INTERFERENCIA (proxy del hash) ───────────────

describe("EffectSystem: la capa de efectos NO muta sus entradas (no toca el hash)", () => {
  it("no muta un evento (ni siquiera congelado) y no lanza", () => {
    const fx = new EffectSystem();
    const ev = deepFreeze({ kind: "vehicle_destroyed", targetId: "v1", position: { x: 2, y: 3 } });
    const clone = structuredClone(ev);
    expect(() => fx.ingestEvent(ev, 0, () => ({ x: 2, y: 3 }))).not.toThrow();
    expect(ev).toEqual(clone); // idéntico byte a byte tras procesarlo
  });

  it("no muta los proyectiles observados (snapshot público intacto)", () => {
    const fx = new EffectSystem();
    const dots = deepFreeze([
      { id: "p1", x: 1, y: 1 },
      { id: "p2", x: 2, y: 2 },
    ]);
    const clone = structuredClone(dots);
    expect(() => fx.ingestProjectiles(dots, 0)).not.toThrow();
    expect(dots).toEqual(clone);
  });

  it("integrar efectos junto al overlay no altera el snapshot público de entrada", () => {
    // Simula el camino de PhaserViewer.pushSnapshot/pushEvent con datos congelados:
    // el overlay y los efectos leen el snapshot/evento; ninguno lo escribe.
    const overlay = new OverlayState();
    const fx = new EffectSystem();
    const snapshot = deepFreeze({
      tick: 7,
      score: { red: 1, blue: 0 },
      vehicles: [{ id: "v1", team: "red", alive: true, hullHp: 50, hullHpMax: 100, modules: [] }],
      projectiles: [{ id: "p1", position: { x: 4, y: 4 } }],
      objectives: [{ kind: "flag", team: "red", state: "at_base", position: { x: 1, y: 1 } }],
    });
    const before = structuredClone(snapshot);
    overlay.applySnapshot(snapshot);
    fx.ingestProjectiles([{ id: "p1", x: 4, y: 4 }], 0);
    const ev = deepFreeze({ kind: "vehicle_destroyed", targetId: "v1", position: { x: 4, y: 4 } });
    overlay.applyEvent(ev);
    fx.ingestEvent(ev, 0);
    // El snapshot público de entrada queda EXACTAMENTE como llegó (no-interferencia).
    expect(snapshot).toEqual(before);
  });
});

// ────────────────── efectos: vida, muestreo y techo ──────────────────────────

describe("EffectSystem: ciclo de vida y muestreo de partículas", () => {
  it("purga las partículas expiradas y conserva las vivas", () => {
    const fx = new EffectSystem();
    fx.ingestProjectiles([{ id: "p1", x: 0, y: 0 }], 0); // fogonazo: vida 90 ms
    expect(fx.active(50).length).toBe(1);
    expect(fx.active(200).length).toBe(0); // ya expiró
  });

  it("sampleEffect integra la deriva y desvanece el alfa a 0 al morir", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "mine_triggered", position: { x: 0, y: 0 } }, 0);
    const smoke = fx.active(0).find((e) => e.kind === "smoke")!;
    expect(smoke.vy).toBeLessThan(0); // el humo SUBE (y decrece)
    const born = sampleEffect(smoke, smoke.bornMs);
    const dead = sampleEffect(smoke, smoke.bornMs + smoke.lifeMs);
    expect(born.alpha).toBeGreaterThan(0);
    expect(dead.alpha).toBeCloseTo(0, 5);
    expect(effectProgress(smoke, smoke.bornMs + smoke.lifeMs)).toBe(1);
  });

  it("respeta un TECHO de partículas vivas (una avalancha no crece sin límite)", () => {
    const fx = new EffectSystem();
    for (let i = 0; i < 400; i++) {
      fx.ingestEvent({ kind: "vehicle_destroyed", position: { x: i, y: i } }, 1000);
    }
    expect(fx.active(1000).length).toBeLessThanOrEqual(MAX_LIVE_EFFECTS);
  });

  it("reset limpia partículas, decals y proyectiles conocidos (seek/reconexión)", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "vehicle_destroyed", position: { x: 0, y: 0 } }, 0);
    fx.reset();
    expect(fx.active(0).length).toBe(0);
    expect(fx.drainDecals().length).toBe(0);
    // Tras reset, el mismo id de proyectil vuelve a contar como disparo nuevo.
    fx.ingestProjectiles([{ id: "p1", x: 0, y: 0 }], 0);
    expect(fx.active(0).filter((e) => e.kind === "muzzle_flash").length).toBe(1);
  });

  it("hullSmoke emite MÁS cuanto mayor es el nivel de daño, y nada a nivel 0", () => {
    // Todas las volutas viven 1100 ms: las emitidas en [0,1000] siguen vivas en 1000,
    // así active(1000).length CUENTA las emisiones — a más daño, más humo.
    const emitted = (level: number): number => {
      const fx = new EffectSystem();
      for (let t = 0; t <= 1000; t += 25) fx.hullSmoke("v1", level, 0, 0, t);
      return fx.active(1000).length;
    };
    expect(emitted(0)).toBe(0); // casco sano ⇒ sin humo
    expect(emitted(1.0)).toBeGreaterThan(emitted(0.2)); // más daño ⇒ más humo
    expect(emitted(0.2)).toBeGreaterThan(0);
  });
});

// ────────────────────────── daño visible ↔ estado público ────────────────────

describe("damage-visuals: correspondencia exacta con el estado público", () => {
  it("slotKind clasifica por convención de nombre del catálogo", () => {
    expect(slotKind("turret_main")).toBe("weapon");
    expect(slotKind("drive")).toBe("movement");
    expect(slotKind("armor_front")).toBe("armor");
    expect(slotKind("armor_rear")).toBe("armor");
    expect(slotKind("sensor_a")).toBe("sensor");
    expect(slotKind("power")).toBe("power");
    expect(slotKind("ammo_main")).toBe("ammo");
    expect(slotKind("mine_bay")).toBe("mine");
    expect(slotKind("radio_a")).toBe("radio");
    expect(slotKind("cosa_rara")).toBe("other");
  });

  it("moduleDisabled = destruido u offline", () => {
    expect(moduleDisabled("destroyed")).toBe(true);
    expect(moduleDisabled("offline")).toBe(true);
    expect(moduleDisabled("critical")).toBe(false);
    expect(moduleDisabled("operational")).toBe(false);
  });

  it("destroyedModules son EXACTAMENTE los slots en 'destroyed' (orden estable)", () => {
    const v: VehicleOverlay = {
      id: "v1",
      team: "red",
      alive: true,
      hullHp: 120,
      hullHpMax: 300,
      carryingFlag: null,
      modules: { turret_main: "operational", armor_front: "destroyed", drive: "destroyed", power: "critical" },
    };
    const d = damageVisualFor(v);
    expect(d.destroyedModules).toEqual(["armor_front", "drive"]);
    expect(d.hullRatio).toBeCloseTo(0.4, 5);
  });

  it("torreta BLOQUEADA ⇔ un arma inutilizada; blindaje/ movilidad análogos", () => {
    const base = (modules: Record<string, ModuleState>): VehicleOverlay => ({
      id: "v",
      team: "red",
      alive: true,
      hullHp: 100,
      hullHpMax: 100,
      carryingFlag: null,
      modules,
    });
    expect(damageVisualFor(base({ turret_main: "operational" })).turretLocked).toBe(false);
    expect(damageVisualFor(base({ turret_main: "destroyed" })).turretLocked).toBe(true);
    expect(damageVisualFor(base({ turret_main: "offline" })).turretLocked).toBe(true);
    expect(damageVisualFor(base({ turret_main: "critical" })).turretLocked).toBe(false);
    expect(damageVisualFor(base({ armor_front: "destroyed" })).armorBroken).toBe(true);
    expect(damageVisualFor(base({ drive: "offline" })).mobilityCrippled).toBe(true);
  });

  it("smokeLevel: 0 con casco sano, crece al bajar, monótono NO creciente, 1 si destruido", () => {
    expect(smokeLevel(1)).toBe(0);
    expect(smokeLevel(0.7)).toBe(0); // por encima del umbral (0.6)
    expect(smokeLevel(0)).toBe(1);
    expect(smokeLevel(0.5, true)).toBeGreaterThan(0);
    expect(smokeLevel(0.5)).toBeLessThan(smokeLevel(0.1));
    expect(smokeLevel(0.9, false)).toBe(1); // muerto ⇒ humo máximo
    // Monotonicidad: menos casco nunca da menos humo.
    let prev = -1;
    for (let r = 1; r >= 0; r -= 0.05) {
      const s = smokeLevel(r);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("deriva el daño a partir de un vehículo del SNAPSHOT público real (vía overlay)", () => {
    const overlay = new OverlayState();
    overlay.applySnapshot({
      tick: 1,
      score: {},
      vehicles: [
        {
          id: "v1",
          team: "blue",
          alive: true,
          hullHp: 30,
          hullHpMax: 300,
          modules: [
            { slot: "turret_main", state: "destroyed" },
            { slot: "drive", state: "operational" },
          ],
        },
      ],
    });
    const d = damageVisualFor(overlay.vehicles.get("v1")!);
    expect(d.turretLocked).toBe(true);
    expect(d.destroyedModules).toEqual(["turret_main"]);
    expect(d.smoke).toBeGreaterThan(0); // casco al 10% humea
  });
});

// ─────────────────────────── objetivos dibujados ─────────────────────────────

describe("objectives-overlay: banderas, bases y zonas con su estado", () => {
  it("dibuja banderas CTF en base (posición pública) y llevadas (sobre el portador)", () => {
    const carriers = new Map<string, string>([["blue", "v9"]]);
    const layer = buildObjectivesLayer({
      objectives: [
        { kind: "flag", team: "red", state: "at_base", position: { x: 5, y: 5 } },
        { kind: "flag", team: "blue", state: "carried" }, // sin posición pública
      ],
      carriers,
    });
    expect(layer.flags.length).toBe(2);
    const red = layer.flags.find((f) => f.team === "red")!;
    const blue = layer.flags.find((f) => f.team === "blue")!;
    expect(red.state).toBe("at_base");
    expect(red.at).toEqual({ x: 5, y: 5 });
    expect(blue.state).toBe("carried");
    expect(blue.at).toBeNull(); // la resuelve el render sobre la pose del portador
    expect(blue.carrierId).toBe("v9");
  });

  it("dibuja zonas de captura con posición, dueño y estado", () => {
    const layer = buildObjectivesLayer({
      objectives: [
        { kind: "zone", id: "z1", team: "red", state: "held", position: { x: 10, y: 2 } },
        { kind: "zone", id: "z2", team: "neutral", state: "neutral", position: { x: 20, y: 2 } },
      ],
    });
    expect(layer.zones.map((z) => z.id)).toEqual(["z1", "z2"]);
    expect(layer.zones[0]).toMatchObject({ team: "red", state: "held", at: { x: 10, y: 2 } });
    expect(layer.zones[1]).toMatchObject({ team: "neutral", state: "neutral" });
  });

  it("dibuja bases del mapa con su equipo y radio", () => {
    const layer = buildObjectivesLayer({
      bases: [
        { team: "red", position: { x: 0, y: 0 }, radiusM: 4 },
        { team: "blue", position: { x: 100, y: 80 } },
      ],
    });
    expect(layer.bases.length).toBe(2);
    expect(layer.bases[0]).toMatchObject({ team: "red", at: { x: 0, y: 0 }, radiusM: 4 });
    expect(layer.bases[1].radiusM).toBeGreaterThan(0); // radio por defecto si falta
  });

  it("las MINAS sólo se dibujan con permiso de espectador (spectator.debug)", () => {
    const mines = [{ position: { x: 3, y: 3 }, team: "red" }];
    expect(buildObjectivesLayer({ mines, canSeeMines: false }).mines.length).toBe(0);
    const visible = buildObjectivesLayer({ mines, canSeeMines: true }).mines;
    expect(visible.length).toBe(1);
    expect(visible[0]).toMatchObject({ at: { x: 3, y: 3 }, team: "red" });
  });

  it("el objetivo juggernaut (sin posición pública) no se pinta sobre el mapa", () => {
    const layer = buildObjectivesLayer({
      objectives: [{ kind: "juggernaut", id: "v1", team: "red", state: "held" }],
    });
    expect(layer.flags.length).toBe(0);
    expect(layer.zones.length).toBe(0);
  });

  it("es tolerante a basura (entradas malformadas o ausencia total)", () => {
    const layer = buildObjectivesLayer({
      objectives: [null, 42, { kind: "flag" }, { kind: "zone", id: "z" }] as any,
    });
    expect(layer.flags.length).toBe(0); // flag sin team se descarta
    expect(layer.zones.length).toBe(0); // zona sin posición se descarta
    expect(buildObjectivesLayer({}).bases.length).toBe(0);
  });

  it("se alimenta del overlay público real (objectives + carriers)", () => {
    const overlay = new OverlayState();
    overlay.applySnapshot({
      tick: 1,
      score: {},
      vehicles: [{ id: "v1", team: "red", alive: true, hullHp: 1, hullHpMax: 1, carryingFlag: "blue", modules: [] }],
      objectives: [{ kind: "flag", team: "blue", state: "carried" }],
    });
    overlay.applyEvent({ kind: "flag_taken", team: "blue", sourceId: "v1", tick: 1 });
    const layer = buildObjectivesLayer({ objectives: overlay.objectives, carriers: overlay.carriers });
    const blue = layer.flags.find((f) => f.team === "blue")!;
    expect(blue.state).toBe("carried");
    expect(blue.carrierId).toBe("v1");
  });
});
