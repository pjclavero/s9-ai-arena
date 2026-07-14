/**
 * T5.4 · DoD del minador: gana >=95% de 20 batallas contra un stub inmóvil.
 */
import { describe, expect, it } from "vitest";
import { startLocalBattle } from "../../sdks/javascript/tests/helpers.js";
import { MinerBot } from "./miner.js";

// 20 batallas reales (~90 s): sólo con RUN_SLOW=1 (ver gunner.test.ts).
const slow = process.env.RUN_SLOW === "1" ? describe : describe.skip;

slow("T5.4 · MinerBot vs stub inmóvil (winrate)", () => {
  it("gana al menos el 95% de 20 batallas, seed distinta cada vez", async () => {
    const N = 20;
    let wins = 0;
    for (let i = 0; i < N; i++) {
      // botId debe cumplir hello.schema.json: ^bot_[0-9a-zA-Z]{1,24}$ (sin guion bajo tras el prefijo).
      const bot = new MinerBot(`bot_minerwr${i}`);
      const battle = await startLocalBattle({
        externalBots: [{ botId: bot.botId, archetype: "miner" }],
        stubBots: [{ botId: `bot_immobile${i}`, archetype: "scout", kind: "idle" }],
        ticks: 900,
        seed: `miner-winrate-${i}`,
      });
      await bot.run(`ws://127.0.0.1:${battle.port}`, battle.battleTokenFor.get(bot.botId)!);
      const result = await battle.waitForResult();
      if (result.winner === "red" && !result.disqualified.includes("veh_1")) wins++;
      battle.free();
    }
    const winrate = wins / N;
    console.log(`MinerBot vs inmóvil: ${wins}/${N} = ${(winrate * 100).toFixed(1)}%`);
    expect(winrate).toBeGreaterThanOrEqual(0.95);
  }, 400000);
});
