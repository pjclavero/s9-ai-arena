// @vitest-environment jsdom
/**
 * 4v4-FIX · Dos defectos menores de la UI hallados por el REVIEW:
 *  1. Visor SIN nómina: el desplegable de la niebla enseñaba `sides[0]` (bandos del
 *     snapshot) pero la niebla iba con `fogTeam = ""` ⇒ al activarla no hacía nada.
 *  2. Detalle: la tabla de estadísticas por bot listaba en el orden de la API
 *     mientras «Resultado por bando» va rojo → azul y por nombre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const VEHICLES = [
  { id: "veh_1", team: "blue" },
  { id: "veh_2", team: "red" },
];
const sceneState: { fog?: unknown } = {};
const sceneStub = new Proxy(
  { overlay: { score: { red: 0, blue: 0 }, vehicles: new Map(VEHICLES.map((v) => [v.id, v])), feed: [] } },
  {
    get: (t, prop) => (prop === "then" ? undefined : prop in t ? (t as any)[prop] : () => undefined),
    set: (_t, prop, v) => {
      (sceneState as any)[prop] = v;
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
  vi.unstubAllGlobals();
});

describe("4v4-FIX · niebla sin nómina", () => {
  it("el bando que enseña el desplegable es el que recibe la niebla al activarla", async () => {
    // Sin `meta.roster`: los bandos salen de los vehículos del snapshot.
    scenario = (emit) => emit("init", { finished: false, spectator: { allowFogView: true } });
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_noroster" />);
    await screen.findByText("en directo");
    const fog = (await screen.findByLabelText("bando de la niebla")) as HTMLSelectElement;
    expect(fog.value).toBe("red");
    await userEvent.click(screen.getByRole("checkbox", { name: /Niebla de guerra/ }));
    expect(sceneState.fog).toMatchObject({ enabled: true, team: fog.value });
  });
});

describe("4v4-FIX · detalle: mismo orden de bandos en todas las tablas", () => {
  it("estadísticas por bot y participantes siguen el orden de «Resultado por bando»", async () => {
    // La API los devuelve intercalados y con el azul primero.
    const names = [
      ["bot_b2", "B-2", "blue"],
      ["bot_a2", "A-2", "red"],
      ["bot_b1", "B-1", "blue"],
      ["bot_a1", "A-1", "red"],
    ];
    const battle = {
      id: "btl_order",
      status: "finished",
      mode: "team_deathmatch",
      mapId: "mvp-arena-01",
      mapVersion: 1,
      participants: names.map(([botId, botName, team]) => ({
        botId,
        botName,
        version: 1,
        team,
        outcome: team === "red" ? "win" : "loss",
      })),
      result: { winner: "red", ticks: 900, score: { red: 2, blue: 1 } },
      failureKind: "none",
      replayAvailable: true,
    };
    const bot = (team: string) => ({
      team,
      shotsFired: 3,
      shotsHit: 1,
      accuracy: 0.33,
      damageDealt: 10,
      damageTaken: 5,
      kills: 1,
      teamKills: 0,
      deaths: 1,
      died: true,
      aliveAtEnd: true,
      survivedTicks: 900,
    });
    const stats = {
      status: "ready",
      perBot: Object.fromEntries(names.map(([id, , team]) => [id, bot(team)])),
      perTeam: {
        blue: {
          team: "blue",
          score: 1,
          bots: 2,
          kills: 1,
          teamKills: 0,
          deaths: 2,
          damageDealt: 20,
          damageTaken: 10,
          shotsFired: 6,
          shotsHit: 2,
          survivors: 2,
        },
        red: {
          team: "red",
          score: 2,
          bots: 2,
          kills: 2,
          teamKills: 0,
          deaths: 2,
          damageDealt: 20,
          damageTaken: 10,
          shotsFired: 6,
          shotsHit: 2,
          survivors: 2,
        },
      },
      diagnostics: {},
    };
    const json = (b: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn((u: string | URL) => {
        const url = String(u).replace(/^\/api\/v1/, "");
        if (url === "/battles/btl_order") return json(battle);
        if (url === "/battles/btl_order/stats") return json(stats);
        return Promise.resolve(new Response("{}", { status: 404 }));
      }) as unknown as typeof fetch,
    );
    const { BattleDetailPage } = await import("../src/pages/BattleDetailPage.js");
    render(<BattleDetailPage id="btl_order" />);
    const sideRows = within(await screen.findByTestId("battle-sides")).getAllByTestId("side-row");
    expect(sideRows.map((r) => r.getAttribute("data-team"))).toEqual(["red", "blue"]);
    const statRows = await screen.findAllByTestId("stats-row");
    expect(statRows.map((r) => r.querySelector("td")?.textContent)).toEqual(["A-1 v1", "A-2 v1", "B-1 v1", "B-2 v1"]);
    const sidesStats = within(screen.getByTestId("battle-stats-sides")).getAllByTestId("stats-side-row");
    expect(sidesStats.map((r) => r.getAttribute("data-team"))).toEqual(["red", "blue"]);
    const partRows = screen.getAllByTestId("participant-row");
    expect(partRows.map((r) => r.querySelector("td")?.textContent)).toEqual(["A-1", "A-2", "B-1", "B-2"]);
  });
});
