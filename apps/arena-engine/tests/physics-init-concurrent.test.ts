/**
 * R-RULES · FASE 19 (hallazgo) · `initPhysics()` CONCURRENTE.
 *
 * En la batalla real local el tournament-worker arrancó 4 batallas a la vez nada más
 * levantarse: cada `Battle.create` llamaba a `initPhysics()`, y como `initialized` sólo
 * se marcaba DESPUÉS del `await RAPIER.init()`, el WASM se inicializaba dos veces (el
 * log mostraba dos avisos de inicialización). La segunda instancia sustituye al módulo
 * bajo los mundos ya creados y el siguiente `setLinvel` revienta con «recursive use of
 * an object detected which would lead to unsafe aliasing in rust», que mataba el
 * PROCESO del worker y dejaba todas las batallas en `running` para siempre.
 *
 * Regla: llamadas concurrentes comparten UNA inicialización.
 */
import { describe, expect, it, vi } from "vitest";
import { initPhysics, PhysicsWorld } from "../src/sim/physics.js";

describe("initPhysics concurrente", () => {
  it("dos llamadas simultáneas inicializan Rapier UNA sola vez y el mundo funciona", async () => {
    // Cada RAPIER.init() imprime el aviso «using deprecated parameters for the
    // initialization function»: es la huella observable de una inicialización (la misma
    // que delataba el doble arranque en el log del worker). El export ESM no es espiable.
    const seen: string[] = [];
    const capture = (...a: unknown[]) => void seen.push(a.map(String).join(" "));
    const warn = vi.spyOn(console, "warn").mockImplementation(capture);
    const log = vi.spyOn(console, "log").mockImplementation(capture);
    try {
      await Promise.all([initPhysics(), initPhysics(), initPhysics()]);
      await initPhysics();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    const inits = seen.filter((m) => m.includes("deprecated parameters for the initialization function"));
    expect(inits).toHaveLength(1);
    const w = new PhysicsWorld();
    w.addVehicle("v", { x: 5, y: 5 }, 0, 1, 1000);
    w.driveVehicle("v", 1, 0, { maxSpeedMs: 5, accelerationMs2: 5, turnRateRads: 1 });
    w.step();
    expect(w.pose("v")!.position.x).toBeGreaterThan(5);
    w.free();
  });
});
