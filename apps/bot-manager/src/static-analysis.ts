/**
 * E6 · bot-manager — análisis estático y extracción de dependencias (T6.1, T6.3).
 *
 * DoD T6.1: "Un bot con dependencia fuera de la allowlist queda Rechazado en la etapa de
 * análisis, con el paquete señalado" + "lockfile obligatorio".
 * DoD T6.3: "Un bot que importa un paquete no incluido falla el build con mensaje que
 * identifica el import."
 *
 * Dos fuentes de verdad se cruzan:
 *   1) el MANIFIESTO declarado (requirements.txt / package.json) → dependencias declaradas;
 *   2) los IMPORTS reales del código → dependencias efectivas.
 * Se bloquea si (a) una dependencia declarada no está en la allowlist, (b) un import real
 * apunta a un paquete de terceros ni declarado ni permitido, (c) no hay lockfile.
 *
 * NO sustituye al sandbox de proceso (ver apps/arena-engine/src/sim/physics.ts: el motor
 * es autoritativo sobre la física y da igual lo que "diga" el bot; pero el bot es CÓDIGO
 * ARBITRARIO que se ejecuta, así que un análisis estático nunca es suficiente — de ahí
 * T6.2). Esto es defensa en profundidad, no la única barrera.
 */
import type { PipelineConfig } from "./config.js";
import type { Runtime, SourceFile } from "./types.js";

// Módulos de la stdlib que NO requieren declaración de dependencia.
const PYTHON_STDLIB = new Set([
  "sys", "os", "math", "json", "random", "typing", "collections", "itertools",
  "functools", "dataclasses", "abc", "time", "re", "enum", "heapq", "bisect",
  "copy", "struct", "array", "statistics", "decimal", "fractions", "queue",
]);
const NODE_BUILTINS = new Set([
  "assert", "buffer", "events", "path", "querystring", "string_decoder",
  "url", "util", "stream", "timers", "console", "process",
]);

// Builtins peligrosos para un bot sandboxeado (red, procesos, FS crudo): la lista es
// CONFIGURABLE (config.dangerousBuiltins, H1/issue #5) y la política por defecto los
// BLOQUEA además de registrarlos como hallazgo de auditoría. El sandbox los neutraliza
// en runtime y sigue siendo la defensa principal; esto es defensa en profundidad.

export interface Dependency {
  name: string;
  /** Versión pinneada si el manifiesto la trae. */
  version?: string;
}

export interface StaticAnalysisResult {
  declared: Dependency[];
  imports: string[];
  hasLockfile: boolean;
  /** Dependencias declaradas fuera de allowlist. */
  disallowedDeps: string[];
  /** Imports de terceros no permitidos (ni stdlib/builtin ni en allowlist). */
  disallowedImports: string[];
  /** Imports de builtins peligrosos (red/procesos/FS). Siempre son hallazgo de
   *  auditoría; con la política "block" (por defecto) además bloquean (H1, issue #5). */
  dangerousImports: string[];
  ok: boolean;
  reasons: string[];
}

function normalizePkg(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

// El nombre del MODULO que se importa no siempre es el del PAQUETE que lo distribuye.
// R6.1: `import websocket` lo aporta el paquete "websocket-client". Sin esta traduccion,
// un bot que use el SDK tal y como documenta su README quedaria rechazado por "import de
// paquete no permitido: websocket", o habria que meter "websocket" en la allowlist, que
// es peor: la allowlist dejaria de nombrar paquetes instalables y no cuadraria con el lock.
const PYTHON_IMPORT_TO_DIST = new Map([["websocket", "websocket-client"]]);

// import arena_sdk  → paquete arena-sdk ;  from numpy import x → numpy
function importToPackage(runtime: Runtime, mod: string): string {
  const top = mod.split(".")[0].split("/")[0];
  if (runtime === "python") {
    const norm = normalizePkg(top);
    return PYTHON_IMPORT_TO_DIST.get(norm) ?? norm;
  }
  // node: preservar el scope (@arena/sdk)
  if (mod.startsWith("@")) return mod.split("/").slice(0, 2).join("/");
  return top;
}

export function parsePythonRequirements(text: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9._-]+)\s*(?:([<>=!~]=?)\s*([0-9A-Za-z.*-]+))?/.exec(line);
    if (m) deps.push({ name: normalizePkg(m[1]), version: m[3] });
  }
  return deps;
}

export function parsePackageJsonDeps(text: string): Dependency[] {
  const deps: Dependency[] = [];
  try {
    const pkg = JSON.parse(text);
    for (const section of ["dependencies", "optionalDependencies"]) {
      const obj = pkg[section] ?? {};
      for (const [name, version] of Object.entries(obj)) {
        deps.push({ name, version: String(version) });
      }
    }
  } catch {
    /* manifest ilegible: se trata como sin declaración (fallará por imports/lockfile). */
  }
  return deps;
}

export function extractImports(runtime: Runtime, files: SourceFile[]): string[] {
  const mods = new Set<string>();
  for (const f of files) {
    if (runtime === "python" && !f.path.endsWith(".py")) continue;
    if (runtime === "node" && !/\.(m?js|ts)$/.test(f.path)) continue;
    for (const line of f.content.split(/\r?\n/)) {
      if (runtime === "python") {
        let m = /^\s*import\s+([A-Za-z0-9_.]+)/.exec(line);
        if (m) mods.add(m[1]);
        m = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/.exec(line);
        if (m) mods.add(m[1]);
      } else {
        let m = /\bfrom\s+['"]([^'"]+)['"]/.exec(line);
        if (m) mods.add(m[1]);
        m = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
        if (m) mods.add(m[1]);
        m = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
        if (m) mods.add(m[1]);
      }
    }
  }
  return [...mods];
}

export function analyze(runtime: Runtime, files: SourceFile[], config: PipelineConfig): StaticAnalysisResult {
  const allowed = config.allowedPackages[runtime];
  const stdlib = runtime === "python" ? PYTHON_STDLIB : NODE_BUILTINS;
  const dangerous = config.dangerousBuiltins.modules[runtime];

  // Manifiesto
  let declared: Dependency[] = [];
  if (runtime === "python") {
    const req = files.find((f) => f.path === "requirements.txt" || f.path.endsWith("/requirements.txt"));
    if (req) declared = parsePythonRequirements(req.content);
  } else {
    const pj = files.find((f) => f.path === "package.json" || f.path.endsWith("/package.json"));
    if (pj) declared = parsePackageJsonDeps(pj.content);
  }

  // Lockfile
  const hasLockfile = files.some((f) =>
    config.lockfileNames[runtime].some((name) => f.path === name || f.path.endsWith("/" + name)),
  );

  // Imports reales (relativos "./x" o ".mod" excluidos)
  const rawImports = extractImports(runtime, files);
  const imports: string[] = [];
  const dangerousImports: string[] = [];
  const disallowedImports: string[] = [];
  const localFileStems = new Set(
    files.map((f) => f.path.replace(/\.(py|m?js|ts)$/, "").split("/").pop()!),
  );
  for (const mod of rawImports) {
    if (mod.startsWith(".") || mod.startsWith("/")) continue; // import local relativo
    imports.push(mod);
    const top = mod.split(".")[0].split("/")[0];
    // "node:fs" y "fs" son el mismo builtin: se normaliza SOLO para la detección
    // de peligrosos (no para la stdlib, para no relajar el resto de comprobaciones).
    const topNorm = top.replace(/^node:/, "");
    if (dangerous.has(topNorm)) dangerousImports.push(mod);
    if (stdlib.has(top)) continue;
    if (dangerous.has(topNorm)) continue; // ya señalado/bloqueado como builtin peligroso
    const pkg = importToPackage(runtime, mod);
    if (runtime === "python" && localFileStems.has(pkg)) continue; // módulo propio del bot
    if (!allowed.has(pkg)) disallowedImports.push(mod);
  }

  const disallowedDeps = declared.map((d) => d.name).filter((n) => !allowed.has(n));

  const reasons: string[] = [];
  if (!hasLockfile) {
    reasons.push(`falta lockfile obligatorio (uno de: ${config.lockfileNames[runtime].join(", ")})`);
  }
  for (const d of disallowedDeps) reasons.push(`dependencia no permitida (fuera de allowlist): ${d}`);
  for (const im of [...new Set(disallowedImports)]) reasons.push(`import de paquete no permitido: ${im}`);
  if (config.dangerousBuiltins.mode === "block") {
    for (const im of [...new Set(dangerousImports)]) {
      reasons.push(`import de builtin peligroso bloqueado por política (H1): ${im}`);
    }
  }

  return {
    declared,
    imports,
    hasLockfile,
    disallowedDeps,
    disallowedImports: [...new Set(disallowedImports)],
    dangerousImports: [...new Set(dangerousImports)],
    ok: reasons.length === 0,
    reasons,
  };
}
