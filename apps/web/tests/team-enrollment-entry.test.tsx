// @vitest-environment jsdom
/**
 * #287 · WEB_TEAM_ENROLLMENT: en un torneo `teams` con reglas NvN el detalle ofrece
 * «Inscribir equipo» (no «Inscribir bot»): equipo → roster con la versión de cada bot →
 * botón sólo con el roster COMPLETO y válido (si no, el motivo) → UNA petición
 * POST /tournaments/{id}/team-entries con exactamente N { botId, version }.
 * En torneos individuales sigue «Inscribir bot». Etiquetas `W287_*`: las usa
 * scripts/team-enrollment-mutants.mjs.
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
import { teamRosterPlan } from "../src/tournament-entry.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };
const OK = { eligible: true, category: "VALID" };
const BAD = { eligible: false, reason: "loadout_no_longer_valid", category: "INVALID_AMMO" };

const pub = (version: number, e = OK) => ({ version, state: "published", battleEligibility: e });
let calls: { method: string; path: string; body?: unknown }[];
let versionsByBot: Record<string, unknown>;
let tournament: Record<string, unknown>;
let teams: Record<string, unknown>[];

const TEAMS_4V4 = {
  id: "t1",
  name: "Copa Equipos",
  format: "teams",
  mode: "team_deathmatch",
  state: "open",
  entryCount: 0,
  rules: { params: { teamSize: 4 } },
};
const BASTION = {
  id: "tm1",
  name: "Bastión",
  isMember: true,
  bots: [
    { id: "b1", name: "Bastión-Apoyo", mine: true },
    { id: "b2", name: "Bastión-Asalto", mine: true },
    { id: "b3", name: "Bastión-Defensor", mine: true },
    { id: "b4", name: "Bastión-Explorador", mine: true },
  ],
};

function mock() {
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === "/tournaments/t1") return tournament;
    if (method === "GET" && path === "/tournaments") return { items: [] };
    if (path === "/tournaments/t1/battles") return { items: [] };
    if (path.startsWith("/bots?ownerId=")) return { items: [] };
    if (path === "/teams?limit=100") return { items: teams };
    const m = /^\/bots\/([^/]+)\/versions$/.exec(path);
    if (method === "GET" && m) return versionsByBot[m[1]] ?? [];
    if (method === "POST" && path === "/tournaments/t1/team-entries") return { entries: [] };
    if (method === "POST" && path === "/tournaments") return { id: "tn" };
    throw new Error(`inesperado: ${method} ${path}`);
  });
}

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
  calls = [];
  tournament = TEAMS_4V4;
  teams = [BASTION, { id: "tm2", name: "Ajeno", isMember: false }];
  versionsByBot = {
    b1: [pub(4)],
    b2: [pub(2)],
    b3: [pub(1)],
    b4: [pub(3), { version: 1, state: "frozen", battleEligibility: OK }],
  };
});

async function pickTeam() {
  render(<TournamentDetailPage id="t1" me={ME} />);
  const user = userEvent.setup();
  await screen.findByText("Copa Equipos");
  await user.selectOptions(await screen.findByLabelText("equipo a inscribir"), "tm1");
  return user;
}

describe("#287 · reglas puras del roster", () => {
  it("W287_PLAN_SIZE · sin exactamente N bots no se puede inscribir (y se dice cuántos faltan)", () => {
    const bots = BASTION.bots;
    const versions = new Map(bots.map((b) => [b.id, [pub(1)]] as const));
    const three = teamRosterPlan({
      teamSize: 4,
      bots,
      included: new Set(["b1", "b2", "b3"]),
      versions,
      chosen: new Map(),
    });
    expect(three.canSubmit).toBe(false);
    expect(three.members).toEqual([]);
    expect(three.reason).toMatch(/exactamente 4 bots.*elegidos: 3/);
    const four = teamRosterPlan({
      teamSize: 4,
      bots,
      included: new Set(bots.map((b) => b.id)),
      versions,
      chosen: new Map(),
    });
    expect(four.canSubmit).toBe(true);
    expect(four.members).toEqual(bots.map((b) => ({ botId: b.id, version: 1 })));
  });

  it("W287_PLAN_INELIGIBLE · un miembro sin versión elegible o de otro dueño bloquea el equipo entero", () => {
    const bots = [...BASTION.bots.slice(0, 3), { id: "x", name: "Ajeno", mine: false }];
    const versions = new Map<string, unknown>(BASTION.bots.map((b) => [b.id, [pub(1)]]));
    versions.set("b3", [pub(1, BAD as never)]);
    const p = teamRosterPlan({
      teamSize: 4,
      bots,
      included: new Set(bots.map((b) => b.id)),
      versions: versions as never,
      chosen: new Map(),
    });
    expect(p.canSubmit).toBe(false);
    expect(p.rows.find((r) => r.botId === "b3")?.problem).toMatch(/Sin versión publicada o congelada elegible/);
    expect(p.rows.find((r) => r.botId === "x")?.problem).toMatch(/otro miembro/);
  });
});

describe("#287 · detalle de un torneo por equipos", () => {
  it("W287_TEAM_FORM · se ofrece «Inscribir equipo» (no «Inscribir bot») con el tamaño del torneo", async () => {
    mock();
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByText("Copa Equipos");
    expect(await screen.findByLabelText("equipo a inscribir")).toBeTruthy();
    expect(screen.queryByLabelText("bot a inscribir")).toBeNull();
    expect(screen.getByTestId("team-entry-form").textContent).toContain("Tamaño: 4 vs 4");
    // Sólo los equipos de los que soy miembro.
    expect(screen.queryByRole("option", { name: "Ajeno" })).toBeNull();
  });

  it("W287_SUBMIT · roster completo y válido: UNA petición con los 4 bots y su versión exacta", async () => {
    mock();
    const user = await pickTeam();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Inscribir equipo" }) as HTMLButtonElement).disabled).toBe(false),
    );
    // Versión elegida a mano para un miembro (la frozen v1 del explorador).
    await user.selectOptions(screen.getByLabelText("versión de Bastión-Explorador"), "1");
    await user.click(screen.getByRole("button", { name: "Inscribir equipo" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        {
          method: "POST",
          path: "/tournaments/t1/team-entries",
          body: {
            teamId: "tm1",
            members: [
              { botId: "b1", version: 4 },
              { botId: "b2", version: 2 },
              { botId: "b3", version: 1 },
              { botId: "b4", version: 1 },
            ],
          },
        },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Equipo Bastión inscrito (4 bots)");
  });

  it("W287_MISSING_BOT · si falta un bot, botón deshabilitado con el motivo y no se envía nada", async () => {
    mock();
    const user = await pickTeam();
    await user.click(await screen.findByLabelText("incluir Bastión-Defensor"));
    expect((screen.getByRole("button", { name: "Inscribir equipo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("team-entry-reason").textContent).toMatch(/exactamente 4 bots.*elegidos: 3/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("W287_INELIGIBLE_MEMBER · un miembro sin versión elegible: motivo visible y el equipo entero deshabilitado", async () => {
    versionsByBot.b3 = [pub(1, BAD as never)];
    mock();
    await pickTeam();
    expect((await screen.findByTestId("roster-problem-b3")).textContent).toMatch(/Munición incompatible/);
    expect((screen.getByRole("button", { name: "Inscribir equipo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("W287_API_ERROR · un 409 de la API se enseña tal cual", async () => {
    mock();
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && path === "/tournaments/t1/team-entries") {
        calls.push({ method, path, body });
        throw new Error("Algún bot no pertenece a este equipo");
      }
      return base(method, path, body);
    });
    const user = await pickTeam();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Inscribir equipo" }) as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Inscribir equipo" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Algún bot no pertenece a este equipo");
  });
});

describe("#287 · sin regresión", () => {
  it("W287_INDIVIDUAL · un torneo individual sigue con «Inscribir bot»", async () => {
    tournament = { id: "t1", name: "Liga", format: "round_robin", mode: "deathmatch", state: "open", entryCount: 0 };
    mock();
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByText("Liga");
    expect(await screen.findByLabelText("bot a inscribir")).toBeTruthy();
    expect(screen.queryByLabelText("equipo a inscribir")).toBeNull();
  });

  it("W287_CREATE · crear un torneo por equipos de TDM envía el tamaño elegido (preset team_deathmatch)", async () => {
    mock();
    render(<TournamentsPage me={ME as never} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa 3v3");
    await user.selectOptions(screen.getByLabelText("formato"), "teams");
    await user.selectOptions(screen.getByLabelText("modo"), "team_deathmatch");
    await user.selectOptions(screen.getByLabelText("tamaño de equipo"), "3");
    await user.click(screen.getByRole("button", { name: "Crear torneo" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/tournaments")?.body).toMatchObject({
        format: "teams",
        mode: "team_deathmatch",
        rules: { preset: "team_deathmatch", teamSize: 3 },
      }),
    );
  });
});
