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

/** Paquetes de la allowlist que NO vienen de un registro publico, sino del propio repo. */
const FROM_REPO = { python: "arena-sdk", node: "@arena/sdk" } as const;

describe("T6.3 · runtimes fijados por lenguaje", () => {
  it("la allowlist Python del pipeline coincide con lo que instala el runtime", () => {
    // R6.1: el invariante real no es "allowlist == lockfile de terceros", porque arena-sdk
    // NO es de terceros: es el SDK del repo y se construye en el build. Lo que debe
    // cumplirse es que CADA paquete de la allowlist tenga un origen declarado: o el lock
    // de terceros (con hash), o el wheel propio construido desde sdks/python.
    const lock = readFileSync(join(runtimes, "python", "allowed-requirements.lock"), "utf8");
    const terceros = new Set(parsePythonRequirements(lock).map((d) => d.name));
    const sdkLock = readFileSync(join(runtimes, "python", "sdk-wheel.lock"), "utf8");

    for (const p of DEFAULT_PYTHON_ALLOWLIST) {
      if (p === FROM_REPO.python) {
        expect(sdkLock, `${p} debe construirse desde el repo y fijar su hash`).toMatch(
          /arena_sdk-[\d.]+-py3-none-any\.whl\s+sha256:[0-9a-f]{64}/,
        );
      } else {
        expect(terceros.has(p), `${p} no esta en allowed-requirements.lock`).toBe(true);
      }
    }
  });

  it("el SDK propio NUNCA se resuelve desde PyPI (dependency confusion)", () => {
    // Regresion de R6.1: el lock pedia `arena-sdk==1.0.0` a PyPI, donde el nombre esta
    // libre. Cualquiera podria publicarlo y su codigo entraria en el runtime de bots.
    const lock = readFileSync(join(runtimes, "python", "allowed-requirements.lock"), "utf8");
    const nombres = parsePythonRequirements(lock).map((d) => d.name);
    expect(nombres).not.toContain("arena-sdk");

    const df = readFileSync(join(runtimes, "python", "Dockerfile"), "utf8");
    expect(df).toMatch(/COPY sdks\/python/); // se construye desde el repo
    expect(df).toMatch(/--no-index/); // sin fallback al registro publico
  });

  it("el SDK Node NUNCA se resuelve desde npmjs (dependency confusion)", () => {
    // El scope @arena no es nuestro en el registro publico.
    const pkg = JSON.parse(readFileSync(join(runtimes, "node", "allowed-package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies)).not.toContain(FROM_REPO.node);

    const df = readFileSync(join(runtimes, "node", "Dockerfile"), "utf8");
    expect(df).toMatch(/COPY sdks\/javascript/);
  });

  it("los locks de los runtimes no tienen hashes placeholder", () => {
    // R6.1: `--require-hashes` con un hash de ceros no verifica nada; el integrity de ws
    // era literalmente una cadena de ceros y `npm ci` lo aceptaba sin comprobar.
    const py = readFileSync(join(runtimes, "python", "allowed-requirements.lock"), "utf8");
    expect(py).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    expect(py).not.toMatch(/sha256:0{64}/);

    const nodeLock = readFileSync(join(runtimes, "node", "allowed-package-lock.json"), "utf8");
    expect(nodeLock).not.toMatch(/sha512-0{40,}/);
    expect(JSON.parse(nodeLock).packages["node_modules/ws"].integrity).toMatch(/^sha512-.+==$/);
  });

  it("la allowlist Node del pipeline coincide con lo que instala el runtime", () => {
    const pkg = JSON.parse(readFileSync(join(runtimes, "node", "allowed-package.json"), "utf8"));
    const declared = new Set(Object.keys(pkg.dependencies));
    for (const p of DEFAULT_NODE_ALLOWLIST) {
      if (p === FROM_REPO.node) continue; // se compila desde sdks/javascript, no se declara
      expect(declared.has(p), `${p} no esta en allowed-package.json`).toBe(true);
    }
  });

  it("la allowlist Python nombra el paquete que el SDK usa de verdad", () => {
    // R6.1: la allowlist pedia "websockets"; el SDK hace `import websocket`, que lo
    // aporta "websocket-client". Son paquetes distintos: el runtime instalaba uno y el
    // pipeline permitia otro.
    expect(DEFAULT_PYTHON_ALLOWLIST.has("websocket-client")).toBe(true);
    expect(DEFAULT_PYTHON_ALLOWLIST.has("websockets")).toBe(false);
    const pyproject = readFileSync(join(runtimes, "..", "sdks", "python", "pyproject.toml"), "utf8");
    expect(pyproject).toMatch(/websocket-client/);
  });

  it("un bot que importa websocket (del SDK) queda permitido pese a llamarse distinto", () => {
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import websocket\n" + bot.content;
    const res = analyze("python", files, DEFAULT_CONFIG);
    expect(res.disallowedImports).not.toContain("websocket");
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
