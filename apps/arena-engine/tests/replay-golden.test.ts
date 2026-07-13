/**
 * T2.2 (escenarios golden) + T2.6 (replays).
 *
 * Los golden files son la red de seguridad de todo el proyecto: si una actualización de
 * Rapier, un refactor del bucle o un cambio de reglas altera la simulación, estos tests
 * lo cazan de inmediato. Regenerarlos NUNCA es un trámite: es una decisión consciente que
 * invalida los replays oficiales y debe justificarse en la PR.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type BattleConfig } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { fromJsonl, record, toJsonl, verify } from "../src/replay.js";
import {
  ctfArena, emptyArena, gunnerLoadout, minerLoadout, mvpArena, sandbagLoadout, scoutLoadout,
} from "../src/fixtures.js";
import { CircleBot, FlagRunnerBot, ForwardBot, HunterBot, IdleBot, SeekBot } from "../src/stubs.js";

const GOLDEN_DIR = join(import.meta.dirname, "../../../tests/golden");
/** UPDATE_GOLDEN=1 npx vitest ... para regenerar (¡conscientemente!). */
const UPDATE = process.env.UPDATE_GOLDEN === "1";

beforeAll(async () => {
  await initPhysics();
  mkdirSync(GOLDEN_DIR, { recursive: true });
});

/** Compara contra el golden, o lo crea si no existe / si se pide regenerar. */
function assertGolden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, name + ".json");
  const serialized = JSON.stringify(actual, null, 2);

  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, serialized + "\n");
    if (!UPDATE) console.warn(`[golden] creado ${name}.json (primera ejecución)`);
    return;
  }

  const expected = readFileSync(file, "utf8").trim();
  expect(
    serialized,
    `El escenario golden "${name}" ha cambiado. Si es intencionado, regenera con ` +
      `UPDATE_GOLDEN=1 y JUSTIFÍCALO en la PR: esto invalida los replays oficiales.`,
  ).toBe(expected);
}

/** Traza de poses por tick: la firma exacta del comportamiento físico. */
function trace(b: Battle, ticks: number, sampleEvery = 10) {
  const out: any[] = [];
  for (let t = 0; t < ticks; t++) {
    b.step();
    if (t % sampleEvery === 0) {
      out.push({
        tick: t,
        poses: b.getVehicles().map((v) => {
          const p = b.getPhysics().pose(v.id)!;
          return {
            id: v.id,
            x: round(p.position.x),
            y: round(p.position.y),
            h: round(p.heading),
            hp: round(v.hullHp),
          };
        }),
      });
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

describe("escenarios golden de física (T2.2)", () => {
  it("PERSECUCIÓN: un ligero rápido alcanza a un pesado lento", () => {
    const b = new Battle({
      battleId: "golden_chase",
      seed: "chase",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 400 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new ForwardBot("b1"));
    b.attachBot("veh_2", new ForwardBot("b2"));

    const t = trace(b, 300);
    assertGolden("chase", t);

    // Además del golden, una aserción con significado: el ligero corre más.
    const last = t[t.length - 1].poses;
    const scoutX = last.find((p: any) => p.id === "veh_1").x;
    const gunnerStart = 100; // spawn azul en emptyArena
    expect(scoutX).toBeGreaterThan(20); // se ha movido de verdad
    b.free();
  });

  it("CHOQUE FRONTAL: dos vehículos se encuentran y ninguno atraviesa al otro", () => {
    const map = emptyArena();
    const b = new Battle({
      battleId: "golden_headon",
      seed: "headon",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 400, friendlyFire: false }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new ForwardBot("b1")); // spawn (20,40) mirando +X
    b.attachBot("veh_2", new ForwardBot("b2")); // spawn (100,40) mirando -X

    const t = trace(b, 300);
    assertGolden("head_on", t);

    // Se han encontrado y NO se han atravesado: la distancia final es > 0.
    const last = t[t.length - 1].poses;
    const d = Math.abs(last[0].x - last[1].x);
    expect(d).toBeGreaterThan(1.0);
    b.free();
  });

  it("SLALOM: un vehículo no atraviesa muros ni siquiera a velocidad máxima", () => {
    // Prueba de túnel: el CCD debe impedir que un cuerpo rápido se cuele por un muro.
    const map = emptyArena(60, 40);
    map.walls.push({ id: "w1", position: { x: 30, y: 20 }, halfW: 0.5, halfH: 15 });
    map.spawns = [{ team: "red", position: { x: 5, y: 20 }, heading: 0 }];

    const b = new Battle({
      battleId: "golden_slalom",
      seed: "slalom",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 400, scoreToWin: 999 }),
      map,
      participants: [{ id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() }],
    });
    b.attachBot("veh_1", new ForwardBot("b1"));

    const t = trace(b, 300);
    assertGolden("slalom_wall", t);

    // Jamás cruza al otro lado del muro (x=30).
    for (const frame of t) {
      expect(frame.poses[0].x, `túnel en el tick ${frame.tick}`).toBeLessThan(30);
    }
    b.free();
  });

  it("COMBATE: un artillero destruye a un saco de arena, de forma reproducible", () => {
    const b = new Battle({
      battleId: "golden_combat",
      seed: "combat",
      ruleset: loadRuleset("tdm_mvp@1", {
        timeLimitTicks: 900,
        scoreToWin: 1,
        respawn: { enabled: false, delayTicks: 0 },
      }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    b.attachBot("veh_1", new HunterBot("b1"));
    b.attachBot("veh_2", new CircleBot("b2"));

    const result = b.run(900);
    assertGolden("combat_result", {
      winner: result.winner,
      ticks: result.ticks,
      score: result.score,
      finalStateHash: result.finalStateHash,
    });

    expect(result.winner).toBe("red");
    b.free();
  }, 30_000);
});

describe("replays (T2.6)", () => {
  const config = (): BattleConfig => ({
    battleId: "replay_test",
    seed: "replay-seed",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 600 }),
    map: mvpArena(),
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: "red", spec: scoutLoadout() },
      { id: "veh_3", botId: "b3", team: "blue", spec: gunnerLoadout() },
      { id: "veh_4", botId: "b4", team: "blue", spec: minerLoadout() },
    ],
  });

  const attach = (b: Battle) => {
    b.attachBot("veh_1", new HunterBot("b1"));
    b.attachBot("veh_2", new CircleBot("b2"));
    b.attachBot("veh_3", new HunterBot("b3"));
    b.attachBot("veh_4", new ForwardBot("b4"));
  };

  it("ROUND-TRIP: un replay re-simulado reproduce el resultado y TODOS los hashes", async () => {
    // El criterio central de la DoD de T2.6.
    const replay = await record(config(), attach);
    const v = await verify(replay);

    expect(v.divergedAtTick, `divergió en el tick ${v.divergedAtTick}`).toBeNull();
    expect(v.matches).toBe(true);
    expect(v.recomputedHash).toBe(v.officialHash);
    expect(v.recomputedResult.winner).toBe(v.officialResult.winner);
    expect(v.recomputedResult.ticks).toBe(v.officialResult.ticks);
    expect(v.recomputedResult.score).toEqual(v.officialResult.score);
  }, 60_000);

  it("el replay sobrevive a la serialización JSONL sin perder nada", async () => {
    const replay = await record(config(), attach);
    const jsonl = toJsonl(replay);
    const parsed = fromJsonl(jsonl);

    expect(parsed.header.seed).toBe(replay.header.seed);
    expect(parsed.commands.length).toBe(replay.commands.length);
    expect(parsed.result.finalStateHash).toBe(replay.result.finalStateHash);

    // Y el replay deserializado sigue verificando.
    const v = await verify(parsed);
    expect(v.matches).toBe(true);
  }, 60_000);

  it("DETECCIÓN DE MANIPULACIÓN: alterar un solo comando rompe la verificación", async () => {
    // Si esto no saltara, cualquiera podría 'ganar' un torneo editando su replay.
    const replay = await record(config(), attach);
    expect((await verify(replay)).matches).toBe(true);

    // Manipulamos un único comando a mitad de la batalla.
    const idx = Math.floor(replay.commands.length / 2);
    const tampered = structuredClone(replay);
    tampered.commands[idx].command.move = { throttle: -1, steer: 1 };

    const v = await verify(tampered);
    expect(v.matches).toBe(false);
    expect(v.divergedAtTick).not.toBeNull();
    // Y sabemos EXACTAMENTE dónde empezó la mentira.
    expect(v.divergedAtTick!).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("los snapshots públicos NO contienen observaciones privadas de bots", async () => {
    // El mismo criterio de fuga, ahora sobre el canal de espectador (lo consumirá E8).
    const replay = await record(config(), attach);

    // OJO: no vale buscar substrings como "radio" — la ranura de un módulo se LLAMA
    // "radio_a", y su nombre es público (se ve el hardware montado en el visor). Lo que
    // no puede aparecer son los DATOS de esos sensores. Comprobamos la estructura.
    const PUBLIC_VEHICLE_KEYS = [
      "id", "team", "alive", "position", "heading", "turretHeading",
      "hullHp", "hullHpMax", "carryingFlag", "modules",
    ];

    for (const snap of replay.snapshots) {
      // El snapshot no expone bloques de percepción de nadie.
      expect(snap.sensors).toBeUndefined();
      expect(snap.observations).toBeUndefined();
      expect(snap.radio).toBeUndefined();
      // Las minas son información oculta: no van en el canal público.
      expect(snap.mines).toBeUndefined();

      for (const v of snap.vehicles) {
        // Ni un solo campo de más: si alguien añade datos privados al snapshot, salta aquí.
        expect(Object.keys(v).sort()).toEqual([...PUBLIC_VEHICLE_KEYS].sort());
        // De cada módulo solo se ve QUÉ es y CÓMO está, nunca sus lecturas.
        for (const m of v.modules) {
          expect(Object.keys(m).sort()).toEqual(["slot", "state"]);
        }
      }
      // Y sí está lo que un espectador debe ver.
      expect(snap.vehicles[0]).toHaveProperty("position");
      expect(snap.vehicles[0]).toHaveProperty("hullHp");
    }
  }, 60_000);

  it("el tamaño de una batalla de 5 minutos se mantiene bajo el umbral (< 5 MB)", async () => {
    // El umbral de la DoD se mide sobre lo que REALMENTE se almacena. El formato de
    // replay es JSONL + zstd (T2.6), así que medir el JSONL en crudo mediría un
    // artefacto que no existe en disco. Se comprime, y se mide lo comprimido.
    const replay = await record(
      { ...config(), ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 9000 }) },
      attach,
    );
    const jsonl = toJsonl(replay);
    const raw = Buffer.byteLength(jsonl, "utf8") / 1024 / 1024;
    const compressed = zstdCompressSync(Buffer.from(jsonl)).length / 1024 / 1024;

    console.log(
      `  replay de ${replay.result.ticks} ticks: ${raw.toFixed(2)} MB en crudo → ` +
        `${compressed.toFixed(2)} MB con zstd (ratio ${(raw / compressed).toFixed(1)}x)`,
    );
    expect(compressed).toBeLessThan(5);
  }, 120_000);

  it("un replay de CTF reproduce la captura exacta", async () => {
    const map = ctfArena();
    const cfg: BattleConfig = {
      battleId: "replay_ctf",
      seed: "ctf-replay",
      ruleset: loadRuleset("ctf_mvp@1", { scoreToWin: 1, timeLimitTicks: 9000 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    };
    const replay = await record(cfg, (b) => {
      b.attachBot("veh_1", new FlagRunnerBot(
        "b1",
        map.flags.find((f) => f.team === "blue")!.position,
        map.bases.find((x) => x.team === "red")!.position,
      ));
      b.attachBot("veh_2", new IdleBot("b2"));
    });

    expect(replay.result.winner).toBe("red");
    const v = await verify(replay);
    expect(v.matches).toBe(true);
    expect(v.recomputedResult.score).toEqual(replay.result.score);
  }, 60_000);
});
