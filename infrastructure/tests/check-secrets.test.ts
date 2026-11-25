/**
 * V1 ADM-SETUP · REV352-01 · Preflight de ficheros de secreto (infrastructure/scripts/check-secrets.mjs).
 * Mutante: `M-SETUP-check-secrets-ignora-faltantes` (scripts/v1-web-setup-mutants.mjs).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkSecrets, secretFiles } from "../scripts/check-secrets.mjs";

const REPO = resolve(__dirname, "../..");
const SCRIPT = join(REPO, "infrastructure/scripts/check-secrets.mjs");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-secrets-"));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(
    join(dir, "compose.yml"),
    [
      "services: {}",
      "secrets:",
      "  jwt_secret: { file: ./secrets/jwt_secret.txt }",
      "  setup_token: { file: ./secrets/setup_token.txt }",
      "  externo: { external: true }",
      "",
    ].join("\n"),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("check-secrets", () => {
  it("el compose real declara setup_token como fichero", () => {
    const names = secretFiles(join(REPO, "infrastructure/docker-compose.yml")).map((s) => s.name);
    expect(names).toContain("setup_token");
  });

  it("[INFRA-check-secrets-falta] detecta el setup_token.txt ausente (rc 1) y lo nombra; con todos presentes rc 0", () => {
    writeFileSync(join(dir, "secrets/jwt_secret.txt"), "x");
    const r1 = checkSecrets(join(dir, "compose.yml"));
    expect(r1.ok).toBe(false);
    expect(r1.missing.map((m) => m.name)).toEqual(["setup_token"]);
    const cli1 = spawnSync(process.execPath, [SCRIPT, "--compose", join(dir, "compose.yml")], { encoding: "utf8" });
    expect(cli1.status).toBe(1);
    expect(cli1.stderr).toContain("setup_token");
    expect(cli1.stderr).toContain("init-secrets.sh");

    writeFileSync(join(dir, "secrets/setup_token.txt"), ""); // vacío vale (asistente cerrado a propósito)
    expect(checkSecrets(join(dir, "compose.yml")).ok).toBe(true);
    const cli2 = spawnSync(process.execPath, [SCRIPT, "--compose", join(dir, "compose.yml")], { encoding: "utf8" });
    expect(cli2.status).toBe(0);
  });

  it("[INFRA-check-secrets-sin-yaml] sin el módulo yaml (sin npm ci) es NO COMPROBADO (rc 2), nunca rc 1", () => {
    // Copia del script en un directorio sin node_modules por encima: `import("yaml")` no resuelve.
    const lone = mkdtempSync(join(tmpdir(), "check-secrets-solo-"));
    try {
      const copy = join(lone, "check-secrets.mjs");
      writeFileSync(copy, readFileSync(SCRIPT));
      const probe = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('yaml')"], {
        cwd: lone,
        encoding: "utf8",
      });
      expect(probe.status, "control: desde ese directorio yaml NO debe resolverse").not.toBe(0);
      const r = spawnSync(process.execPath, [copy, "--compose", join(dir, "compose.yml")], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("NO COMPROBADO");
      expect(r.stderr).toContain("yaml");
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });

  it("un enlace simbólico no cuenta como presente; un compose ilegible es NO COMPROBADO (rc 2)", () => {
    writeFileSync(join(dir, "secrets/jwt_secret.txt"), "x");
    writeFileSync(join(dir, "otro"), "x");
    symlinkSync(join(dir, "otro"), join(dir, "secrets/setup_token.txt"));
    expect(checkSecrets(join(dir, "compose.yml")).missing[0]?.why).toContain("enlace");
    const cli = spawnSync(process.execPath, [SCRIPT, "--compose", join(dir, "no-existe.yml")], { encoding: "utf8" });
    expect(cli.status).toBe(2);
  });
});
