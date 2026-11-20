// @vitest-environment jsdom
/**
 * UX-R · Remates del visor en directo y del reproductor (pendientes 4-6 de UX-E):
 *  - la línea de tiempo del replay tiene NOMBRE accesible (axe `label`, critical);
 *  - «no existe» en el visor se anuncia (role=alert) y SIN HUD ni controles
 *    debajo: un «0 — 0 · Preparados» contradecía la alerta;
 *  - el canvas del visor va en una caja que no desborda la página (móvil);
 *  - los títulos dicen quién juega («Batalla: Alfa vs Beta»), no el UUID.
 *
 * Phaser y el transporte se sustituyen (prueba de componente): el recorrido real
 * contra la API y el gateway está en tests/browser/specs/{viewer,replay}.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReplayIndexData, ReplaySource } from "../src/viewer/replay-player.js";
import { participantsTitle } from "../src/viewer/art-direction.js";
import { applyCanvasSize, canvasSizeFor } from "../src/viewer/viewport.js";

const INDEX: ReplayIndexData = {
  battleId: "btl_r",
  ticks: 30,
  snapshotCount: 1,
  keyframes: [{ tick: 0, snapshotIndex: 0 }],
  result: { winner: "draw", ticks: 30, score: {}, finalStateHash: "x" },
  debugOpen: false,
  roster: [
    { id: "veh_1", botId: "b1", team: "red", name: "Tanque Rojo" },
    { id: "veh_2", botId: "b2", team: "blue", name: "Muro Azul" },
  ],
};

vi.mock("../src/viewer/replay-player.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/viewer/replay-player.js")>();
  const source = (): ReplaySource => ({
    index: async () => INDEX,
    segment: async () => ({ fromKeyframeTick: 0, snapshots: [{ tick: 0, vehicles: [] }], events: [] }),
  });
  return { ...real, httpReplaySource: source };
});

const sceneStub = new Proxy(
  { overlay: { score: { red: 0, blue: 0 }, vehicles: new Map(), feed: [] } },
  { get: (t, prop) => (prop === "then" ? undefined : prop in t ? (t as any)[prop] : () => undefined) },
);
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: async () => sceneStub,
}));
// El HUD real necesita un overlay completo; aquí sólo importa SI se pinta.
vi.mock("../src/viewer/HudOverlay.js", () => ({ HudOverlay: () => <div data-testid="hud">0 — 0 · Preparados</div> }));
vi.mock("../src/viewer/hud-model.js", () => ({ buildHudModel: () => ({}) }));

/** Lo que hará el canal de espectador al conectar, por test. */
let scenario: (emit: (ev: string, payload: unknown) => void) => void = () => undefined;
vi.mock("../src/viewer/spectator-client.js", () => ({
  SpectatorClient: class {
    state = { serverTimeMs: null };
    private handlers = new Map<string, (p: unknown) => void>();
    on(ev: string, cb: (p: unknown) => void) {
      this.handlers.set(ev, cb);
    }
    async connect() {
      scenario((ev, p) => this.handlers.get(ev)?.(p));
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

afterEach(() => {
  cleanup();
  scenario = () => undefined;
});

/**
 * Modelo del ScaleManager de Phaser 4 en modo NONE (node_modules/phaser/src/scale/
 * ScaleManager.js): `resize` sólo toca el estilo si zoom ≠ 1; `setZoom` lo
 * recalcula con el tamaño de juego que haya en ese momento.
 */
class PhaserNoneScale {
  zoom = 1;
  gameW = 960;
  styleW = 960;
  resize(w: number) {
    this.gameW = w;
    if (w * this.zoom !== w) this.styleW = w * this.zoom;
  }
  setZoom(z: number) {
    this.zoom = z;
    this.styleW = this.gameW * z;
  }
}

describe("UX-R · el canvas del visor sigue al contenedor al estrecharse", () => {
  it("dpr 1: tras cada redimensionado el ancho CSS es el del contenedor, no el anterior", () => {
    const scale = new PhaserNoneScale();
    for (const cssW of [1888, 736, 358]) {
      applyCanvasSize(scale, canvasSizeFor(cssW, 640, 1));
      expect(scale.styleW).toBe(cssW);
    }
  });
  it("dpr 2: buffer al doble y CSS al tamaño del contenedor", () => {
    const scale = new PhaserNoneScale();
    applyCanvasSize(scale, canvasSizeFor(736, 640, 2));
    expect(scale.gameW).toBe(1472);
    expect(scale.styleW).toBe(736);
  });
});

describe("UX-R · participantsTitle", () => {
  it("nombres de la nómina, sin repetir ni UUIDs; sin nombres no hay título", () => {
    expect(participantsTitle(INDEX.roster)).toBe("Tanque Rojo vs Muro Azul");
    expect(
      participantsTitle([
        { id: "v1", name: "A" },
        { id: "v2", name: "A" },
        { id: "v3", name: "B" },
      ]),
    ).toBe("A vs B");
    expect(participantsTitle([{ id: "0b6f2a1e-0000-0000-0000-000000000000" }])).toBeNull();
    expect(participantsTitle(undefined)).toBeNull();
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, name: `N${i}` }));
    expect(participantsTitle(many)).toBe("N0 vs N1 vs N2 vs N3 y 2 más");
  });
});

describe("UX-R · ReplayPage", () => {
  it("la línea de tiempo tiene nombre accesible y el título dice quién juega", async () => {
    const { ReplayPage } = await import("../src/pages/ReplayPage.js");
    render(<ReplayPage battleId="btl_r" />);
    const slider = await screen.findByRole("slider", { name: "Línea de tiempo del replay" });
    expect(slider.getAttribute("data-testid")).toBe("timeline");
    expect((await screen.findByTestId("replay-title")).textContent).toBe("Replay: Tanque Rojo vs Muro Azul");
  });
});

describe("UX-R · ViewerPage", () => {
  it("batalla inexistente: alerta «no existe», sin HUD, sin controles de cámara y sin canvas", async () => {
    scenario = (emit) => emit("rejected", { kind: "ticket", status: 404, error: { status: 404 } });
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="00000000-0000-0000-0000-000000000000" />);
    const status = await screen.findByRole("alert");
    expect(status.getAttribute("data-testid")).toBe("viewer-status");
    expect(status.textContent).toContain("no existe");
    expect(screen.queryByTestId("hud")).toBeNull();
    expect(screen.queryByText(/Preparados/)).toBeNull();
    expect(screen.getByTestId("viewer-controls").hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Vista global" })).toBeNull();
    expect(screen.getByTestId("viewer-canvas-host").hidden).toBe(true);
    // El enlace al replay sigue ahí (viewer.spec lo exige).
    expect(screen.getByTestId("viewer-replay-link")).toBeTruthy();
  });

  it("en directo: HUD y controles visibles, canvas en caja que no desborda, título con participantes", async () => {
    scenario = (emit) =>
      emit("init", {
        finished: false,
        spectator: {},
        meta: {
          roster: [
            { id: "veh_1", name: "Alfa", team: "red" },
            { id: "veh_2", name: "Beta", team: "blue" },
          ],
        },
      });
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_live" />);
    await screen.findByText("en directo");
    expect(screen.getByTestId("viewer-title").textContent).toBe("Batalla: Alfa vs Beta");
    expect(screen.getByTestId("hud")).toBeTruthy();
    expect(screen.getByTestId("viewer-controls").hidden).toBe(false);
    const host = screen.getByTestId("viewer-canvas-host");
    expect(host.hidden).toBe(false);
    expect(host.style.overflow).toBe("hidden");
    expect(host.style.maxWidth).toBe("100%");
    expect(screen.getByTestId("viewer-title").style.overflowWrap).toBe("anywhere");
  });
});
