// @vitest-environment jsdom
/**
 * T11.1 · Render de la vista /broadcast en jsdom: pantallas de espera/entre
 * batallas alimentadas por el estado del torneo, branding aplicado por
 * parámetros y CERO interacción (sin botones, sin inputs, cursor oculto).
 *
 * La pantalla EN DIRECTO monta el visor Phaser real de E8 (WebGL/Canvas), que
 * no existe en jsdom: ese camino se cubre con la lógica del director
 * (broadcast-logic.test.ts) + el canal real de E8 (spectator.e2e.test.ts), y
 * queda [PENDIENTE] la pasada en Chromium de verdad (sin navegador aquí).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { BroadcastPage } from "../src/pages/BroadcastPage.js";
import { parseBroadcastConfig } from "../src/broadcast/config.js";

const fetchCalls: { url: string; init?: RequestInit }[] = [];

function mockBattles(items: unknown[]) {
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init });
    return { ok: true, json: async () => ({ items }) } as Response;
  });
}

beforeEach(() => fetchCalls.splice(0));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const scheduled = {
  id: "b1",
  tournamentId: "t1",
  status: "scheduled",
  mode: "deathmatch",
  participants: [
    { botId: "bot-aaaa", version: 1, team: "red" },
    { botId: "bot-bbbb", version: 2, team: "blue" },
  ],
};
const finished = { ...scheduled, id: "b0", status: "finished", result: { score: { red: 2, blue: 1 } } };

describe("T11.1 BroadcastPage (jsdom)", () => {
  it("pantalla de espera con branding por parámetros y sin controles ni cursor", async () => {
    mockBattles([scheduled]);
    const config = parseBroadcastConfig("?tournament=t1&event=Copa%20S9&logo=/img/copa.png&accent=%2300ff88&primary=%23112233");
    const { container } = render(<BroadcastPage config={config} />);

    await waitFor(() => expect(screen.getByTestId("broadcast-waiting")).toBeTruthy());
    // Branding aplicado sin redeploy (DoD)
    expect(screen.getByTestId("broadcast-event").textContent).toBe("Copa S9");
    expect((screen.getByTestId("broadcast-logo") as HTMLImageElement).src).toContain("/img/copa.png");
    const stage = screen.getByTestId("broadcast-stage");
    expect(stage.style.background).toBe("rgb(17, 34, 51)"); // #112233
    expect(stage.style.cursor).toBe("none");
    expect(stage.style.width).toBe("1920px");
    expect(stage.style.height).toBe("1080px");
    // Próxima batalla anunciada desde el estado del torneo (E9, API pública)
    expect(screen.getByTestId("broadcast-next").textContent).toContain("bot-aaaa");
    // Sin interacción: ni botones, ni inputs, ni enlaces
    expect(container.querySelectorAll("button, input, select, a").length).toBe(0);
  });

  it("entre batallas: marcador de la última y anuncio de la siguiente", async () => {
    mockBattles([finished, scheduled]);
    const config = parseBroadcastConfig("?tournament=t1");
    render(<BroadcastPage config={config} />);

    await waitFor(() => expect(screen.getByTestId("broadcast-intermission")).toBeTruthy());
    expect(screen.getByTestId("broadcast-last-score").textContent).toContain("red 2");
    expect(screen.getByTestId("broadcast-next").textContent).toContain("deathmatch");
    // Progreso del torneo en cabecera
    expect(screen.getByTestId("broadcast-round").textContent).toContain("2 / 2");
  });

  it("torneo terminado: pantalla final", async () => {
    mockBattles([finished]);
    render(<BroadcastPage config={parseBroadcastConfig("?tournament=t1")} />);
    await waitFor(() => expect(screen.getByTestId("broadcast-finished")).toBeTruthy());
  });

  it("cero datos privados: todas las peticiones son GET anónimos a /battles", async () => {
    mockBattles([scheduled]);
    render(<BroadcastPage config={parseBroadcastConfig("?tournament=t1")} />);
    await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
    for (const { url, init } of fetchCalls) {
      expect(url).toMatch(/^\/api\/v1\/battles(\?|\/|$)/);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers)).toEqual([]);
    }
  });
});
