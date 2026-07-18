import { describe, it, expect } from "vitest";
import { analyze, extractImports, parsePythonRequirements, parsePackageJsonDeps } from "../src/static-analysis.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { pyGoodFiles, jsGoodFiles, pyBadDepFiles } from "./fixtures.js";

describe("T6.1/T6.3 · análisis estático y dependencias", () => {
  it("extrae dependencias de requirements.txt (con y sin versión)", () => {
    const deps = parsePythonRequirements("numpy==1.26.4\narena-sdk\n# comentario\nrequests>=2.0");
    expect(deps.map((d) => d.name)).toEqual(["numpy", "arena-sdk", "requests"]);
    expect(deps[0].version).toBe("1.26.4");
  });

  it("extrae dependencias de package.json", () => {
    const deps = parsePackageJsonDeps(JSON.stringify({ dependencies: { ws: "^8", "@arena/sdk": "1.0.0" } }));
    expect(deps.map((d) => d.name).sort()).toEqual(["@arena/sdk", "ws"]);
  });

  it("extrae imports Python (import y from ... import) desde el AST real", () => {
    const imports = extractImports("python", pyGoodFiles());
    expect(imports).toContain("numpy");
    expect(imports).toContain("arena_sdk");
    expect(imports).toContain("math");
  });

  it("un bot Python correcto pasa el análisis", () => {
    const res = analyze("python", pyGoodFiles(), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.hasLockfile).toBe(true);
  });

  it("un bot JS correcto pasa el análisis", () => {
    const res = analyze("node", jsGoodFiles(), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
  });

  it("una dependencia fuera de la allowlist se señala con el paquete", () => {
    const res = analyze("python", pyBadDepFiles(), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.disallowedDeps).toContain("requests");
    expect(res.reasons.join(" ")).toMatch(/requests/);
  });

  it("un import de terceros no permitido se detecta aunque no esté declarado", () => {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import pandas\n" + bot.content;
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.disallowedImports).toContain("pandas");
    expect(res.ok).toBe(false);
  });

  // H1 (issue #5): antes solo se señalaban; ahora la política por defecto BLOQUEA.
  it("los imports peligrosos (red/proceso) se señalan Y BLOQUEAN con la política por defecto (H1, issue #5)", () => {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import socket\nimport subprocess\n" + bot.content;
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.dangerousImports).toEqual(expect.arrayContaining(["socket", "subprocess"]));
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/builtin peligroso bloqueado por política.*socket/);
  });

  it("con la política 'audit', los imports peligrosos solo se señalan (comportamiento anterior)", () => {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import socket\nimport subprocess\n" + bot.content;
    const cfg = {
      ...DEFAULT_CONFIG,
      dangerousBuiltins: { ...DEFAULT_CONFIG.dangerousBuiltins, mode: "audit" as const },
    };
    const res = analyze("python", files, cfg);
    expect(res.dangerousImports).toEqual(expect.arrayContaining(["socket", "subprocess"]));
    expect(res.ok).toBe(true);
  });

  it("los builtins peligrosos de Node se detectan también con el prefijo node: (child_process, net…)", () => {
    const files = jsGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.js")!;
    bot.content = "import { exec } from 'node:child_process';\nimport net from 'net';\n" + bot.content;
    const res = analyze("node", files, DEFAULT_CONFIG);
    expect(res.dangerousImports).toEqual(expect.arrayContaining(["node:child_process", "net"]));
    expect(res.ok).toBe(false);
  });

  it("falta de lockfile bloquea", () => {
    const files = pyGoodFiles().filter((f) => f.path !== "requirements.lock");
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.hasLockfile).toBe(false);
    expect(res.ok).toBe(false);
  });
});

// R2.4 (ERR-SEC-06) · el análisis es del AST REAL, no de regexes por línea.
describe("R2.4 · análisis AST: módulos peligrosos ampliados", () => {
  function pyWith(extra: string) {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = extra + "\n" + bot.content;
    return files;
  }
  function jsWith(extra: string) {
    const files = jsGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.js")!;
    bot.content = extra + "\n" + bot.content;
    return files;
  }

  it("DoD: `import os` ya NO es stdlib inocua — se detecta y bloquea", () => {
    const res = analyze("python", pyWith("import os"), DEFAULT_CONFIG);
    expect(res.dangerousImports).toContain("os");
    expect(res.ok).toBe(false);
  });

  it("los módulos nuevos de la lista (importlib, pickle, marshal, pty, runpy, code, shutil) bloquean", () => {
    for (const mod of ["importlib", "pickle", "marshal", "pty", "runpy", "code", "shutil"]) {
      const res = analyze("python", pyWith(`import ${mod}`), DEFAULT_CONFIG);
      expect(res.dangerousImports, mod).toContain(mod);
      expect(res.ok, mod).toBe(false);
    }
  });

  it("`process` sale de los builtins permitidos de Node y bloquea (también con node:)", () => {
    for (const spec of ["process", "node:process"]) {
      const res = analyze("node", jsWith(`import p from '${spec}';`), DEFAULT_CONFIG);
      expect(res.dangerousImports, spec).toContain(spec);
      expect(res.ok, spec).toBe(false);
    }
  });

  it("el AST ve el import multilínea y dentro de condicionales que la regex por línea no veía", () => {
    const res = analyze(
      "python",
      pyWith("if True:\n    import socket  # sangrado: la regex anclada a ^import no lo veía"),
      DEFAULT_CONFIG,
    );
    expect(res.dangerousImports).toContain("socket");
    expect(res.ok).toBe(false);
  });
});

describe("R2.4 · imports dinámicos, eval/exec y __builtins__", () => {
  function pyWith(extra: string) {
    const files = pyGoodFiles();
    files.find((f) => f.path === "src/bot.py")!.content += "\n" + extra + "\n";
    return files;
  }
  function jsWith(extra: string) {
    const files = jsGoodFiles();
    files.find((f) => f.path === "src/bot.js")!.content += "\n" + extra + "\n";
    return files;
  }

  it("DoD: __import__('os') se detecta por el AST y bloquea", () => {
    const res = analyze("python", pyWith("m = __import__('o' + 's')"), DEFAULT_CONFIG);
    expect(res.dynamicFindings.length).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/__import__/);
  });

  it("importlib.import_module con alias se detecta (referencia al atributo, no al nombre)", () => {
    const res = analyze("python", pyWith("import importlib as il\nil.import_module('os')"), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/import_module|importlib/);
  });

  it("eval/exec en Python bloquean, incluso solo REFERENCIADOS (aliasing f = eval)", () => {
    for (const snippet of ["eval('1+1')", "exec('pass')", "f = eval"]) {
      const res = analyze("python", pyWith(snippet), DEFAULT_CONFIG);
      expect(res.ok, snippet).toBe(false);
      expect(res.dynamicFindings.length, snippet).toBeGreaterThan(0);
    }
  });

  it("el acceso a __builtins__ bloquea", () => {
    const res = analyze("python", pyWith("b = __builtins__"), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/__builtins__/);
  });

  it("import()/require() con argumento NO literal bloquean en JS; eval y Function también", () => {
    for (const snippet of [
      "const m = 'node:child_process'; import(m);",
      "const r = require; const x = 'fs'; require(x);",
      "eval('1+1');",
      "const F = Function; F('return 1')();",
    ]) {
      const res = analyze("node", jsWith(snippet), DEFAULT_CONFIG);
      expect(res.ok, snippet).toBe(false);
      expect(res.dynamicFindings.length, snippet).toBeGreaterThan(0);
    }
  });

  it("import('literal') y require('literal') NO son dinámicos: se resuelven como import normal", () => {
    const res = analyze("node", jsWith("import('ws');"), DEFAULT_CONFIG);
    expect(res.dynamicFindings).toEqual([]);
    expect(res.imports).toContain("ws");
  });
});

describe("R2.4 · fail-closed: lo que no parsea se rechaza", () => {
  it("un bot Python con sintaxis inválida se rechaza con el fichero señalado", () => {
    const files = pyGoodFiles();
    files.find((f) => f.path === "src/bot.py")!.content = "def broken(:\n  pass";
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.parseErrors.length).toBe(1);
    expect(res.parseErrors[0].path).toBe("src/bot.py");
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/fail-closed/);
  });

  it("un bot JS con sintaxis inválida se rechaza", () => {
    const files = jsGoodFiles();
    files.find((f) => f.path === "src/bot.js")!.content = "function ( {{{";
    const res = analyze("node", files, DEFAULT_CONFIG);
    expect(res.parseErrors.length).toBe(1);
    expect(res.ok).toBe(false);
  });

  it("un bot Node con .ts se rechaza: el runtime no ejecuta TypeScript y no se analiza otro árbol", () => {
    const files = jsGoodFiles();
    files.push({ path: "src/helper.ts", content: "export const x: number = 1;" });
    const res = analyze("node", files, DEFAULT_CONFIG);
    expect(res.parseErrors.some((p) => p.path === "src/helper.ts")).toBe(true);
    expect(res.ok).toBe(false);
  });

  it("un bot JS CommonJS legítimo (require + module.exports) sí parsea", () => {
    const files = jsGoodFiles();
    files.find((f) => f.path === "src/bot.js")!.content =
      "const { WebSocket } = require('ws');\nmodule.exports.decide = (obs) => ({ forTick: obs.tick });\n";
    const res = analyze("node", files, DEFAULT_CONFIG);
    expect(res.parseErrors).toEqual([]);
    expect(res.imports).toContain("ws");
  });
});
