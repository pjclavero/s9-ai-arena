/**
 * R13.0 · REGRESSION LOCK — radio: sin fuga entre batallas ni entre vehículos, y contador
 * de rate por vehículo acotado que se reinicia por segundo (ERR-ENG-06).
 *
 * Estado del código: el rate-limit de radio usa `v.radioSentThisSecond`/`v.radioSecond`
 * (contador O(1) por vehículo que se reinicia al cambiar de segundo), NO un `Map id:segundo`
 * global que se acumule durante toda la batalla. Estos candados fijan la conducta correcta:
 *   - una batalla nueva no ve mensajes de otra (sin estado global compartido);
 *   - un mensaje dirigido `to` solo llega a su destinatario; el emisor no se oye a sí mismo;
 *   - un mensaje sin `to` es broadcast (lo oyen los demás, no el emisor);
 *   - el contador por vehículo se reinicia cada segundo (se puede volver a emitir) y queda acotado;
 *   - el hash de estado es idéntico en runs repetidos (determinismo intacto).
 *
 * Rápido, determinista, sin Docker/red/reloj.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { MODULES, emptyArena, scoutLoadout } from "../src/fixtures.js";
import type { BotAgent } from "../src/sim/battle.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";

beforeAll(async () => {
  await initPhysics();
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const RADIO_RATE = MODULES.radio.maxMessagesPerSecond ?? 2;

/** Explorador con radio corta añadida (slot radio_a). */
function radioSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [...s.modules, { ...MODULES.radio }];
  return s;
}

type Received = { from: string; data: string; sentTick: number };

/** Registra la radio recibida en cada decisión y, opcionalmente, emite según un plan. */
class RadioBot implements BotAgent {
  received: Received[] = [];
  private d = 0;
  constructor(
    readonly botId: string,
    private plan?: (decisionIndex: number) => { data: string; to?: string }[] | undefined,
  ) {}
  decide(obs: any) {
    if (Array.isArray(obs.radio)) {
      for (const m of obs.radio) this.received.push({ from: m.from, data: m.data, sentTick: m.sentTick });
    }
    const out: any = { forTick: obs.tick };
    const sends = this.plan?.(this.d);
    if (sends && sends.length) {
      out.radio = sends.map((s) => ({ slot: "radio_a", data: s.data, ...(s.to ? { to: s.to } : {}) }));
    }
    this.d++;
    return out;
  }
}

function makeBattle(seed: string, bots: Record<string, RadioBot>) {
  const b = new Battle({
    battleId: "radio",
    seed,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000, scoreToWin: 999 }),
    map: emptyArena(120, 80),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: radioSpec() },
      { id: "veh_2", botId: "b2", team: "red", spec: radioSpec() },
      { id: "veh_3", botId: "b3", team: "blue", spec: radioSpec() },
    ],
  });
  for (const [id, bot] of Object.entries(bots)) b.attachBot(id, bot);
  return b;
}

const DIRECTED = b64("to-veh2");
const BROADCAST = b64("broadcast");

describe("R13.0 · radio dirigida vs broadcast, sin auto-recepción", () => {
  it("un mensaje dirigido solo llega al destinatario; broadcast llega a los demás; el emisor no se oye", () => {
    // veh_1 envía dirigido a veh_2 en la 1ª decisión y broadcast en la 4ª.
    const sender = new RadioBot("b1", (d) => {
      if (d === 0) return [{ data: DIRECTED, to: "veh_2" }];
      if (d === 3) return [{ data: BROADCAST }];
      return undefined;
    });
    const v2 = new RadioBot("b2");
    const v3 = new RadioBot("b3");
    const b = makeBattle("radio-a", { veh_1: sender, veh_2: v2, veh_3: v3 });
    for (let i = 0; i < 21; i++) b.step();
    b.free();

    // Dirigido: solo veh_2.
    expect(v2.received.some((m) => m.from === "veh_1" && m.data === DIRECTED)).toBe(true);
    expect(v3.received.some((m) => m.data === DIRECTED)).toBe(false);
    // Broadcast: veh_2 y veh_3 (incluso el enemigo lo intercepta: no hay filtro de equipo).
    expect(v2.received.some((m) => m.data === BROADCAST)).toBe(true);
    expect(v3.received.some((m) => m.data === BROADCAST)).toBe(true);
    // El emisor jamás se oye a sí mismo.
    expect(sender.received).toHaveLength(0);
  });
});

describe("R13.0 · contador de rate por vehículo se reinicia por segundo (ERR-ENG-06)", () => {
  it("emitir cada decisión respeta ≤rate por segundo y se REANUDA en el segundo siguiente", () => {
    const sender = new RadioBot("b1", () => [{ data: b64("spam") }]); // intenta emitir siempre
    const v2 = new RadioBot("b2");
    const b = makeBattle("radio-rate", { veh_1: sender, veh_2: v2 });
    // ~2,2 s (66 ticks) para cruzar el límite de segundo al menos una vez.
    for (let i = 0; i < 66; i++) b.step();
    const counterAtEnd = b.getVehicle("veh_1")!.radioSentThisSecond;
    b.free();

    // Agrupa lo RECIBIDO por segundo del sentTick.
    const perSecond = new Map<number, number>();
    for (const m of v2.received) {
      const s = Math.floor(m.sentTick / 30);
      perSecond.set(s, (perSecond.get(s) ?? 0) + 1);
    }
    // Al menos dos segundos distintos con entregas ⇒ el contador se reinició.
    expect(perSecond.size).toBeGreaterThanOrEqual(2);
    // Ningún segundo excede el rate del módulo.
    for (const [, count] of perSecond) expect(count).toBeLessThanOrEqual(RADIO_RATE);
    // Cada segundo activo tuvo al menos una entrega (emisión reanudada tras el reset).
    for (const [, count] of perSecond) expect(count).toBeGreaterThanOrEqual(1);
    // El contador por vehículo queda ACOTADO (no crece con la duración): ≤ rate.
    expect(counterAtEnd).toBeLessThanOrEqual(RADIO_RATE);
  });
});

describe("R13.0 · sin fuga de radio entre batallas independientes", () => {
  it("una batalla nueva no recibe mensajes de otra anterior", () => {
    // Batalla A: tráfico de radio real.
    const aSender = new RadioBot("b1", (d) => (d < 5 ? [{ data: b64("secreto-A") }] : undefined));
    const a2 = new RadioBot("b2");
    const a3 = new RadioBot("b3");
    const a = makeBattle("battle-A", { veh_1: aSender, veh_2: a2, veh_3: a3 });
    for (let i = 0; i < 30; i++) a.step();
    a.free();
    expect(a2.received.length + a3.received.length).toBeGreaterThan(0); // hubo tráfico real en A

    // Batalla B: nadie emite. No debe ver NADA de A.
    const b1 = new RadioBot("b1");
    const b2 = new RadioBot("b2");
    const b3 = new RadioBot("b3");
    const b = makeBattle("battle-B", { veh_1: b1, veh_2: b2, veh_3: b3 });
    for (let i = 0; i < 30; i++) b.step();
    b.free();
    expect(b1.received).toHaveLength(0);
    expect(b2.received).toHaveLength(0);
    expect(b3.received).toHaveLength(0);
  });
});

describe("R13.0 · el manejo de radio es determinista", () => {
  it("dos batallas idénticas con radio producen los mismos hashes de estado", () => {
    const run = (seed: string) => {
      const s = new RadioBot("b1", () => [{ data: b64("x") }]);
      const b = makeBattle(seed, {
        veh_1: s,
        veh_2: new RadioBot("b2"),
        veh_3: new RadioBot("b3"),
      });
      // El hash se registra cada 30 ticks; 180 ticks ⇒ ~7 muestras (> 5).
      for (let i = 0; i < 180; i++) b.step();
      const hashes = [...b.stateHashes];
      b.free();
      return hashes;
    };
    const h1 = run("det-radio");
    const h2 = run("det-radio");
    expect(h1.length).toBeGreaterThan(5);
    expect(h1).toEqual(h2);
  });
});
