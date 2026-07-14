#!/usr/bin/env node
/**
 * T5.3 · Genera sdks/javascript/src/generated-types.ts a partir de
 * packages/protocol/schemas/*.json con json-schema-to-typescript — igual mecanismo
 * que documenta packages/protocol/README.md ("los tipos TS se generan desde los
 * esquemas en build; no se escriben a mano"). Salida determinista, committeada:
 * evita depender de correr codegen antes de cada test.
 *
 * Uso: node generate-types.mjs
 */
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "..", "packages", "protocol", "schemas");
const OUT_FILE = join(__dirname, "src", "generated-types.ts");

const TARGETS = [
  ["envelope.schema.json", "Envelope"],
  ["hello.schema.json", "HelloPayload"],
  ["welcome.schema.json", "WelcomePayload"],
  ["observation.schema.json", "ObservationPayload"],
  ["command.schema.json", "CommandPayload"],
  ["event.schema.json", "EventPayload"],
  ["shutdown.schema.json", "ShutdownPayload"],
];

async function main() {
  const parts = [
    "/**",
    " * GENERADO — no editar a mano.",
    " * Fuente: packages/protocol/schemas/*.json (E1).",
    " * Regenerar: node sdks/javascript/generate-types.mjs",
    " */",
    "",
  ];

  for (const [file, typeName] of TARGETS) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    const ts = await compile(schema, typeName, {
      cwd: SCHEMA_DIR,
      bannerComment: "",
      additionalProperties: false,
      style: { semi: true, singleQuote: false },
    });
    parts.push(ts.trim(), "");
  }

  writeFileSync(OUT_FILE, parts.join("\n") + "\n");
  console.log(`Tipos escritos en ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
