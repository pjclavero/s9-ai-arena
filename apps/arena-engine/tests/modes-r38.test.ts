/**
 * R3.8 · Modos de combate baratos: Last Man Standing (+ nivel match), Domination y
 * Juggernaut, más el registro de modos por metadatos.
 *
 * Los escenarios son GUIONIZADOS (bots de tiro fijo y vehículos anclados por física),
 * igual que los de CTF y ERR-ENG-03: cada uno termina con el marcador esperado y de
 * forma determinista. El nivel match prueba la derivación de semillas con el mecanismo
 * de fork del Rng (Definition of Done: mismo seed de match ⇒ mismas rondas).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Rng } from "../src/rng.js";
import { runMatch, swapMapSides, type MatchResult } from "../src/match.js";
import { Battle } from "../src/sim/battle.js";
import {
  DominationMode,
  JuggernautMode,
  MODE_REGISTRY,
  modeMapIncompatibilities,
  type ModeContext,
} from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { Vehicle } from "../src/sim/vehicle.js";
import { emptyArena, gunnerLoadout, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";
import type { BotAgent } from "../src/sim/battle.js";

beforeAll(async () => {
  await initPhysics();
});

/** Bot de tiro fijo: apunta SIEMPRE al mismo punto y dispara. Guion, no inteligencia. */
class FixedGunBot implements BotAgent {
  constructor(
    readonly botId: string,
    private target: { x: number; y: number },
  ) {}
  decide(obs: any) {
    return {
      forTick: obs.tick,
      move: { throttle: 0, steer: 0 },
      turret: { targetPoint: this.target },
      fire: ["turret_main"],
    };
  }
}

function pin(b: Battle, id: string, x: number, y: number): void {
  const body = b.getPhysics().get(id)!.rb;
  body.setTranslation({ x, y }, true);
  body.setLinvel({ x: 0, y: 0 }, true);
}

// ---------------------------------------------------------------------------
// Registro de modos por metadatos
// ---------------------------------------------------------------------------
describe("registro de modos por metadatos (R3.8)", () => {
  it("RECHAZA una combinación mapa/modo incompatible: domination en un mapa con 1 zona", () => {
    const map = emptyArena();
    map.zones = [{ id: "solo", position: { x: 60, y: 40 }, radiusM: 8, kind: "capture" }];
    expect(
      () =>
        new Battle({
          battleId: "dom_bad_map",
          seed: "x",
          ruleset: loadRuleset("dom_mvp@1"),
          map,
          participants: [
            { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
            { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
          ],
        }),
    ).toThrow(/incompatible/i);
  });

  it("RECHAZA juggernaut sin respawn y last_man_standing con respawn", () => {
    const mk = (rulesetId: string, overrides: any) => () =>
      new Battle({
        battleId: "bad_respawn",
        seed: "x",
        ruleset: loadRuleset(rulesetId, overrides),
        map: emptyArena(),
        participants: [
          { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
          { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
        ],
      });
    // Juggernaut degenera en LMS si nadie reaparece: el registro lo exige.
    expect(mk("jugg_mvp@1", { respawn: { enabled: false, delayTicks: 0 } })).toThrow(/respawn/i);
    // LMS con respawn no elimina a nadie jamás: también se rechaza.
    expect(mk("lms_bo3@1", { respawn: { enabled: true, delayTicks: 150 } })).toThrow(/respawn/i);
  });

  it("RECHAZA CTF en un mapa sin banderas ni bases", () => {
    expect(
      () =>
        new Battle({
          battleId: "ctf_bad_map",
          seed: "x",
          ruleset: loadRuleset("ctf_mvp@1"),
          map: emptyArena(), // sin flags ni bases
          participants: [
            { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
            { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
          ],
        }),
    ).toThrow(/incompatible/i);
  });

  it("acepta las combinaciones válidas (lista de incompatibilidades vacía)", () => {
    const dom = emptyArena();
    dom.zones = [
      { id: "alpha", position: { x: 40, y: 40 }, radiusM: 8, kind: "capture" },
      { id: "bravo", position: { x: 80, y: 40 }, radiusM: 8, kind: "capture" },
    ];
    expect(modeMapIncompatibilities(loadRuleset("dom_mvp@1"), ["red", "blue"], dom)).toEqual([]);
    expect(modeMapIncompatibilities(loadRuleset("jugg_mvp@1"), ["red", "blue"], emptyArena())).toEqual([]);
    expect(modeMapIncompatibilities(loadRuleset("lms_bo3@1"), ["red", "blue"], emptyArena())).toEqual([]);
    // Compatibilidad hacia atrás: el motor sigue admitiendo batallas de UN equipo en dm/tdm
    // (entrenamiento, goldens de física, tests de radio).
    expect(modeMapIncompatibilities(loadRuleset("tdm_mvp@1"), ["red"], emptyArena())).toEqual([]);
  });

  it("cada modo registrado declara sus metadatos completos", () => {
    for (const id of ["last_man_standing", "domination", "juggernaut"]) {
      const meta = MODE_REGISTRY[id];
      expect(meta, id).toBeDefined();
      expect(meta.minTeams).toBeGreaterThanOrEqual(2);
      expect(["required", "forbidden", "any"]).toContain(meta.respawn);
      expect(["draw", "most_score", "most_alive_then_kills"]).toContain(meta.tiebreak);
    }
  });
});

// ---------------------------------------------------------------------------
// Last Man Standing (una ronda)
// ---------------------------------------------------------------------------
function lmsBattle(seed = "lms") {
  const b = new Battle({
    battleId: "lms_2v2",
    seed,
    ruleset: loadRuleset("lms_bo3@1", { timeLimitTicks: 6000 }),
    map: emptyArena(),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: "red", spec: gunnerLoadout() },
      { id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() },
      { id: "veh_4", botId: "b4", team: "blue", spec: sandbagLoadout() },
    ],
  });
  // Guion: cada artillero rojo tiene delante, anclado, un saco de arena azul.
  b.step();
  pin(b, "veh_1", 40, 30);
  pin(b, "veh_2", 40, 50);
  pin(b, "veh_3", 70, 30);
  pin(b, "veh_4", 70, 50);
  b.attachBot("veh_1", new FixedGunBot("b1", { x: 70, y: 30 }));
  b.attachBot("veh_2", new FixedGunBot("b2", { x: 70, y: 50 }));
  b.attachBot("veh_3", new IdleBot("b3"));
  b.attachBot("veh_4", new IdleBot("b4"));
  return b;
}

describe("last man standing · eliminación (R3.8)", () => {
  it("2v2 guionizado: al caer el último azul gana el rojo con el marcador esperado", () => {
    const b = lmsBattle();
    const r1 = b.run(6000);
    b.free();

    expect(r1.winner).toBe("red");
    expect(r1.score.red).toBe(2); // dos kills: el marcador de LMS solo cuenta bajas
    expect(r1.score.blue).toBe(0);
    expect(r1.ticks).toBeLessThan(6000); // terminó por eliminación, no por tiempo

    // Determinismo: misma semilla ⇒ mismo hash de estado final, tick a tick.
    const b2 = lmsBattle();
    const r2 = b2.run(6000);
    b2.free();
    expect(r2.finalStateHash).toBe(r1.finalStateHash);
    expect(r2.ticks).toBe(r1.ticks);
  }, 60_000);

  it("al agotarse el tiempo con todos vivos e iguales, la ronda es empate", () => {
    const b = new Battle({
      battleId: "lms_draw",
      seed: "d",
      ruleset: loadRuleset("lms_bo3@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    const r = b.run(500);
    b.free();
    expect(r.winner).toBe("draw"); // mismos vivos, mismas kills: nada que desempatar
  });
});

// ---------------------------------------------------------------------------
// Nivel match: rondas con semillas derivadas por fork y cambio de lado
// ---------------------------------------------------------------------------
async function playLmsMatch(seed: string): Promise<MatchResult> {
  return runMatch(
    {
      matchId: "lms_match",
      seed,
      ruleset: loadRuleset("lms_bo3@1", { timeLimitTicks: 6000 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: gunnerLoadout() },
        { id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() },
        { id: "veh_4", botId: "b4", team: "blue", spec: sandbagLoadout() },
      ],
    },
    (b) => {
      // Mismo guion en cada ronda, con bots FRESCOS: los rojos ganan siempre.
      pin(b, "veh_1", 40, 30);
      pin(b, "veh_2", 40, 50);
      pin(b, "veh_3", 70, 30);
      pin(b, "veh_4", 70, 50);
      b.attachBot("veh_1", new FixedGunBot("b1", { x: 70, y: 30 }));
      b.attachBot("veh_2", new FixedGunBot("b2", { x: 70, y: 50 }));
      b.attachBot("veh_3", new IdleBot("b3"));
      b.attachBot("veh_4", new IdleBot("b4"));
    },
  );
}

describe("nivel match · eliminación por rondas (R3.8)", () => {
  it("bo3: el rojo gana 2 rondas seguidas y el match se corta con cambio de lado en la 2ª", async () => {
    const m = await playLmsMatch("match-seed");

    expect(m.winner).toBe("red");
    expect(m.roundWins).toEqual({ red: 2, blue: 0 });
    expect(m.rounds).toHaveLength(2); // best-of-3: la tercera ronda ya no puede cambiar nada
    expect(m.rounds[0].sidesSwapped).toBe(false);
    expect(m.rounds[1].sidesSwapped).toBe(true);
    // Semillas DERIVADAS y DISTINTAS por ronda: nada de reutilizar la del match.
    expect(m.rounds[0].seed).not.toBe(m.rounds[1].seed);
    expect(m.rounds[0].seed).not.toBe("match-seed");
  }, 120_000);

  it("test de rng.fork: mismo seed de match ⇒ mismas semillas y mismos resultados ronda a ronda", async () => {
    const a = await playLmsMatch("fork-proof");
    const b = await playLmsMatch("fork-proof");

    expect(b.rounds.map((r) => r.seed)).toEqual(a.rounds.map((r) => r.seed));
    expect(b.rounds.map((r) => r.result.winner)).toEqual(a.rounds.map((r) => r.result.winner));
    expect(b.rounds.map((r) => r.result.finalStateHash)).toEqual(a.rounds.map((r) => r.result.finalStateHash));
    expect(b.rounds.map((r) => r.result.ticks)).toEqual(a.rounds.map((r) => r.result.ticks));
    expect(b.winner).toBe(a.winner);

    // Y la derivación es EXACTAMENTE el mecanismo de fork del Rng: reproducible a mano.
    const master = new Rng("fork-proof");
    expect(a.rounds[0].seed).toBe(master.forkSeed("round-1"));
    expect(a.rounds[1].seed).toBe(master.forkSeed("round-2"));

    // Con OTRO seed de match, otras semillas de ronda (la derivación no es constante).
    const c = await playLmsMatch("otra-cosa");
    expect(c.rounds[0].seed).not.toBe(a.rounds[0].seed);
  }, 240_000);

  it("swapMapSides intercambia spawns, bases y banderas entre los dos equipos", () => {
    const map = emptyArena();
    const swapped = swapMapSides(map, ["blue", "red"]);
    expect(swapped.spawns.find((s) => s.team === "red")!.position).toEqual({ x: 100, y: 40 });
    expect(swapped.spawns.find((s) => s.team === "blue")!.position).toEqual({ x: 20, y: 40 });
    // El original queda intacto: es una copia.
    expect(map.spawns.find((s) => s.team === "red")!.position).toEqual({ x: 20, y: 40 });
  });

  it("un plan de match inválido falla cerrado", async () => {
    await expect(
      runMatch(
        {
          matchId: "bad",
          seed: "s",
          ruleset: loadRuleset("lms_bo3@1", { match: { rounds: 0, swapSides: false } }),
          map: emptyArena(),
          participants: [
            { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
            { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
          ],
        },
        () => {},
      ),
    ).rejects.toThrow(/rounds/);
  });
});

// ---------------------------------------------------------------------------
// Domination
// ---------------------------------------------------------------------------
describe("domination · zonas permanentes (R3.8)", () => {
  it("2v2 guionizado: la propiedad persiste al marcharse y el ritmo es proporcional a las zonas", () => {
    const map = emptyArena();
    map.zones = [
      { id: "alpha", position: { x: 40, y: 40 }, radiusM: 8, kind: "capture" },
      { id: "bravo", position: { x: 80, y: 40 }, radiusM: 8, kind: "capture" },
    ];
    const b = new Battle({
      battleId: "dom_2v2",
      seed: "dom",
      ruleset: loadRuleset("dom_mvp@1", { timeLimitTicks: 100000 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: sandbagLoadout() },
        { id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() },
        { id: "veh_4", botId: "b4", team: "blue", spec: sandbagLoadout() },
      ],
    });
    for (const id of ["veh_1", "veh_2", "veh_3", "veh_4"]) b.attachBot(id, new IdleBot(id));
    const mode = (b as any).mode as DominationMode;

    b.step(); // arranque
    // Nadie fuera de las zonas puntúa.
    pin(b, "veh_2", 5, 70);
    pin(b, "veh_3", 115, 70);
    pin(b, "veh_4", 115, 10);

    // FASE 1 · el explorador rojo se planta en alpha 50 ticks: captura y puntúa 1/tick.
    for (let i = 0; i < 50; i++) {
      pin(b, "veh_1", 40, 40);
      b.step();
    }
    const afterAlpha = mode.score.red;
    expect(afterAlpha).toBe(50);
    expect(b.publicEvents.filter((e) => e.kind === "zone_captured")).toHaveLength(1);

    // FASE 2 · se marcha a una esquina 40 ticks: la PROPIEDAD persiste y SIGUE puntuando.
    // (Diferencia deliberada con zone_control/ERR-ENG-03, donde la zona vacía no puntúa.)
    for (let i = 0; i < 40; i++) {
      pin(b, "veh_1", 5, 5);
      b.step();
    }
    expect(mode.score.red).toBe(afterAlpha + 40);

    // FASE 3 · se planta en bravo 40 ticks: dos zonas en propiedad ⇒ 2/tick.
    for (let i = 0; i < 40; i++) {
      pin(b, "veh_1", 80, 40);
      b.step();
    }
    expect(mode.score.red).toBe(afterAlpha + 40 + 80);
    expect(b.publicEvents.filter((e) => e.kind === "zone_captured")).toHaveLength(2);

    // FINAL · sigue en bravo hasta scoreToWin (300): gana el rojo, el azul a cero.
    const r = b.run(100000);
    expect(r.winner).toBe("red");
    expect(r.score.red).toBeGreaterThanOrEqual(300);
    expect(r.score.red).toBeLessThanOrEqual(301); // +2/tick: sin puntos fantasma
    expect(r.score.blue).toBe(0);
    b.free();
  }, 60_000);

  it("una zona DISPUTADA no cambia de dueño (semántica de captura de ERR-ENG-03)", () => {
    const map = emptyArena();
    map.zones = [
      { id: "alpha", position: { x: 40, y: 40 }, radiusM: 8, kind: "capture" },
      { id: "bravo", position: { x: 80, y: 40 }, radiusM: 8, kind: "capture" },
    ];
    const b = new Battle({
      battleId: "dom_contested",
      seed: "dc",
      ruleset: loadRuleset("dom_mvp@1", { timeLimitTicks: 100000 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    const mode = (b as any).mode as DominationMode;

    b.step();
    // Ambos DENTRO de alpha a la vez: disputada, nadie la captura ni puntúa.
    for (let i = 0; i < 30; i++) {
      pin(b, "veh_1", 38, 40);
      pin(b, "veh_2", 42, 40);
      b.step();
    }
    expect(mode.score.red ?? 0).toBe(0);
    expect(mode.score.blue ?? 0).toBe(0);
    expect(b.publicEvents.some((e) => e.kind === "zone_captured")).toBe(false);
    b.free();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Juggernaut
// ---------------------------------------------------------------------------
describe("juggernaut · vehículo marcado (R3.8)", () => {
  it("2v2 guionizado: derribar al marcado da los puntos del ruleset y decide la batalla", () => {
    const b = new Battle({
      battleId: "jugg_2v2",
      seed: "jugg",
      ruleset: loadRuleset("jugg_mvp@1", { timeLimitTicks: 9000 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() }, // primer id: será el marcado
        { id: "veh_2", botId: "b2", team: "red", spec: sandbagLoadout() },
        { id: "veh_3", botId: "b3", team: "blue", spec: gunnerLoadout() },
        { id: "veh_4", botId: "b4", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.step();
    pin(b, "veh_1", 70, 40); // el marcado, delante del cañón azul
    pin(b, "veh_2", 10, 70);
    pin(b, "veh_3", 40, 40);
    pin(b, "veh_4", 110, 70);
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.attachBot("veh_3", new FixedGunBot("b3", { x: 70, y: 40 }));
    b.attachBot("veh_4", new IdleBot("b4"));

    const r = b.run(9000);

    // La marca es determinista (primer vivo por id) y PÚBLICA desde el primer tick.
    const assigned = b.publicEvents.find((e) => e.kind === "juggernaut_assigned");
    expect(assigned).toBeDefined();
    expect(assigned.targetId).toBe("veh_1");
    expect(b.getVehicle("veh_1")!.juggernaut).toBe(false); // al morir pierde la marca

    // Derribo del marcado: +3 (jugg_mvp@1) = scoreToWin ⇒ gana el azul.
    expect(b.publicEvents.some((e) => e.kind === "juggernaut_down")).toBe(true);
    expect(r.winner).toBe("blue");
    expect(r.score.blue).toBe(3);
    expect(r.score.red).toBe(0);
    b.free();
  }, 60_000);

  it("la marca rota al equipo del verdugo y las kills del equipo del marcado puntúan 1", () => {
    // Nivel de modo, con contexto mínimo: sin física de por medio se prueba la REGLA.
    const vehicles = [
      new Vehicle("veh_a", "red", "ba", sandbagLoadout()),
      new Vehicle("veh_b", "red", "bb", sandbagLoadout()),
      new Vehicle("veh_c", "blue", "bc", sandbagLoadout()),
      new Vehicle("veh_d", "blue", "bd", sandbagLoadout()),
    ];
    const events: any[] = [];
    const ctx: ModeContext = {
      tick: 0,
      ruleset: loadRuleset("jugg_mvp@1"),
      vehicles,
      poses: new Map(),
      map: emptyArena(),
      emit: (e) => events.push(e),
    };
    const mode = new JuggernautMode(["blue", "red"]);

    mode.tick(ctx);
    expect(vehicles[0].juggernaut).toBe(true); // veh_a: primer vivo por id

    // El azul derriba al marcado: +3 y la marca pasa al primer vivo AZUL (veh_c).
    vehicles[0].alive = false;
    mode.onKill(vehicles[0], "blue", ctx);
    expect(mode.score.blue).toBe(3);
    expect(vehicles[2].juggernaut).toBe(true);
    expect(vehicles.filter((v) => v.juggernaut)).toHaveLength(1); // jamás dos marcados

    // Ahora el marcado es azul: una kill de SU equipo sobre un rojo no marcado vale 1.
    vehicles[1].alive = false;
    mode.onKill(vehicles[1], "blue", ctx);
    expect(mode.score.blue).toBe(4);

    // Una kill de un equipo SIN el marcado no puntúa nada.
    vehicles[3].alive = false;
    mode.onKill(vehicles[3], "red", ctx);
    expect(mode.score.red ?? 0).toBe(0);

    expect(events.some((e) => e.kind === "juggernaut_down")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regla de oro del motor: el estado nuevo entra en el hash y en el snapshot
// ---------------------------------------------------------------------------
describe("hash canónico y replay (R3.8)", () => {
  it("la marca de juggernaut cambia el hash de estado (como carryingFlag)", () => {
    const b = new Battle({
      battleId: "hash_jug",
      seed: "h",
      ruleset: loadRuleset("tdm_mvp@1"),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    const before = b.stateHash();
    b.getVehicle("veh_1")!.juggernaut = true;
    expect(b.stateHash()).not.toBe(before);
    b.free();
  });

  it("el snapshot público (lo que persiste el replay) incluye la marca", () => {
    const b = new Battle({
      battleId: "snap_jug",
      seed: "s",
      ruleset: loadRuleset("tdm_mvp@1"),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.step();
    const snap = b.snapshots[0];
    expect(snap.vehicles[0]).toHaveProperty("juggernaut", false);
    b.free();
  });
});
