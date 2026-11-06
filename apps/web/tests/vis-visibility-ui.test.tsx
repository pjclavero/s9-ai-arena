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
import { BotDetailPage } from "../src/pages/BotDetailPage.js";
import { entryPrivacyNote } from "../src/pages/TournamentDetailPage.js";
import { BOT_VISIBILITY_NOTE, CODE_PRIVATE_AGAIN_WARNING } from "../src/visibility.js";

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
    if (method === "GET" && path === "/bots/b1") return bot;
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
afterEach(() => cleanup());

describe("VISIBILIDAD · ficha del bot", () => {
  it("WEB_BOT_VISIBILITY_EDIT · el dueño cambia private → team → public por PATCH /bots/{id}", async () => {
    render(<BotDetailPage botId="b1" meId="u1" />);
    const ctl = await screen.findByTestId("bot-visibility-control");
    expect(within(ctl).getByText(/Sólo tú/)).toBeTruthy();
    expect(within(ctl).getByText(/miembros del equipo/)).toBeTruthy();
    expect(within(ctl).getByText(/Cualquier usuario o visitante/)).toBeTruthy();
    expect(screen.getByTestId("bot-visibility-note").textContent).toBe(BOT_VISIBILITY_NOTE);
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
    render(<BotDetailPage botId="b1" meId="otro" />);
    await screen.findByTestId("bot-visibility-readonly");
    expect(screen.queryByTestId("bot-visibility-control")).toBeNull();
  });

  it("WEB_CODE_VISIBILITY_EDIT · «Código de v4 [Privado][Público]» sólo para el dueño, con aviso al hacerlo público", async () => {
    render(<BotDetailPage botId="b1" meId="u1" initialTab="versions" />);
    const ctl = await screen.findByTestId("code-visibility-4");
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

  it("quien no es el dueño ve «privado»/«público» sin botones", async () => {
    render(<BotDetailPage botId="b1" meId="otro" initialTab="versions" />);
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
