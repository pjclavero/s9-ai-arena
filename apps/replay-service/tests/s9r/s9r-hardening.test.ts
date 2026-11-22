/**
 * S9R/1 · endurecimiento tras la revisión de #332: concurrencia, límite+cierre, ficheros
 * fabricados, bombas de descompresión, permisos y publicación sin sobrescribir.
 * Cada test T<n> tiene mutante nombrado en apps/replay-service/scripts/s9r-mutants.mjs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CorruptReplayError,
  InvalidRecordError,
  ReplayLimitExceededError,
  S9rReader,
  S9rWriter,
  WriterStateError,
  nodeFs,
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
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "backpressure" });
    await w.close();
    expect((await verifyFile(f)).ok).toBe(true);
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
    expect(v.ok).toBe(true);
    expect(v.truncated).toBe(true);
    expect(v.records!).toBeLessThan(500);
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
