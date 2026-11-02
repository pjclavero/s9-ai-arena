/**
 * R-API/R-ENGINE (ADR-021) · El worker juega la COPIA INMUTABLE de reglas de la
 * batalla (`battles.rules`), no lo que diga hoy el catálogo; y una batalla SIN copia
 * (anterior a R-RULES o de torneo) sigue el camino de 0.3.0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { buildBattleRules, buildTournamentRules } from "../../api/src/services/battle-rules.js";
import { materializeBattles } from "./scheduler.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { fromJsonl } from "../../arena-engine/src/replay.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { makeEngineExecutor } from "./engine-executor.js";
import { createPublishedBot, type TestBot } from "./testing/fixtures.js";
import type { BattleContext } from "./battle-runner.js";

let h: TestDbHandle;
const bots: TestBot[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  for (let i = 0; i < 4; i++) bots.push(await createPublishedBot(h.db, `rsnap-${i + 1}`));
}, 120_000);

afterAll(async () => {
  await h.stop();
});

async function insertBattle(rules: unknown) {
  const [battle] = await h
    .db("battles")
    .insert({
      status: "running",
      official: false,
      mode: "team_deathmatch",
      ruleset_id: "team-deathmatch-mvp",
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "rsnap-seed",
      rules: rules === null ? null : JSON.stringify(rules),
    })
    .returning("*");
  const participants = bots.map((b, i) => ({
    battle_id: battle.id,
    bot_id: b.botId,
    version: 1,
    team: i < 2 ? "red" : "blue",
    outcome: null,
  }));
  await h.db("participants").insert(participants.map(({ outcome: _o, ...p }) => p));
  return { battle, participants };
}

const exec = () =>
  makeEngineExecutor({ db: h.db, agentResolver: (botId) => new HunterBot(botId), rulesetOverrides: {} });

function ctx(battle: any, participants: any[]): BattleContext {
  return { battle, participants, adminDisqualified: [] } as unknown as BattleContext;
}

describe("worker · copia de reglas", () => {
  it("juega engineRuleset de la copia aunque el ruleset de plataforma cambie después de crearla", async () => {
    const participants = bots.map((b, i) => ({ botId: b.botId, version: 1, team: i < 2 ? "red" : "blue" }));
    const built = await buildBattleRules(h.db, {
      mode: "team_deathmatch",
      rulesetId: "team-deathmatch-mvp",
      participants,
      rules: {
        preset: "custom",
        teamSize: 2,
        params: {
          respawn: { mode: "limited", maxRespawns: 1, delaySeconds: 1 },
          victory: "elimination",
          timeLimitMinutes: 1,
        },
      },
    });
    const { battle, participants: rows } = await insertBattle(built.snapshot);
    // Tras crearla, alguien re-apunta el ruleset de plataforma a otras reglas.
    await h
      .db("rulesets")
      .where({ id: "team-deathmatch-mvp" })
      .update({
        config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "skirmish_low@1" }),
        budget_credits: 600,
      });
    try {
      const out = await exec()(ctx(battle, rows));
      const replay = fromJsonl(out.replayJsonl);
      expect(replay.header.ruleset).toEqual(built.snapshot!.engineRuleset);
      expect(replay.header.ruleset.respawn).toEqual({ enabled: true, delayTicks: 30, maxRespawns: 1 });
      expect(out.versions.rulesetEngine).toBe("custom@1");
      expect(out.versions.catalog).toBe(built.snapshot!.catalogVersion);
      expect(out.ticks).toBeLessThanOrEqual(1800);
    } finally {
      await h
        .db("rulesets")
        .where({ id: "team-deathmatch-mvp" })
        .update({
          config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "tdm_mvp@1" }),
          budget_credits: 1000,
        });
    }
  }, 120_000);

  it("una batalla SIN copia (histórica / de torneo) se resuelve como en 0.3.0", async () => {
    const { battle, participants } = await insertBattle(null);
    const out = await makeEngineExecutor({
      db: h.db,
      agentResolver: (botId) => new HunterBot(botId),
      rulesetOverrides: { timeLimitTicks: 300 },
    })(ctx(battle, participants));
    const replay = fromJsonl(out.replayJsonl);
    expect(replay.header.ruleset).toEqual(
      JSON.parse(JSON.stringify(loadRuleset("tdm_mvp@1", { budgetCredits: 1000, timeLimitTicks: 300 }))),
    );
    expect(out.versions.rulesetEngine).toBe("tdm_mvp@1");
    expect(out.versions.catalog).toBe("latest");
  }, 120_000);
});

describe("torneo · copia inmutable de reglas (ADR-022)", () => {
  it("el scheduler copia tournaments.rules en CADA batalla y el worker juega esa copia", async () => {
    const snapshot = await buildTournamentRules(h.db, {
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      format: "league",
      rules: { preset: "duel", teamSize: 1 },
      budgetCredits: null,
      catalogVersion: null,
    });
    expect(snapshot?.presetId).toBe("duel");
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "eq2-snap",
        format: "league",
        mode: "deathmatch",
        ruleset_id: "deathmatch-mvp",
        map_pool: JSON.stringify([{ mapId: "mvp-arena-02", version: 1 }]),
        rounds_per_pairing: 2,
        state: "running",
        rules: JSON.stringify(snapshot),
      })
      .returning("*");
    const [m] = await h.db("matches").insert({ tournament_id: t.id, round: 1 }).returning("*");
    const entry = (b: TestBot) => ({
      botId: b.botId,
      version: 1,
      loadoutRevision: 1,
      ownerId: "x",
      teamId: null,
      name: b.botId,
    });
    const mctx = {
      db: h.db,
      tournament: t,
      entriesByBot: new Map([bots[0], bots[1]].map((b) => [b.botId, entry(b)])),
      teamsById: new Map(),
      seeds: ["s1"],
      mapPool: [{ mapId: "mvp-arena-02", version: 1 }],
    };
    const ids = await materializeBattles(mctx as never, m.id, {
      slot: "R1M1",
      round: 1,
      bracket: "main",
      home: bots[0].botId,
      away: bots[1].botId,
    } as never);
    expect(ids).toHaveLength(2);
    // Tras materializar, el ruleset de plataforma cambia: las batallas NO.
    await h.db("rulesets").where({ id: "deathmatch-mvp" }).update({ budget_credits: 600 });
    try {
      for (const id of ids) {
        const row = await h.db("battles").where({ id }).first();
        expect(row.rules).toEqual(JSON.parse(JSON.stringify(snapshot)));
      }
      const row = await h.db("battles").where({ id: ids[0] }).first();
      const ps = await h.db("participants").where({ battle_id: row.id });
      const out = await makeEngineExecutor({
        db: h.db,
        agentResolver: (botId) => new HunterBot(botId),
        rulesetOverrides: {},
      })(ctx(row, ps));
      const replay = fromJsonl(out.replayJsonl);
      expect(replay.header.ruleset).toEqual(JSON.parse(JSON.stringify(snapshot!.engineRuleset)));
      expect(replay.header.ruleset.timeoutTiebreak).toEqual(["alive", "lives", "kills"]);
      expect(replay.header.versions.engine).toBe("0.4.0");
      expect(out.versions.rulesetEngine).toBe("duel@1");
    } finally {
      await h.db("rulesets").where({ id: "deathmatch-mvp" }).update({ budget_credits: 1000 });
    }
  }, 180_000);

  it("torneo ANTERIOR (sin copia): sus batallas siguen sin copia (resolución en ejecución)", async () => {
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "eq2-legacy",
        format: "league",
        mode: "deathmatch",
        ruleset_id: "deathmatch-mvp",
        state: "running",
      })
      .returning("*");
    const [m] = await h.db("matches").insert({ tournament_id: t.id, round: 1 }).returning("*");
    const e = (b: TestBot) => ({
      botId: b.botId,
      version: 1,
      loadoutRevision: 1,
      ownerId: "x",
      teamId: null,
      name: "n",
    });
    const ids = await materializeBattles(
      {
        db: h.db,
        tournament: t,
        entriesByBot: new Map([bots[2], bots[3]].map((b) => [b.botId, e(b)])),
        teamsById: new Map(),
        seeds: ["s"],
        mapPool: [{ mapId: "mvp-arena-02", version: 1 }],
      } as never,
      m.id,
      { slot: "L1", round: 1, bracket: "main", home: bots[2].botId, away: bots[3].botId } as never,
    );
    const row = await h.db("battles").where({ id: ids[0] }).first();
    expect(row.rules).toBeNull();
  }, 60_000);
});
