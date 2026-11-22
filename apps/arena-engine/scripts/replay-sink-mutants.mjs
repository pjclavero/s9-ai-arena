#!/usr/bin/env node
/**
 * V1 REPLAYS · PR-1 · calibración por mutantes del sink, la ventana y el gateway.
 * Cada mutante cambia UN fragmento de fuente (o una variable de entorno que activa un
 * mutante dentro del test), ejecuta sólo el grupo de tests y exige rojo. Restaura siempre.
 * Uso: node apps/arena-engine/scripts/replay-sink-mutants.mjs [id...]   (en serie)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENGINE = "apps/arena-engine/tests/replay-sink.test.ts";
const GATEWAY = "apps/api/src/spectate/frame-window.test.ts";
const SINK = "apps/arena-engine/src/sim/replay-sink.ts";
const BATTLE = "apps/arena-engine/src/sim/battle.ts";
const GW = "apps/api/src/spectate/gateway.ts";

export const MUTANTS = [
  {
    id: "M-R1-window-never-evicts-base",
    test: ENGINE,
    group: "R1",
    file: SINK,
    find: "return this.pushed - this.count;",
    replace: "return 0;",
  },
  {
    id: "M-R1-get-ignores-base",
    test: ENGINE,
    group: "R1",
    file: SINK,
    find: "if (i < this.base || i >= this.pushed) return undefined;",
    replace: "if (i >= this.pushed) return undefined;",
  },
  {
    id: "M-R2-hash-not-emitted",
    test: ENGINE,
    group: "R2",
    file: BATTLE,
    find: "this.sink.hash({ tick: this.tick, hash: bd.hash })",
    replace: "void 0",
  },
  {
    id: "M-R2-checkpoint-not-emitted",
    test: ENGINE,
    group: "R2",
    file: BATTLE,
    find: "this.sink.checkpoint(c);",
    replace: "/* mutante */",
  },
  {
    id: "M-R3-command-not-emitted",
    test: ENGINE,
    group: "R3",
    file: BATTLE,
    find: "this.sink.command({ tick: this.tick, vehicleId: v.id, command: cmd });",
    replace: "/* mutante */",
  },
  {
    id: "M-R3-snapshot-not-emitted",
    test: ENGINE,
    group: "R3",
    file: BATTLE,
    find: "this.sink.snapshot(f);",
    replace: "/* mutante */",
  },
  {
    id: "M-R3-event-not-emitted",
    test: ENGINE,
    group: "R3",
    file: BATTLE,
    find: "this.sink.event(e);",
    replace: "/* mutante */",
  },
  {
    id: "M-R4-external-sink-readable",
    test: ENGINE,
    group: "R4",
    file: BATTLE,
    find: "if (!this.memory) throw new ReplayNotRetainedError(what);",
    replace: "if (!this.memory) return new MemoryReplaySink();",
  },
  {
    id: "M-R5-retainFrames-ignored",
    test: ENGINE,
    group: "R5",
    file: BATTLE,
    find: "retainSnapshots: config.retainFrames !== false,",
    replace: "retainSnapshots: true,",
  },
  {
    id: "M-R6-frame-window-ignored",
    test: ENGINE,
    group: "R6",
    file: BATTLE,
    find: "new WindowLog<any>(config.frameWindow ?? DEFAULT_FRAME_WINDOW)",
    replace: "new WindowLog<any>(1_000_000)",
  },
  {
    id: "M-R7-no-cap-on-commands",
    test: ENGINE,
    group: "R7",
    file: SINK,
    find: "if (this.commands.length >= this.limits.maxCommands)",
    replace: "if (false)",
  },
  {
    id: "M-R7-no-cap-on-snapshots",
    test: ENGINE,
    group: "R7",
    file: SINK,
    find: "if (this.snapshots.length >= this.limits.maxSnapshots)",
    replace: "if (false)",
  },
  { id: "M-R8-accumulating-sink", test: ENGINE, group: "R8", env: { S9_SINK_MUTANT: "accumulate" } },
  {
    id: "M-R8-engine-retains-frames",
    test: ENGINE,
    group: "R8",
    file: BATTLE,
    find: "this.frames.push(f);",
    replace: "this.frames.push(f); ((this as any).__keep ??= []).push(JSON.stringify(f), JSON.stringify(f));",
  },
  {
    id: "M-G1-attach-from-zero",
    test: GATEWAY,
    group: "G1",
    file: GW,
    find: "for (let i = logBase(fl); i < fl.length; i++)",
    replace: "for (let i = 0; i < fl.length; i++)",
  },
  {
    id: "M-G2-no-resync-frames",
    test: GATEWAY,
    group: "G2",
    file: GW,
    find: "feed.sentSnapshots = logBase(fl);",
    replace: "/* mutante */",
  },
  {
    id: "M-G2-events-drop-not-counted",
    test: GATEWAY,
    group: "G2",
    file: GW,
    find: "feed.droppedEvents += logBase(el) - feed.sentEvents;",
    replace: "/* mutante */",
  },
  {
    id: "M-R1b-evict-not-notified",
    test: ENGINE,
    group: "R1b",
    file: SINK,
    find: "cb(idx, old);",
    replace: "/* mutante */",
  },
  {
    id: "M-R1b-evict-wrong-index",
    test: ENGINE,
    group: "R1b",
    file: SINK,
    find: "cb(idx, old);",
    replace: "cb(idx + 1, old);",
  },
  {
    id: "M-R5-getter-silent",
    test: ENGINE,
    group: "R5",
    file: BATTLE,
    find: "(needsFrames && this.config.retainFrames === false)",
    replace: "false",
  },
  {
    id: "M-R7-limits-not-derived",
    test: ENGINE,
    group: "R7",
    file: SINK,
    find: "maxSnapshots: per(p.snapshotEvery),",
    replace: "maxSnapshots: 200_000,",
  },
  {
    id: "M-R7-commands-cap-loose",
    test: ENGINE,
    group: "R7",
    file: SINK,
    find: "maxCommands: Math.ceil(ticks * Math.max(1, p.vehicles) * 1.1) + 16,",
    replace: "maxCommands: 2_000_000,",
  },
  {
    id: "M-R7b-fault-propagates",
    test: ENGINE,
    group: "R7b",
    file: BATTLE,
    find: "this.recordingFault = { cause, stream, tick: this.tick };",
    replace: "throw cause;",
  },
  {
    id: "M-R7b-keeps-emitting",
    test: ENGINE,
    group: "R7b",
    file: BATTLE,
    find: "if (this.recordingFault) return;",
    replace: "/* mutante */",
  },
  {
    id: "M-R7b-no-finish-on-fault",
    test: ENGINE,
    group: "R7b",
    file: BATTLE,
    find: "this.finish(RECORDING_FAULT);",
    replace: 'this.finish("draw");',
  },
  {
    id: "M-G3-no-evict-subscription",
    test: GATEWAY,
    group: "G3",
    file: GW,
    find: "if (!Array.isArray(fl) && fl.onEvict) {",
    replace: "if (false) {",
  },
  {
    id: "M-G3-evict-not-projected",
    test: GATEWAY,
    group: "G3",
    file: GW,
    find: "af.lastSnapshot = af.projector.project(item).body;",
    replace: "/* mutante */",
  },
  {
    id: "M-G3-drop-not-counted",
    test: GATEWAY,
    group: "G3",
    file: GW,
    find: "this.totalDroppedFrames++;",
    replace: "/* mutante */",
  },
  {
    id: "M-G3-no-log",
    test: GATEWAY,
    group: "G3",
    file: GW,
    find: "console.warn(JSON.stringify(",
    replace: "void (JSON.stringify(",
  },
];

function run(m) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", m.test, "-t", `${m.group} `, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(m.env ?? {}) },
  });
  return r.status;
}
const only = new Set(process.argv.slice(2));
const base = {};
let bad = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  const key = m.test + m.group;
  if (!(key in base)) base[key] = run({ ...m, env: undefined });
  if (base[key] !== 0) {
    console.log(`${m.id}: BASE ROJA (rc ${base[key]})`);
    bad++;
    continue;
  }
  if (!m.file) {
    const rc = run(m);
    console.log(`${m.id}: ${rc !== 0 ? "MUERTO" : "SOBREVIVE"} (rc ${rc})`);
    if (rc === 0) bad++;
    continue;
  }
  const f = join(root, m.file);
  const orig = readFileSync(f, "utf8");
  const n = orig.split(m.find).length - 1;
  if (n !== 1) {
    console.log(`${m.id}: patrón con ${n} apariciones`);
    bad++;
    continue;
  }
  try {
    writeFileSync(
      f,
      orig.replace(m.find, () => m.replace),
    );
    const rc = run(m);
    console.log(`${m.id}: ${rc !== 0 ? "MUERTO" : "SOBREVIVE"} (rc ${rc})`);
    if (rc === 0) bad++;
  } finally {
    writeFileSync(f, orig);
  }
}
console.log(`supervivientes/errores: ${bad}`);
process.exit(bad ? 1 : 0);
