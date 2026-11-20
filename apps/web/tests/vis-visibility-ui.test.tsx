// @vitest-environment jsdom
/**
 * VISIBILIDAD (2026-11) · UI de las dos visibilidades del bot y de la retransmisión.
 *  - Ficha (Overview): el DUEÑO ve el control Privado/Equipo/Público y el cambio sale por
 *    `PATCH /bots/{id}`; quien sólo ve el bot no ve el control (§4, §5).
 *  - Versions: «Código de vN [Privado][Público]» sólo para el dueño, por
 *    `PUT …/code-visibility`, con el aviso de que quien ya lo descargó conserva su copia (§6).
 *  - Torneos: nunca «hazlo público»; el texto de §26 (§26).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../src/api.js", () => {
  class ApiRequestError extends Error {
    constructor(
      public status: number,
      public body: Record<string, unknown>,
    ) {
      super(String(body?.message ?? `HTTP ${status}`));
    }
  }
  return { api: vi.fn(), setToken: vi.fn(), getToken: vi.fn(() => "tok"), onSessionExpired: vi.fn(), ApiRequestError };
});

import { api } from "../src/api.js";
import { BotsPage } from "../src/pages/BotsPage.js";
import { atBotSection } from "./bot-panel-helpers.js";
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";
import { TournamentDetailPage, entryPrivacyNote } from "../src/pages/TournamentDetailPage.js";
import { TournamentsPage } from "../src/pages/TournamentsPage.js";
import { BOT_VISIBILITY_NOTE, CODE_VISIBILITY_NOTE, CODE_PRIVATE_AGAIN_WARNING } from "../src/visibility.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
let bot: Record<string, unknown>;
let versions: Record<string, unknown>[];
let calls: { method: string; path: string; body?: unknown }[];

beforeEach(() => {
  calls = [];
  bot = {
    id: "b1",
    name: "A-DEF",
    ownerId: "u1",
    visibility: "private",
    latestPublishedVersion: 4,
    createdAt: "2026-10-01T10:00:00Z",
  };
  versions = [
    {
      botId: "b1",
      version: 4,
      state: "published",
      runtime: "python",
      loadoutRevision: 1,
      codePublic: false,
      createdAt: "2026-10-04T10:00:00Z",
    },
  ];
  apiMock.mockImplementation(async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/bots?ownerId="))
      return { items: path.includes("ownerId=u1") ? [bot] : [] };
    if (method === "GET" && path === "/bots/b1") return bot;
    if (method === "GET" && /\/builds$/.test(path)) return [];
    if (method === "GET" && path === "/bots/b1/versions") return versions;
    if (method === "GET" && path === "/bots/b1/loadouts") return [];
    if (method === "GET" && path === "/bots/b1/versions/4")
      return { ...versions[0], canReadSource: true, childVersions: [] };
    if (method === "PATCH" && path === "/bots/b1") {
      bot = { ...bot, visibility: body.visibility };
      return bot;
    }
    if (method === "PUT" && path === "/bots/b1/versions/4/code-visibility") {
      versions = [{ ...versions[0], codePublic: body.codePublic }];
      return versions[0];
    }
    throw new Error(`ruta no simulada: ${method} ${path}`);
  });
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

/** #255 · la visibilidad del bot y la del código viven JUNTAS en la sección «Visibilidad». */
const renderPanel = (meId: string, section = "visibilidad") => {
  atBotSection("b1", section);
  return render(
    <BotsPage
      me={{ id: meId, displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false }}
      catalog={loadCatalog()}
      catalogVersion={CATALOG_VERSION}
      budgetCredits={1000}
    />,
  );
};

describe("VISIBILIDAD · ficha del bot", () => {
  it("WEB_BOT_VISIBILITY_EDIT · el dueño cambia private → team → public por PATCH /bots/{id}", async () => {
    renderPanel("u1");
    const ctl = await screen.findByTestId("bot-visibility-control");
    expect(within(ctl).getByText(/Sólo tú/)).toBeTruthy();
    expect(within(ctl).getByText(/miembros del equipo/)).toBeTruthy();
    expect(within(ctl).getByText(/Cualquier usuario o visitante/)).toBeTruthy();
    // B3 · las dos visibilidades, juntas y explicadas como independientes (en los dos sentidos).
    const independence = screen.getByTestId("visibility-independence").textContent ?? "";
    expect(independence).toContain(BOT_VISIBILITY_NOTE);
    expect(independence).toContain(CODE_VISIBILITY_NOTE);
    expect(within(screen.getByTestId("visibility-card")).getByTestId("code-visibility-4")).toBeTruthy();
    await userEvent.click(screen.getByTestId("bot-visibility-team"));
    await waitFor(() => expect((screen.getByTestId("bot-visibility-team") as HTMLInputElement).checked).toBe(true));
    await userEvent.click(screen.getByTestId("bot-visibility-public"));
    await waitFor(() => expect((screen.getByTestId("bot-visibility-public") as HTMLInputElement).checked).toBe(true));
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.body)).toEqual([{ visibility: "team" }, { visibility: "public" }]);
    // Cambiar la visibilidad del bot NO toca la del código.
    expect(calls.some((c) => c.path.endsWith("/code-visibility"))).toBe(false);
  });

  it("quien no es el dueño no ve el control (sólo el texto)", async () => {
    renderPanel("otro");
    await screen.findByTestId("bot-visibility-readonly");
    expect(screen.queryByTestId("bot-visibility-control")).toBeNull();
    expect(screen.getByTestId("code-visibility-readonly-4").textContent).toBe("Código de v4: privado");
    expect(screen.queryByTestId("code-public-4")).toBeNull();
  });

  it("WEB_CODE_VISIBILITY_EDIT · «Código de v4 [Privado][Público]» sólo para el dueño, con aviso al hacerlo público", async () => {
    renderPanel("u1");
    const ctl = await screen.findByTestId("code-visibility-4");
    // B4 · acción rápida: la versión PUBLICADA arriba, sin buscarla en ninguna tabla.
    expect(within(screen.getByTestId("code-visibility-published")).getByTestId("code-visibility-4")).toBe(ctl);
    expect(screen.getByTestId("visibility-quick").textContent).toMatch(/Bot ● Privado · Código v4 ● Privado/);
    expect(ctl.textContent).toMatch(/Código de v4/);
    expect(screen.queryByTestId("code-private-warning-4")).toBeNull();
    await userEvent.click(screen.getByTestId("code-public-4"));
    await waitFor(() =>
      expect(screen.getByTestId("code-private-warning-4").textContent).toContain(CODE_PRIVATE_AGAIN_WARNING),
    );
    await userEvent.click(screen.getByTestId("code-private-4"));
    await waitFor(() => expect(screen.queryByTestId("code-private-warning-4")).toBeNull());
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.path, c.body])).toEqual([
      ["/bots/b1/versions/4/code-visibility", { codePublic: true }],
      ["/bots/b1/versions/4/code-visibility", { codePublic: false }],
    ]);
    // Cambiar el código NO toca la visibilidad del bot.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("UNA sola fuente de verdad: la tabla de versiones MUESTRA el código, no lo edita", async () => {
    renderPanel("u1", "versiones");
    const cell = await screen.findByTestId("code-cell-4");
    expect(cell.textContent).toBe("privado");
    expect(within(cell).queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("code-visibility-4")).toBeNull();
  });

  it("quien no es el dueño ve «privado»/«público» sin botones", async () => {
    renderPanel("otro", "versiones");
    const cell = await screen.findByTestId("code-cell-4");
    expect(cell.textContent).toBe("privado");
    expect(screen.queryByTestId("code-public-4")).toBeNull();
  });
});

describe("VISIBILIDAD · torneos (§26)", () => {
  it("nunca pide hacer público el bot; explica qué se muestra en una competición pública", () => {
    const priv = entryPrivacyNote("private", true)!;
    expect(priv).toBe(
      "Este bot es privado. Durante las batallas públicas se mostrarán únicamente sus datos de competición; su código seguirá privado.",
    );
    expect(entryPrivacyNote("team", true)).toMatch(/^Este bot es de equipo\./);
    expect(entryPrivacyNote("public", true)).toBeNull();
    for (const v of ["private", "team"]) {
      for (const b of [true, false]) expect(entryPrivacyNote(v, b)).not.toMatch(/hac(er|lo) público|Debes/i);
    }
  });
});

describe("VISIBILIDAD · UI de torneos (§26) renderizada", () => {
  const ME = { id: "u1", displayName: "Ana", email: "a@a.es", roles: ["organizer"], twoFactorEnabled: false };

  it("crear torneo: la casilla «Retransmisión pública» viaja como broadcast (false por defecto)", async () => {
    apiMock.mockImplementation(async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/tournaments") return { items: [] };
      if (method === "POST" && path === "/tournaments") return { id: "t1", ...body, state: "open" };
      throw new Error(`ruta no simulada: ${method} ${path}`);
    });
    render(<TournamentsPage me={ME} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("nombre del torneo"), "Copa");
    await user.click(screen.getByRole("button", { name: /crear/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "Copa", broadcast: false });
    calls.length = 0;
    await user.type(screen.getByLabelText("nombre del torneo"), "Copa TV");
    await user.click(screen.getByTestId("tournament-broadcast"));
    await user.click(screen.getByRole("button", { name: /crear/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ name: "Copa TV", broadcast: true });
  });

  it.each([
    [
      true,
      "Este bot es privado. Durante las batallas públicas se mostrarán únicamente sus datos de competición; su código seguirá privado.",
    ],
    [
      false,
      "Este bot es privado. Puede participar igual; sus batallas sólo las verán sus participantes, su equipo y la organización.",
    ],
  ])(
    "inscribir un bot privado (broadcast=%s): aviso real, nunca «hazlo público»; el público no lleva aviso",
    async (broadcast, text) => {
      apiMock.mockImplementation(async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/tournaments/t1")
          return {
            id: "t1",
            name: "Copa",
            format: "single_elimination",
            mode: "deathmatch",
            state: "open",
            entryCount: 0,
            broadcast,
          };
        if (method === "GET" && path === "/tournaments/t1/battles") return { items: [] };
        if (method === "GET" && path.startsWith("/bots?ownerId="))
          return {
            items: [
              { id: "bp", name: "A-DEF", visibility: "private", latestPublishedVersion: 4 },
              { id: "bq", name: "B-PUB", visibility: "public", latestPublishedVersion: 1 },
            ],
          };
        if (method === "GET") return { items: [], matches: [] };
        throw new Error(`ruta no simulada: ${method} ${path}`);
      });
      render(<TournamentDetailPage id="t1" me={ME} />);
      const user = userEvent.setup();
      const select = await screen.findByLabelText("bot a inscribir");
      await screen.findByRole("option", { name: /A-DEF/ });
      if (broadcast) expect(screen.getByTestId("tournament-broadcast-badge").textContent).toBe("retransmisión pública");
      else expect(screen.queryByTestId("tournament-broadcast-badge")).toBeNull();
      await user.selectOptions(select, "bp");
      expect(screen.getByTestId("entry-privacy-note").textContent).toBe(text);
      expect(document.body.textContent).not.toMatch(/Debes|hac(er|lo) público/i);
      await user.selectOptions(select, "bq");
      expect(screen.queryByTestId("entry-privacy-note")).toBeNull();
      // Mostrar el aviso no toca el bot: ninguna escritura sale de esta pantalla.
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    },
  );
});
