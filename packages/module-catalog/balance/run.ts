#!/usr/bin/env -S npx tsx
/**
 * T3.4 · Banco de simulación espejo.
 *
 * Enfrenta los 3 arquetipos de packages/module-catalog/balance/archetypes.ts
 * (ligero-explorador, medio-polivalente/artillero, pesado-artillero) usando el
 * motor headless de E2 (Battle, importado directamente) y HunterBot
 * (apps/arena-engine/src/stubs.ts) como IA de combate en ambos lados. Objetivo:
 * ningún emparejamiento debe salir del 45-55 % de winrate.
 *
 * Reproducible por semilla: cada batalla usa `bal_v1_<emparejamiento>_<índice>`
 * como semilla del motor (Rng de apps/arena-engine/src/rng.ts vía Battle; nunca
 * Math.random). Ejecutar este script dos veces con los mismos argumentos produce
 * el mismo docs/balance/informe-v1.md byte a byte, porque el motor es determinista
 * por semilla y este script no escribe marcas de tiempo en el informe.
 *
 * Uso:
 *   npx tsx packages/module-catalog/balance/run.ts                  # 200 batallas/emparejamiento
 *   npx tsx packages/module-catalog/balance/run.ts --n 20           # PR rápido
 *   npx tsx packages/module-catalog/balance/run.ts --matrix a.json  # matriz custom: [["scout","heavy"], ...]
 *
 * Nightly vs PR: en CI normal, `--n 20` da una señal rápida (±11 pp de IC95%,
 * suficiente para detectar un desequilibrio grosero). El run nightly usa el valor
 * por defecto (200, ±7 pp) y es el que se versiona en docs/balance/informe-v1.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Battle, type BattleResult } from "../../../apps/arena-engine/src/sim/battle.js";
import { emptyArena } from "../../../apps/arena-engine/src/fixtures.js";
import { loadRuleset } from "../../game-rules/index.js";
import { HunterBot } from "../../../apps/arena-engine/src/stubs.js";
import { resolveVehicle } from "../resolve/index.js";
import { loadCatalog } from "../loadCatalog.js";
import { BALANCE_ARCHETYPES } from "./archetypes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = loadCatalog();

type ArchetypeName = keyof typeof BALANCE_ARCHETYPES;

interface MatchupResult {
  matchup: string;
  battles: number;
  winsA: number;
  winsB: number;
  draws: number;
  winrateA: number;
  ci95PointsA: number;
  avgTicks: number;
  avgDamageDealtA: number;
  avgDamageDealtB: number;
  seedFirst: string;
  seedLast: string;
}

const DEFAULT_MATRIX: [ArchetypeName, ArchetypeName][] = [
  ["scout", "gunner"],
  ["scout", "heavy"],
  ["gunner", "heavy"],
];

function parseArgs(argv: string[]): { n: number; matrixPath: string | null } {
  let n = 200;
  let matrixPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--n") n = Number(argv[++i]);
    if (argv[i] === "--matrix") matrixPath = argv[++i];
  }
  return { n, matrixPath };
}

async function runOneBattle(
  seed: string,
  archA: ArchetypeName,
  archB: ArchetypeName,
  redIsA: boolean,
): Promise<{ result: BattleResult; damageDealtRed: number; damageDealtBlue: number }> {
  const specA = resolveVehicle(BALANCE_ARCHETYPES[archA], catalog);
  const specB = resolveVehicle(BALANCE_ARCHETYPES[archB], catalog);

  const battle = await Battle.create({
    battleId: seed,
    seed,
    ruleset: loadRuleset("dm_practice@1"),
    map: emptyArena(),
    participants: [
      { id: "veh_red", botId: "bot_red", team: "red", spec: redIsA ? specA : specB },
      { id: "veh_blue", botId: "bot_blue", team: "blue", spec: redIsA ? specB : specA },
    ],
  });

  battle.attachBot("veh_red", new HunterBot("bot_red"));
  battle.attachBot("veh_blue", new HunterBot("bot_blue"));

  const hpRedStart = battle.getVehicle("veh_red")!.hullHp;
  const hpBlueStart = battle.getVehicle("veh_blue")!.hullHp;

  const result = battle.run(9000);

  const vRed = battle.getVehicle("veh_red")!;
  const vBlue = battle.getVehicle("veh_blue")!;
  // Daño infligido por un bando = vida perdida por el otro. Aproximación agregada
  // suficiente para el balance de v1 (no distingue overkill del último impacto).
  const damageDealtRed = Math.max(0, hpBlueStart - vBlue.hullHp);
  const damageDealtBlue = Math.max(0, hpRedStart - vRed.hullHp);

  battle.free();
  return { result, damageDealtRed, damageDealtBlue };
}

async function runMatchup(archA: ArchetypeName, archB: ArchetypeName, n: number): Promise<MatchupResult> {
  const matchup = `${archA}_vs_${archB}`;
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let totalTicks = 0;
  let totalDamageA = 0;
  let totalDamageB = 0;
  const seeds: string[] = [];

  for (let i = 0; i < n; i++) {
    // Alterna lados: en la mitad de las batallas A empieza en "red", en la otra mitad en "blue".
    // Elimina el sesgo de spawn (la arena vacía es simétrica, pero por si el modo no lo fuera).
    const redIsA = i % 2 === 0;
    const seed = `bal_v1_${matchup}_${String(i).padStart(4, "0")}`;
    seeds.push(seed);

    const { result, damageDealtRed, damageDealtBlue } = await runOneBattle(seed, archA, archB, redIsA);
    totalTicks += result.ticks;

    const damageA = redIsA ? damageDealtRed : damageDealtBlue;
    const damageB = redIsA ? damageDealtBlue : damageDealtRed;
    totalDamageA += damageA;
    totalDamageB += damageB;

    if (result.winner === "draw") {
      draws++;
    } else {
      const winnerIsA = (result.winner === "red") === redIsA;
      if (winnerIsA) winsA++;
      else winsB++;
    }
  }

  const decided = winsA + winsB;
  const winrateA = decided > 0 ? winsA / decided : 0.5;
  const ci95PointsA = decided > 0 ? 1.96 * Math.sqrt((winrateA * (1 - winrateA)) / decided) : 0;

  return {
    matchup,
    battles: n,
    winsA,
    winsB,
    draws,
    winrateA,
    ci95PointsA,
    avgTicks: totalTicks / n,
    avgDamageDealtA: totalDamageA / n,
    avgDamageDealtB: totalDamageB / n,
    seedFirst: seeds[0],
    seedLast: seeds[seeds.length - 1],
  };
}

function renderReport(results: MatchupResult[]): string {
  const lines: string[] = [];
  lines.push("# Informe de balance v1 — banco de simulación espejo");
  lines.push("");
  lines.push(
    "Generado por `packages/module-catalog/balance/run.ts`. Arquetipos de " +
      "`packages/module-catalog/balance/archetypes.ts`, motor headless de E2 (`Battle`), " +
      "`HunterBot` en ambos lados, ruleset `dm_practice@1`, arena vacía " +
      "(`emptyArena()`). Semilla determinista por batalla: `bal_v1_<emparejamiento>_<índice>`.",
  );
  lines.push("");
  lines.push(
    "| Emparejamiento (A vs B) | Batallas | Winrate A | IC95% | Daño medio A | Daño medio B | Ticks medios | Empates | ¿En 45–55%? |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const inRange = r.winrateA >= 0.45 && r.winrateA <= 0.55 ? "✅" : "❌";
    lines.push(
      `| ${r.matchup} | ${r.battles} | ${(r.winrateA * 100).toFixed(1)}% | ±${(r.ci95PointsA * 100).toFixed(1)} pp | ` +
        `${r.avgDamageDealtA.toFixed(1)} | ${r.avgDamageDealtB.toFixed(1)} | ${r.avgTicks.toFixed(0)} | ${r.draws} | ${inRange} |`,
    );
  }
  lines.push("");
  lines.push("## Semillas (reproducibilidad)");
  for (const r of results) {
    lines.push(`- **${r.matchup}**: \`${r.seedFirst}\` … \`${r.seedLast}\``);
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const { n, matrixPath } = parseArgs(process.argv.slice(2));
  const matrix: [ArchetypeName, ArchetypeName][] = matrixPath
    ? (JSON.parse(readFileSync(matrixPath, "utf8")) as [ArchetypeName, ArchetypeName][])
    : DEFAULT_MATRIX;

  const results: MatchupResult[] = [];
  for (const [a, b] of matrix) {
    console.log(`Simulando ${a} vs ${b} (${n} batallas)...`);
    results.push(await runMatchup(a, b, n));
  }

  const report = renderReport(results);
  const outPath = join(__dirname, "..", "..", "..", "docs", "balance", "informe-v1.md");
  writeFileSync(outPath, report);
  console.log("\n" + report);
  console.log(`Informe escrito en ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
