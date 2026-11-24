/**
 * V1 REPLAYS PR-5 (D-3) · el final por TOPE DE GRABACIÓN (`recording_limit`: replay truncado, sin resultado
 * deportivo) se enseña como «Detenida por límite de grabación», nunca como «Empate» ni «sin ganador».
 * Control: un empate deportivo sigue diciendo «empate». Mutante: replay-pr5-mutants.mjs (M-WEB-*).
 */
import { describe, expect, it } from "vitest";
import { summarizeBattle } from "../src/battle-result.js";

const finished = (result: Record<string, unknown>, outcome?: string) => ({
  id: "b1",
  status: "finished",
  result: { schema: "battle-result/v1", ticks: 3_000, score: { red: 1, blue: 0 }, disqualified: [], ...result },
  participants: [
    { botId: "r", version: 1, team: "red", ...(outcome ? { outcome } : {}) },
    { botId: "b", version: 1, team: "blue", ...(outcome ? { outcome } : {}) },
  ],
});

describe("recording_limit en la UI", () => {
  it("RL1 resumen: «Detenida por límite de grabación», sin ganador ni empate", () => {
    const v = summarizeBattle(finished({ winner: null, endReason: "recording_limit" }));
    expect(v.outcome).toBe("Detenida por límite de grabación (replay truncado, sin resultado deportivo)");
    expect(v.outcome).not.toMatch(/empate|gana/i);
    expect(v.endReason).toContain("límite de grabación");
  });
  it("RL2 control: un empate deportivo sigue siendo «empate»", () => {
    expect(summarizeBattle(finished({ winner: "draw", endReason: "completed" }, "draw")).outcome).toBe("empate");
  });
});
