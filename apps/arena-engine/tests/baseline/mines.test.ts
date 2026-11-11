/**
 * OLA 2 · ME · BASELINE · minas (C-MINE-1/2/4, ME-03/ME-04 HOY).
 *
 * Fija el comportamiento de la mina actual antes de que MC la generalice a Deployable:
 * armado exacto en `armedAtTick`, aliado ignorado sin fuego amigo, ausencia en lo público
 * hasta que explota y el «quirk» de que `deployMine` sólo se procesa junto a un `fire`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { emptyArena, minerLoadout, sandbagLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { ScriptBot } from "./helpers.js";

beforeAll(async () => {
  await initPhysics();
});

/**
 * El minero (veh_1, red) siembra en el tick 0 en (20,40) y se aparta en el 1; en el tick `placeAt`
 * se coloca a la víctima (veh_2) sobre la mina. Devuelve el tick de `mine_triggered`.
 */
function mineScenario(opts: {
  placeAt: number;
  victimTeam: "blue" | "red";
  friendlyFire?: boolean;
  withFire?: boolean;
}) {
  const map = emptyArena(200, 80);
  map.spawns = [
    { team: "red", position: { x: 20, y: 40 }, heading: Math.PI / 2 },
    { team: opts.victimTeam, position: { x: 150, y: 40 }, heading: 0 },
    ...(opts.victimTeam === "red" ? [{ team: "blue", position: { x: 180, y: 70 }, heading: 0 }] : []),
  ];
  const participants: any[] = [
    { id: "veh_1", botId: "b1", team: "red", spec: minerLoadout() },
    { id: "veh_2", botId: "b2", team: opts.victimTeam, spec: sandbagLoadout() },
  ];
  if (opts.victimTeam === "red") participants.push({ id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() });
  const ruleset =
    opts.victimTeam === "red"
      ? loadRuleset("tdm_mvp@1", { timeLimitTicks: 300, scoreToWin: 999, friendlyFire: opts.friendlyFire ?? false })
      : loadRuleset("dm_practice@1", { timeLimitTicks: 300, friendlyFire: opts.friendlyFire ?? false });
  const b = new Battle({ battleId: "me_mine", seed: "me-mine", ruleset, map, participants });
  const withFire = opts.withFire ?? true;
  b.attachBot(
    "veh_1",
    new ScriptBot("b1", (t) => {
      if (t === 0) return { ...(withFire ? { fire: ["turret_main"] } : {}), deployMine: { slot: "mine_bay" } };
      return undefined;
    }),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  if (participants.length === 3) b.attachBot("veh_3", new IdleBot("b3"));
  let triggeredAt: number | null = null;
  let minePublic = false;
  let armedAtTick: number | null = null;
  for (let t = 0; t < 120; t++) {
    if (t === 1) {
      // El minero se aparta de su mina (teletransporte: sin solapes de cuerpos).
      const own = b.getPhysics().get("veh_1")!;
      own.rb.setTranslation({ x: 60, y: 70 }, true);
      own.rb.setLinvel({ x: 0, y: 0 }, true);
    }
    if (t === opts.placeAt) {
      const body = b.getPhysics().get("veh_2")!;
      body.rb.setTranslation({ x: 20, y: 40 }, true);
      body.rb.setLinvel({ x: 0, y: 0 }, true);
    }
    b.step();
    armedAtTick ??= b.getMines()[0]?.armedAtTick ?? null;
    const ev = b.publicEvents.find((e) => e.kind === "mine_triggered");
    if (ev && triggeredAt === null) triggeredAt = ev.tick;
    if (/mine_\d/.test(JSON.stringify(b.snapshots))) minePublic = true; // "mine_bay" (ranura) no cuenta
  }
  const victimHp = b.getVehicle("veh_2")!.hullHp;
  const mines = b.getMines().length;
  b.free();
  return { triggeredAt, armedAtTick, victimHp, victimHpMax: sandbagLoadout().hullHp, minePublic, mines };
}

describe("baseline · minas", () => {
  it("C-MINE-1 · la mina no explota antes de armedAtTick y explota EXACTAMENTE en ese tick si hay un enemigo encima", () => {
    const r = mineScenario({ placeAt: 15, victimTeam: "blue" });
    expect(r.armedAtTick).toBe(30); // armDelayTicks del catálogo (30) con petición 0
    expect(r.triggeredAt).toBe(30);
    expect(r.victimHp).toBeLessThan(r.victimHpMax);
  });

  it("C-MINE-1 · un enemigo que llega DESPUÉS del armado la dispara en cuanto entra en el radio", () => {
    const r = mineScenario({ placeAt: 50, victimTeam: "blue" });
    expect(r.triggeredAt).toBe(50);
  });

  it("C-MINE-2 · sin fuego amigo, un ALIADO encima no la dispara ni recibe daño", () => {
    const r = mineScenario({ placeAt: 15, victimTeam: "red", friendlyFire: false });
    expect(r.triggeredAt).toBeNull();
    expect(r.victimHp).toBe(r.victimHpMax);
    expect(r.mines).toBe(1);
  });

  it("C-MINE-2 · con fuego amigo, el aliado SÍ la dispara", () => {
    const r = mineScenario({ placeAt: 15, victimTeam: "red", friendlyFire: true });
    expect(r.triggeredAt).toBe(30);
    expect(r.victimHp).toBeLessThan(r.victimHpMax);
  });

  it("C-MINE-4 · la mina no aparece en ningún snapshot público (ni antes ni después de explotar)", () => {
    const r = mineScenario({ placeAt: 15, victimTeam: "blue" });
    expect(r.minePublic).toBe(false);
  });

  it("characterizes-defect: deployMine SIN fire en el mismo comando se ignora en silencio (ni mina ni rechazo)", () => {
    const r = mineScenario({ placeAt: 15, victimTeam: "blue", withFire: false });
    expect(r.mines).toBe(0);
    expect(r.triggeredAt).toBeNull();
  });
});
