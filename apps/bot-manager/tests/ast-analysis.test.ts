/**
 * B3 — regresión de dos hallazgos reales de producción:
 *
 *  1) La imagen `bot-manager`/`bot-build-worker` no tenía `python3`: TODO bot
 *     Python quedaba rechazado fail-closed en `static_analysis` con
 *     "spawnSync python3 ENOENT" (verificado en la BD de producción). El fix
 *     es de infraestructura (infrastructure/docker/bot-manager/Dockerfile), no
 *     de código — aquí se prueba que python3 SIGUE disponible en ESTE entorno
 *     y que el analizador AST real puede analizar Python de verdad con él.
 *
 *  2) `parseJs` reportaba el error del intento de FALLBACK (sourceType:
 *     "script"), no el del intento real (sourceType: "module"). Reproducido
 *     con example-bots/javascript/gunner.ts (TypeScript): el usuario veía
 *     "'import' and 'export' may appear only with 'sourceType: module'"
 *     cuando la causa real era "Unexpected token" sobre una anotación de tipo.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extractAst } from "../src/ast-analysis.js";
import type { SourceFile } from "../src/types.js";

describe("B3 · python3 disponible + AST real de Python", () => {
  it("VERIFICACIÓN REAL: python3 está en el PATH de este entorno de ejecución", () => {
    // Esto NO prueba que la imagen Docker de bot-manager tenga python3 (eso
    // requeriría construir y arrancar la imagen; ver más abajo el test que sí
    // parsea el propio Dockerfile como comprobación indirecta). Esto prueba
    // que, DONDE CORREN ESTOS TESTS, `spawnSync("python3", ...)` funciona —
    // que es exactamente la llamada que hace extractPython.
    const proc = spawnSync("python3", ["-c", "print('ok')"], { encoding: "utf8" });
    expect(proc.error).toBeUndefined();
    expect(proc.status).toBe(0);
    expect(proc.stdout.trim()).toBe("ok");
  });

  it("VERIFICACIÓN REAL: extractAst analiza un fichero Python real con python3, sin parseErrors", () => {
    const files: SourceFile[] = [
      {
        path: "src/bot.py",
        content: readFileSync("bots/s9-smoke-bot/main.py", "utf8"),
      },
    ];
    const res = extractAst("python", files);
    expect(res.parseErrors).toEqual([]);
    expect(res.imports).toContain("arena_sdk");
    expect(res.imports).toContain("os");
  });

  it("VERIFICACIÓN REAL: sin python3 en el PATH, extractAst rechaza fail-closed (no aprueba lo que no pudo analizar)", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = ""; // ningún ejecutable resoluble, incluido python3
      const res = extractAst("python", [{ path: "src/bot.py", content: "import os\n" }]);
      expect(res.parseErrors).toHaveLength(1);
      expect(res.parseErrors[0].detail).toMatch(/ENOENT|python3/i);
      expect(res.imports).toEqual([]); // fail-closed: nada se aprueba
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("B3 · Dockerfile de bot-manager instala python3 (comprobación INDIRECTA, no construida)", () => {
  it("infrastructure/docker/bot-manager/Dockerfile instala python3 vía apk", () => {
    // Comprobación indirecta: se parsea el texto del Dockerfile, NO se
    // construye la imagen (requeriría Docker en este entorno de tests). Si
    // Docker estuviera disponible se podría construir de verdad y ejecutar
    // `docker run --rm <imagen> python3 --version`; aquí solo se verifica que
    // la instrucción de instalación está presente y en la imagen correcta.
    const dockerfile = readFileSync("infrastructure/docker/bot-manager/Dockerfile", "utf8");
    expect(dockerfile).toMatch(/apk add[^\n]*python3/);
    // No debe ampliarse la superficie de la imagen genérica (compartida por
    // api/web/map-service/replay-service/tournament-worker): esa NO debe
    // instalar python3.
    const generic = readFileSync("infrastructure/docker/node-service/Dockerfile", "utf8");
    expect(generic).not.toMatch(/python3/);
  });

  it("el Compose apunta bot-manager y bot-build-worker a la imagen con python3, no a la genérica", () => {
    const compose = readFileSync("infrastructure/docker-compose.yml", "utf8");
    const botManagerBlock = compose.slice(
      compose.indexOf("\n  bot-manager:"),
      compose.indexOf("\n  bot-build-worker:"),
    );
    const botBuildWorkerBlock = compose.slice(
      compose.indexOf("\n  bot-build-worker:"),
      compose.indexOf("\n  map-service:"),
    );
    expect(botManagerBlock).toMatch(/dockerfile: infrastructure\/docker\/bot-manager\/Dockerfile/);
    expect(botBuildWorkerBlock).toMatch(/dockerfile: infrastructure\/docker\/bot-manager\/Dockerfile/);
  });
});

describe("B3 · mensaje de error real (causa 3: el fallback mentía)", () => {
  it("un fichero TypeScript produce un mensaje que menciona la causa REAL, no la del reintento CJS", () => {
    const gunnerTs = readFileSync("example-bots/javascript/gunner.ts", "utf8");
    const res = extractAst("node", [{ path: "src/bot.js", content: gunnerTs }]);
    expect(res.parseErrors).toHaveLength(1);
    const detail = res.parseErrors[0].detail;
    // Antes del fix: el mensaje era el del reintento como script, sobre
    // sourceType/import/export — una pista falsa. Ahora NO debe aparecer eso...
    expect(detail).not.toMatch(/sourceType: module/);
    // ...y SÍ debe apuntar a la causa real (el primer intento, como módulo,
    // revienta con "Unexpected token" en la anotación de tipo) más la pista
    // explícita de que el fichero parece TypeScript.
    expect(detail).toMatch(/Unexpected token/);
    expect(detail).toMatch(/TypeScript/);
  });

  it("un CJS legítimo (require + module.exports) sigue aceptándose vía el respaldo como script", () => {
    const cjs = 'const { x } = require("y");\nmodule.exports = function decide() { return x; };\n';
    const res = extractAst("node", [{ path: "src/bot.js", content: cjs }]);
    expect(res.parseErrors).toEqual([]);
    expect(res.imports).toContain("y");
  });

  it("un JS realmente inválido (ni módulo ni script) da un mensaje sin ruido de TypeScript", () => {
    const brokenJs = "function decide( {\n"; // paréntesis sin cerrar: inválido en ambos sourceType
    const res = extractAst("node", [{ path: "src/bot.js", content: brokenJs }]);
    expect(res.parseErrors).toHaveLength(1);
    expect(res.parseErrors[0].detail).not.toMatch(/TypeScript/);
  });
});
