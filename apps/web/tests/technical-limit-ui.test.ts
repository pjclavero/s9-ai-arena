/**
 * EQ2 · ADR-022 · El final por SALVAGUARDA TÉCNICA de la prórroga se enseña como
 * «Detenida por límite técnico», nunca como «Empate», en el resumen de batalla y en el
 * visor (overlay). Control: un empate deportivo sigue diciendo «empate».
 */
import { describe, expect, it } from "vitest";
import { summarizeBattle } from "../src/battle-result.js";
import { OverlayState } from "../src/viewer/overlay.js";

const finished = (result: Record<string, unknown>, outcome?: string) => ({
  id: "b1",
  status: "finished",
  result: { schema: "battle-result/v1", ticks: 37_800, score: { red: 0, blue: 0 }, disqualified: [], ...result },
  participants: [
    { botId: "r", version: 1, team: "red", ...(outcome ? { outcome } : {}) },
    { botId: "b", version: 1, team: "blue", ...(outcome ? { outcome } : {}) },
  ],
});

describe("final técnico ≠ empate en la UI", () => {
  it("resumen: «Detenida por límite técnico (sin resultado deportivo)»", () => {
    const v = summarizeBattle(finished({ winner: null, endReason: "technical_limit" }));
    expect(v.outcome).toBe("Detenida por límite técnico (sin resultado deportivo)");
    expect(v.outcome).not.toMatch(/empate/i);
    expect(v.endReason).toContain("límite técnico");
  });
  it("control: un empate deportivo sigue siendo «empate»", () => {
    expect(summarizeBattle(finished({ winner: "draw", endReason: "completed" }, "draw")).outcome).toBe("empate");
  });
  it("visor: el resultado técnico del canal se anuncia como detenida, no como empate", () => {
    const o = new OverlayState();
    o.applyResult({ winner: null, endReason: "technical_limit", score: { red: 0, blue: 0 }, ticks: 37_800 });
    expect(o.result?.reason).toBe("technical_limit");
    const last = o.feed.at(-1)!.text;
    expect(last).toContain("detenida por límite técnico");
    expect(last).not.toMatch(/empate/);
    const d = new OverlayState();
    d.applyResult({ winner: null, score: {} });
    expect(d.feed.at(-1)!.text).toContain("empate");
  });
});
