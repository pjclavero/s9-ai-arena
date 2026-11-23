/**
 * S9R/1 · endurecimiento tras la revisión de #332: concurrencia, límite+cierre, ficheros
 * fabricados, bombas de descompresión, permisos y publicación sin sobrescribir.
 * Cada test T<n> tiene mutante nombrado en apps/replay-service/scripts/s9r-mutants.mjs.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CorruptReplayError,
  InvalidRecordError,
  S9rError,
  ReplayLimitExceededError,
  S9rReader,
  S9rWriter,
  WriterStateError,
  nodeFs,
  IncompleteReplayError,
  StorageIoError,
  TruncatedReplayError,
  publishPair,
  publishPartial,
  verifyFile,
  type S9rFs,
} from "../../src/s9r/index.js";
import { compress, crc32, sha256 } from "../../src/s9r/codec.js";
import {
  FLAG_COMPLETE,
  FLAG_TRUNCATED,
  FT,
  encodeFooter,
  encodeFrameHeader,
  encodePreamble,
} from "../../src/s9r/format.js";
import { computeChain } from "../../src/s9r/reader.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "s9r-h-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const p = (name: string) => join(dir, `${++seq}-${name}`);
const rec = (t: number) => JSON.stringify({ k: "c", t, v: "veh1", c: { thr: (t % 7) / 7 } });

async function frame(type: number, raw: Buffer): Promise<{ frame: Buffer; comp: Buffer }> {
  const comp = await compress("gzip", raw);
  return { frame: Buffer.concat([encodeFrameHeader(type, comp.length, crc32(comp)), comp]), comp };
}

interface ForgedFragment {
  type: number;
  raw: Buffer;
  /** Para forjar un índice que miente sobre la longitud. */
  rawLenDeclared?: number;
  recordsDeclared?: number;
}
/** Fabrica un fichero con crc, sha, cadena y pie CORRECTOS pero contenido de cabecera/índice a medida. */
async function forge(
  path: string,
  o: { header?: string; fragments?: ForgedFragment[]; index?: (doc: any) => unknown } = {},
): Promise<void> {
  const header = await frame(FT.header, Buffer.from(o.header ?? '{"battleId":"x"}'));
  const frames: Buffer[] = [];
  const entries: any[] = [];
  let offset = 8 + header.frame.length;
  let records = 0;
  let rawBytes = 0;
  for (const f of o.fragments ?? [{ type: FT.data, raw: Buffer.from(rec(0) + "\n") }]) {
    const fr = await frame(f.type, f.raw);
    const lines = f.raw.toString().split("\n").length - 1;
    const recs = f.type === FT.data ? (f.recordsDeclared ?? lines) : 0;
    entries.push({
      type: f.type,
      offset,
      frameLen: fr.frame.length,
      rawLen: f.rawLenDeclared ?? f.raw.length,
      sha256: sha256(fr.comp).toString("hex"),
      firstTick: f.type === FT.data ? 0 : null,
      lastTick: f.type === FT.data ? 0 : null,
      records: recs,
    });
    frames.push(fr.frame);
    offset += fr.frame.length;
    records += recs;
    rawBytes += f.rawLenDeclared ?? f.raw.length;
  }
  const doc: any = {
    formatVersion: 1,
    kind: "R",
    algo: "gzip",
    headerFrameLen: header.frame.length,
    fragments: entries,
    chain: computeChain(
      header.frame,
      entries.map((e) => e.sha256),
    ),
    records,
    rawBytes,
    truncated: false,
  };
  const custom = o.index ? o.index(doc) : doc;
  const indexRaw = Buffer.from(typeof custom === "string" ? custom : JSON.stringify(custom));
  const idx = await frame(FT.index, indexRaw);
  const footer = encodeFooter({
    flags: FLAG_COMPLETE | (doc.truncated ? FLAG_TRUNCATED : 0),
    indexOffset: offset,
    indexLen: idx.frame.length,
    indexSha256: sha256(idx.frame),
  });
  writeFileSync(path, Buffer.concat([encodePreamble("R", "gzip"), header.frame, ...frames, idx.frame, footer]));
}

async function newWriter(path: string, extra: Record<string, unknown> = {}, fs?: S9rFs) {
  return S9rWriter.create(path, {
    kind: "R",
    header: { battleId: "h" },
    maxBytes: 1 << 20,
    fragmentBytes: 300,
    fs,
    ...extra,
  });
}

describe("T10 serialización interna del escritor", () => {
  it("T10 appends lanzados sin await producen un fichero íntegro y en orden", async () => {
    const f = p("conc.s9r");
    const w = await newWriter(f, { maxQueuedBytes: 1 << 20 });
    const sent: string[] = [];
    const pending: Promise<void>[] = [];
    for (let t = 0; t < 60; t++) {
      sent.push(rec(t));
      pending.push(w.append(rec(t), t));
    }
    const closing = w.close({ result: { ok: true } });
    await Promise.all(pending);
    const sum = await closing;
    expect(sum.records).toBe(60);
    const v = await verifyFile(f);
    expect(v.ok, v.error?.message).toBe(true);
    const r = await S9rReader.open(f);
    const got: string[] = [];
    for await (const l of r.records()) got.push(l);
    expect(got).toEqual(sent);
    await r.close();
  });

  it("T10 la cola interna está acotada: sin await, el exceso se rechaza con backpressure y no se corrompe nada", async () => {
    const f = p("bp.s9r");
    const w = await newWriter(f, { maxQueuedBytes: 1000 });
    const res = await Promise.allSettled(Array.from({ length: 100 }, (_, t) => w.append(rec(t), t)));
    const rejected = res.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.some((r) => r.reason.code === "backpressure")).toBe(true);
    // tras la primera pérdida, el resto se rechaza para conservar el prefijo
    for (const r of rejected) expect(["backpressure", "records_dropped"]).toContain(r.reason.code);
    // los rechazados por contrapresión son registros PERDIDOS: no se puede sellar como completo
    const accepted = res.filter((x) => x.status === "fulfilled").length;
    await expect(w.close()).rejects.toMatchObject({ code: "records_dropped" });
    const sum = await w.closeTruncated();
    expect(sum.truncated).toBe(true);
    expect(sum.records).toBe(accepted);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("truncated");
    expect(v.records).toBe(accepted);
  });

  it("T10 un tick que no es entero se rechaza (no podría indexarse)", async () => {
    const w = await newWriter(p("tick.s9r"));
    await expect(w.append(rec(1), Number.NaN)).rejects.toBeInstanceOf(InvalidRecordError);
    await w.abort();
  });
});

describe("T11 límite de bytes y cierre", () => {
  it("T11 tras ReplayLimitExceededError, close() lanza limit_hit; sólo closeTruncated cierra y queda marcado truncado", async () => {
    const f = p("limit.s9r");
    const w = await newWriter(f, { maxBytes: 1200, emergencyBytes: 4096 });
    let hit: unknown;
    let sent = 0;
    for (let t = 0; t < 500 && !hit; t++) {
      try {
        await w.append(rec(t), t);
        sent++;
      } catch (e) {
        hit = e;
      }
    }
    expect(hit).toBeInstanceOf(ReplayLimitExceededError);
    await expect(w.close({ result: { x: 1 } })).rejects.toMatchObject({ code: "limit_hit" });
    await expect(w.close()).rejects.toBeInstanceOf(WriterStateError);
    // los registros siguientes tampoco se aceptan en silencio
    await expect(w.append(rec(999), 999)).rejects.toMatchObject({ code: "limit_hit" });
    const sum = await w.closeTruncated({ result: { endReason: "recording_limit" } });
    expect(sum.truncated).toBe(true);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("truncated");
    expect(v.truncated).toBe(true);
    expect(v.records!).toBeLessThan(500);
    expect((await verifyFile(f, { allowTruncated: true })).ok).toBe(true);
    expect(sent).toBeGreaterThan(0);
  });
});

describe("T12 ficheros fabricados: sólo errores tipados", () => {
  const cases: { name: string; code: string; build: (f: string) => Promise<void>; expectBattleId?: string }[] = [
    { name: "índice null", code: "bad_index", build: (f) => forge(f, { index: () => "null" }) },
    { name: "índice con JSON inválido", code: "bad_json", build: (f) => forge(f, { index: () => "{{" }) },
    {
      name: "índice sin fragments",
      code: "bad_index",
      build: (f) =>
        forge(f, {
          index: (d) => {
            delete d.fragments;
            return d;
          },
        }),
    },
    { name: "cabecera null", code: "bad_header", build: (f) => forge(f, { header: "null" }), expectBattleId: "x" },
    { name: "cabecera con JSON inválido", code: "bad_json", build: (f) => forge(f, { header: "{" }) },
    {
      name: "fragmento con type de índice",
      code: "bad_index",
      build: (f) => forge(f, { fragments: [{ type: FT.index, raw: Buffer.from("{}") }] }),
    },
    {
      name: "records del índice no suma los fragmentos",
      code: "bad_index",
      build: (f) =>
        forge(f, {
          index: (d) => {
            d.records = 999;
            return d;
          },
        }),
    },
    {
      name: "líneas distintas de las que declara el índice",
      code: "records_mismatch",
      build: (f) => forge(f, { fragments: [{ type: FT.data, raw: Buffer.from(rec(0) + "\n"), recordsDeclared: 5 }] }),
    },
  ];
  for (const c of cases) {
    it(`T12 ${c.name}: verifyFile devuelve ok:false (${c.code}) y open lanza un S9rError, nunca TypeError/SyntaxError`, async () => {
      const f = p("forged.s9r");
      await c.build(f);
      const v = await verifyFile(f, { expectBattleId: c.expectBattleId });
      expect(v.ok).toBe(false);
      expect(v.error).toBeInstanceOf(CorruptReplayError);
      expect(v.error!.code).toBe(c.code);
      if (c.code === "records_mismatch") {
        // el lector también lo detecta al recorrer el fragmento
        const r = await S9rReader.open(f);
        await expect(
          (async () => {
            for await (const _ of r.records());
          })(),
        ).rejects.toMatchObject({ code: "records_mismatch" });
        await r.close();
      } else {
        const e = await S9rReader.open(f, { expectBattleId: c.expectBattleId }).catch((x) => x);
        expect(e).toBeInstanceOf(CorruptReplayError);
        expect(e.code).toBe(c.code);
      }
    });
  }
});

describe("T13 bomba de descompresión y topes de lectura", () => {
  it("T13 un fragmento que se expande mucho más de lo que declara el índice falla como decompress_failed", async () => {
    const f = p("bomb.s9r");
    // 6 MiB de ceros (por debajo del tope de formato) frente a un índice que declara 100 B.
    await forge(f, {
      fragments: [{ type: FT.data, raw: Buffer.alloc(6 * 1024 * 1024), rawLenDeclared: 100, recordsDeclared: 1 }],
    });
    const r = await S9rReader.open(f);
    await expect(r.readFragment(0)).rejects.toMatchObject({ code: "decompress_failed" });
    await r.close();
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error!.code).toBe("decompress_failed");
  });

  it("T13 un rawLen declarado por encima del tope de lectura se rechaza al abrir, y el tope es configurable", async () => {
    const f = p("cap.s9r");
    await forge(f, {
      fragments: [{ type: FT.data, raw: Buffer.from(rec(0) + "\n"), rawLenDeclared: 9 * 1024 * 1024 }],
    });
    await expect(S9rReader.open(f)).rejects.toMatchObject({ code: "bad_index" });
    const g = p("cap2.s9r");
    const w = await newWriter(g);
    for (let t = 0; t < 10; t++) await w.append(rec(t), t);
    await w.close();
    expect((await verifyFile(g)).ok).toBe(true);
    await expect(S9rReader.open(g, { maxRawBytes: 10 })).rejects.toMatchObject({ code: "bad_index" });
    const v = await verifyFile(g, { maxRawBytes: 10 });
    expect(v.ok).toBe(false);
  });

  it("T13 el escritor rechaza configuraciones que superen el tope de lectura", async () => {
    await expect(newWriter(p("big.s9r"), { fragmentBytes: 8 * 1024 * 1024 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("T14 permisos y fsync", () => {
  it("T14 el fichero se crea 0640: sin ejecución, sin escritura de grupo y sin acceso a «otros»", async () => {
    const f = p("perm.s9r");
    const w = await newWriter(f);
    await w.append(rec(0), 0);
    await w.close();
    expect(statSync(f).mode & 0o137).toBe(0);
  });

  it("T14 cierra con fsync del fichero y publica con fsync de los directorios del parcial y del destino", async () => {
    const calls: string[] = [];
    const fs2: S9rFs = {
      ...nodeFs,
      create: async (path) => {
        const fh = await nodeFs.create(path);
        return {
          ...fh,
          sync: async () => {
            calls.push("fsync");
            return fh.sync();
          },
        };
      },
      syncDir: async (d) => {
        calls.push(`syncDir:${d}`);
        return nodeFs.syncDir(d);
      },
    };
    const partDir = join(dir, "partial-dir");
    const finDir = join(dir, "final-dir");
    mkdirSync(partDir, { recursive: true });
    mkdirSync(finDir, { recursive: true });
    const part = join(partDir, "a.s9r.part");
    const fin = join(finDir, "a.s9r");
    const w = await newWriter(part, {}, fs2);
    await w.append(rec(0), 0);
    await w.close();
    expect(calls).toEqual(["fsync"]);
    await publishPartial(part, fin, { fs: fs2 });
    expect(calls).toContain(`syncDir:${finDir}`);
    expect(calls).toContain(`syncDir:${partDir}`);
    expect((await verifyFile(fin)).ok).toBe(true);
  });
});

describe("T15 publicación sin sobrescribir", () => {
  it("T15 dos publicaciones concurrentes al mismo destino: una gana, la otra recibe final_exists y el ganador queda intacto", async () => {
    const a = p("a.part");
    const b = p("b.part");
    for (const [path, id] of [
      [a, "A"],
      [b, "B"],
    ] as const) {
      const w = await S9rWriter.create(path, { kind: "R", header: { battleId: id }, maxBytes: 1 << 20 });
      await w.append(rec(1), 1);
      await w.close();
    }
    const fin = p("race.s9r");
    const res = await Promise.allSettled([publishPartial(a, fin), publishPartial(b, fin)]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBe(1);
    const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "final_exists" });
    const winner = res[0].status === "fulfilled" ? "A" : "B";
    const r = await S9rReader.open(fin);
    expect(r.header.battleId).toBe(winner);
    await r.close();
    expect(readFileSync(fin).length).toBeGreaterThan(0);
  });
});

async function truncatedFile(path: string): Promise<void> {
  const w = await newWriter(path, { maxBytes: 1200, emergencyBytes: 4096 });
  for (let t = 0; t < 500; t++) {
    try {
      await w.append(rec(t), t);
    } catch {
      break;
    }
  }
  await w.closeTruncated({ result: { endReason: "recording_limit" } });
}
async function completeFile(path: string): Promise<void> {
  const w = await newWriter(path);
  for (let t = 0; t < 30; t++) await w.append(rec(t), t);
  await w.close({ result: { ok: true } });
}

describe("T16 un registro perdido impide sellar el fichero como completo", () => {
  it("T16 40 appends sin await con contrapresión: close() rechaza, sólo closeTruncated; queda el prefijo aceptado", async () => {
    const f = p("lossy.s9r");
    const w = await newWriter(f, { fragmentBytes: 256, maxRecordBytes: 200, maxQueuedBytes: 600 });
    const res = await Promise.allSettled(Array.from({ length: 40 }, (_, t) => w.append(rec(t), t)));
    const accepted = res.filter((x) => x.status === "fulfilled").length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(40);
    await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "records_dropped" });
    await w.closeTruncated({ result: {} });
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("truncated");
    const r = await S9rReader.open(f);
    const got: string[] = [];
    for await (const l of r.records()) got.push(l);
    expect(got).toEqual(Array.from({ length: accepted }, (_, t) => rec(t)));
    await r.close();
  });

  const causes: { name: string; line: () => string; tick: number; code: string }[] = [
    {
      name: "registro demasiado grande",
      line: () => JSON.stringify({ pad: "x".repeat(400) }),
      tick: 1,
      code: "record_too_large",
    },
    { name: "registro con salto de línea", line: () => "a\nb", tick: 1, code: "record_has_newline" },
    { name: "tick no entero", line: () => rec(1), tick: 1.5, code: "bad_tick" },
  ];
  for (const c of causes) {
    it(`T16 ${c.name}: el append se rechaza (${c.code}), close() ya no puede sellar y el resultado es un prefijo truncado`, async () => {
      const f = p("inv.s9r");
      const w = await newWriter(f, { maxRecordBytes: 200 });
      await w.append(rec(0), 0);
      await expect(w.append(c.line(), c.tick)).rejects.toMatchObject({ code: c.code });
      await expect(w.append(rec(2), 2)).rejects.toMatchObject({ code: "records_dropped" });
      await expect(w.close()).rejects.toMatchObject({ code: "records_dropped" });
      const sum = await w.closeTruncated();
      expect(sum.truncated).toBe(true);
      expect(sum.records).toBe(1);
      expect((await verifyFile(f)).ok).toBe(false);
    });
  }
});

describe("T17 publicar exige un fichero íntegro y completo", () => {
  it("T17 un parcial sin pie (proceso muerto a mitad) no se publica", async () => {
    const part = p("dead.part");
    const w = await newWriter(part);
    for (let t = 0; t < 10; t++) await w.append(rec(t), t);
    const fin = p("dead.s9r");
    await expect(publishPartial(part, fin)).rejects.toBeInstanceOf(IncompleteReplayError);
    expect(existsSync(fin)).toBe(false);
    expect(existsSync(part)).toBe(true);
    await w.abort();
  });

  it("T17 un fichero corrupto (cabecera alterada) no se publica", async () => {
    const part = p("bad.part");
    await completeFile(part);
    const b = readFileSync(part);
    b[8 + 9 + 1] ^= 0xff;
    writeFileSync(part, b);
    const fin = p("bad.s9r");
    await expect(publishPartial(part, fin)).rejects.toBeInstanceOf(CorruptReplayError);
    expect(existsSync(fin)).toBe(false);
  });

  it("T17 un truncado no se publica sin allowTruncated; con él sí y sigue marcado truncado", async () => {
    const part = p("trunc.part");
    await truncatedFile(part);
    const fin = p("trunc.s9r");
    await expect(publishPartial(part, fin)).rejects.toBeInstanceOf(TruncatedReplayError);
    expect(existsSync(fin)).toBe(false);
    await publishPartial(part, fin, { allowTruncated: true });
    const v = await verifyFile(fin);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("truncated");
  });

  it("T17 publishPair comprueba ambos antes de publicar nada: una receta truncada no deja la vista publicada", async () => {
    const vp = p("pair-v.part");
    const rp = p("pair-r.part");
    await completeFile(vp);
    await truncatedFile(rp);
    const vf = p("pair.s9v");
    const rf = p("pair.s9r");
    await expect(
      publishPair({ recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } }),
    ).rejects.toBeInstanceOf(TruncatedReplayError);
    expect(existsSync(vf)).toBe(false);
    expect(existsSync(rf)).toBe(false);
  });

  it("T17 con expectSha256 se verifica el fichero entero: un fragmento alterado no se publica", async () => {
    const part = p("sha.part");
    await completeFile(part);
    const good = await verifyFile(part);
    const r = await S9rReader.open(part);
    const frag = r.index.fragments[0];
    await r.close();
    const fin = p("sha.s9r");
    await expect(publishPartial(part, fin, { expectSha256: "0".repeat(64) })).rejects.toMatchObject({
      code: "file_sha_mismatch",
    });
    const b = readFileSync(part);
    b[frag.offset + 9 + 1] ^= 0x55;
    writeFileSync(part, b);
    await expect(publishPartial(part, fin, { expectSha256: good.sha256 })).rejects.toBeInstanceOf(CorruptReplayError);
    expect(existsSync(fin)).toBe(false);
  });
});

describe("T18 verifyFile: ok sólo si íntegro y completo", () => {
  it("T18 un truncado devuelve ok:false con reason truncated y conserva el diagnóstico", async () => {
    const f = p("v-trunc.s9r");
    await truncatedFile(f);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("truncated");
    expect(v.error).toBeInstanceOf(TruncatedReplayError);
    expect(v.integrityOk).toBe(true);
    expect(v.truncated).toBe(true);
    expect(v.records).toBeGreaterThan(0);
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.fragments).toBeGreaterThan(0);
    const ok = await verifyFile(f, { allowTruncated: true });
    expect(ok.ok).toBe(true);
    expect(ok.truncated).toBe(true);
  });
  it("T18 uno completo devuelve ok:true e integrityOk", async () => {
    const f = p("v-ok.s9r");
    await completeFile(f);
    const v = await verifyFile(f);
    expect(v.ok).toBe(true);
    expect(v.integrityOk).toBe(true);
    expect(v.reason).toBeUndefined();
  });
});

describe("T19 durabilidad y resultado", () => {
  it("T19 si falla el fsync tras escribir el pie, el fichero no queda como completo en su nombre", async () => {
    const fs2: S9rFs = {
      ...nodeFs,
      create: async (path) => {
        const fh = await nodeFs.create(path);
        return {
          ...fh,
          sync: async () => {
            throw Object.assign(new Error("EIO simulado"), { code: "EIO" });
          },
        };
      },
    };
    const f = p("fsyncfail.s9r");
    const w = await newWriter(f, {}, fs2);
    await w.append(rec(0), 0);
    await expect(w.close()).rejects.toMatchObject({ code: "storage_io" });
    expect(existsSync(f)).toBe(false);
    expect(existsSync(f + ".failed")).toBe(true);
    await expect(publishPartial(f, p("x.s9r"))).rejects.toBeDefined();
    await w.abort();
    expect(existsSync(f + ".failed")).toBe(false);
  });

  it("T19 un frame de resultado que no es JSON: verifyFile y readResult dan error tipado, no SyntaxError", async () => {
    const f = p("badresult.s9r");
    await forge(f, {
      fragments: [
        { type: FT.data, raw: Buffer.from(rec(0) + "\n") },
        { type: FT.result, raw: Buffer.from("esto no es json") },
      ],
    });
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error).toBeInstanceOf(CorruptReplayError);
    expect(v.error!.code).toBe("bad_json");
    const r = await S9rReader.open(f);
    const e = await r.readResult().catch((x) => x);
    expect(e).toBeInstanceOf(CorruptReplayError);
    expect(e.code).toBe("bad_json");
    await r.close();
  });
});

// ---------------------------------------------------------------- ronda 3
const io = (code = "EIO") => Object.assign(new Error(`${code} simulado`), { code });

/** fs cuyo fichero falla en fsync y, opcionalmente, en rename / truncate / writeAt. */
function fsyncFails(opts: { rename?: boolean; truncate?: boolean; writeAt?: boolean } = {}): S9rFs {
  return {
    ...nodeFs,
    create: async (path) => {
      const fh = await nodeFs.create(path);
      return {
        ...fh,
        sync: async () => {
          throw io();
        },
        truncate: async (n) => {
          if (opts.truncate) throw io();
          return fh.truncate(n);
        },
        writeAt: async (b, pos) => {
          if (opts.writeAt) throw io();
          return fh.writeAt(b, pos);
        },
      };
    },
    rename: async (a, b) => {
      if (opts.rename) throw io();
      return nodeFs.rename(a, b);
    },
  };
}
const asPart = (from: string): string => {
  const to = p("copy.part");
  copyFileSync(from, to);
  return to;
};

describe("T20 un fallo de fsync nunca deja algo con aspecto de completo", () => {
  it("T20 fsync falla: el fichero apartado (.failed) no verifica, no se lee ni se publica; su contenido no tiene pie", async () => {
    const f = p("g.s9r.part");
    const w = await newWriter(f, {}, fsyncFails());
    await w.append(rec(1), 1);
    await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "storage_io" });
    expect(existsSync(f)).toBe(false);
    expect(existsSync(f + ".failed")).toBe(true);
    const v = await verifyFile(f + ".failed");
    expect(v.ok).toBe(false);
    await expect(S9rReader.open(f + ".failed")).rejects.toMatchObject({ code: "failed_file" });
    await expect(publishPartial(f + ".failed", p("g.final.s9r"))).rejects.toMatchObject({ code: "failed_file" });
    // y aunque alguien le quite el nombre .failed, el CONTENIDO ya no tiene pie
    const copy = asPart(f + ".failed");
    const vc = await verifyFile(copy);
    expect(vc.ok).toBe(false);
    expect(vc.error).toBeInstanceOf(IncompleteReplayError);
    await expect(publishPartial(copy, p("g2.final.s9r"))).rejects.toBeInstanceOf(IncompleteReplayError);
    await w.abort();
    expect(existsSync(f + ".failed")).toBe(false);
  });

  it("T20 fsync Y rename fallan: el original queda en su nombre pero SIN PIE: no verifica ni se publica", async () => {
    const f = p("h.s9r.part");
    const w = await newWriter(f, {}, fsyncFails({ rename: true }));
    await w.append(rec(1), 1);
    await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "storage_io" });
    expect(existsSync(f)).toBe(true);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error).toBeInstanceOf(IncompleteReplayError);
    await expect(publishPartial(f, p("h.final.s9r"))).rejects.toBeInstanceOf(IncompleteReplayError);
    await w.abort();
  });

  it("T20 fsync, rename y ftruncate fallan: el pie se invalida con pwrite y tampoco verifica ni se publica", async () => {
    const f = p("i.s9r.part");
    const w = await newWriter(f, {}, fsyncFails({ rename: true, truncate: true }));
    await w.append(rec(1), 1);
    await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "storage_io" });
    expect(existsSync(f)).toBe(true);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error).toBeInstanceOf(IncompleteReplayError);
    await expect(publishPartial(f, p("i.final.s9r"))).rejects.toBeInstanceOf(IncompleteReplayError);
    await w.abort();
  });

  it("T20 todo falla (rename, ftruncate y pwrite): se intenta borrar el fichero", async () => {
    const f = p("j.s9r.part");
    const w = await newWriter(f, {}, fsyncFails({ rename: true, truncate: true, writeAt: true }));
    await w.append(rec(1), 1);
    await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "storage_io" });
    expect(existsSync(f)).toBe(false);
    await w.abort();
  });

  it("T20 closeTruncated con fallo de fsync: igual de seguro", async () => {
    const f = p("k.s9r.part");
    const w = await newWriter(f, {}, fsyncFails({ rename: true }));
    await w.append(rec(1), 1);
    await expect(w.closeTruncated({})).rejects.toMatchObject({ code: "storage_io" });
    expect((await verifyFile(f)).ok).toBe(false);
    await expect(publishPartial(f, p("k.final.s9r"), { allowTruncated: true })).rejects.toBeInstanceOf(
      IncompleteReplayError,
    );
    await w.abort();
  });

  it("T20 un fichero completo cuyo nombre acaba en .failed no se lee, no se verifica y no se publica", async () => {
    const good = p("ok.s9r.part");
    await completeFile(good);
    const bad = p("ok.s9r.failed");
    renameSync(good, bad);
    const v = await verifyFile(bad);
    expect(v.ok).toBe(false);
    expect(v.error!.code).toBe("failed_file");
    await expect(publishPartial(bad, p("ok.final.s9r"))).rejects.toMatchObject({ code: "failed_file" });
  });

  it("T20 sólo se publican orígenes .part: un fichero con otro nombre se rechaza", async () => {
    const f = p("origin.s9r");
    await completeFile(f);
    await expect(publishPartial(f, p("origin.final.s9r"))).rejects.toMatchObject({ code: "not_a_partial" });
    expect(existsSync(f)).toBe(true);
  });
});

describe("T21 cualquier excepción en append cuenta como registro perdido", () => {
  const circular: any = {};
  circular.self = circular;
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["referencia circular", circular],
    ["BigInt", { n: 10n }],
    ["función", () => 1],
  ];
  for (const [name, value] of cases) {
    it(`T21 ${name}: append devuelve una promesa rechazada (no lanza), y close() ya no puede sellar`, async () => {
      const f = p("ser.s9r.part");
      const w = await newWriter(f);
      await w.append(rec(0), 0);
      let pr: Promise<void> | undefined;
      expect(() => {
        pr = w.append(value as any, 1);
      }).not.toThrow();
      await expect(pr).rejects.toMatchObject({ code: "bad_record" });
      await w.append(rec(2), 2).catch(() => undefined);
      await expect(w.close({ result: {} })).rejects.toMatchObject({ code: "records_dropped" });
      const sum = await w.closeTruncated();
      expect(sum.records).toBe(1);
      expect(sum.truncated).toBe(true);
    });
  }

  it("T21 una excepción interna inesperada deja el escritor fallido (no sigue con estado dudoso)", async () => {
    const f = p("internal.s9r.part");
    const w = await newWriter(f);
    await w.append(rec(0), 0);
    (w as any).lines = 5; // estado corrupto: flush revienta con TypeError
    await expect(w.flushFragment()).rejects.toBeInstanceOf(S9rError);
    await expect(w.append(rec(1), 1)).rejects.toMatchObject({ code: "storage_error" });
    await expect(w.close()).rejects.toMatchObject({ code: "storage_error" });
    await expect(w.closeTruncated()).rejects.toMatchObject({ code: "storage_error" });
    await w.abort();
  });

  it("T21 close() no admite la segunda vía truncated:true: el fichero sale completo", async () => {
    const f = p("noway.s9r");
    const w = await newWriter(f);
    await w.append(rec(0), 0);
    const sum = await w.close({ truncated: true } as any);
    expect(sum.truncated).toBe(false);
    expect((await verifyFile(f)).ok).toBe(true);
  });
});

describe("T22 publishPair es atómico", () => {
  async function pair(tag: string) {
    const vp = p(`${tag}-v.s9v.part`);
    const rp = p(`${tag}-r.s9r.part`);
    await completeFile(vp);
    await completeFile(rp);
    return { vp, rp, vf: p(`${tag}.s9v`), rf: p(`${tag}.s9r`) };
  }

  it("T22 receta con final_exists: no queda publicada la vista y los parciales siguen en su sitio", async () => {
    const { vp, rp, vf, rf } = await pair("atom1");
    writeFileSync(rf, "ya existe");
    await expect(
      publishPair({ recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } }),
    ).rejects.toMatchObject({ code: "final_exists" });
    expect(existsSync(vf)).toBe(false);
    expect(readFileSync(rf, "utf8")).toBe("ya existe");
    expect(existsSync(vp)).toBe(true);
    expect(existsSync(rp)).toBe(true);
  });

  it("T22 error de E/S al enlazar la receta: se deshace la vista", async () => {
    const { vp, rp, vf, rf } = await pair("atom2");
    const fs2: S9rFs = {
      ...nodeFs,
      link: async (a, b) => {
        if (b === rf) throw io();
        return nodeFs.link(a, b);
      },
    };
    await expect(
      publishPair({ recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } }, { fs: fs2 }),
    ).rejects.toBeInstanceOf(StorageIoError);
    expect(existsSync(vf)).toBe(false);
    expect(existsSync(rf)).toBe(false);
    expect(existsSync(vp) && existsSync(rp)).toBe(true);
  });

  it("T22 fallo del fsync de directorio tras enlazar: se deshacen ambos", async () => {
    const { vp, rp, vf, rf } = await pair("atom3");
    const fs2: S9rFs = {
      ...nodeFs,
      syncDir: async () => {
        throw io();
      },
    };
    await expect(
      publishPair({ recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } }, { fs: fs2 }),
    ).rejects.toBeInstanceOf(StorageIoError);
    expect(existsSync(vf) || existsSync(rf)).toBe(false);
    expect(existsSync(vp) && existsSync(rp)).toBe(true);
  });

  it("T22 expectViewSha256 se verifica también para la vista y expectSha256 para la receta", async () => {
    const { vp, rp, vf, rf } = await pair("atom4");
    const goodR = (await verifyFile(rp)).sha256!;
    const goodV = (await verifyFile(vp)).sha256!;
    await expect(
      publishPair(
        { recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } },
        { expectSha256: goodR, expectViewSha256: "0".repeat(64) },
      ),
    ).rejects.toMatchObject({ code: "file_sha_mismatch" });
    expect(existsSync(vf) || existsSync(rf)).toBe(false);
    await publishPair(
      { recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } },
      { expectSha256: goodR, expectViewSha256: goodV },
    );
    expect(existsSync(vf) && existsSync(rf)).toBe(true);
  });
});
