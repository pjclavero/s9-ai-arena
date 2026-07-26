/**
 * B3 — el tercer bot de la plantilla ("Artillero") cambió de un TypeScript
 * (example-bots/javascript/gunner.ts) que NUNCA podía validar (acorn no parsea
 * TS y static_analysis corre antes de build, sin transpilación posible) a un
 * Python real derivado de bots/s9-smoke-bot/main.py (deriveArtilleroSource).
 *
 * Estos tests son VERIFICACIÓN REAL contra el analizador de producción
 * (apps/bot-manager/src/static-analysis.ts `analyze`, el mismo que usa el
 * pipeline de 10 etapas) — no una aproximación ni un mock.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveArtilleroSource } from "./demo-teams.js";
import { analyze } from "../../../../bot-manager/src/static-analysis.js";
import { DEFAULT_CONFIG } from "../../../../bot-manager/src/config.js";
import type { SourceFile } from "../../../../bot-manager/src/types.js";

function wrapAsPythonPackage(content: string): SourceFile[] {
  return [
    { path: "manifest.json", content: JSON.stringify({ runtime: "python", entry: "src/bot.py" }, null, 2) },
    { path: "requirements.txt", content: "arena-sdk==1.0.0\n" },
    { path: "requirements.lock", content: "arena-sdk==1.0.0\n" },
    { path: "src/bot.py", content },
  ];
}

describe("B3 · deriveArtilleroSource", () => {
  const mainPy = readFileSync("bots/s9-smoke-bot/main.py");

  it("conserva la clase SmokeBot íntegra (mismo cuerpo, sin reescribirla)", () => {
    const derived = deriveArtilleroSource(mainPy).toString("utf8");
    expect(derived).toContain("class SmokeBot(ArenaBot):");
    expect(derived).toContain("def on_observation(self, observation):");
    // La estrategia real (perseguir-apuntar-disparar), sin inventar nada nuevo:
    expect(derived).toContain('"fire": ["turret_main"]');
  });

  it("elimina el lanzador de proceso (main(), import os, from __future__): eso es lo que rompía static_analysis", () => {
    const derived = deriveArtilleroSource(mainPy).toString("utf8");
    expect(derived).not.toMatch(/^import os/m);
    expect(derived).not.toMatch(/from __future__ import annotations/);
    expect(derived).not.toContain("def main(");
    expect(derived).not.toContain('if __name__ == "__main__"');
  });

  it("VERIFICACIÓN REAL: el fichero ORIGINAL bots/s9-smoke-bot/main.py, tal cual, NO pasa static_analysis hoy", () => {
    // Documenta el porqué de la derivación: si se usara el fichero íntegro
    // (con su wrapper de proceso), el pipeline lo rechazaría igual que a
    // gunner.ts, solo que por otro motivo (import de builtin peligroso 'os').
    // No relajamos esa política (B3 lo prohíbe) — por eso se deriva en vez de
    // usarse el fichero tal cual.
    const res = analyze("python", wrapAsPythonPackage(mainPy.toString("utf8")), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/os/);
  });

  it("VERIFICACIÓN REAL: el código DERIVADO sí pasa static_analysis (analyze() de producción)", () => {
    const derived = deriveArtilleroSource(mainPy).toString("utf8");
    const res = analyze("python", wrapAsPythonPackage(derived), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.imports).toContain("arena_sdk");
    expect(res.reasons).toEqual([]);
  });

  it("lanza un error claro si bots/s9-smoke-bot/main.py cambiara de forma (no falla en silencio)", () => {
    const otro = Buffer.from("print('no hay clase SmokeBot aquí')\n", "utf8");
    expect(() => deriveArtilleroSource(otro)).toThrow(/marcadores esperados/);
  });
});

describe("B3 (ampliado) · los TRES bots de la plantilla validan de verdad", () => {
  // Hallazgo original (ronda 1): `from __future__ import annotations` — la
  // primera línea de CÓDIGO de explorer.py y defender.py, los bots oficiales
  // del repo — no estaba en PYTHON_STDLIB y se rechazaba como import no
  // permitido. Verificado entonces con analyze() real: los tres bots de la
  // plantilla (incluido el Artillero derivado) fallaban o dependían de un
  // fix pendiente. Corregido en static-analysis.ts (PYTHON_STDLIB incluye
  // ahora `__future__` y `base64`, ambos módulos de la stdlib sin ninguna
  // capacidad de E/S/red/proceso — no es una relajación de la política
  // fail-closed ni de la lista de builtins peligrosos, que siguen intactas).
  it("VERIFICACIÓN REAL: explorer.py pasa static_analysis (antes fallaba por __future__ Y por base64)", () => {
    const explorer = readFileSync("example-bots/python/explorer.py", "utf8");
    const res = analyze("python", wrapAsPythonPackage(explorer), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
    expect(res.imports).toEqual(expect.arrayContaining(["__future__", "base64", "math", "arena_sdk"]));
  });

  it("VERIFICACIÓN REAL: defender.py pasa static_analysis (antes fallaba por __future__)", () => {
    const defender = readFileSync("example-bots/python/defender.py", "utf8");
    const res = analyze("python", wrapAsPythonPackage(defender), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("VERIFICACIÓN REAL: el Artillero derivado pasa static_analysis", () => {
    const mainPy = readFileSync("bots/s9-smoke-bot/main.py");
    const derived = deriveArtilleroSource(mainPy).toString("utf8");
    const res = analyze("python", wrapAsPythonPackage(derived), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });
});

describe("B3 (ampliado) · el fix de __future__/base64 es un falso positivo corregido, no un agujero", () => {
  it("un bot Python con from __future__ import annotations PASA el análisis", () => {
    const src = [
      "from __future__ import annotations",
      "",
      "from arena_sdk import ArenaBot",
      "",
      "class B(ArenaBot):",
      "    def on_observation(self, o):",
      "        return {}",
      "",
    ].join("\n");
    const res = analyze("python", wrapAsPythonPackage(src), DEFAULT_CONFIG);
    expect(res.ok).toBe(true);
    expect(res.disallowedImports).toEqual([]);
  });

  it("un import de terceros de verdad SIGUE rechazado (no se ha abierto la puerta a todo)", () => {
    const src = ["from __future__ import annotations", "", "import requests", "", "class B:", "    pass", ""].join(
      "\n",
    );
    const res = analyze("python", wrapAsPythonPackage(src), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.disallowedImports).toContain("requests");
    expect(res.reasons.join(" ")).toMatch(/requests/);
  });

  it("un import realmente peligroso (os) SIGUE bloqueado por política, sin relajarse", () => {
    const src = ["from __future__ import annotations", "", "import os", "", "class B:", "    pass", ""].join("\n");
    const res = analyze("python", wrapAsPythonPackage(src), DEFAULT_CONFIG);
    expect(res.ok).toBe(false);
    expect(res.dangerousImports).toContain("os");
    expect(res.reasons.join(" ")).toMatch(/os/);
  });
});
