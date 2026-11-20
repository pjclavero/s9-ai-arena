/**
 * UX-02 · el motivo de rechazo señala FICHERO y LÍNEA del código del usuario y
 * no enseña las rutas internas del sandbox.
 */
import { describe, it, expect } from "vitest";
import { describeUserError, locateUserError } from "../src/user-error.js";

const PY_TRACE = `Traceback (most recent call last):
  File "<string>", line 230, in main
  File "/opt/runtime/lib/arena_sdk/bot.py", line 66, in run
  File "/tmp/bot/src/helpers.py", line 3, in calcula
  File "/tmp/bot/src/bot.py", line 7, in on_observation
    return {"move": {"throttle": velocidad}}
NameError: name 'velocidad' is not defined`;

const JS_STACK = `TypeError: Cannot read properties of undefined (reading 'x')
    at Bot.onObservation (file:///tmp/bot/src/bot.js:5:30)
    at Bot._handleObservation (file:///node_modules/@arena/sdk/dist/index.js:110:24)`;

const JS_IMPORT_SYNTAX = `file:///tmp/bot/src/bot.js:3
  onObservation(o) {
               ^

SyntaxError: Unexpected token '{'`;

describe("UX-02 · ubicación del error en el código del usuario", () => {
  it("Python: último marco dentro del paquete y última línea del error", () => {
    expect(locateUserError(PY_TRACE)).toEqual({
      location: { file: "src/bot.py", line: 7 },
      summary: "NameError: name 'velocidad' is not defined",
    });
    expect(describeUserError(PY_TRACE)).toBe("src/bot.py, línea 7: NameError: name 'velocidad' is not defined");
  });

  it("Node: primer marco del paquete", () => {
    expect(describeUserError(JS_STACK)).toBe(
      "src/bot.js, línea 5: TypeError: Cannot read properties of undefined (reading 'x')",
    );
  });

  it("Node: SyntaxError al importar", () => {
    expect(describeUserError(JS_IMPORT_SYNTAX)).toBe("src/bot.js, línea 3: SyntaxError: Unexpected token '{'");
  });

  it("nunca filtra la ruta del sandbox", () => {
    for (const t of [PY_TRACE, JS_STACK, JS_IMPORT_SYNTAX, "Error: /tmp/bot/src/x.js no existe"]) {
      expect(describeUserError(t)).not.toMatch(/\/tmp\/bot/);
    }
  });

  it("sin ubicación: devuelve sólo el resumen", () => {
    expect(describeUserError("fallo al importar el bot")).toBe("fallo al importar el bot");
  });
});
