/**
 * FIX-DIRECTOR-DELAY · El director con el TRANSPORTE REAL: SpectateGateway real (puerto
 * efímero, retardo y latidos de #282) → `ws` → SpectatorClient → SpectatorTimeline →
 * BroadcastDirector. Sólo la API pública se sustituye por una función que refleja el estado
 * REAL de la competición (que es justo lo que no debe decidir las transiciones).
 *
 * Escala comprimida: retardo de 1,2 s, watchdog de 400 ms (< retardo, como 10 s < 30 s en
 * producción), latido de 100 ms. Las cotas INFERIORES son las importantes (nunca antes que el
 * feed retrasado); las superiores sólo evitan que «muy tarde» pase por bueno.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket as WsWebSocket } from "ws";
import { SpectateGateway, type SpectatableBattle } from "../../api/src/spectate/gateway.js";
import { signSpectateTicket } from "../../api/src/auth/tokens.js";
import { SpectatorClient } from "../src/viewer/spectator-client.js";
import { SpectatorTimeline } from "../src/broadcast/delayed-timeline.js";
import { BroadcastDirector, type BattleSummary, type BroadcastScreen } from "../src/broadcast/director.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Tolerancia de los temporizadores de Node (pueden disparar ~1 ms antes). */
const EARLY_MS = 5;
/** Margen para «no demasiado tarde» (sondeo de 200 ms + carga del laboratorio). */
const LATE_MS = 1500;

class LiveBattle implements SpectatableBattle {
  snapshots: any[] = [];
  publicEvents: any[] = [];
  private finished = false;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  startedAt = 0;
  endedAt = 0;
  lastTick = -1;
  constructor(readonly id: string) {}
  start(): void {
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      this.snapshots.push({ tick: ++this.tick, vehicles: [] });
      this.lastTick = this.tick;
    }, 50);
  }
  finish(): void {
    if (this.timer) clearInterval(this.timer);
    this.finished = true;
    this.endedAt = Date.now();
  }
  isFinished(): boolean {
    return this.finished;
  }
  getResult(): unknown {
    return this.finished ? { winner: "red", score: { red: 2, blue: 1 }, ticks: this.tick } : null;
  }
  realStatus(): BattleSummary["status"] {
    return this.startedAt === 0 ? "scheduled" : this.finished ? "finished" : "running";
  }
}

interface Recorded {
  t0: number;
  screens: { at: number; screen: BroadcastScreen }[];
  /** Por batalla: ticks retrasados recibidos, hora del result, latidos, cortes. */
  feeds: Map<string, { ticks: number[]; resultAt: number; heartbeats: number; disconnects: number; reconnects: number }>;
  battles: Map<string, LiveBattle>;
  maxTracked: number;
}

/**
 * Torneo de dos batallas SECUENCIALES (A termina antes de que empiece B) con el gateway real.
 * B empieza en real ANTES del final retrasado de A: es el caso en que el director antiguo
 * cortaba la cola de A para saltar a B.
 */
async function runTournament(delayMs: number, plan: { aEnd: number; bStart: number; bEnd: number }): Promise<Recorded> {
  const gw = new SpectateGateway({ heartbeatIntervalMs: 100, publicSpectateEnabled: true });
  const A = new LiveBattle(`a-${randomUUID()}`);
  const B = new LiveBattle(`b-${randomUUID()}`);
  const rec: Recorded = { t0: Date.now(), screens: [], feeds: new Map(), battles: new Map([[A.id, A], [B.id, B]]), maxTracked: 0 };
  const order = [A, B];
  const summary = (b: LiveBattle): BattleSummary => {
    const status = b.realStatus();
    return {
      id: b.id,
      tournamentId: "t1",
      status,
      mode: "deathmatch",
      participants: [
        { botId: "red", version: 1, team: "red", outcome: status === "finished" ? "win" : undefined },
        { botId: "blue", version: 1, team: "blue", outcome: status === "finished" ? "loss" : undefined },
      ],
      result: status === "finished" ? { score: { red: 2, blue: 1 } } : undefined,
    };
  };
  // API pública anónima que refleja el estado REAL (replays públicos encendidos).
  const fetchJson = async (path: string) => {
    if (path === "/tournaments/t1") return { id: "t1", state: B.isFinished() ? "finished" : "running" };
    if (path === "/tournaments/t1/battles")
      return { items: order.map(summary).filter((s) => s.status !== "scheduled") };
    throw new Error(`ruta inesperada ${path}`);
  };
  const timeline = new SpectatorTimeline({
    createClient: (battleId) => {
      const c = new SpectatorClient({
        getTicket: async () => ({
          ticket: signSpectateTicket({ battleId, jti: randomUUID(), anon: true } as any, 60),
          wsUrl: `ws://127.0.0.1:${gw.port}/spectate/${battleId}`,
        }),
        WebSocketImpl: WsWebSocket as unknown as typeof WebSocket,
        watchdogTimeoutMs: 400,
        reconnectDelayMs: 50,
        maxReconnectAttempts: 5,
      });
      const f = { ticks: [] as number[], resultAt: 0, heartbeats: 0, disconnects: 0, reconnects: 0 };
      rec.feeds.set(battleId, f);
      c.on("snapshot", (s) => f.ticks.push(s.tick));
      c.on("init", (m) => m.snapshot && f.ticks.push(m.snapshot.tick));
      c.on("result", () => (f.resultAt = Date.now()));
      c.on("heartbeat", () => f.heartbeats++);
      c.on("disconnect", () => f.disconnects++);
      c.on("reconnected", () => f.reconnects++);
      return c;
    },
  });
  const director = new BroadcastDirector({
    target: { kind: "tournament", tournamentId: "t1" },
    fetchJson,
    onScreen: (screen) => rec.screens.push({ at: Date.now(), screen }),
    onSourceError: () => undefined,
    pollIntervalMs: 200,
    timeline,
  });
  const probe = setInterval(() => (rec.maxTracked = Math.max(rec.maxTracked, timeline.tracked().length)), 20);
  const attach = (b: LiveBattle) => {
    gw.attachBattle(b.id, b, { spectator: { delaySeconds: delayMs / 1000 }, pollIntervalMs: 20 });
    b.start();
  };
  const finish = (b: LiveBattle) => {
    b.finish();
    // Como el worker: retira la batalla del gateway tras el retardo + margen.
    setTimeout(() => gw.detachBattle(b.id), delayMs + 300);
  };
  try {
    rec.t0 = Date.now();
    attach(A);
    director.start();
    await sleep(plan.aEnd);
    finish(A);
    await sleep(plan.bStart - plan.aEnd);
    attach(B);
    await sleep(plan.bEnd - plan.bStart);
    finish(B);
    await sleep(delayMs + 1200);
  } finally {
    clearInterval(probe);
    director.stop();
    timeline.stopAll();
    gw.close();
  }
  return rec;
}

const liveId = (s: BroadcastScreen) => (s.kind === "live" ? s.battle.id : null);

describe("FIX-DIRECTOR-DELAY · director + gateway real con retardo", () => {
  const DELAY = 1200;
  const PLAN = { aEnd: 1000, bStart: 1300, bEnd: 2300 };
  let r: Recorded;
  let A: LiveBattle;
  let B: LiveBattle;

  beforeAll(async () => {
    process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
    r = await runTournament(DELAY, PLAN);
    [A, B] = [...r.battles.values()];
  }, 30_000);

  const firstAt = (pred: (s: BroadcastScreen) => boolean) => r.screens.find((x) => pred(x.screen))?.at;

  it("DELAYED_BATTLE_START · gateway real: LIVE de A no antes de su primer snapshot retrasado", () => {
    const live = firstAt((s) => liveId(s) === A.id)!;
    expect(live, "nunca salió en directo").toBeDefined();
    expect(live - A.startedAt).toBeGreaterThanOrEqual(DELAY - EARLY_MS);
    expect(live - A.startedAt).toBeLessThan(DELAY + LATE_MS);
  });

  it("DELAYED_BATTLE_END · gateway real: tras el fin real el feed sigue, llegan los ÚLTIMOS ticks y sólo entonces termina A", () => {
    const left = r.screens.find((x) => x.at > A.endedAt && liveId(x.screen) !== A.id)!;
    expect(left, "el director nunca dejó A").toBeDefined();
    // 1 · fin real → el director sigue en A al menos el retardo.
    expect(left.at - A.endedAt, "dejó A antes del final retrasado").toBeGreaterThanOrEqual(DELAY - EARLY_MS);
    expect(left.at - A.endedAt).toBeLessThan(DELAY + LATE_MS);
    // 2-3 · llegaron TODOS los ticks retrasados de A, hasta el último producido, y su result.
    const f = r.feeds.get(A.id)!;
    expect(Math.max(...f.ticks), "faltan los últimos ticks retrasados").toBe(A.lastTick);
    expect(f.resultAt, "no llegó el result retrasado").toBeGreaterThan(0);
    // 4 · el director termina la batalla DESPUÉS de que el feed alcance el final.
    expect(left.at).toBeGreaterThanOrEqual(f.resultAt);
  });

  it("DELAYED_BATTLE_TRANSITION · gateway real: nunca B mientras el feed muestra A; B al llegar SU contenido retrasado", () => {
    const fA = r.feeds.get(A.id)!;
    const bLive = firstAt((s) => liveId(s) === B.id)!;
    expect(bLive, "B nunca salió en directo").toBeDefined();
    expect(bLive, "B en antena con el feed de A aún activo").toBeGreaterThanOrEqual(fA.resultAt);
    expect(bLive - B.startedAt, "B antes de su contenido retrasado").toBeGreaterThanOrEqual(DELAY - EARLY_MS);
    // B empezó en real ANTES del final retrasado de A: el director antiguo saltaba a B ahí.
    expect(B.startedAt).toBeLessThan(A.endedAt + DELAY);
    for (const x of r.screens) if (liveId(x.screen) === B.id) expect(x.at).toBeGreaterThanOrEqual(fA.resultAt);
    expect(r.maxTracked).toBeLessThanOrEqual(2);
  });

  it("DELAYED_TOURNAMENT_END · gateway real: «Torneo terminado» no antes de que el feed retrasado de la última llegue a su final", () => {
    const fin = firstAt((s) => s.kind === "finished")!;
    expect(fin, "nunca terminó").toBeDefined();
    const fB = r.feeds.get(B.id)!;
    expect(fin - B.endedAt, "final público antes del final retrasado").toBeGreaterThanOrEqual(DELAY - EARLY_MS);
    expect(fin).toBeGreaterThanOrEqual(fB.resultAt);
    expect(Math.max(...fB.ticks)).toBe(B.lastTick);
    // Mientras B estaba en antena tras su fin real: ni total ni resultado real.
    for (const x of r.screens)
      if (x.at < fin && x.at >= B.endedAt) {
        expect(x.screen.progress?.total ?? null).toBeNull();
        if (x.screen.kind === "live") expect(x.screen.battle.result).toBeUndefined();
      }
  });

  it("WATCHDOG_REGRESSION · #282 sigue: latidos durante la espera, sin bucle de reconexión y llegan los snapshots retrasados", () => {
    for (const [id, f] of r.feeds) {
      expect(f.heartbeats, `${id}: sin latidos`).toBeGreaterThan(5);
      expect(f.reconnects, `${id}: reconectó (watchdog 400 ms < retardo 1,2 s)`).toBe(0);
      expect(f.disconnects, `${id}: cortes del canal`).toBe(0);
      expect(f.ticks.length, `${id}: no llegaron snapshots retrasados`).toBeGreaterThan(5);
    }
  });
});

describe("FIX-DIRECTOR-DELAY · retardo 0 con el gateway real", () => {
  it("ZERO_DELAY_REGRESSION · gateway real sin retardo: directo, cambio y final inmediatos (≤ un sondeo + margen)", async () => {
    process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
    const r = await runTournament(0, { aEnd: 700, bStart: 900, bEnd: 1500 });
    const [A, B] = [...r.battles.values()];
    const at = (pred: (s: BroadcastScreen) => boolean) => r.screens.find((x) => pred(x.screen))?.at ?? Infinity;
    expect(at((s) => liveId(s) === A.id) - A.startedAt).toBeLessThan(LATE_MS);
    expect(r.screens.find((x) => x.at > A.endedAt && liveId(x.screen) !== A.id)!.at - A.endedAt).toBeLessThan(LATE_MS);
    expect(at((s) => liveId(s) === B.id) - B.startedAt).toBeLessThan(LATE_MS);
    expect(at((s) => s.kind === "finished") - B.endedAt).toBeLessThan(LATE_MS);
    // Sin retardo, ni latidos ni aviso de retardo.
    for (const f of r.feeds.values()) expect(f.heartbeats).toBe(0);
    expect(r.screens.some((x) => x.screen.kind === "waiting" && x.screen.delayNoticeMs)).toBe(false);
  }, 30_000);
});

afterAll(() => undefined);
