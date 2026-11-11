/**
 * OLA 2 · ME · BASELINE · lo que filtran HOY las salidas públicas (C-ID-1/2, C-RPL-2,
 * C-PRJ-1, WELCOME, estadísticas).
 *
 * Fija la FORMA exacta de: snapshot público del motor (lo que el gateway reenvía al
 * espectador y al broadcast tal cual), WELCOME, replay público proyectado
 * (apps/api/src/replay-projection.ts) y estadísticas por módulo (replay-service). Cada
 * fuga conocida va como `characterizes-defect: …`: MA/MB la invierten en su PR y activan
 * el contrato equivalente de contract-pending/.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { ProtocolServer } from "../../src/protocol-server.js";
import { emptyArena, gunnerLoadout, minerLoadout, scoutLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { projectReplayDocument } from "../../../api/src/replay-projection.js";
import { computeBattleStats } from "../../../replay-service/src/stats.js";
import { effectOf } from "../../../../packages/module-catalog/effect-status.js";
import { ScriptBot, allKeys, assertBaselineGolden } from "./helpers.js";
import { recordReference } from "./reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

/**
 * Minero que dispara en el tick 0, siembra una mina en el 3 y vuelve a disparar en el 30:
 * reproduce el hueco de numeración de #261.
 */
function minerIdBattle() {
  const map = emptyArena(200, 80);
  const b = new Battle({
    battleId: "me_ids",
    seed: "me-ids",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
    map,
    snapshotEveryNTicks: 1,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: minerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
    ],
  });
  b.attachBot(
    "veh_1",
    new ScriptBot("b1", (t) => {
      if (t === 0 || t === 30) return { fire: ["turret_main"], turret: { targetHeading: Math.PI / 2 } };
      // fire + deployMine: en la base deployMine sólo se procesa junto a un fire no vacío
      // (ver mine-deploy-quirk). El fire del tick 3 se rechaza por cooldown y NO consume id.
      if (t === 3)
        return { fire: ["turret_main"], deployMine: { slot: "mine_bay" }, turret: { targetHeading: Math.PI / 2 } };
      return { turret: { targetHeading: Math.PI / 2 } };
    }),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  return b;
}

describe("baseline · ids de entidad (proj_N / mine_N, entitySeq compartido, #261)", () => {
  it("characterizes-defect: proyectiles y minas consumen el MISMO entitySeq; el hueco en proj_N delata la mina oculta", () => {
    const b = minerIdBattle();
    for (let t = 0; t < 40; t++) b.step();
    const mines = b.getMines().map((m) => m.id);
    const publicProj = [...new Set(b.snapshots.flatMap((s: any) => s.projectiles.map((p: any) => p.id)))];
    const publicKeys = allKeys(b.snapshots);
    const entitySeq = (b as any).entitySeq;
    b.free();
    expect(mines).toEqual(["mine_1"]);
    expect(publicProj).toEqual(["proj_0", "proj_2"]); // DEFECTO: falta proj_1 ⇒ alguien sembró algo oculto
    expect(entitySeq).toBe(3);
    // La mina en sí no sale en el snapshot público (eso SÍ es contrato vigente).
    expect(JSON.stringify(b.snapshots)).not.toContain("mine_1");
    expect(publicKeys.has("mines")).toBe(false);
  });

  it("characterizes-defect: el id público del vehículo ES el id interno del participante (veh_N)", () => {
    const b = minerIdBattle();
    b.step();
    const ids = b.getPublicSnapshot().vehicles.map((v: any) => v.id);
    b.free();
    expect(ids).toEqual(["veh_1", "veh_2"]);
  });
});

describe("baseline · forma del snapshot público del motor (espectador, broadcast, replay)", () => {
  it("claves exactas por vehículo y por proyectil (golden)", () => {
    const b = minerIdBattle();
    b.step();
    const s = b.getPublicSnapshot();
    b.free();
    assertBaselineGolden("public-snapshot-shape", {
      top: Object.keys(s).sort(),
      vehicle: Object.keys(s.vehicles[0]).sort(),
      module: Object.keys(s.vehicles[0].modules[0]).sort(),
      projectile: s.projectiles.length ? Object.keys(s.projectiles[0]).sort() : [],
      moduleSlots: s.vehicles.map((v: any) => v.modules.map((m: any) => m.slot)),
    });
  });

  it("characterizes-defect: el snapshot público expone hullHp exacto, hullHpMax del chasis y las ranuras de cada módulo", () => {
    const b = minerIdBattle();
    b.step();
    const v = b.getPublicSnapshot().vehicles.find((x: any) => x.id === "veh_1");
    b.free();
    expect(v.hullHpMax).toBe(minerLoadout().hullHp); // identifica el chasis
    expect(typeof v.hullHp).toBe("number"); // hp absoluto, no hullLevel
    expect(v.hullLevel).toBeUndefined();
    expect(v.modules.map((m: any) => m.slot)).toContain("mine_bay"); // revela que lleva minas
  });
});

describe("baseline · WELCOME (protocol-server.buildWelcome)", () => {
  async function welcomeFor(spec = gunnerLoadout()) {
    const battle = await Battle.create({
      battleId: "me_welcome",
      seed: "me-welcome",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_w1", team: "red", spec },
        { id: "veh_2", botId: "bot_w2", team: "blue", spec: scoutLoadout() },
      ],
    });
    const expected = { botId: "bot_w1", vehicleId: "veh_1", battleToken: "t".repeat(16) };
    const server = new ProtocolServer({ battle, catalogVersion: "mvp@1", expected: [expected], port: 0 });
    try {
      return (server as any).buildWelcome(expected);
    } finally {
      server.stop();
      battle.free();
    }
  }

  it("forma del WELCOME (golden de claves y de specs por módulo)", async () => {
    const w = await welcomeFor();
    assertBaselineGolden("welcome-shape", {
      top: Object.keys(w).sort(),
      vehicle: Object.keys(w.vehicle).sort(),
      modules: w.vehicle.modules.map((m: any) => ({
        slot: m.slot,
        moduleId: m.moduleId,
        category: m.category,
        specKeys: Object.keys(m.specs).sort(),
      })),
    });
  });

  it("characterizes-defect: WELCOME.specs incluye campos FUTURE (sin efecto) como weapon.rangeM y turretArcRad", async () => {
    const w = await welcomeFor();
    const leaked: string[] = [];
    for (const m of w.vehicle.modules) {
      for (const k of Object.keys(m.specs)) {
        if (m.specs[k] === undefined) continue;
        if (effectOf(m.category, k)?.status === "FUTURE") leaked.push(`${m.category}.${k}`);
      }
    }
    expect(leaked).toEqual(expect.arrayContaining(["weapon.rangeM", "weapon.turretArcRad", "radio.rangeM"]));
  });
});

describe("baseline · replay público proyectado y estadísticas (API / replay-service)", () => {
  it("characterizes-defect: el documento de replay público conserva hullHpMax, ranuras de módulos, proj_N e ids veh_N", async () => {
    const r = await recordReference();
    const doc: any = projectReplayDocument(r, {
      world: {},
      roster: r.header.participants.map((p: any) => ({
        id: p.id,
        botId: p.botId,
        team: p.team,
        chassis: p.spec.chassisId,
      })),
    });
    const v0 = doc.snapshots[0].vehicles[0];
    expect(v0.id).toBe("veh_1");
    expect(typeof v0.hullHpMax).toBe("number");
    expect(Array.isArray(v0.modules)).toBe(true);
    expect(doc.roster[0].chassis).toBe("chassis.medium@1");
    const projIds = doc.snapshots.flatMap((s: any) => s.projectiles.map((p: any) => p.id));
    expect(projIds.every((id: string) => /^proj_\d+$/.test(id))).toBe(true);
    // Contrato vigente que NO debe romperse: sin seed, sin comandos, sin spec.
    const keys = allKeys(doc);
    for (const k of ["seed", "commands", "spec", "loadout", "stateHashes"]) expect(keys.has(k)).toBe(false);
  });

  it("characterizes-defect: las estadísticas por módulo llevan el moduleId de catálogo de cada ranura", async () => {
    const r = await recordReference();
    const stats = await computeBattleStats(r);
    const perModule = (stats as any).perBot ?? (stats as any).bots ?? stats;
    const json = JSON.stringify(perModule);
    expect(json).toContain("weapon.cannon@1");
    expect(json).toContain("mine.explosive@1");
  });
});
