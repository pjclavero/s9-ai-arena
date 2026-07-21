// @vitest-environment jsdom
/**
 * N6 (entrega A) · DoD de la página pública de solo lectura #/ranking:
 *  - #/ranking es una ruta pública (matchPublicRoute), igual que #/live;
 *  - la página pinta GET /standings?mode=<modo> (Standing[]): datos → filas
 *    con rank/botName/rating/V-D-E; vacío → mensaje claro (nunca lista vacía
 *    engañosa); fallo de carga → se ANUNCIA (role="alert") con reintento (R3.7);
 *  - cambiar el selector de modo recarga el recurso con el nuevo `mode`.
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
import { RankingPage } from "../src/pages/RankingPage.js";
import { matchPublicRoute } from "../src/App.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

describe("N6 · matchPublicRoute(#/ranking)", () => {
  it("reconoce #/ranking como ruta pública, igual que #/live", () => {
    expect(matchPublicRoute("#/ranking")).toEqual({ kind: "ranking" });
    expect(matchPublicRoute("#/live")).toEqual({ kind: "live" });
    expect(matchPublicRoute("#/bots")).toBeNull();
  });
});

describe("N6 · RankingPage (#/ranking, GET /standings)", () => {
  it("con datos: pinta filas con rank, botName, rating y V-D-E", async () => {
    apiMock.mockResolvedValue([
      { rank: 1, botId: "bot-1", botName: "Vector", rating: 1500, wins: 10, losses: 2, draws: 1 },
      { rank: 2, botId: "bot-2", botName: "Nimbus", rating: 1420, wins: 8, losses: 4, draws: 0 },
    ]);
    render(<RankingPage />);
    const rows = await screen.findAllByTestId("ranking-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("1");
    expect(rows[0].textContent).toContain("Vector");
    expect(rows[0].textContent).toContain("1500");
    expect(rows[0].textContent).toContain("10-2-1");
    expect(apiMock).toHaveBeenCalledWith("GET", "/standings?mode=deathmatch");
  });

  it("vacío: mensaje claro, no lista vacía engañosa", async () => {
    apiMock.mockResolvedValue([]);
    render(<RankingPage />);
    const empty = await screen.findByTestId("ranking-empty");
    expect(empty.textContent).toContain("Todavía no hay clasificación");
    expect(screen.queryByTestId("ranking-table")).toBeNull();
  });

  it("un fallo de carga se anuncia con role=alert y reintento (R3.7), no lista vacía", async () => {
    apiMock.mockRejectedValueOnce(new Error("gateway caído")).mockResolvedValueOnce([]);
    render(<RankingPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar");
    expect(screen.queryByTestId("ranking-empty")).toBeNull();
    expect(screen.queryByTestId("ranking-table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByTestId("ranking-empty");
  });

  it("cambiar el modo recarga con el nuevo `mode`", async () => {
    apiMock.mockResolvedValue([]);
    render(<RankingPage />);
    await screen.findByTestId("ranking-empty");
    apiMock.mockClear();
    apiMock.mockResolvedValue([
      { rank: 1, botId: "bot-1", botName: "Vector", rating: 1500, wins: 1, losses: 0, draws: 0 },
    ]);
    fireEvent.change(screen.getByTestId("ranking-mode"), { target: { value: "capture_the_flag" } });
    await screen.findByTestId("ranking-row");
    expect(apiMock).toHaveBeenCalledWith("GET", "/standings?mode=capture_the_flag");
  });
});
