/**
 * T8.2 · Lógica pura del visor: interpolación, cámaras, niebla opcional y overlay.
 *
 * El overlay se valida contra el escenario CTF GUIONIZADO REAL de E2 (DoD: "la
 * máquina de estados de bandera se refleja correctamente en el overlay en el
 * escenario CTF guionizado de E2") — no con eventos inventados.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { ctfArena, sandbagLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { FlagRunnerBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { SnapshotInterpolator, lerpAngle } from "../src/viewer/interpolation.js";
import { computeCamera } from "../src/viewer/camera.js";
import { applyFog } from "../src/viewer/fog.js";
import { OverlayState } from "../src/viewer/overlay.js";

beforeAll(async () => {
  await initPhysics();
});

// ------------------------------------------------------------- interpolación
describe("interpolación en cliente (snapshots a 10 Hz → render a 60 fps)", () => {
  it("lerpAngle va por el arco corto", () => {
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0, 10);
    // De 350° a 10° se pasa por 0°, no por 180°.
    const from = (350 * Math.PI) / 180;
    const to = (10 * Math.PI) / 180;
    const mid = lerpAngle(from, to, 0.5);
    expect(Math.cos(mid)).toBeCloseTo(1, 2);
  });

  it("interpola posiciones entre los dos últimos snapshots por tiempo de llegada", () => {
    const itp = new SnapshotInterpolator();
    const snap = (tick: number, x: number) => ({
      tick,
      vehicles: [{ id: "v1", team: "red", alive: true, position: { x, y: 10 }, heading: 0, turretHeading: 0 }],
      projectiles: [],
    });
    itp.push(snap(0, 0), 1000);
    itp.push(snap(3, 6), 1100); // 100 ms después, 6 m más allá
    const mid = itp.sampleAt(1150)!; // mitad del intervalo siguiente
    expect(mid.vehicles.get("v1")!.x).toBeCloseTo(3, 6);
    const end = itp.sampleAt(1250)!;
    expect(end.vehicles.get("v1")!.x).toBeCloseTo(6, 6); // clamp: no extrapola
  });

  it("reset (reconexión) no interpola a través del hueco", () => {
    const itp = new SnapshotInterpolator();
    itp.push(
      {
        tick: 0,
        vehicles: [{ id: "v1", position: { x: 0, y: 0 }, heading: 0, turretHeading: 0, alive: true }],
        projectiles: [],
      },
      0,
    );
    itp.reset(
      {
        tick: 300,
        vehicles: [{ id: "v1", position: { x: 50, y: 0 }, heading: 0, turretHeading: 0, alive: true }],
        projectiles: [],
      },
      10_000,
    );
    expect(itp.sampleAt(10_001)!.vehicles.get("v1")!.x).toBe(50);
  });
});

// ------------------------------------------------------------------- cámara
describe("modos de cámara", () => {
  const snapshot = {
    vehicles: [
      { id: "a", team: "red", alive: true, position: { x: 10, y: 10 } },
      { id: "b", team: "red", alive: true, position: { x: 30, y: 20 } },
      { id: "c", team: "blue", alive: true, position: { x: 100, y: 70 } },
    ],
  };
  const cfg = { viewportW: 960, viewportH: 640, mapW: 120, mapH: 80 };

  it("global encuadra el mapa entero", () => {
    const c = computeCamera({ kind: "global" }, snapshot, cfg);
    expect(c.centerX).toBe(60);
    expect(c.centerY).toBe(40);
    expect(c.zoom * (cfg.mapW + 8)).toBeLessThanOrEqual(960 + 1e-9);
  });

  it("follow centra en el bot y cae a global si el bot no existe", () => {
    const c = computeCamera({ kind: "follow", vehicleId: "c" }, snapshot, cfg);
    expect(c.centerX).toBe(100);
    expect(c.centerY).toBe(70);
    const fallback = computeCamera({ kind: "follow", vehicleId: "muerto" }, snapshot, cfg);
    expect(fallback.centerX).toBe(60);
  });

  it("team encuadra a todos los vivos del equipo", () => {
    const c = computeCamera({ kind: "team", team: "red" }, snapshot, cfg);
    expect(c.centerX).toBeCloseTo(20, 6);
    expect(c.centerY).toBeCloseTo(15, 6);
  });
});

// ----------------------------------------------------------------- niebla
describe("niebla de guerra opcional del espectador (gating por ruleset)", () => {
  const snapshot = {
    tick: 100,
    score: { red: 1, blue: 0 },
    vehicles: [
      { id: "r1", team: "red", alive: true, position: { x: 10, y: 10 } },
      { id: "b_cerca", team: "blue", alive: true, position: { x: 20, y: 10 } },
      { id: "b_lejos", team: "blue", alive: true, position: { x: 110, y: 70 } },
    ],
    projectiles: [
      { id: "p_cerca", position: { x: 15, y: 10 } },
      { id: "p_lejos", position: { x: 100, y: 60 } },
    ],
  };

  it("si el ruleset NO lo permite, el snapshot pasa intacto aunque el usuario lo pida", () => {
    const out = applyFog(snapshot, { allowFogView: false, enabled: true, team: "red" });
    expect(out).toBe(snapshot);
  });

  it("activada: se ven los propios y lo que cae en el radio; el marcador nunca se oculta", () => {
    const out = applyFog(snapshot, { allowFogView: true, enabled: true, team: "red", visionRadiusM: 50 });
    const ids = out.vehicles.map((v: any) => v.id);
    expect(ids).toContain("r1");
    expect(ids).toContain("b_cerca");
    expect(ids).not.toContain("b_lejos");
    expect(out.projectiles.map((p: any) => p.id)).toEqual(["p_cerca"]);
    expect(out.score).toEqual({ red: 1, blue: 0 });
  });
});

// -------------------------------------------- overlay con el CTF real de E2
describe("overlay: FSM de bandera con el escenario CTF guionizado de E2", () => {
  let replay: Replay;

  beforeAll(async () => {
    // Mismo guion que modes.test.ts de E2: corredor rojo roba la bandera azul.
    const map = ctfArena();
    const blueFlag = map.flags.find((f) => f.team === "blue")!.position;
    const redBase = map.bases.find((b2) => b2.team === "red")!.position;
    replay = await record(
      {
        battleId: "ctf_overlay",
        seed: "ctf-overlay",
        ruleset: loadRuleset("ctf_mvp@1", { scoreToWin: 1 }),
        map,
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
        ],
      },
      (b) => {
        b.attachBot("veh_1", new FlagRunnerBot("b1", blueFlag, redBase));
        b.attachBot("veh_2", new IdleBot("b2"));
      },
    );
    expect(replay.result.winner).toBe("red");
  }, 120000);

  it("refleja taken → captured y el marcador final coincide con el resultado oficial", () => {
    const overlay = new OverlayState();
    const flagStates: string[] = [];

    // Reproducir el stream como lo haría el visor: snapshots y eventos en orden de tick.
    const applyEvent = (e: any) => {
      overlay.applyEvent(e);
      if (e.kind?.startsWith("flag_")) flagStates.push(`${e.kind}:${overlay.flags.get("blue")}`);
    };
    let evIdx = 0;
    const events = [...replay.events].sort((a, b) => a.tick - b.tick);
    for (const snap of replay.snapshots) {
      while (evIdx < events.length && events[evIdx].tick <= snap.tick) applyEvent(events[evIdx++]);
      overlay.applySnapshot(snap);
    }
    // Los eventos del tick final (la captura que TERMINA la batalla) llegan tras el último snapshot.
    while (evIdx < events.length) applyEvent(events[evIdx++]);

    expect(flagStates).toContain("flag_taken:carried");
    expect(flagStates).toContain("flag_captured:at_base");
    // flag_taken ocurre ANTES de flag_captured (orden de la FSM de E2).
    expect(flagStates.findIndex((s) => s.startsWith("flag_taken"))).toBeLessThan(
      flagStates.findIndex((s) => s.startsWith("flag_captured")),
    );
    expect(overlay.score).toEqual(replay.result.score);
    expect(overlay.feed.some((f) => f.kind === "flag_captured")).toBe(true);

    // Salud y módulos del overlay salen del último snapshot.
    const veh = overlay.vehicles.get("veh_1")!;
    expect(veh.hullHpMax).toBeGreaterThan(0);
    expect(Object.keys(veh.modules).length).toBeGreaterThan(0);
  });
});
