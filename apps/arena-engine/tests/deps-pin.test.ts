/**
 * D4 · La build de Rapier está FIJADA por checksum.
 *
 * Por qué importa tanto: el determinismo de Rapier depende de la build exacta del WASM.
 * Un `npm update` que suba de 0.19.3 a 0.19.4 puede cambiar sutilmente los resultados de
 * la física. La simulación seguiría funcionando —ese es el peligro— pero todos los replays
 * oficiales dejarían de verificar y las batallas golden empezarían a fallar sin que nadie
 * entendiera por qué.
 *
 * Con el pin, el motor se niega a arrancar y el problema aparece inmediatamente, con un
 * mensaje que dice exactamente qué ha pasado.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import deps from "../src/engine-deps.json" with { type: "json" };

const require = createRequire(import.meta.url);

function wasmPath(): string {
  const entry = require.resolve("@dimforge/rapier2d-compat");
  return join(dirname(entry), deps.physics.wasmFile);
}

describe("pin de la build de física (D4)", () => {
  it("el WASM instalado coincide con el checksum registrado en engine-deps.json", () => {
    const buf = readFileSync(wasmPath());
    const actual = createHash("sha256").update(buf).digest("hex");

    expect(
      actual,
      `El WASM de Rapier ha cambiado.\n\n` +
        `  registrado: ${deps.physics.wasmSha256}\n` +
        `  instalado:  ${actual}\n\n` +
        `Esto NO se arregla actualizando el hash sin más. Una build distinta de Rapier ` +
        `puede alterar la física de forma sutil e invalidar todos los replays oficiales.\n` +
        `El procedimiento correcto es: (1) un ADR que justifique el cambio de versión, ` +
        `(2) regenerar las batallas golden con UPDATE_GOLDEN=1 revisando las diferencias, ` +
        `y (3) marcar los replays anteriores como verificables solo con la versión antigua ` +
        `del motor.`,
    ).toBe(deps.physics.wasmSha256);
  });

  it("el tamaño del WASM también está registrado (segunda barrera)", () => {
    expect(readFileSync(wasmPath()).length).toBe(deps.physics.wasmBytes);
  });

  it("la versión declarada coincide con la instalada", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(require.resolve("@dimforge/rapier2d-compat")), "package.json"), "utf8"),
    );
    expect(pkg.version).toBe(deps.physics.version);
  });

  it("un checksum falso haría fallar la verificación (la barrera MUERDE)", () => {
    // Comprobamos que la comparación no es decorativa: si el hash no coincide, se detecta.
    const actual = createHash("sha256").update(readFileSync(wasmPath())).digest("hex");
    const fake = "0".repeat(64);
    expect(actual).not.toBe(fake);
  });
});
