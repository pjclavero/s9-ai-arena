#!/usr/bin/env -S npx tsx
/**
 * E6 · T6.3 — Verifica que las imágenes de runtime se referencian por DIGEST, no por tag.
 *
 * Uso (en CI):  npx tsx scripts/verify-runtime-digests.ts
 * Falla (exit 1) si alguna entrada de runtimes/DIGESTS.lock no está fijada por
 * @sha256:<64 hex>, o si algún Dockerfile de runtimes/ usa un FROM con tag mutable.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const runtimesDir = join(root, "runtimes");

export function parseDigests(text: string): { runtime: string; base: string; image: string }[] {
  const out: { runtime: string; base: string; image: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [runtime, base, image] = line.split(/\s+/);
    if (runtime && base && image) out.push({ runtime, base, image });
  }
  return out;
}

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

export function digestViolations(root = runtimesDir): string[] {
  const violations: string[] = [];
  const digests = parseDigests(readFileSync(join(root, "DIGESTS.lock"), "utf8"));
  if (digests.length === 0) violations.push("DIGESTS.lock vacío");
  for (const d of digests) {
    if (!DIGEST_RE.test(d.base)) violations.push(`${d.runtime}: base no fijada por digest: ${d.base}`);
    if (!DIGEST_RE.test(d.image)) violations.push(`${d.runtime}: imagen no fijada por digest: ${d.image}`);
  }
  // Dockerfiles: FROM debe usar @sha256
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const dockerfile = join(root, sub.name, "Dockerfile");
    let content: string;
    try {
      content = readFileSync(dockerfile, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const m = /^FROM\s+(\S+)/i.exec(line.trim());
      if (m && !/@sha256:[0-9a-f]{64}/.test(m[1])) {
        violations.push(`${sub.name}/Dockerfile: FROM sin digest: ${m[1]}`);
      }
    }
  }
  return violations;
}

// Ejecutado directamente (no importado por un test)
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = digestViolations();
  if (v.length) {
    console.error("✗ digests de runtime no conformes:");
    for (const x of v) console.error("   " + x);
    process.exit(1);
  }
  console.log("✓ runtimes fijados por digest");
}
