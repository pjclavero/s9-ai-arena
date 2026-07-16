import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PYTHON_ALLOWLIST, DEFAULT_NODE_ALLOWLIST, DEFAULT_CONFIG } from "../src/config.js";
import { analyze, parsePythonRequirements } from "../src/static-analysis.js";
import { digestViolations } from "../../../scripts/verify-runtime-digests.js";
import { pyGoodFiles } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimes = join(__dirname, "..", "..", "..", "runtimes");

describe("T6.3 · runtimes fijados por lenguaje", () => {
  it("la allowlist Python del pipeline coincide con el lockfile del runtime", () => {
    const lock = readFileSync(join(runtimes, "python", "allowed-requirements.lock"), "utf8");
    const pkgs = new Set(parsePythonRequirements(lock).map((d) => d.name));
    for (const p of DEFAULT_PYTHON_ALLOWLIST) expect(pkgs.has(p)).toBe(true);
  });

  it("la allowlist Node del pipeline coincide con allowed-package.json", () => {
    const pkg = JSON.parse(readFileSync(join(runtimes, "node", "allowed-package.json"), "utf8"));
    const declared = new Set(Object.keys(pkg.dependencies));
    for (const p of DEFAULT_NODE_ALLOWLIST) expect(declared.has(p)).toBe(true);
  });

  it("el Dockerfile Python deshabilita pip en ejecución", () => {
    const df = readFileSync(join(runtimes, "python", "Dockerfile"), "utf8");
    expect(df).toMatch(/pip uninstall/);
    expect(df).toMatch(/pip está deshabilitado/);
    expect(df).toMatch(/USER 10001/);
  });

  it("el Dockerfile Node deshabilita npm/pnpm/yarn en ejecución", () => {
    const df = readFileSync(join(runtimes, "node", "Dockerfile"), "utf8");
    expect(df).toMatch(/rm -f .*\/npm/);
    expect(df).toMatch(/corepack/);
    expect(df).toMatch(/USER 10001/);
  });

  it("las imágenes de runtime están fijadas por digest, no por tag", () => {
    expect(digestViolations()).toEqual([]);
  });

  it("un bot que importa un paquete no incluido falla identificando el import (T6.3 DoD)", () => {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import scipy\n" + bot.content; // no está en la allowlist del runtime
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.disallowedImports).toContain("scipy");
    expect(res.reasons.join(" ")).toMatch(/scipy/);
  });
});
