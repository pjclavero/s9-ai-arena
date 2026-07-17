// Tests del escaneo de seguridad del Compose (DoD T10.2, cap. 28; R1.7).
// El escáner falla si un servicio monta docker.sock o corre privilegiado —
// SIN EXCEPCIONES (R1.7/ERR-SEC-02: la antigua allowlist de bot-manager se
// retiró) — y si alguien que no es el gateway publica puertos. Se prueba
// contra fixtures buenos y malos y, sobre todo, contra el Compose REAL.
// Fuente de verdad de las reglas: complianceViolations (compliance.mjs).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error módulo .mjs sin tipos
import { scanCompose } from "../scripts/scan-compose.mjs";
import {
  complianceViolations,
  compliantBasePosture,
} from "../../apps/bot-manager/src/compliance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => readFileSync(join(here, "fixtures", f), "utf8");
const SCANNER = join(here, "..", "scripts", "scan-compose.mjs");
const REAL_COMPOSE = join(here, "..", "docker-compose.yml");

describe("scan-compose (cap. 28, R1.7)", () => {
  it("acepta un compose limpio (sin docker.sock en ningún servicio, puertos solo en gateway)", () => {
    expect(scanCompose(fixture("good.yml"))).toEqual([]);
  });

  it("rechaza privileged: true", () => {
    const findings = scanCompose(fixture("bad-privileged.yml"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/privilegiado/);
  });

  it("rechaza docker.sock en CUALQUIER servicio, bot-manager incluido (sin excepciones)", () => {
    const findings = scanCompose(fixture("bad-docker-sock.yml"));
    expect(findings).toHaveLength(3);
    for (const f of findings) expect(f).toMatch(/docker\.sock/);
    expect(findings.some((f: string) => f.includes('"bot-manager"'))).toBe(true);
  });

  it("un compose donde SOLO bot-manager monta docker.sock también falla (la excepción no existe)", () => {
    const yaml = [
      "services:",
      "  bot-manager:",
      "    image: node:22-alpine",
      "    volumes:",
      "      - /var/run/docker.sock:/var/run/docker.sock",
    ].join("\n");
    const findings = scanCompose(yaml);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/docker\.sock/);
  });

  it("rechaza puertos publicados por servicios que no son el gateway", () => {
    const findings = scanCompose(fixture("bad-ports.yml"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/"api" publica puertos/);
  });

  it("el Compose real del stack pasa el escaneo (ya sin docker.sock en bot-manager)", () => {
    expect(scanCompose(readFileSync(REAL_COMPOSE, "utf8"))).toEqual([]);
    expect(readFileSync(REAL_COMPOSE, "utf8")).not.toMatch(/- \/var\/run\/docker\.sock/);
  });

  it("está alineado con complianceViolations (única fuente de verdad, ERR-SEC-02)", () => {
    // Lo que complianceViolations marca como violación para docker.sock y
    // privileged es EXACTAMENTE lo que el escáner reporta: mismas cadenas.
    const sock = complianceViolations({ ...compliantBasePosture(), mountsDockerSock: true });
    const priv = complianceViolations({ ...compliantBasePosture(), privileged: true });
    expect(sock).toHaveLength(1);
    expect(priv).toHaveLength(1);
    const yaml = [
      "services:",
      "  a:",
      "    privileged: true",
      "  b:",
      "    volumes:",
      "      - /var/run/docker.sock:/var/run/docker.sock",
    ].join("\n");
    const findings: string[] = scanCompose(yaml);
    expect(findings.some((f) => f.includes(priv[0]))).toBe(true);
    expect(findings.some((f) => f.includes(sock[0]))).toBe(true);
  });

  it("como CLI: exit 0 con el compose real, exit 1 con un fixture malo", () => {
    // exit 0
    execFileSync(process.execPath, [SCANNER, REAL_COMPOSE]);
    // exit != 0
    expect(() =>
      execFileSync(process.execPath, [SCANNER, join(here, "fixtures", "bad-privileged.yml")]),
    ).toThrow();
    // exit != 0 también con docker.sock SOLO en bot-manager (sin excepciones)
    expect(() =>
      execFileSync(process.execPath, [SCANNER, join(here, "fixtures", "bad-docker-sock.yml")]),
    ).toThrow();
  });
});
