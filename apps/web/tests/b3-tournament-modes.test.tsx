// @vitest-environment jsdom
/**
 * B3 (V1, D-OP-9) · El formulario de crear torneo NO ofrece Captura la bandera ni Control de zona.
 * La API es la autoridad (400 tournament_mode_not_allowed); la web no ofrece lo que se va a rechazar.
 * Etiquetas `B3W_*` para el script de mutantes.
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
import { TournamentsPage, TOURNAMENT_CREATE_MODES } from "../src/pages/TournamentsPage.js";
import { TOURNAMENT_ALLOWED_MODES } from "../../tournament-worker/src/tournament-modes.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };
const OLD = {
  id: "t-old",
  name: "Copa antigua",
  format: "round_robin",
  mode: "capture_the_flag",
  rulesetId: "capture-the-flag-mvp",
  state: "finished",
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === "GET" && path === "/tournaments") return Promise.resolve({ items: [OLD] });
    return Promise.resolve({ items: [] });
  });
});
afterEach(() => cleanup());

const optionValues = (el: HTMLElement) => Array.from((el as HTMLSelectElement).options).map((o) => o.value);

describe("B3 · formulario de crear torneo", () => {
  it("B3W_NO_CTF_ZONE · el selector de modo sólo ofrece Deathmatch y Deathmatch por equipos", async () => {
    render(<TournamentsPage me={ME as never} />);
    const modo = await screen.findByLabelText("modo");
    expect(optionValues(modo)).toEqual(["deathmatch", "team_deathmatch"]);
    expect(optionValues(modo)).not.toContain("capture_the_flag");
    expect(optionValues(modo)).not.toContain("zone_control");
  });

  it("B3W_NO_CTF_ZONE_TEAMS · con «Por equipos» tampoco aparecen", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("formato"), "teams");
    expect(optionValues(screen.getByLabelText("modo"))).toEqual(["team_deathmatch"]);
  });

  it("B3W_HISTORIC_LISTED · un torneo antiguo con CTF se sigue listando con su nombre de modo", async () => {
    render(<TournamentsPage me={ME as never} />);
    await waitFor(() => expect(screen.getByText("Copa antigua")).toBeTruthy());
    expect(screen.getByText("Captura la bandera")).toBeTruthy();
  });

  it("B3W_DRIFT · la lista de la web coincide con la fuente única del worker/API", () => {
    expect([...TOURNAMENT_CREATE_MODES]).toEqual([...TOURNAMENT_ALLOWED_MODES]);
  });
});
