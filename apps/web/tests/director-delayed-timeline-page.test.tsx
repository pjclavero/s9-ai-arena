// @vitest-environment jsdom
/**
 * FIX-DIRECTOR-DELAY · /broadcast (página completa): el escenario es el fallo de C2 tal cual.
 * La API pública dice que la batalla y el torneo ya terminaron en real, pero el feed retrasado
 * sigue emitiendo. La página tiene que seguir EN DIRECTO hasta que ese feed llegue a su final,
 * y sólo entonces mostrar «Torneo terminado».
 *
 * Comprueba el CABLEADO: BroadcastPage le da al director la línea temporal, y LiveScreen
 * pinta la conexión de esa línea temporal. Phaser se sustituye; el feed es un SpectatorClient
 * falso que el test gobierna.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_BRANDING, type BroadcastConfig } from "../src/broadcast/config.js";
import { BroadcastPage } from "../src/pages/BroadcastPage.js";

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
const painted: number[] = [];
vi.mock("../src/viewer/live-feed.js", () => ({
  LiveFeed: class {
    // La pantalla se sincroniza con lo que el feed YA trajo (init sintético con su último snapshot).
    onInit(m: { snapshot?: { tick: number } | null }) {
      if (m?.snapshot) painted.push(m.snapshot.tick);
    }
    onSnapshot(s: { tick: number }) {
      painted.push(s.tick);
    }
    onEvent() {}
  },
}));

/** Feeds falsos por batalla (el id sale del ticket que pide la propia página). */
const feeds = new Map<string, { emit: (ev: string, p: unknown) => void; stopped: boolean }>();
vi.mock("../src/viewer/spectator-client.js", () => ({
  SpectatorClient: class {
    state = { serverTimeMs: null, snapshot: null as unknown, result: null as unknown, connected: true };
    private handlers = new Map<string, Set<(p: unknown) => void>>();
    constructor(private readonly opts: { getTicket: () => Promise<{ wsUrl: string }> }) {}
    on(ev: string, cb: (p: unknown) => void) {
      if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
      this.handlers.get(ev)!.add(cb);
      return () => this.handlers.get(ev)?.delete(cb);
    }
    async connect() {
      const { wsUrl } = await this.opts.getTicket();
      const id = wsUrl.split("/").pop()!;
      const self = this;
      const f = {
        stopped: false,
        emit(ev: string, p: any) {
          if (ev === "snapshot") self.state.snapshot = p;
          if (ev === "result") self.state.result = p;
          for (const cb of self.handlers.get(ev) ?? []) cb(p);
        },
      };
      feeds.set(id, f);
      (this as any).feed = f;
    }
    stop() {
      const f = (this as any).feed;
      if (f) f.stopped = true;
    }
  },
}));

type RealStatus = "running" | "finished";
let real = { battle: "running" as RealStatus, tournament: "running" };
/** Otras batallas del torneo (detrás de A), con su estado REAL. */
let others: Record<string, RealStatus> = {};
const row = (id: string, status: RealStatus) => ({
  id,
  tournamentId: "t1",
  status,
  mode: "deathmatch",
  participants: [
    { botId: `${id}r`, botName: "Rojo", version: 1, team: "red", outcome: status === "finished" ? "win" : undefined },
  ],
  result: status === "finished" ? { score: { red: 3, blue: 0 } } : undefined,
});
function stubApi() {
  vi.stubGlobal("fetch", async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    const ticket = /^\/api\/v1\/battles\/([^/]+)\/spectate-ticket$/.exec(u);
    if (init?.method === "POST" && ticket) return json({ ticket: "t", wsUrl: `/spectate/${ticket[1]}` });
    if (u === "/api/v1/tournaments/t1") return json({ id: "t1", state: real.tournament });
    if (u === "/api/v1/tournaments/t1/battles")
      return json({ items: [row("A", real.battle), ...Object.entries(others).map(([id, st]) => row(id, st))] });
    throw new Error(`ruta inesperada ${u}`);
  });
}

const config: BroadcastConfig = {
  target: { kind: "tournament", tournamentId: "t1" },
  branding: DEFAULT_BRANDING,
  pollIntervalMs: 40,
  waitScheduled: false,
};
const stage = () => screen.getByTestId("broadcast-stage");
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  feeds.clear();
  painted.splice(0);
  real = { battle: "running", tournament: "running" };
  others = {};
});

describe("FIX-DIRECTOR-DELAY · /broadcast sigue la línea temporal retrasada", () => {
  it("DELAYED_TOURNAMENT_END · página: fin real de la batalla y del torneo ⇒ sigue EN DIRECTO hasta el result retrasado", async () => {
    stubApi();
    render(<BroadcastPage config={config} />);
    await waitFor(() => expect(feeds.get("A")).toBeTruthy());
    const A = feeds.get("A")!;

    // Inicio real, feed sin imagen todavía ⇒ espera con el aviso de retardo (no LIVE).
    act(() =>
      A.emit("init", { spectator: { delaySeconds: 30, delayMs: 30_000 }, snapshot: null, finished: false, meta: {} }),
    );
    await waitFor(() => expect(screen.getByTestId("broadcast-delay-wait").textContent).toMatch(/retardo de 30 s/));
    expect(stage().getAttribute("data-director-state")).toBe("WAITING_VALID");
    expect(screen.queryByTestId("broadcast-live")).toBeNull();

    // Primer contenido retrasado ⇒ LIVE, pintado por la MISMA conexión.
    act(() => A.emit("snapshot", { tick: 1, vehicles: [] }));
    await waitFor(() => expect(stage().getAttribute("data-director-state")).toBe("LIVE"));
    await waitFor(() => expect(painted).toContain(1));

    // Fin REAL de la batalla y del torneo (lo que vio el director de C2 a las 01:46:54).
    real = { battle: "finished", tournament: "finished" };
    await pause(300); // varios sondeos
    act(() => A.emit("snapshot", { tick: 2, vehicles: [] })); // el feed retrasado sigue
    await pause(200);
    expect(stage().getAttribute("data-director-state")).toBe("LIVE");
    expect(screen.getByTestId("broadcast-live")).toBeTruthy();
    expect(screen.queryByTestId("broadcast-finished")).toBeNull();
    expect(stage().textContent).not.toMatch(/Torneo terminado|red 3/);
    expect(painted).toContain(2);
    expect(A.stopped).toBe(false);

    // El feed retrasado llega a su final ⇒ ahora sí, «Torneo terminado» con el marcador.
    act(() => A.emit("result", { winner: "red", score: { red: 3, blue: 0 } }));
    await waitFor(() => expect(screen.getByTestId("broadcast-finished").textContent).toMatch(/Torneo terminado/));
    expect(stage().getAttribute("data-director-state")).toBe("TARGET_FINISHED");
    expect(screen.getByTestId("broadcast-last-score").textContent).toContain("red 3");
    expect(A.stopped).toBe(true);
  });

  it("LIVE_PAINTS_ON_AIR_FEED (S5) · A en antena y B ya seguida: la imagen sigue en A (ni el rótulo de espera ni los snapshots de B)", async () => {
    stubApi();
    render(<BroadcastPage config={config} />);
    await waitFor(() => expect(feeds.get("A")).toBeTruthy());
    const A = feeds.get("A")!;
    act(() =>
      A.emit("init", { spectator: { delaySeconds: 30, delayMs: 30_000 }, snapshot: null, finished: false, meta: {} }),
    );
    act(() => A.emit("snapshot", { tick: 1, vehicles: [] }));
    await waitFor(() => expect(stage().getAttribute("data-director-state")).toBe("LIVE"));
    await waitFor(() => expect(painted).toContain(1));

    // A termina en real y B empieza en real: el director sigue B (candidata) sin ponerla en antena.
    real = { battle: "finished", tournament: "running" };
    others = { B: "running" };
    await waitFor(() => expect(feeds.get("B")).toBeTruthy());
    const B = feeds.get("B")!;
    act(() =>
      B.emit("init", { spectator: { delaySeconds: 30, delayMs: 30_000 }, snapshot: null, finished: false, meta: {} }),
    );
    await pause(150);
    act(() => A.emit("snapshot", { tick: 2, vehicles: [] }));
    await pause(150);
    expect(stage().getAttribute("data-director-state")).toBe("LIVE");
    expect(painted).toContain(2);
    expect(screen.queryByTestId("broadcast-delay-wait"), "la imagen pinta la espera de B").toBeNull();
    expect(screen.getByTestId("broadcast-ticker").textContent).toContain("tick 2");

    // B ya emite su contenido retrasado en paralelo: sigue sin verse mientras A esté en antena.
    act(() => B.emit("snapshot", { tick: 100, vehicles: [] }));
    await pause(150);
    expect(painted, "la imagen pinta el feed de la candidata").not.toContain(100);
    expect(screen.getByTestId("broadcast-ticker").textContent).toContain("tick 2");
    expect(B.stopped).toBe(false);
  });
});
