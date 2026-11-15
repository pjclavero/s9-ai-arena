/**
 * FIX-BROADCAST · el director de /broadcast distingue la espera legítima (WAITING_VALID)
 * del destino terminado (TARGET_FINISHED / TARGET_CANCELLED) y del fallo de la fuente
 * (SOURCE_ERROR). Antes:
 *  - torneo `finished` con replays públicos apagados ⇒ `{items: []}` ⇒ «Esperando el inicio
 *    del torneo…» para siempre (decideScreen daba `waiting` antes de mirar el estado);
 *  - la web devolviendo index.html ⇒ el `catch` vacío se lo tragaba ⇒ «La batalla empieza
 *    en breve» para siempre.
 * Cada garantía tiene su mutante en scripts/fix-broadcast-mutants.sh.
 */
import { describe, expect, it } from "vitest";
import {
  BroadcastDirector,
  PublicApiError,
  applyTournamentState,
  classifySourceError,
  createPublicApi,
  decideScreen,
  directorStateOf,
  type BattleSummary,
  type BroadcastScreen,
} from "../src/broadcast/director.js";
import { parseBroadcastConfig } from "../src/broadcast/config.js";

const battle = (id: string, status: BattleSummary["status"]): BattleSummary => ({
  id,
  tournamentId: "t1",
  status,
  mode: "deathmatch",
  participants: [{ botId: "bot-a", version: 1, team: "red" }],
});

/** Director de torneo con la lista visible y el estado que se le den. */
function tournamentDirector(visible: () => unknown, state: () => string | null) {
  const screens: BroadcastScreen[] = [];
  const director = new BroadcastDirector({
    target: { kind: "tournament", tournamentId: "t1" },
    fetchJson: async (path) => {
      if (path === "/tournaments/t1") {
        const s = state();
        return s === null ? { id: "t1" } : { id: "t1", state: s };
      }
      if (path === "/tournaments/t1/battles") return visible();
      throw new Error(`ruta inesperada ${path}`);
    },
    onScreen: (s) => screens.push(s),
    onSourceError: () => undefined,
  });
  return { director, screens };
}

function battleDirector(fetchJson: (path: string) => Promise<unknown>, maxTransientFailures?: number) {
  const screens: BroadcastScreen[] = [];
  const errors: string[] = [];
  const director = new BroadcastDirector({
    target: { kind: "battle", battleId: "b1" },
    fetchJson,
    onScreen: (s) => screens.push(s),
    onSourceError: (e) => errors.push(`${e.reason}#${e.consecutive}`),
    maxTransientFailures,
  });
  return { director, screens, errors };
}

const states = (screens: BroadcastScreen[]) => screens.map((s) => directorStateOf(s));

describe("FIX-BROADCAST · estados terminales del torneo", () => {
  it("torneo CERRADO + lista vacía (replays públicos apagados) ⇒ TARGET_FINISHED, nunca «esperando»", async () => {
    const { director, screens } = tournamentDirector(
      () => ({ items: [] }),
      () => "finished",
    );
    await director.tick();
    expect(states(screens)).toEqual(["TARGET_FINISHED"]);
    expect(screens[0]).toMatchObject({ kind: "finished", lastBattle: null });
  });

  it("pura: applyTournamentState(waiting, finished) ⇒ finished; (intermission, finished) ⇒ finished con la última", () => {
    expect(applyTournamentState(decideScreen([], null), "finished").kind).toBe("finished");
    const s = applyTournamentState(
      decideScreen([battle("b1", "finished"), battle("b2", "scheduled")], null),
      "finished",
    );
    expect(s).toMatchObject({ kind: "finished", lastBattle: { id: "b1" } });
    // Con una batalla en directo, el directo manda aunque el estado diga cerrado.
    expect(applyTournamentState(decideScreen([battle("b1", "running")], null), "finished").kind).toBe("live");
  });

  it("torneo cancelado ⇒ TARGET_CANCELLED (terminal propio), con o sin batallas visibles", async () => {
    for (const visible of [[], [battle("b1", "finished")]]) {
      const { director, screens } = tournamentDirector(
        () => ({ items: visible }),
        () => "cancelled",
      );
      await director.tick();
      expect(states(screens)).toEqual(["TARGET_CANCELLED"]);
    }
  });

  it("torneo abierto/en curso con lista vacía (las programadas no se ven) ⇒ WAITING_VALID", async () => {
    for (const st of ["running", "open", "closed"]) {
      const { director, screens } = tournamentDirector(
        () => ({ items: [] }),
        () => st,
      );
      await director.tick();
      expect(states(screens), String(st)).toEqual(["WAITING_VALID"]);
    }
  });

  describe("la consulta del estado del torneo entra en la contabilidad de fallos (R3)", () => {
    const empty = { items: [] };
    function stateFailing(stateCall: () => unknown, maxTransientFailures?: number) {
      const screens: BroadcastScreen[] = [];
      const errors: string[] = [];
      const director = new BroadcastDirector({
        target: { kind: "tournament", tournamentId: "t1" },
        fetchJson: async (path) => {
          if (path === "/tournaments/t1") return stateCall();
          if (path === "/tournaments/t1/battles") return empty;
          throw new Error(`ruta inesperada ${path}`);
        },
        onScreen: (s) => screens.push(s),
        onSourceError: (e) => errors.push(`${e.reason}#${e.consecutive}`),
        maxTransientFailures,
      });
      return { director, screens, errors };
    }

    it("la consulta del torneo falla (5xx) ⇒ reintenta y, a los N seguidos, SOURCE_ERROR; nunca «Esperando»", async () => {
      const { director, screens, errors } = stateFailing(() => {
        throw new PublicApiError("HTTP 503 en GET /tournaments/t1", 503, "http");
      });
      await director.tick();
      await director.tick();
      expect(states(screens)).toEqual([]);
      await director.tick();
      expect(states(screens)).toEqual(["SOURCE_ERROR"]);
      expect(screens[0]).toMatchObject({ kind: "error", reason: "unreachable" });
      expect(errors).toEqual(["unreachable#1", "unreachable#2", "unreachable#3"]);
    });

    it("la consulta del torneo falla una vez y se recupera ⇒ ni error ni «Esperando» por el camino", async () => {
      let n = 0;
      const { director, screens } = stateFailing(() => {
        if (n++ === 0) throw new PublicApiError("HTTP 503", 503, "http");
        return { id: "t1", state: "finished" };
      });
      await director.tick();
      expect(states(screens)).toEqual([]);
      await director.tick();
      expect(states(screens)).toEqual(["TARGET_FINISHED"]);
    });

    it("torneo no encontrado (404) ⇒ SOURCE_ERROR target_not_found en el acto, no «abierto»", async () => {
      const { director, screens } = stateFailing(() => {
        throw new PublicApiError("HTTP 404 en GET /tournaments/t1", 404, "http");
      });
      await director.tick();
      expect(states(screens)).toEqual(["SOURCE_ERROR"]);
      expect(screens[0]).toMatchObject({ kind: "error", reason: "target_not_found" });
    });

    it("respuesta del torneo sin estado ⇒ SOURCE_ERROR invalid_payload", async () => {
      const { director, screens } = stateFailing(() => ({ id: "t1" }));
      await director.tick();
      expect(screens[0]).toMatchObject({ kind: "error", reason: "invalid_payload" });
    });
  });

  it("batalla programada (visible) ⇒ WAITING_VALID", async () => {
    const { director, screens } = battleDirector(async () => battle("b1", "scheduled"));
    await director.tick();
    expect(states(screens)).toEqual(["WAITING_VALID"]);
  });
});

describe("FIX-BROADCAST (R2) · batalla programada (wait=scheduled)", () => {
  function scheduledDirector(
    fetchJson: (path: string) => Promise<unknown>,
    clock: { t: number },
    waitScheduled = true,
  ) {
    const screens: BroadcastScreen[] = [];
    const director = new BroadcastDirector({
      target: { kind: "battle", battleId: "b1" },
      fetchJson,
      onScreen: (s) => screens.push(s),
      onSourceError: () => undefined,
      waitScheduled,
      maxScheduledWaitMs: 60_000,
      now: () => clock.t,
    });
    return { director, screens };
  }
  const notFound = () => new PublicApiError("HTTP 404 en GET /battles/b1", 404, "http");

  it("programada aún no visible (404) ⇒ WAITING_VALID y reintenta; al pasar a running ⇒ LIVE", async () => {
    let running = false;
    const clock = { t: 0 };
    const { director, screens } = scheduledDirector(async () => {
      if (!running) throw notFound();
      return battle("b1", "running");
    }, clock);
    await director.tick();
    clock.t = 30_000;
    await director.tick();
    expect(states(screens)).toEqual(["WAITING_VALID"]);
    running = true;
    await director.tick();
    expect(states(screens)).toEqual(["WAITING_VALID", "LIVE"]);
  });

  it("sin la marca, el mismo 404 es SOURCE_ERROR (destino inexistente) en el acto", async () => {
    const { director, screens } = scheduledDirector(
      async () => {
        throw notFound();
      },
      { t: 0 },
      false,
    );
    await director.tick();
    expect(screens).toMatchObject([{ kind: "error", reason: "target_not_found" }]);
  });

  it("la espera tiene tope: vencido, el 404 pasa a SOURCE_ERROR (no hay espera eterna)", async () => {
    const clock = { t: 0 };
    const { director, screens } = scheduledDirector(async () => {
      throw notFound();
    }, clock);
    await director.tick();
    clock.t = 61_000;
    await director.tick();
    expect(states(screens)).toEqual(["WAITING_VALID", "SOURCE_ERROR"]);
  });

  it("config: wait=scheduled sólo cuenta para una batalla", () => {
    expect(parseBroadcastConfig("?battle=b1&wait=scheduled").waitScheduled).toBe(true);
    expect(parseBroadcastConfig("?battle=b1").waitScheduled).toBe(false);
    expect(parseBroadcastConfig("?tournament=t1&wait=scheduled").waitScheduled).toBe(false);
  });
});

describe("FIX-BROADCAST · SOURCE_ERROR (el catch vacío ya no existe)", () => {
  it("N fallos transitorios seguidos ⇒ SOURCE_ERROR visible (unreachable); antes de N se conserva la pantalla", async () => {
    let fail = false;
    const { director, screens, errors } = battleDirector(async () => {
      if (fail) throw new PublicApiError("HTTP 503 en GET /battles/b1", 503, "http");
      return battle("b1", "running");
    }, 3);
    await director.tick();
    fail = true;
    await director.tick();
    await director.tick();
    expect(states(screens)).toEqual(["LIVE"]);
    await director.tick();
    expect(states(screens)).toEqual(["LIVE", "SOURCE_ERROR"]);
    expect(screens.at(-1)).toMatchObject({ kind: "error", reason: "unreachable" });
    expect(errors).toEqual(["unreachable#1", "unreachable#2", "unreachable#3"]);
  });

  it("un fallo transitorio seguido de éxito ⇒ se recupera sin pasar por error; y tras SOURCE_ERROR también", async () => {
    let fail = 0;
    const { director, screens } = battleDirector(async () => {
      if (fail > 0) {
        fail--;
        throw new TypeError("Failed to fetch");
      }
      return battle("b1", "running");
    }, 3);
    await director.tick();
    fail = 1;
    await director.tick();
    await director.tick();
    expect(states(screens)).toEqual(["LIVE"]);
    // El contador se reinicia con el éxito: 2 fallos + éxito + 2 fallos no llegan a 3 seguidos.
    fail = 2;
    await director.tick();
    await director.tick();
    await director.tick();
    fail = 2;
    await director.tick();
    await director.tick();
    expect(states(screens)).toEqual(["LIVE"]);
    // Tras un SOURCE_ERROR el sondeo sigue: si la fuente vuelve, la emisión se recupera.
    fail = 3;
    await director.tick();
    await director.tick();
    await director.tick();
    await director.tick();
    expect(states(screens)).toEqual(["LIVE", "SOURCE_ERROR", "LIVE"]);
  });

  it("JSON inválido (la web devolviendo index.html) ⇒ SOURCE_ERROR en el ACTO (invalid_json)", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => JSON.parse("<!doctype html><html></html>"),
      }) as unknown as Response) as typeof fetch;
    const api = createPublicApi("/api/v1", fetchImpl);
    const { director, screens } = battleDirector(api.get);
    await director.tick();
    expect(states(screens)).toEqual(["SOURCE_ERROR"]);
    expect(screens[0]).toMatchObject({ kind: "error", reason: "invalid_json" });
  });

  it("JSON con otra forma ⇒ SOURCE_ERROR (invalid_payload), en batalla y en torneo", async () => {
    const b = battleDirector(async () => ({ hello: "world" }));
    await b.director.tick();
    expect(b.screens).toMatchObject([{ kind: "error", reason: "invalid_payload" }]);
    const t = tournamentDirector(
      () => ({ nope: [] }),
      () => "running",
    );
    await t.director.tick();
    expect(t.screens).toMatchObject([{ kind: "error", reason: "invalid_payload" }]);
  });

  it("404 del destino (nunca visto) ⇒ SOURCE_ERROR target_not_found en el acto", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;
    const { director, screens } = battleDirector(createPublicApi("/api/v1", fetchImpl).get);
    await director.tick();
    expect(screens).toMatchObject([{ kind: "error", reason: "target_not_found" }]);
  });

  it("batalla vista en directo que deja de ser legible (404: terminó sin replay público) ⇒ TARGET_FINISHED, no error", async () => {
    let gone = false;
    const { director, screens } = battleDirector(async () => {
      if (gone) throw new PublicApiError("HTTP 404 en GET /battles/b1", 404, "http");
      return battle("b1", "running");
    });
    await director.tick();
    gone = true;
    await director.tick();
    expect(states(screens)).toEqual(["LIVE", "TARGET_FINISHED"]);
  });

  it("clasificación: 4xx permanente, 5xx/429/red transitorios, SyntaxError permanente", () => {
    expect(classifySourceError(new PublicApiError("x", 404, "http"))).toMatchObject({ permanent: true });
    expect(classifySourceError(new PublicApiError("x", 403, "http"))).toMatchObject({
      permanent: true,
      reason: "http_403",
    });
    expect(classifySourceError(new PublicApiError("x", 503, "http"))).toMatchObject({ permanent: false });
    expect(classifySourceError(new PublicApiError("x", 429, "http"))).toMatchObject({ permanent: false });
    expect(classifySourceError(new TypeError("Failed to fetch"))).toMatchObject({ permanent: false });
    expect(classifySourceError(new SyntaxError("Unexpected token <"))).toMatchObject({
      permanent: true,
      reason: "invalid_json",
    });
  });
});
