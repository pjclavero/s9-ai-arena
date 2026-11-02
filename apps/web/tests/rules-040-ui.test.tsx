// @vitest-environment jsdom
/**
 * EQ2 · ADR-022 · «Nueva batalla» con las reglas de 0.4.0:
 *  - CTF (preset ctf@1) en «por equipos»: fija el modo capture_the_flag, enseña el
 *    desempate (capturas → prórroga → siguiente captura → límite de seguridad) y sólo
 *    ofrece mapas COMPATIBLES; los demás salen con el PORQUÉ que da el servidor;
 *  - maxRespawns explícito: 0 ⇒ «1 vida en total», con la explicación de la regla;
 *  - personalizado: aviso de que física/daño/HP/sensores/munición no se tocan, CTF
 *    personalizado con retorno de bandera y bandera propia, y presupuesto de equipo con
 *    reparto libre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CUSTOM_CTF_DEFAULTS,
  CUSTOM_DEFAULTS,
  RULES_LIMITS,
  currentPresets,
} from "../../../packages/game-rules/battle-rules.js";
import { mapModeCompatibility } from "../../../packages/game-rules/map-compat.js";

vi.mock("../src/api.js", () => ({ api: vi.fn() }));
import { api } from "../src/api.js";
import { BattleNewPage } from "../src/pages/BattleNewPage.js";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;
const ME = { id: "u1", displayName: "Op", roles: ["user"] } as never;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

// Contenido mínimo de cada mapa: la compatibilidad la calcula la MISMA función que GET /maps.
const ctfDoc = {
  meta: { supportedModes: ["capture_the_flag", "team_deathmatch"] },
  layers: {
    spawns: [{ team: "red" }, { team: "blue" }],
    bases: [{ team: "red" }, { team: "blue" }],
    flags: [{ team: "red" }, { team: "blue" }],
    zones: [],
  },
};
const tdmDoc = {
  meta: { supportedModes: ["team_deathmatch"] },
  layers: { spawns: [{ team: "red" }, { team: "blue" }], bases: [], flags: [], zones: [] },
};
const MAPS = [
  {
    mapId: "ctf_map",
    version: 1,
    state: "published",
    supportedModes: ctfDoc.meta.supportedModes,
    modeCompatibility: mapModeCompatibility(ctfDoc),
  },
  {
    mapId: "tdm_map",
    version: 1,
    state: "published",
    supportedModes: tdmDoc.meta.supportedModes,
    modeCompatibility: mapModeCompatibility(tdmDoc),
  },
];
const RULESETS = {
  modes: ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"],
  items: [
    { id: "deathmatch-mvp", name: "DM", mode: "deathmatch", budgetCredits: 1000 },
    { id: "team-deathmatch-mvp", name: "TDM", mode: "team_deathmatch", budgetCredits: 1000 },
    { id: "capture-the-flag-mvp", name: "CTF", mode: "capture_the_flag", budgetCredits: 1000 },
  ],
  presets: currentPresets(),
  custom: { defaults: CUSTOM_DEFAULTS, ctfDefaults: CUSTOM_CTF_DEFAULTS, limits: RULES_LIMITS, maxParticipants: 8 },
};

function mockApi() {
  const posts: any[] = [];
  apiMock.mockImplementation((method: string, path: string, body?: unknown) => {
    if (method === "GET" && path === "/maps?limit=100") return Promise.resolve({ items: MAPS });
    if (method === "GET" && path === "/bots?limit=100") return Promise.resolve({ items: [] });
    if (method === "GET" && path === "/rulesets") return Promise.resolve(RULESETS);
    if (method === "GET" && path === "/teams?limit=100") return Promise.resolve({ items: [] });
    if (method === "GET") return Promise.resolve([]);
    if (method === "POST" && path === "/battles/rules-check")
      return Promise.resolve({ ok: true, errors: [], composition: null, rules: null });
    if (method === "POST" && path === "/battles") {
      posts.push(body);
      return Promise.resolve({ id: "btl" });
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  });
  return { posts };
}

async function teamTab() {
  await screen.findByTestId("battle-rules");
  await userEvent.click(screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
  return screen.getByTestId("battle-rules");
}

describe("EQ2 · reglas 0.4.0 en Nueva batalla", () => {
  it("CTF: fija capture_the_flag, enseña la prórroga y explica por qué un mapa no sale", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    const box = await teamTab();
    await userEvent.click(within(box).getByLabelText("reglas Capturar la bandera"));
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("capture_the_flag");
    const tb = screen.getByTestId("rules-tiebreak").textContent ?? "";
    expect(tb).toContain("más capturas");
    expect(tb).toContain("prórroga con el mismo estado");
    expect(tb).toContain("la siguiente captura gana");
    expect(tb).toContain("3 minutos de prórroga");
    const summary = screen.getByTestId("rules-summary").textContent ?? "";
    expect(summary).toContain("Victoria: 3 capturas");
    expect(summary).toContain("Retorno automático de la bandera: 10 s");
    expect(summary).toContain("Bandera propia en base para puntuar: sí");
    // Sólo el mapa con bases y banderas; el otro sale con el motivo del servidor.
    const mapSel = screen.getByLabelText("mapa") as HTMLSelectElement;
    expect([...mapSel.options].map((o) => o.value)).toEqual(["ctf_map@1"]);
    const hidden = screen.getByTestId("maps-hidden").textContent ?? "";
    expect(hidden).toContain("tdm_map v1");
    expect(hidden).toContain("no lo declaró compatible con Capturar la bandera");
    expect(hidden).toContain("no tiene banderas");
  });

  it("Team Deathmatch: desempate puntos → bajas → empate", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    await teamTab();
    const steps = within(screen.getByTestId("rules-tiebreak"))
      .getAllByRole("listitem")
      .map((l) => l.textContent);
    expect(steps).toEqual(["más puntos", "más bajas", "empate"]);
  });

  it("Respawn limitado y Eliminación: los desempates exactos del operador", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    const box = await teamTab();
    await userEvent.click(within(box).getByLabelText("reglas Respawn limitado"));
    let steps = within(screen.getByTestId("rules-tiebreak"))
      .getAllByRole("listitem")
      .map((l) => l.textContent);
    expect(steps).toEqual(["más puntos", "más bots vivos", "más reapariciones restantes", "más bajas", "empate"]);
    await userEvent.click(within(box).getByLabelText("reglas Eliminación por equipos"));
    steps = within(screen.getByTestId("rules-tiebreak"))
      .getAllByRole("listitem")
      .map((l) => l.textContent);
    expect(steps).toEqual(["más bots vivos", "más vidas/reapariciones restantes", "más bajas", "empate"]);
  });

  it("maxRespawns = 0 ⇒ «1 vida en total», y la regla se explica en la UI", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    await userEvent.click(screen.getByLabelText("reglas Personalizado"));
    const box = screen.getByTestId("rules-custom");
    expect(screen.getByTestId("rules-custom-scope").textContent).toContain(
      "La física, el daño, la vida, los sensores y la munición no se pueden alterar",
    );
    await userEvent.selectOptions(within(box).getByLabelText("respawn"), "limited");
    const n = within(box).getByLabelText("Reapariciones por bot (maxRespawns)") as HTMLInputElement;
    expect(n.min).toBe("0");
    await userEvent.clear(n);
    await userEvent.type(n, "0");
    expect(screen.getByTestId("rules-lives").textContent).toContain("1 vida en total");
    expect(screen.getByTestId("rules-respawn-label").textContent).toContain("0 = 1 vida, 1 = 2 vidas, 2 = 3 vidas");
    expect(screen.getByTestId("rules-summary").textContent).toContain(
      "Reaparición: 0 reapariciones por bot (1 vida en total)",
    );
  });

  it("personalizado CTF: retorno de bandera y bandera propia; en 1v1 individual no se ofrece CTF", async () => {
    const { posts } = mockApi();
    render(<BattleNewPage me={ME} />);
    await screen.findByTestId("battle-rules");
    await userEvent.click(screen.getByLabelText("reglas Personalizado"));
    expect(within(screen.getByTestId("rules-custom")).queryByLabelText("juego")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: /BATALLA POR EQUIPOS/ }));
    await userEvent.click(screen.getByLabelText("reglas Personalizado"));
    const box = screen.getByTestId("rules-custom");
    await userEvent.selectOptions(within(box).getByLabelText("juego"), "capture_the_flag");
    expect((screen.getByLabelText("modo") as HTMLSelectElement).value).toBe("capture_the_flag");
    expect(within(box).queryByLabelText("respawn")).toBeNull(); // en CTF siempre ilimitada
    const ret = within(box).getByLabelText("Retorno automático de la bandera") as HTMLInputElement;
    expect(ret.value).toBe("10");
    await userEvent.clear(ret);
    await userEvent.type(ret, "15");
    await userEvent.click(within(box).getByLabelText("bandera propia en base"));
    expect(screen.getByTestId("rules-overtime").textContent).toContain("la siguiente captura gana");
    const summary = screen.getByTestId("rules-summary").textContent ?? "";
    expect(summary).toContain("Retorno automático de la bandera: 15 s");
    expect(summary).toContain("Bandera propia en base para puntuar: no");
    expect(posts).toHaveLength(0);
  });

  it("presupuesto de equipo: se explica el reparto libre entre bots", async () => {
    mockApi();
    render(<BattleNewPage me={ME} />);
    await teamTab();
    await userEvent.click(screen.getByLabelText("reglas Personalizado"));
    const box = screen.getByTestId("rules-custom");
    await userEvent.click(within(box).getByLabelText("Presupuesto total del equipo: sin restricción"));
    const t = within(box).getByLabelText("Presupuesto total del equipo") as HTMLInputElement;
    await userEvent.clear(t);
    await userEvent.type(t, "3500");
    await waitFor(() =>
      expect(screen.getByTestId("rules-team-budget-help").textContent).toContain("1000 + 1000 + 600 + 900"),
    );
    expect(screen.getByTestId("rules-summary").textContent).toContain(
      "Presupuesto del equipo: 3500 cr (reparto libre entre bots)",
    );
  });
});
