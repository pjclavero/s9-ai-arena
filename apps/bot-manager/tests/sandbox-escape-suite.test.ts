import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const suiteDir = join(__dirname, "..", "..", "..", "tests", "sandbox-escape");

describe("T6.2 · la suite de escape está completa y es consistente", () => {
  const manifest = JSON.parse(readFileSync(join(suiteDir, "manifest.json"), "utf8"));
  const botFiles = readdirSync(join(suiteDir, "bots")).filter((f) => f.endsWith(".py"));

  it("cubre los 7+ vectores de la DoD", () => {
    expect(manifest.bots.length).toBeGreaterThanOrEqual(7);
    expect(botFiles.length).toBeGreaterThanOrEqual(7);
  });

  it("cada bot del manifiesto existe como fichero", () => {
    for (const bot of manifest.bots) {
      expect(botFiles).toContain(`${bot.id}.py`);
    }
  });

  it("cubre los vectores exigidos: internet, escritura, fork, memoria, red, /proc, docker.sock", () => {
    const attacks = manifest.bots.map((b: any) => b.id).join(" ");
    for (const key of ["internet", "write_outside_tmp", "fork_bomb", "memory", "network_scan", "read_proc", "docker_sock"]) {
      expect(attacks).toContain(key);
    }
  });

  it("cada bot declara un marcador de escape que el harness vigila", () => {
    for (const bot of manifest.bots) {
      expect(bot.escapeMarker).toBeTruthy();
      const src = readFileSync(join(suiteDir, "bots", `${bot.id}.py`), "utf8");
      expect(src).toContain(bot.escapeMarker);
    }
  });
});
