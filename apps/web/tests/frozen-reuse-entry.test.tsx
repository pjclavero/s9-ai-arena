// @vitest-environment jsdom
/**
 * FROZEN-REUSE (B8) · WEB_FROZEN_REUSE: el detalle del torneo ofrece las versiones
 * `frozen` elegibles («Frozen / Inmutable») además de las publicadas, deja ver (pero no
 * elegir) las no elegibles con su motivo, e inscribe EXACTAMENTE la versión elegida
 * (nunca otra ni una copia). La regla de estados es la misma que la de la API.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
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
import {
  FROZEN_LABEL,
  TOURNAMENT_ENTRY_STATES,
  entryVersionLabel,
  isTournamentEligible,
  tournamentEntryChoices,
} from "../src/tournament-entry.js";
import { COMPETITION_STATES } from "../../api/src/services/version-eligibility.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };
const OK = { eligible: true, category: "VALID" };
const BAD = { eligible: false, reason: "loadout_no_longer_valid", category: "INVALID_AMMO" };

let versions: unknown;
let calls: { method: string; path: string; body?: unknown }[];

function mock(bots: Record<string, unknown>[]) {
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path === "/tournaments/t1")
      return { id: "t1", name: "Copa B", format: "round_robin", mode: "deathmatch", state: "open", entryCount: 0 };
    if (path === "/tournaments/t1/battles") return { items: [] };
    if (path.startsWith("/bots?ownerId=")) return { items: bots };
    if (method === "GET" && /^\/bots\/[^/]+\/versions$/.test(path)) {
      if (versions instanceof Error) throw versions;
      return versions;
    }
    if (method === "POST" && path === "/tournaments/t1/entries") return { id: "e1" };
    throw new Error(`inesperado: ${method} ${path}`);
  });
}

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
  calls = [];
});

describe("FROZEN-REUSE · reglas puras de la web", () => {
  it("los estados inscribibles de la web son EXACTAMENTE los de la API (published, frozen)", () => {
    expect([...TOURNAMENT_ENTRY_STATES].sort()).toEqual([...COMPETITION_STATES].sort());
    expect(TOURNAMENT_ENTRY_STATES).toContain("frozen");
  });

  it("frozen elegible ⇒ inscribible; frozen NO elegible ⇒ bloqueada con motivo; otros estados ⇒ fuera", () => {
    expect(isTournamentEligible({ version: 1, state: "frozen", battleEligibility: OK })).toBe(true);
    expect(isTournamentEligible({ version: 1, state: "frozen", battleEligibility: BAD })).toBe(false);
    expect(isTournamentEligible({ version: 1, state: "suspended", battleEligibility: OK })).toBe(false);
    const c = tournamentEntryChoices([
      { version: 1, state: "frozen", battleEligibility: OK },
      { version: 2, state: "frozen", battleEligibility: BAD },
      { version: 3, state: "validated" },
    ]);
    expect(c.selectable.map((v) => v.version)).toEqual([1]);
    expect(c.defaultVersion).toBe(1);
    expect(c.blocked.map((b) => b.version.version)).toEqual([2]);
    expect(c.blocked[0].reason).toMatch(/Munición incompatible/);
    expect(entryVersionLabel({ version: 1, state: "frozen" })).toBe(`v1 · ${FROZEN_LABEL}`);
    expect(entryVersionLabel({ version: 4, state: "published" })).toBe("v4 · publicada");
  });
});

describe("FROZEN-REUSE · inscribir desde el detalle del torneo", () => {
  it("bot cuya única versión es frozen: se ofrece «Frozen / Inmutable» y se inscribe esa MISMA versión", async () => {
    versions = [{ botId: "bx", version: 1, state: "frozen", battleEligibility: OK }];
    mock([{ id: "bx", name: "A-SCOUT", visibility: "private" }]);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await screen.findByText("Copa B");
    await user.selectOptions(await screen.findByLabelText("bot a inscribir"), "bx");
    const vsel = (await screen.findByLabelText("versión a inscribir")) as HTMLSelectElement;
    expect(vsel.value).toBe("1");
    expect(within(vsel).getByRole("option", { name: `v1 · ${FROZEN_LABEL}` })).toBeTruthy();
    expect(screen.getByTestId("entry-frozen-note").textContent).toContain(FROZEN_LABEL);
    await user.click(screen.getByRole("button", { name: "Inscribir" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/tournaments/t1/entries", body: { botId: "bx", version: 1 } },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toBe(`A-SCOUT inscrito (v1) · ${FROZEN_LABEL}`);
  });

  it("frozen y publicada: se propone la más reciente inscribible y se puede elegir la frozen", async () => {
    versions = [
      { version: 1, state: "frozen", battleEligibility: OK },
      { version: 2, state: "published", battleEligibility: OK },
    ];
    mock([{ id: "bx", name: "A-SCOUT", latestPublishedVersion: 2 }]);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("bot a inscribir"), "bx");
    const vsel = (await screen.findByLabelText("versión a inscribir")) as HTMLSelectElement;
    expect(vsel.value).toBe("2");
    await user.selectOptions(vsel, "1");
    await user.click(screen.getByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ botId: "bx", version: 1 }));
  });

  it("frozen NO elegible: visible y deshabilitada con su motivo; no se envía nada", async () => {
    versions = [{ version: 1, state: "frozen", battleEligibility: BAD }];
    mock([{ id: "bz", name: "Z-BAD" }]);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("bot a inscribir"), "bz");
    const vsel = await screen.findByLabelText("versión a inscribir");
    const opt = within(vsel).getByRole("option", { name: new RegExp(`v1 · ${FROZEN_LABEL} · No elegible`) });
    expect((opt as HTMLOptionElement).disabled).toBe(true);
    expect(opt.textContent).toMatch(/Munición incompatible/);
    await user.click(screen.getByRole("button", { name: "Inscribir" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/ninguna versión publicada o congelada/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("si las versiones no cargan, se usa la última publicada del listado (comportamiento anterior) y decide la API", async () => {
    versions = new Error("red caída");
    mock([{ id: "bp", name: "P-BOT", latestPublishedVersion: 3 }]);
    render(<TournamentDetailPage id="t1" me={ME} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("bot a inscribir"), "bp");
    await screen.findByTestId("entry-versions-unavailable");
    expect(screen.queryByLabelText("versión a inscribir")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Inscribir" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ botId: "bp", version: 3 }));
  });
});
