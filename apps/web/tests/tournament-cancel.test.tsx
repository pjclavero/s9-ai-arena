// @vitest-environment jsdom
/**
 * #288 · Web: «Cancelar» en la creación (no hace POST ni deja nada a medias) y
 * «Cancelar torneo» en el detalle (sólo a quien lo administra, sólo en estados
 * cancelables, siempre con confirmación; en los demás, el motivo).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
import { TournamentsPage } from "../src/pages/TournamentsPage.js";
import { TournamentDetailPage, CANCEL_CONFIRM_TEXT } from "../src/pages/TournamentDetailPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  apiMock.mockReset();
  window.location.hash = "";
});

const posts = () => apiMock.mock.calls.filter((c) => c[0] !== "GET");

describe("#288 · Cancelar la creación", () => {
  it("TW-C1 rellenar y pulsar Cancelar: ningún POST, formulario limpio y de vuelta al listado", async () => {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/tournaments") return { items: [] };
      throw new Error(`inesperado: ${method} ${path}`);
    });
    window.location.hash = "#/tournaments/nuevo";
    render(<TournamentsPage me={ME} />);
    await screen.findByText("No hay torneos todavía.");
    await userEvent.type(screen.getByLabelText("nombre del torneo"), "Copa a medias");
    await userEvent.click(screen.getByTestId("tournament-broadcast"));
    const cancel = screen.getByTestId("cancel-create-tournament");
    expect(cancel.getAttribute("type")).toBe("button"); // nunca envía el formulario
    await userEvent.click(cancel);
    expect(posts()).toEqual([]);
    expect((screen.getByLabelText("nombre del torneo") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("tournament-broadcast") as HTMLInputElement).checked).toBe(false);
    expect(window.location.hash).toBe("#/tournaments");
    // Y después, crear de verdad sigue funcionando (sin arrastrar lo cancelado).
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET") return { items: [] };
      if (method === "POST" && path === "/tournaments") return { id: "t-ok", name: "Copa buena" };
      throw new Error(`inesperado: ${method} ${path}`);
    });
    await userEvent.type(screen.getByLabelText("nombre del torneo"), "Copa buena{Enter}");
    await waitFor(() =>
      expect(posts()).toEqual([
        [
          "POST",
          "/tournaments",
          {
            name: "Copa buena",
            format: "single_elimination",
            mode: "deathmatch",
            rulesetId: "mvp-default",
            broadcast: false,
          },
        ],
      ]),
    );
  });
});

function mockDetail(t: Record<string, unknown>, onPost?: (path: string) => unknown) {
  apiMock.mockImplementation(async (method: string, path: string) => {
    if (method === "GET" && path === "/tournaments/t1")
      return { id: "t1", name: "Copa", format: "league", mode: "deathmatch", entryCount: 2, ...t };
    if (method === "GET" && path === "/tournaments/t1/battles") return { items: [] };
    if (method === "GET" && path.startsWith("/bots?")) return { items: [] };
    if (method === "POST" && onPost) return onPost(path);
    throw new Error(`inesperado: ${method} ${path}`);
  });
}

describe("#288 · Cancelar torneo (detalle)", () => {
  it("TW-D1 sin confirmar no se envía nada; confirmando, POST a /actions/cancel", async () => {
    let state = "open";
    mockDetail({ state: "open", viewerCanManage: true }, (path) => {
      state = "cancelled";
      return { id: "t1", state, path };
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const btn = await screen.findByTestId("cancel-tournament");
    await userEvent.click(btn);
    expect(confirm).toHaveBeenCalledWith(CANCEL_CONFIRM_TEXT);
    expect(CANCEL_CONFIRM_TEXT).toContain("No se borra nada");
    expect(posts()).toEqual([]);
    confirm.mockReturnValue(true);
    await userEvent.click(btn);
    await waitFor(() => expect(posts()).toEqual([["POST", "/tournaments/t1/actions/cancel", {}]]));
    expect((await screen.findByRole("status")).textContent).toContain("Torneo cancelado");
  });

  it("TW-D2 quien no lo administra no ve el botón", async () => {
    mockDetail({ state: "open", viewerCanManage: false });
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByTestId("tournament-state");
    expect(screen.queryByTestId("cancel-tournament")).toBeNull();
    expect(screen.queryByTestId("cancel-tournament-blocked")).toBeNull();
  });

  for (const [state, text] of [
    ["closed", "Ya no se puede cancelar"],
    ["running", "Ya no se puede cancelar"],
    ["finished", "ya ha terminado"],
  ] as const) {
    it(`TW-D3 ${state}: sin botón y con el motivo`, async () => {
      mockDetail({ state, viewerCanManage: true });
      render(<TournamentDetailPage id="t1" me={ME} />);
      const why = await screen.findByTestId("cancel-tournament-blocked");
      expect(why.textContent).toContain(text);
      expect(screen.queryByTestId("cancel-tournament")).toBeNull();
    });
  }

  it("TW-D4 draft también se puede cancelar; cancelled no ofrece nada", async () => {
    mockDetail({ state: "draft", viewerCanManage: true });
    render(<TournamentDetailPage id="t1" me={ME} />);
    expect(await screen.findByTestId("cancel-tournament")).toBeTruthy();
    cleanup();
    mockDetail({ state: "cancelled", viewerCanManage: true });
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByTestId("tournament-state");
    expect(screen.queryByTestId("cancel-tournament")).toBeNull();
  });

  it("TW-D5 si la API rechaza, el error se anuncia (role=alert)", async () => {
    mockDetail({ state: "open", viewerCanManage: true }, () => {
      throw new Error("Las inscripciones ya están cerradas y el calendario generado o en juego: no se puede cancelar");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TournamentDetailPage id="t1" me={ME} />);
    await userEvent.click(await screen.findByTestId("cancel-tournament"));
    expect((await screen.findByRole("alert")).textContent).toContain("no se puede cancelar");
  });
});
