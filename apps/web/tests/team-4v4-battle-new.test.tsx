// @vitest-environment jsdom
/**
 * 4v4 · T-UI · «Nueva batalla» distingue BATALLA INDIVIDUAL (el 1v1 de siempre)
 * de BATALLA POR EQUIPOS. En el modo equipos:
 *  - se eligen Equipo A y Equipo B y sus bots elegibles entran solos con su
 *    versión publicada EXACTA (y se puede elegir otra publicada);
 *  - se puede excluir y sustituir; máx. 4 por bando y 8 en total; sin duplicados;
 *  - los bots sin versión publicada no entran y se dice por qué;
 *  - sólo modos de equipo (por defecto Deathmatch por equipos) y sus mapas;
 *  - «Crear batalla» sólo con composición válida; se envía un participante por bot
 *    con `team` = bando (A → red, B → blue);
 *  - los 400/409 de la API se enseñan con FormError.
 * Mockea `api`: el recorrido real con el stack está en
 * tests/browser/specs/team-battle-4v4.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { BattleNewPage } from "../src/pages/BattleNewPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Op", roles: ["user"] } as never;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const MAPS = [
  {
    mapId: "arena",
    name: "Arena",
    version: 1,
    state: "published",
    supportedModes: ["team_deathmatch", "capture_the_flag"],
  },
  { mapId: "dm_only", version: 1, state: "published", supportedModes: ["deathmatch"] },
];
const RULESETS = {
  modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
  items: [
    { id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 },
    { id: "tdm-mvp", name: "TDM", mode: "team_deathmatch", budgetCredits: 1000 },
    { id: "ctf-mvp", name: "CTF", mode: "capture_the_flag", budgetCredits: 1000 },
  ],
};
const A = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4", "A-ATK-5"];
const B = ["B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"];
const id = (name: string) => `bot_${name}`;
const BOTS = [
  ...[...A, ...B].map((n) => ({ id: id(n), name: n, ownerId: "u1", latestPublishedVersion: n === "A-ATK-2" ? 2 : 1 })),
  { id: "bot_nopub", name: "A-NOPUB", ownerId: "u1", latestPublishedVersion: null },
];
const TEAMS = [
  {
    id: "t_alfa",
    name: "Alfa",
    isMember: true,
    bots: [...A.map((n) => ({ id: id(n), name: n })), { id: "bot_nopub", name: "A-NOPUB" }],
  },
  { id: "t_beta", name: "Beta", isMember: true, bots: B.map((n) => ({ id: id(n), name: n })) },
  { id: "t_ajeno", name: "Ajeno", isMember: false },
];
function versionsOf(botId: string) {
  if (botId === "bot_nopub") return [{ version: 1, state: "validated" }];
  if (botId === id("A-ATK-2"))
    return [
      { version: 2, state: "published" },
      { version: 1, state: "published" },
    ];
  return [{ version: 1, state: "published" }];
}

function mockApi(post: () => Promise<unknown> = () => Promise.resolve({ id: "btl_4v4" })) {
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
    if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
    if (method === "GET" && path === "/rulesets") return Promise.resolve(RULESETS);
    if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: TEAMS });
    const m = /^\/bots\/([^/]+)\/versions$/.exec(path);
    if (method === "GET" && m) return Promise.resolve(versionsOf(decodeURIComponent(m[1])));
    if (method === "POST" && path === "/battles") return post();
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
}

const createBtn = () => screen.getByText("Crear batalla") as HTMLButtonElement;
const slotNames = (side: "A" | "B") =>
  within(screen.getByTestId(`team-slots-${side}`))
    .queryAllByTestId("team-slot")
    .map((li) => li.getAttribute("data-bot-id"));

async function openTeamMode() {
  render(<BattleNewPage me={ME} />);
  await screen.findAllByRole("option", { name: /A-ATK-1/ });
  // Versiones cargadas (la de A-NOPUB dice ya «validada»).
  await waitFor(() => expect(screen.getByTestId("ineligible-bots").textContent).toMatch(/validada/));
  await userEvent.click(screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
}
async function pickTeams(a = "t_alfa", b = "t_beta") {
  await userEvent.selectOptions(screen.getByLabelText("equipo A"), a);
  await userEvent.selectOptions(screen.getByLabelText("equipo B"), b);
}

describe("4v4 · tipo de batalla", () => {
  it("por defecto es BATALLA INDIVIDUAL (el 1v1 de siempre) y se ofrecen ambos tipos", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    const indiv = (await screen.findByRole("radio", { name: /BATALLA INDIVIDUAL/ })) as HTMLInputElement;
    expect(indiv.checked).toBe(true);
    expect((screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText("bot rojo")).toBeTruthy();
    expect(screen.queryByLabelText("equipo A")).toBeNull();
  });

  it("en equipos sólo hay modos de equipo, Deathmatch por equipos por defecto, y sólo sus mapas", async () => {
    mockApi();
    await openTeamMode();
    const modeSel = screen.getByLabelText("modo") as HTMLSelectElement;
    expect(Array.from(modeSel.options).map((o) => o.value)).toEqual([
      "team_deathmatch",
      "capture_the_flag",
      "zone_control",
    ]);
    expect(modeSel.value).toBe("team_deathmatch");
    expect((screen.getByLabelText("ruleset") as HTMLSelectElement).value).toBe("tdm-mvp");
    const mapSel = screen.getByLabelText("mapa") as HTMLSelectElement;
    expect(Array.from(mapSel.options).map((o) => o.value)).toEqual(["arena@1"]);
    // Sólo los equipos de los que el usuario es miembro.
    const teamSel = screen.getByLabelText("equipo A") as HTMLSelectElement;
    expect(Array.from(teamSel.options).map((o) => o.textContent)).toEqual(["— elige un equipo —", "Alfa", "Beta"]);
    // El bando no es el equipo: se explica.
    expect(screen.getByTestId("team-concepts").textContent).toMatch(/Equipo A juega en el bando rojo/);
    expect(screen.getByTestId("team-concepts").textContent).toMatch(/no qué equipo de la sección Equipos jugó/);
    // Sin equipos elegidos no se puede crear.
    expect(createBtn().disabled).toBe(true);
  });
});

describe("4v4 · composición por equipos", () => {
  it("carga 4 + 4 bots elegibles con su versión exacta, lo resume y crea con 8 participantes por bando", async () => {
    mockApi();
    await openTeamMode();
    await pickTeams();
    expect(slotNames("A")).toEqual(A.slice(0, 4).map(id));
    expect(slotNames("B")).toEqual(B.map(id));
    expect(screen.getByTestId("team-summary-A").textContent).toMatch(
      /^Equipo A ✓ A-ATK-1 · v1, A-ATK-2 · v2, A-ATK-3 · v1, A-ATK-4 · v1/,
    );
    expect(screen.getByTestId("team-summary-B").textContent).toMatch(/^Equipo B ✓ B-DEF-1 · v1/);
    expect(screen.getByTestId("participants-count").textContent).toBe("Participantes: 4 vs 4 · 8 / 8");
    // Los que no juegan, con su motivo.
    const out = screen.getByTestId("team-not-playing-A").textContent ?? "";
    expect(out).toMatch(/A-ATK-5 — no cabe: máximo 4 por bando/);
    expect(out).toMatch(/A-NOPUB — no elegible: ninguna versión publicada — tienes v1 validada/);

    expect(createBtn().disabled).toBe(false);
    await userEvent.click(createBtn());
    await screen.findByText(/creada y encolada/i);
    expect(screen.getByTestId("battle-detail-link").getAttribute("href")).toBe("#/battles/btl_4v4");
    const post = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/battles")!;
    expect(post[2]).toMatchObject({ mode: "team_deathmatch", rulesetId: "tdm-mvp", mapId: "arena", mapVersion: 1 });
    expect(post[2].participants).toEqual([
      { botId: id("A-ATK-1"), version: 1, team: "red" },
      { botId: id("A-ATK-2"), version: 2, team: "red" },
      { botId: id("A-ATK-3"), version: 1, team: "red" },
      { botId: id("A-ATK-4"), version: 1, team: "red" },
      ...B.map((n) => ({ botId: id(n), version: 1, team: "blue" })),
    ]);
  });

  it("se puede elegir otra versión publicada de un bot y es la que se envía", async () => {
    mockApi();
    await openTeamMode();
    await pickTeams();
    await userEvent.selectOptions(screen.getByLabelText("versión A-ATK-2"), "1");
    expect(screen.getByTestId("team-summary-A").textContent).toMatch(/A-ATK-2 · v1/);
    await userEvent.click(createBtn());
    await screen.findByText(/creada y encolada/i);
    const post = apiMock.mock.calls.find((c) => c[0] === "POST" && c[1] === "/battles")!;
    expect(post[2].participants[1]).toEqual({ botId: id("A-ATK-2"), version: 1, team: "red" });
  });

  it("excluir, volver a añadir y sustituir un bot", async () => {
    mockApi();
    await openTeamMode();
    await pickTeams();
    await userEvent.click(screen.getByLabelText("excluir A-ATK-1"));
    expect(slotNames("A")).toEqual(["A-ATK-2", "A-ATK-3", "A-ATK-4"].map(id));
    expect(screen.getByTestId("participants-count").textContent).toBe("Participantes: 3 vs 4 · 7 / 8");
    expect(screen.getByTestId("team-not-playing-A").textContent).toMatch(/A-ATK-1 — excluido de esta batalla/);
    // Un 3 vs 4 también es válido.
    expect(createBtn().disabled).toBe(false);
    // Añadir: sólo bots elegibles que no juegan ya (ni A-NOPUB ni los del Equipo B).
    const add = screen.getByLabelText("añadir bot al equipo A") as HTMLSelectElement;
    const offered = Array.from(add.options).map((o) => o.value);
    expect(offered).toContain(id("A-ATK-5"));
    expect(offered).not.toContain("bot_nopub");
    for (const n of B) expect(offered).not.toContain(id(n));
    await userEvent.selectOptions(add, id("A-ATK-5"));
    expect(slotNames("A")).toEqual(["A-ATK-2", "A-ATK-3", "A-ATK-4", "A-ATK-5"].map(id));
    // Lleno: ya no se ofrece añadir.
    expect(screen.queryByLabelText("añadir bot al equipo A")).toBeNull();
    // Sustituir A-ATK-3 por A-ATK-1 (que quedó fuera).
    await userEvent.selectOptions(screen.getByLabelText("sustituir A-ATK-3"), id("A-ATK-1"));
    expect(slotNames("A")).toEqual(["A-ATK-2", "A-ATK-1", "A-ATK-4", "A-ATK-5"].map(id));
  });

  it("sin duplicados: el mismo equipo en los dos bandos no repite bots, y sin bots el bando no es válido", async () => {
    mockApi();
    await openTeamMode();
    await pickTeams("t_beta", "t_beta");
    expect(slotNames("A")).toEqual(B.map(id));
    expect(slotNames("B")).toEqual([]);
    expect(screen.getByTestId("team-not-playing-B").textContent).toMatch(
      /B-DEF-1 — ya juega en el Equipo A: un bot sólo puede jugar una vez/,
    );
    expect(screen.getByTestId("battle-checklist").textContent).toMatch(/✗ Equipo B \(bando azul\): Beta no tiene/);
    expect(screen.getByTestId("participants-count").textContent).toBe("Participantes: 4 vs 0 · 4 / 8");
    expect(createBtn().disabled).toBe(true);
    // Un equipo con 5 bots elegibles repartido en los dos bandos: 4 + el que sobra.
    await pickTeams("t_alfa", "t_alfa");
    expect(slotNames("A")).toEqual(A.slice(0, 4).map(id));
    expect(slotNames("B")).toEqual([id("A-ATK-5")]);
    expect(createBtn().disabled).toBe(false);
    // El sustituto nunca puede ser un bot que ya juega en el otro bando.
    const sub = screen.getByLabelText("sustituir A-ATK-5") as HTMLSelectElement;
    for (const n of A.slice(0, 4)) expect(Array.from(sub.options).map((o) => o.value)).not.toContain(id(n));
  });

  it.each([
    [409, "bot_not_published", "El bot bot_A-ATK-1 v1 no está publicado", /Conflicto/],
    [400, "bad_request", "participants: entre 1 y 8", /Datos no válidos/],
  ])("un %i de la API al crear se enseña con FormError", async (status, code, message, title) => {
    mockApi(() => Promise.reject(Object.assign(new Error(message), { status, body: { code, message } })));
    await openTeamMode();
    await pickTeams();
    await userEvent.click(createBtn());
    const fe = await screen.findByTestId("form-error");
    expect(fe.textContent).toMatch(title);
    expect(fe.textContent).toContain(message);
    expect(screen.queryByText(/creada y encolada/i)).toBeNull();
  });

  it("sin equipos de los que seas miembro lo dice y enlaza a Equipos", async () => {
    mockApi();
    apiMock.mockImplementation((method: string, path: string) => {
      if (path === "/teams?limit=100") return Promise.resolve({ items: [] });
      if (path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
      if (path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
      if (path === "/rulesets") return Promise.resolve(RULESETS);
      return Promise.resolve([]);
    });
    render(<BattleNewPage me={ME} />);
    await userEvent.click(await screen.findByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
    const note = await screen.findByTestId("no-teams");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("#/teams");
    expect(createBtn().disabled).toBe(true);
  });

  it("volver a BATALLA INDIVIDUAL restaura el 1v1 (modos de siempre y bandos rojo/azul)", async () => {
    mockApi();
    await openTeamMode();
    await userEvent.click(screen.getByRole("radio", { name: /BATALLA INDIVIDUAL/ }));
    const modeSel = screen.getByLabelText("modo") as HTMLSelectElement;
    expect(Array.from(modeSel.options).map((o) => o.value)).toEqual(RULESETS.modes);
    expect(modeSel.value).toBe("deathmatch");
    expect(screen.getByLabelText("bot rojo")).toBeTruthy();
  });
});
