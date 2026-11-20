#!/usr/bin/env -S npx tsx
/**
 * V1 · B1 (AUD2-10) · coste de una batalla 1v1 / 2v2 / 3v3 / 4v4.
 *
 * MODO `engine` (defecto, sin Docker): motor en proceso con bots de stub (HunterBot),
 * una batalla a la vez. Mide tiempo de pared, CPU del proceso (user+system) y RSS/heap
 * máximos. NO mide los contenedores de bot (límites 0,5 CPU / 256 MiB / 64 PIDs cada
 * uno): ese coste se suma por fórmula (`concurrency.ts`) o con el modo `containers`.
 *
 * MODO `containers` (opt-in): delega en `scripts/e2e-real-battle-smoke.ts`, que exige
 * `S9_RUN_REAL_DOCKER_E2E=1`, `DOCKER_PROXY_URL` y una imagen de bot fijada por digest
 * (`SMOKE_BOT_DIGEST`). Aquí sólo se imprime el procedimiento: no se descargan imágenes.
 *
 * Uso: npx tsx scripts/ops/measure-battle-cost.ts [engine|containers] [repeticiones=3] [ticks=3000]
 * Salida: una línea JSON por tamaño y repetición, y una tabla final.
 */
import { readFileSync } from "node:fs";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { toEngineMap } from "../../apps/map-service/src/to-engine-map.js";
import { Battle, type Participant } from "../../apps/arena-engine/src/sim/battle.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { gunnerLoadout } from "../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../apps/arena-engine/src/stubs.js";

const modo = process.argv[2] ?? "engine";
const reps = Number(process.argv[3] ?? 3);
const maxTicks = Number(process.argv[4] ?? 3000);

if (modo === "containers") {
  console.log(
    [
      "Modo contenedores (no automático):",
      "  1. Tener una imagen de bot de runtime YA presente (sin descargar) y su digest.",
      "  2. S9_RUN_REAL_DOCKER_E2E=1 DOCKER_PROXY_URL=... SMOKE_BOT_DIGEST=... npx tsx scripts/e2e-real-battle-smoke.ts",
      "  3. En paralelo, `docker stats --no-stream` de los contenedores de bot y /proc/<pid>/stat del worker.",
      "  4. Repetir con 2, 4, 6 y 8 bots (1v1..4v4) y NO más de 5 repeticiones (regla de la sala de pruebas).",
    ].join("\n"),
  );
  process.exit(0);
}

const map = toEngineMap(
  JSON.parse(readFileSync(new URL("../../maps/mvp-arena-01.json", import.meta.url), "utf8")),
);
await initPhysics();

interface Fila {
  size: string;
  bots: number;
  rep: number;
  wallMs: number;
  cpuMs: number;
  ticks: number;
  rssMiB: number;
}
const filas: Fila[] = [];
for (const n of [1, 2, 3, 4]) {
  for (let rep = 1; rep <= reps; rep++) {
    const parts: Participant[] = Array.from({ length: n * 2 }, (_, i) => ({
      id: `veh_${i + 1}`,
      botId: `b${i + 1}`,
      team: i % 2 === 0 ? "red" : "blue",
      spec: gunnerLoadout(),
    }));
    const cpu0 = process.cpuUsage();
    const t0 = process.hrtime.bigint();
    const b = new Battle({
      battleId: `m${n}v${n}-${rep}`,
      seed: `m${n}v${n}-${rep}`,
      ruleset: loadRuleset("tdm_mvp@1"),
      map,
      participants: parts,
    });
    for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
    let ticks = 0;
    let rssMax = 0;
    for (; ticks < maxTicks && !b.isFinished(); ticks++) {
      b.step();
      if (ticks % 100 === 0) rssMax = Math.max(rssMax, process.memoryUsage().rss);
    }
    rssMax = Math.max(rssMax, process.memoryUsage().rss);
    b.free();
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const cpu = process.cpuUsage(cpu0);
    const f: Fila = {
      size: `${n}v${n}`,
      bots: n * 2,
      rep,
      wallMs: Math.round(wallMs),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      ticks,
      rssMiB: Math.round(rssMax / 1048576),
    };
    filas.push(f);
    console.log(JSON.stringify(f));
  }
}
console.log("\ntamaño  bots  wall_ms(med)  cpu_ms(med)  ticks  rss_MiB(max)");
for (const n of [1, 2, 3, 4]) {
  const g = filas.filter((f) => f.bots === n * 2);
  const med = (k: "wallMs" | "cpuMs") => g.map((f) => f[k]).sort((a, b) => a - b)[Math.floor(g.length / 2)];
  console.log(
    `${n}v${n}`.padEnd(8) +
      String(n * 2).padEnd(6) +
      String(med("wallMs")).padEnd(14) +
      String(med("cpuMs")).padEnd(13) +
      String(g[0].ticks).padEnd(7) +
      Math.max(...g.map((f) => f.rssMiB)),
  );
}
