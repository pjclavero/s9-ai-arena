/**
 * DOC-A · BOT_EXAMPLES · la guía (docs/user/bots/ejemplos.md) muestra los ficheros TAL CUAL,
 * y los ejemplos de Python pasan el mismo análisis estático del build que exige la web.
 * (La ejecución real de los ejemplos: docs-examples.test.ts y, en Python,
 * sdks/python/tests/test_docs_examples.py.)
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../../../apps/bot-manager/src/static-analysis.js";
import { DEFAULT_CONFIG } from "../../../apps/bot-manager/src/config.js";
import { wrapSingleFile } from "../../../apps/api/src/services/source-package.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BASE = join(ROOT, "docs", "user", "bots", "examples");
const list = (lang: string, ext: string) =>
  readdirSync(join(BASE, lang))
    .filter((f) => f.endsWith(ext))
    .sort();
const read = (lang: string, f: string) => readFileSync(join(BASE, lang, f), "utf8");
const guia = readFileSync(join(ROOT, "docs", "user", "bots", "ejemplos.md"), "utf8");
const bloques = (lang: string) =>
  [...guia.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]);

describe("DOC-A · la guía de ejemplos es idéntica a los ficheros verificados", () => {
  for (const [lang, ext] of [
    ["javascript", ".js"],
    ["python", ".py"],
  ] as const) {
    it(`hay seis ejemplos ${lang} y todos aparecen tal cual en la guía`, () => {
      const files = list(lang, ext);
      expect(files).toHaveLength(6);
      const b = bloques(lang);
      for (const f of files) expect(b, f).toContain(read(lang, f));
    });
  }

  for (const f of list("python", ".py")) {
    it(`${f}: pasa el análisis estático del build de Python tal cual`, () => {
      const res = analyze("python", wrapSingleFile("python", read("python", f)), DEFAULT_CONFIG);
      expect(res.parseErrors).toEqual([]);
      expect(res.dynamicFindings).toEqual([]);
      expect(res.disallowedImports).toEqual([]);
    });
  }
});
