/**
 * R-API/R-ENGINE (ADR-021) · El worker juega la COPIA INMUTABLE de reglas de la
 * batalla (`battles.rules`), no lo que diga hoy el catálogo; y una batalla SIN copia
 * (anterior a R-RULES o de torneo) sigue el camino de 0.3.0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { buildBattleRules } from "../../api/src/services/battle-rules.js";
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
          respawn: { mode: "limited", respawnsPerBot: 1, delaySeconds: 1 },
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
      .update({ config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "skirmish_low@1" }), budget_credits: 600 });
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
        .update({ config: JSON.stringify({ mode: "team_deathmatch", engineRulesetId: "tdm_mvp@1" }), budget_credits: 1000 });
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
