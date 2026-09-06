/**
 * R17 · Calibración de la sonda de overrides de versión (#143).
 *
 * Lo que hay que probar no es que "funcione": es que DISTINGA las tres cosas
 * que se confunden — hay override, no hay, y no se ha mirado — y que un fallo
 * de la tubería no se traduzca nunca en «no hay overrides».
 */
import { describe, expect, it } from "vitest";
import { interpretarSalidaGate, versionOverridesProbe } from "./probes-overrides.ts";

describe("interpretación de la salida del gate", () => {
  it("un override con efecto se traduce a `active`", () => {
    const r = interpretarSalidaGate({
      global_tag: "4d469dc",
      overrides: { "tournament-worker": { tag: "82c74a8" } },
      fallos: [],
    });
    expect(r.globalTag).toBe("4d469dc");
    expect(r.active).toEqual([{ service: "tournament-worker", tag: "82c74a8" }]);
    expect(r.undeclared).toEqual([]);
  });

  it("sin overrides, `active` está vacío (y eso SÍ afirma algo)", () => {
    const r = interpretarSalidaGate({ global_tag: "4d469dc", overrides: {}, fallos: [] });
    expect(r.active).toEqual([]);
  });

  it("los NO declarados salen del código del gate, no de una segunda opinión", () => {
    const r = interpretarSalidaGate({
      global_tag: "4d469dc",
      overrides: { web: { tag: "colada" } },
      fallos: [{ codigo: "OVERRIDE_NO_DECLARADO", detalle: "web: el entorno lo desplaza a ..." }],
    });
    expect(r.undeclared).toEqual(["web"]);
  });

  it("otros códigos de fallo NO se cuentan como overrides sin declarar", () => {
    const r = interpretarSalidaGate({
      overrides: {},
      fallos: [{ codigo: "IMAGEN_OBJETIVO_DISTINTA", detalle: "web: ..." }],
    });
    expect(r.undeclared).toEqual([]);
  });
});

describe("la sonda", () => {
  it("sin raíz de repositorio NO se ejerce, y lo dice", async () => {
    const r = await versionOverridesProbe("")();
    expect(r.probed).toBe(false);
    expect(r.active).toEqual([]);
    expect(r.reason).toContain("no haber mirado");
  });

  it("con salida válida, observa", async () => {
    const salida = JSON.stringify({ global_tag: "4d469dc", overrides: { api: { tag: "x" } }, fallos: [] });
    const r = await versionOverridesProbe("/repo", async () => ({ stdout: salida }))();
    expect(r.probed).toBe(true);
    expect(r.active).toEqual([{ service: "api", tag: "x" }]);
  });

  it("rc!=0 CON json sigue siendo una observación (el gate rojo observa igual)", async () => {
    const err = Object.assign(new Error("rc=1"), {
      stdout: JSON.stringify({
        global_tag: "4d469dc",
        overrides: { web: { tag: "colada" } },
        fallos: [{ codigo: "OVERRIDE_NO_DECLARADO", detalle: "web: ..." }],
      }),
    });
    const r = await versionOverridesProbe("/repo", async () => {
      throw err;
    })();
    expect(r.probed).toBe(true);
    expect(r.undeclared).toEqual(["web"]);
  });

  it("un fallo SIN json NO se traduce en «no hay overrides»", async () => {
    const r = await versionOverridesProbe("/repo", async () => {
      throw new Error("ENOENT");
    })();
    expect(r.probed).toBe(false);
    expect(r.active).toEqual([]);
    expect(r.reason).toContain("ENOENT");
  });
});
