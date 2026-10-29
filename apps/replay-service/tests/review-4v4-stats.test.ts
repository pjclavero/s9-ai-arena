/**
 * [REVIEW-4v4] · Stats 4v4 con el MOTOR REAL en lo que la suite del carril evita
 * («sin fuego amigo ni zonas»):
 *
 *  1. DEFECTO · Bajas por equipo ≠ marcador con zonas de daño. `stats.ts`
 *     atribuye una baja al autor del `hit_dealt` emitido JUSTO ANTES del
 *     `vehicle_destroyed`. En un mismo tick el motor resuelve proyectiles (PASO 5,
 *     battle.ts resolveProjectiles) y DESPUÉS el ácido (resolveZoneDamage): un
 *     golpe NO letal seguido de la muerte por ácido deja ese `hit_dealt` como
 *     emisión anterior ⇒ stats cuenta una baja que el motor no puntúa
 *     (`onKill(victim, null)`). mvp-arena-01 tiene ácido.
 *  2. Radio exacta contra la verdad de la batalla ORIGINAL (cola de radio y
 *     obs.radio), con todos hablando hasta el final, muertes y reapariciones,
 *     mensajes dirigidos y `no_radio`.
 *  3. Los ganchos no alteran el hash.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, resimulateWithEvents, type Replay } from "../../arena-engine/src/replay.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { MODULES, emptyArena, gunnerLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { computeBattleStats } from "../src/stats.js";

beforeAll(async () => {
  await initPhysics();
});

const ids = Array.from({ length: 8 }, (_, k) => `veh_${k + 1}`);
const teamOf = (id: string) => (Number(id.slice(4)) <= 4 ? "blue" : "red");
const b64 = (s: string) => Buffer.from(s).toString("base64");

async function acidBattle(seed: string): Promise<Replay> {
  const m = emptyArena(120, 80);
  m.zones.push({ id: "acid", position: { x: 60, y: 40 }, radiusM: 22, kind: "damage", damagePerSecond: 240 });
  const parts = ids.map((id) => ({ id, botId: `b_${id}`, team: teamOf(id), spec: gunnerLoadout() }));
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 2400, scoreToWin: 999 }),
      map: m,
      participants: parts,
    },
    (b) => {
      for (const p of parts) b.attachBot(p.id, new HunterBot(p.botId));
    },
  );
}

describe("[REVIEW-4v4] stats TDM 4v4 con ácido", () => {
  // REGRESIÓN (4v4-FIX): antes `it.fails`. stats.ts atribuía al golpe anterior una
  // muerte que causó la zona; ahora la autoría sale de `mode.onKill` vía el gancho.
  it(
    "perTeam.kills === marcador del motor con zona de daño (zk0)",
    async () => {
      const replay = await acidBattle("zk0");
      const s = await computeBattleStats(replay);
      for (const t of ["red", "blue"]) expect(s.perTeam[t].kills, t).toBe(replay.result.score[t] ?? 0);
    },
    120_000,
  );

  it("la trampa: muertes por ácido precedidas por un hit_dealt al mismo objetivo existen y no cuentan como baja (zk0)", async () => {
    const replay = await acidBattle("zk0");
    let prev: { e: any; to: string | null } | null = null;
    let zoneAfterHit = 0;
    let weaponKills = 0;
    await resimulateWithEvents(replay, () => {}, {
      onEmission: (e, to) => {
        if (to === null && e.kind === "vehicle_destroyed" && String(e.targetId).startsWith("veh_")) {
          if (prev?.to && prev.e.kind === "hit_dealt" && prev.e.targetId === e.targetId && prev.e.tick === e.tick)
            zoneAfterHit++;
        }
        if (e.kind === "score_changed") weaponKills++;
        prev = { e, to };
      },
    });
    const s = await computeBattleStats(replay);
    const statsKills = s.perTeam.red.kills + s.perTeam.blue.kills;
    const engine = (replay.result.score.red ?? 0) + (replay.result.score.blue ?? 0);
    // La trampa existe (zoneAfterHit > 0) y aun así stats cuenta sólo las letales,
    // como el motor (4v4-FIX; antes se fijaba statsKills > engine).
    expect(statsKills).toBe(engine);
    expect(weaponKills).toBe(engine);
    expect(zoneAfterHit).toBeGreaterThan(0);
  }, 120_000);
});

describe("[REVIEW-4v4] radio exacta contra la batalla original", () => {
  it("sent/received/fromTeammates/fromEnemies exactos; el rival oye; hooks sin efecto en el hash", async () => {
    const heard = new Map<string, { tm: number; en: number; all: number }>();
    const accepted = new Map<string, number>();
    class Talk {
      d = 0;
      inner: HunterBot;
      constructor(
        readonly botId: string,
        readonly vid: string,
      ) {
        this.inner = new HunterBot(botId);
      }
      decide(obs: any) {
        const h = heard.get(this.vid) ?? { tm: 0, en: 0, all: 0 };
        for (const m of obs.radio ?? []) {
          h.all++;
          if (teamOf(m.from) === teamOf(this.vid)) h.tm++;
          else h.en++;
        }
        heard.set(this.vid, h);
        const c: any = this.inner.decide(obs);
        const out: any[] = [{ slot: "radio_a", data: b64(`${this.vid}-${this.d}`) }];
        if (this.d % 7 === 0)
          out.push({ slot: "radio_a", data: b64("d"), to: this.vid === "veh_1" ? "veh_8" : "veh_1" });
        if (this.d % 11 === 0) out.push({ slot: "turret_main", data: b64("x") });
        c.radio = out;
        this.d++;
        return c;
      }
    }
    const parts = ids.map((id) => {
      const spec = gunnerLoadout();
      spec.modules = [...spec.modules, { ...MODULES.radio }];
      return { id, botId: `b_${id}`, team: teamOf(id), spec };
    });
    const replay = await record(
      {
        battleId: "rv-radio",
        seed: "rv-radio",
        ruleset: loadRuleset("tdm_mvp@1", {
          timeLimitTicks: 1800,
          scoreToWin: 999,
          respawn: { enabled: true, delayTicks: 60 },
        }),
        map: emptyArena(),
        participants: parts,
      },
      (b: any) => {
        const wrap = (q: any[]) => {
          const push = q.push.bind(q);
          q.push = (...msgs: any[]) => {
            for (const m of msgs) accepted.set(m.from, (accepted.get(m.from) ?? 0) + 1);
            return push(...msgs);
          };
          return q;
        };
        let cur = wrap(b.radioQueue);
        Object.defineProperty(b, "radioQueue", { get: () => cur, set: (v) => (cur = wrap(v)), configurable: true });
        for (const p of parts) b.attachBot(p.id, new Talk(p.botId, p.id));
      },
    );
    expect(replay.events.filter((e: any) => e.kind === "vehicle_destroyed").length).toBeGreaterThan(4);
    const s = await computeBattleStats(replay);
    for (const id of ids) {
      const r = s.perBot[id].radio; // perBot va por vehicleId
      const h = heard.get(id)!;
      expect(r.sent, `${id} sent`).toBe(accepted.get(id) ?? 0);
      expect(r.received, `${id} received`).toBe(h.all);
      expect(r.receivedFromTeammates, `${id} tm`).toBe(h.tm);
      expect(r.receivedFromEnemies, `${id} en`).toBe(h.en);
      expect(r.receivedFromEnemies).toBeGreaterThan(0); // contrato: el rival oye
    }
    const plain = await resimulateWithEvents(replay, () => {});
    const hooked = await resimulateWithEvents(replay, () => {}, {
      onObservation: (_v, o) => {
        (o as any).radio = [];
        (o as any).tick = -1;
      },
      onEmission: (e) => {
        (e as any).kind = "x";
      },
    });
    expect(hooked.finalStateHash).toBe(replay.result.finalStateHash);
    expect(plain.finalStateHash).toBe(replay.result.finalStateHash);
  }, 180_000);
});
