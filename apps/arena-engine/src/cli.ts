#!/usr/bin/env node
/**
 * CLI del motor (T2.1).
 *
 *   arena-engine run --seed <s> [--ruleset id] [--map mvp|ctf|empty] [--ticks N]
 *   arena-engine run --config <archivo.json>
 *   arena-engine verify <replay.jsonl>
 *   arena-engine deps
 *
 * Todo lo que hace la CI se puede reproducir a mano desde aquí: es la diferencia entre
 * un motor auditable y una caja negra.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type BattleConfig } from "./sim/battle.js";
import { initPhysics } from "./sim/physics.js";
import { fromJsonl, record, toJsonl, verify } from "./replay.js";
import { ctfArena, emptyArena, gunnerLoadout, minerLoadout, mvpArena, scoutLoadout } from "./fixtures.js";
import { CircleBot, ForwardBot, HunterBot, IdleBot } from "./stubs.js";
import deps from "./engine-deps.json" with { type: "json" };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MAPS: Record<string, () => any> = { mvp: mvpArena, ctf: ctfArena, empty: emptyArena };

const STUBS: Record<string, (id: string) => any> = {
  hunter: (id) => new HunterBot(id),
  circle: (id) => new CircleBot(id),
  forward: (id) => new ForwardBot(id),
  idle: (id) => new IdleBot(id),
};

async function cmdRun(): Promise<void> {
  const configFile = arg("config");
  let config: BattleConfig;
  let stubNames: string[];

  if (configFile) {
    config = JSON.parse(readFileSync(configFile, "utf8"));
    stubNames = (config as any).stubs ?? ["hunter", "circle", "hunter", "forward"];
  } else {
    const mapName = arg("map", "mvp")!;
    const mk = MAPS[mapName];
    if (!mk) throw new Error(`Mapa desconocido: ${mapName}. Opciones: ${Object.keys(MAPS).join(", ")}`);

    config = {
      battleId: arg("id", "cli_" + Date.now())!,
      seed: arg("seed", "default")!,
      ruleset: loadRuleset(arg("ruleset", "tdm_mvp@1")!, {
        timeLimitTicks: Number(arg("ticks", "3000")),
      }),
      map: mk(),
      participants: [
        { id: "veh_1", botId: "bot_1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "bot_2", team: "red", spec: scoutLoadout() },
        { id: "veh_3", botId: "bot_3", team: "blue", spec: gunnerLoadout() },
        { id: "veh_4", botId: "bot_4", team: "blue", spec: minerLoadout() },
      ],
    };
    stubNames = ["hunter", "circle", "hunter", "forward"];
  }

  const out = arg("out");
  const attach = (b: Battle) => {
    config.participants.forEach((p, i) => {
      const stub = STUBS[stubNames[i % stubNames.length]] ?? STUBS.idle;
      b.attachBot(p.id, stub(p.botId));
    });
  };

  const t0 = performance.now();

  if (out) {
    const replay = await record(config, attach);
    writeFileSync(out, toJsonl(replay));
    report(replay.result, performance.now() - t0);
    console.log(`  replay escrito en ${out}`);
    return;
  }

  const b = await Battle.create(config);
  attach(b);
  const result = b.run(Number(arg("ticks", "100000")));
  b.free();
  report(result, performance.now() - t0);
}

function report(result: any, ms: number): void {
  console.log(`\nbatalla ${result.battleId}`);
  console.log(`  ganador       ${result.winner}`);
  console.log(`  marcador      ${JSON.stringify(result.score)}`);
  console.log(`  duración      ${result.ticks} ticks (${(result.ticks / 30).toFixed(1)} s de juego)`);
  console.log(`  descalificados ${result.disqualified.length ? result.disqualified.join(", ") : "ninguno"}`);
  console.log(`  hash final    ${result.finalStateHash}`);
  console.log(`  versiones     motor ${result.versions.engine} · ${result.versions.physics}`);
  console.log(`  tiempo real   ${ms.toFixed(0)} ms (${(((result.ticks / 30) * 1000) / ms).toFixed(0)}× acelerado)\n`);
}

async function cmdVerify(file: string): Promise<void> {
  await initPhysics();
  const replay = fromJsonl(readFileSync(file, "utf8"));
  const v = await verify(replay);

  console.log(`\nverificación de ${file}`);
  console.log(`  batalla        ${replay.header.battleId} · semilla ${replay.header.seed}`);
  console.log(`  motor grabado  ${replay.header.versions.engine} · ${replay.header.versions.physics}`);
  console.log(`  hash oficial   ${v.officialHash}`);
  console.log(`  hash recalcul. ${v.recomputedHash}`);

  if (v.matches) {
    console.log(`\n  ✓ EL REPLAY ES AUTÉNTICO: la re-simulación reproduce el resultado oficial.\n`);
    process.exit(0);
  }
  console.error(`\n  ✗ NO COINCIDE. Divergencia a partir del tick ${v.divergedAtTick}.`);
  console.error(`    O el replay fue manipulado, o el motor cambió y ya no reproduce`);
  console.error(`    esta batalla (comprueba las versiones de la cabecera).\n`);
  process.exit(1);
}

function cmdDeps(): void {
  console.log(JSON.stringify(deps, null, 2));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  try {
    switch (cmd) {
      case "run":
        await cmdRun();
        break;
      case "verify": {
        const f = process.argv[3];
        if (!f) throw new Error("Uso: arena-engine verify <replay.jsonl>");
        await cmdVerify(f);
        break;
      }
      case "deps":
        cmdDeps();
        break;
      default:
        console.log(`arena-engine · motor de simulación de S9 AI Arena

  run     --seed <s> [--map mvp|ctf|empty] [--ruleset id] [--ticks N] [--out replay.jsonl]
  run     --config <archivo.json> [--out replay.jsonl]
  verify  <replay.jsonl>     re-simula y comprueba que el resultado oficial es auténtico
  deps                       versiones y checksums fijados (D4)
`);
        process.exit(cmd ? 1 : 0);
    }
  } catch (err: any) {
    console.error(`\nerror: ${err.message}\n`);
    process.exit(1);
  }
}

main();
