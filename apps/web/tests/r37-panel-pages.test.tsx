// @vitest-environment jsdom
/**
 * R3.7 (ERR-VIS-02/10) · DoD de torneos y batallas en el panel:
 *  - crear un torneo desde el formulario (con Enter: onSubmit real) y seguirlo;
 *  - abrir el directo (#/viewer/<id>) y el replay (#/replay/<id>) por ENLACES,
 *    sin teclear UUIDs;
 *  - cuadro por rondas, cola y feed accesible (aria-live);
 *  - un fallo de carga NUNCA se pinta como lista vacía (role="alert" + reintento).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
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
import { TournamentDetailPage } from "../src/pages/TournamentDetailPage.js";
import { BattlesPage } from "../src/pages/BattlesPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user", "organizer"], twoFactorEnabled: false };

afterEach(cleanup);
beforeEach(() => {
  apiMock.mockReset();
  window.location.hash = "";
});

describe("R3.7 torneos: crear y listar", () => {
  it("el formulario se envía con Enter (onSubmit) y navega al torneo creado", async () => {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === "GET" && path === "/tournaments") return { items: [] };
      if (method === "POST" && path === "/tournaments") return { id: "t-nuevo", name: "Copa S9" };
      throw new Error(`inesperado: ${method} ${path}`);
    });
    render(<TournamentsPage me={ME} />);
    await screen.findByText("No hay torneos todavía.");

    await userEvent.type(screen.getByLabelText("nombre del torneo"), "Copa S9{Enter}");
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("POST", "/tournaments", {
        name: "Copa S9",
        format: "single_elimination",
        mode: "deathmatch",
        rulesetId: "mvp-default",
      });
    });
    await waitFor(() => expect(window.location.hash).toBe("#/tournaments/t-nuevo"));
  });

  it("si crear falla, el error se ANUNCIA (role=alert), no se traga", async () => {
    apiMock.mockImplementation(async (method: string) => {
      if (method === "GET") return { items: [] };
      throw new Error("Solo un organizador puede crear torneos");
    });
    render(<TournamentsPage me={ME} />);
    await userEvent.type(screen.getByLabelText("nombre del torneo"), "Copa{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("organizador");
  });

  it("un fallo al cargar la lista NUNCA se pinta como lista vacía", async () => {
    apiMock.mockRejectedValue(new Error("gateway caído"));
    render(<TournamentsPage me={ME} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar los torneos");
    expect(screen.queryByText("No hay torneos todavía.")).toBeNull();
    expect(within(alert).getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });

  it("los torneos listados enlazan a su detalle (sin teclear UUIDs)", async () => {
    apiMock.mockResolvedValue({
      items: [{ id: "t1", name: "Liga MVP", format: "league", mode: "deathmatch", state: "open" }],
    });
    render(<TournamentsPage me={ME} />);
    const link = (await screen.findByText("Liga MVP")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/tournaments/t1");
  });
});

describe("R3.7 seguir un torneo: cola, en curso, cuadro e historial", () => {
  const BATTLES = [
    { id: "b-cola", status: "scheduled", round: 1, mode: "deathmatch", participants: [] },
    {
      id: "b-directo",
      status: "running",
      round: 1,
      mode: "deathmatch",
      participants: [
        { botId: "11111111-x", version: 1 },
        { botId: "22222222-y", version: 2 },
      ],
    },
    { id: "b-final", status: "finished", round: 2, mode: "deathmatch", participants: [] },
  ];

  function mockDetail(state = "running") {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (path === "/tournaments/t1") return { id: "t1", name: "Copa S9", format: "single_elimination", mode: "deathmatch", state, entryCount: 4 };
      if (path === "/tournaments/t1/battles") return { items: BATTLES };
      if (path.startsWith("/bots?ownerId=")) return { items: [{ id: "bot1", name: "Atlas", latestPublishedVersion: 3 }] };
      if (method === "POST" && path === "/tournaments/t1/entries") return { id: "e1" };
      throw new Error(`inesperado: ${method} ${path}`);
    });
  }

  it("directo y replay se abren por ENLACE: #/viewer y #/replay con el id de la batalla", async () => {
    mockDetail();
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByText("Copa S9");

    const live = (await screen.findAllByText("Ver en directo"))[0] as HTMLAnchorElement;
    expect(live.getAttribute("href")).toBe("#/viewer/b-directo");
    const replay = (await screen.findAllByText("Ver replay"))[0] as HTMLAnchorElement;
    expect(replay.getAttribute("href")).toBe("#/replay/b-final?t=0");
  });

  it("cuadro por rondas + cola + feed con aria-live para lectores de pantalla", async () => {
    mockDetail();
    render(<TournamentDetailPage id="t1" me={ME} />);
    const bracket = await screen.findByTestId("bracket");
    expect(within(bracket).getByText("Ronda 1")).toBeTruthy();
    expect(within(bracket).getByText("Ronda 2")).toBeTruthy();

    const feed = screen.getByTestId("battle-feed");
    expect(feed.getAttribute("aria-live")).toBe("polite");
    expect(feed.textContent).toContain("1 en curso");
    expect(feed.textContent).toContain("1 en cola");
    expect(screen.getByTestId("finished-battles")).toBeTruthy();
  });

  it("inscribir un bot propio con el formulario (Enter incluido) y confirmación accesible", async () => {
    mockDetail("open");
    render(<TournamentDetailPage id="t1" me={ME} />);
    await screen.findByText("Copa S9");
    fireEvent.change(await screen.findByLabelText("bot a inscribir"), { target: { value: "bot1" } });
    fireEvent.submit(screen.getByLabelText("bot a inscribir").closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith("POST", "/tournaments/t1/entries", { botId: "bot1", version: 3 });
    });
    expect((await screen.findByRole("status")).textContent).toContain("Atlas inscrito (v3)");
  });

  it("si las batallas no cargan, se dice con role=alert y reintento (nunca cuadro vacío)", async () => {
    apiMock.mockImplementation(async (_m: string, path: string) => {
      if (path === "/tournaments/t1") return { id: "t1", name: "Copa S9", format: "single_elimination", mode: "deathmatch", state: "running", entryCount: 0 };
      if (path === "/tournaments/t1/battles") throw new Error("worker caído");
      return { items: [] };
    });
    render(<TournamentDetailPage id="t1" me={ME} />);
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts.some((a) => a.textContent?.includes("No se pudieron cargar las batallas"))).toBe(true);
    });
    expect(screen.queryByTestId("bracket")).toBeNull();
  });
});

describe("R3.7 batallas e historial global", () => {
  const ITEMS = [
    {
      id: "b1",
      status: "finished",
      mode: "deathmatch",
      mapId: "mvp-arena-01",
      participants: [{ botId: "bot1", version: 1 }],
      tournamentId: "t1",
    },
    {
      id: "b2",
      status: "running",
      mode: "deathmatch",
      mapId: "mvp-arena-01",
      participants: [{ botId: "otro", version: 2 }],
    },
  ];

  it("lista con enlaces a replay/directo y al torneo de origen", async () => {
    apiMock.mockResolvedValue({ items: ITEMS });
    render(<BattlesPage />);
    const replay = (await screen.findByText("Ver replay")) as HTMLAnchorElement;
    expect(replay.getAttribute("href")).toBe("#/replay/b1?t=0");
    const live = screen.getByText("Ver en directo") as HTMLAnchorElement;
    expect(live.getAttribute("href")).toBe("#/viewer/b2");
    expect((screen.getByText("torneo") as HTMLAnchorElement).getAttribute("href")).toBe("#/tournaments/t1");
  });

  it("el filtro bot → batallas (enlace desde Mis bots) deja solo las suyas", async () => {
    apiMock.mockResolvedValue({ items: ITEMS });
    render(<BattlesPage botFilter="bot1" />);
    await screen.findByTestId("bot-filter");
    await screen.findByText("Ver replay");
    expect(screen.queryByText("Ver en directo")).toBeNull(); // b2 no es de bot1
  });

  it("fallo de carga ⇒ role=alert con reintento, no tabla vacía", async () => {
    apiMock.mockRejectedValueOnce(new Error("api caída")).mockResolvedValueOnce({ items: ITEMS });
    render(<BattlesPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No se pudo cargar las batallas");
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("Ver replay"); // el reintento recupera la lista
  });
});
