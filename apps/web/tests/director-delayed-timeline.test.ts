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
 * Las filas de la API llevan `startedAt`/`finishedAt` (como `battleToJson`) con el reloj `Date`
 * sincronizado con el virtual: un director que los leyera (en vez del feed) se pone en rojo.
 *
 * Ronda 2 · caminos de FALLBACK (feed no disponible, carrera 4404, feed caído): ninguno puede
 * revelar una transición antes que la línea temporal retrasada.
 *
 * Mutantes: scripts/director-delay-mutants.py.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BroadcastDirector,
  MAX_SPECTATOR_DELAY_MS,
  directorStateOf,
  projectBattleStatus,
  projectDelayedTimeline,
  type BattleSummary,
  type BroadcastScreen,
} from "../src/broadcast/director.js";
import {
  SpectatorTimeline,
  type FeedPhase,
  type FeedStatus,
  type PublicTimeline,
  type TimelineClient,
} from "../src/broadcast/delayed-timeline.js";
import { SpectatorClient } from "../src/viewer/spectator-client.js";
import { RULES_LIMITS } from "../../../packages/game-rules/battle-rules.js";

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
/** Hora de pared del instante virtual 0 (las marcas `startedAt`/`finishedAt` de la API). */
const WALL0 = Date.UTC(2026, 10, 16, 1, 0, 0);
const iso = (s: number) => new Date(WALL0 + s * 1000).toISOString();

interface SimOpts {
  replaysPublic?: boolean;
  /** Feed no disponible siempre (sin canal público). */
  unavailable?: Set<string>;
  /** Fase forzada (`entering`: al conectar). `unavailable` es terminal por conexión, como en SpectatorTimeline. */
  override?: (id: string, t: number, entering: boolean) => FeedPhase | undefined;
  /** Desde t el canal CAE (gateway caído): la fase se congela y `lost` = true. */
  lostFrom?: Map<string, number>;
  /** Desde t el feed se ATASCA sin señal (latidos sin contenido ni result): fase congelada, `lost` = false. */
  stallFrom?: Map<string, number>;
  /** Desde t la API deja de listar la batalla (fallida/retirada). */
  goneAt?: Map<string, number>;
}

/** Competición real + API anónima + línea temporal con la semántica del gateway. */
class Sim implements PublicTimeline {
  t = 0;
  readonly trackLog: { t: number; id: string }[] = [];
  maxTrackedSeen = 0;
  /** `announced`: el feed ya mandó un init (sólo entonces se conoce su retardo, como en SpectatorTimeline). */
  private readonly entries = new Map<
    string,
    { phase: FeedPhase; sinceMs: number; lost: boolean; announced: boolean }
  >();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly battles: SimBattle[],
    readonly delayS: number,
    readonly opts: SimOpts = {},
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
      // Como battleToJson: marcas de tiempo REALES (no las debe usar el director).
      startedAt: st === "scheduled" ? null : iso(b.start),
      finishedAt: st === "finished" ? iso(b.end) : null,
      id: b.id,
      tournamentId: "t1",
      status: st,
      mode: "deathmatch",
      participants: [
        { botId: `${b.id}-red`, version: 1, team: "red", outcome: st === "finished" ? "win" : undefined },
        { botId: `${b.id}-blue`, version: 1, team: "blue", outcome: st === "finished" ? "loss" : undefined },
      ],
      result: st === "finished" ? { score: { red: 3, blue: 1 }, ticks: 999 } : undefined,
    } as BattleSummary;
  }
  /** API anónima: running siempre; finished sólo con replays públicos; scheduled nunca. */
  fetchJson = async (path: string): Promise<unknown> => {
    if (path === "/tournaments/t1") return { id: "t1", state: this.t >= this.realEnd() ? "finished" : "running" };
    if (path === "/tournaments/t1/battles") {
      const items = this.battles
        .filter((b) => !(this.opts.goneAt?.has(b.id) && this.t >= this.opts.goneAt.get(b.id)!))
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
  private phaseOf(id: string, entering = false): FeedPhase {
    if (this.opts.unavailable?.has(id)) return "unavailable";
    const o = this.opts.override?.(id, this.t, entering);
    if (o) return o;
    const b = this.battles.find((x) => x.id === id)!;
    const d = this.t - this.delayS; // el feed retrasado enseña el estado de `t − retardo`
    return d >= b.end ? "ended" : d >= b.start ? "playing" : "pending";
  }
  track(id: string): void {
    if (this.entries.has(id)) return;
    // Conexión «instantánea»: el init llega en el mismo instante.
    const phase = this.phaseOf(id, true);
    this.entries.set(id, { phase, sinceMs: this.t * 1000, lost: false, announced: phase !== "unavailable" });
    this.trackLog.push({ t: this.t, id });
    this.maxTrackedSeen = Math.max(this.maxTrackedSeen, this.entries.size);
  }
  release(id: string): void {
    this.entries.delete(id);
  }
  status(id: string): FeedStatus | undefined {
    const e = this.entries.get(id);
    return e
      ? { phase: e.phase, delayMs: e.announced ? this.delayS * 1000 : null, sinceMs: e.sinceMs, lost: e.lost }
      : undefined;
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
      if (e.phase === "ended" || e.phase === "unavailable") continue; // terminales por conexión
      const stallAt = this.opts.stallFrom?.get(id);
      if (stallAt !== undefined && this.t >= stallAt) continue;
      const lostAt = this.opts.lostFrom?.get(id);
      if (lostAt !== undefined && this.t >= lostAt) {
        if (!e.lost) {
          e.lost = true; // canal caído: la fase se congela en la última vista
          changed = true;
        }
        continue;
      }
      const p = this.phaseOf(id);
      if (p !== e.phase) {
        if (p !== "unavailable") e.announced = true;
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
  // `Date` sigue al reloj virtual: las marcas de la API son coherentes con «ahora».
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (let i = 0; i * STEP_S <= untilS; i++) {
      sim.t = i * STEP_S;
      vi.setSystemTime(WALL0 + sim.t * 1000);
      if (opts.timeline !== false) {
        sim.advance(); // un cambio de fase dispara un ciclo del director (lectura fresca de la API)
        await new Promise((r) => setImmediate(r));
      }
      if (Math.abs(sim.t / POLL_S - Math.round(sim.t / POLL_S)) < 1e-9) await director.tick();
    }
  } finally {
    vi.useRealTimers();
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

  it("FALLBACK · sin canal público (feed nunca disponible): nunca en antena con la fila real; el final no antes de fin real + retardo máximo", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, { unavailable: new Set(["A"]) });
    const shown = await run(sim, 100);
    // Sin línea temporal retrasada no hay nada que poner en antena: ni LIVE en el inicio real…
    expect(
      shown.some((x) => x.screen.kind === "live"),
      "LIVE decidido con la fila real",
    ).toBe(false);
    // …ni fin en el fin real: el feed nunca anunció su retardo ⇒ se supone el máximo del servidor.
    const fin = firstTime(shown, (s) => s.kind === "finished")!;
    expect(fin, "final con el estado real inmediato").toBeGreaterThanOrEqual(40 + MAX_SPECTATOR_DELAY_MS / 1000);
    expect(fin).toBeLessThanOrEqual(40 + MAX_SPECTATOR_DELAY_MS / 1000 + POLL_S);
  });
});

describe("FIX-DIRECTOR-DELAY · proyección pura", () => {
  const st = (phase: FeedPhase): FeedStatus => ({ phase, delayMs: 30_000, sinceMs: 0, lost: false });
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
    // Ronda 2 · un feed no disponible nunca pone en antena ni termina con la fila real…
    expect(projectBattleStatus("running", st("unavailable"), false, false)).toBe("hidden");
    expect(projectBattleStatus("finished", st("unavailable"), false, false)).toBe("hidden");
    expect(projectBattleStatus("gone", st("unavailable"), false, false)).toBe("hidden");
    // …y una batalla que ya salió en antena sigue en antena mientras su feed no está sano.
    for (const ph of ["unavailable", "connecting", "pending"] as const) {
      expect(projectBattleStatus("finished", st(ph), false, false, true)).toBe("running");
      expect(projectBattleStatus("running", st(ph), false, false, true)).toBe("running");
    }
  });

  it("un feed no disponible no resuelve la batalla: el torneo cerrado en real sigue abierto en la proyección", () => {
    const p = projectDelayedTimeline({
      battles: [{ battle: b("A", "finished"), real: "gone" }],
      state: "finished",
      feed: () => st("unavailable"),
      ended: new Set(),
      resolvedAtStart: new Set(),
    });
    expect(p.unresolved).toEqual(["A"]);
    expect(p.state).toBe("running");
    expect(p.battles).toEqual([]);
  });

  it("MAX_SPECTATOR_DELAY_MS es el máximo `spectator.delaySeconds` que admite el servidor", () => {
    expect(MAX_SPECTATOR_DELAY_MS).toBe(RULES_LIMITS.delaySeconds.max * 1000);
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

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Ronda 2 · REGLA: ningún camino de fallback revela una transición (inicio, fin, cambio de batalla,
 * fin del torneo) antes de que la línea temporal retrasada la autorice. R1/R2/R5 son los
 * reproductores de la revisión funcional (zz-review-a284), L1 el de la de seguridad.
 */
describe("FIX-DIRECTOR-DELAY · Ronda 2 · caminos de fallback", () => {
  /** El feed da 4404 al conectar antes de `until` (carrera ticket→attach: `running` antes del attach). */
  const raceUntil = (m: Record<string, number>) => (id: string, t: number, entering: boolean) =>
    entering && m[id] !== undefined && t < m[id] ? ("unavailable" as const) : undefined;

  it("FALLBACK_4404_START (R1) · carrera 4404 en la PRIMERA batalla: LIVE no antes del contenido retrasado, sin parpadeo", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, { override: raceUntil({ A: 13 }) });
    const shown = await run(sim, 90);
    expect(
      firstTime(shown, (s) => s.kind === "live"),
      "LIVE en el inicio REAL",
    ).toBe(10 + D);
    expect(shown.map((x) => x.screen.kind)).toEqual(["waiting", "waiting", "live", "finished"]);
    expect(at(shown, 39.5)?.progress?.played ?? 0).toBe(0);
  });

  it("FALLBACK_4404_TRANSITION (R2) · carrera 4404 en la candidata B: nunca B antes de SU contenido retrasado", async () => {
    const sim = new Sim(
      [
        { id: "A", start: 10, end: 40 },
        { id: "B", start: 66, end: 100 },
      ],
      D,
      { override: raceUntil({ B: 69 }) },
    );
    const shown = await run(sim, 150);
    for (const x of shown)
      if (liveId(x.screen) === "B") expect(x.t, "B antes de su retardo").toBeGreaterThanOrEqual(66 + D);
    expect(firstTime(shown, (s) => liveId(s) === "B")).toBe(66 + D);
    expect(shown.map((x) => `${x.screen.kind}:${liveId(x.screen) ?? ""}`)).toEqual([
      "waiting:",
      "waiting:",
      "live:A",
      "intermission:",
      "live:B",
      "finished:",
    ]);
  });

  it("FALLBACK_4404_TOURNAMENT_END (R5) · carrera 4404 en la ÚLTIMA batalla corta: «Torneo terminado» no antes de su final retrasado y B se emite", async () => {
    const sim = new Sim(
      [
        { id: "A", start: 10, end: 40 },
        { id: "B", start: 42, end: 52 },
      ],
      D,
      { override: raceUntil({ B: 45 }) },
    );
    const shown = await run(sim, 120);
    expect(
      firstTime(shown, (s) => s.kind === "finished"),
      "final antes del final retrasado de B",
    ).toBeGreaterThanOrEqual(52 + D);
    expect(
      shown.some((x) => liveId(x.screen) === "B"),
      "B nunca se emitió",
    ).toBe(true);
    for (const x of shown) if (liveId(x.screen) === "B") expect(x.t).toBeGreaterThanOrEqual(42 + D);
  });

  it("FALLBACK_FEED_LOST_AFTER_END (L1) · replays apagados, el WS cae tras el fin REAL y el re-ticket da 404: ni fin ni torneo terminado antes de fin real + retardo", async () => {
    // Fin real 40 s, fin retrasado 70 s; a los 50 s el socket cae y cada reintento da 404.
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, {
      replaysPublic: false,
      override: (id, t) => (id === "A" && t >= 50 ? "unavailable" : undefined),
    });
    const shown = await run(sim, 110);
    // Sigue en antena (imagen congelada): ni «espera» ni final mientras dura su cola retrasada.
    for (const t of grid(40, 40 + D))
      expect(liveId(at(shown, t)), `t=${t}: dejó A antes del final retrasado`).toBe("A");
    const fin = firstTime(shown, (s) => s.kind !== "live" && s.kind !== "waiting")!;
    expect(fin, "final revelado antes del final retrasado").toBeGreaterThanOrEqual(40 + D);
    // Acotado: como mucho un sondeo después de la cota (fin real observado + retardo anunciado).
    expect(fin).toBeLessThanOrEqual(40 + D + POLL_S);
    expect(at(shown, fin)?.kind).toBe("finished");
  });

  it("FALLBACK_GATEWAY_DOWN (P2-1) · gateway caído a mitad de la cola y batalla retirada: sale en tiempo acotado y nunca antes del fin retrasado", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, {
      lostFrom: new Map([["A", 50]]),
      goneAt: new Map([["A", 41]]),
    });
    const shown = await run(sim, 400);
    const left = shown.find((x) => x.t >= 40 && liveId(x.screen) !== "A")!;
    expect(left, "el director se quedó en A (fase congelada)").toBeDefined();
    expect(left.t, "dejó A antes del fin retrasado").toBeGreaterThanOrEqual(40 + D);
    expect(left.t, "congelado más de un sondeo tras la cota").toBeLessThanOrEqual(40 + D + POLL_S);
    expect(liveId(shown[shown.length - 1].screen)).toBeNull();
  });

  it("FALLBACK_GATEWAY_DOWN (P2-1) · gateway caído con la batalla AÚN en curso en real: sigue en antena; acaba fin real + retardo", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 100 }], D, { lostFrom: new Map([["A", 50]]) });
    const shown = await run(sim, 200);
    for (const t of grid(50, 100 + D)) expect(liveId(at(shown, t)), `t=${t}`).toBe("A");
    const fin = firstTime(shown, (s) => s.kind === "finished")!;
    expect(fin).toBeGreaterThanOrEqual(100 + D);
    expect(fin).toBeLessThanOrEqual(100 + D + POLL_S);
  });

  it("FALLBACK_FEED_STALLED (P2-1, R3 de la revisión) · feed atascado SIN señal de corte y batalla retirada: techo acotado, nunca antes del fin retrasado", async () => {
    const sim = new Sim([{ id: "A", start: 10, end: 40 }], D, {
      stallFrom: new Map([["A", 50]]),
      goneAt: new Map([["A", 41]]),
    });
    const shown = await run(sim, 400);
    const left = shown.find((x) => x.t >= 40 && liveId(x.screen) !== "A")!;
    expect(left, "el director sigue en A 360 s después del fin real").toBeDefined();
    expect(left.t, "dejó A antes del fin retrasado").toBeGreaterThanOrEqual(40 + D);
    // Techo: fin real observado + retardo + margen de atasco (15 s) + un sondeo.
    expect(left.t).toBeLessThanOrEqual(40 + D + 15 + POLL_S);
    expect(liveId(shown[shown.length - 1].screen)).toBeNull();
  });

  it("DELAY_NOTICE_ONLY_INITIAL (S4) · replays apagados: el aviso de retardo nunca sale tras el primer LIVE (delataría el inicio real de la siguiente)", async () => {
    const sim = new Sim(SEQ, D, { replaysPublic: false });
    const shown = await run(sim, 120);
    const firstLive = firstTime(shown, (s) => s.kind === "live")!;
    expect(firstLive).toBe(10 + D);
    // Entre A (fin retrasado 70 s) y B (contenido retrasado 76 s) hay una espera con B ya seguida.
    expect(at(shown, 72)).toMatchObject({ kind: "waiting" });
    for (const x of shown)
      if (x.t >= firstLive && x.screen.kind === "waiting")
        expect(x.screen.delayNoticeMs, `t=${x.t}: aviso de retardo entre batallas`).toBeUndefined();
  });
});

/** Cliente de espectador falso con guion por intento (la línea temporal de verdad encima). */
class FakeClient implements TimelineClient {
  state = { snapshot: null as any, result: null as any, serverTimeMs: null, connected: false };
  stopped = false;
  private readonly h = new Map<string, Set<(m: any) => void>>();
  constructor(private readonly script: (c: FakeClient) => void) {}
  on(type: string, fn: (m: any) => void) {
    if (!this.h.has(type)) this.h.set(type, new Set());
    this.h.get(type)!.add(fn);
    return () => this.h.get(type)?.delete(fn);
  }
  emit(type: string, m: any) {
    for (const fn of [...(this.h.get(type) ?? [])]) fn(m);
  }
  async connect() {
    this.script(this);
  }
  stop() {
    this.stopped = true;
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const INIT = { spectator: { delaySeconds: 30, delayMs: 30_000 }, snapshot: null, finished: false, meta: {} };

describe("FIX-DIRECTOR-DELAY · Ronda 2 · SpectatorTimeline en los fallos del canal", () => {
  function timeline(scripts: ((c: FakeClient) => void)[], retries = 5) {
    const made: FakeClient[] = [];
    const tl = new SpectatorTimeline({
      createClient: () => {
        const c = new FakeClient(scripts[Math.min(made.length, scripts.length - 1)]);
        made.push(c);
        return c;
      },
      notLiveRetries: retries,
      setTimeoutImpl: (fn) => setTimeout(fn, 0),
    });
    const phases: FeedPhase[] = [];
    tl.onChange(() => phases.push(tl.status("A")!.phase));
    return { tl, made, phases };
  }
  const notLive = (c: FakeClient) => c.emit("rejected", { kind: "socket", code: 4404 });

  it("TIMELINE_4404_RETRY · 4404 antes del primer init (carrera ticket→attach): reintento, sigue `connecting`, nunca `unavailable`", async () => {
    const { tl, made, phases } = timeline([
      notLive,
      notLive,
      (c) => c.emit("init", { ...INIT, snapshot: { tick: 1 } }),
    ]);
    tl.track("A");
    await flush();
    expect(made.length).toBe(3);
    expect(made[0].stopped && made[1].stopped).toBe(true);
    expect(phases).not.toContain("unavailable");
    expect(tl.status("A")?.phase).toBe("playing");
    // La pantalla pinta el cliente VIGENTE.
    expect(tl.feed("A")?.client).toBe(made[2]);
  });

  it("TIMELINE_4404_RETRY · con un límite: agotado, `unavailable`", async () => {
    const { tl, made } = timeline([notLive], 3);
    tl.track("A");
    await flush();
    expect(made.length).toBe(4);
    expect(tl.status("A")?.phase).toBe("unavailable");
    expect(tl.status("A")?.lost).toBe(false);
  });

  it("TIMELINE_4404_RETRY · un 4404 con el init ya recibido es terminal y marca el canal caído", async () => {
    const { tl, made } = timeline([
      (c) => {
        c.emit("init", { ...INIT, snapshot: { tick: 1 } });
        notLive(c);
      },
    ]);
    tl.track("A");
    await flush();
    expect(made.length).toBe(1);
    expect(tl.status("A")).toMatchObject({ phase: "unavailable", lost: true });
  });

  it("TIMELINE_INIT_FINISHED_ONLY (X3c) · sólo `init.finished` cierra la batalla (un `result` suelto en el init no)", async () => {
    const { tl } = timeline([(c) => c.emit("init", { ...INIT, snapshot: { tick: 5 }, result: { winner: "red" } })]);
    tl.track("A");
    await flush();
    expect(tl.status("A")?.phase).toBe("playing");
  });

  it("TIMELINE_LOST · un corte tras el init marca `lost` (fase congelada); el init de la reconexión lo limpia", async () => {
    let client!: FakeClient;
    const { tl } = timeline([(c) => ((client = c), c.emit("init", { ...INIT, snapshot: { tick: 1 } }))]);
    tl.track("A");
    await flush();
    client.emit("disconnect", { wasConnected: true });
    await flush();
    expect(tl.status("A")).toMatchObject({ phase: "playing", lost: true });
    client.emit("init", { ...INIT, snapshot: { tick: 9 } });
    await flush();
    expect(tl.status("A")).toMatchObject({ phase: "playing", lost: false });
  });

  it("SPECTATOR_CLIENT_STOP_DURING_TICKET (P3) · stop() con el ticket en vuelo no abre un socket huérfano", async () => {
    let give!: (t: { ticket: string; wsUrl: string }) => void;
    const opened: string[] = [];
    class WS {
      constructor(url: string) {
        opened.push(url);
      }
      close() {}
    }
    const c = new SpectatorClient({
      getTicket: () => new Promise((r) => (give = r)),
      WebSocketImpl: WS as unknown as typeof WebSocket,
    });
    const p = c.connect();
    c.stop();
    give({ ticket: "t", wsUrl: "ws://127.0.0.1:1/spectate/A" });
    void p; // sin el arreglo, el socket se abre y connect() espera un open que nunca llega
    await flush();
    expect(opened, "socket abierto tras liberar el feed").toEqual([]);
  });
});
