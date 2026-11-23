#!/usr/bin/env node
/**
 * V1 REPLAYS PR-4 · calibración por mutantes de los lectores incrementales S9R/1.
 * Para cada mutante: aplica el cambio (uno o varios reemplazos, cada patrón con UNA aparición),
 * ejecuta SÓLO el test nombrado y exige que se ponga en ROJO; restaura siempre los ficheros.
 * Línea base: cada test se ejecuta antes sin mutar y debe estar en VERDE.
 * Uso: node apps/replay-service/scripts/replay-pr4-mutants.mjs [id...]   (serie, nunca en paralelo)
 * Commitea antes: el script reescribe ficheros del árbol y los restaura al terminar cada mutante.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RD = "apps/replay-service/tests/s9r/readers.test.ts";
const RD6 = "apps/api/src/replay-s9r.test.ts";
const E8 = "apps/api/src/e8-replay-verify.test.ts";
const BOOT = "apps/replay-service/tests/service-bootstrap.test.ts";
const CANON = "apps/tournament-worker/src/battle-stats-canonical.test.ts";
const RECIPE = "apps/replay-service/src/s9r/recipe.ts";
const VIEW = "apps/replay-service/src/s9r/view.ts";
const API = "apps/api/src/replay-s9r.ts";
const REV = "apps/api/src/v1-replay-pr340-review.test.ts";
const STATS = "apps/replay-service/src/stats.ts";
const ENGINE = "apps/arena-engine/src/replay.ts";

export const MUTANTS = [
  {
    id: "M-RD1-window-not-pruned",
    why: "el cursor retiene todos los comandos leídos (cargaría la receta entera)",
    test: RD,
    t: "RD1 ",
    edits: [
      {
        file: RECIPE,
        find: "if (t < tick) this.window.delete(t);",
        replace: "if (Date.now() < 0) this.window.delete(t);",
      },
    ],
  },
  {
    id: "M-RD2-straddle-lt",
    why: "un tick partido entre dos fragmentos se entrega a medias",
    test: RD,
    t: "RD2 ",
    edits: [
      { file: RECIPE, find: "while (this.loadedThrough <= tick &&", replace: "while (this.loadedThrough < tick &&" },
    ],
  },
  {
    id: "M-RD1-elision-null",
    why: "la elisión «=» devuelve null en vez del comando anterior",
    test: RD,
    t: "RD1 ",
    edits: [{ file: RECIPE, find: "        command = last.get(x.v);", replace: "        command = null;" }],
  },
  {
    id: "M-RD5-range-unfiltered",
    why: "el rango de la vista devuelve todo el fragmento (registros fuera de rango)",
    test: RD,
    t: "RD5 ",
    edits: [{ file: VIEW, find: "if (x.t < fromTick || x.t > toTick) continue;", replace: "/* mutante */" }],
  },
  {
    id: "M-RD6-segment-unfiltered",
    why: "el segmento proyectado devuelve frames fuera del rango",
    test: RD6,
    t: "segmento",
    edits: [
      {
        file: API,
        find: "onSnapshot: (b) => ticks.has(Number(b.tick)) && snapshots.push(b),",
        replace: "onSnapshot: (b) => snapshots.push(b),",
      },
    ],
  },
  {
    id: "M-RD7-stats-without-view",
    why: "las estadísticas desde la receta no reciben snapshots ni eventos públicos",
    test: RD,
    t: "RD7 ",
    edits: [
      {
        file: STATS,
        find: "const sink = new ResimulationSink(view);",
        replace: "const sink = new ResimulationSink({});",
      },
    ],
  },
  {
    id: "M-RD8-official-from-resim",
    why: "verify compara la re-simulación consigo misma (nunca detecta manipulación)",
    test: RD,
    t: "RD8 ",
    edits: [
      {
        file: ENGINE,
        find: "    { header, ...o, commands: [], events: [], snapshots: [] },\n    { result, stateHashes: sink.stateHashes",
        replace:
          "    { header, ...o, result: { ...o.result, finalStateHash: result.finalStateHash }, stateHashes: sink.stateHashes, checkpoints: sink.checkpoints, commands: [], events: [], snapshots: [] },\n    { result, stateHashes: sink.stateHashes",
      },
    ],
  },
  {
    id: "M-E8-checksum-unchecked",
    why: "verify no compara el sha del fichero con la BD",
    test: E8,
    t: "manipulado",
    edits: [{ file: API, find: "if (sha !== String(battle.replay_hash))", replace: "if (Date.now() < 0)" }],
  },
  {
    id: "M-E8-legacy-guard-removed",
    why: "un replay del formato anterior no se trata como «sin replay»",
    test: E8,
    t: "formato ANTERIOR",
    edits: [
      {
        file: "apps/api/src/routes/replays.ts",
        find: "if (!isS9rReplayRef(battle.replay_ref)) throw replayNotFound();",
        replace: "/* mutante */",
      },
    ],
  },
  {
    id: "M-BOOT-legacy-routes-mounted",
    why: "el servicio de producción vuelve a montar las rutas del formato anterior",
    test: BOOT,
    t: "B8",
    edits: [
      {
        file: "apps/replay-service/src/main.ts",
        find: 'mountVersionEndpoint(app, "replay-service");',
        replace:
          'mountVersionEndpoint(app, "replay-service");\napp.use((await import("./server.js")).createReplayServer({ dir }));',
      },
    ],
  },
  {
    id: "M-CANON-stats-state-not-ready",
    why: "las estadísticas del worker no se escriben (ensureRichStats ignora S9R)",
    test: CANON,
    t: "EXACTAMENTE",
    edits: [
      {
        file: "apps/tournament-worker/src/battle-runner.ts",
        find: "if (!row?.replay_ref || !isS9rReplayRef(row.replay_ref)) return;",
        replace: "if (!row?.replay_ref || isS9rReplayRef(row.replay_ref)) return;",
      },
    ],
  },
  {
    id: "M-L1-no-backpressure",
    why: "la descarga ignora el false de res.write: el documento entero se acumula en la API",
    test: REV,
    t: "L1 ",
    edits: [
      {
        file: API,
        find: "  if (res.write(chunk)) return;",
        replace: "  res.write(chunk);\n  if (Date.now() > 0) return;",
      },
    ],
  },
  {
    id: "M-L2-no-range-cap",
    why: "el segmento no tiene tope de anchura",
    test: REV,
    t: "L2 ",
    edits: [
      { file: API, find: 'if (to - from + 1 > MAX_SEGMENT_TICKS) return "too_large";', replace: "/* mutante */" },
    ],
  },
  {
    id: "M-L2-no-clamp",
    why: "rawSegment materializa todo el rango pedido",
    test: REV,
    t: "L2 ",
    edits: [
      {
        file: API,
        find: "const to = Math.min(range.to, range.from + MAX_SEGMENT_TICKS - 1);",
        replace: "const to = range.to;",
      },
    ],
  },
  {
    id: "M-L3-legacy-listed",
    why: "una referencia de formato anterior aparece en los listados como «con replay»",
    test: REV,
    t: "L3 ",
    edits: [{ file: API, find: 'return q.where(column, "like", "%.s9r");', replace: "return q;" }],
  },
  {
    id: "M-L4-view-sha-unchecked",
    why: "la vista no se contrasta con view_sha256",
    test: REV,
    t: "L4 ",
    edits: [
      { file: API, find: "if ((await sha256OfFile(path)) !== art.view_sha256) return null;", replace: "/* mutante */" },
    ],
  },
  {
    id: "M-L5-download-retains",
    why: "la descarga retiene cada frame proyectado (el documento entero en RAM)",
    test: REV,
    t: "L5 ",
    edits: [
      {
        file: API,
        find: '      await w((first ? "" : ",") + JSON.stringify(b));',
        replace:
          '      ((globalThis as any).__keep ??= []).push(b);\n      await w((first ? "" : ",") + JSON.stringify(b));',
      },
    ],
  },
  {
    id: "M-BOOT-listen-error-ignored",
    why: "con el puerto ocupado el servicio anuncia «escuchando» y sale con 0",
    test: BOOT,
    t: "puerto ocupado",
    edits: [
      { file: "apps/replay-service/src/main.ts", find: "  if (err) {", replace: "  if (Date.now() < 0 && err) {" },
    ],
  },
  {
    id: "M-RP1-no-dedupe",
    why: "el helper no deduplica los solapes entre segmentos",
    test: "apps/api/src/replay-pages.test.ts",
    t: "RP1 ",
    edits: [
      {
        file: "tests/browser/specs/replay-pages.ts",
        find: "if (!byTick.has(s.tick)) byTick.set(s.tick, s);",
        replace: "byTick.set(s.tick + Math.random(), s);",
      },
    ],
  },
  {
    id: "M-RP1-skips-chunks",
    why: "el helper se salta trozos (faltan instantáneas)",
    test: "apps/api/src/replay-pages.test.ts",
    t: "RP1 ",
    edits: [
      {
        file: "tests/browser/specs/replay-pages.ts",
        find: "from += SEGMENT_CHUNK_TICKS)",
        replace: "from += 2 * SEGMENT_CHUNK_TICKS)",
      },
    ],
  },
  {
    id: "M-RP1-chunk-too-wide",
    why: "el helper pide trozos más anchos que el tope (400 de la API)",
    test: "apps/api/src/replay-pages.test.ts",
    t: "RP1 ",
    edits: [
      {
        file: "tests/browser/specs/replay-pages.ts",
        find: "export const SEGMENT_CHUNK_TICKS = 1200;",
        replace: "export const SEGMENT_CHUNK_TICKS = 1300;",
      },
    ],
  },
];

function run(test, t) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", test, "-t", t, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  return r.status;
}

const only = new Set(process.argv.slice(2));
const base = new Map();
let survivors = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const key = `${m.test}::${m.t}`;
  if (!base.has(key)) base.set(key, run(m.test, m.t));
  if (base.get(key) !== 0) {
    console.log(`${m.id}: BASE ROJA (rc ${base.get(key)}), no calibrable`);
    survivors++;
    continue;
  }
  const originals = new Map();
  let ok = true;
  for (const e of m.edits) {
    const f = join(root, e.file);
    if (!originals.has(f)) originals.set(f, readFileSync(f, "utf8"));
  }
  const current = new Map(originals);
  for (const e of m.edits) {
    const f = join(root, e.file);
    const src = current.get(f);
    const k = src.split(e.find).length - 1;
    if (k !== 1) {
      console.log(`${m.id}: patrón con ${k} apariciones en ${e.file}`);
      ok = false;
      break;
    }
    current.set(
      f,
      src.replace(e.find, () => e.replace),
    );
  }
  if (!ok) {
    survivors++;
    continue;
  }
  try {
    for (const [f, s] of current) writeFileSync(f, s);
    const rc = run(m.test, m.t);
    const killed = rc !== 0;
    if (!killed) survivors++;
    console.log(`${m.id}: ${killed ? "MUERTO (test en rojo, rc " + rc + ")" : "SOBREVIVE (rc 0)"} · ${m.why}`);
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
  }
}
console.log(`supervivientes/errores: ${survivors}`);
process.exit(survivors ? 1 : 0);
