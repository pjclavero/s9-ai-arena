/**
 * T11.1 · Lógica pura de la vista /broadcast: autoconfiguración por query,
 * branding por parámetros (DoD: cambia sin redeploy), saneado anti-inyección,
 * y el director de emisión que encadena batallas de un torneo simulado con
 * pantallas de espera entre ellas (DoD T11.1).
 *
 * DoD "cero datos privados": el director solo puede hablar con la API por el
 * cliente ANÓNIMO (createPublicApi, sin Authorization por construcción); aquí
 * se verifica que cada petición va sin credenciales y solo a rutas públicas de
 * visitante. La fuga a nivel de STREAM la cubre el mismo test de E8
 * (spectator.e2e.test.ts): broadcast usa ese mismo canal y cliente.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRANDING,
  matchBroadcastRoute,
  parseBroadcastConfig,
  sanitizeColor,
  sanitizeLogoUrl,
} from "../src/broadcast/config.js";
import {
  BroadcastDirector,
  createPublicApi,
  decideScreen,
  type BattleSummary,
  type BroadcastScreen,
} from "../src/broadcast/director.js";

const battle = (id: string, status: BattleSummary["status"], score?: Record<string, number>): BattleSummary => ({
  id,
  tournamentId: "t1",
  status,
  mode: "deathmatch",
  participants: [
    { botId: "bot-a", version: 1, team: "red" },
    { botId: "bot-b", version: 2, team: "blue" },
  ],
  ...(score ? { result: { score } } : {}),
});

// ─────────────────────────────────────────────────────────── configuración

describe("T11.1 configuración por query", () => {
  it("?battle=id configura modo batalla y ?tournament=id modo torneo", () => {
    expect(parseBroadcastConfig("?battle=b1").target).toEqual({ kind: "battle", battleId: "b1" });
    expect(parseBroadcastConfig("tournament=t1").target).toEqual({ kind: "tournament", tournamentId: "t1" });
    // battle manda si vienen los dos
    expect(parseBroadcastConfig("?battle=b1&tournament=t1").target).toEqual({ kind: "battle", battleId: "b1" });
    expect(parseBroadcastConfig("").target).toBeNull();
  });

  it("el branding viaja por parámetros: sin redeploy (DoD)", () => {
    const c = parseBroadcastConfig(
      "?tournament=t1&event=Copa%20S9&logo=/img/copa.png&primary=%23112233&accent=%23FFB300",
    );
    expect(c.branding).toEqual({
      eventName: "Copa S9",
      logoUrl: "/img/copa.png",
      primaryColor: "#112233",
      accentColor: "#ffb300",
    });
    // La MISMA build con otra query = otro branding (eso es "sin redeploy").
    const c2 = parseBroadcastConfig("?tournament=t1&event=Liga%20Nocturna&accent=%2300ff88");
    expect(c2.branding.eventName).toBe("Liga Nocturna");
    expect(c2.branding.accentColor).toBe("#00ff88");
    expect(c2.branding.primaryColor).toBe(DEFAULT_BRANDING.primaryColor);
  });

  it("sanea lo que entra por URL (la vista corre en un Chromium desatendido)", () => {
    expect(sanitizeColor("red; } body { display:none", "#111")).toBe("#111");
    expect(sanitizeColor("#AbC", "#111")).toBe("#abc");
    expect(sanitizeLogoUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeLogoUrl("data:text/html,<b>x</b>")).toBeNull();
    expect(sanitizeLogoUrl("//evil.example/x.png")).toBeNull();
    expect(sanitizeLogoUrl("https://cdn.example/logo.png")).toBe("https://cdn.example/logo.png");
    expect(parseBroadcastConfig("?battle=..%2F..%2Fetc").target).toBeNull(); // id no conservador
    expect(parseBroadcastConfig("?tournament=t1&poll=1").pollIntervalMs).toBe(4000); // fuera de rango
  });

  it("enruta /broadcast (ruta real) y #/broadcast (hash del panel)", () => {
    expect(matchBroadcastRoute("/broadcast", "?battle=b1", "")?.target).toEqual({ kind: "battle", battleId: "b1" });
    expect(matchBroadcastRoute("/", "", "#/broadcast?tournament=t1")?.target).toEqual({
      kind: "tournament",
      tournamentId: "t1",
    });
    expect(matchBroadcastRoute("/", "", "#/viewer/b1")).toBeNull();
    expect(matchBroadcastRoute("/panel", "?battle=b1", "")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────── decisión pura

describe("T11.1 decideScreen", () => {
  it("sin batallas → espera; scheduled sin jugadas → espera con próxima", () => {
    expect(decideScreen([], null).kind).toBe("waiting");
    const s = decideScreen([battle("b1", "scheduled")], null);
    expect(s).toMatchObject({ kind: "waiting", nextBattle: { id: "b1" }, progress: { played: 0, total: 1 } });
  });

  it("running → en directo, y la batalla actual no se abandona si sigue viva", () => {
    const battles = [battle("b1", "running"), battle("b2", "running")];
    expect(decideScreen(battles, null)).toMatchObject({ kind: "live", battle: { id: "b1" } });
    expect(decideScreen(battles, "b2")).toMatchObject({ kind: "live", battle: { id: "b2" } });
  });

  it("entre batallas → intermedio con marcador de la última y la próxima", () => {
    const s = decideScreen([battle("b1", "finished", { red: 2, blue: 1 }), battle("b2", "scheduled")], "b1");
    expect(s).toMatchObject({
      kind: "intermission",
      lastBattle: { id: "b1" },
      nextBattle: { id: "b2" },
      progress: { played: 1, total: 2 },
    });
  });

  it("todo terminado → pantalla final; una failed no se emite", () => {
    expect(decideScreen([battle("b1", "finished"), battle("b2", "failed")], null)).toMatchObject({
      kind: "finished",
      lastBattle: { id: "b1" },
    });
  });
});

// ──────────────────────────────────────────── director con torneo simulado

describe("T11.1 director: encadena batallas con esperas (torneo simulado)", () => {
  it("waiting → live(b1) → intermission → live(b2) → finished, solo con GETs públicos", async () => {
    // Torneo simulado: la "BD" avanza entre sondeos (lo que haría el worker E9).
    const phases: BattleSummary[][] = [
      [battle("b1", "scheduled"), battle("b2", "scheduled")],
      [battle("b1", "running"), battle("b2", "scheduled")],
      [battle("b1", "finished", { red: 3, blue: 1 }), battle("b2", "scheduled")],
      [battle("b1", "finished", { red: 3, blue: 1 }), battle("b2", "running")],
      [battle("b1", "finished", { red: 3, blue: 1 }), battle("b2", "finished", { red: 0, blue: 2 })],
    ];
    const requested: string[] = [];
    let phase = 0;
    const fetchJson = async (path: string) => {
      requested.push(path);
      // listBattles pagina DESC por creación: el director debe re-ordenar él.
      return { items: [...phases[Math.min(phase, phases.length - 1)]].reverse() };
    };

    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson,
      onScreen: (s) => screens.push(s),
    });

    for (phase = 0; phase < phases.length; phase++) await director.tick();
    // Un sondeo repetido de la misma fase NO duplica pantalla (solo cambios).
    phase = phases.length - 1;
    await director.tick();

    expect(screens.map((s) => s.kind)).toEqual(["waiting", "live", "intermission", "live", "finished"]);
    expect(screens[1]).toMatchObject({ kind: "live", battle: { id: "b1" } });
    expect(screens[2]).toMatchObject({ kind: "intermission", lastBattle: { id: "b1" }, nextBattle: { id: "b2" } });
    expect(screens[3]).toMatchObject({ kind: "live", battle: { id: "b2" } });
    expect(screens[4]).toMatchObject({ kind: "finished", lastBattle: { id: "b2" } });

    // Cero datos privados: SOLO rutas públicas de visitante (cap. 16).
    for (const p of requested) expect(p).toMatch(/^\/battles(\?|\/|$)/);
  });

  it("modo batalla fija: scheduled→espera, running→directo, finished→final", async () => {
    let status: BattleSummary["status"] = "scheduled";
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "battle", battleId: "b9" },
      fetchJson: async (path) => {
        expect(path).toBe("/battles/b9");
        return battle("b9", status);
      },
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    status = "running";
    await director.tick();
    status = "finished";
    await director.tick();
    expect(screens.map((s) => s.kind)).toEqual(["waiting", "live", "finished"]);
  });

  it("un GET perdido no tumba la emisión: conserva pantalla y reintenta", async () => {
    let fail = false;
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "battle", battleId: "b1" },
      fetchJson: async () => {
        if (fail) throw new Error("red caída");
        return battle("b1", "running");
      },
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    fail = true;
    await director.tick(); // no lanza ni cambia pantalla
    fail = false;
    await director.tick();
    expect(screens.map((s) => s.kind)).toEqual(["live"]);
  });
});

// ─────────────────────────────────────────────── cliente anónimo (sin token)

describe("T11.1 createPublicApi: jamás viaja Authorization", () => {
  it("las peticiones salen sin cabeceras de credenciales", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init: init ?? {} });
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }) as typeof fetch;

    const api = createPublicApi("/api/v1", fetchImpl);
    await api.get("/battles?limit=100");
    await api.post("/battles/b1/spectate-ticket");

    expect(calls.map((c) => c.url)).toEqual(["/api/v1/battles?limit=100", "/api/v1/battles/b1/spectate-ticket"]);
    for (const { init } of calls) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers)).toEqual([]); // ni Authorization ni cookies manuales
    }
  });
});
