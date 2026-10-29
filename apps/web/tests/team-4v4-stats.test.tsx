// @vitest-environment jsdom
/**
 * 4v4-STATS (petición de T-STATS, PR #186) · el detalle de batalla pinta el
 * contrato nuevo de GET /battles/{id}/stats sin depender de su merge:
 *  - con respawn `died` = «murió al menos una vez» y `survivedTicks` = tiempo vivo
 *    TOTAL: se enseñan `deaths`, `respawns`, `aliveAtEnd` y `teamKills`, no
 *    «destruido a los …»;
 *  - `perTeam` (por bando): bajas, muertes, daño, disparos, aciertos, supervivientes;
 *  - `perBot.radio` (público) y `radioDroppedByReason` sólo en el diagnóstico;
 *  - con stats antiguas (campos ausentes) se cae al texto y a la suma de siempre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { BattleDetailPage, survivalText } from "../src/pages/BattleDetailPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NAMES = ["A-ATK-1", "A-ATK-2", "A-ATK-3", "A-ATK-4", "B-DEF-1", "B-DEF-2", "B-DEF-3", "B-DEF-4"];
const participants = NAMES.map((name, i) => ({
  botId: `bot_${i}`,
  botName: name,
  version: 1,
  team: i < 4 ? "red" : "blue",
  outcome: i < 4 ? "win" : "loss",
  diagnosticsVisible: i === 0,
}));
const battle = {
  id: "btl_st",
  status: "finished",
  mode: "team_deathmatch",
  mapId: "mvp-arena-01",
  mapVersion: 1,
  participants,
  result: { winner: "red", ticks: 900, score: { red: 8, blue: 3 } },
  failureKind: "none",
  replayAvailable: true,
};
const stat = (team: string, extra: Record<string, unknown>) => ({
  team,
  damageDealt: 100,
  damageTaken: 50,
  shotsFired: 10,
  shotsHit: 5,
  accuracy: 0.5,
  kills: 2,
  died: true,
  survivedTicks: 600,
  flagCaptures: 0,
  flagsTaken: 0,
  minesDeployed: 0,
  minesTriggered: 0,
  disqualified: false,
  perModule: {},
  ...extra,
});
const cells = (r: HTMLElement) => Array.from(r.querySelectorAll("td")).map((td) => td.textContent);

function mockStats(stats: unknown) {
  const json = (b: unknown) =>
    Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal(
    "fetch",
    vi.fn((u: string | URL) => {
      const url = String(u).replace(/^\/api\/v1/, "");
      if (url === "/battles/btl_st") return json(battle);
      if (url === "/battles/btl_st/stats") return json(stats);
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch,
  );
}

describe("4v4-STATS · survivalText", () => {
  it("con los campos nuevos dice muertes, reapariciones, si acabó vivo y el tiempo vivo total", () => {
    expect(survivalText({ died: true, survivedTicks: 600, deaths: 2, respawns: 2, aliveAtEnd: true })).toBe(
      "2 muertes · 2 reapariciones · vivo al final · 0:20 vivo en total",
    );
    expect(survivalText({ died: true, survivedTicks: 300, deaths: 1, respawns: 0, aliveAtEnd: false })).toBe(
      "1 muerte · 0 reapariciones · destruido al final · 0:10 vivo en total",
    );
    expect(survivalText({ died: false, survivedTicks: 900, deaths: 0, respawns: 0, aliveAtEnd: true })).toBe(
      "sobrevivió sin morir",
    );
  });
  it("con stats antiguas (sin deaths) mantiene el texto de siempre", () => {
    expect(survivalText({ died: true, survivedTicks: 300 })).toBe("destruido a los 0:10");
    expect(survivalText({ died: false, survivedTicks: 900 })).toBe("sobrevivió");
  });
});

describe("4v4-STATS · BattleDetailPage", () => {
  it("respawn, perTeam, radio y descartes de radio en el diagnóstico", async () => {
    const perBot = Object.fromEntries(
      participants.map((p, i) => [
        p.botId,
        stat(p.team, {
          deaths: 2,
          respawns: 2,
          aliveAtEnd: i !== 7,
          teamKills: i === 1 ? 1 : 0,
          radio: { sent: 3, received: 5, receivedFromTeammates: 2, receivedFromEnemies: 3 },
        }),
      ]),
    );
    mockStats({
      status: "ready",
      perBot,
      perTeam: {
        blue: {
          team: "blue",
          score: 3,
          bots: 4,
          kills: 3,
          deaths: 8,
          damageDealt: 400,
          damageTaken: 900,
          shotsFired: 40,
          shotsHit: 12,
          survivors: 3,
        },
        red: {
          team: "red",
          score: 8,
          bots: 4,
          kills: 8,
          teamKills: 1,
          deaths: 3,
          damageDealt: 900,
          damageTaken: 400,
          shotsFired: 50,
          shotsHit: 30,
          survivors: 4,
        },
      },
      diagnostics: {
        bot_0: {
          botId: "bot_0",
          version: 1,
          measured: true,
          startup: null,
          hello: null,
          decisions: null,
          decisionTimeouts: null,
          maxConsecutiveTimeouts: null,
          disqualified: false,
          disqualifiedReason: null,
          commands: null,
          rejectionsByReason: null,
          disconnectedAtTick: null,
          container: null,
          cpuMs: null,
          radioDroppedByReason: { rate_limited: 2, too_large: 0 },
        },
      },
    });
    render(<BattleDetailPage id="btl_st" />);
    const rows = await screen.findAllByTestId("stats-row");
    expect(rows).toHaveLength(8);
    expect(rows[0].textContent).toContain("2 muertes · 2 reapariciones · vivo al final · 0:20 vivo en total");
    expect(rows[7].textContent).toContain("destruido al final");
    expect(rows[1].textContent).toContain("2 (+1 de fuego amigo)");
    expect(document.body.textContent).not.toContain("destruido a los");
    // perTeam de la API, en orden rojo → azul.
    const sides = within(screen.getByTestId("battle-stats-sides")).getAllByTestId("stats-side-row");
    expect(sides.map(cells)).toEqual([
      ["rojo", "4", "8", "8 (+1 de fuego amigo)", "3", "900", "400", "50", "30", "4 / 4"],
      ["azul", "4", "3", "3", "8", "400", "900", "40", "12", "3 / 4"],
    ]);
    const radio = within(screen.getByTestId("battle-stats-radio")).getAllByTestId("radio-row");
    expect(radio).toHaveLength(8);
    expect(cells(radio[0])).toEqual(["A-ATK-1 v1", "3", "5", "2", "3"]);
    expect(screen.getByTestId("diagnostics-radio-dropped").textContent).toBe("demasiados mensajes de radio: 2");
  });

  it("stats antiguas (sin perTeam, deaths ni radio): resumen por bando sumado aquí y texto de siempre", async () => {
    const perBot = Object.fromEntries(
      participants.map((p, i) => [p.botId, stat(p.team, { died: i >= 6, survivedTicks: 300 })]),
    );
    mockStats({ status: "ready", perBot, diagnostics: {} });
    render(<BattleDetailPage id="btl_st" />);
    const rows = await screen.findAllByTestId("stats-row");
    expect(rows[0].textContent).toContain("sobrevivió");
    expect(rows[7].textContent).toContain("destruido a los 0:10");
    expect(screen.queryByTestId("battle-stats-radio")).toBeNull();
    const sides = within(screen.getByTestId("battle-stats-sides")).getAllByTestId("stats-side-row");
    expect(sides.map(cells)).toEqual([
      ["rojo", "4", "8", "8", "—", "400", "200", "40", "20", "4 / 4"],
      ["azul", "4", "3", "8", "—", "400", "200", "40", "20", "2 / 4"],
    ]);
  });
});
