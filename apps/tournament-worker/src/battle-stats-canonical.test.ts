/**
 * H3 (issue #7) · `battle_stats` tiene UNA sola forma: la canónica del
 * runStatsJob de E8 (T8.4), que es la que leen los agregados de E9
 * (aggregateByBotVersion: shotsFired, shotsHit, died…).
 *
 * Antes había DOS escritores: el worker de E9 guardaba {team, teamScore,
 * ticks, disqualified} y el job de E8 reescribía la forma rica. Si en
 * producción corría solo el camino del worker, las clasificaciones por
 * precisión y supervivencia salían a cero (hallazgo H3 de la auditoría).
 *
 * Este test FALLA si las dos formas vuelven a divergir:
 *  1. Lo que el worker deja en battle_stats debe ser BYTE A BYTE lo que
 *     produce el runStatsJob de E8 sobre el mismo replay (si alguien
 *     reintroduce otro escritor, la comparación revienta).
 *  2. Los campos que consumen los agregados de E9 existen y producen
 *     agregados no degenerados (precisión/supervivencia ≠ ceros por ausencia
 *     de campos).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { runStatsJob, aggregateByBotVersion } from "../../replay-service/src/stats.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { enqueueJob } from "./queue.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];
let worker: TournamentWorker;
let replaysDir: string;
let battleId: string;

function normalizeRows(rows: Array<Record<string, unknown>>) {
  return rows.map((r) => ({
    battle_id: r.battle_id,
    bot_id: r.bot_id,
    stats: typeof r.stats === "string" ? JSON.parse(r.stats as string) : r.stats,
  }));
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 2, "h3");
  replaysDir = mkdtempSync(join(tmpdir(), "h3-replays-"));
  const wired = await makeDefaultHandlers({
    db: h.db,
    rulesetOverrides: { timeLimitTicks: 900, scoreToWin: 1 },
    // Agente determinista que DISPARA (los stubs con el loadout de ejemplo no
    // se encuentran: llevan lidar, no radar): así shotsFired/accuracy de la
    // forma canónica tienen datos reales que agregar.
    agentResolver: () => ({
      decide(obs: { tick: number }) {
        return { forTick: obs.tick, move: { throttle: 0.6, steer: 0.05 }, fire: ["turret_main"] };
      },
    }),
    replaysDir,
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "h3-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });

  battleId = await insertScheduledBattle(h.db, bots[0], bots[1], { official: true, seed: "h3-canonical" });
  await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `h3:${battleId}` });
  for (let i = 0; i < 10 && (await worker.drain()) > 0; i++) {
    /* cascada run_battle → process_result → … */
  }
}, 180_000);

afterAll(async () => {
  await h.stop();
});

describe("H3 · battle_stats: una única forma canónica (la del job de E8)", () => {
  it("lo que escribe el worker es EXACTAMENTE lo que produce runStatsJob sobre el mismo replay", async () => {
    const battle = await h.db("battles").where({ id: battleId }).first();
    expect(battle.status).toBe("finished");

    const written = normalizeRows(await h.db("battle_stats").where({ battle_id: battleId }).orderBy("bot_id"));
    expect(written.length).toBe(2);

    // Recomputo canónico con el runStatsJob REAL de E8 (idempotente por battle_id).
    await runStatsJob(h.db, replaysDir, battleId);
    const canonical = normalizeRows(await h.db("battle_stats").where({ battle_id: battleId }).orderBy("bot_id"));

    // Divergencia de formas = fallo. Si alguien reintroduce el escritor simple
    // del worker ({team, teamScore, ticks, disqualified}), esto revienta.
    expect(written).toEqual(canonical);
  });

  it("la forma escrita contiene TODOS los campos que leen los agregados de E9", async () => {
    const rows = normalizeRows(await h.db("battle_stats").where({ battle_id: battleId }));
    const CANONICAL_FIELDS = [
      // BotBattleStats de E8 (stats.ts): lo que consume aggregateByBotVersion y el panel.
      "botId", "team", "damageDealt", "damageTaken", "shotsFired", "shotsHit",
      "accuracy", "kills", "died", "survivedTicks", "flagCaptures", "flagsTaken",
      "minesDeployed", "minesTriggered", "decisionTimeouts", "disqualified",
      "cpuMs", "perModule", "vehicleId", "battle",
    ];
    for (const r of rows) {
      const keys = Object.keys(r.stats as Record<string, unknown>).sort();
      expect(keys).toEqual([...CANONICAL_FIELDS].sort());
      // La forma LEGADO no debe reaparecer (era {team, teamScore, ticks, disqualified}).
      expect(keys).not.toContain("teamScore");
      expect(keys).not.toContain("ticks");
    }
  });

  it("aggregateByBotVersion (E9) produce agregados NO degenerados desde lo escrito por el worker", async () => {
    const aggregates = await aggregateByBotVersion(h.db);
    const mine = aggregates.filter((a) => bots.some((b) => b.botId === a.botId));
    expect(mine.length).toBe(2);
    for (const a of mine) {
      expect(a.battles).toBe(1);
      // El síntoma de H3 era precisión/supervivencia degeneradas POR AUSENCIA
      // de campos (shotsFired/died solo existían en la forma rica): con la
      // forma canónica, la supervivencia sale de `died` (presente siempre) y
      // la precisión es null-o-válida, nunca un cero por campo inexistente.
      expect(a.survivalRate === 0 || a.survivalRate === 1).toBe(true);
      if (a.accuracy !== null) {
        expect(a.accuracy).toBeGreaterThanOrEqual(0);
        expect(a.accuracy).toBeLessThanOrEqual(1);
      }
    }
  });

  it("la forma rica captura eventos PRIVADOS re-simulados (imposible con la forma simple)", async () => {
    // Los agentes de este test disparan cada tick de decisión; con el catálogo
    // actual el motor rechaza los disparos (no_ammo, hueco conocido ajeno a
    // H3). Esos rechazos son eventos PRIVADOS que solo la re-simulación de E8
    // reconstruye: si aparecen en battle_stats, el pipeline rico corrió de
    // verdad dentro del worker.
    const rows = normalizeRows(await h.db("battle_stats").where({ battle_id: battleId }));
    for (const r of rows) {
      const s = r.stats as { perModule: Record<string, { rejections: number }> };
      expect(s.perModule.turret_main).toBeTruthy();
      expect(s.perModule.turret_main.rejections).toBeGreaterThan(0);
    }
  });
});
