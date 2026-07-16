/**
 * T8.4 · Pipeline de estadísticas: golden a mano sobre batallas guionizadas,
 * idempotencia contra PostgreSQL real (embebido, harness de E7), agregados por
 * bot-versión y por módulo (insumo del balance de E3) y rendimiento medido.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { ctfArena, emptyArena, gunnerLoadout, sandbagLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { DeadBot, FlagRunnerBot, HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "../../api/src/db/seeds/dev.js";
import { ingestReplay } from "../src/store.js";
import { aggregateByBotVersion, aggregateByModule, computeBattleStats, runStatsJob } from "../src/stats.js";

beforeAll(async () => {
  await initPhysics();
});

async function hunterBattle(seed: string, botIds = { red: "bot_red", blue: "bot_blue" }, ticks = 1500): Promise<Replay> {
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: ticks }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: botIds.red, team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: botIds.blue, team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot(botIds.red));
      b.attachBot("v_blue", new HunterBot(botIds.blue));
    },
  );
}

describe("T8.4 golden: batallas guionizadas con valores calculados a mano", () => {
  it("CTF guionizado: 1 bandera tomada, 1 captura, marcador 1-0, lado ganador correcto", async () => {
    const map = ctfArena();
    const blueFlag = map.flags.find((f) => f.team === "blue")!.position;
    const redBase = map.bases.find((b2) => b2.team === "red")!.position;
    const replay = await record(
      {
        battleId: "stats_ctf",
        seed: "stats-ctf",
        ruleset: loadRuleset("ctf_mvp@1", { scoreToWin: 1 }),
        map,
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
        ],
      },
      (b) => {
        b.attachBot("veh_1", new FlagRunnerBot("b1", blueFlag, redBase));
        b.attachBot("veh_2", new IdleBot("b2"));
      },
    );
    const s = await computeBattleStats(replay);

    // Valores conocidos A MANO del guion: el corredor toma la bandera azul UNA vez
    // y la captura UNA vez; nadie dispara, nadie muere, nadie omite turnos.
    const red = s.perBot["veh_1"];
    const blue = s.perBot["veh_2"];
    expect(red.flagsTaken).toBe(1);
    expect(red.flagCaptures).toBe(1);
    expect(red.shotsFired).toBe(0);
    expect(red.kills).toBe(0);
    expect(red.died).toBe(false);
    expect(red.decisionTimeouts).toBe(0);
    expect(blue.flagCaptures).toBe(0);
    expect(blue.died).toBe(false);
    expect(blue.decisionTimeouts).toBe(0);
    expect(s.winner).toBe("red");
    expect(s.perTeam.red.score).toBe(1);
    expect(s.perTeam.blue.score).toBe(0);
    expect(s.durationTicks).toBe(replay.result.ticks);
    // El rojo nace en x=16 (< 60): gana el lado izquierdo.
    expect(s.winnerSide).toBe("left");
  }, 120000);

  it("bot mudo: EXACTAMENTE maxConsecutiveTimeouts turnos omitidos y descalificación", async () => {
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 600 });
    const replay = await record(
      {
        battleId: "stats_timeouts",
        seed: "stats-timeouts",
        ruleset,
        map: emptyArena(),
        participants: [
          { id: "v_mudo", botId: "b_mudo", team: "red", spec: sandbagLoadout() },
          { id: "v_vivo", botId: "b_vivo", team: "blue", spec: sandbagLoadout() },
        ],
      },
      (b) => {
        b.attachBot("v_mudo", new DeadBot("b_mudo"));
        b.attachBot("v_vivo", new IdleBot("b_vivo"));
      },
    );
    const s = await computeBattleStats(replay);
    // A mano: el motor descalifica al vigésimo timeout consecutivo (D2).
    expect(s.perBot["v_mudo"].decisionTimeouts).toBe(ruleset.maxConsecutiveTimeouts);
    expect(s.perBot["v_mudo"].disqualified).toBe(true);
    expect(s.perBot["v_vivo"].decisionTimeouts).toBe(0);
    expect(s.perBot["v_vivo"].disqualified).toBe(false);
    expect(s.winner).toBe("blue");
  });

  it("conservación del daño: lo repartido por uno es EXACTAMENTE lo encajado por el otro", async () => {
    const replay = await hunterBattle("stats_damage");
    const s = await computeBattleStats(replay);
    const red = s.perBot["v_red"];
    const blue = s.perBot["v_blue"];
    // En arena vacía sin minas ni zonas, todo el daño viene de proyectiles.
    expect(red.damageDealt).toBeCloseTo(blue.damageTaken, 6);
    expect(blue.damageDealt).toBeCloseTo(red.damageTaken, 6);
    expect(red.damageDealt + blue.damageDealt).toBeGreaterThan(0); // hubo combate real
    for (const bot of [red, blue]) {
      expect(bot.shotsHit).toBeLessThanOrEqual(bot.shotsFired);
      if (bot.accuracy !== null) {
        expect(bot.accuracy).toBeGreaterThan(0);
        expect(bot.accuracy).toBeLessThanOrEqual(1);
      }
    }
    // El que mató aparece con 1 kill y el muerto con died=true.
    const deaths = [red, blue].filter((b) => b.died).length;
    const kills = red.kills + blue.kills;
    expect(kills).toBe(deaths);
  });

  it("las métricas por módulo usan los moduleId REALES del catálogo de E3", async () => {
    const replay = await hunterBattle("stats_modules");
    const s = await computeBattleStats(replay);
    const catalogIds = new Set(loadCatalog().map((m: any) => `${m.id}@${m.version}`));
    const red = s.perBot["v_red"];
    for (const pm of Object.values(red.perModule)) {
      expect(pm.moduleId).toBeTruthy();
      expect(catalogIds.has(pm.moduleId!), `${pm.moduleId} no está en el catálogo E3`).toBe(true);
    }
    // El cañón del artillero disparó y tiene daño y eficiencia atribuidos.
    const cannon = red.perModule["turret_main"];
    expect(cannon.uses).toBeGreaterThan(0);
    expect(cannon.damageDealt).toBeCloseTo(red.damageDealt, 6); // un solo arma ⇒ exacto
    expect(cannon.efficiency).toBeGreaterThan(0);
  });
});

describe("T8.4 agregados por módulo (insumo del informe de balance de E3)", () => {
  it("agrega uso, daño, fallos, eficiencia y supervivencia por moduleId", async () => {
    const a = await computeBattleStats(await hunterBattle("stats_agg_a"));
    const b = await computeBattleStats(await hunterBattle("stats_agg_b"));
    const agg = aggregateByModule([a, b]);
    const cannon = agg.find((m) => m.moduleId.startsWith("weapon.cannon"));
    expect(cannon).toBeTruthy();
    expect(cannon!.battles).toBe(2);
    expect(cannon!.uses).toBeGreaterThan(0);
    expect(cannon!.efficiency).toBeGreaterThan(0);
    for (const m of agg) {
      expect(m.survivalRate).toBeGreaterThanOrEqual(0);
      expect(m.survivalRate).toBeLessThanOrEqual(1);
    }
  });
});

describe("T8.4 job idempotente contra PostgreSQL real + rendimiento", () => {
  let h: TestDbHandle;
  let dir: string;
  let dbBattleId: string;
  let redBotId: string;
  let blueBotId: string;

  beforeAll(async () => {
    h = await startTestDb();
    await seedDev(h.db);
    dir = mkdtempSync(join(tmpdir(), "e8-stats-"));

    // Bots reales de plataforma (con loadout y versión publicada, FKs de verdad).
    const owner = await h.db("users").where({ email: DEV_USERS.developer }).first();
    const mkBot = async (name: string) => {
      const [bot] = await h.db("bots").insert({ name, owner_id: owner.id, visibility: "public" }).returning("*");
      await h.db("bot_loadouts").insert({
        bot_id: bot.id, revision: 1, catalog_version: "mvp@1",
        chassis: "chassis.medium@1", modules: JSON.stringify([]),
      });
      await h.db("bot_versions").insert({ bot_id: bot.id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
      return bot.id as string;
    };
    redBotId = await mkBot("stats-red");
    blueBotId = await mkBot("stats-blue");

    // Replay REAL cuyos participantes llevan el botId (uuid) de la plataforma.
    const replay = await hunterBattle("stats_job", { red: redBotId, blue: blueBotId });
    ingestReplay(dir, replay, { official: true });

    const [battle] = await h.db("battles")
      .insert({
        status: "finished", official: true, mode: "deathmatch",
        ruleset_id: DEFAULT_RULESET_ID, map_id: "mvp-arena-01", map_version: 1, seed: "stats_job",
      })
      .returning("*");
    dbBattleId = battle.id;
    const outcome = (team: string) => (replay.result.winner === "draw" ? "draw" : replay.result.winner === team ? "win" : "loss");
    await h.db("participants").insert([
      { battle_id: dbBattleId, bot_id: redBotId, version: 1, team: "red", outcome: outcome("red") },
      { battle_id: dbBattleId, bot_id: blueBotId, version: 1, team: "blue", outcome: outcome("blue") },
    ]);
  }, 180000);

  afterAll(async () => {
    await h.stop();
  });

  it("reprocesar la misma batalla dos veces no duplica estadísticas (DoD)", async () => {
    const r1 = await runStatsJob(h.db, dir, dbBattleId, "stats_job");
    const rows1 = await h.db("battle_stats").where({ battle_id: dbBattleId }).orderBy("bot_id");
    const r2 = await runStatsJob(h.db, dir, dbBattleId, "stats_job");
    const rows2 = await h.db("battle_stats").where({ battle_id: dbBattleId }).orderBy("bot_id");

    expect(r1.rowsWritten).toBe(2);
    expect(r2.rowsWritten).toBe(2);
    expect(rows1.length).toBe(2);
    expect(rows2.length).toBe(2);
    // Mismo contenido bit a bit: reprocesar = sobrescribir, jamás acumular.
    expect(JSON.stringify(rows2.map((r) => r.stats))).toBe(JSON.stringify(rows1.map((r) => r.stats)));
  }, 120000);

  it("expone agregados por bot-versión para E9", async () => {
    const agg = await aggregateByBotVersion(h.db);
    const red = agg.find((a) => a.botId === redBotId);
    expect(red).toBeTruthy();
    expect(red!.version).toBe(1);
    expect(red!.battles).toBe(1);
    expect(red!.wins + red!.draws).toBeLessThanOrEqual(1);
    expect(red!.survivalRate).toBeGreaterThanOrEqual(0);
  });

  it("procesar una batalla de 5 minutos tarda < 10 s (DoD, medido)", async () => {
    const replay = await record(
      {
        battleId: "stats_5min",
        seed: "stats-5min",
        ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 9000 }),
        map: emptyArena(),
        participants: [
          { id: "v_red", botId: redBotId, team: "red", spec: sandbagLoadout() },
          { id: "v_blue", botId: blueBotId, team: "blue", spec: sandbagLoadout() },
        ],
      },
      (b) => {
        b.attachBot("v_red", new IdleBot(redBotId));
        b.attachBot("v_blue", new IdleBot(blueBotId));
      },
    );
    ingestReplay(dir, replay, { official: true });
    expect(replay.result.ticks).toBe(9000);

    const t0 = performance.now();
    const stats = await computeBattleStats(replay);
    const elapsed = performance.now() - t0;
    expect(stats.durationTicks).toBe(9000);
    expect(elapsed, `procesado en ${elapsed.toFixed(0)} ms`).toBeLessThan(10_000);
  }, 120000);
});
