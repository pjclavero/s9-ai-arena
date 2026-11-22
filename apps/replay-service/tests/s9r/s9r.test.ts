/**
 * S9R/1 · pruebas de la biblioteca de formato. Cada test T<n> tiene al menos un mutante
 * nombrado en apps/replay-service/scripts/s9r-mutants.mjs que debe ponerlo en rojo.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CorruptReplayError,
  IncompleteReplayError,
  InvalidRecordError,
  ReplayLimitExceededError,
  S9rReader,
  S9rWriter,
  StorageFullError,
  StorageIoError,
  UnsupportedFormatError,
  WriterStateError,
  algoAvailable,
  discardPartial,
  nodeFs,
  publishPair,
  publishPartial,
  scanPartial,
  verifyFile,
  type Algo,
  type S9rFs,
} from "../../src/s9r/index.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "s9r-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const p = (name: string) => join(dir, `${++seq}-${name}`);

/** Registros sintéticos deterministas (LCG): 8 vehículos por tick. */
function rec(t: number, v: number, tag = ""): string {
  const x = (Math.imul(t * 8 + v, 1103515245) + 12345) >>> 0;
  return JSON.stringify({
    k: "c",
    t,
    b: tag,
    v: `veh${v}`,
    c: { thr: (x % 2001) / 1000 - 1, turn: ((x >>> 8) % 2001) / 1000 - 1, fire: (x >>> 16) % 7 === 0 },
  });
}

async function build(
  path: string,
  o: {
    battleId?: string;
    ticks?: number;
    algo?: Algo;
    fragmentBytes?: number;
    maxBytes?: number;
    result?: boolean;
    fs?: S9rFs;
  } = {},
) {
  const w = await S9rWriter.create(path, {
    kind: "R",
    header: { battleId: o.battleId ?? "battle-AAAA", seed: 42, versions: { engine: "0.4.0" } },
    maxBytes: o.maxBytes ?? 64 * 1024 * 1024,
    fragmentBytes: o.fragmentBytes ?? 2048,
    algo: o.algo,
    fs: o.fs,
  });
  const lines: string[] = [];
  try {
    for (let t = 0; t < (o.ticks ?? 60); t++) {
      for (let v = 0; v < 3; v++) {
        const l = rec(t, v, o.battleId ?? "battle-AAAA");
        lines.push(l);
        await w.append(l, t);
      }
    }
    const summary = await w.close(
      o.result === false ? {} : { result: { winner: "team-a", ticks: o.ticks ?? 60, finalStateHash: "ab".repeat(32) } },
    );
    return { w, summary, lines };
  } catch (e) {
    await w.abort();
    throw e;
  }
}

const algos: Algo[] = (["zstd", "gzip"] as Algo[]).filter(algoAvailable);

describe("T1 ida y vuelta exacta", () => {
  for (const algo of algos) {
    it(`T1 registros, cabecera, resultado y tamaños idénticos (${algo})`, async () => {
      const f = p("rt.s9r");
      const { summary, lines } = await build(f, { algo });
      expect(summary.fragments).toBeGreaterThan(3);
      const r = await S9rReader.open(f, { expectBattleId: "battle-AAAA" });
      expect(r.header).toEqual({ battleId: "battle-AAAA", seed: 42, versions: { engine: "0.4.0" } });
      const got: string[] = [];
      for await (const l of r.records()) got.push(l);
      expect(got).toEqual(lines);
      expect(await r.readResult()).toEqual({ winner: "team-a", ticks: 60, finalStateHash: "ab".repeat(32) });
      expect(r.index.records).toBe(lines.length);
      expect(statSync(f).size).toBe(summary.bytes);
      await r.close();
    });
  }
  it("T1 el sha256 del fichero entero (escritor) coincide con el del verificador y con el de disco", async () => {
    const f = p("sha.s9r");
    const { summary } = await build(f);
    const v = await verifyFile(f);
    expect(v.ok).toBe(true);
    expect(v.sha256).toBe(summary.sha256);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(readFileSync(f)).digest("hex")).toBe(summary.sha256);
  });
});

describe("T2 corrupción de un byte", () => {
  it("T2 cualquier byte alterado en cualquier posición del fichero es detectado por verify", async () => {
    const f = p("flip.s9r");
    await build(f, { ticks: 12, fragmentBytes: 400 });
    const orig = readFileSync(f);
    expect(orig.length).toBeLessThan(6000);
    expect((await verifyFile(f)).ok).toBe(true);
    const undetected: number[] = [];
    for (let i = 0; i < orig.length; i++) {
      const b = Buffer.from(orig);
      b[i] ^= 0x01;
      const g = p("flipped.s9r");
      writeFileSync(g, b);
      const res = await verifyFile(g);
      if (res.ok) undetected.push(i);
      rmSync(g);
    }
    expect(undetected).toEqual([]);
  });
  it("T2 un byte alterado en el payload de un fragmento lo nombra crc_mismatch al leerlo", async () => {
    const f = p("crc.s9r");
    await build(f);
    const r0 = await S9rReader.open(f);
    const frag = r0.index.fragments[1];
    await r0.close();
    const b = readFileSync(f);
    b[frag.offset + 9 + 2] ^= 0xff;
    writeFileSync(f, b);
    const r = await S9rReader.open(f);
    await expect(r.readFragment(1)).rejects.toMatchObject({ code: "crc_mismatch" });
    await expect(r.readFragment(0)).resolves.toBeInstanceOf(Buffer);
    await r.close();
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error).toBeInstanceOf(CorruptReplayError);
  });
  it("T2 un crc ajustado a un payload manipulado sigue detectándose por sha256 del índice", async () => {
    const f = p("sha-idx.s9r");
    await build(f);
    const r0 = await S9rReader.open(f);
    const frag = r0.index.fragments[1];
    await r0.close();
    const b = readFileSync(f);
    const { crc32 } = await import("../../src/s9r/codec.js");
    b[frag.offset + 9 + 2] ^= 0x10;
    b.writeUInt32LE(crc32(b.subarray(frag.offset + 9, frag.offset + frag.frameLen)), frag.offset + 5);
    writeFileSync(f, b);
    const r = await S9rReader.open(f);
    await expect(r.readFragment(1)).rejects.toMatchObject({ code: "sha_mismatch" });
    await r.close();
  });
  it("T2 un major desconocido responde unsupported_format", async () => {
    const f = p("major.s9r");
    await build(f);
    const b = readFileSync(f);
    b[4] = 2;
    writeFileSync(f, b);
    await expect(S9rReader.open(f)).rejects.toBeInstanceOf(UnsupportedFormatError);
    const v = await verifyFile(f);
    expect(v.ok).toBe(false);
    expect(v.error).toMatchObject({ code: "unsupported_format" });
  });
});

describe("T3 fragmento o cuerpo de otra batalla", () => {
  it("T3 cuerpo de la batalla B bajo la cabecera de la A es rechazado (cadena atada a la cabecera)", async () => {
    const a = p("a.s9r");
    const bf = p("b.s9r");
    await build(a, { battleId: "battle-AAAA" });
    await build(bf, { battleId: "battle-BBBB" });
    const ab = readFileSync(a);
    const bb = readFileSync(bf);
    const ra = await S9rReader.open(a);
    const headerEnd = 8 + ra.index.headerFrameLen;
    await ra.close();
    // Mismo esquema y mismo reparto de fragmentos: cabecera de A + todo lo demás de B.
    const rb = await S9rReader.open(bf);
    expect(rb.index.headerFrameLen).toBe(ra.index.headerFrameLen);
    await rb.close();
    const frank = Buffer.concat([ab.subarray(0, headerEnd), bb.subarray(headerEnd)]);
    const g = p("frank.s9r");
    writeFileSync(g, frank);
    await expect(S9rReader.open(g)).rejects.toMatchObject({ code: "chain_mismatch" });
    expect((await verifyFile(g)).ok).toBe(false);
    // Control positivo: B entero, abierto con su propia cabecera, es válido.
    expect((await verifyFile(bf)).ok).toBe(true);
  });
  it("T3 un fragmento de B colocado en A (mismo tamaño) falla por sha256 del índice", async () => {
    const a = p("a2.s9r");
    const bf = p("b2.s9r");
    await build(a, { battleId: "battle-AAAA", fragmentBytes: 1 << 20 });
    await build(bf, { battleId: "battle-BBBB", fragmentBytes: 1 << 20 });
    const ra = await S9rReader.open(a);
    const rb = await S9rReader.open(bf);
    const ea = ra.index.fragments[0];
    const eb = rb.index.fragments[0];
    await ra.close();
    await rb.close();
    expect(eb.frameLen).toBe(ea.frameLen);
    const ab = readFileSync(a);
    const bb = readFileSync(bf);
    bb.copy(ab, ea.offset, eb.offset, eb.offset + eb.frameLen);
    writeFileSync(a, ab);
    const v = await verifyFile(a);
    expect(v.ok).toBe(false);
    expect(v.error).toMatchObject({ code: "sha_mismatch" });
  });
  it("T3 expectBattleId distinto de la cabecera se rechaza", async () => {
    const f = p("exp.s9r");
    await build(f);
    await expect(S9rReader.open(f, { expectBattleId: "battle-ZZZZ" })).rejects.toMatchObject({
      code: "battle_mismatch",
    });
  });
});

describe("T4 fichero sin pie es parcial", () => {
  it("T4 truncar en CADA longitud posible da IncompleteReplayError", async () => {
    const f = p("full.s9r");
    await build(f, { ticks: 8, fragmentBytes: 300 });
    const orig = readFileSync(f);
    for (let n = 0; n < orig.length; n++) {
      const g = p("trunc.s9r");
      writeFileSync(g, orig.subarray(0, n));
      await expect(S9rReader.open(g)).rejects.toBeInstanceOf(IncompleteReplayError);
      const v = await verifyFile(g);
      expect(v.ok).toBe(false);
      expect(v.error).toBeInstanceOf(IncompleteReplayError);
      rmSync(g);
    }
  });
  it("T4 un escritor sin cerrar deja un parcial: no abre, pero scanPartial cuenta los fragmentos intactos", async () => {
    const f = p("open.s9r.part");
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "x" },
      maxBytes: 1 << 20,
      fragmentBytes: 300,
    });
    for (let t = 0; t < 40; t++) await w.append(rec(t, 0), t);
    await expect(S9rReader.open(f)).rejects.toBeInstanceOf(IncompleteReplayError);
    const s = await scanPartial(f);
    expect(s.dataFragments).toBeGreaterThan(3);
    expect(s.clean).toBe(true);
    await w.abort();
    expect(existsSync(f)).toBe(false);
  });
  it("T4 el bit complete del pie a cero es parcial", async () => {
    const f = p("nocomplete.s9r");
    await build(f);
    const b = readFileSync(f);
    b[b.length - 64 + 4] = 0;
    writeFileSync(f, b);
    await expect(S9rReader.open(f)).rejects.toMatchObject({ code: "not_complete" });
  });
});

describe("T5 tope de bytes", () => {
  it("T5 se comprueba en cada fragmento y es exacto en el borde", async () => {
    const probe = p("probe.s9r");
    const ref = await build(probe, { ticks: 40, fragmentBytes: 400, result: false });
    const r = await S9rReader.open(probe);
    const lastData = r.index.fragments[r.index.fragments.length - 1];
    const dataEnd = lastData.offset + lastData.frameLen;
    await r.close();
    expect(ref.summary.fragments).toBeGreaterThan(4);
    // Justo en el borde cabe.
    const ok = await build(p("edge-ok.s9r"), { ticks: 40, fragmentBytes: 400, result: false, maxBytes: dataEnd });
    expect(ok.summary.fragments).toBe(ref.summary.fragments);
    // Un byte menos: el ÚLTIMO fragmento (no el primero) lanza el error de límite.
    await expect(
      build(p("edge-ko.s9r"), { ticks: 40, fragmentBytes: 400, result: false, maxBytes: dataEnd - 1 }),
    ).rejects.toBeInstanceOf(ReplayLimitExceededError);
  });
  it("T5 tras el límite el escritor sigue utilizable: cierra como truncado, dentro del margen y verificable", async () => {
    const f = p("trunc-limit.s9r");
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "x" },
      maxBytes: 1200,
      emergencyBytes: 2048,
      fragmentBytes: 300,
    });
    let hit: unknown;
    let lastGood = -1;
    for (let t = 0; t < 500 && !hit; t++) {
      try {
        await w.append(rec(t, 0), t);
        lastGood = t;
      } catch (e) {
        hit = e;
      }
    }
    expect(hit).toBeInstanceOf(ReplayLimitExceededError);
    const sum = await w.closeTruncated({ result: { endReason: "recording_limit" } });
    expect(sum.truncated).toBe(true);
    expect(sum.bytes).toBeLessThanOrEqual(1200 + 2048);
    const v = await verifyFile(f);
    expect(v.ok).toBe(true);
    expect(v.truncated).toBe(true);
    const r = await S9rReader.open(f);
    expect(r.truncated).toBe(true);
    expect(r.index.fragments.filter((e) => e.type === 2).length).toBeGreaterThan(0);
    expect(lastGood).toBeGreaterThan(0);
    await r.close();
  });
  it("T5 el tope también aplica a los datos: ningún fragmento escrito rebasa maxBytes", async () => {
    const f = p("cap.s9r");
    const w = await S9rWriter.create(f, { kind: "R", header: { battleId: "x" }, maxBytes: 3000, fragmentBytes: 300 });
    try {
      for (let t = 0; t < 5000; t++) await w.append(rec(t, 0), t);
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayLimitExceededError);
    }
    expect(w.bytesWritten).toBeLessThanOrEqual(3000);
    await w.abort();
  });
});

describe("T6 errores de disco tipados", () => {
  function faulty(failOp: "write" | "sync" | "link", nth: number, code: string): S9rFs {
    let n = 0;
    const hit = () => {
      if (++n >= nth) throw Object.assign(new Error(`${code} simulado`), { code });
    };
    return {
      ...nodeFs,
      create: async (path) => {
        const f = await nodeFs.create(path);
        return {
          ...f,
          write: async (b) => {
            if (failOp === "write") hit();
            return f.write(b);
          },
          sync: async () => {
            if (failOp === "sync") hit();
            return f.sync();
          },
        };
      },
      link: async (a, b) => {
        if (failOp === "link") hit();
        return nodeFs.link(a, b);
      },
    };
  }
  it("T6 ENOSPC en un fragmento intermedio -> StorageFullError, escritor envenenado y búfer vacío", async () => {
    const f = p("enospc.s9r");
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "x" },
      maxBytes: 1 << 20,
      fragmentBytes: 300,
      fs: faulty("write", 4, "ENOSPC"),
    });
    let err: unknown;
    let t = 0;
    for (; t < 400 && !err; t++) {
      try {
        await w.append(rec(t, 0), t);
      } catch (e) {
        err = e;
      }
    }
    expect(err).toBeInstanceOf(StorageFullError);
    expect((err as StorageFullError).errno).toBe("ENOSPC");
    expect(w.bufferedBytes).toBe(0);
    // envenenado: sigue devolviendo el mismo error y NO acumula en RAM
    await expect(w.append(rec(t, 0), t)).rejects.toBe(err);
    expect(w.bufferedBytes).toBe(0);
    await expect(w.close()).rejects.toBe(err);
    await w.abort();
    expect(existsSync(f)).toBe(false);
  });
  it("T6 EIO en el fsync de cierre -> StorageIoError (distinto de disco lleno) y sin pie publicable", async () => {
    const f = p("eio.s9r");
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "x" },
      maxBytes: 1 << 20,
      fragmentBytes: 300,
      fs: faulty("sync", 1, "EIO"),
    });
    for (let t = 0; t < 10; t++) await w.append(rec(t, 0), t);
    const e = await w.close().catch((x) => x);
    expect(e).toBeInstanceOf(StorageIoError);
    expect(e).not.toBeInstanceOf(StorageFullError);
    await expect(w.append("{}", 1)).rejects.toBe(e);
    await w.abort();
    expect(existsSync(f)).toBe(false);
  });
  it("T6 ENOSPC al crear el parcial se tipa igual", async () => {
    const fs2: S9rFs = {
      ...nodeFs,
      create: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOSPC" })),
    };
    await expect(
      S9rWriter.create(p("c.s9r"), { kind: "R", header: {}, maxBytes: 1 << 20, fs: fs2 }),
    ).rejects.toBeInstanceOf(StorageFullError);
  });
  it("T6 fallo en el link de publicación: no queda publicado y el parcial se conserva", async () => {
    const part = p("pub.s9r.part");
    const fin = p("pub.s9r");
    await build(part);
    await expect(publishPartial(part, fin, { fs: faulty("link", 1, "EIO") })).rejects.toBeInstanceOf(StorageIoError);
    expect(existsSync(fin)).toBe(false);
    expect(existsSync(part)).toBe(true);
  });
});

describe("T7 búfer acotado", () => {
  it("T7 el búfer nunca supera fragmentBytes + un registro; los registros inválidos se rechazan", async () => {
    const f = p("buf.s9r");
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "x" },
      maxBytes: 64 << 20,
      fragmentBytes: 4096,
      maxRecordBytes: 256,
    });
    for (let t = 0; t < 5000; t++) await w.append(rec(t, 0), t);
    expect(w.peakBufferBytes).toBeLessThan(4096 + 256);
    await expect(w.append("x".repeat(300), 1)).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(w.append("a\nb", 1)).rejects.toBeInstanceOf(InvalidRecordError);
    await w.close();
    await expect(w.append("{}", 1)).rejects.toBeInstanceOf(WriterStateError);
  });
});

describe("T8 memoria acotada con 45 000 ticks", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const MiB = 1024 * 1024;
  it("T8 escribir y leer 45 000 ticks x 8 vehículos mantiene heapUsed acotado", async () => {
    const f = p("big.s9r");
    gc();
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    const w = await S9rWriter.create(f, {
      kind: "R",
      header: { battleId: "big" },
      maxBytes: 512 * MiB,
      fragmentBytes: 256 * 1024,
    });
    for (let t = 0; t < 45000; t++) {
      for (let v = 0; v < 8; v++) await w.append(rec(t, v), t);
      if (t % 1000 === 999) {
        gc();
        peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      }
    }
    const sum = await w.close({ result: { ticks: 45000 } });
    expect(sum.records).toBe(360000);
    expect(w.peakBufferBytes).toBeLessThan(256 * 1024 + 4096);
    expect(peak).toBeLessThan(12 * MiB);
    // lectura: cursor por fragmento, sin cargar el fichero
    const r = await S9rReader.open(f);
    let n = 0;
    let readPeak = 0;
    for await (const _ of r.records()) {
      if (++n % 60000 === 0) {
        gc();
        readPeak = Math.max(readPeak, process.memoryUsage().heapUsed - base);
      }
    }
    expect(n).toBe(360000);
    expect(readPeak).toBeLessThan(12 * MiB);
    await r.close();
    // seek: un rango estrecho toca sólo los fragmentos que lo cubren
    const r2 = await S9rReader.open(f);
    const cnt: string[] = [];
    for await (const l of r2.records({ fromTick: 30000, toTick: 30010 })) cnt.push(l);
    expect(r2.fragmentReads).toBeLessThanOrEqual(2);
    expect(r2.fragmentReads).toBeLessThan(r2.dataFragments.length / 10);
    expect(cnt.length).toBeGreaterThanOrEqual(11 * 8);
    await r2.close();
  }, 120000);
});

describe("T9 publicación atómica", () => {
  it("T9 nada visible antes del rename; después, el final existe y el parcial no", async () => {
    const part = p("a.s9r.part");
    const fin = p("a.published.s9r");
    await build(part);
    expect(existsSync(fin)).toBe(false);
    await publishPartial(part, fin);
    expect(existsSync(part)).toBe(false);
    expect((await verifyFile(fin)).ok).toBe(true);
  });
  it("T9 no sobrescribe un replay publicado", async () => {
    const part = p("b.s9r.part");
    const fin = p("b.published.s9r");
    await build(part);
    writeFileSync(fin, "ya publicado");
    await expect(publishPartial(part, fin)).rejects.toMatchObject({ code: "final_exists" });
    expect(readFileSync(fin, "utf8")).toBe("ya publicado");
  });
  it("T9 vista primero y receta al final; si falla la receta, no hay receta publicada", async () => {
    const order: string[] = [];
    const fs2: S9rFs = {
      ...nodeFs,
      link: async (a, b) => {
        order.push(b.endsWith(".s9v") ? "V" : "R");
        if (b.endsWith(".s9r")) throw Object.assign(new Error("boom"), { code: "EIO" });
        return nodeFs.link(a, b);
      },
    };
    const rp = p("c.s9r.part");
    const vp = p("c.s9v.part");
    await build(rp);
    await build(vp);
    const rf = p("c.s9r");
    const vf = p("c.s9v");
    await expect(
      publishPair({ recipe: { partial: rp, final: rf }, view: { partial: vp, final: vf } }, { fs: fs2 }),
    ).rejects.toBeInstanceOf(StorageIoError);
    expect(order).toEqual(["V", "R"]);
    expect(existsSync(rf)).toBe(false);
  });
  it("T9 discardPartial es idempotente", async () => {
    const part = p("d.s9r.part");
    await build(part);
    await discardPartial(part);
    await discardPartial(part);
    expect(existsSync(part)).toBe(false);
  });
});
