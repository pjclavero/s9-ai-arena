/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MA (proyección, PublicEntityId, privacidad del
 * equipamiento D-B1 = R2).
 *
 * En ROJO sobre el BASE_SHA f07ff6f (`contractIt("MA", …)` = it.fails). Son de CAJA NEGRA
 * sobre las salidas que existen hoy y que MA tiene que sustituir por la proyección:
 * snapshot público del motor (lo que reenvían spectator y broadcast), eventos públicos,
 * documento de replay público e índice proyectado (API), observación del bot y WELCOME.
 * Si MA cambia el NOMBRE del punto de salida (p. ej. retira `getPublicSnapshot()` por
 * `projectFrame()`), adapta aquí SÓLO la función `publicFrames()`/`publicDoc()` y anota el
 * cambio en su PR; las aserciones no se tocan.
 *
 * Contratos: packages/projection/contracts.ts (I1-I7, F1, P-1) y §3-§5 y §12 de
 * docs/technical/engine-v2-contracts.md.
 */
import { beforeAll, describe, expect } from "vitest";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { Battle } from "../../src/sim/battle.js";
import { initPhysics } from "../../src/sim/physics.js";
import { ProtocolServer } from "../../src/protocol-server.js";
import { emptyArena, gunnerLoadout, minerLoadout, scoutLoadout } from "../../src/fixtures.js";
import { IdleBot } from "../../src/stubs.js";
import { projectIndex, projectReplayDocument } from "../../../api/src/replay-projection.js";
import { effectOf } from "../../../../packages/module-catalog/effect-status.js";
import { ScriptBot, allKeys, allStrings, contractIt } from "../baseline/helpers.js";
import { recordReference } from "../baseline/reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

/** Patrón de id INTERNO del BASE_SHA: vehículos veh_N, proyectiles proj_N, minas mine_N. */
const INTERNAL_ID = /\b(veh|proj|mine)_\d+\b/;
/** Prefijo público permitido (PublicEntityPrefix) + número: `v_1`, `p_3`… */
const PUBLIC_ID = /^[vpdzc]_[0-9a-zA-Z]{1,16}$/;

/** Mismo guion que la baseline de ids, con o sin la mina oculta del tick 3. */
function idBattle(withMine: boolean) {
  const b = new Battle({
    battleId: "me_pids",
    seed: "me-pids",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
    map: emptyArena(200, 80),
    snapshotEveryNTicks: 1,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec: minerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
    ],
  });
  const aim = { turret: { targetHeading: Math.PI / 2 } };
  b.attachBot(
    "veh_1",
    new ScriptBot("b1", (t) => {
      if (t === 0 || t === 30) return { fire: ["turret_main"], ...aim };
      if (t === 3 && withMine) return { deployMine: { slot: "mine_bay" }, ...aim };
      return aim;
    }),
  );
  b.attachBot("veh_2", new IdleBot("b2"));
  for (let t = 0; t < 40; t++) b.step();
  const frames = b.snapshots; // = lo que el gateway reenvía (battle.snapshots) a spectator/broadcast
  const events = b.publicEvents;
  b.free();
  return { frames, events };
}

/** Ids de proyectil por orden de primera aparición en los frames públicos. */
function projectileIds(frames: any[]): string[] {
  return [...new Set(frames.flatMap((s: any) => (s.projectiles ?? []).map((p: any) => String(p.id))))];
}

describe("MA · PublicEntityId: ningún id interno sale (I1, F1)", () => {
  contractIt("MA", "los frames públicos (spectator/broadcast) no contienen ids internos veh_/proj_/mine_", () => {
    const { frames } = idBattle(true);
    const leaked = allStrings(frames).filter((s) => INTERNAL_ID.test(s));
    expect(leaked).toEqual([]);
  });

  contractIt("MA", "todo id de entidad en un frame público usa un prefijo de clase pública (v, p, d, z, c)", () => {
    const { frames } = idBattle(true);
    const ids = frames.flatMap((s: any) => [
      ...(s.vehicles ?? []).map((v: any) => String(v.id)),
      ...(s.projectiles ?? []).map((p: any) => String(p.id)),
    ]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id: string) => !PUBLIC_ID.test(id))).toEqual([]);
  });

  contractIt("MA", "el replay público proyectado y su índice no contienen ids internos", async () => {
    const r = await recordReference();
    const meta = { world: {}, roster: r.header.participants.map((p: any) => ({ id: p.id, botId: p.botId, team: p.team })) };
    const doc = projectReplayDocument(r, meta);
    const idx = projectIndex({ battleId: "me", ticks: r.result.ticks, snapshotCount: 1, keyframes: [], result: r.result }, meta);
    expect(allStrings(doc).filter((s) => INTERNAL_ID.test(s))).toEqual([]);
    expect(allStrings(idx).filter((s) => INTERNAL_ID.test(s))).toEqual([]);
  });

  contractIt("MA", "la observación del bot no entrega el id interno del vehículo detectado (espacio BotEntityRef)", () => {
    const map = emptyArena(200, 80);
    map.spawns = [
      { team: "red", position: { x: 40, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 55, y: 40 }, heading: Math.PI },
    ];
    const b = new Battle({
      battleId: "me_botids",
      seed: "me-botids",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    const obs: any[] = [];
    b.attachBot("veh_1", new ScriptBot("b1", (_t, o) => (obs.push(o), undefined)));
    b.attachBot("veh_2", new IdleBot("b2"));
    for (let t = 0; t < 10; t++) b.step();
    b.free();
    const contacts = obs.flatMap((o) => (o.sensors?.radar ?? []).flatMap((r: any) => r.contacts ?? []));
    expect(contacts.length).toBeGreaterThan(0); // control: el radar SÍ ve al rival
    expect(allStrings(contacts).filter((s) => s === "veh_2")).toEqual([]);
  });
});

describe("MA · ids densos por audiencia: lo oculto no consume número (I3, P-1, #261)", () => {
  contractIt("MA", "los ids públicos de proyectil son densos (sin huecos) aunque haya una mina oculta", () => {
    const ids = projectileIds(idBattle(true).frames);
    expect(ids).toHaveLength(2);
    const nums = ids.map((id) => Number(id.split("_")[1]));
    expect(nums[1] - nums[0]).toBe(1);
  });

  contractIt("MA", "una entidad no vista (mina) no consume id: la secuencia pública es la misma con y sin mina", () => {
    expect(projectileIds(idBattle(true).frames)).toEqual(projectileIds(idBattle(false).frames));
  });
});

/** Campos de equipamiento que R2 hace privados en toda salida pública. */
const EQUIPMENT_KEYS = ["hullHpMax", "modules", "chassis", "moduleId", "loadout", "spec", "specs"];

describe("MA · equipamiento privado (D-B1 = R2) en las salidas públicas", () => {
  contractIt("MA", "spectator/broadcast: los frames públicos no llevan hullHpMax, módulos ni chasis", () => {
    const keys = allKeys(idBattle(true).frames);
    expect(EQUIPMENT_KEYS.filter((k) => keys.has(k))).toEqual([]);
  });

  contractIt("MA", "replay público e índice: sin hullHpMax, módulos ni chasis en snapshots ni nómina", async () => {
    const r = await recordReference();
    const meta = {
      world: {},
      roster: r.header.participants.map((p: any) => ({ id: p.id, botId: p.botId, team: p.team, chassis: p.spec.chassisId })),
    };
    const keys = allKeys([projectReplayDocument(r, meta), projectIndex({ battleId: "me", result: r.result }, meta)]);
    expect(EQUIPMENT_KEYS.filter((k) => keys.has(k))).toEqual([]);
  });

  contractIt("MA", "WELCOME: specs sólo con campos ACTIVE o VALIDATION_ONLY (nunca FUTURE ni derivados)", async () => {
    const battle = await Battle.create({
      battleId: "me_welcome_c",
      seed: "me-welcome-c",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 60 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_w1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "bot_w2", team: "blue", spec: scoutLoadout() },
      ],
    });
    const expected = { botId: "bot_w1", vehicleId: "veh_1", battleToken: "t".repeat(16) };
    const server = new ProtocolServer({ battle, catalogVersion: "mvp@1", expected: [expected], port: 0 });
    let w: any;
    try {
      w = (server as any).buildWelcome(expected);
    } finally {
      server.stop();
      battle.free();
    }
    const bad: string[] = [];
    for (const m of w.vehicle.modules) {
      for (const [k, val] of Object.entries(m.specs ?? {})) {
        if (val === undefined) continue;
        const st = effectOf(m.category, k)?.status;
        if (st === "FUTURE") bad.push(`${m.category}.${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  contractIt("MA", "eventos públicos (replay y directo): ningún id interno ni campo de equipamiento", async () => {
    const r = await recordReference();
    // Control: la batalla de referencia produce eventos públicos (si no, el test es vacío).
    expect(r.events.length).toBeGreaterThan(0);
    const keys = allKeys(r.events);
    expect(allStrings(r.events).filter((s) => INTERNAL_ID.test(s))).toEqual([]);
    expect(EQUIPMENT_KEYS.filter((k) => keys.has(k))).toEqual([]);
  });
});
