// @vitest-environment jsdom
/**
 * R9 · DoD de la página de creación de batalla (#/battles/new).
 * Mockea `api`; NO toca Docker ni el runner. Verifica: crear prepared con mapa publicado
 * + 2 bots ready → POST /battles; rechazo sin mapa; botón deshabilitado con <2 bots
 * publicados. REVIEW (R4.6): crear = ejecutar (lo hace el tournament-worker); no hay
 * botón «Ejecutar batalla real» ni llamada a /run ni a /system/status; los errores de
 * carga y de envío usan los componentes comunes de D (ErrorState / FormError).
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

  it("avisa de que la batalla la ejecuta el worker con la versión publicada de cada bot", async () => {
    mockLists(MAPS, BOTS);
    render(<BattleNewPage me={ME} />);
    const note = await screen.findByRole("note");
    expect(note.textContent ?? "").toMatch(/la ejecuta el worker/i);
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

  it("REVIEW R4.6 · tras crear NO hay botón de ejecución real ni se llama a /run o /system/status", async () => {
    mockLists(MAPS, BOTS, { enabled: true, available: true });
    await createBattle();
    expect(screen.queryByTestId("run-real")).toBeNull();
    expect(screen.queryByText(/Ejecutar batalla real/i)).toBeNull();
    const paths = apiMock.mock.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(paths.some((p) => p.endsWith("/run"))).toBe(false);
    expect(paths).not.toContain("GET /system/status");
    expect((screen.getByRole("link", { name: "Batallas" }) as HTMLAnchorElement).getAttribute("href")).toBe(
      "#/battles",
    );
  });

  it("REVIEW R4.8 · un 409 del servidor al crear se muestra con FormError (no se traga)", async () => {
    apiMock.mockImplementation((method: string, path: string) => {
      if (method === "POST" && path === "/battles") {
        return Promise.reject(
          Object.assign(new Error("El mapa map_a v2 no soporta el modo deathmatch"), {
            status: 409,
            kind: "http",
            body: { error: "map_mode_unsupported", message: "El mapa map_a v2 no soporta el modo deathmatch" },
          }),
        );
      }
      if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
      if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
      if (method === "GET" && path === "/rulesets") return Promise.resolve(RULESETS);
      if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<BattleNewPage me={ME} />);
    await screen.findByLabelText("mapa");
    await userEvent.selectOptions(screen.getByLabelText("mapa"), "map_a@2");
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    await userEvent.selectOptions(screen.getByLabelText("bot azul"), "bot_b");
    await userEvent.click(screen.getByText("Crear batalla"));
    const fe = await screen.findByTestId("form-error");
    expect(fe.textContent ?? "").toMatch(/no soporta el modo deathmatch/);
  });

  it("REVIEW R4.8 · si falla la carga se pinta ErrorState con Reintentar, no una lista vacía", async () => {
    apiMock.mockImplementation(() => Promise.reject(Object.assign(new Error("boom"), { status: 503, kind: "http" })));
    render(<BattleNewPage me={ME} />);
    const err = await screen.findByTestId("resource-error-mapas,-bots-y-rulesets");
    expect(err.textContent ?? "").toMatch(/No se pudo cargar/);
  });
});
