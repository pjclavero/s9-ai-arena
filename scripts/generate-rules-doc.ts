/**
 * EQ2 · ADR-022 · Escribe docs/user/rules.md y docs/user/rules.json desde el registro de
 * reglas. Uso: `npx tsx scripts/generate-rules-doc.ts`. El test
 * packages/game-rules/rules-doc.test.ts comprueba que el repo está al día.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rulesDocJson, rulesDocMarkdown } from "../packages/game-rules/rules-doc.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "docs/user/rules.md"), rulesDocMarkdown());
writeFileSync(join(root, "docs/user/rules.json"), JSON.stringify(rulesDocJson(), null, 2) + "\n");
console.log("docs/user/rules.md y docs/user/rules.json regenerados");
