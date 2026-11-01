// @vitest-environment jsdom
/**
 * UX-VIEW · Páginas del visor y del replay.
 *
 *  - BUG de cámara: `ViewerPage` reaplicaba `scene.cameraMode` en cada snapshot
 *    (`overlayTick`) y `ReplayPage` en cada tick: el zoom y el pan manuales se
 *    perdían al instante. Ahora la escena es la fuente de verdad: la página sólo
 *    cambia el modo ante una acción del usuario.
 *  - Modo de cámara visible y % de zoom, reflejados de la escena (subscribeView).
 *  - Botones −/+/Encajar/100 %/Centrar seleccionado llaman a la escena.
 *  - Minimapa como panel FUERA del escenario, ocultable.
 *  - Ancho completo: `.page-wide` en <main> mientras la página está montada.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReplaySource } from "../src/viewer/replay-player.js";

const ROSTER = [
  { id: "veh_1", name: "Alfa", team: "red", chassis: "chassis.medium@1" },
  { id: "veh_2", name: "Beta", team: "blue", chassis: "chassis.medium@1" },
];

const INDEX = {
  battleId: "btl_ux",
  ticks: 600,
  snapshotCount: 1,
  keyframes: [{ tick: 0, snapshotIndex: 0 }],
  result: { winner: "red", ticks: 600, score: { red: 1, blue: 0 }, finalStateHash: "x" },
  debugOpen: false,
  roster: ROSTER,
};

vi.mock("../src/viewer/replay-player.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/viewer/replay-player.js")>();
  const snaps = Array.from({ length: 21 }, (_, i) => ({ tick: i * 30, vehicles: [] }));
  const source = (): ReplaySource => ({
    index: async () => INDEX,
    segment: async () => ({ fromKeyframeTick: 0, snapshots: snaps, events: [] }),
  });
  return { ...real, httpReplaySource: source };
});

/** Escena falsa que CUENTA cuántas veces la página le pone el modo de cámara. */
const calls = { cameraModeSets: [] as unknown[], method: [] as string[] };
let viewCb: ((s: unknown) => void) | null = null;
const sceneStub = new Proxy(
  {
    overlay: {
      score: { red: 0, blue: 0 },
      vehicles: new Map(ROSTER.map((r) => [r.id, { id: r.id, team: r.team, alive: true, hullHp: 50, hullHpMax: 100 }])),
      feed: [],
    },
    subscribeView: (cb: (s: unknown) => void) => {
      viewCb = cb;
      cb({ mode: { kind: "global" }, zoomPercent: 122, selectedId: null });
      return () => {
        viewCb = null;
      };
    },
  },
  {
    get: (t, prop) => {
      if (prop === "then") return undefined;
      if (prop in t) return (t as any)[prop];
      return (..._a: unknown[]) => {
        calls.method.push(String(prop));
        return undefined;
      };
    },
    set: (_t, prop, v) => {
      if (prop === "cameraMode") calls.cameraModeSets.push(v);
      return true;
    },
  },
);
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: async () => sceneStub,
}));
vi.mock("../src/viewer/HudOverlay.js", () => ({ HudOverlay: () => <div data-testid="hud" /> }));
vi.mock("../src/viewer/hud-model.js", () => ({ buildHudModel: () => ({}) }));

let emitLater: ((ev: string, payload: unknown) => void) | null = null;
vi.mock("../src/viewer/spectator-client.js", () => ({
  SpectatorClient: class {
    state = { serverTimeMs: null };
    private handlers = new Map<string, (p: unknown) => void>();
    on(ev: string, cb: (p: unknown) => void) {
      this.handlers.set(ev, cb);
    }
    async connect() {
      emitLater = (ev, p) => this.handlers.get(ev)?.(p);
      emitLater("init", { finished: false, spectator: {}, meta: { roster: ROSTER } });
    }
    stop() {}
  },
}));
vi.mock("../src/viewer/live-feed.js", () => ({
  LiveFeed: class {
    onInit() {}
    onSnapshot() {}
    onEvent() {}
  },
}));
vi.mock("../src/api.js", () => ({ api: async () => ({ ticket: "t" }) }));

afterEach(() => {
  cleanup();
  calls.cameraModeSets.length = 0;
  calls.method.length = 0;
  viewCb = null;
  emitLater = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function withMain() {
  const main = document.createElement("main");
  document.body.appendChild(main);
  return main;
}

describe("ViewerPage · la cámara manual no se pisa", () => {
  it("los snapshots NO reaplican el modo de cámara (antes: uno por tick)", async () => {
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_ux" />, { container: withMain() });
    await screen.findByText("en directo");
    const before = calls.cameraModeSets.length;
    for (let t = 1; t <= 12; t++) await act(async () => emitLater?.("snapshot", { tick: t, vehicles: [] }));
    expect(calls.cameraModeSets.length - before).toBe(0);
    // Una acción del usuario sí cambia el modo, una sola vez.
    await userEvent.click(screen.getByRole("button", { name: "Bando azul" }));
    expect(calls.cameraModeSets.at(-1)).toEqual({ kind: "team", team: "blue" });
    const after = calls.cameraModeSets.length;
    for (let t = 13; t <= 20; t++) await act(async () => emitLater?.("snapshot", { tick: t, vehicles: [] }));
    expect(calls.cameraModeSets.length).toBe(after);
  });

  it("modo visible y % de zoom reflejan la escena; los botones de zoom llaman a la escena", async () => {
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_ux" />, { container: withMain() });
    await screen.findByText("en directo");
    expect(screen.getByTestId("camera-mode").textContent).toBe("Cámara: vista completa");
    // La suscripción a la escena se monta tras el primer render: se espera, no se supone.
    await vi.waitFor(() => expect(screen.getByTestId("zoom-level").textContent).toBe("122 %"));
    await act(async () =>
      viewCb?.({ mode: { kind: "manual", centerX: 1, centerY: 1, zoom: 20 }, zoomPercent: 250, selectedId: null }),
    );
    expect(screen.getByTestId("camera-mode").getAttribute("data-mode")).toBe("manual");
    expect(screen.getByTestId("camera-mode").textContent).toBe("Cámara: libre");
    expect(screen.getByTestId("zoom-level").textContent).toBe("250 %");
    await act(async () =>
      viewCb?.({ mode: { kind: "follow", vehicleId: "veh_2" }, zoomPercent: 150, selectedId: "veh_2" }),
    );
    expect(screen.getByTestId("camera-mode").textContent).toBe("Cámara: siguiendo a Beta");
    expect(screen.getByRole("button", { name: "Seguir Beta" }).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Acercar", "Alejar", "Encajar mapa", "100 %", "Centrar seleccionado"]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    expect(calls.method).toEqual(
      expect.arrayContaining(["zoomIn", "zoomOut", "fitMap", "zoomNative", "centerSelected"]),
    );
  });

  it("«Centrar seleccionado» está desactivado sin selección", async () => {
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_ux" />, { container: withMain() });
    await screen.findByText("en directo");
    expect((screen.getByRole("button", { name: "Centrar seleccionado" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("minimapa: panel aparte del escenario (no dentro), ocultable", async () => {
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_ux" />, { container: withMain() });
    await screen.findByText("en directo");
    const stage = screen.getByTestId("viewer-canvas-host");
    const mini = screen.getByTestId("minimap");
    expect(stage.contains(mini)).toBe(false);
    expect(mini.contains(stage)).toBe(false);
    const toggle = within(mini).getByTestId("minimap-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    expect(mini.getAttribute("data-state")).toBe("closed");
    expect(within(mini).queryByTestId("minimap-canvas")).toBeNull();
    await userEvent.click(toggle);
    expect(within(mini).getByTestId("minimap-canvas")).toBeTruthy();
  });

  it("el escenario es enfocable y declara su ayuda de teclado; <main> pasa a ancho completo", async () => {
    const main = withMain();
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    const r = render(<ViewerPage battleId="btl_ux" />, { container: main });
    await screen.findByText("en directo");
    expect(main.classList.contains("page-wide")).toBe(true);
    const stage = screen.getByTestId("viewer-stage");
    expect(stage.tabIndex).toBe(0);
    expect(stage.getAttribute("aria-describedby")).toBe("viewer-help");
    expect(document.getElementById("viewer-help")?.textContent).toMatch(/1–8: seguir bots/);
    r.unmount();
    expect(main.classList.contains("page-wide")).toBe(false);
  });
});

describe("ReplayPage · la cámara manual no se pisa", () => {
  it("los ticks del replay NO reaplican el modo de cámara (antes: uno por tick publicado)", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const { ReplayPage } = await import("../src/pages/ReplayPage.js");
    render(<ReplayPage battleId="btl_ux" />, { container: withMain() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const tick = Number(screen.getByTestId("replay-tick").getAttribute("data-tick"));
    expect(tick).toBeGreaterThan(0); // el replay avanzó: hubo re-renders por tick
    expect(calls.cameraModeSets).toEqual([]);
    expect(screen.getByRole("button", { name: "Seguir Alfa" })).toBeTruthy();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "Seguir Alfa" }));
    expect(calls.cameraModeSets).toEqual([{ kind: "follow", vehicleId: "veh_1" }]);
  });
});
