import { describe, it, expect } from "vitest";
import { SandboxProcessRunner } from "../src/sandbox-process.js";

describe("T6.2 · deadline de ejecución (bucle infinito no cuelga al motor)", () => {
  const runner = new SandboxProcessRunner();

  it("un bot en bucle infinito se mata al vencer el deadline", async () => {
    const res = await runner.runWithDeadline("while(true){}", 500);
    expect(res.timedOut).toBe(true);
    expect(res.killed).toBe(true);
    // el proceso se contuvo cerca del deadline, sin colgar el harness
    expect(res.durationMs).toBeLessThan(3000);
  }, 10000);

  it("un bot que termina rápido NO se mata", async () => {
    const res = await runner.runWithDeadline("console.log('hola'); process.exit(0)", 2000);
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hola");
  }, 10000);

  it("no hereda secretos del entorno del padre", async () => {
    process.env.__SECRETO_TEST__ = "top-secret";
    try {
      const res = await runner.runWithDeadline("console.log(process.env.__SECRETO_TEST__ ?? 'undefined')", 2000);
      expect(res.stdout.trim()).toBe("undefined");
    } finally {
      delete process.env.__SECRETO_TEST__;
    }
  }, 10000);
});
