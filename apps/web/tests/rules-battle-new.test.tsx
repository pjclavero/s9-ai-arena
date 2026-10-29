// @vitest-environment jsdom
/**
 * R-UI (ADR-021) · «Nueva batalla» con CONJUNTO DE REGLAS:
 *  - tipo de batalla → presets oficiales del tipo + Personalizado + Clásico;
 *  - preset por defecto (Duelo / Team Deathmatch) y su resumen antes de crear;
 *  - Personalizado: opciones avanzadas con los límites del servidor y resumen;
 *  - el cuerpo de POST /battles lleva `rules` (sin él, en Clásico);
 *  - la checklist usa POST /battles/rules-check: una violación de créditos bloquea
 *    «Crear batalla» y se dice qué bot y cuánto se pasa.
 * Mockea `api`; el recorrido real está en las batallas locales de la FASE 19.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CUSTOM_DEFAULTS, RULES_LIMITS, RULES_PRESETS } from "../../../packages/game-rules/battle-rules.js";

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
  { mapId: "dm_map", version: 1, state: "published", supportedModes: ["deathmatch"] },
  { mapId: "tdm_map", version: 1, state: "published", supportedModes: ["team_deathmatch"] },
];
const RULESETS = {
  modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
  items: [
    { id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 },
    { id: "team-deathmatch-mvp", name: "TDM", mode: "team_deathmatch", budgetCredits: 1000 },
  ],
  presets: RULES_PRESETS,
  custom: { defaults: CUSTOM_DEFAULTS, limits: RULES_LIMITS, maxParticipants: 8 },
};
const BOTS = [
  { id: "bot_r", name: "Red", latestPublishedVersion: 1 },
  { id: "bot_b", name: "Blue", latestPublishedVersion: 1 },
];

type Check = (body: any) => unknown;
function mockApi(check: Check = () => ({ ok: true, errors: [], composition: null, rules: null })) {
  const posts: any[] = [];
  const checks: any[] = [];
  apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
    if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
    if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
    if (method === "GET" && path === "/rulesets") return Promise.resolve(RULESETS);
    if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
    if (method === "GET" && /^\/bots\/[^/]+\/versions$/.test(path))
      return Promise.resolve([{ version: 1, state: "published" }]);
    if (method === "POST" && path === "/battles/rules-check") {
      checks.push(body);
      return Promise.resolve(check(body));
    }
    if (method === "POST" && path === "/battles") {
      posts.push(body);
      return Promise.resolve({ id: "btl_r" });
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return { posts, checks };
}

async function pickBots() {
  await screen.findByLabelText("mapa");
  await waitFor(() => expect(screen.getByLabelText("bot rojo").querySelectorAll("option").length).toBeGreaterThan(1));
  await userEvent.selectOptions(screen.getByLabelText("bot rojo"), "bot_r");
  await userEvent.selectOptions(screen.getByLabelText("bot azul"), "bot_b");
}

describe("R-UI · conjunto de reglas en Nueva batalla", () => {
  it("1v1: presets Duelo/Combate/Resistencia + Personalizado + Clásico; Duelo por defecto con resumen", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    const box = await screen.findByTestId("battle-rules");
    for (const name of ["Duelo", "Combate", "Resistencia", "Personalizado", "Clásico"])
      expect(within(box).getByLabelText(`reglas ${name}`)).toBeTruthy();
    expect(within(box).queryByLabelText("reglas Team Deathmatch")).toBeNull();
    expect((within(box).getByLabelText("reglas Duelo") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Una vida. Sin reaparición.", { exact: false })).toBeTruthy();
    const summary = screen.getByTestId("rules-summary");
    expect(summary.textContent).toContain("1 contra 1");
    expect(summary.textContent).toContain("Respawns: ninguno (1 vida)");
    expect(summary.textContent).toContain("Tiempo máximo: 3 min");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("deathmatch");
  });

  it("Duelo ⇒ POST /battles con rules {preset: duel, teamSize: 1}", async () => {
    const { posts } = mockApi();
    render(<BattleNewPage me={ME} />);
    await pickBots();
    await waitFor(() =>
      expect(screen.getByTestId("battle-checklist").textContent).toContain("Reglas y presupuestos: válidos"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear batalla" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].rules).toEqual({ preset: "duel", teamSize: 1 });
    expect(posts[0].mode).toBe("deathmatch");
  });

  it("Clásico ⇒ POST sin rules (contrato anterior)", async () => {
    const { posts, checks } = mockApi();
    render(<BattleNewPage me={ME} />);
    await pickBots();
    await userEvent.click(screen.getByLabelText("reglas Clásico"));
    await userEvent.click(screen.getByRole("button", { name: "Crear batalla" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("rules");
    expect(checks.every((c) => c.rules !== undefined)).toBe(true);
  });

  it("cambiar el modo a uno distinto del preset pasa a Clásico", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    await userEvent.selectOptions(screen.getByLabelText("modo"), "capture_the_flag");
    expect((screen.getByLabelText("reglas Clásico") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId("rules-summary")).toBeNull();
  });

  it("Personalizado: opciones avanzadas, límites del servidor, vidas = respawns + 1 y resumen", async () => {
    const { posts } = mockApi();
    render(<BattleNewPage me={ME} />);
    await pickBots();
    await userEvent.click(screen.getByLabelText("reglas Personalizado"));
    const box = screen.getByTestId("rules-custom");
    await userEvent.selectOptions(within(box).getByLabelText("respawn"), "limited");
    const respawns = within(box).getByLabelText("Reapariciones por bot") as HTMLInputElement;
    expect(respawns.max).toBe(String(RULES_LIMITS.respawnsPerBot.max));
    await userEvent.clear(respawns);
    await userEvent.type(respawns, "3");
    expect(screen.getByTestId("rules-lives").textContent).toContain("4 vidas");
    await userEvent.click(within(box).getByLabelText("Créditos máximos por bot: sin restricción"));
    const cr = within(box).getByLabelText("Créditos máximos por bot") as HTMLInputElement;
    await userEvent.clear(cr);
    await userEvent.type(cr, "900");
    // En 1v1 no se ofrecen topes de equipo ni fuego amigo.
    expect(within(box).queryByLabelText("fuego amigo")).toBeNull();
    expect(within(box).queryByLabelText("Créditos máximos por equipo")).toBeNull();
    const summary = screen.getByTestId("rules-summary").textContent ?? "";
    expect(summary).toContain("Batalla personalizada");
    expect(summary).toContain("Respawns: 3 por bot (4 vidas)");
    expect(summary).toContain("Máx. por bot: 900 cr");
    await waitFor(() =>
      expect(screen.getByTestId("battle-checklist").textContent).toContain("Reglas y presupuestos: válidos"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear batalla" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].rules).toEqual({
      preset: "custom",
      teamSize: 1,
      params: {
        respawn: { mode: "limited", respawnsPerBot: 3, delaySeconds: 5 },
        victory: "score_limit",
        scoreLimit: 10,
        timeLimitMinutes: 10,
        botCredits: 900,
      },
    });
  });

  it("una violación de créditos de rules-check bloquea crear y dice qué bot se pasa y cuánto", async () => {
    const violation = {
      code: "bot_credits_exceeded",
      team: "blue",
      botId: "bot_b",
      limit: 900,
      actual: 1000,
      excess: 100,
      message: "Blue v1 supera el presupuesto máximo por bot en 100 cr (1000/900 cr)",
    };
    const { posts } = mockApi(() => ({
      ok: false,
      errors: [],
      rules: null,
      composition: {
        ok: false,
        limits: { botCredits: 900, teamCredits: null, botMassKg: null, teamMassKg: null },
        teams: [
          {
            team: "red",
            totalCredits: 890,
            totalMassKg: 2890,
            ok: true,
            bots: [{ botId: "bot_r", label: "Red v1", team: "red", costCredits: 890, massKg: 2890, ok: true }],
          },
          {
            team: "blue",
            totalCredits: 1000,
            totalMassKg: 2890,
            ok: false,
            bots: [{ botId: "bot_b", label: "Blue v1", team: "blue", costCredits: 1000, massKg: 2890, ok: false }],
          },
        ],
        violations: [violation],
      },
    }));
    render(<BattleNewPage me={ME} />);
    await pickBots();
    const report = await screen.findByTestId("rules-check");
    const lines = within(report)
      .getAllByTestId("rules-check-bot")
      .map((l) => l.textContent);
    expect(lines).toEqual(["✓ Red v1 — 890/900 cr", "✗ Blue v1 — 1000/900 cr"]);
    expect(screen.getByTestId("rules-check-invalid").textContent).toContain(
      "supera el presupuesto máximo por bot en 100 cr",
    );
    expect(screen.getByTestId("battle-checklist").textContent).toContain("✗ Reglas:");
    expect((screen.getByRole("button", { name: "Crear batalla" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("errores de reglas del servidor aparecen en la checklist", async () => {
    mockApi(() => ({
      ok: false,
      errors: [{ field: "rules.params.timeLimitMinutes", message: "tiempo fuera de rango" }],
      composition: null,
      rules: null,
    }));
    render(<BattleNewPage me={ME} />);
    await pickBots();
    await waitFor(() => expect(screen.getByTestId("battle-checklist").textContent).toContain("tiempo fuera de rango"));
  });

  it("por equipos: presets de equipos y Team Deathmatch por defecto", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    await userEvent.click(screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
    const box = screen.getByTestId("battle-rules");
    for (const name of ["Eliminación por equipos", "Respawn limitado", "Team Deathmatch", "Resistencia por equipos"])
      expect(within(box).getByLabelText(`reglas ${name}`)).toBeTruthy();
    expect(within(box).queryByLabelText("reglas Duelo")).toBeNull();
    expect((within(box).getByLabelText("reglas Team Deathmatch") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("team_deathmatch");
    await userEvent.click(within(box).getByLabelText("reglas Respawn limitado"));
    expect(screen.getByTestId("rules-summary").textContent).toContain("Respawns: 2 por bot (3 vidas)");
  });

  it("sin presets en GET /rulesets (API anterior) no se pinta el selector y se envía sin rules", async () => {
    const { posts } = mockApi();
    apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === "/rulesets")
        return Promise.resolve({ modes: RULESETS.modes, items: RULESETS.items });
      if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
      if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: BOTS });
      if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
      if (method === "GET") return Promise.resolve([{ version: 1, state: "published" }]);
      if (method === "POST" && path === "/battles") {
        posts.push(body);
        return Promise.resolve({ id: "btl_r" });
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    render(<BattleNewPage me={ME} />);
    await pickBots();
    expect(screen.queryByTestId("battle-rules")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Crear batalla" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty("rules");
  });
});
