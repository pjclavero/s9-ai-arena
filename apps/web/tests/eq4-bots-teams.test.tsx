// @vitest-environment jsdom
/**
 * EQ4 · «Mis bots» y «Equipos» en maestro-detalle.
 *  - Activos/Retirados: los retirados no están en la lista principal (van en un
 *    desplegable) y «Retirar bot» llama a PATCH /bots/{id} { retired } — no borra;
 *  - el detalle (derecha) es del bot seleccionado, con resumen, secciones y
 *    enlaces a Batallas y Replays filtrados por ese bot;
 *  - Equipos: lista a la izquierda y configurador del equipo seleccionado.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  setToken: vi.fn(),
  getToken: vi.fn(() => "tok"),
  onSessionExpired: vi.fn(),
  bootstrapSession: vi.fn(),
  logout: vi.fn(),
  ApiRequestError: class extends Error {},
}));

import { api } from "../src/api.js";
import { BotsPage } from "../src/pages/BotsPage.js";
import { TeamsPage } from "../src/pages/TeamsPage.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
const catalog = loadCatalog();

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  window.location.hash = "";
});

const BOTS = [
  { id: "b1", name: "Activo-1", visibility: "private", latestPublishedVersion: 2, retiredAt: null },
  { id: "b2", name: "Viejo", visibility: "team", retiredAt: "2026-10-01T00:00:00.000Z" },
];

function mockBots() {
  apiMock.mockImplementation((m: string, p: string) => {
    if (m === "GET" && p.startsWith("/bots?ownerId")) return Promise.resolve({ items: BOTS });
    if (m === "GET" && /\/versions$/.test(p)) return Promise.resolve([]);
    if (m === "GET" && /\/loadouts$/.test(p)) return Promise.resolve([]);
    if (m === "GET" && /\/builds/.test(p)) return Promise.resolve([]);
    if (m === "PATCH") return Promise.resolve({ ...BOTS[0], retiredAt: "2026-11-02T00:00:00.000Z" });
    return Promise.resolve({});
  });
}

describe("EQ4 · Mis bots: Activos / Retirados y maestro-detalle", () => {
  it("los retirados no saturan la lista principal (desplegable aparte, sin borrarse)", async () => {
    mockBots();
    render(<BotsPage me={ME} catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={1000} />);
    const active = await screen.findByTestId("bots-active");
    expect(within(active).getByRole("button", { name: "Activo-1" })).toBeTruthy();
    expect(within(active).queryByRole("button", { name: "Viejo" })).toBeNull();
    const retired = screen.getByTestId("bots-retired");
    expect(retired.tagName).toBe("DETAILS");
    expect((retired as HTMLDetailsElement).open).toBe(false);
    expect(within(retired).getByText("Retirados (1)")).toBeTruthy();
    expect(within(retired).getByRole("button", { name: "Viejo" })).toBeTruthy();
    expect(screen.getByText("Activos (1)")).toBeTruthy();
  });

  it("sin selección, el panel derecho invita a elegir; al elegir, resumen + secciones + enlaces filtrados", async () => {
    mockBots();
    render(<BotsPage me={ME} catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={1000} />);
    await screen.findByTestId("bots-active");
    expect(screen.getByTestId("bot-pane-empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Activo-1" }));
    const summary = await screen.findByTestId("bot-summary");
    expect(within(summary).getByRole("heading", { name: "Activo-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activo-1" }).getAttribute("aria-current")).toBe("true");
    const sections = within(summary).getByRole("navigation", { name: "secciones de Activo-1" });
    expect(within(sections).getByRole("button", { name: "Loadout" })).toBeTruthy();
    expect(within(sections).getByRole("button", { name: "Código / Versiones" })).toBeTruthy();
    expect(within(sections).getByRole("button", { name: "Build / Pipeline" })).toBeTruthy();
    expect(screen.getByTestId("bot-battles-link").getAttribute("href")).toBe("#/battles?bot=b1");
    expect(screen.getByTestId("bot-replays-link").getAttribute("href")).toBe("#/replays?bot=b1");
    expect(screen.queryByTestId("bot-pane-empty")).toBeNull();
  });

  it("«Retirar bot» usa PATCH { retired:true } (no DELETE) y explica que no borra historial", async () => {
    mockBots();
    render(<BotsPage me={ME} catalog={catalog} catalogVersion={CATALOG_VERSION} budgetCredits={1000} />);
    await screen.findByTestId("bots-active");
    fireEvent.click(screen.getByRole("button", { name: "Activo-1" }));
    const btn = await screen.findByTestId("bot-retire");
    expect(btn.textContent).toBe("Retirar bot");
    expect(screen.getByTestId("bot-summary").textContent).toMatch(/no borra versiones, batallas ni replays/);
    fireEvent.click(btn);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("PATCH", "/bots/b1", { retired: true }));
    expect(apiMock.mock.calls.some((c) => c[0] === "DELETE")).toBe(false);
    await waitFor(() => expect(screen.getByTestId("bot-retire").textContent).toBe("Reactivar bot"));
  });
});

const TEAMS = [
  {
    id: "t1",
    name: "Rojos",
    memberCount: 1,
    botCount: 0,
    isCaptain: true,
    isMember: true,
    members: [{ userId: "u1", displayName: "Ana", role: "captain" }],
    bots: [],
  },
  {
    id: "t2",
    name: "Azules",
    memberCount: 2,
    botCount: 1,
    isCaptain: false,
    isMember: true,
    members: [
      { userId: "u9", displayName: "Zoe", role: "captain" },
      { userId: "u1", displayName: "Ana", role: "member" },
    ],
    bots: [{ id: "b7", name: "zoebot" }],
  },
];

describe("EQ4 · Equipos: lista y configurador del seleccionado", () => {
  it("izquierda: mis equipos; derecha: sólo el seleccionado, con acciones según el rol", async () => {
    apiMock.mockImplementation((m: string, p: string) =>
      Promise.resolve(p.startsWith("/teams") ? { items: TEAMS } : { items: [] }),
    );
    render(<TeamsPage me={ME as never} />);
    const list = await screen.findByTestId("teams-list");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Rojos", "Azules"]);
    // por defecto el primero
    expect(screen.getByRole("region", { name: "equipo Rojos" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "equipo Azules" })).toBeNull();
    expect(screen.getByRole("region", { name: "equipo Rojos" }).textContent).toMatch(/como capitán/);
    fireEvent.click(within(list).getByRole("button", { name: "Azules" }));
    const az = await screen.findByRole("region", { name: "equipo Azules" });
    expect(az.textContent).toMatch(/como miembro/);
    expect(within(az).queryByLabelText("renombrar-Azules")).toBeNull(); // no es capitán
    expect(within(az).getByTestId("team-replays-link").getAttribute("href")).toBe("#/replays?team=t2");
    expect(screen.queryByRole("region", { name: "equipo Rojos" })).toBeNull();
  });

  it("un equipo recién creado queda seleccionado", async () => {
    let created = false;
    apiMock.mockImplementation((m: string, p: string) => {
      if (m === "POST" && p === "/teams") {
        created = true;
        return Promise.resolve({});
      }
      if (p.startsWith("/teams"))
        return Promise.resolve({
          items: created
            ? [...TEAMS, { id: "t3", name: "Nuevos", memberCount: 1, botCount: 0, isCaptain: true, isMember: true }]
            : TEAMS,
        });
      return Promise.resolve({ items: [] });
    });
    render(<TeamsPage me={ME as never} />);
    await screen.findByTestId("teams-list");
    fireEvent.change(screen.getByLabelText("nuevo-equipo"), { target: { value: "Nuevos" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear equipo" }));
    expect(await screen.findByRole("region", { name: "equipo Nuevos" })).toBeTruthy();
  });
});
