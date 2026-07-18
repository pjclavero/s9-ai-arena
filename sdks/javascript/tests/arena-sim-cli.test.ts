/**
 * R2.8 · E2E del CLI `arena-sim` de JS: el bot TypeScript de ejemplo
 * (example-bots/javascript/gunner.ts) completa una batalla REAL en el simulador
 * local invocado por CLI, sin Docker — cruzando de verdad el límite de proceso
 * (spawn de tsx), que es como lo usará un usuario, no llamando a la función.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const TSX = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = resolve(REPO_ROOT, "sdks", "javascript", "src", "arena-sim.ts");
const GUNNER = resolve(REPO_ROOT, "example-bots", "javascript", "gunner.ts");

function runCli(args: string[]) {
  return spawnSync(TSX, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 90_000 });
}

describe("R2.8 · CLI arena-sim (JS)", () => {
  it("el gunner de ejemplo completa una batalla contra un stub idle, por CLI y sin Docker", () => {
    expect(existsSync(TSX)).toBe(true);
    const proc = runCli([
      GUNNER,
      "--archetype", "gunner",
      "--opponent", "idle",
      "--ticks", "900",
      "--seed", "r28-e2e",
      // Acelerado como en el resto de la suite; sin este flag el CLI corre en
      // tiempo real (~33 ms/tick), igual que el arena-sim de Python.
      "--tick-interval-ms", "3",
    ]);

    expect(proc.error).toBeUndefined();
    expect(proc.status, proc.stderr).toBe(0);

    const result = JSON.parse(proc.stdout);
    // La batalla terminó de verdad, con el motor y el protocolo reales.
    expect(result.versions.protocol).toBe("arena/1");
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThanOrEqual(900);
    // El bot externo (veh_1) participó: un bot que no conecta o no responde a
    // tiempo acaba descalificado por el ProtocolServer.
    expect(result.disqualified).not.toContain("veh_1");
    // Contra un stub inmóvil que no dispara, el gunner solo puede ganar o
    // (si no lo encuentra a tiempo) empatar; "blue" delataría un bot roto.
    expect(["red", "draw"]).toContain(result.winner);
  });

  it("falla con exit 1 y un mensaje claro si el módulo no exporta ninguna subclase de ArenaBot", () => {
    // src/types.ts es un módulo válido pero sin bots dentro.
    const proc = runCli([resolve(REPO_ROOT, "sdks", "javascript", "src", "types.ts")]);
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("no exporta ninguna subclase de ArenaBot");
  });

  it("sin argumentos imprime el uso y sale con 1", () => {
    const proc = runCli([]);
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("Uso: arena-sim");
  });
});
