#!/usr/bin/env -S npx tsx
/**
 * E6 · CLI de escaneo de seguridad del Compose (T6.2, criterio cap. 28).
 *
 * Uso (en CI):  npx tsx scripts/scan-compose.ts [ruta1.yml ...]
 * Sin argumentos, escanea docker-compose.demo.yml de la raíz (prototipo v1; el
 * stack oficial infrastructure/docker-compose.yml lo escanea scan-compose.mjs en
 * la etapa 6 de la CI). Sale con código 1 (falla el CI)
 * si algún servicio monta docker.sock, corre privilegiado, añade cap ALL, usa seccomp/
 * apparmor unconfined, o comparte red/PID del host.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCompose } from "../apps/bot-manager/src/compose-scanner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2);
if (files.length === 0) files.push(join(__dirname, "..", "docker-compose.demo.yml"));

let failed = false;
for (const file of files) {
  let yaml: string;
  try {
    yaml = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`✗ no se pudo leer ${file}: ${(e as Error).message}`);
    failed = true;
    continue;
  }
  const violations = scanCompose(yaml);
  if (violations.length === 0) {
    console.log(`✓ ${file}: sin infracciones de seguridad`);
  } else {
    failed = true;
    console.error(`✗ ${file}: ${violations.length} infracción(es):`);
    for (const v of violations) console.error(`   L${v.line} [${v.rule}] ${v.text}`);
  }
}

process.exit(failed ? 1 : 0);
