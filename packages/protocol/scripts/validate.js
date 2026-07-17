#!/usr/bin/env node
/* arena-protocol validate <file|dir>
 *
 * Valida documentos contra el envelope de arena/1. Sin argumentos, ejecuta la
 * suite completa: todos los examples/valid deben pasar y todos los
 * examples/invalid deben fallar. Es el test que exige la DoD de T1.2.
 */
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const SCHEMA_DIR = path.join(__dirname, "..", "schemas");
const EX_DIR = path.join(__dirname, "..", "examples");

function buildValidator() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), "utf8"));
    // Registramos cada esquema con su nombre de fichero para que los $ref relativos resuelvan.
    ajv.addSchema(schema, f);
  }
  return ajv.getSchema("envelope.schema.json");
}

function stripMeta(doc) {
  const { _why, ...rest } = doc;
  return rest;
}

function validateFile(validate, file) {
  const doc = stripMeta(JSON.parse(fs.readFileSync(file, "utf8")));
  const ok = validate(doc);
  return { ok, errors: validate.errors ? [...validate.errors] : [] };
}

function main() {
  const validate = buildValidator();
  const arg = process.argv[2];

  if (arg) {
    const files = fs.statSync(arg).isDirectory()
      ? fs
          .readdirSync(arg)
          .filter((f) => f.endsWith(".json"))
          .map((f) => path.join(arg, f))
      : [arg];
    let bad = 0;
    for (const f of files) {
      const { ok, errors } = validateFile(validate, f);
      console.log(`${ok ? "OK  " : "FAIL"} ${path.basename(f)}`);
      if (!ok) {
        bad++;
        for (const e of errors) console.log(`       ${e.instancePath || "/"} ${e.message}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }

  // Suite completa
  let failures = 0;
  const validDir = path.join(EX_DIR, "valid");
  const invalidDir = path.join(EX_DIR, "invalid");

  console.log("== examples/valid (deben PASAR) ==");
  for (const f of fs.readdirSync(validDir).sort()) {
    const { ok, errors } = validateFile(validate, path.join(validDir, f));
    if (ok) console.log(`  OK    ${f}`);
    else {
      failures++;
      console.log(`  FALLO ${f}`);
      for (const e of errors.slice(0, 3)) console.log(`          ${e.instancePath || "/"} ${e.message}`);
    }
  }

  console.log("\n== examples/invalid (deben SER RECHAZADOS) ==");
  for (const f of fs.readdirSync(invalidDir).sort()) {
    const why = JSON.parse(fs.readFileSync(path.join(invalidDir, f), "utf8"))._why;
    const { ok } = validateFile(validate, path.join(invalidDir, f));
    if (!ok) console.log(`  OK    ${f}  (${why})`);
    else {
      failures++;
      console.log(`  FALLO ${f}: fue ACEPTADO y no debia serlo (${why})`);
    }
  }

  console.log(`\n${failures === 0 ? "TODO CORRECTO" : failures + " FALLO(S)"}`);
  process.exit(failures ? 1 : 0);
}

main();
