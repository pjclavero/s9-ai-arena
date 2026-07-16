/**
 * T8.3 · Reproductor de replays contra el replay-service HTTP REAL (supertest):
 * reproducción completa con marcador oficial, salto temporal por keyframes
 * (±1 tick y < 1 s sobre un replay de 5 minutos), velocidades 0,5×–8× con
 * coherencia de eventos, enlaces compartibles y depuración opt-in del dueño.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { createReplayServer } from "../../replay-service/src/server.js";
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

let app: Express;
let combat: Replay; // batalla con eventos (cazadores)
let fiveMin: Replay; // 5 minutos de juego (9000 ticks) para el DoD de salto temporal
let dir: string;

/** Adapta supertest a la interfaz fetch mínima que usa httpReplaySource. */
function sourceFor(battleId: string): ReplaySource {
  return httpReplaySource("", battleId, async (url: string) => {
    const res = await request(app).get(url);
    return { ok: res.status < 400, status: res.status, json: async () => res.body };
  });
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
  dir = mkdtempSync(join(tmpdir(), "e8-player-"));
  combat = await recordBattle("player_combat", { hunters: true, ticks: 1500 });
  fiveMin = await recordBattle("player_5min", { hunters: false, ticks: 9000 });
  ingestReplay(dir, combat, { official: true });
  ingestReplay(dir, fiveMin, { official: true });
  app = createReplayServer({ dir });
}, 300000);

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

describe("T8.3 capas de depuración en replay: opt-in del dueño", () => {
  it("sin permiso del dueño el segmento NO trae comandos; con permiso, sí (para todos)", async () => {
    const privado = await recordBattle("player_debug_off", { hunters: true, ticks: 300 });
    const abierto = await recordBattle("player_debug_on", { hunters: true, ticks: 300 });
    ingestReplay(dir, privado, { official: false });
    ingestReplay(dir, abierto, { official: false, debugOpen: true });

    const pOff = new ReplayPlayer(sourceFor("player_debug_off"));
    await pOff.init(0);
    expect(pOff.debugOpen).toBe(false);
    expect(pOff.commandsAt(0)).toEqual([]);

    const pOn = new ReplayPlayer(sourceFor("player_debug_on"));
    await pOn.init(0);
    expect(pOn.debugOpen).toBe(true);
    const anyCmdTick = abierto.commands[0].tick;
    await pOn.seekTick(anyCmdTick);
    expect(pOn.commandsAt(anyCmdTick).length).toBeGreaterThan(0);
  });
});
