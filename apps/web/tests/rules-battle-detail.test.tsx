// @vitest-environment jsdom
/**
 * R-STATS (FASE 13) · el detalle de batalla adapta las métricas al MODO de reglas:
 *  - reglas de la copia en «Datos de la batalla»;
 *  - respawn limitado: reapariciones usadas y restantes (por bot y por bando);
 *  - deathmatch (respawn ilimitado): sin «Supervivientes» (engañoso), con respawns;
 *  - eliminación: supervivientes, sin columnas de respawn;
 *  - batallas anteriores (sin profile ni rules): la tabla de siempre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { BattleDetailPage } from "../src/pages/BattleDetailPage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const participants = ["R1", "R2", "B1", "B2"].map((name, i) => ({
  botId: `bot_${i}`,
  botName: name,
  version: 1,
  team: i < 2 ? "red" : "blue",
  outcome: i < 2 ? "win" : "loss",
}));
const stat = (team: string, extra: Record<string, unknown>) => ({
  team,
  damageDealt: 100,
  damageTaken: 50,
  shotsFired: 10,
  shotsHit: 5,
  accuracy: 0.5,
  kills: 1,
  died: true,
  deaths: 1,
  respawns: 1,
  aliveAtEnd: true,
  survivedTicks: 600,
  flagCaptures: 0,
  flagsTaken: 0,
  minesDeployed: 0,
  minesTriggered: 0,
  disqualified: false,
  perModule: {},
  ...extra,
});
const team = (t: string, extra: Record<string, unknown>) => ({
  team: t,
  score: 2,
  bots: 2,
  kills: 2,
  deaths: 2,
  damageDealt: 200,
  damageTaken: 100,
  shotsFired: 20,
  shotsHit: 10,
  survivors: 2,
  respawns: 2,
  ...extra,
});

function mock(
  profile: string | undefined,
  rules: unknown,
  perBotExtra: Record<string, unknown> = {},
  perTeamExtra: Record<string, unknown> = {},
) {
  const battle = {
    id: "btl_rs",
    status: "finished",
    mode: "team_deathmatch",
    mapId: "m",
    mapVersion: 1,
    participants,
    result: { winner: "red", ticks: 900, score: { red: 2, blue: 1 } },
    failureKind: "none",
    replayAvailable: true,
    ...(rules ? { rules } : {}),
  };
  const stats = {
    status: "ready",
    perBot: Object.fromEntries(participants.map((p) => [p.botId, stat(p.team, perBotExtra)])),
    perTeam: { red: team("red", perTeamExtra), blue: team("blue", perTeamExtra) },
    diagnostics: {},
    ...(profile ? { profile } : {}),
  };
  const json = (b: unknown) =>
    Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal(
    "fetch",
    vi.fn((u: string | URL) => {
      const url = String(u).replace(/^\/api\/v1/, "");
      if (url === "/battles/btl_rs") return json(battle);
      if (url === "/battles/btl_rs/stats") return json(stats);
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as unknown as typeof fetch,
  );
}
const headers = async () => {
  const t = await screen.findByTestId("battle-stats-sides");
  return Array.from(t.querySelectorAll("th")).map((th) => th.textContent);
};

describe("R-STATS · detalle por modo", () => {
  it("respawn limitado: reglas, reapariciones restantes por bot y por bando, eliminado", async () => {
    mock(
      "limited_respawn",
      {
        name: "Respawn limitado",
        source: "preset",
        profile: "limited_respawn",
        summary: ["2 contra 2", "Respawns: 2 por bot (3 vidas)"],
      },
      { lives: 3, respawnsRemaining: 0, eliminated: true },
      { respawnsRemaining: 0 },
    );
    render(<BattleDetailPage id="btl_rs" />);
    expect((await screen.findByTestId("battle-rules")).textContent).toContain("Respawns: 2 por bot (3 vidas)");
    const h = await headers();
    expect(h).toContain("Respawns");
    expect(h).toContain("Respawns restantes");
    expect(h).toContain("Supervivientes");
    expect(screen.getAllByTestId("stats-lives")[0].textContent).toContain("0 de 2 reapariciones restantes · eliminado");
  });

  it("deathmatch (respawn ilimitado): sin «Supervivientes», con respawns", async () => {
    mock("deathmatch", { name: "Team Deathmatch", source: "preset", profile: "deathmatch", summary: [] });
    render(<BattleDetailPage id="btl_rs" />);
    const h = await headers();
    expect(h).not.toContain("Supervivientes");
    expect(h).toContain("Respawns");
    expect(h).not.toContain("Respawns restantes");
    expect(screen.queryByTestId("stats-lives")).toBeNull();
  });

  it("eliminación: supervivientes y sin columnas de respawn", async () => {
    mock("elimination", { name: "Duelo", source: "preset", profile: "elimination", summary: [] });
    render(<BattleDetailPage id="btl_rs" />);
    const h = await headers();
    expect(h).toContain("Supervivientes");
    expect(h).not.toContain("Respawns");
  });

  it("batalla anterior (sin profile ni rules): columnas de siempre y sin «Reglas»", async () => {
    mock(undefined, undefined);
    render(<BattleDetailPage id="btl_rs" />);
    const h = await headers();
    expect(h).toContain("Supervivientes");
    expect(h).not.toContain("Respawns");
    expect(screen.queryByTestId("battle-rules")).toBeNull();
    const facts = screen.getByTestId("battle-facts");
    expect(within(facts).queryByText("Reglas")).toBeNull();
  });
});
