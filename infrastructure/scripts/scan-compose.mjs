#!/usr/bin/env node
/**
 * Escaneo de seguridad del Compose (dosier cap. 28; DoD de T10.2; R1.7).
 * Falla (exit 1) si algún servicio:
 *   - corre privilegiado (privileged: true),
 *   - monta el socket de Docker (docker.sock) — SIN EXCEPCIONES (R1.7,
 *     ERR-SEC-02): la antigua allowlist de bot-manager se ha retirado; el
 *     bot-manager habla con el proxy de la API de Docker del host
 *     (apps/bot-manager/src/docker-proxy.ts), nunca con el socket.
 *   - publica puertos al exterior sin ser el gateway.
 *
 * Única fuente de verdad: complianceViolations
 * (apps/bot-manager/src/compliance.mjs, la misma función que usa el
 * container-runner y el proxy). Este escáner solo traduce cada servicio del
 * YAML a una postura y le pregunta; no mantiene reglas propias que puedan
 * contradecirla.
 *
 * Uso: node infrastructure/scripts/scan-compose.mjs <compose.yml> [...]
 * Lo ejecuta la etapa 6 de la CI (.github/workflows/ci.yml), la aceptación
 * (acceptance/criteria.mjs) y los tests de infrastructure/tests/scan-compose.test.ts.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { complianceViolations, compliantBasePosture } from "../../apps/bot-manager/src/compliance.mjs";

const PORT_ALLOW = new Set(["gateway"]);

function mountsDockerSock(def) {
  const volumes = Array.isArray(def.volumes) ? def.volumes : [];
  return volumes.some((v) => {
    const src = typeof v === "string" ? v : (v?.source ?? "");
    return String(src).includes("docker.sock");
  });
}

export function scanCompose(source, name = "compose") {
  const doc = parse(source, { merge: true });
  const findings = [];
  const services = doc?.services ?? {};

  for (const [svc, def] of Object.entries(services)) {
    if (!def || typeof def !== "object") continue;

    // Postura conforme de base + SOLO lo que el Compose permite observar:
    // así complianceViolations (única fuente de verdad) devuelve exactamente
    // las infracciones observadas, sin allowlist posible por servicio.
    const posture = {
      ...compliantBasePosture(),
      privileged: def.privileged === true,
      mountsDockerSock: mountsDockerSock(def),
    };
    for (const violation of complianceViolations(posture)) {
      findings.push(
        `${name}: el servicio "${svc}" infringe el cap. 28 — ${violation} (sin excepciones; fuente: complianceViolations)`,
      );
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
      console.log(`OK · ${f}: sin privilegiados, sin docker.sock (en ningún servicio), puertos solo en gateway`);
  }
  process.exit(bad ? 1 : 0);
}
