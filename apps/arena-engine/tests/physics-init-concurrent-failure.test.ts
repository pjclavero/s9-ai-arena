/**
 * EQ1 · Robustez · camino de ERROR de la inicialización compartida de `initPhysics()`.
 *
 * Con el fix, las llamadas concurrentes comparten una promesa. Si esa inicialización
 * falla, todas las que esperaban reciben el error, pero la promesa NO puede quedarse
 * envenenada: el siguiente intento debe volver a inicializar y funcionar.
 *
 * Aquí `RAPIER.init` se envuelve (vi.mock) para contar las llamadas de verdad y hacer
 * fallar la primera; el resto del módulo es el real.
 */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ n: 0, failNext: true }));

vi.mock("@dimforge/rapier2d-compat", async (importOriginal) => {
  const real: any = await importOriginal();
  const RAPIER = real.default;
  // Copia del namespace (sus propiedades son de sólo lectura): mismas clases reales.
  const wrapped = { ...RAPIER };
  wrapped.init = async (...args: unknown[]) => {
    calls.n++;
    await new Promise((r) => setTimeout(r, 5)); // ventana para que se solapen
    if (calls.failNext) {
      calls.failNext = false;
      throw new Error("fallo simulado de RAPIER.init");
    }
    return RAPIER.init(...args);
  };
  return { ...real, default: wrapped };
});

const { initPhysics, PhysicsWorld } = await import("../src/sim/physics.js");

describe("initPhysics concurrente · fallo de inicialización", () => {
  it("un fallo llega a todos los que esperaban, no envenena la promesa y el reintento inicializa UNA vez", async () => {
    const first = await Promise.allSettled([initPhysics(), initPhysics(), initPhysics()]);
    expect(first.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls.n).toBe(1); // una sola inicialización compartida, aunque falle

    await Promise.all([initPhysics(), initPhysics(), initPhysics()]);
    expect(calls.n).toBe(2); // el reintento inicializa de nuevo, una sola vez

    await initPhysics();
    expect(calls.n).toBe(2); // ya inicializado: no se vuelve a llamar

    const w = new PhysicsWorld();
    w.addVehicle("v", { x: 5, y: 5 }, 0, 1, 1000);
    w.driveVehicle("v", 1, 0, { maxSpeedMs: 5, accelerationMs2: 5, turnRateRads: 1 });
    w.step();
    expect(w.pose("v")!.position.x).toBeGreaterThan(5);
    w.free();
  });
});
