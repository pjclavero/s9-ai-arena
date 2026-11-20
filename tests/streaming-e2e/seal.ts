/**
 * EQ5b · Utilidad del E2E local: sella una clave de PRUEBA con la clave pública,
 * leyendo AMBAS de ficheros (nunca de argv) y escribiendo el sobre JSON en stdout.
 *
 *   npx tsx tests/streaming-e2e/seal.ts <publica.pem> <fichero-clave> <plataforma> <ingesta> > sobre.json
 *
 * EQ5c · el sobre queda ATADO a plataforma + ingesta (no son secretos: van en argv).
 */
import { readFileSync } from "node:fs";
import { sealSecret } from "../../packages/stream-secrets/index.js";

const [pubFile, keyFile, platform, ingest] = process.argv.slice(2);
if (!pubFile || !keyFile || !platform || !ingest)
  throw new Error("uso: seal.ts <publica.pem> <fichero-clave> <plataforma> <ingesta>");
const sealed = sealSecret(readFileSync(keyFile, "utf8").trim(), readFileSync(pubFile, "utf8"), { platform, ingest });
process.stdout.write(JSON.stringify(sealed));
