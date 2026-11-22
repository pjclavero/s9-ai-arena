/**
 * PR C · ronda 2 (P2-3) · el cableado de la carga: `buildLoadConfig` (puro) y que
 * `main.ts` lo usa de verdad. main.ts es un script con efectos (BD, Redis) que no se
 * puede importar, así que se comprueba su ESTRUCTURA (AST ESTree: imports, llamadas y
 * spreads dentro de `new TournamentWorker({...})` y `containerAgents({...})`), no
 * apariciones de texto. Cada test lleva el mutante que lo mata
 * (scripts/mutants-worker-load.sh).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import * as acorn from "acorn";
import { buildLoadConfig, executorLoadOptions, workerLoadOptions } from "./load-config.js";
import { computeConcurrency } from "./worker.js";

describe("buildLoadConfig / workerLoadOptions / executorLoadOptions", () => {
  it("sin variables: concurrencia 1 (defecto seguro, se pasa explícita) e intervalo 2000 (M-E1)", () => {
    const cfg = buildLoadConfig({});
    expect(cfg.concurrency).toBeUndefined();
    expect(cfg.effectiveConcurrency).toBe(1);
    expect(workerLoadOptions(cfg)).toEqual({ concurrency: 1 });
    expect(cfg.cpuSampleMs).toBe(2000);
    expect(executorLoadOptions(cfg)).toEqual({ cpuSampleMs: 2000 });
  });

  it("con variables: la concurrencia y el intervalo llegan a las opciones de cada pieza (M-E2, M-E3)", () => {
    const cfg = buildLoadConfig({ TOURNAMENT_WORKER_CONCURRENCY: "2", TOURNAMENT_WORKER_CPU_SAMPLE_MS: "3000" });
    expect(cfg).toEqual({ concurrency: 2, effectiveConcurrency: 2, cpuSampleMs: 3000 });
    expect(workerLoadOptions(cfg)).toEqual({ concurrency: 2 });
    expect(executorLoadOptions(cfg)).toEqual({ cpuSampleMs: 3000 });
  });

  it("`auto` calcula con computeConcurrency (cgroup + batalla) y llega al worker", () => {
    const cfg = buildLoadConfig({ TOURNAMENT_WORKER_CONCURRENCY: "auto" });
    expect(cfg.concurrency).toBe("auto");
    expect(cfg.effectiveConcurrency).toBe(computeConcurrency());
    expect(workerLoadOptions(cfg)).toEqual({ concurrency: computeConcurrency() });
  });

  it("un valor inválido LANZA (el worker no arranca; no se degrada al defecto)", () => {
    expect(() => buildLoadConfig({ TOURNAMENT_WORKER_CONCURRENCY: "0" })).toThrow(/CONCURRENCY/);
    expect(() => buildLoadConfig({ TOURNAMENT_WORKER_CPU_SAMPLE_MS: "50" })).toThrow(/CPU_SAMPLE_MS/);
  });
});

type N = { type: string; [k: string]: unknown };
const here = dirname(fileURLToPath(import.meta.url));

function parseMain(): N {
  const js = stripTypeScriptTypes(readFileSync(join(here, "main.ts"), "utf8"), { mode: "strip" });
  return acorn.parse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as N;
}
function walk(n: unknown, f: (x: N) => void): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, f));
  const node = n as N;
  if (typeof node.type === "string") f(node);
  for (const [k, v] of Object.entries(node)) if (k !== "type") walk(v, f);
}
const name = (c: unknown): string => {
  const n = c as N;
  return n.type === "Identifier"
    ? String(n.name)
    : n.type === "MemberExpression"
      ? `${name(n.object)}.${name(n.property)}`
      : n.type;
};
/** ¿El objeto de la llamada/`new` a `callee` esparce `spreadFn(arg)`? (también dentro de anidados). */
function callSpreads(ast: N, callee: string, spreadFn: string, arg: string): boolean {
  let found = false;
  walk(ast, (x) => {
    if ((x.type !== "NewExpression" && x.type !== "CallExpression") || name(x.callee) !== callee) return;
    walk(x.arguments, (y) => {
      if (y.type !== "SpreadElement") return;
      const a = y.argument as N;
      if (a.type !== "CallExpression" || name(a.callee) !== spreadFn) return;
      const args = a.arguments as N[];
      if (args.length === 1 && args[0].type === "Identifier" && args[0].name === arg) found = true;
    });
  });
  return found;
}

describe("main.ts cablea la carga (AST)", () => {
  const ast = parseMain();

  it("control positivo: el analizador ve el main real", () => {
    let imports = 0;
    walk(ast, (x) => x.type === "ImportDeclaration" && imports++);
    expect(imports).toBeGreaterThan(10);
    expect(callSpreads(ast, "TournamentWorker", "noExiste", "loadConfig")).toBe(false);
  });

  it("loadConfig = buildLoadConfig(process.env) (M-E4: main no lee el entorno)", () => {
    let ok = false;
    walk(ast, (x) => {
      if (x.type !== "VariableDeclarator" || (x.id as N).name !== "loadConfig") return;
      const init = x.init as N | null;
      if (init?.type === "CallExpression" && name(init.callee) === "buildLoadConfig") {
        const a = (init.arguments as N[])[0];
        ok = !!a && name(a) === "process.env";
      }
    });
    expect(ok).toBe(true);
  });

  it("new TournamentWorker({...}) esparce workerLoadOptions(loadConfig) (N12: main no pasa `concurrency`)", () => {
    expect(callSpreads(ast, "TournamentWorker", "workerLoadOptions", "loadConfig")).toBe(true);
  });

  it("containerAgents({...}) esparce executorLoadOptions(loadConfig) (N13: main no pasa `cpuSampleMs`)", () => {
    expect(callSpreads(ast, "containerAgents", "executorLoadOptions", "loadConfig")).toBe(true);
  });
});
