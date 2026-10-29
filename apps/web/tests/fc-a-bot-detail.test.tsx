// @vitest-environment jsdom
/**
 * DEV-A · A9.19 — vista de bot con Overview · Code · Equipment · Versions.
 * Monta la página contra un backend falso con las formas REALES de la API de
 * versionado y comprueba lo que se RENDERIZA y qué peticiones salen.
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

import { api, ApiRequestError } from "../src/api.js";
import { BotDetailPage } from "../src/pages/BotDetailPage.js";
import { matchBotDetailRoute } from "../src/pages/BotsPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const BOT = {
  id: "b1",
  name: "Ana-bot",
  ownerId: "u1",
  visibility: "private",
  latestPublishedVersion: 1,
  createdAt: "2026-10-01T10:00:00Z",
};
const V = (version: number, state: string, extra: Record<string, unknown> = {}) => ({
  botId: "b1",
  version,
  state,
  runtime: "python",
  loadoutRevision: 1,
  createdAt: `2026-10-0${version}T10:00:00Z`,
  ...extra,
});
const VERSIONS = [
  V(1, "published", { artifactHash: "a".repeat(64), publishedAt: "2026-10-02T00:00:00Z" }),
  V(2, "rejected", { rejectionReason: "protocol_test: ningún COMMAND válido" }),
  V(3, "draft", { parentVersion: 1 }),
];
const detail = (v: ReturnType<typeof V>) => ({
  ...v,
  canReadSource: true,
  childVersions: v.version === 1 ? [3] : [],
  latestBuild:
    v.version === 3
      ? undefined
      : {
          id: `build-${v.version}`,
          status: v.version === 1 ? "passed" : "failed",
          createdAt: v.createdAt,
          stages: [
            {
              name: "protocol_test",
              status: v.version === 1 ? "passed" : "failed",
              message: v.version === 1 ? undefined : "ningún COMMAND válido",
              logs: ["contenedor lanzado"],
            },
            { name: "resource_limits", status: "passed", metrics: { startupMs: 412, p95DecisionMs: 2.5 } },
          ],
        },
  artifact: v.version === 1 ? { hash: "a".repeat(64), buildId: "build-1", createdAt: v.createdAt } : undefined,
});

let calls: { method: string; path: string; body?: unknown }[];
let filesForbidden = false;

beforeEach(() => {
  calls = [];
  filesForbidden = false;
  apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/bots/b1") return BOT;
    if (method === "GET" && path === "/bots/b1/versions") return VERSIONS;
    if (method === "GET" && path === "/bots/b1/loadouts")
      return [
        { revision: 1, chassis: "chassis.medium@1", modules: [{ slot: "drive", moduleId: "movement.tracks@1" }] },
      ];
    const m = /^\/bots\/b1\/versions\/(\d+)$/.exec(path);
    if (method === "GET" && m) return detail(VERSIONS[Number(m[1]) - 1]);
    if (method === "GET" && /\/files$/.test(path)) {
      if (filesForbidden) throw new ApiRequestError(403, { message: "privado" });
      return {
        version: 1,
        packaged: false,
        files: [
          { path: "src/bot.py", content: "class Bot(ArenaBot): pass\n" },
          { path: "requirements.txt", content: "arena-sdk==1.0.0\n" },
        ],
      };
    }
    if (method === "GET" && /\/diff\?against=/.test(path)) {
      return {
        from: 2,
        to: 3,
        files: [
          { path: "src/bot.py", status: "modified", additions: 1, deletions: 1, diff: "@@ -1,1 +1,1 @@\n-a\n+b" },
          { path: "requirements.txt", status: "unchanged", additions: 0, deletions: 0, diff: "" },
        ],
      };
    }
    if (method === "POST" && /actions\/clone$/.test(path)) return V(4, "draft", { parentVersion: 1 });
    throw new Error(`ruta no simulada: ${method} ${path}`);
  });
});
afterEach(() => cleanup());

describe("A9.19 · BotDetailPage", () => {
  it("la ruta #/bots/<id> se reconoce; #/bots no", () => {
    expect(matchBotDetailRoute("#/bots/b1")).toBe("b1");
    expect(matchBotDetailRoute("#/bots")).toBeNull();
    expect(matchBotDetailRoute("#/battles?bot=b1")).toBeNull();
  });

  it("Versions: lista versión, estado, build, artefacto y publicada; el build muestra etapas, motivo y métricas", async () => {
    render(<BotDetailPage botId="b1" meId="u1" initialTab="versions" />);
    await screen.findByTestId("panel-versions");
    await waitFor(() => expect(within(screen.getByTestId("version-row-1")).getByText("passed")).toBeTruthy());
    const r1 = screen.getByTestId("version-row-1");
    expect(within(r1).getByText("published")).toBeTruthy();
    expect(within(r1).getByText(/aaaaaaaaaaaa…/)).toBeTruthy();
    const r2 = screen.getByTestId("version-row-2");
    expect(within(r2).getByText(/rejected — protocol_test: ningún COMMAND válido/)).toBeTruthy();
    expect(within(r2).getByText("failed")).toBeTruthy();
    expect(within(screen.getByTestId("version-row-3")).getByText(/v3 \(desde v1\)/)).toBeTruthy();
    expect(within(screen.getByTestId("version-row-3")).getByText("sin build")).toBeTruthy();

    await userEvent.click(screen.getByTestId("show-build-2"));
    const b = screen.getByTestId("build-detail");
    expect(within(b).getByText(/— ningún COMMAND válido/)).toBeTruthy();
    expect(within(b).getByText(/startupMs=412/)).toBeTruthy();
  });

  it("«Nueva versión desde ésta» hace POST clone y avisa de que la original no cambia", async () => {
    render(<BotDetailPage botId="b1" meId="u1" initialTab="versions" />);
    await screen.findByTestId("clone-1");
    await userEvent.click(screen.getByTestId("clone-1"));
    await screen.findByText(/Creada v4 \(draft\) desde v1\. v1 no cambia\./);
    expect(calls.some((c) => c.method === "POST" && c.path === "/bots/b1/versions/1/actions/clone")).toBe(true);
  });

  it("si el servidor rechaza la versión por el loadout (422), el aviso dice el motivo y qué munición usar", async () => {
    const base = apiMock.getMockImplementation() as (method: string, path: string, body?: unknown) => Promise<unknown>;
    const message =
      "La revisión 1 del loadout ya no es válida: El módulo weapon.cannon@1 no admite ammo.standard@1. Municiones compatibles: ammo.ap, ammo.he. Guarda una revisión corregida y úsala.";
    apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "POST" && /actions\/clone$/.test(path)) {
        throw new ApiRequestError(422, { error: "loadout_invalid", message, violations: [] });
      }
      return base(method, path, body);
    });
    render(<BotDetailPage botId="b1" meId="u1" initialTab="versions" />);
    await userEvent.click(await screen.findByTestId("clone-1"));
    expect((await screen.findByTestId("bot-detail-notice")).textContent).toBe(
      `No se pudo crear la versión: ${message}`,
    );
  });

  it("Comparar pide el diff al backend y lo pinta (sólo ficheros cambiados)", async () => {
    render(<BotDetailPage botId="b1" meId="u1" initialTab="versions" />);
    await userEvent.click(await screen.findByTestId("compare-3"));
    const pre = await screen.findByTestId("diff-src/bot.py");
    expect(pre.textContent).toContain("+b");
    expect(screen.queryByTestId("diff-requirements.txt")).toBeNull();
    expect(calls.some((c) => c.path === "/bots/b1/versions/3/diff?against=2")).toBe(true);
  });

  it("Code: muestra los ficheros; si el código es privado lo dice (403), no pinta un vacío", async () => {
    render(<BotDetailPage botId="b1" meId="u1" initialTab="code" />);
    expect((await screen.findByTestId("file-src/bot.py")).textContent).toContain("class Bot");
    cleanup();
    filesForbidden = true;
    render(<BotDetailPage botId="b1" meId="otro" initialTab="code" />);
    await screen.findByText(/No tienes permiso para ver el código de esta versión/);
    expect(screen.queryByTestId("save-as-new")).toBeNull();
  });

  it("Overview y Equipment se renderizan con datos de la API", async () => {
    render(<BotDetailPage botId="b1" meId="u1" />);
    await screen.findByTestId("panel-overview");
    expect(screen.getByText(/Versión publicada más reciente: v1/)).toBeTruthy();
    await userEvent.click(screen.getByTestId("tab-equipment"));
    expect(screen.getByText(/Revisión 1 · chassis.medium@1/)).toBeTruthy();
    expect(screen.getByText(/Usada por: v1, v2, v3/)).toBeTruthy();
  });
});
