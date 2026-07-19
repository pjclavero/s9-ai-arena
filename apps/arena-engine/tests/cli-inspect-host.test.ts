/**
 * R13.2 · REGRESSION LOCK — opt-in explícito para exponer el inspector en un
 * host no-loopback.
 *
 * El inspector (`inspector.ts`) no tiene CORS ni autenticación a propósito:
 * eso solo es defendible mientras se quede en loopback. Este candado exige
 * `--inspect-allow-remote` para cualquier `--inspect-host` que no sea
 * 127.0.0.1/localhost/::1, y comprueba que el default sigue siendo loopback.
 *
 * Prueba la función de validación exportada directamente (sin levantar
 * batalla ni servidor): `cli.ts` solo ejecuta `main()` cuando se invoca como
 * script (guarda de entrypoint añadida en R13.2), así que importarlo aquí no
 * dispara `process.exit`.
 */
import { describe, expect, it } from "vitest";
import { validateInspectHost } from "../src/cli.js";

describe("R13.2 · REGRESSION LOCK — validateInspectHost", () => {
  it.each(["127.0.0.1", "localhost", "::1"])("host loopback %s no exige el flag", (host) => {
    expect(() => validateInspectHost(host, false)).not.toThrow();
  });

  it("host no-loopback SIN --inspect-allow-remote lanza error claro", () => {
    expect(() => validateInspectHost("0.0.0.0", false)).toThrow(/inspect-allow-remote/);
    expect(() => validateInspectHost("192.168.1.50", false)).toThrow(/inspect-allow-remote/);
  });

  it("host no-loopback CON --inspect-allow-remote no lanza", () => {
    expect(() => validateInspectHost("0.0.0.0", true)).not.toThrow();
    expect(() => validateInspectHost("192.168.1.50", true)).not.toThrow();
  });
});
