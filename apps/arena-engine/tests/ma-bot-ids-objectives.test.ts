/**
 * OLA 2 · MA · 2ª revisión, P2-A: `objectives` (y cualquier otro campo) del canal del bot no
 * lleva ids internos `veh_N` en NINGÚN modo (deathmatch/equipos, ctf, zonas, juggernaut).
 * Motor real: cada bot pasa observaciones y eventos por su BotIdBook y se inspecciona lo que
 * recibiría. Mutante: BotIdBook.observation sin traducir `objectives` ⇒ rojo.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, emptyArena, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { BotIdBook } from "../../../packages/projection/bot-ids.js";

beforeAll(async () => {
  await initPhysics();
});

const INTERNAL = /\b(veh|proj|mine)_[0-9a-zA-Z]+/;

type Part = { id: string; botId: string; team: string };

function book(battleId: string, observer: string, parts: Part[]): BotIdBook {
  const team = parts.find((p) => p.id === observer)!.team;
  return new BotIdBook({
    battleId,
    observer,
    team: parts.filter((p) => p.team === team),
    allVehicleIds: parts.map((p) => p.id),
  });
}

/** Bot que registra lo que vería el canal del bot (observación y eventos ya traducidos). */
class Recorder implements BotAgent {
  readonly seen: any[] = [];
  constructor(
    readonly botId: string,
    private readonly ids: BotIdBook,
  ) {}
  decide(obs: any) {
    this.seen.push(this.ids.observation(obs));
    return { forTick: obs.tick };
  }
  onEvent(e: any) {
    this.seen.push(this.ids.event(e));
  }
}

function play(battle: Battle, parts: Part[], ticks: number, battleId: string): Recorder[] {
  const recs = parts.map((p) => new Recorder(p.botId, book(battleId, p.id, parts)));
  parts.forEach((p, i) => battle.attachBot(p.id, recs[i]));
  battle.run(ticks);
  return recs;
}

const PARTS4: Part[] = [
  { id: "veh_1", botId: "b1", team: "red" },
  { id: "veh_2", botId: "b2", team: "red" },
  { id: "veh_3", botId: "b3", team: "blue" },
  { id: "veh_4", botId: "b4", team: "blue" },
];
const spec = (id: string) => (id === "veh_1" || id === "veh_3" ? scoutLoadout() : sandbagLoadout());

describe("BotIdBook.observation · objectives", () => {
  const mk = () =>
    new BotIdBook({
      battleId: "obj-unit",
      observer: "veh_1",
      team: PARTS4.filter((p) => p.team === "red"),
      allVehicleIds: PARTS4.map((p) => p.id),
    });

  it("el id del juggernaut sale como v_N: el del aliado es el de teammates, el de un rival aún no visto recibe uno propio y estable", () => {
    const b = mk();
    const ally = b.observation({
      tick: 1,
      objectives: [{ kind: "juggernaut", id: "veh_2", team: "red", state: "held" }],
    });
    expect(ally.objectives[0].id).toBe(b.teammateIds()[0]);
    const rival = b.observation({
      tick: 2,
      objectives: [{ kind: "juggernaut", id: "veh_4", team: "blue", state: "held" }],
    });
    expect(rival.objectives[0].id).toMatch(/^v_[0-9]+$/);
    // más tarde el radar nítido ve al mismo rival: mismo id
    const radar = b.observation({
      tick: 3,
      sensors: { radar: [{ slot: "s", contacts: [{ entityId: "veh_4", position: { x: 3, y: 3 } }] }] },
      objectives: [{ kind: "juggernaut", id: "veh_4", team: "blue", state: "held" }],
    });
    expect(radar.sensors.radar[0].contacts[0].entityId).toBe(rival.objectives[0].id);
    expect(radar.objectives[0].id).toBe(rival.objectives[0].id);
    expect(JSON.stringify([ally, rival, radar])).not.toMatch(INTERNAL);
  });

  it("banderas y zonas (sin id de vehículo) pasan intactas; el original no se muta", () => {
    const b = mk();
    const obj = [
      { kind: "flag", team: "red", state: "at_base", position: { x: 1, y: 2 } },
      { kind: "zone", id: "alpha", team: "neutral", state: "neutral", position: { x: 3, y: 4 } },
    ];
    const out = b.observation({ tick: 1, objectives: obj });
    expect(out.objectives).toEqual(obj);
    const j = [{ kind: "juggernaut", id: "veh_3", team: "blue", state: "held" }];
    b.observation({ tick: 2, objectives: j });
    expect(j[0].id).toBe("veh_3");
  });

  it("red de seguridad: un campo NUEVO con un id interno (observación o evento) no llega con veh_N", () => {
    const b = mk();
    const o = b.observation({ tick: 1, mystery: { target: "veh_3", list: ["veh_4", "x"] } });
    const e = b.event({ tick: 1, kind: "future", carrierId: "veh_3" });
    expect(JSON.stringify([o, e])).not.toMatch(INTERNAL);
    expect(o.mystery.list).toContain("x");
  });
});

describe("canal del bot en cada modo con objetivos (motor real)", () => {
  it("juggernaut: objectives[0].id es v_N en todas las observaciones y coincide con teammates o con el radar", () => {
    const battleId = "obj-jugg";
    const battle = new Battle({
      battleId,
      seed: "obj-jugg",
      ruleset: loadRuleset("jugg_mvp@1", { timeLimitTicks: 240 }),
      map: emptyArena(),
      participants: PARTS4.map((p) => ({ ...p, spec: spec(p.id) })),
    });
    const recs = play(battle, PARTS4, 240, battleId);
    for (const r of recs) {
      const objs = r.seen.filter((o) => o.objectives).flatMap((o) => o.objectives);
      expect(objs.length, "control positivo: el juggernaut se publica a todos").toBeGreaterThan(0);
      for (const o of objs) if (o.kind === "juggernaut") expect(o.id).toMatch(/^v_[0-9]+$/);
      expect(JSON.stringify(r.seen)).not.toMatch(INTERNAL);
    }
    // veh_1 es el marcado (primer vivo por id): su propio bot lo ve como su selfId
    const own = recs[0].seen.find((o) => o.objectives?.some((x: any) => x.kind === "juggernaut"));
    expect(own.objectives[0].id).toBe(book(battleId, "veh_1", PARTS4).selfId());
    // y un compañero lo ve con el id de su teammates (el de veh_1 en SU mapper)
    const mate = recs[1].seen.find((o) => o.objectives?.some((x: any) => x.kind === "juggernaut"));
    expect(mate.objectives[0].id).toBe(book(battleId, "veh_2", PARTS4).teammateIds()[0]);
  });

  it("zonas (dominio) y CTF: ningún id interno en observaciones ni eventos de ningún bot", () => {
    const zoneMap = emptyArena();
    zoneMap.zones = [
      { id: "alpha", position: { x: 40, y: 40 }, radiusM: 8, kind: "capture" },
      { id: "bravo", position: { x: 80, y: 40 }, radiusM: 8, kind: "capture" },
    ];
    for (const [name, ruleset, map] of [
      ["obj-dom", loadRuleset("dom_mvp@1", { timeLimitTicks: 120 }), zoneMap],
      ["obj-ctf", loadRuleset("ctf_mvp@1", { timeLimitTicks: 120 }), ctfArena()],
      ["obj-tdm", loadRuleset("tdm_mvp@1", { timeLimitTicks: 120 }), emptyArena()],
    ] as const) {
      const parts = PARTS4;
      const battle = new Battle({
        battleId: name,
        seed: name,
        ruleset,
        map,
        participants: parts.map((p) => ({ ...p, spec: spec(p.id) })),
      });
      const recs = play(battle, parts, 120, name);
      for (const r of recs) {
        expect(r.seen.length, `${name}: control positivo`).toBeGreaterThan(0);
        expect(JSON.stringify(r.seen), name).not.toMatch(INTERNAL);
      }
      if (name !== "obj-tdm") {
        expect(
          recs[0].seen.some((o) => o.objectives?.length),
          `${name}: hay objetivos`,
        ).toBe(true);
      }
    }
  });
});
