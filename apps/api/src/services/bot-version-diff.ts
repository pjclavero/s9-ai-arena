/**
 * DEV-A · A9.12 — diff entre los sources ALMACENADOS de dos versiones de un bot.
 *
 * Backend = BD (no Git): se decodifican los dos paquetes (mismo `decodePackage`
 * que el pipeline) y se compara fichero a fichero con un diff de líneas por LCS,
 * emitido en formato unificado (`@@ -a,b +c,d @@`). Sin dependencias nuevas.
 * Límite: ficheros de más de MAX_DIFF_LINES líneas se marcan modificados sin hunks.
 */
import type { SourceFile } from "../../../bot-manager/src/types.js";

export const MAX_DIFF_LINES = 4000;
const CONTEXT = 3;

export interface FileDiff {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  additions: number;
  deletions: number;
  diff: string;
}

type Op = { kind: " " | "-" | "+"; line: string };

function lineOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // LCS por programación dinámica (tabla de sufijos).
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: "-", line: a[i++] });
    else ops.push({ kind: "+", line: b[j++] });
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });
  while (j < m) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

function unified(ops: Op[]): string {
  const out: string[] = [];
  let k = 0;
  // posiciones 1-based en a y b para cada op
  const posA: number[] = [];
  const posB: number[] = [];
  let ia = 1;
  let ib = 1;
  for (const op of ops) {
    posA.push(ia);
    posB.push(ib);
    if (op.kind !== "+") ia++;
    if (op.kind !== "-") ib++;
  }
  while (k < ops.length) {
    if (ops[k].kind === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    // extender el hunk mientras los cambios estén a ≤ 2*CONTEXT líneas
    let lastChange = k;
    while (end < ops.length) {
      if (ops[end].kind !== " ") lastChange = end;
      if (end - lastChange > 2 * CONTEXT) break;
      end++;
    }
    end = Math.min(ops.length, lastChange + CONTEXT + 1);
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.kind !== "+").length;
    const bCount = slice.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aCount ? posA[start] : posA[start] - 1},${aCount} +${bCount ? posB[start] : posB[start] - 1},${bCount} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
    k = end;
  }
  return out.join("\n");
}

const lines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

export function diffFiles(from: SourceFile[], to: SourceFile[]): FileDiff[] {
  const a = new Map(from.map((f) => [f.path, f.content]));
  const b = new Map(to.map((f) => [f.path, f.content]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.map((path): FileDiff => {
    const x = a.get(path);
    const y = b.get(path);
    const la = x === undefined ? [] : lines(x);
    const lb = y === undefined ? [] : lines(y);
    const status: FileDiff["status"] = x === undefined ? "added" : y === undefined ? "removed" : x === y ? "unchanged" : "modified";
    if (status === "unchanged") return { path, status, additions: 0, deletions: 0, diff: "" };
    if (la.length > MAX_DIFF_LINES || lb.length > MAX_DIFF_LINES) {
      return { path, status, additions: lb.length, deletions: la.length, diff: "(fichero demasiado grande para diff en línea)" };
    }
    const ops = lineOps(la, lb);
    return {
      path,
      status,
      additions: ops.filter((o) => o.kind === "+").length,
      deletions: ops.filter((o) => o.kind === "-").length,
      diff: unified(ops),
    };
  });
}
