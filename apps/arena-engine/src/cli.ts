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
import { loadRuleset, TICK_DT } from "../../../packages/game-rules/index.js";
import { Battle, type BattleConfig } from "./sim/battle.js";
import { initPhysics } from "./sim/physics.js";
import { fromJsonl, record, toJsonl, verify } from "./replay.js";
import { ctfArena, emptyArena, gunnerLoadout, minerLoadout, mvpArena, scoutLoadout } from "./fixtures.js";
import { CircleBot, ForwardBot, HunterBot, IdleBot } from "./stubs.js";
import { createInspector, type Inspector } from "./inspector.js";
import deps from "./engine-deps.json" with { type: "json" };
import { fileURLToPath } from "node:url";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes("--" + name);
}

/** Hosts que se consideran loopback (solo la propia máquina puede alcanzarlos). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * R13.2 (hardening) · El inspector no tiene CORS ni autenticación (deliberado,
 * ver cabecera de `inspector.ts`): eso solo es aceptable si se queda en
 * loopback. Exponerlo en cualquier otro host exige el opt-in EXPLÍCITO
 * `--inspect-allow-remote`; sin él, se falla con un mensaje claro en vez de
 * arrancar un servidor sin auth escuchando en la red.
 */
export function validateInspectHost(host: string, allowRemote: boolean): void {
  if (LOOPBACK_HOSTS.has(host) || allowRemote) return;
  throw new Error(
    `--inspect-host ${host} no es loopback (127.0.0.1/localhost/::1) y el inspector no tiene CORS ni ` +
      `autenticación. Añade --inspect-allow-remote si de verdad quieres exponerlo en la red (bajo tu propio riesgo).`,
  );
}

/** Corre la batalla tick a tick al ritmo real de `speed` (fuera de sim/, es legítimo:
 * TICK_DT, la lógica y los hashes no cambian, solo la cadencia del reloj de pared). */
async function runPaced(b: Battle, maxTicks: number, speed: number): Promise<void> {
  const tickIntervalMs = (TICK_DT * 1000) / speed;
  while (!b.isFinished() && b.tick < maxTicks) {
    const t0 = Date.now();
    b.step();
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, tickIntervalMs - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
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

  const inspect = flag("inspect");
  const speedArg = arg("speed");
  let speed: number | undefined;
  if (speedArg !== undefined) {
    speed = Number(speedArg);
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error(`--speed inválido: "${speedArg}" (debe ser un número finito > 0)`);
    }
  }

  const t0 = performance.now();

  if (out) {
    if (inspect || speed !== undefined) {
      throw new Error("--inspect y --speed no son compatibles con --out (grabación de replay)");
    }
    const replay = await record(config, attach);
    writeFileSync(out, toJsonl(replay));
    report(replay.result, performance.now() - t0);
    console.log(`  replay escrito en ${out}`);
    return;
  }

  const b = await Battle.create(config);
  attach(b);

  let inspector: Inspector | undefined;
  if (inspect) {
    const inspectHost = arg("inspect-host", "127.0.0.1")!;
    validateInspectHost(inspectHost, flag("inspect-allow-remote"));
    inspector = await createInspector({
      battle: b,
      host: inspectHost,
      port: Number(arg("inspect-port", "0")),
    });
    console.log(`  inspector escuchando en http://${inspector.host}:${inspector.port}`);
  }

  const maxTicks = Number(arg("ticks", "100000"));
  let result;
  try {
    if (inspect || speed !== undefined) {
      // --inspect sin --speed corre a ritmo real (1×) para que el inspector tenga
      // ocasión de servir peticiones mientras la batalla avanza.
      await runPaced(b, maxTicks, speed ?? 1);
      result = b.isFinished() ? b.getResult()! : b.run(maxTicks);
    } else {
      result = b.run(maxTicks);
    }
  } finally {
    if (inspector) await inspector.close();
  }
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
  run     [--inspect [--inspect-host h] [--inspect-port p] [--inspect-allow-remote]] [--speed n]
                              inspector HTTP + ritmo real (R13.1); host no-loopback exige
                              --inspect-allow-remote (R13.2, sin CORS ni auth)
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

// R13.2 (hardening) · guarda de entrypoint: solo ejecuta `main()` cuando el
// archivo se invoca como script (bin CLI real), NUNCA al importarse (p. ej.
// para testear `validateInspectHost` sin disparar `process.exit` en el
// proceso de test). Comportamiento del CLI real sin cambios.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
