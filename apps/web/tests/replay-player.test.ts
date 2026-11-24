/**
 * T8.3 · Reproductor de replays contra replays REALES en S9R/1 servidos con los lectores
 * incrementales de la API (tests/s9r-replay-source.ts; V1 REPLAYS PR-4b sustituye al
 * replay-service HTTP retirado): reproducción completa con marcador oficial, salto temporal por
 * keyframes (±1 tick y < 1 s sobre un replay de 5 minutos), velocidades 0,5×–8× con coherencia
 * de eventos, enlaces compartibles y AUSENCIA de la capa de depuración (retirada).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { hostS9rReplays, type S9rReplayHost } from "./s9r-replay-source.js";
import { OverlayState } from "../src/viewer/overlay.js";
import {
  MAX_SPEED,
  MIN_SPEED,
  ReplayPlayer,
  buildShareLink,
  httpReplaySource,
  parseShareLink,
  type ReplaySource,
} from "../src/viewer/replay-player.js";

let host: S9rReplayHost;
let combat: Replay; // batalla con eventos (cazadores)
let fiveMin: Replay; // 5 minutos de juego (9000 ticks) para el DoD de salto temporal
let debugCandidate: Replay; // batalla con comandos: la capa de depuración retirada no los expone
/** Fuente HTTP (httpReplaySource) sobre el anfitrión S9R en memoria. */
function sourceFor(battleId: string): ReplaySource {
  return host.sourceFor(battleId);
}

async function recordBattle(seed: string, opts: { hunters?: boolean; ticks: number }): Promise<Replay> {
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: opts.ticks }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", opts.hunters ? new HunterBot("bot_red") : new IdleBot("bot_red"));
      b.attachBot("v_blue", opts.hunters ? new HunterBot("bot_blue") : new IdleBot("bot_blue"));
    },
  );
}

beforeAll(async () => {
  await initPhysics();
  combat = await recordBattle("player_combat", { hunters: true, ticks: 1500 });
  fiveMin = await recordBattle("player_5min", { hunters: false, ticks: 9000 });
  debugCandidate = await recordBattle("player_debug_retired", { hunters: true, ticks: 300 });
  host = await hostS9rReplays([combat, fiveMin, debugCandidate]);
}, 300000);

afterAll(async () => {
  await host?.close();
});

describe("T8.3 reproducción completa (E2E a nivel HTTP)", () => {
  it("un replay oficial se reproduce y su marcador final coincide con el BattleResult almacenado", async () => {
    const player = new ReplayPlayer(sourceFor("player_combat"));
    await player.init(0);
    player.play();
    player.setSpeed(8);

    const overlay = new OverlayState();
    let guard = 0;
    while (!player.finished && guard++ < 10000) {
      const { snapshot, events } = await player.advance(100); // 100 ms reales por frame
      for (const e of events) overlay.applyEvent(e);
      if (snapshot) overlay.applySnapshot(snapshot);
    }
    expect(player.finished).toBe(true);
    // El marcador del reproductor = BattleResult oficial almacenado en el índice.
    expect(overlay.score).toEqual(player.index!.result.score);
    expect(player.index!.result.score).toEqual(combat.result.score);
    expect(player.index!.result.finalStateHash).toBe(combat.result.finalStateHash);
  });

  it("las velocidades se acotan al rango 0,5×–8× del dosier", async () => {
    const player = new ReplayPlayer(sourceFor("player_combat"));
    await player.init(0);
    player.setSpeed(0.1);
    expect(player.speed).toBe(MIN_SPEED);
    player.setSpeed(100);
    expect(player.speed).toBe(MAX_SPEED);
    // Pausa: el playhead no avanza.
    player.pause();
    const before = player.currentTick;
    await player.advance(500);
    expect(player.currentTick).toBe(before);
  });
});

describe("T8.3 salto temporal por keyframes", () => {
  it("aterriza en el tick pedido ±1 tick", async () => {
    const player = new ReplayPlayer(sourceFor("player_combat"));
    await player.init(0);
    const n = combat.result.ticks;
    for (const t of [1, 100, 101, Math.floor(n / 3), Math.floor(n / 2) + 1, n - 2]) {
      await player.seekTick(t);
      expect(Math.abs(player.currentTick - t), `salto a ${t}`).toBeLessThanOrEqual(1);
      const { snapshot } = await player.advance(0);
      expect(Math.abs(snapshot.tick - t)).toBeLessThanOrEqual(1);
    }
  });

  it("el salto a un tick arbitrario de un replay de 5 minutos tarda < 1 s (DoD, medido)", async () => {
    const player = new ReplayPlayer(sourceFor("player_5min"));
    await player.init(0);
    expect(player.index!.ticks).toBe(9000);

    for (const t of [7500, 300, 8991, 4444]) {
      const t0 = performance.now();
      await player.seekTick(t);
      const elapsed = performance.now() - t0;
      expect(elapsed, `salto a ${t} tardó ${elapsed.toFixed(0)} ms`).toBeLessThan(1000);
      expect(Math.abs(player.currentTick - t)).toBeLessThanOrEqual(1);
    }
  });

  it("tras un salto no se re-entregan eventos anteriores al punto de aterrizaje", async () => {
    const player = new ReplayPlayer(sourceFor("player_combat"));
    await player.init(0);
    const mid = Math.floor(combat.result.ticks / 2);
    await player.seekTick(mid);
    player.play();
    const { events } = await player.advance(100);
    for (const e of events) expect(e.tick).toBeGreaterThanOrEqual(mid - 1);
  });
});

describe("T8.3 coherencia de eventos y snapshots a 8×", () => {
  it("reproducir a 8× con frames irregulares entrega TODOS los eventos, en orden y a su tick", async () => {
    const player = new ReplayPlayer(sourceFor("player_combat"));
    await player.init(0);
    player.play();
    player.setSpeed(8);

    const delivered: any[] = [];
    // Frames deliberadamente irregulares (como un navegador con tirones).
    const dts = [16, 7, 120, 33, 250, 16, 5, 500];
    let i = 0;
    let guard = 0;
    while (!player.finished && guard++ < 10000) {
      const before = player.currentTick;
      const { snapshot, events } = await player.advance(dts[i++ % dts.length]);
      for (const e of events) {
        // Cada evento se entrega cuando el playhead ALCANZA su tick, nunca antes,
        // y siempre dentro de la ventana del avance que lo cruzó.
        expect(e.tick).toBeGreaterThanOrEqual(before - 1);
        expect(e.tick).toBeLessThanOrEqual(player.currentTick);
        // El snapshot vigente nunca va por detrás del evento más de un intervalo (3 ticks).
        expect(snapshot.tick).toBeGreaterThanOrEqual(e.tick - 3);
        delivered.push(e);
      }
    }
    // Ni un evento perdido ni duplicado respecto al replay oficial, y en orden.
    expect(delivered.length).toBe(combat.events.length);
    expect(delivered.map((e) => e.tick)).toEqual([...combat.events].sort((a, b) => a.tick - b.tick).map((e) => e.tick));
    expect(combat.events.length).toBeGreaterThan(0); // el guion tiene eventos de verdad
  });
});

describe("T8.3 enlaces compartibles con tick inicial", () => {
  it("build/parse hacen round-trip y sanean valores raros", () => {
    expect(parseShareLink(buildShareLink("abc", 1234))).toEqual({ battleId: "abc", t: 1234 });
    expect(parseShareLink(buildShareLink("con espacios/raros", 7))).toEqual({ battleId: "con espacios/raros", t: 7 });
    expect(parseShareLink("#/replay/abc")).toEqual({ battleId: "abc", t: 0 });
    expect(parseShareLink("#/replay/abc?t=-5")).toEqual({ battleId: "abc", t: 0 });
    expect(parseShareLink("#/replay/abc?t=NaN")).toEqual({ battleId: "abc", t: 0 });
    expect(parseShareLink("#/otracosa")).toBeNull();
  });

  it("abrir el enlace inicia el reproductor en el instante correcto (±1 tick)", async () => {
    const t = Math.floor(combat.result.ticks * 0.7) + 1;
    const link = buildShareLink("player_combat", t);
    const parsed = parseShareLink(link)!;
    const player = new ReplayPlayer(sourceFor(parsed.battleId));
    await player.init(parsed.t);
    expect(Math.abs(player.currentTick - t)).toBeLessThanOrEqual(1);
  });
});

/**
 * V1 REPLAYS PR-4b · T8.3 «capas de depuración en replay» RETIRADA por decisión del operador.
 * Sustituye al test opt-in (`debugOpen`/`commandsAt`): la capa no existe en el reproductor, el
 * índice no la anuncia, ningún segmento trae comandos y, aunque una fuente maliciosa o antigua
 * mandara `debugOpen: true` y `commands`, el reproductor no guarda ni expone ninguno.
 */
describe("T8.3 · la capa de depuración del replay ya no existe (retirada)", () => {
  it("ni el índice ni los segmentos S9R anuncian ni traen comandos, aunque la batalla los tenga", async () => {
    expect(debugCandidate.commands.length).toBeGreaterThan(0);
    const src = sourceFor("player_debug_retired");
    const index = (await src.index()) as unknown as Record<string, unknown>;
    expect(index).not.toHaveProperty("debugOpen");
    const total = debugCandidate.result.ticks;
    for (let from = 0; from <= total; from += 600) {
      const seg = (await src.segment(from, Math.min(from + 599, total))) as unknown as Record<string, unknown>;
      expect(seg).not.toHaveProperty("commands");
      expect(JSON.stringify(seg)).not.toMatch(/"forTick"|"throttle"/);
    }
  });

  it("el reproductor no tiene debugOpen ni commandsAt y no retiene comandos de una fuente que los mande", async () => {
    const real = sourceFor("player_debug_retired");
    const hostile: ReplaySource = {
      index: async () => ({ ...(await real.index()), debugOpen: true }) as any,
      segment: async (f, t) => ({ ...(await real.segment(f, t)), commands: debugCandidate.commands }) as any,
    };
    const player = new ReplayPlayer(hostile);
    await player.init(0);
    await player.seekTick(debugCandidate.commands[0].tick);
    const p = player as unknown as Record<string, unknown>;
    expect("debugOpen" in p).toBe(false);
    expect("commandsAt" in p).toBe(false);
    expect("commands" in p).toBe(false);
    // Ningún campo del reproductor retiene un comando (los comandos llevan `forTick`/`throttle`).
    const held = Object.values(p).filter((v) => Array.isArray(v));
    expect(JSON.stringify(held)).not.toMatch(/"forTick"|"throttle"/);
  });
});
