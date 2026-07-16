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

  it("extrae imports Python (import y from ... import)", () => {
    const imports = extractImports("python", pyGoodFiles());
    expect(imports).toContain("numpy");
    expect(imports).toContain("arena_sdk");
    expect(imports).toContain("os");
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
    const cfg = { ...DEFAULT_CONFIG, dangerousBuiltins: { ...DEFAULT_CONFIG.dangerousBuiltins, mode: "audit" as const } };
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
