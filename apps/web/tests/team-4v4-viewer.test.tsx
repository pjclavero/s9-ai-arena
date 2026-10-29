// @vitest-environment jsdom
/**
 * 4v4 · T-UI · Visor, replay y detalle con 8 participantes (Fase 5).
 *  - los botones de cámara y la niebla salen de la NÓMINA, no de red/blue fijos;
 *  - sin bando por defecto "red" (vehicleTeam);
 *  - títulos agrupados por bando: «A-ATK-1, …, A-ATK-4 (rojo) vs B-DEF-1, … (azul)»;
 *  - los 4 vehículos de un bando se distinguen por NOMBRE (nómina y «Seguir …»);
 *  - el detalle da el resultado POR BANDO.
 * Phaser y el transporte se sustituyen (prueba de componente): el recorrido real
 * contra el stack está en tests/browser/specs/team-battle-4v4.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReplayIndexData, ReplaySource } from "../src/viewer/replay-player.js";
import { participantsTitle, rosterFromMeta, rosterTeams, sortTeams, vehicleTeam } from "../src/viewer/art-direction.js";
import { sideResults, sidesTitle, botVersionLabel, botLabel } from "../src/battle-result.js";
import { CameraInteraction } from "../src/viewer/camera-interaction.js";

const A = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4"];
const B = ["B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"];
const ROSTER8 = [
  ...A.map((name, i) => ({ id: `veh_${i + 1}`, botId: `bot_a${i}`, team: "red", name, chassis: "chassis.light@1" })),
  ...B.map((name, i) => ({ id: `veh_${i + 5}`, botId: `bot_b${i}`, team: "blue", name, chassis: "chassis.heavy@1" })),
];
const TITLE8 = "A-ATK-1, A-ATK-2, A-ATK-3, A-ATK-4 (rojo) vs B-DEF-1, B-DEF-2, B-DEF-3, B-DEF-4 (azul)";

const INDEX: ReplayIndexData = {
  battleId: "btl_4v4",
  ticks: 30,
  snapshotCount: 1,
  keyframes: [{ tick: 0, snapshotIndex: 0 }],
  result: { winner: "red", ticks: 30, score: { red: 3, blue: 1 }, finalStateHash: "x" },
  debugOpen: false,
  roster: ROSTER8,
};

vi.mock("../src/viewer/replay-player.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/viewer/replay-player.js")>();
  const source = (): ReplaySource => ({
    index: async () => INDEX,
    segment: async () => ({ fromKeyframeTick: 0, snapshots: [{ tick: 0, vehicles: [] }], events: [] }),
  });
  return { ...real, httpReplaySource: source };
});

/** Escena falsa: registra el modo de cámara y la niebla que le pone la página. */
const sceneState: { cameraMode?: unknown; fog?: unknown } = {};
const sceneStub = new Proxy(
  {
    overlay: {
      score: { red: 0, blue: 0 },
      vehicles: new Map(ROSTER8.map((r) => [r.id, { id: r.id, team: r.team }])),
      feed: [],
    },
  },
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

describe("4v4 · lógica pura del visor", () => {
  it("título agrupado por bando con 8; con un bot por bando sigue «Alfa vs Beta»", () => {
    expect(participantsTitle(ROSTER8)).toBe(TITLE8);
    expect(
      participantsTitle([
        { id: "v1", name: "Alfa", team: "red" },
        { id: "v2", name: "Beta", team: "blue" },
      ]),
    ).toBe("Alfa vs Beta");
    // Equipos de torneo (A/B): mismo agrupado con la etiqueta tal cual.
    expect(participantsTitle(ROSTER8.map((r) => ({ ...r, team: r.team === "red" ? "A" : "B" })))).toBe(
      TITLE8.replace("(rojo)", "(A)").replace("(azul)", "(B)"),
    );
  });

  it("bandos de la nómina en orden estable y SIN bando inventado", () => {
    expect(rosterTeams(rosterFromMeta(ROSTER8))).toEqual(["red", "blue"]);
    expect(sortTeams(["blue", "B", "red", "A"])).toEqual(["red", "blue", "A", "B"]);
    expect(rosterTeams(rosterFromMeta([{ id: "v1", name: "x" }]))).toEqual([]);
    const r = rosterFromMeta(ROSTER8);
    expect(vehicleTeam(r, "veh_5")).toBe("blue");
    expect(vehicleTeam(new Map(), "veh_5", "blue")).toBe("blue");
    // Antes: `?? "red"` → un vehículo sin datos se pintaba rojo.
    expect(vehicleTeam(new Map(), "veh_x")).toBeUndefined();
  });

  it("las teclas 1–8 siguen a cada uno de los 8 vehículos", () => {
    const ids = ROSTER8.map((r) => r.id);
    const i = new CameraInteraction({ kind: "global" });
    for (let n = 1; n <= 8; n++) expect(i.onKey(String(n), ids)).toEqual({ kind: "follow", vehicleId: ids[n - 1] });
    expect(i.onKey("9", ids)).toBeNull();
  });

  it("detalle: título y resultado por bando con 8 participantes", () => {
    const participants = ROSTER8.map((r, i) => ({
      botId: r.botId,
      botName: r.name,
      version: 1,
      team: r.team,
      outcome: i < 4 ? "win" : "loss",
    }));
    expect(sidesTitle(participants, botLabel)).toBe(TITLE8);
    expect(sidesTitle(participants.slice(3, 5), botVersionLabel, { withSide: true })).toBe(
      "A-ATK-4 v1 (rojo) vs B-DEF-1 v1 (azul)",
    );
    const sides = sideResults({
      id: "b",
      status: "finished",
      participants,
      result: { winner: "red", score: { red: 3, blue: 1 } },
    });
    expect(sides.map((s) => [s.label, s.bots.length, s.score, s.outcome])).toEqual([
      ["rojo", 4, 3, "gana"],
      ["azul", 4, 1, "pierde"],
    ]);
    expect(sideResults({ id: "b", status: "running", participants, result: null }).map((s) => s.outcome)).toEqual([
      null,
      null,
    ]);
  });
});

describe("4v4 · ViewerPage con 8 participantes", () => {
  it("título por bando, cámaras y niebla de la nómina, y los 8 por nombre", async () => {
    scenario = (emit) =>
      emit("init", { finished: false, spectator: { allowFogView: true }, meta: { roster: ROSTER8 } });
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_4v4" />);
    await screen.findByText("en directo");
    expect(screen.getByTestId("viewer-title").textContent).toBe(`Batalla: ${TITLE8}`);
    expect(screen.getAllByTestId("camera-side").map((b) => b.textContent)).toEqual(["Bando rojo", "Bando azul"]);
    const fog = screen.getByLabelText("bando de la niebla") as HTMLSelectElement;
    expect(Array.from(fog.options).map((o) => o.value)).toEqual(["red", "blue"]);
    const vehicles = within(screen.getByTestId("viewer-roster")).getAllByTestId("roster-vehicle");
    expect(vehicles.map((v) => v.textContent?.replace(/^, /, ""))).toEqual([...A, ...B]);
    // «Seguir …» por NOMBRE, no por id de vehículo.
    for (const n of [...A, ...B]) expect(screen.getByRole("button", { name: `Seguir ${n}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Seguir veh_/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Bando azul" }));
    expect(sceneState.cameraMode).toEqual({ kind: "team", team: "blue" });
  });

  it("con bandos que no son red/blue (torneo A/B) los botones y la niebla son A y B", async () => {
    const roster = ROSTER8.map((r) => ({ ...r, team: r.team === "red" ? "A" : "B" }));
    scenario = (emit) => emit("init", { finished: false, spectator: { allowFogView: true }, meta: { roster } });
    const { ViewerPage } = await import("../src/pages/ViewerPage.js");
    render(<ViewerPage battleId="btl_ab" />);
    await screen.findByText("en directo");
    expect(screen.getAllByTestId("camera-side").map((b) => b.textContent)).toEqual(["Bando A", "Bando B"]);
    expect(screen.queryByText("Bando rojo")).toBeNull();
    const fog = screen.getByLabelText("bando de la niebla") as HTMLSelectElement;
    expect(Array.from(fog.options).map((o) => o.value)).toEqual(["A", "B"]);
    // La niebla se activa sobre un bando REAL de la nómina (antes: "red", inexistente aquí).
    await userEvent.click(screen.getByRole("checkbox", { name: /Niebla de guerra/ }));
    expect(sceneState.fog).toMatchObject({ enabled: true, team: "A" });
  });
});

describe("4v4 · ReplayPage con 8 participantes", () => {
  it("título por bando, cámaras de la nómina y los 8 por nombre", async () => {
    const { ReplayPage } = await import("../src/pages/ReplayPage.js");
    render(<ReplayPage battleId="btl_4v4" />);
    expect((await screen.findByTestId("replay-title")).textContent).toBe(`Replay: ${TITLE8}`);
    expect(screen.getAllByTestId("camera-side").map((b) => b.textContent)).toEqual(["Bando rojo", "Bando azul"]);
    const sides = within(screen.getByTestId("replay-roster")).getAllByTestId("roster-side");
    expect(sides.map((s) => s.getAttribute("data-team"))).toEqual(["red", "blue"]);
    expect(within(sides[0]).getAllByTestId("roster-vehicle")).toHaveLength(4);
    expect(within(sides[1]).getAllByTestId("roster-vehicle")).toHaveLength(4);
    expect(sides[0].textContent).toBe(`Bando rojo (4): ${A.join(", ")}`);
  });
});

describe("4v4 · BattleDetailPage con 8 participantes", () => {
  it("título agrupado por bando y tabla de resultado por bando", async () => {
    const battle = {
      id: "btl_4v4",
      status: "finished",
      mode: "team_deathmatch",
      mapId: "mvp-arena-01",
      mapVersion: 1,
      participants: ROSTER8.map((r, i) => ({
        botId: r.botId,
        botName: r.name,
        version: 1,
        team: r.team,
        outcome: i < 4 ? "win" : "loss",
      })),
      result: { winner: "red", ticks: 900, score: { red: 3, blue: 1 } },
      failureKind: "none",
      replayAvailable: true,
    };
    const json = (b: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn((u: string | URL) => {
        const url = String(u).replace(/^\/api\/v1/, "");
        if (url === "/battles/btl_4v4") return json(battle);
        if (url === "/battles/btl_4v4/stats") return json({ status: "pending", perBot: {}, diagnostics: {} });
        return Promise.resolve(new Response("{}", { status: 404 }));
      }) as unknown as typeof fetch,
    );
    const { BattleDetailPage } = await import("../src/pages/BattleDetailPage.js");
    render(<BattleDetailPage id="btl_4v4" />);
    const title = await screen.findByTestId("battle-title");
    expect(title.textContent).toMatch(new RegExp(`^${TITLE8.replace(/[()]/g, "\\$&")} ·`));
    const rows = within(screen.getByTestId("battle-sides")).getAllByTestId("side-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      `rojo4 · ${A.map((n) => `${n} v1`).join(", ")}3gana`,
      `azul4 · ${B.map((n) => `${n} v1`).join(", ")}1pierde`,
    ]);
    expect(screen.getAllByTestId("participant-row")).toHaveLength(8);
  });
});
