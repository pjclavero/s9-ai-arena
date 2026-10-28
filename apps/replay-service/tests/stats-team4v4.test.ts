/**
 * 4v4-STATS · Estadísticas de batallas por equipos con el MOTOR REAL (no hay
 * replays hechos a mano): un team_deathmatch 4v4 con respawn, 8 participantes.
 *
 * Qué fija:
 *  1. Muertes con respawn: TODAS las bajas y muertes por bot (antes sólo la
 *     primera), `died`/`aliveAtEnd`/`survivors` coherentes, y las bajas por
 *     equipo IGUALES al marcador del motor (`result.score`).
 *  2. `perTeam` = suma de lo deportivo de `perBot` (bajas, muertes, daño,
 *     disparos, aciertos).
 *  3. Radio observada sin cambiar el contrato (Fase 6): `radio.sent`, `received`,
 *     `receivedFromTeammates`, `receivedFromEnemies` EXACTOS contra lo que los
 *     agentes vivos oyeron en la batalla original; el rival también oye.
 *  4. Los ganchos de `resimulateWithEvents` no alteran la simulación.
 *
 * La verdad de cada comprobación sale de una fuente INDEPENDIENTE de stats.ts:
 * los agentes reales registran lo que oyen durante la batalla grabada, y las
 * muertes se cuentan sobre los eventos públicos del replay.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { resimulateWithEvents, verify, type Replay } from "../../arena-engine/src/replay.js";
import { computeBattleStats, type BattleStatsResult } from "../src/stats.js";
import { BLUE, RED, play4v4, type Listening } from "./fixtures/team4v4.js";

let replay: Replay;
let agents: Map<string, Listening>;
let s: BattleStatsResult;

beforeAll(async () => {
  await initPhysics();
  ({ replay, agents } = await play4v4("stats-4v4-tdm"));
  s = await computeBattleStats(replay);
}, 180_000);

describe("4v4-STATS · TDM 4v4 real con respawn", () => {
  it("es un 4v4 de verdad: 8 participantes, TDM, verificable, con reapariciones", async () => {
    expect(replay.header.participants).toHaveLength(8);
    expect(replay.header.ruleset.mode).toBe("team_deathmatch");
    expect(Object.keys(s.perBot).sort()).toEqual([...RED, ...BLUE].sort());
    expect((await verify(replay)).matches).toBe(true);
    const respawns = Object.values(s.perBot).reduce((a, b) => a + b.respawns, 0);
    expect(respawns).toBeGreaterThan(0);
    // Al menos un bot murió MÁS de una vez: sin esto el test no prueba el respawn.
    expect(Math.max(...Object.values(s.perBot).map((b) => b.deaths))).toBeGreaterThan(1);
    // Los dos bandos puntúan: hay bajas en ambos sentidos.
    expect(replay.result.score.red).toBeGreaterThan(0);
    expect(replay.result.score.blue).toBeGreaterThan(0);
  });

  it("muertes por bot = vehicle_destroyed públicos del replay (todas, no sólo la primera)", () => {
    for (const id of [...RED, ...BLUE]) {
      const destroyed = replay.events.filter((e) => e.kind === "vehicle_destroyed" && e.targetId === id).length;
      expect(s.perBot[id].deaths, id).toBe(destroyed);
      expect(s.perBot[id].died).toBe(destroyed > 0);
    }
  });

  it("las bajas por equipo cuadran EXACTAMENTE con el marcador del motor", () => {
    for (const team of ["red", "blue"]) {
      expect(s.perTeam[team].kills, team).toBe(replay.result.score[team]);
      expect(s.perTeam[team].score).toBe(replay.result.score[team]);
    }
    // Sin fuego amigo ni zonas, cada muerte de un bando es una baja del otro.
    expect(s.perTeam.red.kills).toBe(s.perTeam.blue.deaths);
    expect(s.perTeam.blue.kills).toBe(s.perTeam.red.deaths);
    expect(s.perTeam.red.teamKills + s.perTeam.blue.teamKills).toBe(0);
    expect(s.perTeam.red.kills + s.perTeam.blue.kills).toBeGreaterThan(1);
  });

  it("vida coherente con el respawn: aliveAtEnd, survivors y respawns ≤ deaths", () => {
    for (const b of Object.values(s.perBot)) {
      expect(b.respawns).toBeLessThanOrEqual(b.deaths);
      expect(b.deaths - b.respawns).toBeLessThanOrEqual(1);
      // Vivo al final ⇔ reapareció tantas veces como murió.
      expect(b.aliveAtEnd).toBe(b.deaths === b.respawns && !b.disqualified);
      expect(b.survivedTicks).toBeGreaterThan(0);
      expect(b.survivedTicks).toBeLessThanOrEqual(s.durationTicks);
      if (b.deaths === 0) expect(b.survivedTicks).toBe(s.durationTicks);
    }
    // El último snapshot público dice quién estaba vivo.
    const last = replay.snapshots.at(-1);
    for (const team of ["red", "blue"]) {
      const alive = Object.entries(s.perBot).filter(([, b]) => b.team === team && b.aliveAtEnd).length;
      expect(s.perTeam[team].survivors).toBe(alive);
      expect(s.perTeam[team].bots).toBe(4);
    }
    for (const v of last.vehicles) {
      // El snapshot puede ser hasta 2 ticks anterior al final: sólo se exige si no hubo cambios en esos ticks.
      const changedAtEnd = replay.events.some((e) => e.targetId === v.id && e.tick > last.tick);
      if (!changedAtEnd) expect(s.perBot[v.id].aliveAtEnd, v.id).toBe(Boolean(v.alive));
    }
  });

  it("perTeam = suma de lo deportivo de perBot (daño, disparos, aciertos, bajas, muertes)", () => {
    for (const team of ["red", "blue"]) {
      const bots = Object.values(s.perBot).filter((b) => b.team === team);
      const sum = (f: (b: (typeof bots)[number]) => number) => bots.reduce((a, b) => a + f(b), 0);
      const t = s.perTeam[team];
      expect(t.damageDealt).toBeCloseTo(sum((b) => b.damageDealt), 9);
      expect(t.damageTaken).toBeCloseTo(sum((b) => b.damageTaken), 9);
      expect(t.shotsFired).toBe(sum((b) => b.shotsFired));
      expect(t.shotsHit).toBe(sum((b) => b.shotsHit));
      expect(t.kills).toBe(sum((b) => b.kills));
      expect(t.deaths).toBe(sum((b) => b.deaths));
    }
    // Conservación del daño entre bandos (sin zonas ni fuego amigo).
    expect(s.perTeam.red.damageDealt).toBeCloseTo(s.perTeam.blue.damageTaken, 6);
    expect(s.perTeam.blue.damageDealt).toBeCloseTo(s.perTeam.red.damageTaken, 6);
    expect(s.perTeam.red.shotsHit + s.perTeam.blue.shotsHit).toBeGreaterThan(0);
  });
});

describe("4v4-STATS · radio observada (Fase 6) sin cambiar el contrato", () => {
  it("received / fromTeammates / fromEnemies EXACTOS contra lo que oyeron los agentes en vivo", () => {
    const teamOf = new Map(replay.header.participants.map((p: any) => [p.id, p.team]));
    for (const [id, a] of agents) {
      const mate = a.heard.filter((m) => teamOf.get(m.from) === teamOf.get(id)).length;
      const enemy = a.heard.filter((m) => teamOf.get(m.from) !== teamOf.get(id)).length;
      expect(s.perBot[id].radio.received, id).toBe(a.heard.length);
      expect(s.perBot[id].radio.receivedFromTeammates, id).toBe(mate);
      expect(s.perBot[id].radio.receivedFromEnemies, id).toBe(enemy);
    }
    // Contrato actual: el rival TAMBIÉN oye (sensors.ts; radio-regression.test.ts).
    for (const id of BLUE) expect(s.perBot[id].radio.receivedFromEnemies, id).toBeGreaterThan(0);
    for (const id of ["r2", "r3", "r4"]) expect(s.perBot[id].radio.receivedFromTeammates, id).toBeGreaterThan(0);
    // Sólo r1 emite: nadie oye a otro, y r1 no se oye a sí mismo.
    expect(s.perBot.r1.radio.received).toBe(0);
    for (const id of BLUE) expect(s.perBot[id].radio.receivedFromTeammates).toBe(0);
  });

  it("sent = mensajes ACEPTADOS (oídos por alguien), no intentos: ni descartados ni enviados muerto", () => {
    const r1 = s.perBot.r1;
    // r1 emite hasta RADIO_UNTIL_TICK y la batalla dura más: todo lo aceptado se
    // entrega. Los vivos y los muertos observan (sólo un descalificado no), así
    // que cada broadcast aceptado lo oyen los otros 7 y cada dirigido, sólo r2.
    expect(Object.values(s.perBot).some((b) => b.disqualified)).toBe(false);
    const broadcastAccepted = agents.get("b1")!.heard.length;
    for (const id of ["r3", "r4", ...BLUE]) expect(agents.get(id)!.heard.length).toBe(broadcastAccepted);
    const directedAccepted = agents.get("r2")!.heard.length - broadcastAccepted;
    expect(broadcastAccepted).toBeGreaterThan(0);
    expect(directedAccepted).toBeGreaterThan(0);
    expect(r1.radio.sent).toBe(broadcastAccepted + directedAccepted);
    // r1 murió hablando: lo que «envió» muerto ni se acepta ni se descarta. La
    // cuenta ingenua (intentos − descartes) lo contaría: aquí se ve la diferencia.
    expect(r1.deaths).toBeGreaterThan(0);
    const attempts = replay.commands
      .filter((c) => c.vehicleId === "r1")
      .reduce((a, c) => a + (c.command?.radio?.length ?? 0), 0);
    const dropped = Object.values(r1.radioDroppedByReason).reduce((a, n) => a + n, 0);
    expect(attempts - dropped).toBeGreaterThan(r1.radio.sent);
    expect(r1.perModule.radio_a.usesKind).toBe("radio_messages");
    expect(r1.perModule.radio_a.uses).toBe(r1.radio.sent);
    // Descartes: diagnóstico, por motivo; el rate-limit y el tamaño se ven.
    expect(r1.radioDroppedByReason.rate_limited ?? 0).toBeGreaterThan(0);
    expect(r1.radioDroppedByReason.too_large ?? 0).toBeGreaterThan(0);
    for (const id of ["r2", "r3", "r4", ...BLUE]) {
      expect(s.perBot[id].radio.sent).toBe(0);
      expect(Object.keys(s.perBot[id].radioDroppedByReason)).toHaveLength(0);
    }
  });

  it("los ganchos onObservation/onEmission no alteran la simulación (mismo resultado y hash)", async () => {
    let observations = 0;
    let emissions = 0;
    const withHooks = await resimulateWithEvents(replay, () => {}, {
      onObservation: (_id, obs) => {
        observations++;
        // Un callback hostil que mutara la observación NO debe cambiar la batalla.
        obs.tick = -1;
        if (obs.score) obs.score.red = 1e9;
      },
      onEmission: (e) => {
        emissions++;
        e.tick = -1;
      },
    });
    const without = await resimulateWithEvents(replay, () => {});
    expect(observations).toBeGreaterThan(0);
    expect(emissions).toBeGreaterThan(0);
    expect(withHooks.finalStateHash).toBe(replay.result.finalStateHash);
    expect(without.finalStateHash).toBe(replay.result.finalStateHash);
    expect(withHooks.score).toEqual(replay.result.score);
  }, 120_000);
});
