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
import { beforeAll, describe, expect, it } from "vitest";
import { projectIndex, projectReplayDocument } from "../../../api/src/replay-projection.js";
import { computeBattleStats } from "../../../replay-service/src/stats.js";
import { projectBotStats } from "../../../../packages/projection/index.js";
import type { AudienceClass } from "../../../../packages/projection/contracts.js";
import { initPhysics } from "../../src/sim/physics.js";
import { allKeys, allStrings, fixtureGuard } from "../baseline/helpers.js";
import { recordReference } from "../baseline/reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

/** Id versionado de catálogo: `weapon.cannon@1`, `mine.explosive@1`, … */
const CATALOG_ID = /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@\d+\b/;
const INTERNAL_ID = /\b(veh|proj|mine)_\d+\b/;

async function statsFor(audience: AudienceClass = "public_replay"): Promise<any> {
  const r = await recordReference();
  const stats: any = await computeBattleStats(r);
  // Control de escenario: la batalla de referencia produce estadísticas por bot y módulo.
  fixtureGuard(stats && typeof stats === "object", "computeBattleStats no devolvió un objeto");
  const perBot = stats.perBot ?? stats.bots;
  fixtureGuard(perBot && Object.keys(perBot).length === 2, "las estadísticas de referencia no traen 2 bots");
  // Integración OLA 2 (M0): adaptador a MA. getBattleStats (apps/api/src/routes/battles.ts) publica por
  // bot `projectBotStats(stats, audiencia)`, sin el diagnóstico (cpuMs, decisions, rechazos); esto
  // reproduce esa salida. computeBattleStats es el cálculo INTERNO de replay-service.
  const pub: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(perBot as Record<string, any>)) {
    const { cpuMs: _c, decisions: _d, rejectionsByReason: _r, radioDroppedByReason: _x, ...rest } = s;
    pub[String(s.botId ?? k)] = projectBotStats(rest, audience);
  }
  return { perBot: pub, raw: perBot };
}

/** Estadísticas que ve un tercero cualquiera (replay público). */
async function publicStats(): Promise<any> {
  const { perBot } = await statsFor("public_replay");
  return { perBot };
}

describe("MA · D-B1 · getBattleStats (computeBattleStats) no revela el equipamiento", () => {
  it("[contrato MA cumplido · integración OLA 2] las estadísticas públicas no llevan moduleId de catálogo (ni valor ni clave `moduleId`)", async () => {
    const stats = await publicStats();
    expect(allStrings(stats).filter((s) => CATALOG_ID.test(s))).toEqual([]);
    expect([...allKeys(stats)].filter((k) => k === "moduleId")).toEqual([]);
  });

  it("(guarda de baseline, verde en el BASE_SHA) las estadísticas públicas no llevan el loadout ni el chasis", async () => {
    const stats = await publicStats();
    const keys = allKeys(stats);
    for (const k of ["loadout", "spec", "chassis", "chassisId", "modules"]) {
      expect(keys.has(k), `clave de equipamiento «${k}» en las estadísticas públicas`).toBe(false);
    }
  });

  it("[contrato MA cumplido · integración OLA 2] las estadísticas públicas no llevan ids internos de vehículo/proyectil/mina", async () => {
    const stats = await publicStats();
    expect(allStrings(stats).filter((s) => INTERNAL_ID.test(s))).toEqual([]);
    expect([...allKeys(stats)].filter((k) => INTERNAL_ID.test(k))).toEqual([]);
  });

  it("[contrato MA cumplido · integración OLA 2] sin daño ABSOLUTO público: ni damageDealt/damageTaken numéricos ni daño por módulo", async () => {
    const stats = await publicStats();
    const keys = allKeys(stats);
    for (const k of ["damageDealt", "damageTaken", "hullHp", "hullHpMax"]) {
      expect(keys.has(k), `daño absoluto «${k}» en las estadísticas públicas`).toBe(false);
    }
  });
});

describe("MA · D-B1 · audiencias de dueño y staff: valores EXACTOS (G2, REVIEW-ME-2 P2-B)", () => {
  for (const audience of ["owner", "staff"] as const) {
    it(`[G2] ${audience}: damageDealt/damageTaken y aciertos EXACTOS (iguales al cálculo interno), sin id interno`, async () => {
      const { perBot, raw } = await statsFor(audience);
      for (const [key, own] of Object.entries(perBot as Record<string, any>)) {
        const internal = (Object.values(raw) as any[]).find((x) => String(x.botId) === key)!;
        fixtureGuard(internal !== undefined, `no hay estadística interna para ${key}`);
        fixtureGuard(typeof internal.damageDealt === "number", "la referencia no trae damageDealt numérico");
        expect(own.damageDealt, `${audience} ${key}`).toBe(internal.damageDealt);
        expect(own.damageTaken).toBe(internal.damageTaken);
        expect(own.shotsHit).toBe(internal.shotsHit); // sin cuantizar
        expect(own).not.toHaveProperty("vehicleId"); // id interno: nunca, ni al dueño
      }
      expect(allStrings(perBot).filter((x) => INTERNAL_ID.test(x))).toEqual([]);
    });
  }

  it("[G2] control diferencial: un tercero recibe los aciertos CUANTIZADOS y ningún daño absoluto sobre los mismos datos", async () => {
    const owner = (await statsFor("owner")).perBot as Record<string, any>;
    const third = (await statsFor("public_replay")).perBot as Record<string, any>;
    const quantized = Object.keys(owner).filter((k) => owner[k].shotsHit % 5 !== 0);
    // Si todos los exactos fueran múltiplos de 5 la prueba no distinguiría cuantizado de exacto.
    fixtureGuard(
      quantized.length > 0,
      "la referencia no tiene aciertos no múltiplos de 5: no distingue exacto de cuantizado",
    );
    for (const k of Object.keys(third)) {
      expect(third[k].shotsHit % 5, k).toBe(0);
      expect(third[k]).not.toHaveProperty("damageDealt");
      expect(third[k]).not.toHaveProperty("damageTaken");
    }
  });
});

describe("MA · D-B1 · loadout PRIVADO explícito aunque el bot sea público (G2, REVIEW-ME-2 P2-B)", () => {
  // La visibilidad del BOT (público/privado) no abre el equipamiento: ninguna audiencia que no sea
  // dueño o staff recibe perModule, minas, radio ni moduleId de catálogo. (El endpoint
  // `GET /bots/{id}/loadouts` con bot público lo cubre apps/api/src/ma-loadouts-private.test.ts.)
  for (const audience of ["public_live", "broadcast", "public_replay", "team", "bot_team"] as const) {
    it(`[G2] ${audience}: sin perModule, minas, radio ni moduleId de catálogo`, async () => {
      const { perBot } = await statsFor(audience);
      const keys = allKeys(perBot);
      for (const k of ["perModule", "minesDeployed", "minesTriggered", "radio", "loadout", "chassis", "moduleId"]) {
        expect(keys.has(k), `${audience}: clave de equipamiento «${k}»`).toBe(false);
      }
      expect(allStrings(perBot).filter((x) => CATALOG_ID.test(x))).toEqual([]);
    });
  }

  it("[G2] control positivo: el DUEÑO sí recibe su desglose por ranura (si no, lo de arriba no distingue privado de inexistente)", async () => {
    const { perBot, raw } = await statsFor("owner");
    const internalHasModules = (Object.values(raw) as any[]).some((x) => x.perModule !== undefined);
    fixtureGuard(internalHasModules, "la referencia no produce perModule: control inútil");
    expect(Object.values(perBot as Record<string, any>).some((x) => x.perModule !== undefined)).toBe(true);
  });
});

describe("MA · D-B1 · replay público: nómina e índice sin equipamiento", () => {
  it("[contrato MA cumplido · integración OLA 2] la nómina (roster) del replay público no lleva chasis de catálogo", async () => {
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
