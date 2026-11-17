/** OLA 2 · ME · autotest del helper `contractIt` (política «rojo por aserción»). */
import { AssertionError, strictEqual } from "node:assert";
import { describe, expect, it } from "vitest";
import { FixtureError, enforced, isAssertionError } from "./contract-it.js";

describe("contractIt · clasificación de fallos", () => {
  it("una aserción de vitest/chai y una de node:assert son aserciones", () => {
    let chai: unknown;
    try {
      expect(1).toBe(2);
    } catch (e) {
      chai = e;
    }
    expect(isAssertionError(chai)).toBe(true);
    expect(isAssertionError(new AssertionError({ message: "x" }))).toBe(true);
    try {
      strictEqual(1, 2);
    } catch (e) {
      expect(isAssertionError(e)).toBe(true);
    }
  });

  it("TypeError, ReferenceError, FixtureError, cadenas y undefined NO son aserciones", () => {
    let te: unknown;
    try {
      (undefined as any).x;
    } catch (e) {
      te = e;
    }
    expect(isAssertionError(te)).toBe(false);
    expect(isAssertionError(new ReferenceError("y"))).toBe(false);
    expect(isAssertionError(new FixtureError("z"))).toBe(false);
    expect(isAssertionError("AssertionError")).toBe(false);
    expect(isAssertionError(undefined)).toBe(false);
  });

  it("sin S9_CONTRACT_ENFORCE ningún equipo está activado", () => {
    if (!process.env.S9_CONTRACT_ENFORCE) expect(enforced("MA")).toBe(false);
  });
});
