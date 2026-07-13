/**
 * T2.5 · Modos de juego.
 *
 * La FSM de bandera (cap. 13.1) se recorre entera: at_base → carried → dropped →
 * returning → at_base, y la captura. Las transiciones ilegales se prueban por lo que
 * NO ocurre (capturar sin bandera propia en base cuando la regla lo exige).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { CaptureTheFlagMode } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { ctfArena, emptyArena, gunnerLoadout, mvpArena, sandbagLoadout, scoutLoadout } from "../src/fixtures.js";
import { FlagRunnerBot, IdleBot, SeekBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

function ctfBattle(overrides: any = {}) {
  // Arena abierta: aquí probamos la FSM de bandera, no el pathfinding (ver fixtures.ts).
  const map = ctfArena();
  const b = new Battle({
    battleId: "ctf",
    seed: "ctf-seed",
    ruleset: loadRuleset("ctf_mvp@1", { timeLimitTicks: 9000, scoreToWin: 1, ...overrides }),
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
    ],
  });
  return { b, map };
}

describe("CTF · máquina de estados de bandera (cap. 13.1)", () => {
  it("recorre el ciclo completo: at_base → carried → captured", () => {
    const { b, map } = ctfBattle();
    const blueFlag = map.flags.find((f) => f.team === "blue")!.position;
    const redBase = map.bases.find((b2) => b2.team === "red")!.position;

    // El corredor rojo va a por la bandera azul y la trae a casa.
    b.attachBot("veh_1", new FlagRunnerBot("b1", blueFlag, redBase));
    b.attachBot("veh_2", new IdleBot("b2"));

    const mode = (b as any).mode as CaptureTheFlagMode;
    expect(mode.flags.get("blue")!.state).toBe("at_base");

    const result = b.run(9000);

    expect(result.winner).toBe("red");
    expect(result.score.red).toBe(1);
    // Tras capturar, la bandera vuelve a estar en juego.
    expect(mode.flags.get("blue")!.state).toBe("at_base");
    b.free();
  }, 60_000);

  it("emite los eventos de la FSM en orden: flag_taken antes que flag_captured", () => {
    const { b, map } = ctfBattle();
    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.run(9000);

    const kinds = b.publicEvents.map((e) => e.kind);
    const taken = kinds.indexOf("flag_taken");
    const captured = kinds.indexOf("flag_captured");

    expect(taken).toBeGreaterThanOrEqual(0);
    expect(captured).toBeGreaterThan(taken); // el orden importa
    b.free();
  }, 60_000);

  it("si el portador muere, la bandera CAE (no vuelve a base ni desaparece)", () => {
    const { b, map } = ctfBattle();
    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));

    const mode = (b as any).mode as CaptureTheFlagMode;

    // Corremos hasta que la lleve encima.
    for (let i = 0; i < 9000 && mode.flags.get("blue")!.state !== "carried"; i++) b.step();
    expect(mode.flags.get("blue")!.state).toBe("carried");

    const posBefore = { ...mode.flags.get("blue")!.position };

    // Lo matamos a mitad de camino.
    const carrier = b.getVehicle("veh_1")!;
    carrier.hullHp = 0;
    carrier.alive = false;
    b.step();

    const flag = mode.flags.get("blue")!;
    expect(flag.state).toBe("dropped");
    expect(flag.carrierId).toBeNull();
    // Cae DONDE ESTABA, no en su base: es lo que hace interesante el juego de posición.
    expect(Math.hypot(flag.position.x - posBefore.x, flag.position.y - posBefore.y)).toBeLessThan(2);
    expect(b.publicEvents.some((e) => e.kind === "flag_dropped")).toBe(true);
    b.free();
  }, 60_000);

  it("una bandera caída vuelve sola a su base tras flagReturnTicks", () => {
    const { b, map } = ctfBattle({ ctf: { requireOwnFlagAtBase: true, flagReturnTicks: 30 } });
    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));

    const mode = (b as any).mode as CaptureTheFlagMode;
    for (let i = 0; i < 9000 && mode.flags.get("blue")!.state !== "carried"; i++) b.step();

    const carrier = b.getVehicle("veh_1")!;
    carrier.hullHp = 0;
    carrier.alive = false;
    b.step();
    expect(mode.flags.get("blue")!.state).toBe("dropped");

    // Pasado el tiempo de retorno, vuelve sola.
    for (let i = 0; i < 40; i++) b.step();

    const flag = mode.flags.get("blue")!;
    expect(flag.state).toBe("at_base");
    expect(flag.position).toEqual(flag.basePosition);
    expect(b.publicEvents.some((e) => e.kind === "flag_returned")).toBe(true);
    b.free();
  }, 60_000);

  it("TRANSICIÓN ILEGAL: no se puede capturar sin la bandera propia en base (regla activa)", () => {
    const map = ctfArena();
    const b = new Battle({
      battleId: "ctf_illegal",
      seed: "x",
      ruleset: loadRuleset("ctf_mvp@1", {
        scoreToWin: 1,
        timeLimitTicks: 3000,
        ctf: { requireOwnFlagAtBase: true, flagReturnTicks: 99999 },
      }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });

    const mode = (b as any).mode as CaptureTheFlagMode;
    // La bandera ROJA está fuera de su base (la tiene el azul, digamos): estado dropped.
    mode.flags.get("red")!.state = "dropped";
    mode.flags.get("red")!.position = { x: 60, y: 70 };

    // El rojo lleva la bandera azul a su base... pero no debería poder capturar.
    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));

    const result = b.run(3000);

    // Llega a su base con la bandera, pero NO puntúa: la regla lo impide.
    expect(result.score.red ?? 0).toBe(0);
    expect(b.publicEvents.some((e) => e.kind === "flag_captured")).toBe(false);
    b.free();
  }, 60_000);

  it("con la regla DESACTIVADA, esa misma situación SÍ permite capturar", () => {
    // Prueba de que la regla es realmente configurable y no está cableada.
    const map = ctfArena();
    const b = new Battle({
      battleId: "ctf_legal",
      seed: "x",
      ruleset: loadRuleset("ctf_mvp@1", {
        scoreToWin: 1,
        timeLimitTicks: 9000,
        ctf: { requireOwnFlagAtBase: false, flagReturnTicks: 99999 },
      }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });

    const mode = (b as any).mode as CaptureTheFlagMode;
    mode.flags.get("red")!.state = "dropped";
    mode.flags.get("red")!.position = { x: 60, y: 70 };

    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));

    const result = b.run(9000);
    expect(result.score.red).toBe(1);
    b.free();
  }, 60_000);

  it("la posición de una bandera transportada NO es pública (hay que verla)", () => {
    const { b, map } = ctfBattle();
    b.attachBot("veh_1", new FlagRunnerBot(
      "b1",
      map.flags.find((f) => f.team === "blue")!.position,
      map.bases.find((x) => x.team === "red")!.position,
    ));
    b.attachBot("veh_2", new IdleBot("b2"));

    const mode = (b as any).mode as CaptureTheFlagMode;
    for (let i = 0; i < 9000 && mode.flags.get("blue")!.state !== "carried"; i++) b.step();

    const objectives = mode.objectives();
    const blue = objectives.find((o: any) => o.team === "blue");
    expect(blue.state).toBe("carried");
    expect(blue.position).toBeUndefined(); // ¡nada de posición gratis!

    const red = objectives.find((o: any) => o.team === "red");
    expect(red.state).toBe("at_base");
    expect(red.position).toBeDefined(); // una bandera en su base sí es pública
    b.free();
  }, 60_000);
});

describe("fuego amigo (configurable por ruleset)", () => {
  function friendlyFireBattle(friendlyFire: boolean) {
    const b = new Battle({
      battleId: "ff",
      seed: "ff",
      ruleset: loadRuleset("tdm_mvp@1", { friendlyFire, timeLimitTicks: 400, respawn: { enabled: false, delayTicks: 0 } }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: sandbagLoadout() }, // ¡compañero!
        // Un rival lejano y pasivo. Sin él, con respawn desactivado y todos los vivos
        // en un mismo equipo, la regla de "último equipo en pie" daría la batalla por
        // ganada en el tick 0 y no llegaríamos a disparar.
        { id: "veh_3", botId: "b3", team: "blue", spec: sandbagLoadout() },
      ],
    });

    b.step();
    const phys = b.getPhysics();
    phys.get("veh_1")!.rb.setTranslation({ x: 40, y: 40 }, true);
    phys.get("veh_2")!.rb.setTranslation({ x: 55, y: 40 }, true);

    // El artillero dispara a bocajarro a su propio compañero.
    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({
        forTick: obs.tick,
        move: { throttle: 0, steer: 0 },
        turret: { targetPoint: { x: 55, y: 40 } },
        fire: ["turret_main"],
      }),
    });
    b.attachBot("veh_2", new IdleBot("b2"));
    b.attachBot("veh_3", new IdleBot("b3"));

    for (let i = 0; i < 200; i++) b.step();
    const hp = b.getVehicle("veh_2")!.hullHp;
    b.free();
    return hp;
  }

  it("DESACTIVADO: el proyectil atraviesa al aliado sin dañarlo", () => {
    expect(friendlyFireBattle(false)).toBe(180); // intacto
  });

  it("ACTIVADO: el mismo escenario SÍ hiere al aliado", () => {
    expect(friendlyFireBattle(true)).toBeLessThan(180);
  });
});

describe("zone control", () => {
  it("un equipo dentro de la zona puntúa de forma continua", () => {
    const map = emptyArena();
    map.zones = [{ id: "z1", position: { x: 60, y: 40 }, radiusM: 8, kind: "capture" }];

    const b = new Battle({
      battleId: "zc",
      seed: "z",
      ruleset: loadRuleset("zc_mvp@1", { scoreToWin: 50, timeLimitTicks: 3000 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });

    b.attachBot("veh_1", new SeekBot("b1", { x: 60, y: 40 })); // va a la zona
    b.attachBot("veh_2", new IdleBot("b2")); // se queda en su esquina

    const result = b.run(3000);
    expect(result.winner).toBe("red");
    expect(result.score.red).toBeGreaterThanOrEqual(50);
    expect(result.score.blue).toBe(0);
    expect(b.publicEvents.some((e) => e.kind === "zone_captured")).toBe(true);
    b.free();
  }, 60_000);
});

describe("deathmatch y límite de tiempo", () => {
  it("una batalla sin acción termina en empate al agotarse el tiempo", () => {
    const b = new Battle({
      battleId: "dm",
      seed: "d",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: sandbagLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));

    const r = b.run(500);
    expect(r.winner).toBe("draw");
    expect(r.ticks).toBe(100);
    b.free();
  });
});
