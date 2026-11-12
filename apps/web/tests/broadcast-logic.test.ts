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
// STREAMING-UX §7 (al final) · REPLAY_STREAMING_CURRENT_BEHAVIOR = sólo el estado final.
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
      const cur = phases[Math.min(phase, phases.length - 1)];
      if (path === "/tournaments/t1") {
        const done = cur.every((b) => b.status === "finished");
        return { id: "t1", state: done ? "finished" : "running" };
      }
      // listTournamentBattles devuelve el calendario en orden de juego (ASC).
      return { items: [...cur] };
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

    // Cero datos privados: SOLO la ruta pública de visitante del torneo (cap. 16).
    for (const p of requested) expect(p).toMatch(/^\/tournaments\/t1(\/battles)?$/);
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

describe("EQ5 · el modo torneo lee el calendario COMPLETO del torneo, no la última página global", () => {
  // Defecto real (auditoría EQ5, 2026-11-02): el director pedía `GET /battles?limit=100`
  // (las 100 batallas MÁS RECIENTES de toda la plataforma, máximo de `parseLimit`) y
  // filtraba por torneo en el cliente. Con más de 100 batallas creadas después de las
  // del torneo (prácticas, otro torneo…) la emisión se quedaba en «Esperando el inicio
  // del torneo…» con una batalla del torneo EN DIRECTO. La API ya tiene la ruta
  // pública y completa: `GET /tournaments/{id}/battles` (visitor, ASC por creación).
  const ajena = (i: number): BattleSummary => ({ ...battle(`x${i}`, "finished"), tournamentId: "otro" });

  it("con la página global llena de batallas ajenas, la batalla del torneo en directo SE EMITE", async () => {
    const requested: string[] = [];
    const fetchJson = async (path: string) => {
      requested.push(path);
      if (path.startsWith("/battles?")) return { items: Array.from({ length: 100 }, (_, i) => ajena(i)) };
      if (path === "/tournaments/t1/battles") return { items: [battle("b1", "finished"), battle("b2", "running")] };
      if (path === "/tournaments/t1") return { id: "t1", state: "running" };
      throw new Error(`ruta inesperada ${path}`);
    };
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson,
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    expect(screens.at(-1)).toMatchObject({ kind: "live", battle: { id: "b2" }, progress: { played: 1 } });
    expect(requested.filter((p) => p.startsWith("/battles"))).toEqual([]);
    expect(requested).toContain("/tournaments/t1/battles");
  });

  it("respeta el orden ASC de la ruta del torneo (no lo invierte): la última jugada es la última", async () => {
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson: async (path) =>
        path === "/tournaments/t1"
          ? { id: "t1", state: "finished" }
          : { items: [battle("b1", "finished", { red: 1, blue: 0 }), battle("b2", "finished", { red: 0, blue: 5 })] },
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    expect(screens.at(-1)).toMatchObject({ kind: "finished", lastBattle: { id: "b2" } });
  });
});

describe("EQ5 · un visitante NO ve las batallas programadas: el final lo decide el estado del torneo", () => {
  // Defecto real reproducido en Chromium (auditoría EQ5, 2026-11-02): la vista es
  // ANÓNIMA por construcción y la política de lectura (battle-access.ts) sólo enseña a
  // un visitante las batallas `running` (directo público) y las `finished` (replay
  // público). Las `scheduled` NO. Con B1 terminada y B2 aún programada, la lista visible
  // era [B1] ⇒ decideScreen la daba por la ÚLTIMA ⇒ «Torneo terminado. ¡Gracias por
  // vernos!» en mitad del torneo, y la cabecera rotulaba «Batalla 1 / 1».
  const fetchFor = (visible: () => BattleSummary[], state: () => string) => async (path: string) => {
    if (path === "/tournaments/t1") return { id: "t1", state: state() };
    if (path === "/tournaments/t1/battles") return { items: visible() };
    throw new Error(`ruta inesperada ${path}`);
  };

  it("B1 terminada y B2 oculta (programada) con el torneo en curso ⇒ intermedio, NO pantalla final", async () => {
    let visible = [battle("b1", "running")];
    let state = "running";
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson: fetchFor(
        () => visible,
        () => state,
      ),
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    visible = [battle("b1", "finished", { red: 2, blue: 1 })]; // B2 existe, pero el visitante no la ve
    await director.tick();
    expect(screens.at(-1)?.kind).toBe("intermission");
    expect(screens.at(-1)).toMatchObject({ lastBattle: { id: "b1" }, nextBattle: null });
    // El total no es conocible para un visitante mientras el torneo sigue: no se inventa «1 / 1».
    expect(screens.at(-1)?.progress).toEqual({ played: 1, total: null });

    visible = [battle("b1", "finished", { red: 2, blue: 1 }), battle("b2", "running")];
    await director.tick();
    expect(screens.at(-1)).toMatchObject({ kind: "live", battle: { id: "b2" } });

    visible = [battle("b1", "finished", { red: 2, blue: 1 }), battle("b2", "finished", { red: 0, blue: 3 })];
    state = "finished";
    await director.tick();
    expect(screens.at(-1)).toMatchObject({
      kind: "finished",
      lastBattle: { id: "b2" },
      progress: { played: 2, total: 2 },
    });
    expect(screens.map((s) => s.kind)).toEqual(["live", "intermission", "live", "finished"]);
  });

  it("si el estado del torneo no se puede leer, NUNCA anuncia el final: reintenta y luego SOURCE_ERROR", async () => {
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson: async (path) => {
        if (path === "/tournaments/t1") throw new Error("HTTP 503");
        return { items: [battle("b1", "finished", { red: 1, blue: 0 })] };
      },
      onScreen: (s) => screens.push(s),
      onSourceError: () => undefined,
    });
    await director.tick();
    expect(screens).toEqual([]);
    await director.tick();
    await director.tick();
    expect(screens.map((s) => s.kind)).toEqual(["error"]);
  });

  it("un torneo cancelado también cierra la emisión con su pantalla terminal (FIX-BROADCAST: «cancelado»)", async () => {
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "tournament", tournamentId: "t1" },
      fetchJson: fetchFor(
        () => [battle("b1", "finished")],
        () => "cancelled",
      ),
      onScreen: (s) => screens.push(s),
    });
    await director.tick();
    expect(screens.map((s) => s.kind)).toEqual(["cancelled"]);
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

// ───────────────────────────────── STREAMING-UX §7 · REPLAY_STREAMING_CURRENT_BEHAVIOR
describe("STREAMING-UX §7 · /broadcast?battle=<finalizada> muestra SÓLO el estado final (no reproduce)", () => {
  it("una batalla terminada da la pantalla `finished` con el marcador, en cada sondeo, y nunca `live`", async () => {
    const requested: string[] = [];
    const fetchJson = async (path: string) => {
      requested.push(path);
      return battle("b-fin", "finished", { red: 3, blue: 1 });
    };
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "battle", battleId: "b-fin" },
      fetchJson,
      onScreen: (s) => screens.push(s),
    });
    for (let i = 0; i < 5; i++) await director.tick();
    // Una sola pantalla (nunca cambia) y es la del final: ni tick 0, ni progreso, ni visor.
    expect(screens.map((s) => s.kind)).toEqual(["finished"]);
    expect(screens[0]).toMatchObject({
      kind: "finished",
      lastBattle: { id: "b-fin", result: { score: { red: 3, blue: 1 } } },
    });
    // Sólo se lee el resumen de la batalla: ni ticket de espectador ni replay.
    expect(requested.every((p) => p === "/battles/b-fin")).toBe(true);
  });
});
