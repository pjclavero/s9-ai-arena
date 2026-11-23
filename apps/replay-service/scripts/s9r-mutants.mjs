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
const HARD = "apps/replay-service/tests/s9r/s9r-hardening.test.ts";

export const MUTANTS = [
  {
    id: "M-T1-drop-last-record",
    group: "T1",
    file: "writer.ts",
    find: `this.lines.join("\\n") + "\\n"`,
    replace: `this.lines.slice(0, -1).join("\\n") + "\\n"`,
  },
  {
    id: "M-T1-filehash-not-updated",
    group: "T1",
    file: "writer.ts",
    find: `this.fileHash.update(buf);`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T2-footer-reserved-unchecked",
    group: "T2",
    file: "format.ts",
    find: `if (!b.subarray(52, 64).equals(Buffer.alloc(12)))`,
    replace: `if (false)`,
  },
  {
    id: "M-T2-preamble-reserved-unchecked",
    group: "T2",
    file: "format.ts",
    find: `if (b[7] !== 0)`,
    replace: `if (false)`,
  },
  {
    id: "M-T2-index-sha-unchecked",
    group: "T2",
    file: "reader.ts",
    find: `if (!sha256(indexFrame).equals(footer.indexSha256))`,
    replace: `if (false)`,
  },
  {
    id: "M-T2-crc-unchecked-on-read",
    group: "T2",
    file: "reader.ts",
    find: `if (crc32(payload) !== h.crc) throw new CorruptReplayError("crc_mismatch", \`frame \${i}: crc32 incorrecto\`);`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T2-fragment-sha-unchecked-on-read",
    group: "T2",
    file: "reader.ts",
    find: `if (sha256(payload).toString("hex") !== entry.sha256)`,
    replace: `if (false)`,
  },
  { id: "M-T2-major-unchecked", group: "T2", file: "format.ts", find: `if (b[4] !== MAJOR)`, replace: `if (false)` },
  {
    id: "M-T3-chain-not-bound-to-header",
    group: "T3",
    file: "reader.ts",
    find: `let chain = sha256(headerFrame);`,
    replace: `let chain: Buffer = sha256(Buffer.alloc(0));`,
  },
  {
    id: "M-T3-verify-fragment-sha-unchecked",
    group: "T3",
    file: "verify.ts",
    find: `if (expectSha !== null && sha256(payload).toString("hex") !== expectSha)`,
    replace: `if (false)`,
  },
  {
    id: "M-T3-battleid-unchecked",
    group: "T3",
    file: "reader.ts",
    find: `header.battleId !== opts.expectBattleId`,
    replace: `false`,
  },
  {
    id: "M-T4-footer-magic-unchecked",
    group: "T4",
    file: "format.ts",
    find: `|| !b.subarray(0, 4).equals(FOOTER_MAGIC)`,
    replace: ``,
  },
  {
    id: "M-T4-complete-flag-unchecked",
    group: "T4",
    file: "format.ts",
    find: `if ((flags & FLAG_COMPLETE) === 0)`,
    replace: `if (false)`,
  },
  {
    id: "M-T4-scan-counts-nothing",
    group: "T4",
    file: "verify.ts",
    find: `if (fh.type === FT.data) data++;`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T5-limit-off-by-one",
    group: "T5",
    file: "writer.ts",
    find: `if (this.offset + frameLen > limit)`,
    replace: `if (this.offset + frameLen >= limit)`,
  },
  {
    id: "M-T5-limit-only-first-fragments",
    group: "T5",
    file: "writer.ts",
    find: `if (this.offset + frameLen > limit)`,
    replace: `if (this.entries.length < 2 && this.offset + frameLen > limit)`,
  },
  {
    id: "M-T5-truncated-flag-lost",
    group: "T5",
    file: "writer.ts",
    find: `return this.finish({ ...opts, truncated: true });`,
    replace: `return this.finish({ ...opts, truncated: false });`,
  },
  {
    id: "M-T6-enospc-not-typed",
    group: "T6",
    file: "errors.ts",
    find: `c === "ENOSPC" || c === "EDQUOT"`,
    replace: `c === "EDQUOT"`,
  },
  { id: "M-T6-eio-not-typed", group: "T6", file: "errors.ts", find: `if (c === "EIO")`, replace: `if (false)` },
  {
    id: "M-T6-writer-not-poisoned",
    group: "T6",
    file: "writer.ts",
    find: `this.state = "failed";\n      this.failure = err;`,
    replace: `this.failure = err;`,
  },
  {
    id: "M-T6-failed-writer-keeps-accepting",
    group: "T6",
    file: "writer.ts",
    find: `if (this.state === "failed") throw this.failure!;`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T7-buffer-unbounded",
    group: "T7",
    file: "writer.ts",
    find: `if (this.bufBytes >= this.o.fragmentBytes) await this.flushInner();`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T7-newline-accepted",
    group: "T7",
    file: "writer.ts",
    find: `if (line.includes("\\n"))`,
    replace: `if (false)`,
  },
  {
    id: "M-T8-buffer-unbounded",
    group: "T8",
    file: "writer.ts",
    find: `if (this.bufBytes >= this.o.fragmentBytes) await this.flushInner();`,
    replace: `/* mutante */`,
  },
  {
    id: "M-T8-cursor-loads-everything",
    group: "T8",
    file: "reader.ts",
    find: `    for (const i of this.fragmentsForTicks(from, to)) {\n      for (const line of await this.readRecords(i)) yield line;\n    }`,
    replace: `    const all: string[] = [];\n    for (const i of this.fragmentsForTicks(from, to)) {\n      for (const line of await this.readRecords(i)) all.push(line);\n    }\n    for (const l of all) yield l;`,
  },
  {
    id: "M-T8-seek-reads-all",
    group: "T8",
    file: "reader.ts",
    find: `if (f.type === FT.data && f.lastTick! >= fromTick && f.firstTick! <= toTick) out.push(i);`,
    replace: `if (f.type === FT.data) out.push(i);`,
  },
  {
    id: "M-T9-overwrites-published",
    group: "T9",
    file: "publish.ts",
    find: `await fs.link(partialPath, finalPath);`,
    replace: `await fs.rename(partialPath, finalPath);`,
  },
  {
    id: "M-T9-recipe-before-view",
    group: "T9",
    file: "publish.ts",
    find: `  if (pair.view) await linkPublish(pair.view.partial, pair.view.final, fs);\n  await linkPublish(pair.recipe.partial, pair.recipe.final, fs);`,
    replace: `  await linkPublish(pair.recipe.partial, pair.recipe.final, fs);\n  if (pair.view) await linkPublish(pair.view.partial, pair.view.final, fs);`,
  },
  {
    id: "M-T10-no-serialization",
    group: "T10",
    file: "writer.ts",
    find: "const run = this.tail.then(fn);",
    replace: "const run = fn();",
  },
  {
    id: "M-T10-no-backpressure",
    group: "T10",
    file: "writer.ts",
    find: "if (this.queuedBytes + bytes > this.o.maxQueuedBytes) {",
    replace: "if (false) {",
  },
  {
    id: "M-T10-bad-tick-accepted",
    group: "T10",
    file: "writer.ts",
    find: "if (!Number.isSafeInteger(tick))",
    replace: "if (false)",
  },
  {
    id: "M-T11-close-after-limit",
    group: "T11",
    file: "writer.ts",
    find: "private assertNoLimit(): void {\n    if (this.limitHit) {",
    replace: "private assertNoLimit(): void {\n    if (false) {",
  },
  {
    id: "M-T11-limit-not-flagged",
    group: "T11",
    file: "writer.ts",
    find: "this.limitHit = true;\n      throw new ReplayLimitExceededError(limit, this.offset + frameLen);",
    replace: "throw new ReplayLimitExceededError(limit, this.offset + frameLen);",
  },
  {
    id: "M-T12-index-object-unchecked",
    group: "T12",
    file: "validate.ts",
    find: 'if (typeof x !== "object" || x === null || Array.isArray(x)) return bad("no es un objeto");',
    replace: "/* mutante */",
  },
  {
    id: "M-T12-json-unwrapped",
    group: "T12",
    file: "validate.ts",
    find: 'throw new CorruptReplayError("bad_json", `${what}: JSON inv\u00e1lido`, { cause: e });',
    replace: "throw e;",
  },
  {
    id: "M-T12-header-unchecked",
    group: "T12",
    file: "validate.ts",
    find: 'throw new CorruptReplayError("bad_header", "la cabecera no es un objeto JSON");',
    replace: "/* mutante */",
  },
  {
    id: "M-T12-records-sum-unchecked",
    group: "T12",
    file: "validate.ts",
    find: 'if (records !== d.records) return bad("records no suma los fragmentos");',
    replace: "/* mutante */",
  },
  {
    id: "M-T12-fragment-type-unchecked",
    group: "T12",
    file: "validate.ts",
    find: 'if (e.type !== FT.data && e.type !== FT.result) return bad("type de fragmento");',
    replace: "/* mutante */",
  },
  {
    id: "M-T12-fragments-array-unchecked",
    group: "T12",
    file: "validate.ts",
    find: 'if (!Array.isArray(d.fragments)) return bad("fragments");',
    replace: "/* mutante */",
  },
  {
    id: "M-T12-verify-lines-unchecked",
    group: "T12",
    file: "verify.ts",
    find: "if (nl !== records || raw[raw.length - 1] !== 10)",
    replace: "if (false)",
  },
  {
    id: "M-T12-read-lines-unchecked",
    group: "T12",
    file: "reader.ts",
    find: "if (lines.length !== this.index.fragments[i].records)",
    replace: "if (false)",
  },
  {
    id: "M-T13-bomb-reader",
    group: "T13",
    file: "reader.ts",
    find: "decompress(this.algo, payload, entry.rawLen)",
    replace: "decompress(this.algo, payload, 8 * 1024 * 1024)",
  },
  {
    id: "M-T13-bomb-verify",
    group: "T13",
    file: "verify.ts",
    find: "rawLen ?? MAX_META_BYTES",
    replace: "8 * 1024 * 1024",
  },
  {
    id: "M-T13-rawlen-cap-unchecked",
    group: "T13",
    file: "validate.ts",
    find: " || e.rawLen > maxRawBytes",
    replace: "",
  },
  {
    id: "M-T13-writer-config-unchecked",
    group: "T13",
    file: "writer.ts",
    find: "if (o.fragmentBytes + o.maxRecordBytes > MAX_RAW_FRAGMENT_BYTES) {",
    replace: "if (false) {",
  },
  {
    id: "M-T14-mode-666",
    group: "T14",
    file: "io.ts",
    find: "0o640",
    replace: "0o666",
  },
  {
    id: "M-T14-no-fsync",
    group: "T14",
    file: "writer.ts",
    find: 'await this.guard("fsync", () => this.file.sync());',
    replace: "/* mutante */",
  },
  {
    id: "M-T14-no-syncdir-partial",
    group: "T14",
    file: "publish.ts",
    find: "if (dirname(partialPath) !== dirname(finalPath)) await fs.syncDir(dirname(partialPath));",
    replace: "/* mutante */",
  },
  {
    id: "M-T14-no-syncdir-final",
    group: "T14",
    file: "publish.ts",
    find: "await fs.syncDir(dirname(finalPath));",
    replace: "/* mutante */",
  },
  {
    id: "M-T15-publish-overwrites",
    group: "T15",
    file: "publish.ts",
    find: "await fs.link(partialPath, finalPath);",
    replace: "await fs.rename(partialPath, finalPath);",
  },
  {
    id: "M-T16-backpressure-not-lossy",
    group: "T16",
    file: "writer.ts",
    find: "      this.markLoss(seq);\n      return Promise.reject(",
    replace: "      return Promise.reject(",
  },
  {
    id: "M-T16-invalid-not-lossy",
    group: "T16",
    file: "writer.ts",
    find: "const reject = (e: InvalidRecordError): never => {\n      this.markLoss(seq);\n",
    replace: "const reject = (e: InvalidRecordError): never => {\n",
  },
  {
    id: "M-T16-close-ignores-loss",
    group: "T16",
    file: "writer.ts",
    find: "if (this.lostFromSeq !== null) throw this.lossError();\n    if (this.limitHit) {",
    replace: "if (false) throw this.lossError();\n    if (this.limitHit) {",
  },
  {
    id: "M-T16-prefix-dropped",
    group: "T16",
    file: "writer.ts",
    find: "      if (!this.limitHit) {\n        try {\n          await this.flushInner();",
    replace: "      if (false) {\n        try {\n          await this.flushInner();",
  },
  {
    id: "M-T17-no-open-check",
    group: "T17",
    file: "publish.ts",
    find: "const r = await S9rReader.open(path, { fs: opts.fs });",
    replace: "const r = { truncated: false, close: async () => undefined } as any;",
  },
  {
    id: "M-T17-truncated-allowed",
    group: "T17",
    file: "publish.ts",
    find: "if (truncated && !opts.allowTruncated) {",
    replace: "if (false) {",
  },
  {
    id: "M-T17-pair-no-precheck",
    group: "T17",
    file: "publish.ts",
    find: "await assertPublishable(pair.recipe.partial, opts);",
    replace: "/* mutante */",
  },
  {
    id: "M-T17-sha-not-verified",
    group: "T17",
    file: "publish.ts",
    find: "if (opts.expectSha256 !== undefined) {",
    replace: "if (false) {",
  },
  {
    id: "M-T18-truncated-is-ok",
    group: "T18",
    file: "verify.ts",
    find: "ok: !incomplete,",
    replace: "ok: true,",
  },
  {
    id: "M-T18-truncated-no-reason",
    group: "T18",
    file: "verify.ts",
    find: 'reason: "truncated" as const,',
    replace: "",
  },
  {
    id: "M-T19-no-quarantine",
    group: "T19",
    file: "writer.ts",
    find: "await this.quarantine();",
    replace: "/* mutante */",
  },
  {
    id: "M-T19-result-json-unchecked-verify",
    group: "T19",
    file: "verify.ts",
    find: 'if (type === FT.result) parseJson(raw, "resultado");',
    replace: "/* mutante */",
  },
  {
    id: "M-T19-result-untyped-read",
    group: "T19",
    file: "reader.ts",
    find: 'parseJson(await this.readFragment(i), "resultado")',
    replace: 'JSON.parse((await this.readFragment(i)).toString("utf8"))',
  },
  {
    id: "M-T20-no-truncate",
    group: "T20",
    file: "writer.ts",
    find: "await this.file.truncate(this.footerOffset);",
    replace: "/* mutante */",
  },
  {
    id: "M-T20-no-pwrite-fallback",
    group: "T20",
    file: "writer.ts",
    find: "await this.file.writeAt(Buffer.alloc(FOOTER_LEN), this.footerOffset);",
    replace: "/* mutante */",
  },
  {
    id: "M-T20-no-unlink-last-resort",
    group: "T20",
    file: "writer.ts",
    find: "await this.fs.unlink(this.path);",
    replace: "/* mutante */",
  },
  {
    id: "M-T20-reader-accepts-failed",
    group: "T20",
    file: "reader.ts",
    find: 'if (path.endsWith(".failed"))',
    replace: "if (false)",
  },
  {
    id: "M-T20-publish-accepts-failed",
    group: "T20",
    file: "publish.ts",
    find: 'if (path.endsWith(".failed")) throw new CorruptReplayError("failed_file", "fichero .failed: nunca se publica");',
    replace: "",
  },
  {
    id: "M-T20-publish-any-name",
    group: "T20",
    file: "publish.ts",
    find: 'if (!path.endsWith(".part"))',
    replace: "if (false)",
  },
  {
    id: "M-T21-undefined-serializes",
    group: "T21",
    file: "writer.ts",
    find: 'if (typeof l !== "string") throw new TypeError("el registro no es serializable a JSON");',
    replace: "",
  },
  {
    id: "M-T21-serialization-not-lossy",
    group: "T21",
    file: "writer.ts",
    find: "} catch (cause) {\n      this.markLoss(seq);",
    replace: "} catch (cause) {",
  },
  {
    id: "M-T21-internal-not-poisoned",
    group: "T21",
    file: "writer.ts",
    find: 'const err = toStorageError(e, "internal");',
    replace: "throw e;",
  },
  {
    id: "M-T21-close-truncated-option",
    group: "T21",
    file: "writer.ts",
    find: "return this.finish({ result: opts.result, truncated: false });",
    replace: "return this.finish(opts as any);",
  },
  {
    id: "M-T22-no-rollback",
    group: "T22",
    file: "publish.ts",
    find: "for (const f of linked.reverse()) await fs.unlink(f).catch(() => undefined);",
    replace: "void linked;",
  },
  {
    id: "M-T22-view-sha-ignored",
    group: "T22",
    file: "publish.ts",
    find: "await assertPublishable(pair.view.partial, opts, opts.expectViewSha256);",
    replace: "await assertPublishable(pair.view.partial, opts, undefined);",
  },
];

function run(group) {
  const test = /^T(1[0-9]|2[0-9])$/.test(group) ? HARD : TEST;
  const r = spawnSync("nice", ["-n", "19", "npx", "vitest", "run", test, "-t", `${group} `, "--maxWorkers=1"], {
    cwd: root,
    encoding: "utf8",
  });
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
    writeFileSync(
      f,
      orig.replace(m.find, () => m.replace),
    );
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
