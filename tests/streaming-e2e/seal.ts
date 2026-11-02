/**
 * EQ5b · Utilidad del E2E local: sella una clave de PRUEBA con la clave pública,
 * leyendo AMBAS de ficheros (nunca de argv) y escribiendo el sobre JSON en stdout.
 *
 *   npx tsx tests/streaming-e2e/seal.ts <publica.pem> <fichero-clave> > sobre.json
 */
import { readFileSync } from "node:fs";
import { sealSecret } from "../../packages/stream-secrets/index.js";

const [pubFile, keyFile] = process.argv.slice(2);
if (!pubFile || !keyFile) throw new Error("uso: seal.ts <publica.pem> <fichero-clave>");
const sealed = sealSecret(readFileSync(keyFile, "utf8").trim(), readFileSync(pubFile, "utf8"));
process.stdout.write(JSON.stringify(sealed));
