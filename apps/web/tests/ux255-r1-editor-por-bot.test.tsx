// @vitest-environment jsdom
/**
 * #255 · ronda 1 · P2-1 (REVIEWER-B) y P3-4 · el editor de «Código» es de UN bot.
 *
 * Política (no el código): lo que se escribe o se carga en el editor de un bot —su
 * código, su runtime y el linaje «Editar en una versión nueva desde vN»— pertenece a
 * ESE bot. Cambiar de bot en la lista nunca puede hacer que «Subir como versión
 * nueva» cree en el bot B una versión con el código de A ni con un `parentVersion`
 * que es de A (sería un linaje falso). El aviso dice de qué bot y de qué versión
 * viene el código. Si la sesión caduca y el panel se vuelve a montar, el borrador
 * recuperado conserva también su linaje (P3-4).
 *
 * Basado en el test de reproducción del revisor (reviewer-b-p2.test.tsx).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
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
import { loadCatalog, CATALOG_VERSION } from "../../../packages/module-catalog/loadCatalog.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const mk = (id: string, name: string) => ({
  id,
  name,
  ownerId: "u1",
  visibility: "private",
  latestPublishedVersion: 1,
  createdAt: "2026-10-01T10:00:00Z",
});
const BOTS = [mk("bA", "Alfa"), mk("bB", "Beta")];
const CODE: Record<string, string> = { bA: "# CODIGO-DE-ALFA\nclass Bot(ArenaBot): pass\n", bB: "# CODIGO-DE-BETA\n" };
let posts: { path: string; fields: Record<string, string> }[];

beforeEach(() => {
  posts = [];
  sessionStorage.clear();
  apiMock.mockImplementation(async (method: string, path: string, _body?: unknown, opts?: { formData?: FormData }) => {
    if (method === "GET" && path.startsWith("/bots?ownerId=")) return { items: BOTS };
    const m = /^\/bots\/(b[AB])(\/.*)?$/.exec(path.split("?")[0]);
    if (!m) throw new Error(`ruta no simulada: ${method} ${path}`);
    const id = m[1];
    const rest = m[2] ?? "";
    if (method === "GET" && rest === "") return BOTS.find((b) => b.id === id);
    if (method === "GET" && rest === "/versions")
      return [
        {
          botId: id,
          version: 1,
          state: "published",
          runtime: "python",
          loadoutRevision: 1,
          createdAt: "2026-10-01T10:00:00Z",
        },
      ];
    if (method === "GET" && rest === "/loadouts")
      return [
        { revision: 1, chassis: "chassis.medium@1", modules: [{ slot: "drive", moduleId: "movement.tracks@1" }] },
      ];
    if (method === "GET" && /\/versions\/1\/builds$/.test(rest)) return [];
    if (method === "GET" && /\/versions\/1$/.test(rest))
      return { botId: id, version: 1, state: "published", runtime: "python", loadoutRevision: 1 };
    if (method === "GET" && /\/files$/.test(rest))
      return { version: 1, packaged: false, files: [{ path: "src/bot.py", content: CODE[id] }] };
    if (method === "POST" && rest === "/versions") {
      const fields: Record<string, string> = {};
      for (const [k, v] of opts!.formData!.entries()) fields[k] = typeof v === "string" ? v : await (v as Blob).text();
      posts.push({ path, fields });
      return { botId: id, version: 2, state: "draft", runtime: "python", loadoutRevision: 1 };
    }
    return [];
  });
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function renderPage() {
  return render(
    <BotsPage
      me={{ id: "u1", displayName: "Ana", email: "a@a.es", roles: ["user"], twoFactorEnabled: false }}
      catalog={loadCatalog()}
      catalogVersion={CATALOG_VERSION}
      budgetCredits={1000}
    />,
  );
}
const editor = () => screen.getByLabelText("codigo") as HTMLTextAreaElement;

async function editAlfaFromV1() {
  window.location.hash = "#/bots/bA/codigo";
  const view = renderPage();
  await userEvent.click(await screen.findByTestId("edit-as-new"));
  await waitFor(() => expect(editor().value).toContain("CODIGO-DE-ALFA"));
  return view;
}
async function switchTo(name: string, id: string) {
  await userEvent.click(within(screen.getByTestId("bots-active")).getByRole("link", { name }));
  await waitFor(() => expect(window.location.hash).toBe(`#/bots/${id}/codigo`));
  await screen.findByRole("heading", { name });
}

describe("#255 R1 · P2-1 · el editor no arrastra código ni linaje de un bot a otro", () => {
  it("Alfa «Editar desde v1» → Beta → Subir: NUNCA un POST a Beta con el código o el parentVersion de Alfa", async () => {
    await editAlfaFromV1();
    await switchTo("Beta", "bB");
    // En Beta no hay linaje ni código heredado de Alfa.
    expect(screen.queryByTestId("editing-from")).toBeNull();
    expect(editor().value).not.toContain("CODIGO-DE-ALFA");
    await userEvent.click(await screen.findByRole("button", { name: "Subir como versión nueva" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].path).toBe("/bots/bB/versions");
    expect(posts[0].fields.parentVersion).toBeUndefined();
    expect(posts[0].fields.source).not.toContain("CODIGO-DE-ALFA");
  });

  it("al volver a Alfa, su borrador y su linaje siguen siendo de Alfa (y el aviso nombra bot y versión)", async () => {
    await editAlfaFromV1();
    await switchTo("Beta", "bB");
    await switchTo("Alfa", "bA");
    expect(editor().value).toContain("CODIGO-DE-ALFA");
    expect(screen.getByTestId("editing-from").textContent).toMatch(/«Alfa».*código de v1: al subirlo se crea la v2/);
    await userEvent.click(screen.getByRole("button", { name: "Subir como versión nueva" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].path).toBe("/bots/bA/versions");
    expect(posts[0].fields.parentVersion).toBe("1");
    expect(posts[0].fields.source).toContain("CODIGO-DE-ALFA");
  });
});

describe("#255 R1 · P3-4 · el borrador recuperado conserva su linaje", () => {
  it("sesión caducada (desmontar/montar) → el borrador de Alfa vuelve con «desde v1» y se sube con parentVersion=1", async () => {
    const first = await editAlfaFromV1();
    first.unmount(); // lo que hace el App al volver al login
    renderPage();
    await waitFor(() => expect(editor().value).toContain("CODIGO-DE-ALFA"));
    expect(screen.getByTestId("editing-from").textContent).toMatch(/«Alfa».*código de v1/);
    await userEvent.click(screen.getByRole("button", { name: "Subir como versión nueva" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].path).toBe("/bots/bA/versions");
    expect(posts[0].fields.parentVersion).toBe("1");
  });
});
