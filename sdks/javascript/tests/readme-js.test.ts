/**
 * UX-05 (G-06) · el camino documentado para bots JavaScript es JavaScript ESM que
 * el build ACEPTA: el bloque del README es idéntico a tests/tutorial-bot.js, y ése
 * y los ejemplos oficiales pasan el análisis estático real del pipeline (antes
 * eran TypeScript y se rechazaban), exportan por defecto una subclase de ArenaBot
 * (lo que busca el arranque del sandbox) e implementan onObservation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyze } from "../../../apps/bot-manager/src/static-analysis.js";
import { DEFAULT_CONFIG } from "../../../apps/bot-manager/src/config.js";
import { wrapSingleFile } from "../../../apps/api/src/services/source-package.js";
import { ArenaBot } from "../src/index.js";

const README = readFileSync("sdks/javascript/README.md", "utf8");
const UPLOADABLE = [
  "sdks/javascript/tests/tutorial-bot.js",
  "example-bots/javascript/gunner.js",
  "example-bots/javascript/miner.js",
];

describe("UX-05 · bots JavaScript documentados = JavaScript que el build acepta", () => {
  it("el primer bloque de código del README es exactamente tests/tutorial-bot.js", () => {
    const block = /```javascript\n([\s\S]*?)```/.exec(README)?.[1];
    expect(block).toBe(readFileSync("sdks/javascript/tests/tutorial-bot.js", "utf8"));
  });

  it("el README no enseña TypeScript como código a subir", () => {
    expect(README).not.toMatch(/```typescript/);
  });

  for (const path of UPLOADABLE) {
    it(`${path}: pasa el análisis estático del build tal cual (sin errores de parseo ni imports prohibidos)`, () => {
      const res = analyze("node", wrapSingleFile("node", readFileSync(path, "utf8")), DEFAULT_CONFIG);
      expect(res.parseErrors).toEqual([]);
      expect(res.dynamicFindings).toEqual([]);
      expect(res.disallowedImports).toEqual([]);
    });

    it(`${path}: exporta por defecto una subclase de ArenaBot que implementa onObservation`, async () => {
      const mod = await import(`../../../${path}`);
      expect(mod.default.prototype).toBeInstanceOf(ArenaBot);
      expect(mod.default.prototype.onObservation).not.toBe(ArenaBot.prototype.onObservation);
    });
  }
});
