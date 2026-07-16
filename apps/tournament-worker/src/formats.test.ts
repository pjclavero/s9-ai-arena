/**
 * E9 · T9.2 — DoD de formatos:
 *  - Golden brackets: cada formato con 4, 8 y 13 participantes (impar incluido).
 *  - Propiedades (fast-check): round robin todos-contra-todos exactamente una
 *    vez; suizo sin repetir rival mientras sea evitable; doble eliminación
 *    nadie fuera con una sola derrota.
 * Generadores PUROS: sin BD.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  generateDoubleElimination,
  generateLeague,
  generateRoundRobin,
  generateSingleElimination,
  generateSwissRound,
  generateTeams,
  recommendedSwissRounds,
  seedPositions,
  type Entrant,
  type Pairing,
  type SwissStanding,
} from "./formats.js";

const P = (n: number, owners?: Record<number, string>): Entrant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `P${i + 1}`, seed: i + 1, ownerId: owners?.[i + 1] }));

const game = (p: Pairing) => [p.slot, p.home, p.away] as const;

// -------------------------------------------------------------------- golden

describe("T9.2 · golden brackets (calendario exacto)", () => {
  it("round robin con 4: 3 rondas, método del círculo con lados alternados", () => {
    const rr = generateRoundRobin(P(4));
    expect(rr.map(game)).toEqual([
      ["RR1M1", "P1", "P4"],
      ["RR1M2", "P3", "P2"],
      ["RR2M1", "P3", "P1"],
      ["RR2M2", "P4", "P2"],
      ["RR3M1", "P1", "P2"],
      ["RR3M2", "P4", "P3"],
    ]);
  });

  it("round robin con 8: 7 rondas × 4 mesas, sin byes", () => {
    const rr = generateRoundRobin(P(8));
    expect(rr.length).toBe(28); // C(8,2)
    expect(rr.filter((p) => p.bye)).toEqual([]);
    expect(new Set(rr.map((p) => p.round)).size).toBe(7);
    expect(rr.filter((p) => p.round === 1).map(game)).toEqual([
      ["RR1M1", "P1", "P8"],
      ["RR1M2", "P7", "P2"],
      ["RR1M3", "P3", "P6"],
      ["RR1M4", "P5", "P4"],
    ]);
  });

  it("round robin con 13 (impar): 13 rondas, un descanso rotatorio por ronda", () => {
    const rr = generateRoundRobin(P(13));
    const byes = rr.filter((p) => p.bye);
    expect(rr.length - byes.length).toBe(78); // C(13,2)
    expect(byes.length).toBe(13); // cada uno descansa exactamente una vez
    expect(new Set(byes.map((p) => p.home)).size).toBe(13);
    expect(rr.filter((p) => p.round === 1).map(game)).toEqual([
      ["RR1M1", "P1", null], // descanso de P1
      ["RR1M2", "P13", "P2"],
      ["RR1M3", "P3", "P12"],
      ["RR1M4", "P11", "P4"],
      ["RR1M5", "P5", "P10"],
      ["RR1M6", "P9", "P6"],
      ["RR1M7", "P7", "P8"],
    ]);
  });

  it("liga con 4 (ida y vuelta): la vuelta invierte los lados de la ida", () => {
    const league = generateLeague(P(4));
    expect(league.length).toBe(12);
    const ida = league.filter((p) => p.slot.startsWith("L1"));
    const vuelta = league.filter((p) => p.slot.startsWith("L2"));
    expect(ida.length).toBe(6);
    for (let i = 0; i < ida.length; i++) {
      expect(vuelta[i].home).toBe(ida[i].away);
      expect(vuelta[i].away).toBe(ida[i].home);
    }
    expect(ida[0].round).toBe(1);
    expect(vuelta[0].round).toBe(4); // la vuelta continúa la numeración
  });

  it("eliminatoria simple con 4: sembrado clásico 1v4 / 2v3 y final", () => {
    const se = generateSingleElimination(P(4));
    expect(se.map((p) => ({ slot: p.slot, home: p.home, away: p.away, final: p.final ?? false }))).toEqual([
      { slot: "W1M1", home: "P1", away: "P4", final: false },
      { slot: "W1M2", home: "P2", away: "P3", final: false },
      { slot: "W2M1", home: null, away: null, final: true },
    ]);
    expect(se[2].homeSource).toEqual({ slot: "W1M1", take: "winner" });
    expect(se[2].awaySource).toEqual({ slot: "W1M2", take: "winner" });
  });

  it("eliminatoria simple con 8: bracket completo estándar", () => {
    const se = generateSingleElimination(P(8));
    expect(se.filter((p) => p.round === 1).map(game)).toEqual([
      ["W1M1", "P1", "P8"],
      ["W1M2", "P4", "P5"],
      ["W1M3", "P2", "P7"],
      ["W1M4", "P3", "P6"],
    ]);
    expect(se.length).toBe(7); // 4 + 2 + 1
    expect(se.filter((p) => p.final).map((p) => p.slot)).toEqual(["W3M1"]);
  });

  it("eliminatoria simple con 13: byes exactamente para los 3 mejores seeds", () => {
    const se = generateSingleElimination(P(13));
    const r1 = se.filter((p) => p.round === 1);
    expect(r1.length).toBe(8); // bracket de 16
    const byes = r1.filter((p) => p.bye);
    expect(byes.map((p) => p.home).sort()).toEqual(["P1", "P2", "P3"]);
    expect(se.length).toBe(15);
    expect(se.filter((p) => p.final).map((p) => p.slot)).toEqual(["W4M1"]);
    // sembrado clásico de 16: la mesa 1 es 1 vs 16 (aquí bye)
    expect(seedPositions(16).slice(0, 4)).toEqual([1, 16, 8, 9]);
  });

  it("doble eliminación con 4: W + L + gran final con bracket reset", () => {
    const de = generateDoubleElimination(P(4));
    expect(de.map((p) => p.slot)).toEqual(["W1M1", "W1M2", "W2M1", "L1M1", "L2M1", "GF", "GF2"]);
    const bySlot = new Map(de.map((p) => [p.slot, p]));
    expect(bySlot.get("L1M1")!.homeSource).toEqual({ slot: "W1M1", take: "loser" });
    expect(bySlot.get("L1M1")!.awaySource).toEqual({ slot: "W1M2", take: "loser" });
    expect(bySlot.get("L2M1")!.homeSource).toEqual({ slot: "L1M1", take: "winner" });
    expect(bySlot.get("L2M1")!.awaySource).toEqual({ slot: "W2M1", take: "loser" });
    expect(bySlot.get("GF")!.homeSource).toEqual({ slot: "W2M1", take: "winner" });
    expect(bySlot.get("GF")!.awaySource).toEqual({ slot: "L2M1", take: "winner" });
    expect(bySlot.get("GF2")!.conditionalOn).toBe("W2M1");
    expect(de.filter((p) => p.final).map((p) => p.slot)).toEqual(["GF2"]);
  });

  it("doble eliminación con 8 y 13: todos los perdedores de W caen a L", () => {
    for (const n of [8, 13]) {
      const de = generateDoubleElimination(P(n));
      const wSlots = de.filter((p) => p.bracket === "winners").map((p) => p.slot);
      const loserFeeds = new Set(
        de
          .flatMap((p) => [p.homeSource, p.awaySource])
          .filter((s) => s?.take === "loser")
          .map((s) => s!.slot),
      );
      for (const slot of wSlots) expect(loserFeeds.has(slot)).toBe(true);
    }
    expect(generateDoubleElimination(P(8)).length).toBe(7 + 6 + 2); // W + L + GF/GF2
  });

  it("suizo con 8: ronda 1 por puntuación (adyacentes) con lados alternados", () => {
    const round1 = generateSwissRound(P(8).map((e) => ({ id: e.id, points: 0, seed: e.seed })), new Set(), 1);
    expect(round1.map(game)).toEqual([
      ["S1M1", "P1", "P2"],
      ["S1M2", "P4", "P3"],
      ["S1M3", "P5", "P6"],
      ["S1M4", "P8", "P7"],
    ]);
    expect(recommendedSwissRounds(8)).toBe(3);
    expect(recommendedSwissRounds(13)).toBe(4);
  });

  it("suizo con 13 (impar): bye para el peor clasificado sin descanso previo", () => {
    const round1 = generateSwissRound(P(13).map((e) => ({ id: e.id, points: 0, seed: e.seed })), new Set(), 1);
    const bye = round1.find((p) => p.bye);
    expect(bye?.home).toBe("P13");
    expect(round1.filter((p) => !p.bye).length).toBe(6);
  });

  it("suizo con 4: empareja por puntos y evita repetir rival", () => {
    // Tras la ronda 1 (P1>P2, P3>P4): líderes P1-P3; PERO P1 ya jugó con P2 y
    // P3 con P4, así que la ronda 2 natural es P1vP3 y P2vP4 (sin repetición).
    const standings: SwissStanding[] = [
      { id: "P1", points: 3, seed: 1 },
      { id: "P2", points: 0, seed: 2 },
      { id: "P3", points: 3, seed: 3 },
      { id: "P4", points: 0, seed: 4 },
    ];
    const played = new Set(["P1|P2", "P3|P4"]);
    const round2 = generateSwissRound(standings, played, 2);
    const pairs = round2.map((p) => [p.home, p.away].sort().join("|"));
    expect(pairs).toContain("P1|P3");
    expect(pairs).toContain("P2|P4");
  });

  it("equipos con 4 plantillas: liguilla entre equipos (round robin)", () => {
    const teams = generateTeams([
      { teamId: "T1", roster: ["a1", "a2"] },
      { teamId: "T2", roster: ["b1", "b2"] },
      { teamId: "T3", roster: ["c1", "c2"] },
      { teamId: "T4", roster: ["d1", "d2"] },
    ]);
    expect(teams.map(game)).toEqual([
      ["TRR1M1", "T1", "T4"],
      ["TRR1M2", "T3", "T2"],
      ["TRR2M1", "T3", "T1"],
      ["TRR2M2", "T4", "T2"],
      ["TRR3M1", "T1", "T2"],
      ["TRR3M2", "T4", "T3"],
    ]);
  });

  it("E9.M anti-colusión: dos bots del mismo dueño no se cruzan en la ronda 1 si es evitable", () => {
    // P1 y P4 son del mismo dueño y el sembrado clásico los cruzaría (1v4).
    const se = generateSingleElimination(P(4, { 1: "alice", 4: "alice" }));
    const r1 = se.filter((p) => p.round === 1);
    for (const m of r1) {
      expect(m.home === "P1" && m.away === "P4").toBe(false);
      expect(m.home === "P4" && m.away === "P1").toBe(false);
    }
    // Todos siguen jugando exactamente una vez.
    const all = r1.flatMap((p) => [p.home, p.away]);
    expect([...all].sort()).toEqual(["P1", "P2", "P3", "P4"]);
  });
});

// ---------------------------------------------------------------- propiedades

describe("T9.2 · propiedades (fast-check)", () => {
  it("round robin: todos juegan contra todos EXACTAMENTE una vez (2..16, par e impar)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 16 }), (n) => {
        const rr = generateRoundRobin(P(n));
        const seen = new Map<string, number>();
        for (const p of rr) {
          if (p.bye) continue;
          const key = [p.home, p.away].sort().join("|");
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        expect(seen.size).toBe((n * (n - 1)) / 2);
        for (const count of seen.values()) expect(count).toBe(1);
        // y nadie juega dos veces en la misma ronda
        for (let r = 1; r <= (n % 2 === 0 ? n - 1 : n); r++) {
          const inRound = rr.filter((p) => p.round === r).flatMap((p) => [p.home, p.away]).filter(Boolean);
          expect(new Set(inRound).size).toBe(inRound.length);
        }
      }),
      { numRuns: 15 },
    );
  });

  it("suizo: nadie repite rival mientras sea evitable (torneos simulados)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 12 }).filter((n) => n % 2 === 0),
        fc.infiniteStream(fc.boolean()),
        (n, results) => {
          const it = results[Symbol.iterator]();
          const points = new Map<string, number>(P(n).map((e) => [e.id, 0]));
          const played = new Set<string>();
          for (let round = 1; round <= recommendedSwissRounds(n); round++) {
            const standings: SwissStanding[] = P(n).map((e) => ({ id: e.id, points: points.get(e.id)!, seed: e.seed }));
            const pairings = generateSwissRound(standings, played, round);
            for (const p of pairings) {
              if (p.bye) continue;
              const key = [p.home, p.away].sort().join("|");
              expect(played.has(key)).toBe(false); // con rondas <= log2(n) SIEMPRE es evitable
              played.add(key);
              const homeWins = it.next().value as boolean;
              const winner = homeWins ? p.home! : p.away!;
              points.set(winner, points.get(winner)! + 3);
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("doble eliminación: NADIE queda fuera con una sola derrota (simulación completa)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 16 }),
        fc.infiniteStream(fc.boolean()),
        (n, results) => {
          const it = results[Symbol.iterator]();
          const de = generateDoubleElimination(P(n));
          const losses = new Map<string, number>(P(n).map((e) => [e.id, 0]));
          const outcome = new Map<string, { winner: string | null; loser: string | null }>();

          const pending = [...de];
          let guard = de.length * 4;
          let champion: string | null = null;
          while (pending.length > 0 && guard-- > 0) {
            const p = pending.shift()!;
            const home = p.home ?? (p.homeSource ? (outcome.has(p.homeSource.slot) ? outcome.get(p.homeSource.slot)![p.homeSource.take] : undefined) : null);
            const away = p.away ?? (p.awaySource ? (outcome.has(p.awaySource.slot) ? outcome.get(p.awaySource.slot)![p.awaySource.take] : undefined) : null);
            if (home === undefined || away === undefined) {
              pending.push(p); // aún no resuelto
              continue;
            }
            if (p.bye || home === null || away === null) {
              const solo = home ?? away;
              outcome.set(p.slot, { winner: solo, loser: null });
              if (p.final) champion = solo;
              continue;
            }
            // bracket reset condicional: si el invicto ganó la GF, GF2 es formalidad
            if (p.conditionalOn && outcome.get(p.conditionalOn)?.winner === home) {
              outcome.set(p.slot, { winner: home, loser: null });
              if (p.final) champion = home;
              continue;
            }
            const homeWins = it.next().value as boolean;
            const winner = homeWins ? home : away;
            const loser = homeWins ? away : home;
            losses.set(loser, (losses.get(loser) ?? 0) + 1);
            outcome.set(p.slot, { winner, loser });
            if (p.final) champion = winner;
          }

          expect(pending.length).toBe(0); // el bracket siempre se resuelve
          expect(champion).not.toBeNull();
          for (const [player, count] of losses) {
            if (player === champion) expect(count).toBeLessThanOrEqual(1);
            else expect(count).toBeLessThanOrEqual(2); // nadie acumula más de 2
          }
          // TODO eliminado (no campeón) tiene EXACTAMENTE 2 derrotas… salvo los
          // que nunca jugaron contra nadie (n=2 con bye no existe aquí).
          const eliminated = P(n).map((e) => e.id).filter((id) => id !== champion);
          for (const id of eliminated) expect(losses.get(id)).toBe(2);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("liga a dos vueltas: cada emparejamiento juega EXACTAMENTE una vez por lado (T9.4)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (n) => {
        const league = generateLeague(P(n));
        const sides = new Map<string, number>(); // "home>away" dirigido
        for (const p of league) {
          if (p.bye) continue;
          const key = `${p.home}>${p.away}`;
          sides.set(key, (sides.get(key) ?? 0) + 1);
        }
        expect(sides.size).toBe(n * (n - 1)); // todos los pares ordenados
        for (const count of sides.values()) expect(count).toBe(1);
      }),
      { numRuns: 15 },
    );
  });
});
