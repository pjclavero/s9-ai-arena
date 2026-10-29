// @vitest-environment jsdom
/**
 * 4v4-FIX · Carrera en «Nueva batalla» (functional-e2e golden del PR #191): si se
 * marca BATALLA POR EQUIPOS antes de que llegue GET /rulesets, la carga ponía el
 * modo en `modes[0]` (deathmatch). El desplegable de equipos lo pintaba como su
 * primera opción («Deathmatch por equipos»), pero se enviaba `mode: deathmatch` y
 * el ruleset de DM ⇒ 409 `deathmatch_shared_team`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const A = ["A-1", "A-2", "A-3", "A-4"];
const B = ["B-1", "B-2", "B-3", "B-4"];
const RULESETS = {
  modes: ["deathmatch", "team_deathmatch", "capture_the_flag"],
  items: [
    { id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 },
    { id: "tdm-mvp", name: "TDM", mode: "team_deathmatch", budgetCredits: 1000 },
  ],
};

describe("4v4-FIX · BATALLA POR EQUIPOS marcada antes de que carguen los rulesets", () => {
  it("se envía team_deathmatch con su ruleset, no el deathmatch que trae la carga", async () => {
    let releaseRulesets!: () => void;
    const rulesetsReady = new Promise<void>((r) => (releaseRulesets = r));
    const posted: any[] = [];
    apiMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === "/maps?limit=100")
        return {
          items: [
            {
              mapId: "arena",
              name: "Arena",
              version: 1,
              state: "published",
              supportedModes: ["deathmatch", "team_deathmatch"],
            },
          ],
        };
      if (method === "GET" && path === "/bots?limit=100")
        return {
          items: [...A, ...B].map((n) => ({ id: `bot_${n}`, name: n, ownerId: "u1", latestPublishedVersion: 1 })),
        };
      if (method === "GET" && path === "/rulesets") {
        await rulesetsReady;
        return RULESETS;
      }
      if (method === "GET" && path === "/teams?limit=100")
        return {
          items: [
            { id: "t_a", name: "Alfa", isMember: true, bots: A.map((n) => ({ id: `bot_${n}`, name: n })) },
            { id: "t_b", name: "Beta", isMember: true, bots: B.map((n) => ({ id: `bot_${n}`, name: n })) },
          ],
        };
      if (method === "GET" && /^\/bots\/[^/]+\/versions$/.test(path)) return [{ version: 1, state: "published" }];
      if (method === "POST" && path === "/battles") {
        posted.push(body);
        return { id: "btl" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<BattleNewPage me={ME} />);
    // El usuario elige el tipo ANTES de que llegue /rulesets.
    await userEvent.click(await screen.findByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
    releaseRulesets();
    await screen.findAllByRole("option", { name: "Alfa" });
    await userEvent.selectOptions(screen.getByLabelText("equipo A"), "t_a");
    await userEvent.selectOptions(screen.getByLabelText("equipo B"), "t_b");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("team_deathmatch");
    expect((screen.getByLabelText("ruleset") as HTMLSelectElement).value).toBe("tdm-mvp");
    await waitFor(() => expect((screen.getByText("Crear batalla") as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByText("Crear batalla"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ mode: "team_deathmatch", rulesetId: "tdm-mvp" });
  });
});
