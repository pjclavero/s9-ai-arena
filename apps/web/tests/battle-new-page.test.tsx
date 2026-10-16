// @vitest-environment jsdom
/**
 * R9 · DoD de la página de creación de batalla (#/battles/new).
 * Mockea `api`; NO toca Docker ni el runner. Verifica: crear prepared con mapa publicado
 * + 2 bots ready → POST /battles; rechazo sin mapa; botón deshabilitado con <2 bots
 * publicados; y el aviso de que el runner containerizado no se dispara desde la UI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { BattleNewPage } from "../src/pages/BattleNewPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Op", roles: ["user"] } as never;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const MAPS = [
  { mapId: "map_a", version: 2, state: "published", supportedModes: ["deathmatch"] },
  { mapId: "map_draft", version: 1, state: "draft", supportedModes: ["deathmatch"] },
  { mapId: "map_ctf", version: 1, state: "published", supportedModes: ["capture_the_flag"] },
];
// FC-C · lo que sirve GET /rulesets: ids de la tabla `rulesets` (no los del motor).
const RULESETS = {
  modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
  items: [
    { id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 },
    { id: "capture-the-flag-mvp", name: "CTF", mode: "capture_the_flag", budgetCredits: 1000 },
  ],
};
const BOTS = [
  { id: "bot_r", name: "Red", latestPublishedVersion: 3 },
  { id: "bot_b", name: "Blue", latestPublishedVersion: 1 },
  { id: "bot_np", name: "NoPub", latestPublishedVersion: null },
];

function mockLists(maps: unknown[], bots: unknown[], runCap = { enabled: false, available: false }) {
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: maps });
    if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: bots });
    if (method === "GET" && path === "/rulesets") return Promise.resolve(RULESETS);
    if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
    if (method === "GET" && path === "/system/status") return Promise.resolve({ realBattleRuns: runCap });
    if (method === "POST" && path === "/battles") return Promise.resolve({ id: "btl_1" });
    if (method === "POST" && path === "/battles/btl_1/run")
      return Promise.resolve({ status: "completed", replay: { ingested: true } });
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
}

describe("R9 · #/battles/new", () => {
  it("crea una batalla prepared con mapa publicado y 2 bots ready → POST /battles", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("mapa");
    await userEvent.selectOptions(screen.getByLabelText("mapa"), "map_a@2");
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    await userEvent.selectOptions(screen.getByLabelText("bot azul"), "bot_b");
    await userEvent.click(screen.getByText("Crear batalla"));
    await screen.findByText(/creada y encolada/i);

    const post = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/battles");
    expect(post).toBeTruthy();
    expect(post![2]).toMatchObject({
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp", // el id que sirvió la API, no uno hardcodeado
      mapId: "map_a",
      mapVersion: 2,
      participants: [
        { botId: "bot_r", version: 3, team: "red" },
        { botId: "bot_b", version: 1, team: "blue" },
      ],
    });
  });

  it("solo ofrece mapas publicados (el draft no aparece)", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    const mapSel = (await screen.findByLabelText("mapa")) as HTMLSelectElement;
    const values = Array.from(mapSel.options).map((o) => o.value);
    expect(values).toContain("map_a@2");
    expect(values).not.toContain("map_draft@1");
    // FC-C · y solo los que soportan el modo elegido
    expect(values).not.toContain("map_ctf@1");
  });

  it("FC-C · modos y rulesets vienen de GET /rulesets; al cambiar de modo cambian ruleset y mapas", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    const modeSel = (await screen.findByLabelText("modo")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "zone_control" });
    expect(Array.from(modeSel.options).map((o) => o.value)).toEqual(RULESETS.modes);
    await userEvent.selectOptions(modeSel, "capture_the_flag");
    expect((screen.getByLabelText("ruleset") as HTMLSelectElement).value).toBe("capture-the-flag-mvp");
    const maps = Array.from((screen.getByLabelText("mapa") as HTMLSelectElement).options).map((o) => o.value);
    expect(maps).toEqual(["", "map_ctf@1"]);
  });

  it("rechaza crear sin mapa", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("bot rojo");
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    await userEvent.selectOptions(screen.getByLabelText("bot azul"), "bot_b");
    await userEvent.click(screen.getByText("Crear batalla"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/mapa/i);
    expect(apiMock.mock.calls.some((c) => c[0] === "POST")).toBe(false);
  });

  it("botón deshabilitado con menos de 2 bots publicados", async () => {
    mockLists(MAPS, [BOTS[0], BOTS[2]]); // solo 1 con versión publicada
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("mapa");
    expect((screen.getByText("Crear batalla") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/al menos 2 bots/i)).toBeTruthy();
  });

  it("avisa de que el runner containerizado NO se dispara desde la UI", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    const note = await screen.findByRole("note");
    expect(note.textContent ?? "").toMatch(/runner containerizado/i);
  });

  async function createBattle() {
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("mapa");
    await userEvent.selectOptions(screen.getByLabelText("mapa"), "map_a@2");
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    await userEvent.selectOptions(screen.getByLabelText("bot azul"), "bot_b");
    await userEvent.click(screen.getByText("Crear batalla"));
    await screen.findByText(/creada y encolada/i);
  }

  it("R6.2/R9-B · botón Run DESHABILITADO si el backend no lo permite", async () => {
    mockLists(MAPS, BOTS, { enabled: false, available: false });
    await createBattle();
    const run = screen.getByTestId("run-real") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByText(/Ejecución real no disponible/i)).toBeTruthy();
  });

  it("R6.2/R9-B · botón Run HABILITADO y ejecuta cuando el backend dice available", async () => {
    mockLists(MAPS, BOTS, { enabled: true, available: true });
    await createBattle();
    const run = screen.getByTestId("run-real") as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    await userEvent.click(run);
    await screen.findByText(/completed/i);
    const post = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/battles/btl_1/run");
    expect(post).toBeTruthy();
    expect((screen.getByText("ver replay") as HTMLAnchorElement).getAttribute("href")).toBe("#/replay/btl_1");
  });
});
