/**
 * EQ2 · ADR-022 · La documentación canónica de reglas (docs/user/rules.md y .json) es
 * la que GENERA el registro: si alguien cambia una regla y no regenera, esto se pone rojo.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rulesDocJson, rulesDocMarkdown } from "./rules-doc.js";
import { TIEBREAK_RULES, currentPresets } from "./battle-rules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("docs/user/rules.* generados desde el registro", () => {
  it("rules.md está al día (npx tsx scripts/generate-rules-doc.ts)", () => {
    expect(read("docs/user/rules.md")).toBe(rulesDocMarkdown());
  });
  it("rules.json está al día", () => {
    expect(JSON.parse(read("docs/user/rules.json"))).toEqual(JSON.parse(JSON.stringify(rulesDocJson())));
  });
  it("documenta todos los presets vigentes y todas las familias de desempate", () => {
    const md = rulesDocMarkdown();
    for (const p of currentPresets()) expect(md).toContain(`\`${p.id}@${p.version}\``);
    for (const t of Object.values(TIEBREAK_RULES)) expect(md).toContain(t.label);
    expect(md).toContain("maxRespawns");
    expect(md).toContain("la siguiente captura gana");
  });
});
