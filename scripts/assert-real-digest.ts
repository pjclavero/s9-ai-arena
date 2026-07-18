#!/usr/bin/env -S npx tsx
/**
 * R1.6 — Expone el guard de digests a los scripts de shell.
 *
 *   npx tsx scripts/assert-real-digest.ts <ref> [contexto]
 *
 * Sale 0 si la referencia está fijada por un digest REAL; 1 si es un placeholder
 * (000…0, PENDIENTE) o no lleva @sha256. Lo usa run-escape-suite.sh para no
 * "probar" el sandbox contra una imagen que no existe (ERR-SEC-04).
 */
import { assertRealDigest, PlaceholderDigestError } from "../apps/bot-manager/src/digest-guard.js";

const ref = process.argv[2];
const context = process.argv[3] ?? "assert-real-digest";

if (!ref) {
  console.error("uso: assert-real-digest.ts <ref> [contexto]");
  process.exit(1);
}

// El guard cubre los placeholders de ceros, pero no una referencia sin @sha256 ni
// un pseudo-digest como `@sha256:PENDIENTE` (que es justo lo que el CI pasaba a la
// suite de escape). Exigir la forma canónica aquí no cambia la semántica del guard
// para el resto de usos.
const CANONICAL = /@sha256:[0-9a-f]{64}$/;

try {
  if (!CANONICAL.test(ref)) {
    console.error(`${context}: la referencia no está fijada por un digest canónico (@sha256:<64 hex>): ${ref}`);
    process.exit(1);
  }
  assertRealDigest(ref, context);
  console.log(`digest real: ${ref}`);
} catch (err) {
  if (err instanceof PlaceholderDigestError) {
    console.error(`${context}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
