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
import { ScriptBot, allKeys, allStrings, assertBaselineGolden, publicStream } from "./helpers.js";
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
  // INVERTIDO en la integración OLA 2 (M0) por el arreglo de MA (P-1: PublicEntityId por audiencia, densos,
  // una entidad no vista no consume id): antes «el hueco en proj_N delata la mina oculta». El asignador
  // INTERNO sigue compartido (entitySeq 3: proj_0, mine_1, proj_2); lo que ya no sale es ese número.
  it("corregido (MA): los ids públicos de proyectil son densos y no delatan la mina oculta", () => {
    const b = minerIdBattle();
    for (let t = 0; t < 40; t++) b.step();
    const mines = b.getMines().map((m) => m.id);
    const pub = publicStream(b);
    const publicProj = [
      ...new Set(pub.snapshots.flatMap((s: any) => (s.projectiles ?? []).map((p: any) => String(p.id)))),
    ];
    const publicKeys = allKeys(pub.snapshots);
    const entitySeq = (b as any).entitySeq;
    b.free();
    expect(mines).toEqual(["mine_1"]);
    expect(entitySeq).toBe(3);
    expect(publicProj).toHaveLength(2);
    expect(publicProj.every((id) => /^p_\d+$/.test(id))).toBe(true);
    const nums = publicProj.map((id) => Number(id.split("_")[1]));
    expect(nums[1]! - nums[0]!).toBe(1);
    // La mina no sale en el frame público (contrato vigente).
    expect(JSON.stringify(pub.snapshots)).not.toMatch(/mine_\d|"d_\d/);
    expect(publicKeys.has("mines")).toBe(false);
  });

  // INVERTIDO en la integración OLA 2 (M0) por el arreglo de MA (ids públicos v_N; los internos nunca salen):
  // antes «el id público del vehículo ES el id interno (veh_N)».
  it("corregido (MA): el id público del vehículo NO es el interno (v_N, no veh_N)", () => {
    const b = minerIdBattle();
    b.step();
    const ids = (publicStream(b).snapshots[0] as any).vehicles.map((v: any) => String(v.id));
    b.free();
    expect(ids).toHaveLength(2);
    expect(ids.every((id: string) => /^v_\d+$/.test(id))).toBe(true);
  });
});

describe("baseline · forma del snapshot público del motor (espectador, broadcast, replay)", () => {
  it("claves exactas por vehículo y por proyectil (golden)", () => {
    // REGENERADO en la integración OLA 2 (M0) por MA: la forma pública es la del frame PROYECTADO
    // (projectFrame, audiencia public_live), sin módulos ni ranuras (D-B1 = R2) y con hullLevel (D-B5).
    const b = minerIdBattle();
    b.step();
    const s: any = publicStream(b).snapshots[0];
    b.free();
    assertBaselineGolden("public-snapshot-shape", {
      top: Object.keys(s).sort(),
      vehicle: Object.keys(s.vehicles[0]).sort(),
      projectile: (s.projectiles ?? []).length ? Object.keys(s.projectiles[0]).sort() : [],
    });
  });

  // INVERTIDO en la integración OLA 2 (M0) por MA (D-B1 = R2, frame proyectado) y MB/MA (D-B5 hullLevel N=20):
  // antes «el snapshot público expone hullHp exacto, hullHpMax del chasis y las ranuras de cada módulo».
  it("corregido (MA/MB): el frame público no expone hullHp, hullHpMax ni ranuras; lleva hullLevel en [0, 20]", () => {
    const b = minerIdBattle();
    b.step();
    const vs = (publicStream(b).snapshots[0] as any).vehicles as any[];
    b.free();
    expect(vs).toHaveLength(2);
    for (const v of vs) {
      expect(v).not.toHaveProperty("hullHp");
      expect(v).not.toHaveProperty("hullHpMax");
      expect(v).not.toHaveProperty("modules");
      expect(Number.isInteger(v.hullLevel) && v.hullLevel >= 0 && v.hullLevel <= 20).toBe(true);
    }
    expect(allStrings(vs)).not.toContain("mine_bay"); // ya no revela que lleva minas
    expect(minerLoadout().hullHp).toBeGreaterThan(0);
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

  // INVERTIDO en la integración OLA 2 (M0) por MC (P-2: weapon.rangeM y radio.rangeM son reales, ningún campo
  // FUTURE), MB (D-B2: turretArcRad sale del arma) y MA (ficha WELCOME sólo ACTIVE/validación):
  // antes «WELCOME.specs incluye campos FUTURE como weapon.rangeM y turretArcRad».
  it("corregido (MC/MB/MA): WELCOME.specs no lleva ningún campo FUTURE ni turretArcRad en el arma", async () => {
    const w = await welcomeFor();
    const leaked: string[] = [];
    for (const m of w.vehicle.modules) {
      for (const k of Object.keys(m.specs)) {
        if (m.specs[k] === undefined) continue;
        if (effectOf(m.category, k)?.status === "FUTURE") leaked.push(`${m.category}.${k}`);
      }
    }
    expect(leaked).toEqual([]);
    const weapon = w.vehicle.modules.find((m: any) => m.category === "weapon");
    expect(weapon).toBeDefined();
    expect(weapon.specs).not.toHaveProperty("turretArcRad");
  });
});

describe("baseline · replay público proyectado y estadísticas (API / replay-service)", () => {
  // INVERTIDO en la integración OLA 2 (M0) por MA (proyección del replay público: ids públicos, sin hullHpMax,
  // módulos ni chasis): antes «el documento de replay público conserva hullHpMax, ranuras, proj_N e ids veh_N».
  it("corregido (MA): el documento de replay público no lleva hullHpMax, módulos, chasis ni ids internos", async () => {
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
    expect(v0.id).toMatch(/^v_\d+$/);
    expect(v0).not.toHaveProperty("hullHpMax");
    expect(v0).not.toHaveProperty("modules");
    expect(doc.roster[0]).not.toHaveProperty("chassis");
    const projIds = doc.snapshots.flatMap((s: any) => (s.projectiles ?? []).map((p: any) => String(p.id)));
    expect(projIds.length).toBeGreaterThan(0);
    expect(projIds.every((id: string) => /^p_\d+$/.test(id))).toBe(true);
    expect(allStrings(doc).filter((s) => /\b(veh|proj|mine)_\d+\b/.test(s))).toEqual([]);
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
