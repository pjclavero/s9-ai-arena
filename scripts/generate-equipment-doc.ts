/**
 * DOC-A · Escribe docs/user/equipment-catalog.md desde el catálogo real de módulos.
 * Uso: `npx tsx scripts/generate-equipment-doc.ts`. El test
 * packages/module-catalog/equipment-doc.test.ts comprueba que el repo está al día.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { equipmentDocMarkdown } from "../packages/module-catalog/equipment-doc.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(root, "docs/user/equipment-catalog.md"), equipmentDocMarkdown());
console.log("docs/user/equipment-catalog.md regenerado");
