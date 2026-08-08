/**
 * B9 (observación del supervisor) · El worker de torneos NO puede jugar una
 * batalla con reglas de otro modo.
 *
 * `engine-executor.ts` resolvía el ruleset del motor con
 * `ENGINE_RULESETS[battle.mode] ?? "dm_practice@1"`: un objeto plano indexado con
 * un dato de BD y con caída silenciosa a deathmatch. Un modo desconocido —o uno
 * nuevo que nadie añadiera a esa tabla— se jugaba como deathmatch sin que constara
 * en ningún sitio: exactamente la sustitución silenciosa que B9 prohíbe para los
 * mapas, pero con las REGLAS. Y `battle.mode = "__proto__"` resolvía a
 * `Object.prototype` (truthy), así que el `??` ni se activaba.
 *
 * Se prueba el comportamiento: la batalla se rechaza como fallo TÉCNICO (la cola
 * la reintenta y acaba en revisión manual), y en ningún caso se ejecuta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { makeEngineExecutor } from "./engine-executor.js";
import { InfrastructureFailure } from "./errors.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 2, "b9rs");
}, 120000);
afterAll(async () => {
  await h.stop();
});

async function contextForMode(mode: string) {
  const battleId = await insertScheduledBattle(h.db, bots[0], bots[1]);
  await h.db("battles").where({ id: battleId }).update({ mode });
  const battle = await h.db("battles").where({ id: battleId }).first();
  const participants = await h.db("participants").where({ battle_id: battleId });
  return { battle, participants, adminDisqualified: [] } as never;
}

describe("B9 · el worker no sustituye las reglas en silencio", () => {
  it.each(["modo_inventado", "__proto__", "constructor", "toString"])(
    'mode="%s" → fallo técnico explícito, NUNCA se juega como deathmatch',
    async (mode) => {
      const executor = makeEngineExecutor({ db: h.db });
      const ctx = await contextForMode(mode);

      await expect(executor(ctx)).rejects.toBeInstanceOf(InfrastructureFailure);
      await expect(executor(ctx)).rejects.toThrow(/no hay ruleset del motor para el modo/);
    },
    60_000,
  );

  it("un modo REAL del catálogo sigue resolviéndose (no se ha roto el camino bueno)", async () => {
    // No se ejecuta la batalla entera: basta con comprobar que la resolución del
    // ruleset NO es lo que falla — si el modo se resolviera mal, el rechazo sería
    // el mismo mensaje del test anterior.
    const executor = makeEngineExecutor({ db: h.db, rulesetOverrides: { timeLimitTicks: 30 } });
    const ctx = await contextForMode("team_deathmatch");
    let error: unknown;
    try {
      await executor(ctx);
    } catch (err) {
      error = err;
    }
    if (error) expect(String((error as Error).message)).not.toMatch(/no hay ruleset del motor/);
  }, 120_000);
});
