/**
 * RE-REVIEW-4V4 · El gancho `onKill` de `resimulateWithEvents` es SÓLO de
 * observación: con y sin él, la re-simulación produce el mismo `finalStateHash`
 * que el replay grabado, el mismo resultado y la misma secuencia EXACTA de
 * eventos por vehículo y de observaciones. Se prueba con el motor real en las
 * configuraciones donde el gancho trabaja (zonas de daño, minas, fuego amigo,
 * respawn, DM y TDM) y con un modo que no puntúa bajas (onKill ausente → el
 * gancho instala uno que sólo avisa).
 *
 * Control positivo: el mismo comparador detecta una re-simulación alterada (una
 * orden grabada menos), así que «igual» no es un comparador ciego.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../src/sim/physics.js";
import { record, resimulateWithEvents, type Replay } from "../src/replay.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout, minerLoadout } from "../src/fixtures.js";
import { HunterBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

class MinerHunter extends HunterBot {
  private d = 0;
  override decide(obs: any) {
    const cmd: any = super.decide(obs);
    if (this.d++ % 20 === 0) {
      cmd.deployMine = { slot: "mine_bay" };
      cmd.fire ??= ["turret_main"];
    }
    return cmd;
  }
}

async function tdm4v4(seed: string): Promise<Replay> {
  const m = emptyArena(120, 80);
  m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 14, kind: "damage", damagePerSecond: 160 });
  const parts = ["r1", "r2", "r3", "r4", "b1", "b2", "b3", "b4"].map((id, i) => ({
    id,
    botId: `bot_${id}`,
    team: id.startsWith("r") ? "red" : "blue",
    spec: i % 2 === 0 ? minerLoadout() : gunnerLoadout(),
  }));
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 2400, scoreToWin: 999, friendlyFire: true }),
      map: m,
      participants: parts,
    },
    (b) => {
      for (const p of parts) b.attachBot(p.id, new MinerHunter(p.botId));
    },
  );
}

async function dm4(seed: string, rulesetId: string): Promise<Replay> {
  const m = emptyArena(120, 80);
  m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 20, kind: "damage", damagePerSecond: 240 });
  m.spawns = [
    { team: "v1", position: { x: 15, y: 15 }, heading: 0.6 },
    { team: "v2", position: { x: 105, y: 65 }, heading: -2.5 },
    { team: "v3", position: { x: 15, y: 65 }, heading: -0.6 },
    { team: "v4", position: { x: 105, y: 15 }, heading: 2.5 },
  ];
  const parts = ["v1", "v2", "v3", "v4"].map((id) => ({ id, botId: `bot_${id}`, team: id, spec: gunnerLoadout() }));
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset(rulesetId, {
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
}

/** Huella de TODO lo observable de una re-simulación. */
async function trace(replay: Replay, withKill: boolean) {
  const h = createHash("sha256");
  const kills: any[] = [];
  const result = await resimulateWithEvents(
    replay,
    (vehicleId, e) => h.update(`E|${vehicleId}|${JSON.stringify(e)}\n`),
    {
      onEmission: (e, to) => h.update(`M|${to}|${JSON.stringify(e)}\n`),
      onObservation: (id, o) => h.update(`O|${id}|${JSON.stringify(o)}\n`),
      ...(withKill ? { onKill: (k) => kills.push(k) } : {}),
    },
  );
  return { result, digest: h.digest("hex"), kills };
}

describe("RE-REVIEW-4V4 · onKill no altera la simulación", () => {
  const cases: [string, () => Promise<Replay>][] = [
    ["TDM 4v4 ácido+minas+fuego amigo", () => tdm4v4("re-ok-tdm")],
    ["DM 4 con ácido y respawn", () => dm4("re-ok-dm", "dm_practice@1")],
  ];
  for (const [name, mk] of cases) {
    it(
      name,
      async () => {
        const replay = await mk();
        const off = await trace(replay, false);
        const on = await trace(replay, true);
        // El gancho trabajó de verdad (si no, el test no prueba nada).
        expect(on.kills.length).toBeGreaterThan(0);
        const destroyed = replay.events.filter(
          (e: any) => e.kind === "vehicle_destroyed" && /^(r|b|v)\d$/.test(e.targetId),
        );
        expect(on.kills.length).toBe(destroyed.length);
        // Mismo hash final que el grabado, con y sin gancho.
        expect(off.result.finalStateHash).toBe(replay.result.finalStateHash);
        expect(on.result.finalStateHash).toBe(replay.result.finalStateHash);
        expect(on.result).toEqual(off.result);
        expect(on.result.score).toEqual(replay.result.score);
        // Misma secuencia exacta de eventos, emisiones y observaciones.
        expect(on.digest).toBe(off.digest);
      },
      240_000,
    );
  }

  it("control positivo: el comparador ve una re-simulación alterada", async () => {
    const replay = await tdm4v4("re-ok-ctrl");
    const base = await trace(replay, true);
    const i = replay.commands.findIndex((c: any) => c.command?.fire?.length);
    expect(i).toBeGreaterThanOrEqual(0);
    const tampered: Replay = { ...replay, commands: replay.commands.filter((_: any, j: number) => j !== i) };
    const alt = await trace(tampered, true);
    expect(alt.digest).not.toBe(base.digest);
  }, 240_000);
});
