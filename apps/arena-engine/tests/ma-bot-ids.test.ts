/**
 * OLA 2 · MA · Ids en el canal del bot: cada bot es su propia audiencia y ve `v_N`
 * (nunca `veh_N`/`proj_N`/`mine_N`), estables durante la batalla, y su COMMAND vuelve a
 * ids internos sólo si el destinatario es un id público suyo. Motor real, sin mocks.
 * Mutante de calibración: enviar la observación/WELCOME/EVENT sin traducir ⇒ rojo.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ProtocolServer } from "../src/protocol-server.js";
import { MODULES, emptyArena, scoutLoadout } from "../src/fixtures.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { BotIdBook, UNRESOLVED_RADIO_TARGET } from "../../../packages/projection/bot-ids.js";

beforeAll(async () => {
  await initPhysics();
});

const INTERNAL = /\b(veh|proj|mine)_[0-9a-zA-Z]+/;

function radarSpec(): VehicleSpec {
  const s = scoutLoadout();
  s.modules = [
    ...s.modules.filter((m) => m.slot !== "radio_a" && m.slot !== "sensor_b"),
    { ...MODULES.radio },
    { ...MODULES.radar },
  ];
  return s;
}

const PARTS = [
  { id: "veh_1", botId: "bot_a", team: "red" },
  { id: "veh_2", botId: "bot_b", team: "red" },
  { id: "veh_3", botId: "bot_c", team: "blue" },
  { id: "veh_4", botId: "bot_d", team: "blue" },
];
const bookFor = (observer: string, parts = PARTS, ids?: Record<string, string>) => {
  const map = (i: string) => ids?.[i] ?? i;
  const mine = parts.filter((p) => p.team === parts.find((q) => map(q.id) === map(observer))!.team);
  return new BotIdBook({
    battleId: "ma-bot-ids",
    observer: map(observer),
    team: mine.map((p) => ({ id: map(p.id), team: p.team, botId: p.botId })),
    allVehicleIds: parts.map((p) => map(p.id)),
  });
};

describe("BotIdBook · ids públicos del bot", () => {
  it("selfId y teammates son v_N; la numeración sólo depende del orden público (botId), no de los ids internos", () => {
    const a = bookFor("veh_1");
    const b = bookFor("veh_1", PARTS, { veh_1: "veh_9", veh_2: "veh_7", veh_3: "veh_5", veh_4: "veh_3" });
    expect(a.selfId()).toBe("v_1");
    expect(a.teammateIds()).toEqual(["v_2"]);
    expect([b.selfId(), b.teammateIds()]).toEqual([a.selfId(), a.teammateIds()]);
    // el otro bot del equipo: su numeración es la suya (cada uno es su audiencia), pero también sin veh_
    const c = bookFor("veh_2");
    expect(c.selfId()).toBe("v_2");
    expect(JSON.stringify([a.selfId(), a.teammateIds(), c.selfId(), c.teammateIds()])).not.toMatch(INTERNAL);
  });

  it("contactos de radar: entityId traducido, ESTABLE entre observaciones; empates por posición, no por orden interno", () => {
    const contact = (id: string, x: number, y: number) => ({ entityId: id, kind: "vehicle", position: { x, y } });
    const obs = (contacts: any[]) => ({ tick: 3, sensors: { radar: [{ slot: "sensor_b", contacts }] } });
    const A = bookFor("veh_1");
    const first = A.observation(obs([contact("veh_4", 50, 10), contact("veh_3", 40, 10)]));
    // veh_3 (x=40) se numera antes que veh_4 (x=50), venga en el orden que venga
    const B = bookFor("veh_1");
    const swapped = B.observation(obs([contact("veh_3", 40, 10), contact("veh_4", 50, 10)]));
    const byPos = (o: any) =>
      Object.fromEntries(o.sensors.radar[0].contacts.map((c: any) => [c.position.x, c.entityId]));
    expect(byPos(swapped)).toEqual(byPos(first));
    expect(byPos(first)).toEqual({ 40: "v_3", 50: "v_4" });
    // estabilidad: más tarde, el mismo rival conserva su id aunque el otro no se vea
    const later = A.observation(obs([contact("veh_4", 70, 20)]));
    expect(later.sensors.radar[0].contacts[0].entityId).toBe("v_4");
    expect(JSON.stringify([first, swapped, later])).not.toMatch(INTERNAL);
  });

  it("un eco sin entityId queda igual; un id que no es vehículo se omite (falla hacia menos información)", () => {
    const A = bookFor("veh_1");
    const o = A.observation({
      tick: 3,
      sensors: {
        radar: [
          {
            slot: "s",
            contacts: [
              { kind: "vehicle", position: { x: 1, y: 1 } },
              { entityId: "wall_n", position: { x: 2, y: 2 } },
            ],
          },
        ],
      },
    });
    expect(o.sensors.radar[0].contacts[0]).not.toHaveProperty("entityId");
    expect(o.sensors.radar[0].contacts[1]).not.toHaveProperty("entityId");
  });

  it("radio.from y eventos (sourceId/targetId) salen como v_N; un rival nunca visto recibe id al nombrarlo un evento público", () => {
    const A = bookFor("veh_1");
    const o = A.observation({ tick: 6, radio: [{ from: "veh_2", data: "AA==", sentTick: 3 }] });
    expect(o.radio[0].from).toBe("v_2");
    const ev = A.event({ tick: 6, kind: "vehicle_destroyed", targetId: "veh_4", position: { x: 5, y: 5 } });
    expect(ev.targetId).toBe("v_3");
    expect(A.event({ tick: 9, kind: "hit_dealt", targetId: "veh_4", damage: 1 }).targetId).toBe("v_3");
    expect(A.event({ tick: 9, kind: "flag_taken", sourceId: "veh_2", team: "blue" }).sourceId).toBe("v_2");
    expect(A.event({ tick: 9, kind: "hit_taken", sector: "front", damage: 1 })).toEqual({
      tick: 9,
      kind: "hit_taken",
      sector: "front",
      damage: 1,
    });
    expect(JSON.stringify([o, ev])).not.toMatch(INTERNAL);
  });

  it("COMMAND: radio.to sólo resuelve un id PÚBLICO conocido; un id interno o inventado no se entrega", () => {
    const A = bookFor("veh_1");
    const cmd = (to?: string) => ({ forTick: 3, radio: [{ slot: "radio_a", data: "AA==", ...(to ? { to } : {}) }] });
    expect(A.command(cmd("v_2")).radio[0].to).toBe("veh_2");
    expect(A.command(cmd("veh_2")).radio[0].to).toBe(UNRESOLVED_RADIO_TARGET); // el interno ya no vale
    expect(A.command(cmd("v_99")).radio[0].to).toBe(UNRESOLVED_RADIO_TARGET);
    expect(A.command(cmd()).radio[0]).not.toHaveProperty("to");
  });
});

// ------------------------------------------------------- motor real + WebSocket real
const servers: ProtocolServer[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const s of servers.splice(0)) s.stop();
});

describe("canal real del bot (ProtocolServer + WebSocket)", () => {
  it("WELCOME, OBSERVATION y EVENT recibidos NO contienen ningún id interno; sí hay contactos con v_N", async () => {
    const arena = emptyArena(120, 80);
    arena.spawns = [
      { team: "red", position: { x: 40, y: 40 }, heading: 0 },
      { team: "blue", position: { x: 52, y: 40 }, heading: Math.PI },
    ];
    const battle = await Battle.create({
      battleId: "ma-bot-ids-ws",
      seed: "ma-bot-ids-ws",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 90 }),
      map: arena,
      participants: [
        { id: "veh_1", botId: "bot_a", team: "red", spec: radarSpec() },
        { id: "veh_2", botId: "bot_b", team: "blue", spec: radarSpec() },
      ],
    });
    battle.attachBot("veh_2", { botId: "bot_b", decide: () => ({ forTick: 0 }) } as BotAgent);
    const server = new ProtocolServer({
      battle,
      catalogVersion: "mvp@1",
      expected: [{ botId: "bot_a", vehicleId: "veh_1", battleToken: "t".repeat(16) }],
      tickIntervalMs: 3,
      decisionDeadlineMs: 20,
    });
    servers.push(server);
    server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    sockets.push(ws);
    const msgs: any[] = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(String(raw))));
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(
      JSON.stringify({
        proto: "arena/1",
        type: "HELLO",
        seq: 0,
        payload: {
          botId: "bot_a",
          botVersion: "1",
          sdk: { name: "custom", version: "0" },
          battleToken: "t".repeat(16),
        },
      }),
    );
    await server.waitForResult();
    const welcome = msgs.find((m) => m.type === "WELCOME");
    expect(welcome.payload.selfId).toMatch(/^v_[0-9]+$/);
    const obsMsgs = msgs.filter((m) => m.type === "OBSERVATION");
    expect(obsMsgs.length).toBeGreaterThan(3);
    const contactIds = obsMsgs
      .flatMap((m) => (m.payload.sensors?.radar ?? []).flatMap((r: any) => r.contacts.map((c: any) => c.entityId)))
      .filter(Boolean);
    expect(contactIds.length, "control positivo: el radar vio al rival nítido").toBeGreaterThan(0);
    expect(new Set(contactIds).size).toBe(1); // estable
    for (const m of msgs) expect(JSON.stringify(m), `${m.type}`).not.toMatch(INTERNAL);
  }, 20000);
});
