/**
 * ADM-1 · Lector de `system_settings` (puro, con una BD simulada): guarda de reentrada y log del
 * fallo de lectura. Cada caso lleva su mutante en scripts/adm1-mutants.py.
 */
import { describe, expect, it, vi } from "vitest";
import { createSettingsRegistry } from "./registry.js";
import { SystemSettingsReader } from "./reader.js";

const REGISTRY = createSettingsRegistry([
  { key: "test.n", type: "integer", min: 1, max: 9, default: 2, consumer: "worker", apply: "hot", description: "n" },
]);

/** BD simulada: `db(tabla).select(...)` delega en `impl`. */
function fakeDb(impl: () => Promise<{ key: string; value: unknown }[]>) {
  return (() => ({ select: () => impl() })) as never;
}

describe("lector de ajustes", () => {
  it("REENTRADA: con una lectura en curso, otro refresh no lanza una segunda consulta", async () => {
    let calls = 0;
    const rd = new SystemSettingsReader(
      fakeDb(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return [{ key: "test.n", value: 5 }];
      }),
      REGISTRY,
      { refreshMs: 5_000, env: {} },
    );
    await Promise.all([rd.refresh(), rd.refresh(), rd.refresh()]);
    expect(calls).toBe(1);
    expect(rd.get("test.n")).toBe(5);
    await rd.refresh(); // terminada la anterior, vuelve a poder leer
    expect(calls).toBe(2);
  });

  it("LOG_DE_FALLO: el fallo de lectura se registra una vez por racha (no cada sondeo) y la racha se reinicia al recuperarse", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let mode: "fail" | "ok" = "fail";
      const rd = new SystemSettingsReader(
        fakeDb(async () => {
          if (mode === "fail") throw new Error("db caida");
          return [];
        }),
        REGISTRY,
        { refreshMs: 5_000, env: {} },
      );
      await rd.refresh();
      await rd.refresh();
      await rd.refresh();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toMatch(/lectura fallida/);
      expect(rd.entry("test.n").source).toBe("fail_closed");
      mode = "ok";
      await rd.refresh();
      expect(rd.entry("test.n").source).toBe("default");
      mode = "fail";
      await rd.refresh();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
