// @vitest-environment jsdom
/**
 * #291 · Web: «Cerrar inscripciones» sólo para quien gestiona el torneo (lo dice la API
 * con `viewerCanManage`: dueño o staff). La inscripción del propio bot sigue para todos.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
import { TournamentDetailPage } from "../src/pages/TournamentDetailPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };
let calls: { method: string; path: string }[];

function mockDetail(extra: Record<string, unknown>) {
  apiMock.mockImplementation(async (method: string, path: string) => {
    calls.push({ method, path });
    if (path === "/tournaments/t1")
      return { id: "t1", name: "Copa 291", format: "round_robin", mode: "deathmatch", state: "open", ...extra };
    if (path === "/tournaments/t1/battles") return { items: [] };
    if (path.startsWith("/bots?ownerId=")) return { items: [] };
    if (method === "POST" && path === "/tournaments/t1/actions/close-entries") return {};
    throw new Error(`inesperado: ${method} ${path}`);
  });
}

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
  calls = [];
});

describe("#291 · Cerrar inscripciones según viewerCanManage", () => {
  it("TW-291-1 quien gestiona el torneo ve el botón y cierra", async () => {
    mockDetail({ viewerCanManage: true });
    render(<TournamentDetailPage id="t1" me={ME} />);
    const btn = await screen.findByTestId("close-entries");
    await userEvent.click(btn);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", path: "/tournaments/t1/actions/close-entries" }),
    );
  });

  for (const [label, extra] of [
    ["viewerCanManage=false (organizador ajeno, user)", { viewerCanManage: false }],
    ["sin viewerCanManage (API antigua o anónimo)", {}],
  ] as const) {
    it(`TW-291-2 ${label}: no hay botón, pero sí la inscripción del propio bot`, async () => {
      mockDetail(extra);
      render(<TournamentDetailPage id="t1" me={ME} />);
      expect(await screen.findByRole("button", { name: "Inscribir" })).toBeTruthy();
      expect(screen.queryByTestId("close-entries")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cerrar inscripciones" })).toBeNull();
    });
  }
});
