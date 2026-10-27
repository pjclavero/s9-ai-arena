// @vitest-environment jsdom
/**
 * UX-D · D1/D3/UX-06 · Detalle de batalla (#/battles/<id>) y lista con nombres.
 *
 * Antes `#/battles/<id>` era 404, la lista enseñaba UUIDs recortados y las
 * estadísticas y el diagnóstico sólo existían en la API. Mockea `fetch` con las
 * formas REALES de la API de UX-D (GET /battles/{id}, /stats, /audit).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { BattleDetailPage } from "../src/pages/BattleDetailPage.js";
import { BattlesPage } from "../src/pages/BattlesPage.js";
import { matchPanelRoute } from "../src/App.js";

const ID = "6953a070-0a7f-4b40-887b-ad2c1155acf1";
const MINE = "5cdd6306-b901-4b52-b691-3753702c0c36";
const RIVAL = "4ae23dac-d09f-49b2-a31a-8e446e5ca666";

const BATTLE = {
  id: ID,
  status: "finished",
  official: false,
  mode: "deathmatch",
  mapId: "mvp-arena-02",
  mapName: "Arena de pruebas 2",
  mapVersion: 1,
  participants: [
    { botId: MINE, botName: "Tanque Rojo", version: 3, team: "red", outcome: "win", diagnosticsVisible: true, cpuMs: 2148 },
    { botId: RIVAL, botName: "Muro Azul", version: 1, team: "blue", outcome: "disqualified", diagnosticsVisible: false, cpuMs: null },
  ],
  result: {
    schema: "battle-result/v1",
    winner: "red",
    ticks: 9000,
    score: { red: 1, blue: 0 },
    disqualified: [RIVAL],
    endReason: "completed",
    agents: "container",
  },
  failureKind: "none",
  replayAvailable: true,
};

const STAT = (team: string, extra: Record<string, unknown> = {}) => ({
  team,
  damageDealt: 120,
  damageTaken: 30,
  shotsFired: 10,
  shotsHit: 4,
  accuracy: 0.4,
  kills: 1,
  died: false,
  survivedTicks: 9000,
  flagCaptures: 0,
  flagsTaken: 0,
  minesDeployed: 0,
  minesTriggered: 0,
  decisionTimeouts: 2,
  distanceM: 412.7,
  disqualified: false,
  perModule: {
    drive: { moduleId: "movement.tracks@1", usesKind: "move_commands", uses: 120, rejections: 0, damageDealt: 0, finalState: "operational" },
    power: { moduleId: "power.generator@1", usesKind: "passive", uses: 0, rejections: 0, damageDealt: 0, finalState: "operational" },
    turret_main: { moduleId: "weapon.cannon@1", usesKind: "shots", uses: 10, rejections: 5, damageDealt: 120, finalState: "operational" },
  },
  ...extra,
});

const STATS_READY = {
  battleId: ID,
  status: "ready",
  perBot: { [MINE]: STAT("red"), [RIVAL]: STAT("blue", { disqualified: true }) },
  diagnostics: {
    [MINE]: {
      botId: MINE,
      botName: "Tanque Rojo",
      version: 3,
      measured: true,
      startup: { ok: true },
      hello: { ok: true, tick: 0, reconnects: 0 },
      decisions: 280,
      decisionTimeouts: 2,
      maxConsecutiveTimeouts: 20,
      disqualified: false,
      disqualifiedReason: null,
      commands: { received: 290, invalid: 7, firstInvalidReason: "/move/throttle maximum", invalidJson: 0, late: 3, wrongTick: 0, extra: 0 },
      rejectionsByReason: { cooldown: 5, no_ammo: 1 },
      disconnectedAtTick: null,
      container: null,
      cpuMs: 2148,
    },
  },
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function mockApi(routes: Record<string, () => Promise<Response>>) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((u: string | URL) => {
      const url = String(u).replace(/^\/api\/v1/, "");
      urls.push(url);
      const hit = routes[url];
      return hit ? hit() : json({ error: "not_found", message: "Ruta no encontrada" }, 404);
    }) as unknown as typeof fetch,
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UX-D · ruta #/battles/<id>", () => {
  it("un UUID abre el detalle; basura y la lista siguen como estaban", () => {
    expect(matchPanelRoute(`#/battles/${ID}`)).toEqual({ kind: "battle", id: ID });
    expect(matchPanelRoute(`#/battles/${ID}?x=1`)).toEqual({ kind: "battle", id: ID });
    expect(matchPanelRoute("#/battles/basura")).toBeNull();
    expect(matchPanelRoute("#/battles")).toEqual({ kind: "battles", botFilter: undefined });
    expect(matchPanelRoute("#/battles/new")).toEqual({ kind: "battle-new" });
  });
});

describe("UX-D · D1 resultado claro", () => {
  it("ganador con nombre y versión, marcador, duración, mapa, modo, versiones y enlace al replay; ni UUIDs ni veh_", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json(BATTLE),
      [`/battles/${ID}/stats`]: () => json(STATS_READY),
      [`/battles/${ID}/audit`]: () =>
        json({ versions: { engine: "e2@1.4.0", physics: "rapier2d-compat@0.19.3", rules: "dm_mvp@1", catalog: "mvp@1", protocol: "arena/1" } }),
    });
    render(<BattleDetailPage id={ID} />);
    const winner = await screen.findByTestId("battle-winner");
    expect(winner.textContent).toContain("gana red (Tanque Rojo v3)");
    expect(winner.textContent).toContain("red: 1 · blue: 0");
    expect(screen.getByTestId("battle-duration").textContent).toBe("5:00 de partida (9000 ticks a 30/s)");
    const facts = screen.getByTestId("battle-facts").textContent ?? "";
    expect(facts).toContain("todos contra todos");
    expect(facts).toContain("Arena de pruebas 2 (versión 1)");
    expect((await screen.findByTestId("battle-versions")).textContent).toContain("motor e2@1.4.0");
    const rows = screen.getAllByTestId("participant-row").map((r) => r.textContent);
    expect(rows[0]).toContain("Tanque Rojo");
    expect(rows[0]).toContain("v3");
    expect(rows[1]).toContain("Muro Azul");
    expect(rows[1]).toContain("descalificado");
    expect((screen.getByTestId("battle-replay-link") as HTMLAnchorElement).getAttribute("href")).toBe(`#/replay/${ID}?t=0`);

    const text = screen.getByTestId("battle-detail").textContent ?? "";
    expect(text).not.toContain(MINE.slice(0, 8));
    expect(text).not.toContain(RIVAL.slice(0, 8));
    expect(text).not.toMatch(/veh_\d|undefined|null|\[object Object\]/);
  });
});

describe("UX-D · D3 estadísticas en la web", () => {
  it("disparos, aciertos, precisión, daño, bajas, supervivencia, recorrido, timeouts y uso de módulos con QUÉ mide", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json(BATTLE),
      [`/battles/${ID}/stats`]: () => json(STATS_READY),
      [`/battles/${ID}/audit`]: () => json({}),
    });
    render(<BattleDetailPage id={ID} />);
    const rows = await screen.findAllByTestId("stats-row");
    const cells = within(rows[0])
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(["Tanque Rojo v3", "10", "4", "40 %", "120", "30", "1", "sobrevivió", "413 m", "2", "—"]);
    const usage = screen.getAllByTestId("module-usage")[0].textContent ?? "";
    expect(usage).toContain("120 órdenes de movimiento"); // antes drive.uses = 0 siempre
    expect(usage).toContain("pasivo (actúa solo)");
    expect(usage).toContain("10 disparos");
  });

  it("TD-065 · stats aún no escritas: «calculando», nunca una tabla vacía", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json(BATTLE),
      [`/battles/${ID}/stats`]: () => json({ battleId: ID, status: "pending", perBot: {}, diagnostics: {} }),
      [`/battles/${ID}/audit`]: () => json({}),
    });
    render(<BattleDetailPage id={ID} />);
    expect((await screen.findByTestId("stats-pending")).textContent).toMatch(/Calculando estadísticas/);
    expect(screen.queryByTestId("battle-stats")).toBeNull();
  });
});

describe("UX-06 · diagnóstico de TUS bots", () => {
  it("se ve el del bot propio con motivos legibles; no aparece sección para el rival", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json(BATTLE),
      [`/battles/${ID}/stats`]: () => json(STATS_READY),
      [`/battles/${ID}/audit`]: () => json({}),
    });
    render(<BattleDetailPage id={ID} />);
    const diags = await screen.findAllByTestId("bot-diagnostics");
    expect(diags.length).toBe(1);
    expect(diags[0].getAttribute("data-bot-id")).toBe(MINE);
    const problems = within(diags[0]).getByTestId("diagnostics-problems").textContent ?? "";
    expect(problems).toContain("7 COMMAND con forma inválida descartados (primero: /move/throttle maximum)");
    expect(within(diags[0]).getByTestId("diagnostics-rejections").textContent).toBe(
      "arma en enfriamiento (cadencia): 5 · sin munición: 1",
    );
    const text = diags[0].textContent ?? "";
    expect(text).toContain("se descalifica con 20 seguidos");
    expect(text).toContain("2148 ms");
    expect(text).not.toMatch(/seccomp|proxy|token|\/data\//i);
  });

  it("descalificado por no arrancar: lo dice en palabras", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json(BATTLE),
      [`/battles/${ID}/stats`]: () =>
        json({
          battleId: ID,
          status: "unavailable",
          perBot: {},
          diagnostics: {
            [MINE]: {
              ...STATS_READY.diagnostics[MINE],
              startup: { ok: false, reason: "bot_execution_timeout" },
              hello: null,
              commands: null,
              decisions: null,
              decisionTimeouts: null,
              rejectionsByReason: null,
              disqualified: true,
              disqualifiedReason: "bot_execution_timeout",
            },
          },
        }),
      [`/battles/${ID}/audit`]: () => json({}),
    });
    render(<BattleDetailPage id={ID} />);
    const problems = (await screen.findByTestId("diagnostics-problems")).textContent ?? "";
    expect(problems).toContain("No arrancó: no llegó a conectarse (HELLO) dentro del plazo de arranque.");
    expect(problems).toContain("Descalificado:");
    expect(screen.getByTestId("stats-unavailable")).toBeTruthy();
  });
});

describe("UX-D · permiso incorrecto", () => {
  it("una batalla ajena o inexistente: error visible de «no encontrado», sin datos", async () => {
    mockApi({
      [`/battles/${ID}`]: () => json({ error: "not_found", message: "Batalla no encontrada" }, 404),
      [`/battles/${ID}/stats`]: () => json({ error: "not_found", message: "Batalla no encontrada" }, 404),
      [`/battles/${ID}/audit`]: () => json({ error: "not_found", message: "Batalla no encontrada" }, 404),
    });
    render(<BattleDetailPage id={ID} />);
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-error-kind")).toBe("notFound");
    expect(screen.queryByTestId("battle-winner")).toBeNull();
  });
});

describe("UX-D · lista de batallas con nombres y enlace al detalle", () => {
  it("participantes por nombre y versión, mapa por nombre, modo en palabras", async () => {
    mockApi({ "/battles": () => json({ items: [BATTLE] }) });
    render(<BattlesPage />);
    const link = (await screen.findByTestId("battle-detail-link")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(`#/battles/${ID}`);
    expect(link.textContent).toBe("Tanque Rojo v3 (red) vs Muro Azul v1 (blue)");
    const row = screen.getByTestId("battle-row");
    expect(row.textContent).toContain("Arena de pruebas 2");
    expect(row.textContent).toContain("todos contra todos");
    expect(within(row).getByTestId("battle-outcome").textContent).toContain("gana red (Tanque Rojo v3)");
    expect(row.textContent).not.toContain(MINE.slice(0, 8));
  });
});
