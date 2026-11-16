/**
 * FIX-DIRECTOR-DELAY · El director de /broadcast decide con la línea temporal PÚBLICA
 * RETRASADA, no con el estado real de la API.
 *
 * Defecto demostrado en C2 (2026-11-16, delaySeconds=30): la última batalla terminó en real
 * a las 01:46:42 y el director anunció «Torneo terminado» a las 01:46:54, con el feed
 * retrasado aún emitiendo hasta las 01:47:12. Cada fin y cambio de batalla cortaba igual
 * los 30 s finales.
 *
 * Escenario determinista con reloj VIRTUAL (segundos): una competición real (batallas con
 * inicio y fin reales), la API anónima que la refleja (sondeo cada 4 s) y una línea temporal
 * que reproduce la semántica del gateway (fase del feed = estado de `t − retardo`; sólo se
 * conoce la de las batallas seguidas). El transporte real (gateway + ws + SpectatorClient)
 * está en director-delayed-timeline.e2e.test.ts.
 *
 * Mutantes: scripts/director-delay-mutants.py.
 */
import { describe, expect, it } from "vitest";
import {
  BroadcastDirector,
  directorStateOf,
  projectBattleStatus,
  projectDelayedTimeline,
  type BattleSummary,
  type BroadcastScreen,
} from "../src/broadcast/director.js";
import type { FeedPhase, FeedStatus, PublicTimeline } from "../src/broadcast/delayed-timeline.js";

interface SimBattle {
  id: string;
  start: number;
  end: number;
}

interface Shown {
  t: number;
  screen: BroadcastScreen;
}

const POLL_S = 4;
const STEP_S = 0.5;

/** Competición real + API anónima + línea temporal con la semántica del gateway. */
class Sim implements PublicTimeline {
  t = 0;
  readonly trackLog: { t: number; id: string }[] = [];
  maxTrackedSeen = 0;
  private readonly entries = new Map<string, { phase: FeedPhase; sinceMs: number }>();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly battles: SimBattle[],
    readonly delayS: number,
    readonly opts: { replaysPublic?: boolean; unavailable?: Set<string> } = {},
  ) {}

  // ── competición real ───────────────────────────────────────────────────────────
  realStatus(b: SimBattle): BattleSummary["status"] {
    return this.t < b.start ? "scheduled" : this.t < b.end ? "running" : "finished";
  }
  realEnd(): number {
    return Math.max(...this.battles.map((b) => b.end));
  }
  summary(b: SimBattle): BattleSummary {
    const st = this.realStatus(b);
    return {
      id: b.id,
      tournamentId: "t1",
      status: st,
      mode: "deathmatch",
      participants: [
        { botId: `${b.id}-red`, version: 1, team: "red", outcome: st === "finished" ? "win" : undefined },
        { botId: `${b.id}-blue`, version: 1, team: "blue", outcome: st === "finished" ? "loss" : undefined },
      ],
      result: st === "finished" ? { score: { red: 3, blue: 1 }, ticks: 999 } : undefined,
    };
  }
  /** API anónima: running siempre; finished sólo con replays públicos; scheduled nunca. */
  fetchJson = async (path: string): Promise<unknown> => {
    if (path === "/tournaments/t1") return { id: "t1", state: this.t >= this.realEnd() ? "finished" : "running" };
    if (path === "/tournaments/t1/battles") {
      const items = this.battles
        .map((b) => this.summary(b))
        .filter((s) => s.status === "running" || (s.status === "finished" && this.opts.replaysPublic !== false));
      return { items };
    }
    if (path.startsWith("/battles/")) {
      const b = this.battles.find((x) => `/battles/${x.id}` === path)!;
      return this.summary(b);
    }
    throw new Error(`ruta inesperada ${path}`);
  };

  // ── línea temporal (semántica del gateway) ─────────────────────────────────────
  private phaseOf(id: string): FeedPhase {
    if (this.opts.unavailable?.has(id)) return "unavailable";
    const b = this.battles.find((x) => x.id === id)!;
    const d = this.t - this.delayS; // el feed retrasado enseña el estado de `t − retardo`
    return d >= b.end ? "ended" : d >= b.start ? "playing" : "pending";
  }
  track(id: string): void {
    if (this.entries.has(id)) return;
    // Conexión «instantánea»: el init llega en el mismo instante.
    this.entries.set(id, { phase: this.phaseOf(id), sinceMs: this.t * 1000 });
    this.trackLog.push({ t: this.t, id });
    this.maxTrackedSeen = Math.max(this.maxTrackedSeen, this.entries.size);
  }
  release(id: string): void {
    this.entries.delete(id);
  }
  status(id: string): FeedStatus | undefined {
    const e = this.entries.get(id);
    return e ? { phase: e.phase, delayMs: this.delayS * 1000, sinceMs: e.sinceMs } : undefined;
  }
  tracked(): string[] {
    return [...this.entries.keys()];
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Avanza las fases (monótonas) y avisa como lo hace SpectatorTimeline. */
  advance(): void {
    let changed = false;
    for (const [id, e] of this.entries) {
      const p = this.phaseOf(id);
      if (p !== e.phase && e.phase !== "ended") {
        e.phase = p;
        e.sinceMs = this.t * 1000;
        changed = true;
      }
    }
    if (changed) for (const fn of this.listeners) fn();
  }
}

async function run(
  sim: Sim,
  untilS: number,
  opts: { timeline?: boolean; target?: "tournament" | "battle" } = {},
): Promise<Shown[]> {
  const shown: Shown[] = [];
  const director = new BroadcastDirector({
    target:
      opts.target === "battle"
        ? { kind: "battle", battleId: sim.battles[0].id }
        : { kind: "tournament", tournamentId: "t1" },
    fetchJson: sim.fetchJson,
    onScreen: (screen) => shown.push({ t: sim.t, screen }),
    onSourceError: () => undefined,
    now: () => sim.t * 1000,
    ...(opts.timeline === false ? {} : { timeline: sim }),
  });
  for (let i = 0; i * STEP_S <= untilS; i++) {
    sim.t = i * STEP_S;
    if (opts.timeline !== false) {
      sim.advance(); // un cambio de fase dispara un ciclo del director (lectura fresca de la API)
      await new Promise((r) => setImmediate(r));
    }
    if (Math.abs(sim.t / POLL_S - Math.round(sim.t / POLL_S)) < 1e-9) await director.tick();
  }
  director.stop();
  return shown;
}

/** Pantalla vigente en el instante t. */
function at(shown: Shown[], t: number): BroadcastScreen | null {
  let cur: BroadcastScreen | null = null;
  for (const s of shown) if (s.t <= t) cur = s.screen;
  return cur;
}
const liveId = (s: BroadcastScreen | null) => (s?.kind === "live" ? s.battle.id : null);
const firstTime = (shown: Shown[], pred: (s: BroadcastScreen) => boolean) => shown.find((x) => pred(x.screen))?.t;
/** Instantes de la rejilla del escenario en [a, b). */
function grid(a: number, b: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(a / STEP_S) * STEP_S; t < b - 1e-9; t += STEP_S) out.push(t);
  return out;
}

const D = 30;
// Batallas SECUENCIALES (no simultáneas): B empieza en real antes del final retrasado de A.
const SEQ: SimBattle[] = [
  { id: "A", start: 10, end: 40 },
  { id: "B", start: 46, end: 80 },
];

describe("FIX-DIRECTOR-DELAY · la línea temporal pública retrasada manda", () => {
  it("DELAYED_BATTLE_START · con retardo 30 s, LIVE no se adelanta al primer contenido retrasado (aviso antes)", async () => {
    const sim = new Sim(SEQ, D);
    const shown = await run(sim, 50);
    const live = firstTime(shown, (s) => s.kind === "live");
    // A empieza en real a los 10 s: su primer contenido retrasado llega a los 40 s.
    expect(live, "el directo empezó antes que el feed retrasado").toBe(10 + D);
    for (const t of grid(0, 10 + D)) {
      const s = at(shown, t);
      expect(s?.kind ?? "waiting", `t=${t}`).toBe("waiting");
      expect(directorStateOf(s)).toBe("WAITING_VALID");
    }
    // El aviso de retardo (secuencia aceptada WAITING → aviso → LIVE) en cuanto el feed lo anuncia.
    const notice = at(shown, 20);
    expect(notice).toMatchObject({ kind: "waiting", delayNoticeMs: D * 1000 });
    // La cabecera no rotula ninguna batalla antes del directo retrasado.
    expect(at(shown, 39.5)?.progress?.played ?? 0).toBe(0);
  });

  it("DELAYED_BATTLE_END · el fin real NO termina la batalla: el director sigue en ella hasta el final del feed retrasado", async () => {
    for (const replaysPublic of [true, false]) {
      const sim = new Sim(SEQ, D, { replaysPublic });
      const shown = await run(sim, 75);
      // 1-3: la batalla terminó en real a los 40 s; el feed sigue y el director sigue en A.
      for (const t of grid(40, 40 + D)) {
        expect(liveId(at(shown, t)), `replays=${replaysPublic} t=${t}: dejó A antes del final retrasado`).toBe("A");
      }
      // 4: el feed alcanza el final (70 s) ⇒ el director termina la batalla EN ESE instante.
      const left = shown.find((x) => x.t >= 40 && liveId(x.screen) !== "A");
      expect(left?.t, `replays=${replaysPublic}`).toBe(40 + D);
      expect(left?.screen.kind).toBe(replaysPublic ? "intermission" : "waiting");
    }
  });

  it("DELAYED_BATTLE_TRANSITION · A → B secuenciales: nunca B mientras el feed muestra A; B cuando llega SU contenido retrasado", async () => {
    const sim = new Sim(SEQ, D);
    const shown = await run(sim, 100);
    for (const x of shown) {
      if (liveId(x.screen) === "B") {
        expect(x.t, "B en antena mientras el feed de A seguía").toBeGreaterThanOrEqual(40 + D);
        expect(x.t, "B en antena antes de su contenido retrasado").toBeGreaterThanOrEqual(46 + D);
      }
    }
    // Mientras el feed de A sigue, el director sigue en A (B ya está en curso en real desde 46 s).
    for (const t of grid(46, 40 + D)) expect(liveId(at(shown, t)), `t=${t}`).toBe("A");
    // Fin retrasado de A (70 s) → intermedio con su marcador → B a los 76 s.
    expect(at(shown, 70)).toMatchObject({ kind: "intermission", lastBattle: { id: "A" } });
    expect(firstTime(shown, (s) => liveId(s) === "B")).toBe(46 + D);
    expect(shown.map((x) => `${x.screen.kind}:${liveId(x.screen) ?? ""}`)).toEqual([
      "waiting:",
      "waiting:", // + aviso de retardo
      "live:A",
      "intermission:",
      "live:B",
    ]);
    // Sólo se siguen la batalla en antena y la siguiente (la candidata se conecta sin pintarla).
    expect(sim.maxTrackedSeen).toBeLessThanOrEqual(2);
  });

  it("DELAYED_TOURNAMENT_END · el final público no aparece antes de que el contenido retrasado llegue a su final", async () => {
    const sim = new Sim(SEQ, D);
    const shown = await run(sim, 120);
    const fin = firstTime(shown, (s) => s.kind === "finished");
    // La última batalla termina en real a los 80 s; el torneo se cierra en real a los 80 s.
    expect(fin, "«Torneo terminado» antes del final retrasado").toBe(80 + D);
    for (const t of grid(80, 80 + D)) {
      const s = at(shown, t);
      expect(liveId(s), `t=${t}`).toBe("B");
      // Ni el total del torneo (sólo se rotula cerrado) ni el marcador se adelantan.
      expect(s?.progress?.total ?? null, `t=${t}: total del torneo antes de tiempo`).toBeNull();
    }
    expect(at(shown, 110)).toMatchObject({ kind: "finished", lastBattle: { id: "B" }, progress: { total: 2 } });
  });

  it("DELAYED_TOURNAMENT_END · última batalla CORTA: el torneo cerrado en real no se anuncia mientras su feed retrasado ni ha empezado", async () => {
    // B dura 5 s y termina (y cierra el torneo) en real antes del final retrasado de A.
    const sim = new Sim(
      [
        { id: "A", start: 10, end: 40 },
        { id: "B", start: 42, end: 47 },
      ],
      D,
    );
    const shown = await run(sim, 90);
    expect(firstTime(shown, (s) => s.kind === "finished")).toBe(47 + D);
    expect(at(shown, 70)).toMatchObject({ kind: "intermission", lastBattle: { id: "A" } });
    expect(firstTime(shown, (s) => liveId(s) === "B")).toBe(42 + D);
  });

  it("DIRECTOR_DOES_NOT_LEAK_REALTIME_STATE · en antena tras el fin real: sin resultado, sin outcome, sin marcador ni recuento", async () => {
    const sim = new Sim(SEQ, D);
    const shown = await run(sim, 120);
    for (const x of shown) {
      const s = x.screen;
      if (s.kind === "live") {
        expect(s.battle.result, `t=${x.t}: resultado real en el directo`).toBeUndefined();
        for (const p of s.battle.participants)
          expect(p.outcome, `t=${x.t}: ganador real en el directo`).toBeUndefined();
      }
      if (s.kind === "intermission" || s.kind === "finished") {
        const last = s.lastBattle!;
        const end = SEQ.find((b) => b.id === last.id)!.end;
        expect(x.t, `t=${x.t}: marcador de ${last.id} antes de su final retrasado`).toBeGreaterThanOrEqual(end + D);
      }
    }
    // El recuento de la cabecera sólo cuenta una batalla tras su final retrasado.
    expect(at(shown, 69.5)?.progress?.played).toBe(0);
    expect(at(shown, 70)?.progress?.played).toBe(1);
  });

  it("DELAYED_BATTLE_END · modo batalla suelta: «Batalla terminada» sólo al final retrasado", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D);
    const shown = await run(sim, 80, { target: "battle" });
    expect(firstTime(shown, (s) => s.kind === "live")).toBe(10 + D);
    expect(firstTime(shown, (s) => s.kind === "finished")).toBe(40 + D);
  });

  it("DELAYED_BATTLE_TRANSITION · batallas en PARALELO (como C2, replays apagados): cada cambio al final retrasado de la que está en antena", async () => {
    const sim = new Sim(
      [
        { id: "A", start: 10, end: 40 },
        { id: "B", start: 10, end: 60 },
        { id: "C", start: 10, end: 50 },
      ],
      D,
      { replaysPublic: false },
    );
    const shown = await run(sim, 120);
    expect(firstTime(shown, (s) => liveId(s) === "A")).toBe(40);
    expect(firstTime(shown, (s) => liveId(s) === "B")).toBe(70);
    for (const t of grid(40, 70)) expect(liveId(at(shown, t)), `t=${t}`).toBe("A");
    for (const t of grid(70, 90)) expect(liveId(at(shown, t)), `t=${t}`).toBe("B");
    expect(firstTime(shown, (s) => s.kind === "finished")).toBe(90);
    expect(sim.maxTrackedSeen).toBeLessThanOrEqual(2);
  });

  it("ZERO_DELAY_REGRESSION · con retardo 0 todo sigue siendo inmediato: misma secuencia y nunca más tarde que el director en tiempo real", async () => {
    const battles = [
      { id: "A", start: 10, end: 40 },
      { id: "B", start: 46, end: 80 },
    ];
    const pub = await run(new Sim(battles, 0), 100);
    const legacy = await run(new Sim(battles, 0), 100, { timeline: false });
    const seq = (xs: Shown[]) => xs.map((x) => `${x.screen.kind}:${liveId(x.screen) ?? ""}`);
    expect(seq(pub)).toEqual(seq(legacy));
    pub.forEach((x, i) => expect(x.t, `transición ${i} más tarde que en tiempo real`).toBeLessThanOrEqual(legacy[i].t));
    // Sin retardo no hay aviso de retardo.
    expect(pub.some((x) => x.screen.kind === "waiting" && x.screen.delayNoticeMs)).toBe(false);
    expect(firstTime(pub, (s) => s.kind === "finished")).toBeLessThanOrEqual(80 + POLL_S);
  });

  it("feed no disponible (sin canal público) de una batalla en curso ⇒ en antena como siempre; al terminar en real, fin", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, { unavailable: new Set(["A"]) });
    const shown = await run(sim, 60);
    expect(firstTime(shown, (s) => s.kind === "live")).toBe(12);
    expect(firstTime(shown, (s) => s.kind === "finished")).toBe(40);
  });
});

describe("FIX-DIRECTOR-DELAY · proyección pura", () => {
  const st = (phase: FeedPhase): FeedStatus => ({ phase, delayMs: 30_000, sinceMs: 0 });
  const b = (id: string, status: BattleSummary["status"]): BattleSummary => ({
    id,
    status,
    mode: "deathmatch",
    participants: [{ botId: "x", version: 1, team: "red", outcome: status === "finished" ? "win" : undefined }],
    result: status === "finished" ? { score: { red: 1 } } : undefined,
  });

  it("el feed manda sobre la fila real en cada fase", () => {
    expect(projectBattleStatus("finished", st("playing"), false, false)).toBe("running");
    expect(projectBattleStatus("gone", st("playing"), false, false)).toBe("running");
    expect(projectBattleStatus("running", st("pending"), false, false)).toBe("hidden");
    expect(projectBattleStatus("running", st("connecting"), false, false)).toBe("hidden");
    expect(projectBattleStatus("running", undefined, false, false)).toBe("hidden");
    expect(projectBattleStatus("finished", undefined, false, false)).toBe("hidden");
    expect(projectBattleStatus("finished", undefined, false, true)).toBe("finished");
    expect(projectBattleStatus("running", st("ended"), false, false)).toBe("finished");
    expect(projectBattleStatus("running", undefined, true, false)).toBe("finished");
    expect(projectBattleStatus("running", st("unavailable"), false, false)).toBe("running");
    expect(projectBattleStatus("finished", st("unavailable"), false, false)).toBe("finished");
  });

  it("torneo cerrado en real con un feed aún emitiendo ⇒ abierto en la proyección; la batalla en curso va sin resultado", () => {
    const p = projectDelayedTimeline({
      battles: [{ battle: b("A", "finished"), real: "finished" }],
      state: "finished",
      feed: () => st("playing"),
      ended: new Set(),
      resolvedAtStart: new Set(),
    });
    expect(p.state).toBe("running");
    expect(p.unresolved).toEqual(["A"]);
    expect(p.battles[0].status).toBe("running");
    expect(p.battles[0].result).toBeUndefined();
    expect(p.battles[0].participants[0].outcome).toBeUndefined();
  });
});
