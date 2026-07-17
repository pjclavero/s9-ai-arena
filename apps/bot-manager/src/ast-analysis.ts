/**
 * R2.4 (ERR-SEC-06/07) · Análisis del AST REAL de cada runtime.
 *
 * Sustituye el parseo por regex de static-analysis.ts: una regex por línea no ve
 * imports partidos en varias líneas, strings, `__import__("os")`, `require(v)` con
 * variable, `eval`/`exec` ni accesos a `__builtins__`. Aquí se parsea el árbol de
 * verdad:
 *   - Python: el módulo `ast` de CPython (se invoca `python3` con un analizador
 *     embebido; el mismo intérprete que ejecutará el bot en su runtime).
 *   - JS/TS: acorn (parser real de ECMAScript).
 *
 * FAIL-CLOSED (regla de oro de la Ronda 2): si un fichero no se puede parsear
 * (sintaxis inválida, python3 ausente, salida corrupta…), el bot se RECHAZA con el
 * motivo; jamás se aprueba lo que no se ha podido analizar. Los ficheros .ts de
 * bots se rechazan también: el runtime de bots no ejecuta TypeScript y acorn no lo
 * parsea — aceptar "lo que parezca JS" sería analizar un árbol distinto del real.
 *
 * Esto sigue siendo defensa en profundidad: el sandbox (T6.2/R6.1) es la barrera
 * principal. Pero un bot que necesita `__import__` dinámico o `eval` para
 * "funcionar" no tiene sitio en la arena.
 */
import { spawnSync } from "node:child_process";
import * as acorn from "acorn";
import type { Runtime, SourceFile } from "./types.js";

/** Un hallazgo ligado a un fichero concreto (para mensajes accionables, T6.3). */
export interface AstFinding {
  path: string;
  detail: string;
}

export interface AstExtraction {
  /** Módulos importados ESTÁTICAMENTE (import/from/require/import() con literal). */
  imports: string[];
  /**
   * Construcciones que derrotan al análisis estático y se bloquean SIEMPRE
   * (independientemente de la política de builtins): `__import__`,
   * `importlib.import_module`, `import()`/`require()` con argumento no literal,
   * `eval`/`exec`/`compile`, `new Function(...)` y accesos a `__builtins__`.
   */
  dynamicFindings: AstFinding[];
  /** Ficheros que NO se pudieron parsear → rechazo fail-closed. */
  parseErrors: AstFinding[];
}

// ---------------------------------------------------------------------------
// Python · analizador sobre el módulo `ast` de CPython.
// Lee JSON por stdin: [{path, content}, ...]; escribe JSON por stdout:
// [{path, imports, dynamic, error}, ...]. Cualquier desviación = fail-closed.
// ---------------------------------------------------------------------------
const PY_ANALYZER = String.raw`
import ast, json, sys

# Nombres cuya sola REFERENCIA se señala: alias como "f = eval" o "g = __import__"
# derrotan cualquier detección de llamadas, así que se bloquea el nombre en sí.
BANNED_NAMES = {"eval", "exec", "compile", "__import__", "__builtins__", "__loader__", "__spec__"}
# En posicion de ATRIBUTO "compile" NO se banea (re.compile es legitimo); el resto si:
# importlib.import_module, builtins.eval, x.__import__, obj.__builtins__...
BANNED_ATTRS = {"import_module", "__import__", "eval", "exec", "__builtins__", "__loader__", "__spec__"}

def analyze(src):
    tree = ast.parse(src)
    imports, dynamic = [], []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                imports.append(node.module)
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            dynamic.append(f"linea {node.lineno}: referencia a {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr in BANNED_ATTRS:
            dynamic.append(f"linea {node.lineno}: acceso a atributo {node.attr}")
    return imports, dynamic

out = []
for f in json.load(sys.stdin):
    try:
        imports, dynamic = analyze(f["content"])
        out.append({"path": f["path"], "imports": imports, "dynamic": dynamic, "error": None})
    except SyntaxError as e:
        out.append({"path": f["path"], "imports": [], "dynamic": [], "error": f"SyntaxError: {e.msg} (linea {e.lineno})"})
json.dump(out, sys.stdout)
`;

interface PyFileResult {
  path: string;
  imports: string[];
  dynamic: string[];
  error: string | null;
}

function extractPython(files: SourceFile[]): AstExtraction {
  const res: AstExtraction = { imports: [], dynamicFindings: [], parseErrors: [] };
  if (files.length === 0) return res;
  const proc = spawnSync("python3", ["-I", "-c", PY_ANALYZER], {
    input: JSON.stringify(files.map((f) => ({ path: f.path, content: f.content }))),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Fail-closed: sin intérprete, con crash o con salida ilegible NO hay análisis
  // → TODOS los ficheros quedan como no parseables y el bot se rechaza.
  if (proc.error || proc.status !== 0) {
    const why = proc.error ? String(proc.error) : `python3 salió con código ${proc.status}: ${proc.stderr}`;
    for (const f of files) res.parseErrors.push({ path: f.path, detail: `análisis AST no ejecutable (${why})` });
    return res;
  }
  let parsed: PyFileResult[];
  try {
    parsed = JSON.parse(proc.stdout) as PyFileResult[];
    if (!Array.isArray(parsed) || parsed.length !== files.length) throw new Error("salida incompleta");
  } catch (e) {
    for (const f of files) res.parseErrors.push({ path: f.path, detail: `salida del analizador AST ilegible (${String(e)})` });
    return res;
  }
  for (const r of parsed) {
    if (r.error) res.parseErrors.push({ path: r.path, detail: r.error });
    res.imports.push(...r.imports);
    for (const d of r.dynamic) res.dynamicFindings.push({ path: r.path, detail: d });
  }
  return res;
}

// ---------------------------------------------------------------------------
// JS · acorn. ESM primero y CJS como respaldo; si ninguno parsea → fail-closed.
// ---------------------------------------------------------------------------
type Node = acorn.Node & Record<string, unknown>;

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    walk(n[key], visit);
  }
}

function parseJs(content: string): acorn.Program {
  try {
    return acorn.parse(content, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch {
    // Los bots CJS legítimos (require + module.exports) no parsean como módulo.
    return acorn.parse(content, { ecmaVersion: "latest", sourceType: "script", locations: true });
  }
}

function line(n: Node): number {
  return (n.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0;
}

function extractNode(files: SourceFile[]): AstExtraction {
  const res: AstExtraction = { imports: [], dynamicFindings: [], parseErrors: [] };
  for (const f of files) {
    let tree: acorn.Program;
    try {
      tree = parseJs(f.content);
    } catch (e) {
      res.parseErrors.push({ path: f.path, detail: e instanceof SyntaxError ? e.message : String(e) });
      continue;
    }
    walk(tree, (n) => {
      switch (n.type) {
        case "ImportDeclaration":
        case "ExportNamedDeclaration":
        case "ExportAllDeclaration": {
          const src = n.source as Node | null;
          if (src && src.type === "Literal" && typeof src.value === "string") res.imports.push(src.value);
          break;
        }
        case "ImportExpression": {
          const src = n.source as Node;
          if (src.type === "Literal" && typeof src.value === "string") {
            res.imports.push(src.value);
          } else {
            res.dynamicFindings.push({ path: f.path, detail: `línea ${line(n)}: import() dinámico con argumento no literal` });
          }
          break;
        }
        case "CallExpression": {
          const callee = n.callee as Node;
          if (callee.type === "Identifier" && callee.name === "require") {
            const arg = (n.arguments as Node[])[0];
            if (arg && arg.type === "Literal" && typeof arg.value === "string") {
              res.imports.push(arg.value);
            } else {
              res.dynamicFindings.push({ path: f.path, detail: `línea ${line(n)}: require() con argumento no literal` });
            }
          }
          break;
        }
        case "Identifier": {
          // Como en Python: la sola referencia a eval/Function permite aliasing
          // ("const f = eval"), así que se bloquea el nombre, no solo la llamada.
          if (n.name === "eval") {
            res.dynamicFindings.push({ path: f.path, detail: `línea ${line(n)}: referencia a eval` });
          } else if (n.name === "Function") {
            res.dynamicFindings.push({ path: f.path, detail: `línea ${line(n)}: referencia al constructor Function` });
          }
          break;
        }
      }
    });
  }
  return res;
}

/** Ficheros de código del runtime (los demás — lockfiles, manifiestos — no se parsean). */
export function codeFiles(runtime: Runtime, files: SourceFile[]): SourceFile[] {
  if (runtime === "python") return files.filter((f) => f.path.endsWith(".py"));
  return files.filter((f) => /\.(m?js|cjs|ts)$/.test(f.path));
}

/**
 * Extrae imports y hallazgos dinámicos del AST real. Los `.ts` en bots Node se
 * rechazan (parseError): el runtime no los ejecuta y acorn no los parsea.
 */
export function extractAst(runtime: Runtime, files: SourceFile[]): AstExtraction {
  const code = codeFiles(runtime, files);
  if (runtime === "python") return extractPython(code);
  const ts = code.filter((f) => f.path.endsWith(".ts"));
  const js = code.filter((f) => !f.path.endsWith(".ts"));
  const res = extractNode(js);
  for (const f of ts) {
    res.parseErrors.push({ path: f.path, detail: "TypeScript no es ejecutable por el runtime de bots: entrega JS" });
  }
  return res;
}
