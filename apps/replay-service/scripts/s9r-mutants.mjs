#!/usr/bin/env node
/**
 * S9R/1 · calibración por mutantes. Para cada mutante: aplica el cambio al fichero fuente,
 * ejecuta SÓLO los tests del grupo indicado y exige que se pongan en ROJO; restaura siempre
 * el fichero original. Uso: node apps/replay-service/scripts/s9r-mutants.mjs [id...]
 * Un mutante que sobrevive (rc 0) devuelve rc 1 en el script. Serie, nunca en paralelo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (f) => join(root, "apps/replay-service/src/s9r", f);
const TEST = "apps/replay-service/tests/s9r/s9r.test.ts";

export const MUTANTS = [
  { id: "M-T1-drop-last-record", group: "T1", file: "writer.ts", find: `this.lines.join("\\n") + "\\n"`, replace: `this.lines.slice(0, -1).join("\\n") + "\\n"` },
  { id: "M-T1-filehash-not-updated", group: "T1", file: "writer.ts", find: `this.fileHash.update(buf);`, replace: `/* mutante */` },
  { id: "M-T2-footer-reserved-unchecked", group: "T2", file: "format.ts", find: `if (!b.subarray(52, 64).equals(Buffer.alloc(12)))`, replace: `if (false)` },
  { id: "M-T2-preamble-reserved-unchecked", group: "T2", file: "format.ts", find: `if (b[7] !== 0)`, replace: `if (false)` },
  { id: "M-T2-index-sha-unchecked", group: "T2", file: "reader.ts", find: `if (!sha256(indexFrame).equals(footer.indexSha256))`, replace: `if (false)` },
  { id: "M-T2-crc-unchecked-on-read", group: "T2", file: "reader.ts", find: `if (crc32(payload) !== h.crc) throw new CorruptReplayError("crc_mismatch", \`frame \${i}: crc32 incorrecto\`);`, replace: `/* mutante */` },
  { id: "M-T2-fragment-sha-unchecked-on-read", group: "T2", file: "reader.ts", find: `if (sha256(payload).toString("hex") !== entry.sha256)`, replace: `if (false)` },
  { id: "M-T2-major-unchecked", group: "T2", file: "format.ts", find: `if (b[4] !== MAJOR)`, replace: `if (false)` },
  { id: "M-T3-chain-not-bound-to-header", group: "T3", file: "reader.ts", find: `let chain = sha256(headerFrame);`, replace: `let chain: Buffer = sha256(Buffer.alloc(0));` },
  { id: "M-T3-verify-fragment-sha-unchecked", group: "T3", file: "verify.ts", find: `if (expectSha !== null && sha256(payload).toString("hex") !== expectSha)`, replace: `if (false)` },
  { id: "M-T3-battleid-unchecked", group: "T3", file: "reader.ts", find: `header.battleId !== opts.expectBattleId`, replace: `false` },
  { id: "M-T4-footer-magic-unchecked", group: "T4", file: "format.ts", find: `|| !b.subarray(0, 4).equals(FOOTER_MAGIC)`, replace: `` },
  { id: "M-T4-complete-flag-unchecked", group: "T4", file: "format.ts", find: `if ((flags & FLAG_COMPLETE) === 0)`, replace: `if (false)` },
  { id: "M-T4-scan-counts-nothing", group: "T4", file: "verify.ts", find: `if (fh.type === FT.data) data++;`, replace: `/* mutante */` },
  { id: "M-T5-limit-off-by-one", group: "T5", file: "writer.ts", find: `if (this.offset + frameLen > limit)`, replace: `if (this.offset + frameLen >= limit)` },
  { id: "M-T5-limit-only-first-fragments", group: "T5", file: "writer.ts", find: `if (this.offset + frameLen > limit)`, replace: `if (this.entries.length < 2 && this.offset + frameLen > limit)` },
  { id: "M-T5-truncated-flag-lost", group: "T5", file: "writer.ts", find: `return this.finish({ ...opts, truncated: true });`, replace: `return this.finish({ ...opts, truncated: false });` },
  { id: "M-T6-enospc-not-typed", group: "T6", file: "errors.ts", find: `c === "ENOSPC" || c === "EDQUOT"`, replace: `c === "EDQUOT"` },
  { id: "M-T6-eio-not-typed", group: "T6", file: "errors.ts", find: `if (c === "EIO")`, replace: `if (false)` },
  { id: "M-T6-writer-not-poisoned", group: "T6", file: "writer.ts", find: `this.state = "failed";\n      this.failure = err;`, replace: `this.failure = err;` },
  { id: "M-T6-failed-writer-keeps-accepting", group: "T6", file: "writer.ts", find: `if (this.state === "failed") throw this.failure!;`, replace: `/* mutante */` },
  { id: "M-T7-buffer-unbounded", group: "T7", file: "writer.ts", find: `if (this.bufBytes >= this.o.fragmentBytes) await this.flushFragment();`, replace: `/* mutante */` },
  { id: "M-T7-newline-accepted", group: "T7", file: "writer.ts", find: `if (line.includes("\\n"))`, replace: `if (false)` },
  { id: "M-T8-buffer-unbounded", group: "T8", file: "writer.ts", find: `if (this.bufBytes >= this.o.fragmentBytes) await this.flushFragment();`, replace: `/* mutante */` },
  {
    id: "M-T8-cursor-loads-everything",
    group: "T8",
    file: "reader.ts",
    find: `    for (const i of this.fragmentsForTicks(from, to)) {\n      for (const line of await this.readRecords(i)) yield line;\n    }`,
    replace: `    const all: string[] = [];\n    for (const i of this.fragmentsForTicks(from, to)) {\n      for (const line of await this.readRecords(i)) all.push(line);\n    }\n    for (const l of all) yield l;`,
  },
  { id: "M-T8-seek-reads-all", group: "T8", file: "reader.ts", find: `if (f.type === FT.data && f.lastTick! >= fromTick && f.firstTick! <= toTick) out.push(i);`, replace: `if (f.type === FT.data) out.push(i);` },
  { id: "M-T9-overwrites-published", group: "T9", file: "publish.ts", find: `if (await fs.exists(finalPath))`, replace: `if (false)` },
  { id: "M-T9-recipe-before-view", group: "T9", file: "publish.ts", find: `  if (pair.view) await publishPartial(pair.view.partial, pair.view.final, opts);\n  await publishPartial(pair.recipe.partial, pair.recipe.final, opts);`, replace: `  await publishPartial(pair.recipe.partial, pair.recipe.final, opts);\n  if (pair.view) await publishPartial(pair.view.partial, pair.view.final, opts);` },
];

function run(group) {
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", TEST, "-t", `${group} `, "--maxWorkers=1"], { cwd: root, encoding: "utf8" });
  return r.status;
}

const only = new Set(process.argv.slice(2));
const base = {};
let survivors = 0;
for (const m of MUTANTS) {
  if (only.size && !only.has(m.id)) continue;
  if (!(m.group in base)) base[m.group] = run(m.group);
  if (base[m.group] !== 0) {
    console.log(`${m.id}: BASE ROJA (rc ${base[m.group]}), no calibrable`);
    survivors++;
    continue;
  }
  const f = src(m.file);
  const orig = readFileSync(f, "utf8");
  const n = orig.split(m.find).length - 1;
  if (n !== 1) {
    console.log(`${m.id}: patrón con ${n} apariciones en ${m.file}`);
    survivors++;
    continue;
  }
  try {
    writeFileSync(f, orig.replace(m.find, () => m.replace));
    const rc = run(m.group);
    const killed = rc !== 0;
    if (!killed) survivors++;
    console.log(`${m.id}: ${killed ? "MUERTO (test en rojo, rc " + rc + ")" : "SOBREVIVE (rc 0)"}`);
  } finally {
    writeFileSync(f, orig);
  }
}
console.log(`supervivientes/errores: ${survivors}`);
process.exit(survivors ? 1 : 0);
