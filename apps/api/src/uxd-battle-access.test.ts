/**
 * UX-D (G-08 · TD-047 · UX-06 · TD-065) · Matriz de autorización de las vistas de
 * una BATALLA: listado, detalle, estadísticas, auditoría, ticket de espectador y
 * /run, más los diagnósticos por bot.
 *
 * Expectativas escritas a partir de la POLÍTICA (battle-access.ts, que reutiliza
 * replay-access.ts), no del código. Antes de UX-D cualquier anónimo listaba y
 * leía batallas de bots privados (botId, versión, CPU, stats, auditoría) y
 * cualquier sesión obtenía ticket de espectador: todo esto estaba en ROJO.
 *
 * Actores: anónimo · dueño del bot privado (A) · ajeno (B) · dueño del bot
 * público rival (C) · organizer/admin (staff).
 * Batallas: priv (bot privado de A vs público de C) · pub (dos públicos de C) ·
 * live (en curso, sólo públicos) · sched (programada, bot privado de A).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";

let h: TestDbHandle;
let closed: Express; // sin capabilities públicas (defecto de producción)
let open: Express; // S9_PUBLIC_REPLAYS_ENABLED + S9_PUBLIC_SPECTATE_ENABLED
let catalogVersion: string;
const tok: Record<string, string> = {};
const B: Record<string, string> = {};
const BOT: Record<string, string> = {};

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@uxd.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newBot(ownerId: string, visibility: string, name: string): Promise<string> {
  const id = randomUUID();
  await h.db("bots").insert({ id, name, owner_id: ownerId, visibility });
  await h.db("bot_loadouts").insert({
    bot_id: id,
    revision: 1,
    catalog_version: catalogVersion,
    chassis: "chassis.scout@1",
    modules: JSON.stringify([]),
  });
  await h
    .db("bot_versions")
    .insert({ bot_id: id, version: 1, state: "published", runtime: "python", loadout_revision: 1 });
  return id;
}

async function newBattle(status: string, botIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status,
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: "uxd-secret-seed",
    ...(status === "finished"
      ? {
          result: JSON.stringify({
            schema: "battle-result/v1",
            winner: "A",
            ticks: 900,
            score: { A: 1, B: 0 },
            disqualified: [],
            endReason: "completed",
            agents: "container",
          }),
          finished_at: h.db.fn.now(),
          started_at: h.db.fn.now(),
        }
      : {}),
    ...extra,
  });
  let i = 0;
  for (const botId of botIds) {
    await h.db("participants").insert({
      battle_id: id,
      bot_id: botId,
      version: 1,
      team: i++ % 2 ? "B" : "A",
      outcome: status === "finished" ? (i === 1 ? "win" : "loss") : null,
      cpu_ms: status === "finished" ? 1234.5 : null,
    });
  }
  return id;
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  const quota = { max: 100_000, windowMs: 3600_000 };
  closed = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: false, publicSpectateEnabled: false });
  open = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: true, publicSpectateEnabled: true });

  const A = await newUser("uxd-owner-a");
  const Bu = await newUser("uxd-stranger-b");
  const C = await newUser("uxd-owner-c");
  tok.A = A.token;
  tok.B = Bu.token;
  tok.C = C.token;
  tok.organizer = await tokenFor(h.db, DEV_USERS.organizer);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);

  BOT.privA = await newBot(A.id, "private", "AUDIT-UXD-privado");
  BOT.pub1 = await newBot(C.id, "public", "AUDIT-UXD-publico-1");
  BOT.pub2 = await newBot(C.id, "public", "AUDIT-UXD-publico-2");

  B.priv = await newBattle("finished", [BOT.privA, BOT.pub1], { replay_ref: "/no/existe/priv.replay" });
  B.pub = await newBattle("finished", [BOT.pub1, BOT.pub2], { replay_ref: "/no/existe/pub.replay" });
  B.live = await newBattle("running", [BOT.pub1, BOT.pub2], { started_at: h.db.fn.now() });
  B.liveMixed = await newBattle("running", [BOT.privA, BOT.pub2], { started_at: h.db.fn.now() });
  B.sched = await newBattle("scheduled", [BOT.privA, BOT.pub2]);

  // Diagnóstico medido por el ejecutor + stats del replay del bot privado de A.
  await h
    .db("participants")
    .where({ battle_id: B.priv, bot_id: BOT.privA })
    .update({
      diagnostics: JSON.stringify({
        schema: "bot-diagnostics/v1",
        startup: { ok: true },
        protocol: {
          helloOk: true,
          helloTick: 0,
          reconnects: 0,
          commandsReceived: 290,
          invalidCommands: 7,
          firstInvalidReason: "/move/throttle maximum",
          invalidJson: 0,
          lateCommands: 3,
          wrongTickCommands: 0,
          extraCommands: 0,
          disconnectedAtTick: null,
        },
      }),
    });
  for (const botId of [BOT.privA, BOT.pub1]) {
    await h.db("battle_stats").insert({
      battle_id: B.priv,
      bot_id: botId,
      stats: JSON.stringify({
        botId,
        team: botId === BOT.privA ? "A" : "B",
        shotsFired: 10,
        shotsHit: 4,
        damageDealt: 120,
        decisionTimeouts: 2,
        decisions: 280,
        rejectionsByReason: { cooldown: 5, no_ammo: 1 },
        cpuMs: 1234.5,
        disqualified: false,
        perModule: {},
      }),
    });
  }
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

type Actor = "anon" | "A" | "B" | "C" | "organizer" | "admin";
const ACTORS: Actor[] = ["anon", "A", "B", "C", "organizer", "admin"];

function call(app: Express, actor: Actor, method: "get" | "post", path: string) {
  const r = method === "get" ? request(app).get(path) : request(app).post(path);
  return actor === "anon" ? r : r.set("Authorization", `Bearer ${tok[actor]}`);
}

/** Política esperada: quién LEE cada batalla (resto: 404 uniforme). */
const READERS: Record<"closed" | "open", Record<string, Actor[]>> = {
  closed: {
    priv: ["A", "C", "organizer", "admin"],
    pub: ["C", "organizer", "admin"],
    live: ["C", "organizer", "admin"],
    liveMixed: ["A", "C", "organizer", "admin"],
    sched: ["A", "C", "organizer", "admin"],
  },
  open: {
    priv: ["A", "C", "organizer", "admin"], // un bot privado mantiene privada la batalla
    pub: ACTORS, // terminada, sólo públicos, replays públicos
    live: ACTORS, // en curso, sólo públicos, directo público
    liveMixed: ["A", "C", "organizer", "admin"],
    sched: ["A", "C", "organizer", "admin"],
  },
};

const VIEWS: { name: string; method: "get" | "post"; path: (id: string) => string; ok: number }[] = [
  { name: "detalle", method: "get", path: (id) => `/battles/${id}`, ok: 200 },
  { name: "stats", method: "get", path: (id) => `/battles/${id}/stats`, ok: 200 },
  { name: "auditoría", method: "get", path: (id) => `/battles/${id}/audit`, ok: 200 },
];

describe("G-08 · una sola política de lectura para todas las vistas de una batalla", () => {
  for (const mode of ["closed", "open"] as const) {
    for (const battle of Object.keys(READERS[mode])) {
      for (const view of VIEWS) {
        it(`${mode} · ${battle} · ${view.name}: sólo los lectores de la política`, async () => {
          const app = mode === "closed" ? closed : open;
          for (const actor of ACTORS) {
            const r = await call(app, actor, view.method, view.path(B[battle]));
            const allowed = READERS[mode][battle].includes(actor);
            expect({ actor, status: r.status }).toEqual({ actor, status: allowed ? view.ok : 404 });
            if (!allowed) expect(r.body).toMatchObject({ error: "not_found", message: "Batalla no encontrada" });
            else expect(r.headers["cache-control"]).toBe("private, no-store");
          }
        });
      }
      it(`${mode} · ${battle} · listado: aparece sólo a sus lectores`, async () => {
        const app = mode === "closed" ? closed : open;
        for (const actor of ACTORS) {
          const r = await call(app, actor, "get", "/battles?limit=100");
          expect(r.status).toBe(200);
          expect(r.headers["cache-control"]).toBe("private, no-store");
          const ids = (r.body.items as { id: string }[]).map((b) => b.id);
          expect({ actor, listed: ids.includes(B[battle]) }).toEqual({
            actor,
            listed: READERS[mode][battle].includes(actor),
          });
        }
      });
    }
  }

  it("un id inexistente o no-UUID da el MISMO 404 que una batalla ajena", async () => {
    const a = await call(closed, "B", "get", `/battles/${randomUUID()}`);
    const b = await call(closed, "B", "get", `/battles/no-es-un-uuid`);
    const c = await call(closed, "B", "get", `/battles/${B.priv}`);
    const shape = (x: { status: number; body: Record<string, unknown> }) => ({
      status: x.status,
      error: x.body.error,
      message: x.body.message,
    });
    expect(shape(a)).toEqual({ status: 404, error: "not_found", message: "Batalla no encontrada" });
    expect(shape(b)).toEqual(shape(a));
    expect(shape(c)).toEqual(shape(a));
  });

  it("ticket de espectador: sesión ajena → 404 (antes 201); dueño y staff → 201", async () => {
    for (const actor of ["B"] as Actor[]) {
      expect((await call(closed, actor, "post", `/battles/${B.liveMixed}/spectate-ticket`)).status).toBe(404);
      expect((await call(open, actor, "post", `/battles/${B.liveMixed}/spectate-ticket`)).status).toBe(404);
    }
    expect((await call(open, "anon", "post", `/battles/${B.liveMixed}/spectate-ticket`)).status).toBe(404);
    expect((await call(open, "anon", "post", `/battles/${B.live}/spectate-ticket`)).status).toBe(201);
    expect((await call(closed, "anon", "post", `/battles/${B.live}/spectate-ticket`)).status).toBe(404);
    expect((await call(closed, "A", "post", `/battles/${B.liveMixed}/spectate-ticket`)).status).toBe(201);
    expect((await call(closed, "organizer", "post", `/battles/${B.liveMixed}/spectate-ticket`)).status).toBe(201);
  });

  it("/run de una batalla ajena: 404 (no se revela ni se toca); el dueño sí puede", async () => {
    expect((await call(closed, "B", "post", `/battles/${B.sched}/run`)).status).toBe(404);
    expect((await call(closed, "A", "post", `/battles/${B.sched}/run`)).status).toBe(202);
  });
});

describe("UX-06 · diagnóstico por bot: sólo el dueño de ESE bot y el staff", () => {
  it("el dueño ve el diagnóstico de SU bot (HELLO, comandos inválidos, rechazos, CPU), no el del rival", async () => {
    const r = await call(closed, "A", "get", `/battles/${B.priv}/stats`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(Object.keys(r.body.diagnostics)).toEqual([BOT.privA]);
    const d = r.body.diagnostics[BOT.privA];
    expect(d).toMatchObject({
      botName: "AUDIT-UXD-privado",
      measured: true,
      startup: { ok: true },
      hello: { ok: true, tick: 0 },
      decisions: 280,
      decisionTimeouts: 2,
      disqualified: false,
      commands: { received: 290, invalid: 7, firstInvalidReason: "/move/throttle maximum", late: 3 },
      rejectionsByReason: { cooldown: 5, no_ammo: 1 },
      cpuMs: 1234.5,
    });
    expect(typeof d.maxConsecutiveTimeouts).toBe("number");
    // El rival ve las stats deportivas del bot de A, sin CPU ni desglose de diagnóstico.
    const rc = await call(closed, "C", "get", `/battles/${B.priv}/stats`);
    expect(Object.keys(rc.body.diagnostics)).toEqual([BOT.pub1]);
    const sporting = rc.body.perBot[BOT.privA];
    expect(sporting).toMatchObject({ shotsFired: 10, shotsHit: 4, damageDealt: 120, botName: "AUDIT-UXD-privado" });
    expect(sporting.cpuMs).toBeUndefined();
    expect(sporting.rejectionsByReason).toBeUndefined();
    expect(sporting.decisions).toBeUndefined();
  });

  it("staff ve todos los diagnósticos; un lector público no ve ninguno", async () => {
    const s = await call(closed, "organizer", "get", `/battles/${B.priv}/stats`);
    expect(Object.keys(s.body.diagnostics).sort()).toEqual([BOT.privA, BOT.pub1].sort());
    const anon = await call(open, "anon", "get", `/battles/${B.pub}/stats`);
    expect(anon.status).toBe(200);
    expect(anon.body.diagnostics).toEqual({});
  });

  it("CPU por participante en el detalle: sólo para el dueño de ese bot y staff", async () => {
    const mine = await call(closed, "A", "get", `/battles/${B.priv}`);
    const pa = mine.body.participants.find((p: any) => p.botId === BOT.privA);
    const pc = mine.body.participants.find((p: any) => p.botId === BOT.pub1);
    expect(pa).toMatchObject({ botName: "AUDIT-UXD-privado", cpuMs: 1234.5, diagnosticsVisible: true });
    expect(pc).toMatchObject({ botName: "AUDIT-UXD-publico-1", cpuMs: null, diagnosticsVisible: false });
    expect(mine.body.mapName).toBeTruthy();
    const anon = await call(open, "anon", "get", `/battles/${B.pub}`);
    for (const p of anon.body.participants) expect(p.cpuMs).toBeNull();
  });
});

describe("TD-065 · stats justo tras finished: «pendiente», nunca vacías y cacheadas", () => {
  it("finished con replay y sin filas: status pending y no-store; en curso: pending; sin replay: unavailable", async () => {
    const r = await call(open, "anon", "get", `/battles/${B.pub}/stats`);
    expect(r.body).toMatchObject({ status: "pending", perBot: {} });
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect((await call(closed, "A", "get", `/battles/${B.sched}/stats`)).body.status).toBe("pending");
    const noReplay = await newBattle("finished", [BOT.pub1, BOT.pub2]);
    expect((await call(open, "anon", "get", `/battles/${noReplay}/stats`)).body.status).toBe("unavailable");
  });
});

describe("G-08 · el directo público sólo anuncia lo que un anónimo puede ver", () => {
  it("/public/battles/live lista la batalla de bots públicos, no la que tiene un bot privado", async () => {
    const r = await call(open, "anon", "get", "/public/battles/live");
    const ids = (r.body.battles as { id: string }[]).map((b) => b.id);
    expect(ids).toContain(B.live);
    expect(ids).not.toContain(B.liveMixed);
    expect((await call(open, "anon", "get", `/public/battles/${B.live}`)).status).toBe(200);
    expect((await call(open, "anon", "get", `/public/battles/${B.liveMixed}`)).status).toBe(404);
  });
});
