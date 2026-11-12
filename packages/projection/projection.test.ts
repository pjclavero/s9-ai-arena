/**
 * OLA 2 · MA · Gates PUBLIC_ENTITY_IDS y PRIVATE_EQUIPMENT (proyección pura) y CROSS_VIEW
 * de la clave de caché. Streams sintéticos con la forma EXACTA del frame interno.
 *
 * Cada `it` está calibrado con un mutante que lo pone rojo (ver informe MA):
 *  M1 id público = interno · M7 contador público compartido entre prefijos · M8 numerar por
 *  orden interno · M3 mapping compartido entre audiencias · M2 sin epoch en la clave ·
 *  MP política de equipamiento abierta.
 */
import { describe, expect, it } from "vitest";
import {
  AudiencePublicIdMapper,
  AudienceProjector,
  DEFAULT_DISCLOSURE_POLICY,
  ENTITY_ID_SCHEMA_RE,
  HULL_LEVEL_N,
  STATS_ACCURACY_N,
  STATS_HITS_STEP,
  ProjectionCache,
  VisibilityTracker,
  audienceKey,
  hullLevel,
  projectBotStats,
  projectReplayStream,
  projectWelcomeModule,
  projectionKeyString,
  type InternalFrame,
} from "./index.js";

const ROSTER = [
  { id: "veh_2", botId: "bot-b", team: "blue", chassis: "chassis.heavy@1", name: "Beta" },
  { id: "veh_1", botId: "bot-a", team: "red", chassis: "chassis.light@1", name: "Alfa" },
];

function veh(id: string, x: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    team: id === "veh_1" ? "red" : "blue",
    alive: true,
    position: { x, y: 10 },
    heading: 0.5,
    turretHeading: 1.25,
    hullHp: 300,
    hullHpMax: 400,
    carryingFlag: null,
    juggernaut: false,
    modules: [
      { slot: "turret_main", state: "operational" },
      { slot: "mine_bay", state: "operational" },
    ],
    ...extra,
  };
}

/**
 * Stream de #261: veh_1 dispara en cada frame y veh_2 siembra minas intercaladas. El
 * contador interno es COMPARTIDO (proj_0, mine_1, proj_2, mine_3…), como en el motor.
 */
function stream(withMines: boolean): InternalFrame[] {
  const frames: InternalFrame[] = [];
  let seq = 0;
  const projectiles: { id: string; position: { x: number; y: number } }[] = [];
  const mines: { id: string; kind: string; position: { x: number; y: number }; ownerId: string; team: string }[] = [];
  for (let t = 0; t < 8; t++) {
    projectiles.push({ id: `proj_${seq++}`, position: { x: 5 + t, y: 20 } });
    if (withMines && t % 2 === 0) {
      mines.push({ id: `mine_${seq++}`, kind: "mine", position: { x: 30, y: 30 + t }, ownerId: "veh_2", team: "blue" });
    } else if (!withMines && t % 2 === 0) {
      seq++; // el hueco del contador interno existe igual en el motor; aquí NO hay mina
    }
    frames.push({
      stage: "internal",
      battleId: "b-261",
      tick: t * 3,
      vehicles: [veh("veh_1", 1), veh("veh_2", 50)],
      projectiles: projectiles.map((p) => ({ ...p })),
      deployables: mines.map((m) => ({ ...m })),
      score: { red: 0, blue: 0 },
      objectives: [{ kind: "juggernaut", id: "veh_2", team: "blue", state: "held" }],
    });
  }
  return frames;
}

/** Todos los strings de una estructura (claves y valores), parseando, no contando texto. */
function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.push(k);
      strings(v, out);
    }
  return out;
}

function keysDeep(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) keysDeep(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysDeep(v, out);
    }
  return out;
}

const INTERNAL_ID = /^(veh|proj|mine)_\d+$/;

function projectAll(frames: InternalFrame[], aud = audienceKey("public_live"), relationOf?: (e: string) => any) {
  const pr = new AudienceProjector({ battleId: "b-261", audience: aud, roster: ROSTER, relationOf });
  const bodies = frames.map((f) => pr.project(f).body);
  const events = [
    { tick: 3, kind: "vehicle_destroyed", targetId: "veh_1", position: { x: 1, y: 1 } },
    { tick: 3, kind: "mine_triggered", position: { x: 30, y: 30 } },
    { tick: 3, kind: "flag_taken", team: "red", sourceId: "veh_2" },
    { tick: 3, kind: "hit_dealt", targetId: "veh_2", damage: 12.5 },
  ].map((e) => pr.projectEvent(e));
  const result = pr.projectResult({
    winner: "red",
    ticks: 21,
    score: { red: 1 },
    disqualified: ["veh_2"],
    versions: { engine: "x" },
  });
  return { pr, bodies, events, result, roster: pr.projectRoster() };
}

describe("PUBLIC_ENTITY_IDS · #261", () => {
  it("T-ID-1 · proyectiles densos p_1..p_n en orden de primera visibilidad; las minas ocultas no consumen id", () => {
    const { bodies } = projectAll(stream(true));
    const last = bodies.at(-1)!;
    expect(last.projectiles.map((p) => p.id)).toEqual(["p_1", "p_2", "p_3", "p_4", "p_5", "p_6", "p_7", "p_8"]);
    expect(last.deployables).toEqual([]);
  });

  it("T-ID-1 · diferencial: el mismo stream SIN minas da el MISMO flujo público byte a byte", () => {
    const a = projectAll(stream(true));
    const b = projectAll(stream(false));
    expect(JSON.stringify(a.bodies)).toBe(JSON.stringify(b.bodies));
    expect(a.pr.mappingId).toBe(b.pr.mappingId);
  });

  it("T-ID-2 · ningún id interno sale (frames, eventos, objetivos, resultado, nómina) y todo cabe en el esquema", () => {
    const { bodies, events, result, roster } = projectAll(stream(true));
    const all = strings({ bodies, events, result, roster });
    expect(all.filter((s) => INTERNAL_ID.test(s))).toEqual([]);
    for (const b of bodies) {
      for (const v of b.vehicles) expect(v.id).toMatch(ENTITY_ID_SCHEMA_RE);
      for (const p of b.projectiles) expect(p.id).toMatch(ENTITY_ID_SCHEMA_RE);
    }
    // hit_dealt es privado: no está en la lista blanca de eventos públicos.
    expect(events[3]).toBeNull();
    expect(result.disqualified).toEqual(["v_1"]);
    expect(result).not.toHaveProperty("versions");
  });

  it("T-ID-3 · coherencia: el mismo vehículo tiene el mismo id en frame, objetivo, evento, nómina y resultado", () => {
    const { bodies, events, roster, result } = projectAll(stream(true));
    // Nómina por orden PÚBLICO (bando, botId): blue/bot-b = v_1, red/bot-a = v_2.
    expect(roster.map((r) => [r.id, r.botId])).toEqual([
      ["v_1", "bot-b"],
      ["v_2", "bot-a"],
    ]);
    expect(bodies[0].objectives[0]).toMatchObject({ kind: "juggernaut", id: "v_1" });
    expect(events[0]).toMatchObject({ kind: "vehicle_destroyed", targetId: "v_2" });
    expect(events[2]).toMatchObject({ kind: "flag_taken", sourceId: "v_1" });
    expect(result.disqualified).toEqual(["v_1"]);
  });

  it("T-ID-4 · audiencias separadas: el dueño ve su mina (d_1) sin desplazar la numeración pública; mappingId distinto", () => {
    const pub = projectAll(stream(true));
    const owner = projectAll(stream(true), audienceKey("owner", "user-b"), (e) => (e === "veh_2" ? "owner" : "none"));
    expect(owner.bodies.at(-1)!.deployables.map((d) => d.id)).toEqual(["d_1", "d_2", "d_3", "d_4"]);
    expect(owner.bodies.at(-1)!.projectiles.map((p) => p.id)).toEqual(pub.bodies.at(-1)!.projectiles.map((p) => p.id));
    expect(owner.pr.mappingId).not.toBe(pub.pr.mappingId);
    const pubIds = new Set(strings(pub.bodies));
    expect(pubIds.has("d_1")).toBe(false);
  });

  it("T-ID-5 · fin de episodio: un id no se recicla y una reaparición recibe id nuevo", () => {
    const m = new AudiencePublicIdMapper({
      battleId: "b",
      audience: audienceKey("public_live"),
      projectionVersion: "t",
    });
    m.reveal([{ id: "proj_9", prefix: "p", x: 0, y: 0 }]);
    expect(m.toPublic("proj_9")).toBe("p_1");
    m.retire("proj_9");
    expect(m.toPublic("proj_9")).toBeUndefined();
    expect(m.fromPublic("p_1")).toBeUndefined();
    m.reveal([{ id: "proj_9", prefix: "p", x: 0, y: 0 }]);
    expect(m.toPublic("proj_9")).toBe("p_2");
  });

  it("T-ID-6 · empates en el frame por clave pública: permutar el orden interno no cambia la proyección", () => {
    const base = stream(true);
    const permuted = base.map((f) => ({ ...f, projectiles: [...f.projectiles].reverse() }));
    expect(JSON.stringify(projectAll(permuted).bodies)).toBe(JSON.stringify(projectAll(base).bodies));
    // Y la numeración de los que nacen a la vez sigue la posición, no el id interno.
    const pr = new AudienceProjector({ battleId: "b", audience: audienceKey("public_live"), roster: [] });
    const f = (ps: { id: string; position: { x: number; y: number } }[]): InternalFrame => ({
      stage: "internal",
      battleId: "b",
      tick: 0,
      vehicles: [],
      projectiles: ps,
      deployables: [],
      score: {},
      objectives: [],
    });
    const body = pr.project(
      f([
        { id: "proj_1", position: { x: 9, y: 0 } },
        { id: "proj_7", position: { x: 2, y: 0 } },
      ]),
    ).body;
    expect(body.projectiles).toEqual([
      { id: "p_1", position: { x: 2, y: 0 } },
      { id: "p_2", position: { x: 9, y: 0 } },
    ]);
  });

  it("T-ID-7 · determinismo e independencia de la semilla: el mappingId es función de (batalla, audiencia, versión)", () => {
    const a = projectAll(stream(true));
    const b = projectAll(stream(true));
    expect(JSON.stringify(a.bodies)).toBe(JSON.stringify(b.bodies));
    const m1 = new AudiencePublicIdMapper({
      battleId: "x",
      audience: audienceKey("public_live"),
      projectionVersion: "1",
    });
    const m2 = new AudiencePublicIdMapper({
      battleId: "x",
      audience: audienceKey("public_live"),
      projectionVersion: "1",
    });
    expect(m1.mappingId).toBe(m2.mappingId);
    expect(m1.mappingId).not.toBe(
      new AudiencePublicIdMapper({ battleId: "x", audience: audienceKey("broadcast"), projectionVersion: "1" })
        .mappingId,
    );
  });

  it("replay: un segmento usa los mismos ids que el stream completo", () => {
    const frames = stream(true);
    const full = projectReplayStream({
      battleId: "b-261",
      audience: audienceKey("public_replay"),
      roster: ROSTER,
      snapshots: frames,
      events: [],
    });
    const again = projectReplayStream({
      battleId: "b-261",
      audience: audienceKey("public_replay"),
      roster: ROSTER,
      snapshots: frames,
      events: [],
    });
    expect(full.snapshots[5]).toEqual(again.snapshots[5]);
    expect(full.snapshots[5].projectiles.map((p) => p.id)).toEqual(["p_1", "p_2", "p_3", "p_4", "p_5", "p_6"]);
  });

  it("ids de mapa: sólo por lista blanca; uno con forma de id público no pasa", () => {
    const m = new AudiencePublicIdMapper({
      battleId: "b",
      audience: audienceKey("public_live"),
      projectionVersion: "t",
      mapEntityIds: ["zone_a", "p_1"],
    });
    expect(m.ref("zone_a")).toBe("zone_a");
    expect(m.ref("p_1")).toBeUndefined();
    expect(m.ref("veh_1")).toBeUndefined();
  });
});

describe("PRIVATE_EQUIPMENT · R2 (D-B1)", () => {
  it("el frame público no lleva hullHp, hullHpMax ni módulos; sí hullLevel con N=20", () => {
    const { bodies } = projectAll(stream(true));
    const keys = keysDeep(bodies);
    for (const k of ["hullHp", "hullHpMax", "modules", "slot", "ownerId", "kind"]) {
      if (k === "kind") continue; // `kind` sí existe en objetivos (bandera/zona/juggernaut)
      expect(keys.has(k), k).toBe(false);
    }
    expect(bodies[0].vehicles.map((v) => v.hullLevel)).toEqual([15, 15]); // 300/400 · 20
    expect(HULL_LEVEL_N).toBe(20);
    expect(DEFAULT_DISCLOSURE_POLICY.regime).toBe("R2");
  });

  it("diferencial: cambiar sólo campos privados (loadout, casco máximo a igual fracción) no cambia el flujo público", () => {
    const a = stream(true);
    const b = a.map((f) => ({
      ...f,
      vehicles: f.vehicles.map((v) => ({
        ...v,
        hullHp: 600,
        hullHpMax: 800,
        modules: [{ slot: "armor_front", state: "damaged" }],
      })),
    }));
    expect(JSON.stringify(projectAll(b).bodies)).toBe(JSON.stringify(projectAll(a).bodies));
  });

  it("hullLevel: ceil(N·hp/max), 1 mínimo vivo, 0 destruido, nunca > N", () => {
    expect(hullLevel(400, 400)).toBe(20);
    expect(hullLevel(1, 400)).toBe(1);
    expect(hullLevel(0, 400)).toBe(0);
    expect(hullLevel(390, 400)).toBe(20);
    expect(hullLevel(380, 400)).toBe(19);
    expect(hullLevel(500, 400)).toBe(20);
    expect(hullLevel(10, 0)).toBe(0);
  });

  it("nómina pública sin chasis", () => {
    const { roster } = projectAll(stream(true));
    expect(keysDeep(roster).has("chassis")).toBe(false);
    expect(roster[0]).toEqual({ id: "v_1", botId: "bot-b", team: "blue", name: "Beta" });
  });

  it("getBattleStats: un tercero no recibe perModule, minas, radio, turnos sin responder ni el id interno", () => {
    const stats = {
      vehicleId: "veh_1",
      botId: "bot-a",
      team: "red",
      damageDealt: 50,
      shotsFired: 4,
      minesDeployed: 2,
      minesTriggered: 1,
      decisionTimeouts: 3,
      radio: { sent: 2, received: 0, receivedFromTeammates: 0, receivedFromEnemies: 0 },
      perModule: { turret_main: { moduleId: "weapon.cannon@1", uses: 4 } },
      somethingNew: 1,
    };
    const third = projectBotStats(stats, "public_replay");
    expect(Object.keys(third).sort()).toEqual(["botId", "damageDealt", "shotsFired", "team"]);
    const owner = projectBotStats(stats, "owner");
    expect(owner).toMatchObject({
      perModule: stats.perModule,
      minesDeployed: 2,
      radio: stats.radio,
      decisionTimeouts: 3,
    });
    expect(owner).not.toHaveProperty("vehicleId");
    expect(owner).not.toHaveProperty("somethingNew");
  });

  it("WELCOME: la ficha de un módulo propio no es el ModuleSpec entero (sin FUTURE ni campos no declarados)", () => {
    const spec = {
      slot: "turret_main",
      moduleId: "weapon.cannon@1",
      category: "weapon",
      hp: 80,
      massKg: 300,
      costCredits: 120,
      perActionEU: 5,
      damage: 25,
      cooldownTicks: 15,
      projectileSpeedMs: 40,
      spreadRad: 0.01,
      turretArcRad: 6.28,
      turretRateRads: 1.5,
      acceptsAmmo: ["ammo.standard"],
      rangeM: 60,
      internalDerived: 123,
    };
    const w = projectWelcomeModule(spec);
    expect(w.slot).toBe("turret_main");
    expect(w.moduleId).toBe("weapon.cannon@1");
    expect(w.specs).not.toHaveProperty("turretArcRad");
    expect(w.specs).not.toHaveProperty("rangeM");
    expect(w.specs).not.toHaveProperty("internalDerived");
    expect(w.specs).toMatchObject({ damage: 25, cooldownTicks: 15, perActionEU: 5, massKg: 300 });
  });
});

describe("CROSS_VIEW · clave de proyección con audiencia y visibilityEpoch", () => {
  function frameWith(mine: boolean): InternalFrame {
    return {
      stage: "internal",
      battleId: "b",
      tick: 3,
      vehicles: [veh("veh_1", 1)],
      projectiles: [],
      deployables: mine
        ? [{ id: "mine_4", kind: "mine", position: { x: 1, y: 1 }, ownerId: "veh_1", team: "red" }]
        : [],
      score: {},
      objectives: [],
    };
  }

  it("CV-1 · hidden → revealed cambia la clave y la caché sirve el estado NUEVO (no el pre-revelación)", () => {
    const owner = new AudienceProjector({
      battleId: "b",
      audience: audienceKey("owner", "u1"),
      roster: [{ id: "veh_1", botId: "a", team: "red" }],
      relationOf: (e) => (e === "veh_1" ? "owner" : "none"),
    });
    const cache = new ProjectionCache<string>();
    owner.advance(frameWith(false));
    const k1 = owner.key("*");
    const before = cache.getOrProject(k1, "tick3", () => "sin-mina");
    owner.advance(frameWith(true));
    const k2 = owner.key("*");
    expect(projectionKeyString(k2)).not.toBe(projectionKeyString(k1));
    const after = cache.getOrProject(k2, "tick3", () => "con-mina");
    expect(before).toBe("sin-mina");
    expect(after).toBe("con-mina");
  });

  it("CV-2/CV-5 · audiencias distintas (public_live, broadcast, owner) nunca comparten entrada; control SAME sí", () => {
    const mk = (aud: ReturnType<typeof audienceKey>) => {
      const p = new AudienceProjector({
        battleId: "b",
        audience: aud,
        roster: [{ id: "veh_1", botId: "a", team: "red" }],
      });
      p.advance(frameWith(false));
      return projectionKeyString(p.key("*"));
    };
    const live = mk(audienceKey("public_live"));
    expect(mk(audienceKey("public_live"))).toBe(live); // SAME
    expect(mk(audienceKey("broadcast"))).not.toBe(live);
    expect(mk(audienceKey("owner", "u1"))).not.toBe(live);
  });

  it("el epoch es del tracker (proyección): sube en cada cambio y nunca baja", () => {
    const t = new VisibilityTracker(audienceKey("public_live"));
    expect(t.set("x", "hidden", 0)).toBeNull(); // nunca visto: no existe
    t.set("x", "revealed", 1);
    const e1 = t.stateOf("x").epoch;
    t.set("x", "hidden", 2);
    t.set("x", "revealed", 3);
    expect(t.stateOf("x").epoch).toBeGreaterThan(e1);
    expect(t.digest()).not.toBe(new VisibilityTracker(audienceKey("public_live")).digest());
  });

  it("raw no es una audiencia proyectable", () => {
    expect(() => audienceKey("raw")).toThrow();
  });
});

describe("estadísticas públicas sin daño absoluto (M0)", () => {
  const stats = { botId: "bot-a", team: "red", damageDealt: 1234, damageTaken: 301, shotsFired: 77, shotsHit: 33, accuracy: 33 / 77, died: true, deaths: 1 };

  it("un tercero o equipo NO recibe damageDealt ni damageTaken (HP absolutos reconstruyen el casco); dueño y staff, exactos", () => {
    for (const aud of ["public_replay", "public_live", "broadcast", "team", "bot_team"] as const) {
      const t = projectBotStats(stats, aud);
      expect(t, aud).not.toHaveProperty("damageDealt");
      expect(t, aud).not.toHaveProperty("damageTaken");
      expect(t, aud).toMatchObject({ died: true, deaths: 1 }); // KO se indica
    }
    for (const aud of ["owner", "staff"] as const)
      expect(projectBotStats(stats, aud)).toMatchObject({ damageDealt: 1234, damageTaken: 301, shotsHit: 33 });
  });

  it("aciertos en pasos de STATS_HITS_STEP y precisión derivada de los aciertos cuantizados", () => {
    const t = projectBotStats(stats, "public_replay") as Record<string, number>;
    expect(t.shotsHit).toBe(Math.floor(33 / STATS_HITS_STEP) * STATS_HITS_STEP);
    expect(t.accuracy).toBe(Math.floor((t.shotsHit / 77) * STATS_ACCURACY_N) / STATS_ACCURACY_N);
    expect(t.shotsFired).toBe(77); // cadencia visible: residual, no se toca
    expect(t.accuracy).not.toBeCloseTo(33 / 77, 3);
    const a = projectBotStats({ ...stats, shotsHit: 31, accuracy: 31 / 77 }, "public_replay");
    const b = projectBotStats({ ...stats, shotsHit: 34, accuracy: 34 / 77 }, "public_replay");
    expect(a).toEqual(b);
  });

  it("sin disparos la precisión es null (no se inventa)", () => {
    const t = projectBotStats({ botId: "b", team: "r", shotsFired: 0, shotsHit: 0, accuracy: null }, "public_replay");
    expect(t.accuracy).toBeNull();
  });
});

describe("desempate público de la numeración (hallazgo P3-8)", () => {
  it("dos proyectiles que aparecen a la vez en el mismo punto se numeran por su rumbo público, no por el orden interno", () => {
    const mk = (order: [string, string]) => {
      const m = new AudiencePublicIdMapper({
        battleId: "b",
        audience: audienceKey("public_live"),
        projectionVersion: "t",
      });
      const cand = {
        proj_7: { id: "proj_7", prefix: "p" as const, x: 5, y: 5, tie: 0.5 },
        proj_9: { id: "proj_9", prefix: "p" as const, x: 5, y: 5, tie: 2.5 },
      };
      m.reveal(order.map((k) => cand[k as keyof typeof cand]));
      return [m.toPublic("proj_7"), m.toPublic("proj_9")];
    };
    expect(mk(["proj_7", "proj_9"])).toEqual(["p_1", "p_2"]);
    expect(mk(["proj_9", "proj_7"])).toEqual(["p_1", "p_2"]); // permutar el orden interno no cambia nada
    // permutar los IDS internos (mismos rumbos) tampoco: manda el rumbo
    const m = new AudiencePublicIdMapper({
      battleId: "b",
      audience: audienceKey("public_live"),
      projectionVersion: "t",
    });
    m.reveal([
      { id: "proj_1", prefix: "p", x: 5, y: 5, tie: 2.5 },
      { id: "proj_2", prefix: "p", x: 5, y: 5, tie: 0.5 },
    ]);
    expect([m.toPublic("proj_2"), m.toPublic("proj_1")]).toEqual(["p_1", "p_2"]);
  });
});
