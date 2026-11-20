// @vitest-environment jsdom
/**
 * FIX-DELAY · La emisión (/broadcast, LiveScreen) con retardo anti-coaching: mientras
 * llega el primer snapshot diferido muestra «Directo con retardo de 30 s…» en vez
 * de un mapa vacío en el tick 0; al llegar la imagen, el rótulo desaparece. Sin
 * retardo, nada cambia. Phaser y el transporte se sustituyen (prueba de componente).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_BRANDING, type BroadcastConfig } from "../src/broadcast/config.js";
import { LiveScreen } from "../src/pages/BroadcastPage.js";

const sceneStub = new Proxy({} as Record<string, unknown>, {
  get: (t, prop) => (prop === "then" ? undefined : prop in t ? t[prop as string] : () => undefined),
  set: (t, prop, v) => {
    t[prop as string] = v;
    return true;
  },
});
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: async () => sceneStub,
}));
vi.mock("../src/viewer/HudOverlay.js", () => ({ HudOverlay: () => <div data-testid="hud" /> }));
vi.mock("../src/viewer/hud-model.js", () => ({ buildHudModel: () => ({}) }));
vi.mock("../src/viewer/live-feed.js", () => ({
  LiveFeed: class {
    onInit() {}
    onSnapshot() {}
    onEvent() {}
  },
}));
let emit: (ev: string, payload: unknown) => void = () => undefined;
let connected = false;
/**
 * FIX-DIRECTOR-DELAY · LiveScreen ya no abre su propio WS: pinta el feed que sigue el
 * director (SpectatorTimeline). Aquí el feed es un cliente falso que el test gobierna.
 */
function fakeFeed() {
  const handlers = new Map<string, (p: unknown) => void>();
  const client = {
    state: { serverTimeMs: null, snapshot: null, result: null, connected: true },
    on(ev: string, cb: (p: unknown) => void) {
      handlers.set(ev, cb);
      emit = (e, p) => handlers.get(e)?.(p);
      connected = true;
      return () => handlers.delete(ev);
    },
    async connect() {},
    stop() {},
  };
  return { client, lastInit: () => null, rejection: () => null };
}

const config: BroadcastConfig = {
  target: { kind: "tournament", tournamentId: "t1" },
  branding: DEFAULT_BRANDING,
  pollIntervalMs: 1000,
  waitScheduled: false,
};
const battle = { id: "b1", participants: [], mode: "deathmatch" } as any;

async function mount() {
  const feed = fakeFeed(); // identidad estable, como la que da SpectatorTimeline.feed()
  render(<LiveScreen config={config} battle={battle} feed={feed} />);
  await vi.waitFor(() => expect(connected).toBe(true)); // la pantalla se suscribió al feed
}

afterEach(() => {
  cleanup();
  emit = () => undefined;
  connected = false;
});

describe("FIX-DELAY · /broadcast con retardo", () => {
  it("init con retardo 30 s y sin snapshot ⇒ rótulo «Directo con retardo de 30 s…»; el primer snapshot lo quita", async () => {
    await mount();
    act(() =>
      emit("init", { spectator: { delaySeconds: 30, delayMs: 30_000 }, snapshot: null, finished: false, meta: {} }),
    );
    const wait = await screen.findByTestId("broadcast-delay-wait");
    expect(wait.textContent).toMatch(/Directo con retardo de 30 s/);
    // Los latidos no cambian nada en pantalla (no traen estado).
    act(() => emit("heartbeat", { delayMs: 30_000 }));
    expect(screen.getByTestId("broadcast-delay-wait")).toBeTruthy();
    act(() => emit("snapshot", { tick: 1, vehicles: [] }));
    expect(screen.queryByTestId("broadcast-delay-wait")).toBeNull();
  });

  it("init con retardo que YA trae estado (reconexión pasada la ventana) ⇒ sin rótulo", async () => {
    await mount();
    act(() =>
      emit("init", {
        spectator: { delaySeconds: 30 },
        snapshot: { tick: 300, vehicles: [] },
        finished: false,
        meta: {},
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByTestId("broadcast-delay-wait")).toBeNull();
  });

  it("sin retardo ⇒ comportamiento de siempre: ningún rótulo de espera", async () => {
    await mount();
    act(() => emit("init", { spectator: { delaySeconds: 0 }, snapshot: null, finished: false, meta: {} }));
    await act(async () => undefined);
    expect(screen.queryByTestId("broadcast-delay-wait")).toBeNull();
  });
});
