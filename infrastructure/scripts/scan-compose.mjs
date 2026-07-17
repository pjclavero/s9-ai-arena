#!/usr/bin/env node
/**
 * Escaneo de seguridad del Compose (dosier cap. 28; DoD de T10.2).
 * Falla (exit 1) si algún servicio:
 *   - corre privilegiado (privileged: true),
 *   - monta el socket de Docker (docker.sock),
 *   - publica puertos al exterior sin ser el gateway,
 * salvo las excepciones documentadas de ALLOW (bot-manager y docker.sock,
 * por su API restringida de build/lanzamiento de bots; ver el comentario del
 * servicio en infrastructure/docker-compose.yml).
 *
 * Uso: node infrastructure/scripts/scan-compose.mjs <compose.yml> [...]
 * Lo ejecuta la etapa 6 de la CI (.github/workflows/ci.yml) y los tests de
 * infrastructure/tests/scan-compose.test.ts.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Excepciones documentadas: servicio → capacidades permitidas.
const ALLOW = {
  "bot-manager": { dockerSock: true },
};
const PORT_ALLOW = new Set(["gateway"]);

export function scanCompose(source, name = "compose") {
  const doc = parse(source, { merge: true });
  const findings = [];
  const services = doc?.services ?? {};

  for (const [svc, def] of Object.entries(services)) {
    if (!def || typeof def !== "object") continue;

    if (def.privileged === true) {
      findings.push(`${name}: el servicio "${svc}" corre privilegiado (privileged: true), prohibido por el cap. 28`);
    }

    const volumes = Array.isArray(def.volumes) ? def.volumes : [];
    for (const v of volumes) {
      const src = typeof v === "string" ? v : (v?.source ?? "");
      if (String(src).includes("docker.sock")) {
        if (!ALLOW[svc]?.dockerSock) {
          findings.push(
            `${name}: el servicio "${svc}" monta docker.sock sin ser una excepción documentada (solo bot-manager)`,
          );
        }
      }
    }

    const ports = Array.isArray(def.ports) ? def.ports : [];
    if (ports.length > 0 && !PORT_ALLOW.has(svc)) {
      findings.push(`${name}: el servicio "${svc}" publica puertos al exterior; solo el gateway puede (dosier 6.4)`);
    }
  }

  return findings;
}

// CLI
const files = process.argv.slice(2);
if (files.length > 0) {
  let bad = false;
  for (const f of files) {
    const findings = scanCompose(readFileSync(f, "utf8"), f);
    for (const msg of findings) {
      console.error("FALLO ·", msg);
      bad = true;
    }
    if (findings.length === 0)
      console.log(`OK · ${f}: sin privilegiados, sin docker.sock no autorizado, puertos solo en gateway`);
  }
  process.exit(bad ? 1 : 0);
}
