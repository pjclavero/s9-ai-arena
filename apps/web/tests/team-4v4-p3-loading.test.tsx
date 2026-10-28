// @vitest-environment jsdom
/**
 * 4v4 · T-UI · Defecto P3 (BattleNewPage `:223`, `:353`, `:420`).
 *
 * `versionsByBot[id] ?? null` confundía «todavía cargando» (clave ausente) con
 * «falló» (`null`): mientras GET /bots/{id}/versions estaba en vuelo, la página ya
 * decía «no se pudieron cargar sus otras versiones». Ahora:
 *  - en vuelo → «cargando sus versiones…», NUNCA el texto de fallo;
 *  - fallo REAL de la petición → «no se pudieron cargar sus otras versiones».
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const BOTS = [
  { id: "bot_r", name: "Red", latestPublishedVersion: 3, ownerId: "u1" },
  { id: "bot_b", name: "Blue", latestPublishedVersion: 1, ownerId: "u1" },
];

function mockWithVersions(versions: (botId: string) => Promise<unknown>) {
  apiMock.mockImplementation((method: string, path: string) => {
    if (path === "/maps?limit=100")
      return Promise.resolve({
        items: [{ mapId: "m", version: 1, state: "published", supportedModes: ["deathmatch", "team_deathmatch"] }],
      });
    if (path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
    if (path === "/rulesets")
      return Promise.resolve({
        modes: ["deathmatch", "team_deathmatch"],
        items: [{ id: "dm", name: "DM", mode: null, budgetCredits: 1000 }],
      });
    if (path === "/teams?limit=100") return Promise.resolve({ items: [] });
    const m = /^\/bots\/([^/]+)\/versions$/.exec(path);
    if (method === "GET" && m) return versions(decodeURIComponent(m[1]));
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
}

describe("4v4 · P3 · «cargando» no es «falló»", () => {
  it("mientras se cargan las versiones NO dice «no se pudieron cargar» (dice que está cargando)", async () => {
    // Las versiones nunca responden durante el test: siguen en vuelo.
    mockWithVersions(() => new Promise(() => undefined));
    render(<BattleNewPage me={ME} />);
    await screen.findAllByRole("option", { name: /^Red/ });
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    const status = screen.getByTestId("bot-status-rojo");
    expect(status.textContent).not.toMatch(/no se pudieron cargar/);
    expect(status.textContent).toMatch(/cargando sus versiones/);
  });

  it("si la petición de versiones FALLA de verdad, entonces sí lo dice", async () => {
    mockWithVersions(() => Promise.reject(Object.assign(new Error("boom"), { status: 500 })));
    render(<BattleNewPage me={ME} />);
    await screen.findAllByRole("option", { name: /^Red/ });
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    await waitFor(() =>
      expect(screen.getByTestId("bot-status-rojo").textContent).toMatch(/no se pudieron cargar sus otras versiones/),
    );
    expect(screen.getByTestId("bot-status-rojo").textContent).not.toMatch(/cargando/);
  });

  it("con las versiones cargadas no aparece ninguno de los dos avisos", async () => {
    mockWithVersions(async (id) =>
      id === "bot_r"
        ? [
            { version: 3, state: "published" },
            { version: 2, state: "published" },
          ]
        : [{ version: 1, state: "published" }],
    );
    render(<BattleNewPage me={ME} />);
    await screen.findAllByRole("option", { name: /^Red/ });
    await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
    // Cargadas: el selector ofrece las DOS versiones publicadas y no hay aviso.
    await waitFor(() => expect((screen.getByLabelText("versión rojo") as HTMLSelectElement).options.length).toBe(2));
    expect(screen.getByTestId("bot-status-rojo").textContent).not.toMatch(/no se pudieron cargar|cargando/);
  });
});
