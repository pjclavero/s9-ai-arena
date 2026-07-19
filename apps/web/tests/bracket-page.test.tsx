// @vitest-environment jsdom
/**
 * R12 (slice 1, solo lectura) · DoD del cuadro de torneo en el panel:
 *  - #/tournaments/:id/bracket resuelve a BracketPage, NO al detalle
 *    (matchPanelRoute mira el patrón de cuadro antes que el de detalle);
 *  - GET /tournaments/:id/matches vacío → mensaje claro (bracket-empty),
 *    nunca una lista vacía engañosa (R3.7, ERR-VIS-10);
 *  - con matches → rondas agrupadas y ganador visible;
 *  - un fallo de carga se ANUNCIA (role="alert") con reintento.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  setToken: vi.fn(),
  getToken: vi.fn(() => null),
  onSessionExpired: vi.fn(),
  bootstrapSession: vi.fn(),
  logout: vi.fn(),
  ApiRequestError: class extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>) {
      super(String(body?.message ?? `HTTP ${status}`));
      this.status = status;
      this.body = body;
    }
  },
}));

import { api } from "../src/api.js";
import { BracketPage } from "../src/pages/BracketPage.js";
import { matchPanelRoute } from "../src/App.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

describe("R12 · matchPanelRoute(#/tournaments/:id/bracket)", () => {
  it("resuelve al cuadro, NO al detalle", () => {
    expect(matchPanelRoute("#/tournaments/abc/bracket")).toEqual({ kind: "tournamentBracket", id: "abc" });
    expect(matchPanelRoute("#/tournaments/abc")).toEqual({ kind: "tournament", id: "abc" });
    expect(matchPanelRoute("#/tournaments/abc/battles")).toEqual({ kind: "tournament", id: "abc" });
  });

  it("decodifica el id (URL-encoded)", () => {
    expect(matchPanelRoute("#/tournaments/a%2Fb/bracket")).toEqual({ kind: "tournamentBracket", id: "a/b" });
  });
});

describe("R12 · BracketPage (GET /tournaments/:id/matches)", () => {
  it("torneo sin cuadro generado: mensaje claro, no lista vacía engañosa", async () => {
    apiMock.mockResolvedValue({ matches: [] });
    render(<BracketPage id="t1" />);
    const empty = await screen.findByTestId("bracket-empty");
    expect(empty.textContent).toContain("no se ha generado");
    expect(screen.queryByTestId("bracket-rounds")).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("GET", "/tournaments/t1/matches");
  });

  it("con matches: agrupa por ronda y muestra el ganador", async () => {
    apiMock.mockResolvedValue({
      matches: [
        {
          id: "m1",
          round: 1,
          slot: "r1m1",
          pairing: {},
          state: "finished",
          winnerBotId: "bot-a",
          winnerTeamId: null,
          final: false,
        },
        {
          id: "m2",
          round: 2,
          slot: "r2m1",
          pairing: {},
          state: "scheduled",
          winnerBotId: null,
          winnerTeamId: null,
          final: true,
        },
      ],
    });
    render(<BracketPage id="t1" />);
    const rounds = await screen.findByTestId("bracket-rounds");
    expect(rounds.textContent).toContain("Ronda 1");
    expect(rounds.textContent).toContain("Ronda 2");
    const winner = screen.getByTestId("bracket-winner");
    expect(winner.textContent).toContain("bot-a");
    expect(screen.getByTestId("bracket-final-mark")).toBeDefined();
    expect(screen.queryByTestId("bracket-empty")).toBeNull();
  });

  it("fallo de carga: role=alert con reintento (R3.7), nunca vacío engañoso", async () => {
    apiMock.mockRejectedValueOnce(new Error("gateway caído")).mockResolvedValueOnce({ matches: [] });
    render(<BracketPage id="t1" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar");
    expect(screen.queryByTestId("bracket-empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByTestId("bracket-empty");
  });
});
