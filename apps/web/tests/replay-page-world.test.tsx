// @vitest-environment jsdom
/**
 * UX-D (D4 · C-G9) · El reproductor pinta el MUNDO y los NOMBRES del replay.
 *
 * El índice de la API trae ahora `world` (muros, destructibles, bases) y `roster`
 * (vehículo → nombre del bot). Antes ReplayPage sólo pasaba la nómina —que el
 * índice nunca traía— y nunca el mundo: el replay se veía sin obstáculos y con
 * `veh_1`. Se comprueba que la página entrega ambos a la escena.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReplayIndexData, ReplaySource } from "../src/viewer/replay-player.js";

const WORLD = {
  widthM: 120,
  heightM: 80,
  walls: [{ position: { x: 60, y: 40 }, halfW: 2, halfH: 10 }],
  destructibles: [{ position: { x: 30, y: 20 }, halfW: 1, halfH: 1 }],
  bases: [{ team: "red", position: { x: 10, y: 40 }, radiusM: 5 }],
};
const INDEX: ReplayIndexData = {
  battleId: "btl_world",
  ticks: 30,
  snapshotCount: 1,
  keyframes: [{ tick: 0, snapshotIndex: 0 }],
  result: { winner: "draw", ticks: 30, score: {}, finalStateHash: "x" },
  debugOpen: false,
  roster: [{ id: "veh_1", botId: "b1", team: "red", name: "Tanque Rojo" }],
  world: WORLD,
};

vi.mock("../src/viewer/replay-player.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/viewer/replay-player.js")>();
  const source = (): ReplaySource => ({
    index: async () => INDEX,
    segment: async () => ({ fromKeyframeTick: 0, snapshots: [{ tick: 0, vehicles: [] }], events: [] }),
  });
  return { ...real, httpReplaySource: source };
});

const calls: { setWorld: unknown[]; setRoster: unknown[] } = { setWorld: [], setRoster: [] };
const sceneStub = new Proxy(
  {
    overlay: { score: {} },
    setWorld: (w: unknown) => calls.setWorld.push(w),
    setRoster: (r: unknown) => calls.setRoster.push(r),
  },
  { get: (t, prop) => (prop === "then" ? undefined : prop in t ? (t as any)[prop] : () => undefined) },
);
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: async () => sceneStub,
}));

afterEach(() => {
  cleanup();
});

describe("UX-D · ReplayPage entrega mundo y nómina a la escena", () => {
  it("setWorld con los muros del índice y setRoster con el nombre del bot", async () => {
    const { ReplayPage } = await import("../src/pages/ReplayPage.js");
    render(<ReplayPage battleId="btl_world" />);
    await vi.waitFor(() => expect(calls.setWorld.length).toBe(1));
    expect(calls.setWorld[0]).toEqual(WORLD);
    expect(calls.setRoster.length).toBe(1);
    const roster = calls.setRoster[0] as Map<string, { name?: string }>;
    expect(roster.get("veh_1")?.name).toBe("Tanque Rojo");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
