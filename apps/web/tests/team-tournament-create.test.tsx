// @vitest-environment jsdom
/**
 * V1-T1 · TEAM_TOURNAMENT_CREATE: elegir «Por equipos» al crear un torneo debe dejar un torneo
 * con tamaño de equipo (reglas NvN, preset `team_deathmatch`). Antes, con el modo por defecto
 * (Deathmatch) el torneo nacía con `rules = null`: `teamSizeOfTournament` daba null, no se montaba
 * «Inscribir equipo» y los equipos no se podían seleccionar. Etiquetas `V1T1_*` para los mutantes.
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
import { TournamentsPage } from "../src/pages/TournamentsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };
let calls: { method: string; path: string; body?: unknown }[];

beforeEach(() => {
  calls = [];
  apiMock.mockReset();
  apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/tournaments") return Promise.resolve({ id: "t9" });
    return Promise.resolve({ items: [] });
  });
});
afterEach(() => cleanup());

const optionValues = (el: HTMLElement) => Array.from((el as HTMLSelectElement).options).map((o) => o.value);

describe("V1-T1 · crear un torneo por equipos", () => {
  it("V1T1_DEFAULT_MODE · «Por equipos» sin tocar el modo ofrece el tamaño y envía las reglas NvN", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa");
    await user.selectOptions(screen.getByLabelText("formato"), "teams");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("team_deathmatch");
    expect(screen.getByLabelText("tamaño de equipo")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Crear torneo" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/tournaments")?.body).toMatchObject({
        format: "teams",
        mode: "team_deathmatch",
        rules: { preset: "team_deathmatch", teamSize: 4 },
      }),
    );
  });

  it("V1T1_ONLY_TDM · con «Por equipos» el modo sólo puede ser Deathmatch por equipos (CTF/zona/DM crearían un torneo sin tamaño)", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("formato"), "teams");
    expect(optionValues(screen.getByLabelText("modo"))).toEqual(["team_deathmatch"]);
  });

  it("V1T1_LEAVE_TEAMS · al salir de «Por equipos» vuelve el modo por defecto y no se envían reglas", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa");
    await user.selectOptions(screen.getByLabelText("formato"), "teams");
    await user.selectOptions(screen.getByLabelText("formato"), "round_robin");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("deathmatch");
    expect(optionValues(screen.getByLabelText("modo")).length).toBeGreaterThan(1);
    expect(screen.queryByLabelText("tamaño de equipo")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Crear torneo" }));
    await waitFor(() => {
      const body = calls.find((c) => c.method === "POST" && c.path === "/tournaments")?.body as Record<string, unknown>;
      expect(body).toMatchObject({ format: "round_robin", mode: "deathmatch" });
      expect(body.rules).toBeUndefined();
    });
  });

  it("V1T1_KEEP_MODE · al cambiar entre formatos que no son «Por equipos» se conserva el modo elegido", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa");
    await user.selectOptions(screen.getByLabelText("formato"), "single_elimination");
    await user.selectOptions(screen.getByLabelText("modo"), "team_deathmatch");
    await user.selectOptions(screen.getByLabelText("formato"), "round_robin");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("team_deathmatch");
    await user.click(screen.getByRole("button", { name: "Crear torneo" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/tournaments")?.body).toMatchObject({
        format: "round_robin",
        mode: "team_deathmatch",
      }),
    );
  });

  it("V1T1_TDM_NO_TEAMS_NO_RULES · con modo TDM y un formato que no es «Por equipos» el POST va sin reglas", async () => {
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa");
    await user.selectOptions(screen.getByLabelText("formato"), "single_elimination");
    await user.selectOptions(screen.getByLabelText("modo"), "team_deathmatch");
    await user.click(screen.getByRole("button", { name: "Crear torneo" }));
    await waitFor(() => {
      const body = calls.find((c) => c.method === "POST" && c.path === "/tournaments")?.body as Record<string, unknown>;
      expect(body).toMatchObject({ format: "single_elimination", mode: "team_deathmatch" });
      expect(body.rules).toBeUndefined();
    });
  });
});
