// @vitest-environment jsdom
/**
 * UX-R · Remates de la fase UX Review + Functional Acceptance (pendientes que
 * UX-E dejó en páginas de otros carriles). Cada caso se pone ROJO sin su fix:
 *  1. «Mis mapas» del editor: si la carga falla, ErrorState con reintento (no
 *     «Cargando…» eterno).
 *  2. spawns del lienzo con `role="img"` (axe `aria-prohibited-attr`); Mapas pasa
 *     el error ORIGINAL a ErrorState para que se clasifique.
 *  3. modos en palabras al crear batalla, coherentes con el ranking.
 *  8. formatos y estados de torneo en palabras; el cuadro dice «Partido N».
 *  9. el detalle del bot usa ErrorState (fallo clasificado).
 * 10. borrador de sesión en el editor de código del detalle del bot.
 * 11. Administración clasifica sus errores (Sistema en español: admin-ops-pages).
 * La API se mockea (prueba de componente); el E2E real es tests/browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  ApiRequestError: class extends Error {
    constructor(
      public status: number,
      public body: Record<string, unknown>,
    ) {
      super(String(body?.message ?? status));
    }
  },
}));
import { api } from "../src/api.js";
import { MapEditorPage } from "../src/pages/MapEditorPage.js";
import { MapsPage } from "../src/pages/MapsPage.js";
import { BattleNewPage } from "../src/pages/BattleNewPage.js";
import { RankingPage } from "../src/pages/RankingPage.js";
import { TournamentsPage } from "../src/pages/TournamentsPage.js";
import { BracketPage } from "../src/pages/BracketPage.js";
import { BotDetailPage } from "../src/pages/BotDetailPage.js";
import { AdminPage } from "../src/pages/AdminPage.js";
import { MODE_NAME } from "../src/battle-result.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Ana", roles: ["user"] } as never;
const ADMIN = { id: "a1", displayName: "Admin", roles: ["admin"] } as never;
/** Un fallo HTTP con la FORMA de ApiRequestError (la clasificación es por forma). */
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, body: { message } });

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  apiMock.mockReset();
  window.location.hash = "";
  window.sessionStorage.clear();
});

describe("UX-R 1-2 · mapas", () => {
  it("«Mis mapas» que no cargan: alerta clasificada con Reintentar, y el reintento funciona", async () => {
    let fail = true;
    apiMock.mockImplementation((method: string, path: string) => {
      if (method === "GET" && path.startsWith("/maps?mine=true"))
        return fail ? Promise.reject(httpError(503, "servicio caído")) : Promise.resolve({ items: [] });
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<MapEditorPage />);
    const alert = await screen.findByTestId("resource-error-tus-mapas");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("unavailable");
    expect(alert.textContent).toContain("No se pudo cargar tus mapas");
    expect(screen.queryByText("Cargando…")).toBeNull();
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await screen.findByText("Aún no has guardado ningún mapa.");
    expect(screen.queryByTestId("resource-error-tus-mapas")).toBeNull();
  });

  it("cada spawn del lienzo con aria-label lleva un role que lo permite (img)", async () => {
    apiMock.mockResolvedValue({ items: [] });
    const { container } = render(<MapEditorPage />);
    const circles = Array.from(container.querySelectorAll("circle[aria-label]"));
    expect(circles.length).toBeGreaterThan(0);
    for (const c of circles) expect(c.getAttribute("role")).toBe("img");
  });

  it("Mapas: el fallo de carga se CLASIFICA (403 = permiso), no sólo se repite el mensaje", async () => {
    apiMock.mockRejectedValue(httpError(403, "sin permiso"));
    render(<MapsPage me={ME} />);
    const alert = await screen.findByTestId("resource-error-los-mapas");
    expect(alert.getAttribute("data-error-kind")).toBe("forbidden");
    expect(within(alert).getByTestId("error-title").textContent).toBe("No tienes permiso para esto");
  });
});

describe("UX-R 3 · modos en palabras", () => {
  const RULESETS = {
    modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
    items: [{ id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 }],
  };
  it("crear batalla enseña el NOMBRE del modo (el valor sigue siendo el de la API), como el ranking", async () => {
    apiMock.mockImplementation((method: string, path: string) => {
      if (path === "/rulesets") return Promise.resolve(RULESETS);
      if (path.startsWith("/standings")) return Promise.resolve([]);
      return Promise.resolve({ items: [] });
    });
    render(<BattleNewPage me={ME} />);
    const sel = (await screen.findByLabelText("modo")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Deathmatch por equipos" });
    const shown = Array.from(sel.options).map((o) => o.textContent);
    expect(shown).toEqual(["Deathmatch", "Deathmatch por equipos", "Captura la bandera", "Control de zona"]);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(RULESETS.modes);
    // Sin mapas para el modo, el aviso tampoco usa el identificador.
    expect(screen.getByTestId("maps-for-mode").textContent).toContain("el modo Deathmatch;");
    expect(document.body.textContent).not.toMatch(/team_deathmatch|capture_the_flag|zone_control/);
    cleanup();
    render(<RankingPage />);
    const rank = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(Array.from(rank.options).map((o) => o.textContent)).toEqual(Object.values(MODE_NAME));
  });
});

describe("UX-R 8 · torneos y cuadro", () => {
  it("lista y formulario con formato, modo y estado en palabras", async () => {
    apiMock.mockResolvedValue({
      items: [{ id: "t1", name: "Copa", format: "round_robin", mode: "team_deathmatch", state: "open" }],
    });
    render(<TournamentsPage me={ME} />);
    const row = (await screen.findByText("Copa")).closest("tr")!;
    expect(row.textContent).toContain("Todos contra todos (liguilla)");
    expect(row.textContent).toContain("Deathmatch por equipos");
    expect(row.textContent).toContain("inscripciones abiertas");
    expect(row.textContent).not.toMatch(/round_robin|team_deathmatch|\bopen\b/);
    const fmt = screen.getByLabelText("formato") as HTMLSelectElement;
    expect(fmt.value).toBe("single_elimination");
    expect(fmt.selectedOptions[0].textContent).toBe("Eliminación directa");
    expect(Array.from(fmt.options).some((o) => /_/.test(o.textContent ?? ""))).toBe(false);
    const mode = screen.getByLabelText("modo") as HTMLSelectElement;
    expect(Array.from(mode.options).some((o) => /_/.test(o.textContent ?? ""))).toBe(false);
  });

  it("el cuadro dice «Partido N» y el estado en palabras, nunca el slot ni el id del match", async () => {
    apiMock.mockResolvedValue({
      matches: [
        {
          id: "9f1c2d3e-aaaa-bbbb-cccc-000000000001",
          round: 1,
          slot: "W1M1",
          pairing: {},
          state: "finished",
          winnerBotId: "bot-a",
          winnerTeamId: null,
          final: false,
        },
        {
          id: "9f1c2d3e-aaaa-bbbb-cccc-000000000002",
          round: 1,
          slot: null,
          pairing: {},
          state: "scheduled",
          winnerBotId: null,
          winnerTeamId: null,
          final: false,
        },
      ],
    });
    render(<BracketPage id="t1" />);
    const rounds = await screen.findByTestId("bracket-rounds");
    const items = within(rounds).getAllByTestId("bracket-match");
    expect(items[0].textContent).toContain("Partido 1");
    expect(items[0].textContent).toContain("terminado");
    expect(items[1].textContent).toContain("Partido 2");
    expect(items[1].textContent).toContain("pendiente");
    expect(rounds.textContent).not.toMatch(/W1M1|9f1c2d3e|scheduled|finished/);
  });
});

describe("UX-R 9-10 · detalle del bot", () => {
  const BOT = { id: "b1", name: "Ana-bot", ownerId: "u1", visibility: "private", latestPublishedVersion: 1 };
  const V1 = { botId: "b1", version: 1, state: "published", runtime: "python", loadoutRevision: 1 };
  function backend() {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (path === "/bots/b1") return BOT;
      if (path === "/bots/b1/versions") return [V1];
      if (path === "/bots/b1/loadouts") return [];
      if (path === "/bots/b1/versions/1") return { ...V1, canReadSource: true, childVersions: [] };
      if (path === "/bots/b1/versions/1/files")
        return { version: 1, packaged: false, files: [{ path: "src/bot.py", content: "del servidor\n" }] };
      throw new Error(`ruta no simulada: ${method} ${path}`);
    });
  }

  it("un fallo al cargar el bot se muestra con ErrorState CLASIFICADO y reintento", async () => {
    apiMock.mockRejectedValue(httpError(404, "Bot no encontrado"));
    render(<BotDetailPage botId="b1" meId="u1" />);
    const box = await screen.findByTestId("bot-detail-error");
    const alert = within(box).getByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("notFound");
    expect(within(alert).getByTestId("error-title").textContent).toBe("No existe o no está disponible");
    expect(alert.textContent).toContain("No se pudo cargar el bot: Bot no encontrado");
    expect(within(alert).getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });

  it("el código editado sin guardar sobrevive al desmontaje (sesión caducada) y se anuncia", async () => {
    backend();
    const first = render(<BotDetailPage botId="b1" meId="u1" initialTab="code" />);
    const area = (await screen.findByLabelText("codigo-editado")) as HTMLTextAreaElement;
    expect(area.value).toBe("del servidor\n");
    fireEvent.change(area, { target: { value: "mis cambios" } });
    first.unmount();

    render(<BotDetailPage botId="b1" meId="u1" initialTab="code" />);
    await waitFor(() =>
      expect((screen.getByLabelText("codigo-editado") as HTMLTextAreaElement).value).toBe("mis cambios"),
    );
    expect(screen.getByTestId("code-draft-restored").textContent).toMatch(/no está en el servidor/);
    await userEvent.click(screen.getByRole("button", { name: "Descartar borrador" }));
    expect((screen.getByLabelText("codigo-editado") as HTMLTextAreaElement).value).toBe("del servidor\n");
    expect(screen.queryByTestId("code-draft-restored")).toBeNull();
  });
});

describe("UX-R 11 · Administración", () => {
  it("Administración CLASIFICA el error (servidor caído), no pinta el mensaje suelto", async () => {
    apiMock.mockRejectedValue(httpError(500, "Error interno"));
    render(<AdminPage me={ADMIN} />);
    const err = await screen.findByTestId("admin-error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.getAttribute("data-error-kind")).toBe("server");
    expect(err.textContent).toContain("Error del servidor (500)");
  });
});
