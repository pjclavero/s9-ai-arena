/**
 * RADIO · Aislamiento de la radio por equipo (RADIO_SCOPE=TEAM).
 *
 * Contrato (`packages/protocol/schemas/command.schema.json`: «Mensajes de equipo»,
 * `to` ausente = «difusión al equipo»): un mensaje de radio sólo lo reciben los
 * vehículos del MISMO equipo que el emisor, según el equipo del estado de batalla
 * (`Vehicle.team`, fijado al crear la batalla). El rival no recibe nada: ni el
 * payload, ni el remitente, ni el tick de envío, ni una entrada vacía en `obs.radio`.
 *
 * El test principal (sección 14 del encargo) estaba ROJO en main e3bf2fa: el filtro
 * de entrega de `buildObservation` no comparaba el equipo y la difusión llegaba a todos.
 *
 * Rápido, determinista, sin Docker, red ni reloj.
 */
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
const SECRET_A = b64("RADIO_SECRET_A");
const SECRET_B = b64("RADIO_SECRET_B");

type Send = { data: string; to?: string; team?: string };
type Plan = (decision: number, obs: any) => Send[] | undefined;

/** Explorador con la radio corta del catálogo en `radio_a`. */
function radioSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [...s.modules.filter((m) => m.slot !== "radio_a"), { ...MODULES.radio }];
  return s;
}

/**
 * Bot que no se mueve ni dispara: registra TODA observación (radio y JSON entero)
 * y emite según su plan. Así ninguna muerte ni movimiento ajeno al test interfiere.
 */
class Listener implements BotAgent {
  heard: { tick: number; from: string; data: string; sentTick: number }[] = [];
  /** Cada observación serializada: para buscar el payload rival en CUALQUIER campo. */
  raw: string[] = [];
  /** Cada clave `radio` vista (aunque viniera vacía). */
  radioKeys = 0;
  events: any[] = [];
  private d = 0;
  constructor(
    readonly botId: string,
    private plan?: Plan,
  ) {}
  decide(obs: any) {
    this.raw.push(JSON.stringify(obs));
    if ("radio" in obs) this.radioKeys++;
    for (const m of obs.radio ?? []) this.heard.push({ tick: obs.tick, from: m.from, data: m.data, sentTick: m.sentTick });
    const out: any = { forTick: obs.tick };
    const sends = this.plan?.(this.d, obs);
    if (sends && sends.length) {
      out.radio = sends.map((s) => ({
        slot: "radio_a",
        data: s.data,
        ...(s.to ? { to: s.to } : {}),
        // Team spoofing: un campo `team` en el comando NO debe elegir destinatarios.
        ...(s.team ? { team: s.team } : {}),
      }));
    }
    this.d++;
    return out;
  }
  onEvent(e: any) {
    this.events.push(e);
  }
}

/** Arena con un spawn por vehículo, rojos a la izquierda y azules a la derecha. */
function arena(n: number): ArenaMap {
  const m = emptyArena(160, 100);
  m.mapId = `radio-${n}v${n}`;
  const ys = Array.from({ length: n }, (_, i) => 15 + i * 20);
  m.spawns = [
    ...ys.map((y) => ({ team: "red", position: { x: 30, y }, heading: 0 })),
    ...ys.map((y) => ({ team: "blue", position: { x: 130, y }, heading: Math.PI })),
  ];
  return m;
}

const ids = (team: "r" | "b", n: number) => Array.from({ length: n }, (_, i) => `${team}${i + 1}`);

interface Setup {
  n: number;
  plans?: Record<string, Plan>;
  seed?: string;
  timeLimitTicks?: number;
  rulesetId?: string;
  recordReplay?: boolean;
}

function participantsFor(n: number) {
  return [
    ...ids("r", n).map((id) => ({ id, botId: `bot_${id}`, team: "red", spec: radioSpec() })),
    ...ids("b", n).map((id) => ({ id, botId: `bot_${id}`, team: "blue", spec: radioSpec() })),
  ];
}

function configFor(s: Setup) {
  return {
    battleId: `radio-${s.n}v${s.n}`,
    seed: s.seed ?? `radio-${s.n}`,
    ruleset: loadRuleset(s.rulesetId ?? "tdm_mvp@1", { timeLimitTicks: s.timeLimitTicks ?? 3000, scoreToWin: 999 }),
    map: arena(s.n),
    participants: participantsFor(s.n),
    ...(s.recordReplay ? { recordReplay: true } : {}),
  };
}

function setup(s: Setup) {
  const b = new Battle(configFor(s));
  const bots = new Map<string, Listener>();
  for (const p of participantsFor(s.n)) {
    const bot = new Listener(p.botId, s.plans?.[p.id]);
    bots.set(p.id, bot);
    b.attachBot(p.id, bot);
  }
  return { b, bots };
}

const teamOf = (id: string) => (id.startsWith("r") ? "red" : "blue");

/**
 * Invariante de aislamiento sobre TODO lo que cada bot ha observado: ninguna entrada
 * de radio cuyo emisor sea rival, y ningún payload rival en ningún campo de la observación.
 */
function expectIsolated(bots: Map<string, Listener>, payloadsByTeam: Record<string, string[]>) {
  for (const [id, bot] of bots) {
    const mine = teamOf(id);
    for (const m of bot.heard) {
      expect(teamOf(m.from), `${id} oyó a ${m.from} (rival) en t=${m.tick}`).toBe(mine);
      expect(m.from, `${id} se oyó a sí mismo`).not.toBe(id);
    }
    const rivalPayloads = payloadsByTeam[mine === "red" ? "blue" : "red"] ?? [];
    for (const raw of bot.raw) for (const p of rivalPayloads) expect(raw.includes(p), `${id} ve el payload rival ${p}`).toBe(false);
  }
}

// ======================================================================= §14
describe("RADIO §14 · test principal: dos bandos, dos secretos en el mismo tick", () => {
  it("A2 oye RADIO_SECRET_A y no RADIO_SECRET_B; B2 oye B y no A; los emisores no se oyen", () => {
    const once = (data: string): Plan => (d) => (d === 1 ? [{ data }] : undefined);
    const { b, bots } = setup({ n: 2, plans: { r1: once(SECRET_A), b1: once(SECRET_B) } });
    for (let i = 0; i < 30; i++) b.step();
    b.free();

    const A1 = bots.get("r1")!;
    const A2 = bots.get("r2")!;
    const B1 = bots.get("b1")!;
    const B2 = bots.get("b2")!;

    // Recibe el compañero, exactamente una vez y del emisor correcto.
    expect(A2.heard.filter((m) => m.data === SECRET_A).map((m) => m.from)).toEqual(["r1"]);
    expect(B2.heard.filter((m) => m.data === SECRET_B).map((m) => m.from)).toEqual(["b1"]);
    // El rival no recibe nada del otro bando.
    expect(A2.heard.some((m) => m.data === SECRET_B)).toBe(false);
    expect(B2.heard.some((m) => m.data === SECRET_A)).toBe(false);
    // Eco definido: el emisor no se oye a sí mismo; tampoco oye al rival.
    expect(A1.heard).toEqual([]);
    expect(B1.heard).toEqual([]);
    // Ni rastro del payload rival en ningún campo de la observación.
    expectIsolated(bots, { red: [SECRET_A], blue: [SECRET_B] });
  });
});

// ======================================================================= §16
describe("RADIO §16 · matriz 1v1, 2v2, 3v3 y 4v4", () => {
  for (const n of [1, 2, 3, 4]) {
    describe(`${n}v${n}`, () => {
      it("un emisor: sólo sus compañeros lo reciben (1v1: nadie)", () => {
        const { b, bots } = setup({ n, plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A }] : undefined) } });
        for (let i = 0; i < 30; i++) b.step();
        b.free();
        const receivers = [...bots].filter(([, bot]) => bot.heard.some((m) => m.data === SECRET_A)).map(([id]) => id);
        expect(receivers.sort()).toEqual(ids("r", n).filter((id) => id !== "r1"));
        // El rival no recibe NI SIQUIERA una clave `radio` vacía.
        for (const id of ids("b", n)) expect(bots.get(id)!.radioKeys, id).toBe(0);
        expectIsolated(bots, { red: [SECRET_A] });
      });

      it("emisores simultáneos de los dos bandos, varios mensajes por bando", () => {
        const msgsA = [b64("A-0"), b64("A-1"), b64("A-2"), b64("A-3")];
        const msgsB = [b64("B-0"), b64("B-1"), b64("B-2"), b64("B-3")];
        const plans: Record<string, Plan> = {};
        // Cada decisión par, todos los vehículos de ambos bandos emiten en el MISMO tick.
        for (const [k, id] of ids("r", n).entries()) plans[id] = (d) => (d % 2 === 0 && d < 8 ? [{ data: msgsA[(d / 2 + k) % 4] }] : undefined);
        for (const [k, id] of ids("b", n).entries()) plans[id] = (d) => (d % 2 === 0 && d < 8 ? [{ data: msgsB[(d / 2 + k) % 4] }] : undefined);
        const { b, bots } = setup({ n, plans });
        for (let i = 0; i < 60; i++) b.step();
        b.free();
        expectIsolated(bots, { red: msgsA, blue: msgsB });
        // Con compañeros, cada uno oye a TODOS sus compañeros (4 emisiones cada uno) y a nadie más.
        for (const [id, bot] of bots) {
          const mates = ids(id.startsWith("r") ? "r" : "b", n).filter((x) => x !== id);
          expect([...new Set(bot.heard.map((m) => m.from))].sort(), id).toEqual(mates);
          expect(bot.heard.length, id).toBe(mates.length * 4);
        }
      });

      it("mensaje vacío y mensaje de tamaño máximo (32 bytes): mismo aislamiento", () => {
        const empty = "";
        const max = Buffer.alloc(32, 0x41).toString("base64");
        const maxB = Buffer.alloc(32, 0x42).toString("base64");
        const { b, bots } = setup({
          n,
          plans: {
            r1: (d) => (d === 1 ? [{ data: empty }, { data: max }] : undefined),
            b1: (d) => (d === 1 ? [{ data: maxB }] : undefined),
          },
        });
        for (let i = 0; i < 30; i++) b.step();
        b.free();
        for (const id of ids("r", n).filter((x) => x !== "r1")) {
          expect(bots.get(id)!.heard.map((m) => m.data), id).toEqual([empty, max]);
        }
        for (const id of ids("b", n)) {
          expect(bots.get(id)!.heard.every((m) => m.from === "b1"), id).toBe(true);
          expect(bots.get(id)!.heard.some((m) => m.data === max || m.data === empty), id).toBe(false);
        }
        expectIsolated(bots, { red: [max], blue: [maxB] });
      });

      it("muerte, respawn e inmediatamente después: el rival nunca recibe; sin duplicados ni mensajes viejos", () => {
        // r1 habla en TODAS sus decisiones (rate-limit incluido); b1 también.
        const say = (prefix: string): Plan => (d) => [{ data: b64(`${prefix}${d}`) }];
        const { b, bots } = setup({ n, plans: { r1: say("A"), b1: say("B") } });
        const victim = b.getVehicle("b1")!; // el emisor azul y, en 1v1, el único receptor azul
        const deadAt: number[] = [];
        for (let i = 0; i < 240; i++) {
          if (i === 30 || i === 150) {
            // Muerte forzada (como la de una zona de daño): el modo programará el respawn.
            victim.hullHp = 0;
            victim.alive = false;
            deadAt.push(b.tick);
          }
          b.step();
          expect(victim.team).toBe("blue"); // el respawn no cambia el equipo
        }
        b.free();
        expect(bots.get("b1")!.events.filter((e) => e.kind === "respawned").length).toBeGreaterThanOrEqual(1);
        const allA = Array.from({ length: 100 }, (_, d) => b64(`A${d}`));
        const allB = Array.from({ length: 100 }, (_, d) => b64(`B${d}`));
        expectIsolated(bots, { red: allA, blue: allB });
        // Sin duplicados: cada (emisor, payload) llega como mucho una vez a cada receptor.
        for (const [id, bot] of bots) {
          const keys = bot.heard.map((m) => `${m.from}|${m.data}`);
          expect(new Set(keys).size, id).toBe(keys.length);
          // Nada llega antes del retardo ni en un tick posterior al previsto (1 decisión = 3 ticks).
          for (const m of bot.heard) expect(m.tick - m.sentTick, id).toBe(3);
        }
        // Con compañeros, el compañero sigue oyendo al emisor (vivo, muerto o recién reaparecido).
        if (n > 1) expect(bots.get("b2")!.heard.some((m) => m.from === "b1")).toBe(true);
      });

      it("fin de batalla: nada rival en ninguna observación hasta el último tick", () => {
        const say = (prefix: string): Plan => (d) => [{ data: b64(`${prefix}${d}`) }];
        const { b, bots } = setup({ n, plans: { r1: say("A"), b1: say("B") }, timeLimitTicks: 60 });
        const res = b.run();
        b.free();
        expect(res.ticks).toBeGreaterThan(0);
        const allA = Array.from({ length: 40 }, (_, d) => b64(`A${d}`));
        const allB = Array.from({ length: 40 }, (_, d) => b64(`B${d}`));
        expectIsolated(bots, { red: allA, blue: allB });
      });
    });
  }
});

// ======================================================================= §17
describe("RADIO §17 · spoofing", () => {
  it("receiver spoofing: `to` a un rival no le entrega nada (ni a nadie)", () => {
    const { b, bots } = setup({ n: 2, plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A, to: "b1" }] : undefined) } });
    for (let i = 0; i < 30; i++) b.step();
    b.free();
    for (const [id, bot] of bots) expect(bot.heard, id).toEqual([]);
  });

  it("`to` a un compañero: sólo ese compañero lo recibe", () => {
    const { b, bots } = setup({ n: 3, plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A, to: "r3" }] : undefined) } });
    for (let i = 0; i < 30; i++) b.step();
    b.free();
    const receivers = [...bots].filter(([, bot]) => bot.heard.length > 0).map(([id]) => id);
    expect(receivers).toEqual(["r3"]);
  });

  it("`to` a un id inexistente o a sí mismo: nadie lo recibe", () => {
    const { b, bots } = setup({
      n: 2,
      plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A, to: "nadie" }] : d === 2 ? [{ data: SECRET_A, to: "r1" }] : undefined) },
    });
    for (let i = 0; i < 30; i++) b.step();
    b.free();
    for (const [id, bot] of bots) expect(bot.heard, id).toEqual([]);
  });

  it("team spoofing: un `team` rival en el comando no cambia los destinatarios", () => {
    const { b, bots } = setup({ n: 2, plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A, team: "blue" }] : undefined) } });
    for (let i = 0; i < 30; i++) b.step();
    b.free();
    expect(bots.get("r2")!.heard.map((m) => m.data)).toEqual([SECRET_A]);
    for (const id of ["b1", "b2"]) expect(bots.get(id)!.heard, id).toEqual([]);
  });

  it("observationFor (canal del servidor de protocolo) aplica el mismo aislamiento", () => {
    const { b } = setup({ n: 2, plans: { r1: (d) => (d === 1 ? [{ data: SECRET_A }] : undefined) } });
    let mate = false;
    for (let i = 0; i < 30; i++) {
      b.step();
      for (const id of ["b1", "b2"]) expect(JSON.stringify(b.observationFor(id)).includes(SECRET_A), id).toBe(false);
      if ((b.observationFor("r2").radio ?? []).some((m: any) => m.data === SECRET_A)) mate = true;
    }
    b.free();
    expect(mate).toBe(true);
  });
});

// ======================================================================= §16 límites
describe("RADIO §16 · el filtrado no toca los límites", () => {
  it("el rate-limit sigue contando por emisor aunque no haya receptores (1v1)", () => {
    const { b, bots } = setup({ n: 1, plans: { r1: () => [{ data: b64("x") }, { data: b64("y") }] } });
    for (let i = 0; i < 60; i++) b.step();
    b.free();
    const dropped = bots.get("r1")!.events.filter((e) => e.kind === "radio_dropped" && e.reason === "rate_limited");
    expect(dropped.length).toBeGreaterThan(0);
    expect(bots.get("b1")!.heard).toEqual([]);
  });
});

// ======================================================================= §10 replay
describe("RADIO §10 · replay: la re-simulación no reconstruye observaciones con radio rival", () => {
  it("record → verify casa, y las observaciones re-simuladas están aisladas", async () => {
    const say = (prefix: string): Plan => (d) => (d % 2 === 0 ? [{ data: b64(`${prefix}${d}`) }] : undefined);
    const cfg = configFor({ n: 2, seed: "radio-replay", timeLimitTicks: 300, recordReplay: true });
    const replay = await record(cfg, (b) => {
      for (const p of cfg.participants) {
        b.attachBot(p.id, new Listener(p.botId, p.id === "r1" ? say("A") : p.id === "b1" ? say("B") : undefined));
      }
    });
    // El replay global guarda los comandos de ambos bandos (dato de administración/replay).
    expect(replay.commands.some((c) => c.vehicleId === "r1" && c.command?.radio)).toBe(true);
    expect(replay.commands.some((c) => c.vehicleId === "b1" && c.command?.radio)).toBe(true);

    const v = await verify(replay);
    expect(v.matches).toBe(true);
    expect(v.divergedAtTick).toBeNull();

    const seen: { vehicleId: string; from: string }[] = [];
    await resimulateWithEvents(replay, () => {}, {
      onObservation: (vehicleId, obs) => {
        for (const m of obs.radio ?? []) seen.push({ vehicleId, from: m.from });
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(teamOf(s.from), `${s.vehicleId} ← ${s.from}`).toBe(teamOf(s.vehicleId));
  });
});

// ======================================================================= §13
describe("RADIO §13 · determinismo con radio", () => {
  it("dos ejecuciones idénticas 4v4 con radio cruzada dan los mismos hashes y la misma radio oída", () => {
    const run = () => {
      const say = (prefix: string): Plan => (d) => [{ data: b64(`${prefix}${d % 10}`) }];
      const { b, bots } = setup({ n: 4, seed: "radio-det", plans: { r1: say("A"), r2: say("C"), b1: say("B"), b3: say("D") } });
      for (let i = 0; i < 180; i++) b.step();
      const hashes = [...b.stateHashes];
      b.free();
      const heard = [...bots].map(([id, bot]) => [id, bot.heard] as const);
      return { hashes, heard };
    };
    const r1 = run();
    const r2 = run();
    expect(r1.hashes.length).toBeGreaterThan(5);
    expect(r1.hashes).toEqual(r2.hashes);
    expect(r1.heard).toEqual(r2.heard);
  });
});
