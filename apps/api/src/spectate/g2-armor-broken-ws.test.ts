/**
 * OLA 2 · G2 · ronda 2 (P3-4) · ARMOR_BROKEN_PUBLIC_PROJECTION sobre las capas REALES:
 * replay público (projectReplayDocument), espectador en directo (`public_live`) y broadcast
 * (SpectateGateway por WebSocket real). Batalla real con rotura por DAÑO (no forzada).
 *
 * Parte de la sonda de la revisión independiente de G2 (revisor, 2026-11-16), incorporada al
 * repo: hasta ahora el WS del espectador y el broadcast sólo los cubría esa sonda.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SpectateGateway, spectateProtocols } from "./gateway.js";
import { signSpectateTicket, type SpectatorView } from "../auth/tokens.js";
import { projectReplayDocument, projectedReplayStream } from "../replay-projection.js";
import { Battle, type BattleConfig } from "../../../arena-engine/src/sim/battle.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { record } from "../../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../../arena-engine/src/stubs.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { fixtureGuard } from "../../../../packages/test-contracts/contract-it.js";

beforeAll(async () => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
  await initPhysics();
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECTORS = ["front", "left", "right", "rear"];

function cfg(id: string): BattleConfig {
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: { x: 30, y: 40 }, heading: 0 },
    { team: "blue", position: { x: 60, y: 40 }, heading: Math.PI },
  ];
  return {
    battleId: id,
    seed: "g2rev-armor",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 700 }),
    map,
    snapshotEveryNTicks: 1,
    participants: [
      { id: "veh_1", botId: "bot_h", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot_i", team: "blue", spec: gunnerLoadout() },
    ],
  };
}
const attach = (b: Battle) => {
  b.attachBot("veh_1", new HunterBot("bot_h"));
  b.attachBot("veh_2", new IdleBot("bot_i"));
};

/** Sectores rotos (hp<=0, hpMax>0) por vehículo interno en un frame interno. */
function brokenInternal(f: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const v of f.vehicles ?? [])
    out[v.id] = SECTORS.filter((s) => v.armor?.[s] && v.armor[s].hpMax > 0 && !(v.armor[s].hp > 0));
  return out;
}

function keysDeep(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) keysDeep(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysDeep(v, out);
    }
  return out;
}

/** Comprueba la forma de TODO armorBroken público encontrado; devuelve cuántos frames lo llevan. */
function checkPublicArmor(frames: any[]): { withBroken: number; seqs: string[] } {
  let withBroken = 0;
  const seqs: string[] = [];
  for (const f of frames)
    for (const v of f.vehicles ?? []) {
      if (!("armorBroken" in v)) continue;
      withBroken++;
      const ab = v.armorBroken;
      expect(ab && typeof ab === "object" && !Array.isArray(ab)).toBe(true);
      const ks = Object.keys(ab);
      expect(ks.length, "armorBroken vacío (revela que hay blindaje)").toBeGreaterThan(0);
      for (const k of ks) expect(SECTORS).toContain(k);
      for (const val of Object.values(ab)) expect(val).toBe(true);
      // orden canónico (front,left,right,rear)
      expect(ks).toEqual(SECTORS.filter((s) => ks.includes(s)));
      seqs.push(`${f.tick}:${v.id}:${ks.join("+")}`);
    }
  const keys = keysDeep(frames);
  for (const k of ["hp", "hpMax", "armor", "reduction", "modules", "slot", "hullHp", "hullHpMax"])
    expect(keys.has(k), `clave privada «${k}» en lo público`).toBe(false);
  return { withBroken, seqs };
}

describe("G2 · armorBroken por capa real (replay público, espectador y broadcast por WS)", () => {
  it("replay público: armorBroken == conjunto exacto de sectores rotos del frame interno; nada más", async () => {
    const replay: any = await record(cfg("g2rev_replay"), attach);
    const internal = replay.snapshots as any[];
    const anyBroken = internal.some((f) => Object.values(brokenInternal(f)).some((l) => l.length > 0));
    fixtureGuard(anyBroken, "la batalla no rompió ningún blindaje por daño (el escenario no mide nada)");
    const doc: any = projectReplayDocument(replay, null);
    const pub = (doc.snapshots ?? doc.body?.snapshots) as any[];
    expect(Array.isArray(pub) && pub.length > 0, "FIXTURE: sin snapshots públicos").toBe(true);
    const r = checkPublicArmor(pub);
    expect(r.withBroken).toBeGreaterThan(0);
    // Igualdad exacta por tick con el estado interno (ids: el roster público mapea botId).
    const roster = (projectedReplayStream(replay, null).roster ?? []) as any[];
    expect(roster.length, "FIXTURE: sin nómina pública").toBe(2);
    const pubIdOf = (bot: string) => roster.find((x) => x.botId === bot)?.id;
    const intByTick = new Map(internal.map((f) => [f.tick, f]));
    let compared = 0;
    for (const f of pub) {
      const fi = intByTick.get(f.tick);
      if (!fi) continue;
      const bi = brokenInternal(fi);
      for (const iv of fi.vehicles) {
        const pid = pubIdOf(cfg("x").participants.find((p) => p.id === iv.id)!.botId);
        const pv = (f.vehicles ?? []).find((x: any) => x.id === pid);
        if (!pv) continue;
        compared++;
        expect(Object.keys(pv.armorBroken ?? {}), `tick ${f.tick} ${iv.id}`).toEqual(bi[iv.id]);
      }
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("diferencial: borrar los sectores ÍNTEGROS o cambiar su hp en lo interno NO cambia el replay público", async () => {
    const replay: any = await record(cfg("g2rev_diff"), attach);
    const base = JSON.stringify(projectReplayDocument(replay, null));
    const mut = (fn: (sec: any, v: any, s: string) => void) => {
      const r2 = JSON.parse(JSON.stringify(replay));
      for (const f of r2.snapshots)
        for (const v of f.vehicles ?? [])
          for (const s of SECTORS) if (v.armor?.[s] && v.armor[s].hp > 0) fn(v.armor[s], v, s);
      return JSON.stringify(projectReplayDocument(r2, null));
    };
    expect(mut((_a, v, s) => delete v.armor[s]), "existencia de sector íntegro visible").toBe(base);
    expect(mut((a) => (a.hp = a.hpMax)), "hp de sector íntegro visible").toBe(base);
    expect(mut((a) => (a.hpMax = a.hpMax * 3)), "hpMax de sector íntegro visible").toBe(base);
  });

  it("espectador directo y broadcast por WebSocket: la misma forma y la rotura aparece", async () => {
    const id = "g2rev-gw";
    const b = await Battle.create(cfg(id));
    attach(b);
    cleanups.push(() => b.free());
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    gw.attachBattle(id, b, {
      pollIntervalMs: 5,
      roster: [
        { id: "veh_1", botId: "bot_h", team: "red" },
        { id: "veh_2", botId: "bot_i", team: "blue" },
      ],
      meta: { mode: "deathmatch" },
    });
    const conn = (view: SpectatorView) => {
      const ticket = signSpectateTicket({ battleId: id, jti: randomUUID(), anon: true, view }, 60);
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${id}`, spectateProtocols(ticket));
      cleanups.push(() => ws.terminate());
      const got: any[] = [];
      ws.on("message", (d) => got.push(JSON.parse(String(d))));
      return new Promise<any[]>((res, rej) => {
        ws.once("open", () => res(got));
        ws.once("error", rej);
      });
    };
    const live = await conn("public_live");
    const bc = await conn("broadcast");
    while (!b.isFinished()) {
      for (let i = 0; i < 6 && !b.isFinished(); i++) b.step();
      await sleep(2);
    }
    await sleep(400);
    for (const [name, got] of [
      ["public_live", live],
      ["broadcast", bc],
    ] as const) {
      const frames = got.filter((m) => m.type === "snapshot").map((m) => m.snapshot);
      expect(frames.length, `${name}: sin snapshots`).toBeGreaterThan(5);
      const r = checkPublicArmor(frames);
      expect(r.withBroken, `${name}: la rotura no se ve`).toBeGreaterThan(0);
      const all = JSON.stringify(got);
      expect(all).not.toMatch(/"hp"\s*:|"hpMax"|"armor"\s*:/);
    }
  }, 60_000);
});
