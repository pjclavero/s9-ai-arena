// @vitest-environment jsdom
/**
 * V1 · TORNEOS POR INVITACIÓN (D-OP-43) · web: ficha, panel del organizador, alta y captura del
 * enlace. Etiquetas `TIW_*`: las usa scripts/v1-tournament-invitation-mutants.py.
 * El recorrido login/registro → vuelta al formulario está en v1-tournament-invitation-login.test.tsx.
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
import { TournamentsPage } from "../src/pages/TournamentsPage.js";
import { captureInvitationFromLocation, invitationLink, pendingInvitation } from "../src/tournament-invitation.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false };
const TOKEN = "Tk_".padEnd(43, "x");
const OK = { eligible: true, category: "VALID" };
let calls: { method: string; path: string; body?: unknown }[];
let tournament: Record<string, unknown>;
let check: { valid: boolean };
let entryError: (Error & { body?: unknown }) | null;

function mock() {
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/tournaments/t1") return tournament;
    if (method === "GET" && path === "/tournaments") return { items: [tournament] };
    if (path === "/tournaments/t1/battles") return { items: [] };
    if (path.startsWith("/bots?ownerId=")) return { items: [{ id: "b1", name: "Rayo", latestPublishedVersion: 1 }] };
    if (method === "GET" && path === "/bots/b1/versions")
      return [{ version: 1, state: "published", battleEligibility: OK }];
    if (method === "POST" && path === "/tournaments/t1/invitation/check") return check;
    if (method === "POST" && path === "/tournaments/t1/entries") {
      if (entryError) throw entryError;
      return { id: "e1" };
    }
    if (path === "/teams?limit=100")
      return {
        items: [
          {
            id: "tm1",
            name: "Bastión",
            isMember: true,
            bots: [
              { id: "b1", name: "Bastión-A", mine: true },
              { id: "b2", name: "Bastión-B", mine: true },
            ],
          },
        ],
      };
    if (method === "GET" && /^\/bots\/b[12]\/versions$/.test(path))
      return [{ version: 1, state: "published", battleEligibility: OK }];
    if (method === "GET" && path.startsWith("/tournaments/t1/team-consents?teamId=")) return { items: [] };
    if (method === "POST" && path === "/tournaments/t1/team-entries") return { entries: [] };
    if (method === "GET" && path === "/tournaments/t1/invitation") return { active: false };
    if (method === "POST" && path === "/tournaments/t1/invitation")
      return { invitationToken: TOKEN, createdAt: "2026-11-24T10:00:00.000Z", revokedPrevious: false };
    if (method === "DELETE" && path === "/tournaments/t1/invitation") return { active: false, revoked: true };
    if (method === "PUT" && path === "/tournaments/t1/enrollment") return { ...tournament, ...(body as object) };
    if (method === "POST" && path === "/tournaments") return { id: "tn" };
    throw new Error(`inesperado: ${method} ${path}`);
  });
}

const BASE = {
  id: "t1",
  name: "Copa Invitación",
  format: "round_robin",
  mode: "deathmatch",
  state: "open",
  entryCount: 0,
};

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
  calls = [];
  check = { valid: true };
  entryError = null;
  tournament = { ...BASE, enrollment: "invitation" };
  window.sessionStorage.clear();
  window.location.hash = "";
  mock();
});

const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("V1 · invitación en la ficha del torneo", () => {
  it("TIW_NO_FORM sin invitación la ficha de un torneo por invitación NO ofrece inscribirse", async () => {
    render(<TournamentDetailPage id="t1" me={ME} />);
    expect(await screen.findByTestId("entry-invitation-only")).toBeTruthy();
    expect(screen.getByTestId("tournament-invitation-badge").textContent).toBe("Por invitación");
    expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull();
    expect(screen.queryByTestId("entry-form")).toBeNull();
    expect(posted("/tournaments/t1/invitation/check")).toHaveLength(0);
    expect(screen.queryByTestId("invitation-panel")).toBeNull(); // no gestiona el torneo
  });

  it("TIW_NO_FORM_TEAM sin invitación tampoco se ofrece «Inscribir equipo»", async () => {
    tournament = { ...tournament, format: "teams", mode: "team_deathmatch", rules: { params: { teamSize: 2 } } };
    render(<TournamentDetailPage id="t1" me={ME} />);
    expect(await screen.findByTestId("entry-invitation-only")).toBeTruthy();
    expect(screen.queryByTestId("team-entry-form")).toBeNull();
  });

  it("TIW_OPEN_UNCHANGED un torneo abierto ofrece inscribirse como siempre, sin comprobar invitaciones", async () => {
    tournament = { ...BASE, enrollment: "open" };
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN); // un enlace suelto no cambia nada
    render(<TournamentDetailPage id="t1" me={ME} />);
    expect(await screen.findByRole("button", { name: "Inscribir" })).toBeTruthy();
    expect(screen.queryByTestId("entry-invitation-only")).toBeNull();
    expect(screen.queryByTestId("tournament-invitation-badge")).toBeNull();
    expect(posted("/tournaments/t1/invitation/check")).toHaveLength(0);
  });

  it("TIW_VALID_FORM con un enlace válido aparece el formulario; inscribir envía el token en el cuerpo", async () => {
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Inscribir" });
    expect(posted("/tournaments/t1/invitation/check")[0].body).toEqual({ invitationToken: TOKEN });
    expect(posted("/tournaments/t1/entries")).toHaveLength(0); // el enlace NO inscribe solo
    await user.selectOptions(screen.getByLabelText("bot a inscribir"), "b1");
    await screen.findByLabelText("versión a inscribir");
    await user.click(button);
    await waitFor(() => expect(posted("/tournaments/t1/entries")).toHaveLength(1));
    expect(posted("/tournaments/t1/entries")[0].body).toEqual({ botId: "b1", version: 1, invitationToken: TOKEN });
  });

  it("TIW_VALID_TEAM con un enlace válido aparece «Inscribir equipo» en un torneo por equipos", async () => {
    tournament = { ...tournament, format: "teams", mode: "team_deathmatch", rules: { params: { teamSize: 2 } } };
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN);
    render(<TournamentDetailPage id="t1" me={ME} />);
    expect(await screen.findByTestId("team-entry-form")).toBeTruthy();
    expect(screen.queryByTestId("entry-invitation-only")).toBeNull();
  });

  it("TIW_TEAM_SUBMIT inscribir el equipo con un enlace válido envía el token en el cuerpo", async () => {
    tournament = { ...tournament, format: "teams", mode: "team_deathmatch", rules: { params: { teamSize: 2 } } };
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Bastión" });
    await user.selectOptions(screen.getByLabelText("equipo a inscribir"), "tm1");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Inscribir equipo" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(posted("/tournaments/t1/team-entries")).toHaveLength(0); // el enlace NO inscribe solo
    await user.click(screen.getByRole("button", { name: "Inscribir equipo" }));
    await waitFor(() => expect(posted("/tournaments/t1/team-entries")).toHaveLength(1));
    expect(posted("/tournaments/t1/team-entries")[0].body).toEqual({
      teamId: "tm1",
      members: [
        { botId: "b1", version: 1 },
        { botId: "b2", version: 1 },
      ],
      invitationToken: TOKEN,
    });
  });

  it("TIW_INVALID un enlace revocado no habilita nada y se olvida", async () => {
    check = { valid: false };
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN);
    render(<TournamentDetailPage id="t1" me={ME} />);
    await waitFor(() =>
      expect(screen.getByTestId("entry-invitation-only").textContent).toMatch(/no es válido o ha sido revocado/),
    );
    expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull();
    expect(pendingInvitation("t1")).toBeNull();
  });

  it("TIW_REVOKED_ON_SUBMIT si la API rechaza la invitación al inscribir, el formulario desaparece", async () => {
    window.sessionStorage.setItem("s9.tournamentInvitation:t1", TOKEN);
    entryError = Object.assign(new Error("El enlace de invitación no es válido o ha sido revocado"), {
      body: { error: "invitation_invalid" },
    });
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Inscribir" });
    await user.selectOptions(screen.getByLabelText("bot a inscribir"), "b1");
    await screen.findByLabelText("versión a inscribir");
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Inscribir" })).toBeNull());
    expect(screen.getByTestId("entry-invitation-only").textContent).toMatch(/revocado/);
    expect(pendingInvitation("t1")).toBeNull();
  });
});

describe("V1 · panel del organizador", () => {
  it("TIW_ADMIN_GENERATE el organizador genera, ve y copia el enlace (con el token en el fragmento)", async () => {
    tournament = { ...tournament, viewerCanManage: true };
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    // Después de setup(): userEvent instala su propio portapapeles en navigator.
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await screen.findByTestId("invitation-panel")).toBeTruthy();
    await screen.findByText(/No hay ningún enlace activo/);
    await user.click(screen.getByTestId("invitation-generate"));
    const link = (await screen.findByTestId("invitation-link")) as HTMLInputElement;
    expect(link.value).toBe(invitationLink("t1", TOKEN));
    expect(link.value).toMatch(new RegExp(`#/tournaments/t1/invitation/${TOKEN}$`));
    await user.click(screen.getByTestId("invitation-copy"));
    expect(writeText).toHaveBeenCalledWith(link.value);
    // El organizador sigue pudiendo cerrar inscripciones aunque no vea el formulario.
    expect(screen.getByTestId("close-entries")).toBeTruthy();
  });

  it("TIW_ADMIN_REVOKE el organizador revoca el enlace activo", async () => {
    tournament = { ...tournament, viewerCanManage: true };
    apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/tournaments/t1/invitation")
        return { active: true, createdAt: "2026-11-24T10:00:00.000Z" };
      if (method === "DELETE" && path === "/tournaments/t1/invitation") return { active: false, revoked: true };
      if (method === "GET" && path === "/tournaments/t1") return tournament;
      if (path === "/tournaments/t1/battles") return { items: [] };
      if (path.startsWith("/bots?ownerId=")) return { items: [] };
      throw new Error(`inesperado: ${method} ${path}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("invitation-revoke"));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/tournaments/t1/invitation")).toBe(true),
    );
    await screen.findByText(/No hay ningún enlace activo/);
  });

  it("TIW_ADMIN_ENROLLMENT el organizador cambia la modalidad desde la ficha", async () => {
    tournament = { ...BASE, enrollment: "open", viewerCanManage: true };
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("enrollment-select"), "invitation");
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/tournaments/t1/enrollment",
        body: { enrollment: "invitation" },
      }),
    );
  });

  it("TIW_ADMIN_HIDDEN sin viewerCanManage no hay panel, y en un torneo cerrado tampoco", async () => {
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByTestId("entry-invitation-only");
    expect(screen.queryByTestId("invitation-panel")).toBeNull();
    cleanup();
    tournament = { ...tournament, viewerCanManage: true, state: "closed" };
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByTestId("tournament-state");
    expect(screen.queryByTestId("invitation-panel")).toBeNull();
  });
});

describe("V1 · alta y listado", () => {
  it("TIW_CREATE el formulario de alta envía la modalidad elegida", async () => {
    render(<TournamentsPage me={ME} />);
    const user = userEvent.setup();
    await screen.findByText("Copa Invitación");
    expect(screen.getByText(/por invitación/)).toBeTruthy(); // listado: se ve, con su modalidad
    await user.type(screen.getByLabelText("nombre del torneo"), "Copa privada");
    await user.selectOptions(screen.getByTestId("tournament-enrollment"), "invitation");
    await user.click(screen.getByTestId("create-tournament"));
    await waitFor(() => expect(posted("/tournaments")).toHaveLength(1));
    expect((posted("/tournaments")[0].body as Record<string, unknown>).enrollment).toBe("invitation");
  });

  it("TIW_CREATE_DEFAULT por defecto el torneo nace abierto (la petición no cambia: la API pone `open`)", async () => {
    render(<TournamentsPage me={ME} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa abierta");
    await user.click(screen.getByTestId("create-tournament"));
    await waitFor(() => expect(posted("/tournaments")).toHaveLength(1));
    expect(posted("/tournaments")[0].body).not.toHaveProperty("enrollment");
  });
});

describe("V1 · captura del enlace", () => {
  it("TIW_CAPTURE el token pasa a sessionStorage y sale de la barra y del historial", () => {
    window.location.hash = `#/tournaments/t1/invitation/${TOKEN}`;
    const clean = captureInvitationFromLocation();
    expect(clean).toBe("#/tournaments/t1");
    expect(window.location.hash).toBe("#/tournaments/t1");
    expect(window.location.href).not.toContain(TOKEN);
    expect(pendingInvitation("t1")).toBe(TOKEN);
    // Una ruta normal no se toca.
    window.location.hash = "#/tournaments/t1";
    expect(captureInvitationFromLocation()).toBeNull();
  });
});
