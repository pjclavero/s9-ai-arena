/**
 * PRE-1 · Replay CRUDO restringido + PROYECCIÓN PÚBLICA de competición.
 *
 * Expectativas escritas desde la POLÍTICA (docs/technical/replays.md §PRE-1 y
 * apps/api/src/replay-projection.ts), no desde el código:
 *  - LEER un replay (índice/segmentos) sigue la política de TD-004/VISIBILIDAD.
 *  - Recibir el CRUDO (fichero, índice de almacén, segmentos con comandos) exige
 *    moderator/admin o ser dueño de TODOS los bots participantes. Con el flag
 *    público activado o desactivado: el flag nunca concede el crudo.
 *  - Lo que recibe quien no tiene el crudo es la proyección: sin semilla, sin
 *    comandos, sin `radio[].data`, sin `deployMine`, sin `spec`, sin eventos
 *    privados (observaciones de un bot) y sin metadatos de almacén.
 *
 * El replay es REAL (motor E2) y está grabado con bots que SÍ mandan radio con
 * una carga marcada y despliegan minas: la calibración comprueba que el crudo
 * contiene todo eso (si no, la ausencia en la proyección no probaría nada).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { fromJsonl, record, verify, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, minerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { decompress } from "../../replay-service/src/format.js";
import {
  PUBLIC_EVENT_KINDS,
  PUBLIC_PROJECTION_FORMAT,
  projectEvents,
  projectIndex,
  projectReplayDocument,
  projectSegment,
  projectSnapshot,
} from "./replay-projection.js";
import { ReplayPlayer, httpReplaySource } from "../../web/src/viewer/replay-player.js";

const SEED = "PRE1-SEED-7f3a9c";
const RADIO_SECRET = "PRE1-RADIO-SECRET";

/** Bot que, además de cazar, habla por radio con una carga marcada. */
class RadioHunter extends HunterBot {
  decide(obs: any) {
    const c = (super.decide(obs) ?? {}) as Record<string, unknown>;
    return { ...c, radio: [{ slot: "radio_a", data: RADIO_SECRET }] };
  }
}
/**
 * Bot que, además de cazar, pide sembrar una mina al FINAL de la partida (tick >= SEED_MINE_FROM).
 * Antes pedía deployMine en cada decisión, pero el motor sólo lo procesaba si el comando traía
 * también `fire` (defecto, corregido en OLA 2: deployMine se procesa sin fire). Con el arreglo,
 * ese bot sembraba minas desde el tick 0 y, con la semilla fija, la partida cambiaba de
 * trayectoria: nadie moría ni había eventos en 900 ticks y el test dejaba de probar nada.
 * Sembrar sólo al final no puede alterar lo ocurrido antes (los ticks previos son idénticos a la
 * partida sin mina, causalidad), así que los eventos públicos de la partida siguen existiendo; el
 * crudo conserva `deployMine` y `mine.explosive@1`, que es lo que la calibración exige.
 */
const SEED_MINE_FROM = 880;
class MinerHunter extends HunterBot {
  decide(obs: any) {
    const c = (super.decide(obs) ?? {}) as Record<string, unknown>;
    if (obs.tick < SEED_MINE_FROM) return c;
    return { ...c, deployMine: { slot: "mine_bay", armDelayTicks: 0 } };
  }
}

let h: TestDbHandle;
let off: Express;
let on: Express;
let dir: string;
let base: Replay;
let catalogVersion: string;
const tok: Record<string, string> = {};
const B: Record<string, string> = {};
const rawFile: Record<string, string> = {};

type Actor = "anon" | "A" | "C" | "T" | "S" | "organizer" | "moderator" | "admin";
const ACTORS: Actor[] = ["anon", "A", "C", "T", "S", "organizer", "moderator", "admin"];
type BattleName = "solo" | "pub" | "bcast" | "team";
const BATTLES: BattleName[] = ["solo", "pub", "bcast", "team"];

async function newUser(label: string): Promise<{ id: string; token: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@pre1.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert({ user_id: u.id, role: "user" });
  return { id: u.id, token: await tokenFor(h.db, email) };
}

async function newBot(ownerId: string, visibility: string, teamId: string | null = null): Promise<string> {
  const id = randomUUID();
  await h.db("bots").insert({ id, name: `pre1-${id.slice(0, 8)}`, owner_id: ownerId, visibility, team_id: teamId });
  // participants(bot_id, version) referencia bot_versions: versión publicada con su loadout.
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

async function newBattle(botIds: string[], tournamentId: string | null = null, debugOpen = false): Promise<string> {
  const id = randomUUID();
  const header = {
    ...base.header,
    battleId: id,
    participants: base.header.participants.map((p: any, i: number) => ({ ...p, botId: botIds[i % botIds.length] })),
  };
  const stored = ingestReplay(dir, { ...base, header }, { official: false, debugOpen });
  rawFile[id] = stored.path;
  await h.db("battles").insert({
    id,
    status: "finished",
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    seed: SEED,
    tournament_id: tournamentId,
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: base.result.finalStateHash,
    result: JSON.stringify({ score: base.result.score, ticks: base.result.ticks }),
    finished_at: h.db.fn.now(),
  });
  let i = 0;
  for (const botId of botIds) {
    await h.db("participants").insert({ battle_id: id, bot_id: botId, version: 1, team: i++ % 2 ? "B" : "A" });
  }
  return id;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  catalogVersion = (await h.db("catalog_versions").first()).catalog_version;
  const quota = { max: 100_000, windowMs: 3600_000 };
  off = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: false });
  on = createApp({ db: h.db, anonQuota: quota, publicReplaysEnabled: true });
  dir = mkdtempSync(join(tmpdir(), "pre1-replays-"));
  base = await record(
    {
      battleId: "pre1-base",
      seed: SEED,
      // Arena pequeña, 900 ticks y dos artilleros: hay destrucciones y cambios de marcador
      // (eventos públicos que el visor debe recibir); sin ellos la comprobación de eventos
      // del visor y la de la lista blanca no probarían nada.
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 900 }),
      map: emptyArena(40, 30),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: scoutLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: minerLoadout() },
        { id: "v_green", botId: "bot_red", team: "green", spec: gunnerLoadout() },
        { id: "v_yellow", botId: "bot_blue", team: "yellow", spec: gunnerLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new RadioHunter("bot_red"));
      b.attachBot("v_blue", new MinerHunter("bot_blue"));
      b.attachBot("v_green", new HunterBot("bot_red"));
      b.attachBot("v_yellow", new HunterBot("bot_blue"));
    },
  );

  const A = await newUser("owner-a");
  const C = await newUser("owner-c");
  const T = await newUser("team-t");
  const S = await newUser("stranger-s");
  Object.assign(tok, { A: A.token, C: C.token, T: T.token, S: S.token });
  tok.organizer = await tokenFor(h.db, DEV_USERS.organizer);
  tok.moderator = await tokenFor(h.db, DEV_USERS.moderator);
  tok.admin = await tokenFor(h.db, DEV_USERS.admin);

  const [team] = await h
    .db("teams")
    .insert({ name: `pre1-${randomUUID().slice(0, 8)}`, captain_id: C.id })
    .returning("id");
  for (const uid of [C.id, T.id]) {
    await h.db("team_members").insert({ team_id: team.id, user_id: uid, role: uid === C.id ? "captain" : "member" });
  }
  const tb = await request(on)
    .post("/tournaments")
    .set("Authorization", `Bearer ${tok.organizer}`)
    .send({
      name: `pre1-tb-${randomUUID().slice(0, 6)}`,
      format: "round_robin",
      mode: "deathmatch",
      rulesetId: DEFAULT_RULESET_ID,
      broadcast: true,
    });
  expect(tb.status).toBe(201);

  B.solo = await newBattle([await newBot(A.id, "public"), await newBot(A.id, "private")]);
  B.pub = await newBattle([await newBot(A.id, "public"), await newBot(C.id, "public")]);
  B.bcast = await newBattle([await newBot(A.id, "private"), await newBot(C.id, "public")], tb.body.id);
  B.team = await newBattle([await newBot(C.id, "team", team.id), await newBot(A.id, "public")]);
  // Depuración abierta en el almacén (el dueño «abrió las capas»): los comandos crudos
  // siguen siendo crudo y la proyección NO los entrega, ni con el flag activado.
  B.dbg = await newBattle([await newBot(A.id, "public"), await newBot(C.id, "public")], null, true);
}, 240_000);

afterAll(async () => {
  await h?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- política esperada
/** Quién LEE (TD-004 + VISIBILIDAD, sin cambios en PRE-1). */
const READ: Record<"off" | "on", Record<BattleName, Actor[]>> = {
  off: {
    solo: ["A", "organizer", "moderator", "admin"],
    pub: ["A", "C", "organizer", "moderator", "admin"],
    bcast: ["A", "C", "organizer", "moderator", "admin"],
    team: ["A", "C", "T", "organizer", "moderator", "admin"],
  },
  on: {
    solo: ["A", "organizer", "moderator", "admin"], // bot privado, sin torneo ⇒ no público
    pub: ACTORS,
    bcast: ACTORS, // torneo retransmitido: se MUESTRA (proyección), no se entrega el crudo
    team: ["A", "C", "T", "organizer", "moderator", "admin"],
  },
};
/** Quién recibe el CRUDO (PRE-1): moderator/admin y el dueño de TODOS los participantes. Igual con flag on/off. */
const RAW: Record<BattleName, Actor[]> = {
  solo: ["A", "moderator", "admin"],
  pub: ["moderator", "admin"],
  bcast: ["moderator", "admin"],
  team: ["moderator", "admin"],
};

function get(app: Express, actor: Actor, path: string) {
  const r = request(app).get(path);
  return actor === "anon" ? r : r.set("Authorization", `Bearer ${tok[actor]}`);
}
function getBinary(app: Express, actor: Actor, path: string) {
  return get(app, actor, path)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

/** Todas las claves de un JSON, a cualquier profundidad. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}
const FORBIDDEN_KEYS = ["seed", "commands", "command", "radio", "data", "deployMine", "spec", "stateHashes", "ruleset"];
const FORBIDDEN_TEXT = [
  SEED,
  RADIO_SECRET,
  "deployMine",
  "mine.explosive@1", // loadout (spec) del minador
  "radio.short@1", // loadout (spec) del explorador
  "sensor.lidar_front@1",
  '"hit_taken"', // eventos privados (observación de un bot)
  '"hit_dealt"',
  '"mine_deployed"',
  '"radio_dropped"',
  '"rejected_action"',
  '"sha256"', // metadatos de almacén
  '"expiresAt"',
  '"mapChecksum"',
  "replay_ref",
  dirMarker(),
];
function dirMarker(): string {
  return "pre1-replays-"; // ruta interna del almacén
}

/** Afirma que un cuerpo es una proyección limpia. */
function assertClean(label: string, body: unknown) {
  const text = JSON.stringify(body);
  const keys = keysDeep(body);
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${label}: clave «${k}»`).toBe(false);
  for (const t of FORBIDDEN_TEXT) expect(text, `${label}: contiene «${t}»`).not.toContain(t);
}

/** Lo que un anónimo puede reunir de una batalla con el flag activado: índice, TODOS los segmentos y la descarga. */
async function anonHarvest(battleId: string) {
  const index = await get(on, "anon", `/replays/${battleId}/index`);
  const seg = await get(on, "anon", `/replays/${battleId}/segment?fromTick=0&toTick=${index.body.ticks}`);
  const dl = await get(on, "anon", `/public/replays/${battleId}/download`);
  return { index, seg, dl };
}

// =================================================================== calibración
describe("PRE-1 · calibración: el CRUDO contiene lo que la proyección debe quitar", () => {
  it("el fichero grabado lleva semilla, radio con carga, minas, spec y eventos privados no", () => {
    const text = decompress(readFileSync(rawFile[B.pub])).toString("utf8");
    expect(text).toContain(SEED);
    expect(text).toContain(RADIO_SECRET);
    expect(text).toContain("deployMine");
    expect(text).toContain("mine.explosive@1");
    const replay = fromJsonl(text);
    expect(replay.commands.length).toBeGreaterThan(10);
    expect(replay.commands.some((c) => Array.isArray(c.command?.radio))).toBe(true);
    expect(replay.commands.some((c) => c.command?.deployMine)).toBe(true);
    expect(replay.snapshots.length).toBeGreaterThan(5);
    // y eventos públicos reales (si no, «el visor recibe todos los eventos» sería 0 = 0)
    expect(replay.events.filter((e: any) => PUBLIC_EVENT_KINDS.has(e.kind)).length).toBeGreaterThan(0);
  });

  it("un actor con crudo recibe exactamente esos bytes (moderator, flag on y off)", async () => {
    for (const app of [on, off]) {
      const r = await getBinary(app, "moderator", `/replays/${B.pub}`);
      expect(r.status).toBe(200);
      expect(Buffer.compare(r.body as Buffer, readFileSync(rawFile[B.pub]))).toBe(0);
    }
  });
});

// ======================================================= matriz actor × batalla × recurso
describe("PRE-1 · matriz actor × batalla × recurso × flag", () => {
  for (const flag of ["off", "on"] as const) {
    for (const battle of BATTLES) {
      for (const actor of ACTORS) {
        const reads = READ[flag][battle].includes(actor);
        const raw = reads && RAW[battle].includes(actor);
        const label = `flag ${flag} · ${battle} · ${actor} ⇒ ${raw ? "CRUDO" : reads ? "PROYECCIÓN" : "404"}`;
        it(label, async () => {
          const app = flag === "on" ? on : off;
          const id = B[battle];
          // Fichero: sólo con crudo; en otro caso, 404 IDÉNTICO al de un id inexistente.
          const file = await getBinary(app, actor, `/replays/${id}`);
          expect(file.status, `file ${label}`).toBe(raw ? 200 : 404);
          if (!raw) {
            const missing = await get(app, actor, `/replays/${randomUUID()}`);
            const fileJson = JSON.parse((file.body as Buffer).toString("utf8"));
            expect({ e: fileJson.error, m: fileJson.message }).toEqual({
              e: missing.body.error,
              m: missing.body.message,
            });
          }
          // Índice y segmento: lectura según la política; representación según el crudo.
          const index = await get(app, actor, `/replays/${id}/index`);
          const seg = await get(app, actor, `/replays/${id}/segment?fromTick=0&toTick=1000`);
          expect(index.status, `index ${label}`).toBe(reads ? 200 : 404);
          expect(seg.status, `segment ${label}`).toBe(reads ? 200 : 404);
          if (reads) {
            expect(index.headers["cache-control"]).toBe("private, no-store");
            expect(index.body.battleId).toBe(id);
            expect(seg.body.snapshots.length).toBeGreaterThan(0);
            if (raw) {
              expect(index.body.sha256, "índice de almacén").toMatch(/^[0-9a-f]{64}$/);
              expect(index.body.projection).toBeUndefined();
            } else {
              expect(index.body.projection).toBe(PUBLIC_PROJECTION_FORMAT);
              expect(seg.body.projection).toBe(PUBLIC_PROJECTION_FORMAT);
              assertClean(`index ${label}`, index.body);
              assertClean(`segment ${label}`, seg.body);
            }
          }
          // Verificación: misma política de LECTURA (sólo devuelve booleano y hashes).
          const v = await request(app)
            .post(`/replays/${id}/verify`)
            .set(actor === "anon" ? {} : { Authorization: `Bearer ${tok[actor]}` });
          expect(v.status, `verify ${label}`).toBe(reads ? 200 : 404);
          if (reads) assertClean(`verify ${label}`, v.body);
        });
      }
    }
  }
});

describe("PRE-1 · descarga pública: siempre la proyección, nunca el crudo", () => {
  it("flag on: bPub y bBroadcast ⇒ 200 JSON proyectado; solo/team ⇒ 404", async () => {
    for (const battle of ["pub", "bcast"] as const) {
      const r = await getBinary(on, "anon", `/public/replays/${B[battle]}/download`);
      expect(r.status, battle).toBe(200);
      expect(String(r.headers["content-type"])).toMatch(/application\/json/);
      expect(Buffer.compare(r.body as Buffer, readFileSync(rawFile[B[battle]]))).not.toBe(0);
      const doc = JSON.parse((r.body as Buffer).toString("utf8"));
      expect(doc.projection).toBe(PUBLIC_PROJECTION_FORMAT);
      expect(doc.snapshots.length).toBe(base.snapshots.length);
      assertClean(`download ${battle}`, doc);
    }
    for (const battle of ["solo", "team"] as const) {
      expect((await get(on, "anon", `/public/replays/${B[battle]}/download`)).status, battle).toBe(404);
    }
  });

  it("flag on: ni un admin recibe el crudo por la ruta pública", async () => {
    const r = await getBinary(on, "admin", `/public/replays/${B.pub}/download`);
    expect(r.status).toBe(200);
    assertClean("download admin", JSON.parse((r.body as Buffer).toString("utf8")));
  });

  it("flag off: 404 para todos", async () => {
    for (const actor of ACTORS) {
      expect((await get(off, actor, `/public/replays/${B.pub}/download`)).status, actor).toBe(404);
    }
  });
});

// ============================================================== no-fuga por inferencia
describe("PRE-1 · no-fuga por inferencia: con lo que recibe un anónimo no se re-simula la batalla", () => {
  it("ni semilla ni comandos en nada de lo que reúne; un atacante con TODO lo demás no reproduce el hash", async () => {
    const { index, seg, dl } = await anonHarvest(B.bcast);
    expect([index.status, seg.status, dl.status]).toEqual([200, 200, 200]);
    for (const [label, body] of [
      ["index", index.body],
      ["segment", seg.body],
      ["download", dl.body],
    ] as const) {
      assertClean(label, body);
    }
    const officialHash = dl.body.result.finalStateHash;
    expect(officialHash).toBe(base.result.finalStateHash);

    // Atacante GENEROSO: conoce reglas, mapa y loadouts exactos (no los publica la
    // proyección); le faltan la semilla y los comandos, que no recibe.
    const attempt = (seed: string, commands: Replay["commands"]): Replay => ({
      ...base,
      header: { ...base.header, seed },
      commands,
      stateHashes: [],
    });
    const guessSeeds = ["", String(dl.body.battleId), "0"];
    for (const s of guessSeeds) {
      const r = await verify(attempt(s, []));
      expect(r.recomputedHash, `semilla adivinada «${s}» sin comandos`).not.toBe(officialHash);
    }
    // Calibración: CON la semilla y los comandos del crudo, la re-simulación cuadra.
    const ok = await verify(attempt(base.header.seed, base.commands));
    expect(ok.recomputedHash).toBe(officialHash);
  }, 120_000);
});

// ================================================================= visor con la proyección
describe("PRE-1 · el visor de replays funciona con la proyección (anónimo, flag on)", () => {
  it("ReplayPlayer real contra la API: carga, salta y llega al final con el marcador oficial", async () => {
    const fetchImpl = async (url: string) => {
      const r = await request(on).get(url);
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    };
    const player = new ReplayPlayer(httpReplaySource("", B.bcast, fetchImpl));
    await player.init(0);
    expect(player.index!.ticks).toBe(base.result.ticks);
    expect(player.debugOpen).toBe(false);
    expect(player.index!.world?.widthM).toBeGreaterThan(0);
    expect(player.index!.roster?.length).toBe(base.header.participants.length);
    // Salto temporal por keyframe y reproducción hasta el final a 8×.
    await player.seekTick(Math.floor(base.result.ticks / 2));
    expect(Math.abs(player.currentTick - Math.floor(base.result.ticks / 2))).toBeLessThanOrEqual(1);
    await player.seekTick(0);
    player.setSpeed(8);
    player.play();
    let last: any = null;
    const seen: any[] = [];
    for (let i = 0; i < 2000 && !player.finished; i++) {
      const a = await player.advance(50);
      last = a.snapshot;
      seen.push(...a.events);
    }
    expect(player.finished).toBe(true);
    expect(last.score).toEqual(base.result.score);
    // Lo que pinta el visor con la proyección es EXACTAMENTE el snapshot público del motor.
    const lastRaw = base.snapshots[base.snapshots.length - 1];
    expect(last).toEqual(JSON.parse(JSON.stringify(lastRaw)));
    // Y los eventos públicos del motor llegan todos.
    expect(seen.length).toBe(base.events.filter((e) => PUBLIC_EVENT_KINDS.has(e.kind)).length);
  }, 120_000);

  it("la proyección de snapshots es SIN PÉRDIDA para el visor (deriva del motor ⇒ rojo)", async () => {
    const r = await get(on, "anon", `/replays/${B.pub}/segment?fromTick=0&toTick=${base.result.ticks}`);
    expect(r.status).toBe(200);
    expect(r.body.snapshots).toEqual(JSON.parse(JSON.stringify(base.snapshots)));
  });

  it("todo evento público que emite el motor está en la lista blanca (un tipo nuevo ⇒ rojo, se decide a propósito)", () => {
    const kinds = new Set(base.events.map((e: any) => String(e.kind)));
    expect(kinds.size).toBeGreaterThan(0);
    for (const k of kinds) expect(PUBLIC_EVENT_KINDS.has(k), k).toBe(true);
  });
});

// ======================================================= depuración abierta (debugOpen)
describe("PRE-1 · `debugOpen` no abre los comandos a quien no tiene el crudo", () => {
  it("calibración: con depuración abierta, el moderator recibe los comandos crudos con la radio", async () => {
    const seg = await get(on, "moderator", `/replays/${B.dbg}/segment?fromTick=0&toTick=${base.result.ticks}`);
    expect(seg.status).toBe(200);
    expect(Array.isArray(seg.body.commands)).toBe(true);
    expect(JSON.stringify(seg.body.commands)).toContain(RADIO_SECRET);
    const index = await get(on, "moderator", `/replays/${B.dbg}/index`);
    expect(index.body.debugOpen).toBe(true);
  });

  for (const actor of ["anon", "S", "A", "C", "organizer"] as const) {
    it(`flag on · ${actor}: índice con debugOpen=false y segmento sin comandos`, async () => {
      const index = await get(on, actor, `/replays/${B.dbg}/index`);
      const seg = await get(on, actor, `/replays/${B.dbg}/segment?fromTick=0&toTick=${base.result.ticks}`);
      expect([index.status, seg.status]).toEqual([200, 200]);
      expect(index.body.debugOpen).toBe(false);
      expect(seg.body.commands).toBeUndefined();
      assertClean(`index dbg ${actor}`, index.body);
      assertClean(`segment dbg ${actor}`, seg.body);
    });
  }
});

// ===================================================== proyección pura (red de seguridad)
describe("PRE-1 · proyección pura: lista blanca + saneado a cualquier profundidad", () => {
  /** Entrada HOSTIL: lo prohibido metido en cada sitio por el que podría colarse. */
  const hostile = {
    battleId: "b1",
    seed: SEED,
    fromKeyframeTick: 0,
    commands: [
      { tick: 1, vehicleId: "v", command: { radio: [{ slot: "radio_a", data: RADIO_SECRET }], deployMine: {} } },
    ],
    snapshots: [
      {
        tick: 1,
        seed: SEED,
        vehicles: [
          {
            id: "v",
            team: "red",
            alive: true,
            position: { x: 1, y: 2, data: RADIO_SECRET },
            spec: { modules: ["mine.explosive@1"] },
            radio: [{ data: RADIO_SECRET }],
          },
        ],
        projectiles: [],
        score: { red: 1 },
        objectives: [{ id: "zone", owner: "red", radio: [{ data: RADIO_SECRET }], seed: SEED }],
        observations: { v: { enemies: [] } },
      },
    ],
    events: [
      // tipo público con carga prohibida anidada
      { tick: 1, kind: "score_changed", team: "red", radio: [{ data: RADIO_SECRET }], extra: { seed: SEED, spec: {} } },
      // tipos PRIVADOS (observación de un bot): no salen
      { tick: 1, kind: "hit_taken", vehicleId: "v" },
      { tick: 1, kind: "mine_deployed", vehicleId: "v" },
      { tick: 1, kind: "radio_dropped", vehicleId: "v" },
    ],
  };

  it("projectSegment: sin comandos, sin radio.data, sin semilla, sin spec, sin eventos privados", () => {
    const out = projectSegment(hostile);
    assertClean("segment hostil", out);
    expect((out.events as any[]).map((e) => e.kind)).toEqual(["score_changed"]);
    expect((out.snapshots as any[])[0].objectives).toEqual([{ id: "zone", owner: "red" }]);
  });

  it("projectEvents: un tipo público con radio/semilla/spec anidados sale saneado", () => {
    const [e] = projectEvents(hostile.events);
    expect(e).toEqual({ tick: 1, kind: "score_changed", team: "red", extra: {} });
  });

  it("projectSnapshot: lista blanca por vehículo (ni radio, ni spec, ni carga en la posición)", () => {
    const s = projectSnapshot(hostile.snapshots[0]);
    expect(JSON.stringify(s)).not.toContain(RADIO_SECRET);
    expect((s.vehicles as any[])[0].position).toEqual({ x: 1, y: 2 });
    expect(s).not.toHaveProperty("observations");
  });

  it("projectIndex y projectReplayDocument: sin almacén ni receta, debugOpen siempre false", () => {
    const idx = projectIndex(
      {
        battleId: "b1",
        ticks: 10,
        snapshotCount: 1,
        keyframes: [{ tick: 0, snapshotIndex: 0, offset: 99 }],
        sha256: "f".repeat(64),
        algo: "gzip",
        expiresAt: "2026-12-01T00:00:00Z",
        mapChecksum: "x",
        debugOpen: true,
        result: { winner: "red", ticks: 10, score: { red: 1 }, seed: SEED },
      },
      { world: { widthM: 10, heightM: 10, seed: SEED }, roster: [{ id: "v", botId: "b", team: "red" }] },
    );
    assertClean("index hostil", idx);
    expect(idx.debugOpen).toBe(false);
    const doc = projectReplayDocument(
      {
        header: { battleId: "b1", seed: SEED, participants: [{ spec: { modules: ["mine.explosive@1"] } }] },
        events: hostile.events,
        snapshots: hostile.snapshots,
        result: { winner: "red", ticks: 10, score: { red: 1 } },
      },
      null,
    );
    assertClean("documento hostil", doc);
    expect(doc).not.toHaveProperty("participants");
  });
});
