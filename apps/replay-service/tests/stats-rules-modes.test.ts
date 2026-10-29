/**
 * R-STATS (ADR-021) · Stats por modo con el MOTOR REAL: respawn limitado (vidas,
 * reapariciones usadas y restantes, eliminado) y batallas sin límite (esas métricas
 * NO aparecen). La verdad sale de los eventos públicos del replay, no de stats.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, verify, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { resolveRulesRequest } from "../../../packages/game-rules/battle-rules.js";
import { computeBattleStats } from "../src/stats.js";
import { addBotToTeam, emptyTeamStats } from "../src/team-stats.js";

beforeAll(async () => {
  await initPhysics();
});

async function play(ruleset: any, perSide: number): Promise<Replay> {
  const participants = [];
  for (let i = 0; i < perSide * 2; i++) {
    participants.push({
      id: `veh_${i + 1}`,
      botId: `bot_${i + 1}`,
      team: perSide === 1 ? `t${i}` : i % 2 === 0 ? "red" : "blue",
      spec: gunnerLoadout(),
    });
  }
  return record({ battleId: "stats-rules", seed: "stats-rules", ruleset, map: emptyArena(), participants }, (b) => {
    for (const p of participants) b.attachBot(p.id, new HunterBot(p.botId));
  });
}

function limitedRuleset() {
  const r = resolveRulesRequest({
    preset: "custom",
    teamSize: 2,
    params: {
      respawn: { mode: "limited", respawnsPerBot: 1, delaySeconds: 1 },
      victory: "elimination",
      timeLimitMinutes: 20,
    },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.engineRuleset;
}

describe("respawn limitado 2v2 (1 reaparición, 2 vidas)", () => {
  let replay: Replay;
  beforeAll(async () => {
    replay = await play(limitedRuleset(), 2);
  }, 120_000);

  it("el replay verifica y lleva la copia del ruleset con maxRespawns", async () => {
    expect(replay.header.ruleset.respawn).toEqual({ enabled: true, delayTicks: 30, maxRespawns: 1 });
    expect((await verify(replay)).matches).toBe(true);
  });

  it("deaths / respawns / lives / respawnsRemaining / eliminated por bot cuadran con el replay", async () => {
    const s = await computeBattleStats(replay);
    const elim = new Set(replay.events.filter((e: any) => e.kind === "vehicle_eliminated").map((e: any) => e.targetId));
    expect(elim.size).toBeGreaterThan(0);
    for (const [id, b] of Object.entries(s.perBot)) {
      const deaths = replay.events.filter((e: any) => e.kind === "vehicle_destroyed" && e.targetId === id).length;
      expect(b.deaths, id).toBe(deaths);
      expect(b.lives).toBe(2);
      expect(b.respawns).toBeLessThanOrEqual(1);
      expect(b.respawnsRemaining).toBe(1 - b.respawns);
      expect(b.eliminated, id).toBe(elim.has(id));
      if (b.eliminated) expect(b.deaths).toBe(2);
    }
    // El bando perdedor: todos eliminados, 0 reapariciones restantes.
    const loser = replay.result.winner === "red" ? "blue" : "red";
    expect(s.perTeam[loser].respawnsRemaining).toBe(0);
    expect(s.perTeam[loser].survivors).toBe(0);
    expect(s.perTeam[loser].respawns).toBe(2);
  });
});

describe("sin límite de respawns (0.3.0 / ilimitado): no hay métricas de vidas", () => {
  it("tdm_mvp@1 (histórico): ni lives, ni respawnsRemaining, ni eliminated; perTeam sin respawnsRemaining", async () => {
    const replay = await play(loadRuleset("tdm_mvp@1", { timeLimitTicks: 2000 }), 1);
    const s = await computeBattleStats(replay);
    for (const b of Object.values(s.perBot)) {
      expect(b).not.toHaveProperty("lives");
      expect(b).not.toHaveProperty("respawnsRemaining");
      expect(b).not.toHaveProperty("eliminated");
    }
    for (const t of Object.values(s.perTeam)) expect(t).not.toHaveProperty("respawnsRemaining");
    expect(replay.events.some((e: any) => e.kind === "vehicle_eliminated")).toBe(false);
  }, 120_000);
});

describe("addBotToTeam", () => {
  it("suma respawns siempre y respawnsRemaining sólo si el bot lo trae", () => {
    const t = emptyTeamStats("red", 0);
    addBotToTeam(t, { respawns: 2, respawnsRemaining: 0 });
    addBotToTeam(t, { respawns: 1, respawnsRemaining: 1 });
    expect(t.respawns).toBe(3);
    expect(t.respawnsRemaining).toBe(1);
    const u = emptyTeamStats("blue", 0);
    addBotToTeam(u, { respawns: 4 });
    expect(u.respawns).toBe(4);
    expect(u).not.toHaveProperty("respawnsRemaining");
  });
});
