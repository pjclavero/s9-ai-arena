// Tests del escaneo de seguridad del Compose (DoD T10.2, cap. 28).
// El escáner falla si un servicio monta docker.sock o corre privilegiado,
// salvo bot-manager (excepción documentada), y si alguien que no es el
// gateway publica puertos. Se prueba contra fixtures buenos y malos y,
// sobre todo, contra el Compose REAL del stack.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error módulo .mjs sin tipos
import { scanCompose } from "../scripts/scan-compose.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (f: string) => readFileSync(join(here, "fixtures", f), "utf8");
const SCANNER = join(here, "..", "scripts", "scan-compose.mjs");
const REAL_COMPOSE = join(here, "..", "docker-compose.yml");

describe("scan-compose (cap. 28)", () => {
  it("acepta un compose limpio (docker.sock solo en bot-manager, puertos solo en gateway)", () => {
    expect(scanCompose(fixture("good.yml"))).toEqual([]);
  });

  it("rechaza privileged: true", () => {
    const findings = scanCompose(fixture("bad-privileged.yml"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/privilegiado/);
  });

  it("rechaza docker.sock en servicios que no son bot-manager (forma corta y larga)", () => {
    const findings = scanCompose(fixture("bad-docker-sock.yml"));
    expect(findings).toHaveLength(2);
    for (const f of findings) expect(f).toMatch(/docker\.sock/);
  });

  it("rechaza puertos publicados por servicios que no son el gateway", () => {
    const findings = scanCompose(fixture("bad-ports.yml"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/"api" publica puertos/);
  });

  it("el Compose real del stack pasa el escaneo", () => {
    expect(scanCompose(readFileSync(REAL_COMPOSE, "utf8"))).toEqual([]);
  });

  it("como CLI: exit 0 con el compose real, exit 1 con un fixture malo", () => {
    // exit 0
    execFileSync(process.execPath, [SCANNER, REAL_COMPOSE]);
    // exit != 0
    expect(() =>
      execFileSync(process.execPath, [SCANNER, join(here, "fixtures", "bad-privileged.yml")]),
    ).toThrow();
  });
});
