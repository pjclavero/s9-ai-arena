/**
 * R3.1 · ERR-VIS-01 — El replay interpola como el directo.
 *
 * Prueba el RELOJ DE REPRODUCCIÓN y el cableado ReplayPlayer→escena sin Phaser ni
 * navegador (la capa de render es tonta a propósito): la escena falsa usa el
 * SnapshotInterpolator REAL, así que lo que se afirma aquí es exactamente lo que
 * la ruta compartida de interpolación pintaría a 60 fps.
 *
 * DoD cubierto:
 * - pushSnapshot por snapshot nuevo (fechado en ms de partida) y resetTo SOLO
 *   al arrancar y tras seek — nunca por frame.
 * - El muestreo entre snapshots es continuo (sin los 10 saltos/s del bug).
 * - Un seek (adelante y atrás) reposiciona sin arrastrar interpolación previa.
 * La comprobación VISUAL en navegador queda pendiente (no hay navegador en este
 * entorno); esto la cubre a nivel de reloj de reproducción.
 */
import { describe, expect, it } from "vitest";
import { ReplayFeed, type PlaybackScene } from "../src/viewer/replay-feed.js";
import { ReplayPlayer, tickToMs, type ReplaySource } from "../src/viewer/replay-player.js";
import { SnapshotInterpolator } from "../src/viewer/interpolation.js";
import type { ViewerScene } from "../src/viewer/PhaserViewer.js";

// La ViewerScene real cumple la interfaz que consume la ReplayFeed (solo tipos:
// importar PhaserViewer en runtime arrastraría Phaser a un test de lógica pura).
const _sceneContract: PlaybackScene = null as unknown as ViewerScene;
void _sceneContract;

const FRAME_MS = 1000 / 60;
const SNAPSHOT_EVERY = 3; // ticks entre snapshots (10 Hz con simulación a 30 Hz)

/** Batalla sintética: v1 avanza 1 m/tick en x — la posición delata el tick. */
function snapAt(tick: number) {
  return {
    tick,
    vehicles: [{ id: "v1", position: { x: tick, y: 0 }, heading: 0, turretHeading: 0, alive: true }],
    projectiles: [],
  };
}

function makeSource(totalTicks: number): ReplaySource {
  const snapshots: any[] = [];
  for (let t = 0; t <= totalTicks; t += SNAPSHOT_EVERY) snapshots.push(snapAt(t));
  const events = [
    { tick: 9, type: "hit" },
    { tick: 30, type: "hit" },
  ];
  return {
    index: async () => ({
      battleId: "b_feed",
      ticks: totalTicks,
      snapshotCount: snapshots.length,
      keyframes: [{ tick: 0, snapshotIndex: 0 }],
      result: { winner: "red", ticks: totalTicks, score: {}, finalStateHash: "h" },
      debugOpen: false,
    }),
    segment: async (fromTick, toTick) => ({
      fromKeyframeTick: fromTick,
      snapshots: snapshots.filter((s) => s.tick >= fromTick && s.tick <= toTick),
      events: events.filter((e) => e.tick >= fromTick && e.tick <= toTick),
    }),
  };
}

/** Escena falsa con el interpolador REAL: registra llamadas y muestrea como update(). */
class FakeScene implements PlaybackScene {
  clock: (() => number) | null = null;
  calls: { kind: "push" | "reset"; tick: number; atMs: number | undefined }[] = [];
  events: any[] = [];
  private readonly itp = new SnapshotInterpolator();

  setPlaybackClock(clock: () => number): void {
    this.clock = clock;
  }
  pushSnapshot(s: any, atMs?: number): void {
    this.calls.push({ kind: "push", tick: s.tick, atMs });
    this.itp.push(s, atMs!);
  }
  resetTo(s: any, atMs?: number): void {
    this.calls.push({ kind: "reset", tick: s.tick, atMs });
    this.itp.reset(s, atMs!);
  }
  pushEvent(e: any): void {
    this.events.push(e);
  }
  /** Lo que ViewerScene.update() pintaría: muestreo con el reloj de reproducción. */
  sampleX(): number | null {
    const frame = this.itp.sampleAt(this.clock!());
    return frame?.vehicles.get("v1")?.x ?? null;
  }
}

async function makeFeed(totalTicks = 300, startTick = 0) {
  const player = new ReplayPlayer(makeSource(totalTicks));
  const scene = new FakeScene();
  const feed = new ReplayFeed(player, scene);
  await player.init(startTick);
  return { player, scene, feed };
}

describe("R3.1 · reloj de reproducción compartido (ERR-VIS-01)", () => {
  it("la escena muestrea con el playhead del reproductor, no con el reloj de pared", async () => {
    const { player, scene, feed } = await makeFeed();
    expect(scene.clock).not.toBeNull();
    expect(scene.clock!()).toBe(player.playheadMs);

    player.play();
    player.setSpeed(2);
    await feed.frame(100); // 100 ms reales a 2× = 200 ms de partida
    expect(player.playheadMs).toBeCloseTo(200, 6);
    expect(scene.clock!()).toBe(player.playheadMs); // el reloj sigue al playhead
  });

  it("tickToMs es el eje de fechado: 30 ticks = 1000 ms de partida", () => {
    expect(tickToMs(0)).toBe(0);
    expect(tickToMs(30)).toBe(1000);
    expect(tickToMs(SNAPSHOT_EVERY)).toBeCloseTo(100, 6);
  });
});

describe("R3.1 · pushSnapshot por snapshot y resetTo solo tras seek", () => {
  it("a 1×: un reset inicial y después SOLO pushSnapshot, uno por snapshot nuevo", async () => {
    const { player, scene, feed } = await makeFeed();
    player.play();
    for (let i = 0; i < 120; i++) await feed.frame(FRAME_MS); // ~2 s de partida

    expect(scene.calls[0]).toMatchObject({ kind: "reset", tick: 0, atMs: 0 });
    const rest = scene.calls.slice(1);
    expect(rest.length).toBeGreaterThan(10);
    expect(rest.every((c) => c.kind === "push")).toBe(true);
    // Un push por snapshot (cada 3 ticks), en orden y fechado en ms de partida.
    for (let i = 0; i < rest.length; i++) {
      expect(rest[i].tick).toBe((i + 1) * SNAPSHOT_EVERY);
      expect(rest[i].atMs).toBeCloseTo(tickToMs(rest[i].tick), 6);
    }
    // MUCHOS menos pushes que frames: no se reseteaba por frame como en el bug.
    expect(rest.length).toBeLessThan(120 / 2);
  });

  it("en pausa no se reempuja el mismo snapshot", async () => {
    const { player, scene, feed } = await makeFeed();
    player.play();
    for (let i = 0; i < 30; i++) await feed.frame(FRAME_MS);
    player.pause();
    const callsBefore = scene.calls.length;
    for (let i = 0; i < 30; i++) await feed.frame(FRAME_MS);
    expect(scene.calls.length).toBe(callsBefore);
  });

  it("los eventos llegan a la escena en orden y una sola vez", async () => {
    const { player, scene, feed } = await makeFeed();
    player.play();
    for (let i = 0; i < 90; i++) await feed.frame(FRAME_MS); // cruza ticks 9 y 30
    expect(scene.events.map((e) => e.tick)).toEqual([9, 30]);
  });
});

describe("R3.1 · el replay se ve interpolado, no a 10 saltos por segundo", () => {
  it("el muestreo a 60 fps es continuo entre snapshots (sin saltos de 3 ticks)", async () => {
    const { player, scene, feed } = await makeFeed();
    player.play();
    const xs: number[] = [];
    for (let i = 0; i < 180; i++) {
      await feed.frame(FRAME_MS);
      const x = scene.sampleX();
      if (x !== null) xs.push(x);
    }
    // Con el bug (resetTo por frame) x solo tomaba los valores de los snapshots:
    // ~10 valores distintos por segundo, con saltos de 3. Interpolado, avanza en
    // pasos de ~0,5 ticks por frame y nunca retrocede.
    const distinct = new Set(xs.map((x) => x.toFixed(4))).size;
    expect(distinct).toBeGreaterThan(60); // muchas más poses que snapshots
    for (let i = 1; i < xs.length; i++) {
      const delta = xs[i] - xs[i - 1];
      expect(delta).toBeGreaterThanOrEqual(0); // nunca retrocede
      expect(delta).toBeLessThanOrEqual(1); // jamás un salto de snapshot (3 m)
    }
    // Y de verdad interpola: hay poses que no coinciden con NINGÚN snapshot.
    expect(xs.some((x) => x % SNAPSHOT_EVERY !== 0)).toBe(true);
  });
});

describe("R3.1 · seek: reposiciona sin arrastrar interpolación del tramo anterior", () => {
  it("seek adelante: resetTo al tick de aterrizaje y la pose es EXACTA, sin mezcla", async () => {
    const { player, scene, feed } = await makeFeed();
    player.play();
    for (let i = 0; i < 60; i++) await feed.frame(FRAME_MS);

    await feed.seek(150);
    const last = scene.calls[scene.calls.length - 1];
    expect(last.kind).toBe("reset");
    expect(Math.abs(last.tick - 150)).toBeLessThanOrEqual(1); // DoD T8.3: ±1 tick
    expect(last.atMs).toBeCloseTo(tickToMs(last.tick), 6);
    // La pose muestreada tras el seek es la del snapshot de aterrizaje, no una
    // interpolación con el tramo anterior (x≈30 → habría dado valores intermedios).
    expect(scene.sampleX()).toBe(last.tick);
  });

  it("seek hacia ATRÁS: también resetea (push descartaría el snapshot como reordenado)", async () => {
    const { player, scene, feed } = await makeFeed(300, 150);
    player.play();
    for (let i = 0; i < 30; i++) await feed.frame(FRAME_MS);

    await feed.seek(30);
    const last = scene.calls[scene.calls.length - 1];
    expect(last.kind).toBe("reset");
    expect(Math.abs(last.tick - 30)).toBeLessThanOrEqual(1);
    expect(scene.sampleX()).toBe(last.tick);

    // Y tras el seek se vuelve a la ruta normal: pushes crecientes desde ahí.
    for (let i = 0; i < 30; i++) await feed.frame(FRAME_MS);
    const after = scene.calls.slice(scene.calls.indexOf(last) + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.kind === "push")).toBe(true);
    expect(after[0].tick).toBeGreaterThan(last.tick);
  });

  it("seek en PAUSA reposiciona la escena inmediatamente", async () => {
    const { scene, feed } = await makeFeed();
    await feed.frame(0); // reset inicial
    await feed.seek(90); // sin play(): el playhead no avanza, pero la escena sí salta
    const last = scene.calls[scene.calls.length - 1];
    expect(last.kind).toBe("reset");
    expect(Math.abs(last.tick - 90)).toBeLessThanOrEqual(1);
    expect(scene.sampleX()).toBe(last.tick);
  });
});
