/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MA (D-B1 = R2, EQUIPMENT_PRIVATE).
 *
 * El equipamiento y el loadout completo son PRIVADOS por defecto en getBattleStats,
 * API pública y spectator: sin loadout, sin moduleId de catálogo, sin daño absoluto
 * público y sin ids internos. Cubre el hueco de la revisión (P1-2a): ya existían los
 * contratos de frames y de replay público (projection-ids.test.ts); faltaban las
 * ESTADÍSTICAS (getBattleStats se alimenta de `computeBattleStats`), el índice/nómina
 * del replay público y el WELCOME entregado al rival.
 *
 * Nombres del BASE_SHA: `computeBattleStats` (replay-service), `projectReplayDocument`,
 * `projectIndex` (api). Si MA añade una audiencia a `computeBattleStats`, adapta SÓLO
 * `publicStats()`. Dependencia de equipo: MA.
 */
import { beforeAll, describe, expect } from "vitest";
import { projectIndex, projectReplayDocument } from "../../../api/src/replay-projection.js";
import { computeBattleStats } from "../../../replay-service/src/stats.js";
import { initPhysics } from "../../src/sim/physics.js";
import { allKeys, allStrings, contractIt, fixtureGuard } from "../baseline/helpers.js";
import { recordReference } from "../baseline/reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

/** Id versionado de catálogo: `weapon.cannon@1`, `mine.explosive@1`, … */
const CATALOG_ID = /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@\d+\b/;
const INTERNAL_ID = /\b(veh|proj|mine)_\d+\b/;

async function publicStats(): Promise<any> {
  const r = await recordReference();
  const stats: any = await computeBattleStats(r);
  // Control de escenario: la batalla de referencia produce estadísticas por bot y módulo.
  fixtureGuard(stats && typeof stats === "object", "computeBattleStats no devolvió un objeto");
  const perBot = stats.perBot ?? stats.bots;
  fixtureGuard(perBot && Object.keys(perBot).length === 2, "las estadísticas de referencia no traen 2 bots");
  return stats;
}

describe("MA · D-B1 · getBattleStats (computeBattleStats) no revela el equipamiento", () => {
  contractIt(
    "MA",
    "las estadísticas públicas no llevan moduleId de catálogo (ni valor ni clave `moduleId`)",
    async () => {
      const stats = await publicStats();
      expect(allStrings(stats).filter((s) => CATALOG_ID.test(s))).toEqual([]);
      expect([...allKeys(stats)].filter((k) => k === "moduleId")).toEqual([]);
    },
  );

  contractIt("MA", "las estadísticas públicas no llevan el loadout ni el chasis de catálogo", async () => {
    const stats = await publicStats();
    const keys = allKeys(stats);
    for (const k of ["loadout", "spec", "chassis", "chassisId", "modules"]) {
      expect(keys.has(k), `clave de equipamiento «${k}» en las estadísticas públicas`).toBe(false);
    }
  });

  contractIt("MA", "las estadísticas públicas no llevan ids internos de vehículo/proyectil/mina", async () => {
    const stats = await publicStats();
    expect(allStrings(stats).filter((s) => INTERNAL_ID.test(s))).toEqual([]);
    expect([...allKeys(stats)].filter((k) => INTERNAL_ID.test(k))).toEqual([]);
  });

  contractIt("MA", "sin daño ABSOLUTO público: ni damageDealt/damageTaken numéricos ni daño por módulo", async () => {
    const stats = await publicStats();
    const keys = allKeys(stats);
    for (const k of ["damageDealt", "damageTaken", "hullHp", "hullHpMax"]) {
      expect(keys.has(k), `daño absoluto «${k}» en las estadísticas públicas`).toBe(false);
    }
  });
});

describe("MA · D-B1 · replay público: nómina e índice sin equipamiento", () => {
  contractIt("MA", "la nómina (roster) del replay público no lleva chasis de catálogo", async () => {
    const r = await recordReference();
    const meta = {
      world: {},
      roster: r.header.participants.map((p: any) => ({
        id: p.id,
        botId: p.botId,
        team: p.team,
        chassis: p.spec.chassisId,
      })),
    };
    const doc: any = projectReplayDocument(r, meta);
    const idx = projectIndex(
      { battleId: "me", ticks: r.result.ticks, snapshotCount: 1, keyframes: [], result: r.result },
      meta,
    );
    fixtureGuard(Array.isArray(doc.roster) && doc.roster.length === 2, "el replay público no trae nómina de 2");
    for (const part of [doc.roster, idx]) {
      expect(allStrings(part).filter((s) => CATALOG_ID.test(s))).toEqual([]);
      expect([...allKeys(part)].filter((k) => k === "chassis" || k === "moduleId")).toEqual([]);
    }
  });
});
