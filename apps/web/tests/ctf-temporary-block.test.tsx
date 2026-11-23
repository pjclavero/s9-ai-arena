// @vitest-environment jsdom
/**
 * V1 · «Nueva batalla» no ofrece captura de bandera mientras la API la declare bloqueada
 * (GET /rulesets → disabledModes): ni en el selector de modo, ni como preset, ni como
 * juego del personalizado (si éste se muestra, va deshabilitado con su motivo).
 * Sin `disabledModes` (API anterior o interruptor activado) todo sigue como antes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CUSTOM_DEFAULTS, RULES_LIMITS, RULES_PRESETS } from "../../../packages/game-rules/battle-rules.js";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { BattleNewPage } from "../src/pages/BattleNewPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Op", roles: ["user"] } as never;
const REASON = "El modo captura la bandera está deshabilitado temporalmente mientras se corrige.";

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

function mockApi(disabled: boolean) {
  apiMock.mockImplementation((method: string, path: string) => {
    if (method === "GET" && path === "/maps?limit=100")
      return Promise.resolve({
        items: [
          { mapId: "dm_map", version: 1, state: "published", supportedModes: ["deathmatch"] },
          { mapId: "tdm_map", version: 1, state: "published", supportedModes: ["team_deathmatch", "capture_the_flag"] },
        ],
      });
    if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: [] });
    if (method === "GET" && path === "/rulesets")
      return Promise.resolve({
        modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
        ...(disabled ? { disabledModes: [{ mode: "capture_the_flag", reason: REASON }] } : {}),
        items: [{ id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 }],
        presets: RULES_PRESETS,
        custom: { defaults: CUSTOM_DEFAULTS, limits: RULES_LIMITS, maxParticipants: 8 },
      });
    if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
}

const modeValues = () =>
  Array.from((screen.getByLabelText("modo") as HTMLSelectElement).querySelectorAll("option")).map((o) => o.value);

describe("V1 · CTF bloqueado en Nueva batalla", () => {
  it("el selector de modo no ofrece capture_the_flag y se explica el motivo", async () => {
    mockApi(true);
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    expect(modeValues()).not.toContain("capture_the_flag");
    expect(modeValues()).toContain("deathmatch");
    expect(screen.getByTestId("mode-disabled-capture_the_flag").textContent).toContain("deshabilitado temporalmente");
  });

  it("por equipos: ni el preset CTF ni el juego CTF del personalizado están disponibles", async () => {
    mockApi(true);
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    await userEvent.click(screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
    const box = await screen.findByTestId("battle-rules");
    expect(within(box).queryByLabelText(/reglas Captura/i)).toBeNull();
    expect(modeValues()).not.toContain("capture_the_flag");
    await userEvent.click(within(box).getByLabelText("reglas Personalizado"));
    const opt = screen.getByRole("option", { name: /Capturar la bandera/ }) as HTMLOptionElement;
    expect(opt.disabled).toBe(true);
    expect(opt.title).toBe(REASON);
  });

  it("sin bloqueo (interruptor activado) CTF se ofrece como siempre", async () => {
    mockApi(false);
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    expect(modeValues()).toContain("capture_the_flag");
    expect(screen.queryByTestId("mode-disabled-capture_the_flag")).toBeNull();
  });
});
