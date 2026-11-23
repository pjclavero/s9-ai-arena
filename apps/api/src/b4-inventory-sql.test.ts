/**
 * V1 · B4 · el SQL de inventario (scripts/b4-inventory/query.sql) se ejecuta de verdad,
 * en una transacción READ ONLY, y calcula el mismo coste que `loadoutCostCredits`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { createPublishedBot, EXAMPLE_LOADOUT } from "../../tournament-worker/src/testing/fixtures.js";
import { getCatalog } from "./services/catalog.js";
import { loadoutCostCredits } from "../../../packages/module-catalog/validator/index.js";

let h: TestDbHandle;
beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
}, 180_000);
afterAll(async () => {
  await h.stop();
});

const sql = readFileSync(join(import.meta.dirname, "../../../scripts/b4-inventory/query.sql"), "utf8");
const queries = sql
  .split(/^-- ===== Q\d =====$/m)
  .slice(1)
  .map((q) => q.trim().replace(/;$/, ""));

describe("B4 · inventario SQL de sólo lectura", () => {
  it("B4_INV_SQL · Q1..Q4 corren en READ ONLY y el coste nuevo = loadoutCostCredits (900), el antiguo 850", async () => {
    expect(queries).toHaveLength(4);
    const bot = await createPublishedBot(h.db, "b4-inv");
    const catalog = await getCatalog(h.db, EXAMPLE_LOADOUT.catalogVersion);
    const expected = loadoutCostCredits(EXAMPLE_LOADOUT, catalog);
    expect(expected).toBe(900);
    const results = await h.db.transaction(async (trx) => {
      await trx.raw("SET TRANSACTION READ ONLY");
      const out: Record<string, unknown>[][] = [];
      for (const q of queries) out.push((await trx.raw(q)).rows);
      return out;
    });
    const mine = results[0].find((r) => r.bot_id === bot.botId)!;
    expect(mine.cost_new).toBe(expected);
    expect(mine.cost_old).toBe(850);
    expect(mine.ammo_embedded).toBe(50);
    expect(mine.over_800).toBe(true);
    expect(mine.invalid_vs_practice_1000).toBe(false);
    expect(Object.keys(mine).join(",")).not.toMatch(/mail|owner|user/);
    const at800 = results[1].find((r) => r.budget_credits === 800)!;
    expect(Number(at800.versions_over_new_cost)).toBeGreaterThanOrEqual(1);
    expect(Number(at800.newly_over_due_to_ammo)).toBeGreaterThanOrEqual(0);
  });
});
