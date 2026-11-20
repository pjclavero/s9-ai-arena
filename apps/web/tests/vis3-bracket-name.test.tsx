// @vitest-environment jsdom
/**
 * VISIBILIDAD-3 · P3-6 · «bracket con nombre» (§13 del encargo). El cuadro del
 * torneo pinta el NOMBRE de competición del ganador (`winnerBotName`, que la API
 * sólo da cuando el solicitante puede identificarlo: torneo con `broadcast` o bot
 * visible), nunca el prefijo del id. Un ganador oculto (torneo sin broadcast)
 * sigue saliendo como «Bot privado», sin nombre ni id.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
afterEach(cleanup);
beforeEach(() => apiMock.mockReset());

const BOT_ID = "0f3a9c1e-1111-4222-8333-444455556666";
const base = { round: 1, slot: "r1m1", pairing: {}, state: "finished", winnerTeamId: null, final: true };

describe("VISIBILIDAD-3 · P3-6 · cuadro con nombre", () => {
  it("torneo con broadcast: el ganador privado sale con su nombre de competición, no `bot <8 hex>`", async () => {
    apiMock.mockResolvedValue({ matches: [{ ...base, id: "m1", winnerBotId: BOT_ID, winnerBotName: "A-DEF" }] });
    render(<BracketPage id="tb" />);
    const w = await screen.findByTestId("bracket-winner");
    expect(w.textContent).toContain("A-DEF");
    expect(w.textContent).not.toContain(BOT_ID.slice(0, 8));
  });

  it("torneo sin broadcast: el ganador oculto sigue como «Bot privado», sin nombre ni id", async () => {
    apiMock.mockResolvedValue({ matches: [{ ...base, id: "m1", winnerBotId: null, winnerPrivate: true }] });
    render(<BracketPage id="tn" />);
    const w = await screen.findByTestId("bracket-winner");
    expect(w.textContent).toContain("Bot privado");
    expect(w.textContent).not.toContain("A-DEF");
    expect(w.textContent).not.toMatch(/[0-9a-f]{8}/);
  });

  it("sin nombre en la respuesta (cliente con API anterior): cae al prefijo del id", async () => {
    apiMock.mockResolvedValue({ matches: [{ ...base, id: "m1", winnerBotId: BOT_ID }] });
    render(<BracketPage id="tx" />);
    const w = await screen.findByTestId("bracket-winner");
    expect(w.textContent).toContain(`bot ${BOT_ID.slice(0, 8)}`);
  });
});
