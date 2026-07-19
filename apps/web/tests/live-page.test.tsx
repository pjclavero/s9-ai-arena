// @vitest-environment jsdom
/**
 * R11 · DoD del slice mínimo de espectador público en el panel:
 *  - #/live es una ruta pública (matchPublicRoute), igual que #/viewer y #/replay;
 *  - la página pinta los tres estados de GET /public/battles/live: capability
 *    apagada (aviso claro), activada sin batallas (vacío) y activada con
 *    batallas (listado con enlace a #/viewer/<id>);
 *  - un fallo de carga se ANUNCIA (role="alert") con reintento (R3.7), nunca se
 *    pinta como lista vacía.
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
import { LivePage } from "../src/pages/LivePage.js";
import { matchPublicRoute } from "../src/App.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

describe("R11 · matchPublicRoute(#/live)", () => {
  it("reconoce #/live como ruta pública, igual que #/viewer y #/replay", () => {
    expect(matchPublicRoute("#/live")).toEqual({ kind: "live" });
    expect(matchPublicRoute("#/viewer/abc")).toEqual({ kind: "viewer", battleId: "abc" });
    expect(matchPublicRoute("#/bots")).toBeNull();
  });
});

describe("R11 · LivePage (#/live, GET /public/battles/live)", () => {
  it("capability apagada: aviso claro, no lista vacía engañosa", async () => {
    apiMock.mockResolvedValue({ enabled: false, battles: [] });
    render(<LivePage />);
    const notice = await screen.findByTestId("live-disabled");
    expect(notice.textContent).toContain("desactivada");
    expect(screen.queryByTestId("live-empty")).toBeNull();
    expect(screen.queryByTestId("live-battles")).toBeNull();
  });

  it("capability activada sin batallas: mensaje de vacío explícito", async () => {
    apiMock.mockResolvedValue({ enabled: true, battles: [] });
    render(<LivePage />);
    await screen.findByTestId("live-empty");
    expect(screen.queryByTestId("live-disabled")).toBeNull();
  });

  it("capability activada con batallas: listado con enlace a #/viewer/:id", async () => {
    apiMock.mockResolvedValue({
      enabled: true,
      battles: [
        {
          id: "battle-1",
          status: "running",
          mode: "deathmatch",
          mapId: "mvp-arena-01",
          mapName: "mvp-arena-01",
          createdAt: "2026-07-19T10:00:00Z",
          startedAt: "2026-07-19T10:00:05Z",
        },
      ],
    });
    render(<LivePage />);
    const list = await screen.findByTestId("live-battles");
    const link = list.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("#/viewer/battle-1");
    expect(link.textContent).toContain("mvp-arena-01");
    expect(link.textContent).toContain("deathmatch");
  });

  it("un fallo de carga se anuncia con role=alert y reintento (R3.7), no lista vacía", async () => {
    apiMock.mockRejectedValueOnce(new Error("gateway caído")).mockResolvedValueOnce({ enabled: true, battles: [] });
    render(<LivePage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar");
    expect(screen.queryByTestId("live-empty")).toBeNull();
    expect(screen.queryByTestId("live-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByTestId("live-empty");
  });
});
