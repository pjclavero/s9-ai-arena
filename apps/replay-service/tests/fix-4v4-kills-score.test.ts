/**
 * 4v4-FIX · Bajas = marcador con el MOTOR REAL, también donde el orden de emisión
 * engaña: zonas de daño (ácido del mapa real mvp-arena-01), minas, fuego amigo y
 * suicidio, en TDM 4v4 y en DM.
 *
 * Invariante (la regla de puntuación de `modes.ts`):
 *  - DM y TDM sin fuego amigo: `score[t] === perTeam[t].kills`.
 *  - TDM con fuego amigo: matar a un compañero (o a uno mismo) puntúa al RIVAL, así
 *    que `score[t] === perTeam[t].kills + Σ_{u≠t} perTeam[u].teamKills`.
 *  - Las muertes sin autor (zona) no suman a nadie:
 *    `Σ deaths === Σ kills + Σ teamKills + muertes por zona`.
 * La verdad independiente es `result.score` del replay grabado y los eventos
 * públicos (`vehicle_destroyed`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, resimulateWithEvents, type Replay } from "../../arena-engine/src/replay.js";
import type { ArenaMap } from "../../arena-engine/src/sim/modes.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout, minerLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import { computeBattleStats, type BattleStatsResult } from "../src/stats.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const realMap = (): ArenaMap => toEngineMap(JSON.parse(readFileSync(join(REPO, "maps", "mvp-arena-01.json"), "utf8")));

beforeAll(async () => {
  await initPhysics();
});

const RED = ["r1", "r2", "r3", "r4"];
const BLUE = ["b1", "b2", "b3", "b4"];

/**
 * HunterBot que además suelta minas cada N decisiones (si lleva lanzaminas). OJO:
 * el motor sólo procesa `deployMine` en una orden que también dispara
 * (`resolveFiring` hace `continue` sin `fire`), así que la mina va con disparo.
 */
class MinerHunter extends HunterBot {
  private d = 0;
  constructor(
    botId: string,
    private every: number,
  ) {
    super(botId);
  }
  override decide(obs: any) {
    const cmd: any = super.decide(obs);
    if (this.d++ % this.every === 0) {
      cmd.deployMine = { slot: "mine_bay" };
      cmd.fire ??= ["turret_main"];
    }
    return cmd;
  }
}

async function tdm4v4(
  seed: string,
  map: ArenaMap,
  opts: { friendlyFire?: boolean; miners?: boolean; ticks?: number } = {},
): Promise<Replay> {
  const parts = [
    ...RED.map((id, i) => ({
      id,
      botId: `bot_${id}`,
      team: "red",
      spec: opts.miners && i % 2 === 0 ? minerLoadout() : gunnerLoadout(),
    })),
    ...BLUE.map((id, i) => ({
      id,
      botId: `bot_${id}`,
      team: "blue",
      spec: opts.miners && i % 2 === 0 ? minerLoadout() : gunnerLoadout(),
    })),
  ];
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("tdm_mvp@1", {
        timeLimitTicks: opts.ticks ?? 2700,
        scoreToWin: 999,
        ...(opts.friendlyFire ? { friendlyFire: true } : {}),
      }),
      map,
      participants: parts,
    },
    (b) => {
      for (const p of parts) b.attachBot(p.id, opts.miners ? new MinerHunter(p.botId, 25) : new HunterBot(p.botId));
    },
  );
}

/** Muertes sin autor (zona) según el motor, contadas por el gancho onKill. */
async function zoneDeaths(replay: Replay): Promise<number> {
  let n = 0;
  await resimulateWithEvents(replay, () => {}, {
    onKill: (k) => {
      if (k.killerId === null) n++;
    },
  });
  return n;
}

function expectScoreMatches(replay: Replay, s: BattleStatsResult, friendlyFireRivalScores: boolean) {
  const teams = Object.keys(s.perTeam);
  for (const t of teams) {
    let expected = s.perTeam[t].kills;
    if (friendlyFireRivalScores) for (const u of teams) if (u !== t) expected += s.perTeam[u].teamKills;
    expect(expected, `equipo ${t}`).toBe(replay.result.score[t] ?? 0);
  }
  // perTeam = suma de perBot (las bajas no se inventan ni se pierden por el camino).
  for (const t of teams) {
    const bots = Object.values(s.perBot).filter((b) => b.team === t);
    expect(s.perTeam[t].kills).toBe(bots.reduce((a, b) => a + b.kills, 0));
  }
}

describe("4v4-FIX · bajas = marcador con zonas de daño, minas, fuego amigo y suicidio", () => {
  it("el mapa real mvp-arena-01 trae una zona de daño (si no, este test no prueba nada)", () => {
    expect(realMap().zones.some((z) => z.kind === "damage" && (z.damagePerSecond ?? 0) > 0)).toBe(true);
  });

  for (const seed of ["fx-acid-1", "fx-acid-2", "fx-acid-3"]) {
    it(`TDM 4v4 en mvp-arena-01 (ácido real): perTeam.kills === marcador (${seed})`, async () => {
      const replay = await tdm4v4(seed, realMap());
      const s = await computeBattleStats(replay);
      expectScoreMatches(replay, s, false);
      const deaths = Object.values(s.perBot).reduce((a, b) => a + b.deaths, 0);
      const destroyed = replay.events.filter((e: any) => e.kind === "vehicle_destroyed" && s.perBot[e.targetId]);
      expect(deaths).toBe(destroyed.length);
      const kills = Object.values(s.perBot).reduce((a, b) => a + b.kills + b.teamKills, 0);
      expect(kills + (await zoneDeaths(replay))).toBe(deaths);
      expect(deaths).toBeGreaterThan(0);
    }, 180_000);
  }

  it("TDM 4v4 con ácido fuerte en el centro: hay muertes por zona y aun así bajas === marcador", async () => {
    const m = emptyArena(120, 80);
    m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 22, kind: "damage", damagePerSecond: 240 });
    for (const seed of ["fx-zk-1", "fx-zk-2"]) {
      const replay = await tdm4v4(seed, m, { ticks: 2400 });
      const s = await computeBattleStats(replay);
      expectScoreMatches(replay, s, false);
      expect(await zoneDeaths(replay), seed).toBeGreaterThan(0);
    }
  }, 240_000);

  it("TDM 4v4 con fuego amigo, minas y suicidio: marcador = bajas propias + teamKills del rival", async () => {
    const m = emptyArena(120, 80);
    m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 10, kind: "damage", damagePerSecond: 120 });
    let teamKills = 0;
    for (const seed of ["fx-ff-1", "fx-ff-2"]) {
      const replay = await tdm4v4(seed, m, { friendlyFire: true, miners: true, ticks: 2400 });
      const s = await computeBattleStats(replay);
      expectScoreMatches(replay, s, true);
      teamKills += Object.values(s.perBot).reduce((a, b) => a + b.teamKills, 0);
    }
    // Sin fuego amigo real el caso no estaría probado.
    expect(teamKills).toBeGreaterThan(0);
  }, 240_000);

  it("suicidio con mina propia (fuego amigo): teamKill del dueño, punto del rival, ninguna baja", async () => {
    const m = emptyArena(120, 80);
    const parts = [
      // Chasis de 150: con 3 cargas de 90 la mina propia SÍ mata (con 300 no).
      { id: "r1", botId: "bot_r1", team: "red", spec: { ...minerLoadout(), hullHp: 150 } },
      { id: "b1", botId: "bot_b1", team: "blue", spec: gunnerLoadout() },
    ];
    const replay = await record(
      {
        battleId: "fx-suicide",
        seed: "fx-suicide",
        ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 900, scoreToWin: 999, friendlyFire: true }),
        map: m,
        participants: parts,
      },
      (b) => {
        // r1 suelta minas sin moverse (se pisa la suya); b1 no hace nada.
        // Dispara hacia atrás (al muro) porque sin `fire` el motor ignora `deployMine`.
        b.attachBot("r1", {
          botId: "bot_r1",
          decide: (o: any) => ({
            forTick: o.tick,
            turret: { targetHeading: Math.PI },
            fire: ["turret_main"],
            deployMine: { slot: "mine_bay" },
          }),
        });
        b.attachBot("b1", { botId: "bot_b1", decide: (o: any) => ({ forTick: o.tick }) });
      },
    );
    const s = await computeBattleStats(replay);
    expect(s.perBot.r1.deaths).toBeGreaterThan(0);
    expect(s.perBot.r1.teamKills).toBe(s.perBot.r1.deaths);
    expect(s.perBot.r1.kills).toBe(0);
    expect(s.perTeam.blue.kills).toBe(0);
    expect(replay.result.score.blue).toBe(s.perBot.r1.deaths);
    expectScoreMatches(replay, s, true);
  }, 120_000);

  it("DM con zona de daño: bajas por bot === marcador", async () => {
    const m = emptyArena(120, 80);
    m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 22, kind: "damage", damagePerSecond: 240 });
    // v1 nace (y reaparece) en ácido letal: muertes por zona garantizadas en DM.
    m.zones.push({ id: "acid_v1", position: { x: 15, y: 15 }, radiusM: 8, kind: "damage", damagePerSecond: 900 });
    const ids = ["v1", "v2", "v3", "v4"];
    m.spawns = [
      { team: "v1", position: { x: 15, y: 15 }, heading: 0.6 },
      { team: "v2", position: { x: 105, y: 65 }, heading: -2.5 },
      { team: "v3", position: { x: 15, y: 65 }, heading: -0.6 },
      { team: "v4", position: { x: 105, y: 15 }, heading: 2.5 },
    ];
    const parts = ids.map((id) => ({ id, botId: `bot_${id}`, team: id, spec: gunnerLoadout() }));
    const replay = await record(
      {
        battleId: "fx-dm",
        seed: "fx-dm",
        ruleset: loadRuleset("dm_practice@1", {
          timeLimitTicks: 2400,
          scoreToWin: 999,
          respawn: { enabled: true, delayTicks: 60 },
        }),
        map: m,
        participants: parts,
      },
      (b) => {
        for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
      },
    );
    const s = await computeBattleStats(replay);
    expectScoreMatches(replay, s, false);
    expect(await zoneDeaths(replay)).toBeGreaterThan(0);
    expect(Object.values(replay.result.score).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }, 120_000);
});
