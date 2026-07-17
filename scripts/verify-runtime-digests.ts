#!/usr/bin/env -S npx tsx
/**
 * E6 · T6.3 — Verifica que las imágenes de runtime se referencian por DIGEST, no por tag.
 *
 * Uso (en CI):  npx tsx scripts/verify-runtime-digests.ts
 * Falla (exit 1) si alguna entrada de runtimes/DIGESTS.lock no está fijada por
 * @sha256:<64 hex>, si algún Dockerfile de runtimes/ usa un FROM con tag mutable,
 * o (issue #12) si algún sha256 de runtimes/ es un PLACEHOLDER (000…0): mientras
 * queden placeholders, este script NUNCA da OK ("digests placeholder: ejecuta el
 * build real").
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlaceholderSha256, PLACEHOLDER_MSG } from "../apps/bot-manager/src/digest-guard.js";

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
  // Dockerfiles: FROM debe usar @sha256 Y ser la MISMA base que declara DIGESTS.lock.
  // R6.1: comprobar solo "el FROM lleva un @sha256" dejaba pasar que el lock declarase una
  // base y el Dockerfile construyera sobre otra. El lock es la fuente de verdad y hasta
  // ahora nadie ataba las dos cosas: se podia subir la base y olvidar el lock (o al reves)
  // sin que nada protestase, y el lock estaria describiendo una imagen que no existe.
  const baseDelLock = new Map(digests.map((d) => [d.runtime, d.base]));
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const dockerfile = join(root, sub.name, "Dockerfile");
    let content: string;
    try {
      content = readFileSync(dockerfile, "utf8");
    } catch {
      continue;
    }
    const esperada = baseDelLock.get(sub.name);
    for (const line of content.split(/\r?\n/)) {
      const m = /^FROM\s+(\S+)/i.exec(line.trim());
      if (!m) continue;
      if (!/@sha256:[0-9a-f]{64}/.test(m[1])) {
        violations.push(`${sub.name}/Dockerfile: FROM sin digest: ${m[1]}`);
        continue;
      }
      // Las etapas intermedias (AS sdk-builder) tambien construyen sobre la base fijada.
      if (esperada && m[1] !== esperada) {
        violations.push(
          `${sub.name}/Dockerfile: FROM ${m[1]} no coincide con la base de DIGESTS.lock (${esperada})`,
        );
      }
    }
  }
  return violations;
}

/**
 * Issue #12 — Detecta sha256 PLACEHOLDER (mismo carácter repetido 64 veces) en
 * cualquier fichero de runtimes/: DIGESTS.lock, FROM de Dockerfiles y hashes de
 * lockfiles (p. ej. `--hash=sha256:000…0` en allowed-requirements.lock).
 */
export function placeholderViolations(root = runtimesDir): string[] {
  const violations: string[] = [];
  const scanFile = (label: string, path: string) => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Los comentarios que documentan el formato no cuentan.
      const line = lines[i].replace(/#.*$/, "");
      for (const m of line.matchAll(/sha256:([0-9a-fA-F]{64})/g)) {
        if (isPlaceholderSha256(m[1])) {
          violations.push(`${label}:${i + 1}: ${PLACEHOLDER_MSG} (sha256:${m[1].slice(0, 8)}…)`);
        }
      }
    }
  };
  scanFile("DIGESTS.lock", join(root, "DIGESTS.lock"));
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    for (const f of readdirSync(join(root, sub.name))) {
      scanFile(`${sub.name}/${f}`, join(root, sub.name, f));
    }
  }
  return violations;
}

// Ejecutado directamente (no importado por un test)
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = [...digestViolations(), ...placeholderViolations()];
  if (v.length) {
    console.error("✗ digests de runtime no conformes:");
    for (const x of v) console.error("   " + x);
    process.exit(1);
  }
  console.log("✓ runtimes fijados por digest (sin placeholders)");
}
