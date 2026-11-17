/**
 * REVIEW #234 · Revisión independiente y adversarial del aislamiento de la radio.
 *
 * NO es del autor del PR. Ataca por NO-INTERFERENCIA en lugar de buscar payloads:
 * si la radio de un bando es invisible para el otro, TODO lo que observa el otro bando
 * (cada observación serializada entera y cada evento) tiene que ser BIT A BIT igual
 * tanto si el primer bando habla por radio como si se queda callado. Eso cubre el
 * payload, el remitente, el `sentTick`, la clave `radio`, longitudes, contadores y
 * cualquier canal lateral de estructura, sin tener que enumerarlos.
 *
 * Motor real (Battle + Rapier), sin mocks. Rápido, sin Docker ni red.
 * Con `REVIEW234_DUMP=<fichero>` vuelca la traza para un diferencial main↔PR.
 */
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { MODULES, emptyArena, scoutLoadout } from "../src/fixtures.js";
import type { ArenaMap } from "../src/sim/modes.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";
import { record, resimulateWithEvents, verify } from "../src/replay.js";

beforeAll(async () => {
  await initPhysics();
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
type Team = "red" | "blue";
type Plan = (d: number, obs: any) => any[] | undefined;

function radioSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [...s.modules.filter((m) => m.slot !== "radio_a"), { ...MODULES.radio }];
  return s;
}

class Spy implements BotAgent {
  obs: string[] = [];
  evs: string[] = [];
  heard: { tick: number; from: string; data: string; sentTick: number }[] = [];
  private d = 0;
  constructor(
    readonly botId: string,
    private plan?: Plan,
  ) {}
  decide(obs: any) {
    this.obs.push(JSON.stringify(obs));
    for (const m of obs.radio ?? [])
      this.heard.push({ tick: obs.tick, from: m.from, data: m.data, sentTick: m.sentTick });
    const out: any = { forTick: obs.tick };
    const r = this.plan?.(this.d, obs);
    if (r && r.length) out.radio = r;
    this.d++;
    return out;
  }
  onEvent(e: any) {
    this.evs.push(JSON.stringify(e));
  }
}

const ids = (p: "r" | "b", n: number) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const teamOf = (id: string): Team => (id.startsWith("r") ? "red" : "blue");

function arena(n: number): ArenaMap {
  const m = emptyArena(160, 100);
  m.mapId = `rev234-${n}v${n}`;
  const ys = Array.from({ length: n }, (_, i) => 15 + i * 20);
  m.spawns = [
    ...ys.map((y) => ({ team: "red", position: { x: 30, y }, heading: 0 })),
    ...ys.map((y) => ({ team: "blue", position: { x: 130, y }, heading: Math.PI })),
  ];
  return m;
}

function participants(n: number) {
  return [
    ...ids("r", n).map((id) => ({ id, botId: `bot_${id}`, team: "red", spec: radioSpec() })),
    ...ids("b", n).map((id) => ({ id, botId: `bot_${id}`, team: "blue", spec: radioSpec() })),
  ];
}

function config(n: number, extra: Record<string, unknown> = {}) {
  return {
    battleId: `rev234-${n}v${n}`,
    seed: `rev234-${n}`,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000, scoreToWin: 999 }),
    map: arena(n),
    participants: participants(n),
    ...extra,
  };
}

/** Ataque rojo: difusión, `to` a cada rival, `to` raros, `team`/`from` falsificados, máximo y vacío. */
function redAttack(n: number): Plan {
  const rivals = ids("b", n);
  const weird: any[] = ["__proto__", "constructor", "toString", "", "r1", "nadie", "b1 ", "B1"];
  return (d) => {
    const k = d % 6;
    if (k === 0) return [{ slot: "radio_a", data: b64(`RA${d}`) }];
    if (k === 1) return [{ slot: "radio_a", data: b64(`RT${d}`), to: rivals[d % rivals.length] }];
    if (k === 2) return [{ slot: "radio_a", data: b64(`RW${d}`), to: weird[d % weird.length] }];
    if (k === 3) return [{ slot: "radio_a", data: b64(`RS${d}`), team: "blue", from: "b1" }];
    if (k === 4)
      return d % 12 === 4
        ? [{ slot: "radio_a", data: b64("Y".repeat(33)) }] // 33 bytes: too_large, igual que en main
        : [
            { slot: "radio_a", data: b64("X".repeat(32)) },
            { slot: "radio_a", data: "" },
          ];
    return [
      { slot: "radio_a", data: b64(`RM${d}`) },
      { slot: "radio_a", data: b64(`RN${d}`) },
    ]; // la segunda roza el rate-limit
  };
}
const blueTalk: Plan = (d) => (d % 4 === 0 ? [{ slot: "radio_a", data: b64(`BA${d}`) }] : undefined);

interface RunOpts {
  n: number;
  redTalks: boolean;
  blueTalks?: boolean;
  steps?: number;
  latency?: boolean;
  kill?: boolean;
  observeFor?: boolean;
}

function run(o: RunOpts) {
  const b = new Battle(config(o.n, o.latency ? { simulatedLatency: { minCycles: 0, maxCycles: 2 } } : {}) as any);
  const bots = new Map<string, Spy>();
  for (const p of participants(o.n)) {
    const plan =
      p.team === "red" ? (o.redTalks ? redAttack(o.n) : undefined) : o.blueTalks === false ? undefined : blueTalk;
    const s = new Spy(p.botId, plan);
    bots.set(p.id, s);
    b.attachBot(p.id, s);
  }
  const ofor = new Map<string, string[]>();
  const simParts: string[] = [];
  for (let i = 0; i < (o.steps ?? 420); i++) {
    if (o.kill) {
      // Receptor rival muerto (b1), emisor muerto (r1) y otro receptor (b2), con respawn.
      const kills: Record<number, string[]> = { 20: ["b1"], 60: ["r1"], 90: ["b2"], 200: ["b1", "r1"] };
      for (const id of kills[i] ?? []) {
        const v = b.getVehicle(id);
        if (v && v.alive) {
          v.hullHp = 0;
          v.alive = false;
        }
      }
    }
    b.step();
    // OLA2-MD · el hash v2 INCLUYE la radio (cola, contadores, comandos en vuelo): la
    // no-interferencia se afirma sobre los componentes que no son radio.
    if (b.tick % 30 === 1) {
      const c = b.stateHashBreakdown().components;
      simParts.push([c.tick, c.rng, c.solver, c.projectiles, c.deployables, c.destructibles, c.mode].join(":"));
    }
    if (o.observeFor) {
      for (const id of ids("b", o.n)) {
        const list = ofor.get(id) ?? [];
        list.push(JSON.stringify(b.observationFor(id)));
        ofor.set(id, list);
      }
    }
    if (b.isFinished?.()) break;
  }
  const hashes = [...b.stateHashes];
  const publicEvents = JSON.stringify(b.publicEvents);
  const snaps = JSON.stringify(b.snapshots);
  const teams = Object.fromEntries(b.getVehicles().map((v) => [v.id, v.team]));
  b.free();
  return { bots, hashes, publicEvents, ofor, teams, simParts, snaps };
}

function blueView(r: ReturnType<typeof run>, n: number) {
  return ids("b", n).map((id) => ({ id, obs: r.bots.get(id)!.obs, evs: r.bots.get(id)!.evs, ofor: r.ofor.get(id) }));
}

describe("REVIEW #234 · no-interferencia: lo que ve azul no depende de si rojo habla", () => {
  for (const n of [1, 2, 3, 4]) {
    for (const variant of [
      { name: "básico", kill: false, latency: false },
      { name: "muerte y respawn (emisor y receptor)", kill: true, latency: false },
      { name: "latencia simulada", kill: true, latency: true },
    ]) {
      it(`${n}v${n} · ${variant.name}`, () => {
        const loud = run({ n, redTalks: true, kill: variant.kill, latency: variant.latency, observeFor: true });
        const quiet = run({ n, redTalks: false, kill: variant.kill, latency: variant.latency, observeFor: true });
        // La radio no altera la simulación (física, combate, RNG, modo, snapshots) ni los
        // eventos públicos. OLA2-MD: el hash completo SÍ cambia (la cola de radio es estado).
        expect(loud.simParts.length).toBeGreaterThan(5);
        expect(loud.simParts).toEqual(quiet.simParts);
        expect(loud.snaps).toBe(quiet.snaps);
        expect(loud.publicEvents).toBe(quiet.publicEvents);
        // El respawn no cambia el equipo.
        for (const [id, t] of Object.entries(loud.teams)) expect(t).toBe(teamOf(id));
        if (variant.kill) {
          const respawned = loud.bots.get("b1")!.evs.filter((e) => e.includes('"respawned"')).length;
          expect(respawned).toBeGreaterThanOrEqual(1);
        }
        // Cada observación (decisión y observationFor) y cada evento de cada azul: idénticos.
        const L = blueView(loud, n);
        const Q = blueView(quiet, n);
        for (let i = 0; i < L.length; i++) {
          expect(L[i].obs.length).toBe(Q[i].obs.length);
          for (let k = 0; k < L[i].obs.length; k++) {
            if (L[i].obs[k] !== Q[i].obs[k]) {
              expect(L[i].obs[k], `${L[i].id} obs #${k} difiere`).toBe(Q[i].obs[k]);
            }
          }
          expect(L[i].evs, `${L[i].id} eventos`).toEqual(Q[i].evs);
          expect(L[i].ofor, `${L[i].id} observationFor`).toEqual(Q[i].ofor);
        }
        // Ningún azul oye nunca a un rojo.
        for (const id of ids("b", n)) for (const m of loud.bots.get(id)!.heard) expect(teamOf(m.from)).toBe("blue");
      });
    }
  }
});

describe("REVIEW #234 · control positivo: el propio equipo SÍ recibe, una vez y a tiempo", () => {
  for (const n of [2, 3, 4]) {
    it(`${n}v${n}`, () => {
      const r = run({ n, redTalks: true, kill: true });
      for (const id of ids("r", n)) {
        const heard = r.bots.get(id)!.heard;
        for (const m of heard) {
          expect(teamOf(m.from)).toBe("red");
          expect(m.from).not.toBe(id); // sin eco
          expect(m.tick - m.sentTick).toBe(3);
        }
        const keys = heard.map((m) => `${m.from}|${m.sentTick}|${m.data}`);
        expect(new Set(keys).size).toBe(keys.length); // sin duplicados
        if (id !== "r1") {
          const fromR1 = heard.filter((m) => m.from === "r1").map((m) => Buffer.from(m.data, "base64").toString());
          // difusiones al equipo sí; `to` a rivales, raros y a sí mismo, no.
          expect(fromR1.some((s) => s.startsWith("RA"))).toBe(true);
          expect(fromR1.some((s) => s.startsWith("RS"))).toBe(true); // team/from falsos no desvían
          expect(fromR1.some((s) => s.startsWith("RT"))).toBe(false);
          expect(fromR1.some((s) => s === "X".repeat(32))).toBe(true); // tamaño máximo entra
        }
      }
    });
  }
});

describe("REVIEW #234 · `to` y tipos raros no rompen el motor ni abren canal", () => {
  it("to: valores no string / prototipos — ningún rival recibe y el motor no cae", () => {
    const strange: any[] = [null, 0, 1, true, {}, [], ["b1"], { toString: () => "b1" }, "__proto__", "hasOwnProperty"];
    const b = new Battle(config(2) as any);
    const bots = new Map<string, Spy>();
    for (const p of participants(2)) {
      const plan: Plan | undefined =
        p.id === "r1" ? (d) => [{ slot: "radio_a", data: b64(`Z${d}`), to: strange[d % strange.length] }] : undefined;
      const s = new Spy(p.botId, plan);
      bots.set(p.id, s);
      b.attachBot(p.id, s);
    }
    for (let i = 0; i < 120; i++) b.step();
    b.free();
    for (const id of ["b1", "b2"]) expect(bots.get(id)!.heard).toEqual([]);
  });
});

describe("REVIEW #234 · replay: ninguna observación re-simulada contiene radio rival", () => {
  it("4v4 con ataque rojo y charla azul", async () => {
    const replay = await record(
      config(4, { ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 450, scoreToWin: 999 }) }) as any,
      (b) => {
        for (const p of participants(4))
          b.attachBot(p.id, new Spy(p.botId, p.team === "red" ? redAttack(4) : blueTalk));
      },
    );
    const v = await verify(replay);
    expect(v.matches).toBe(true);
    let total = 0;
    await resimulateWithEvents(replay, () => {}, {
      onObservation: (vid, obs) => {
        for (const m of obs.radio ?? []) {
          total++;
          expect(teamOf(m.from), `${vid} ← ${m.from}`).toBe(teamOf(vid));
        }
      },
    });
    expect(total).toBeGreaterThan(0);
    // El replay global sí puede llevar los comandos de radio de ambos bandos (dato de administración).
    const radioCmds = replay.commands.filter((c: any) => Array.isArray(c.command?.radio));
    expect(new Set(radioCmds.map((c: any) => teamOf(c.vehicleId)))).toEqual(new Set(["red", "blue"]));
  });
});

describe("REVIEW #234 · traza para el diferencial main↔PR (límites y simulación)", () => {
  it("vuelca eventos privados del EMISOR, hashes y eventos públicos", () => {
    const r = run({ n: 4, redTalks: true, kill: true });
    const dump = {
      hashes: r.hashes,
      publicEvents: r.publicEvents,
      // Eventos del emisor (radio_dropped: rate_limited/too_large/queue_full): deben ser iguales en main.
      senderEvents: Object.fromEntries(ids("r", 4).map((id) => [id, r.bots.get(id)!.evs])),
    };
    if (process.env.REVIEW234_DUMP) writeFileSync(process.env.REVIEW234_DUMP, JSON.stringify(dump, null, 1));
    expect(r.hashes.length).toBeGreaterThan(5);
  });
});
