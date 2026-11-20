/**
 * V1 · TD-068 · D-OP-6 · `GET /bots` filtra la visibilidad EN SQL (`whereBotVisible`).
 *
 * Garantías (cada una con su test):
 *  G1 · ningún bot privado ajeno aparece en items ni en el cursor (el cursor es el del último ELEMENTO
 *       VISIBLE de la página: su id y su instante son los de un bot que el solicitante ya ve);
 *  G2 · con 2300 bots (casi todos privados ajenos) intercalados con públicos, la paginación completa
 *       devuelve EXACTAMENTE el conjunto visible, sin duplicados ni saltos, con varios tamaños de página;
 *  G3 · no hay páginas vacías artificiales (toda página salvo la última sale con `limit` elementos);
 *  G4 · contrato estable: cursor v2 `{v,t,k}` en claro como el de main, `nextCursor` ausente al agotar;
 *  G5 · coherencia con `canSeeBot` (la ficha): para cada rol, el listado devuelve lo mismo que filtrar
 *       todas las filas con `canSeeBot`; en particular el moderador ve todo y el organizador NO (la regla
 *       de replays `isReplayStaff` es otra, a propósito).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";
import { canSeeBot, type Auth } from "./services/bots.js";
import { ROLE_RANK } from "./openapi.js";

let h: TestDbHandle;
let app: Express;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
}, 120000);

afterAll(async () => {
  await h.stop();
});

type U = { id: string; token: string; roles: string[] };
async function newUser(label: string, roles: string[] = ["user", "developer"]): Promise<U> {
  const email = `${label}-${randomUUID().slice(0, 8)}@v1b.example.internal`;
  const [u] = await h.db("users").insert({ email, password_hash: "x", display_name: label }).returning("id");
  await h.db("user_roles").insert(roles.map((role) => ({ user_id: u.id, role })));
  return { id: u.id, token: await tokenFor(h.db, email), roles };
}

const H = (t?: string): Record<string, string> => (t ? { Authorization: `Bearer ${t}` } : {});

async function walk(token: string | undefined, limit: number, extra = "") {
  const ids: string[] = [];
  const sizes: number[] = [];
  const cursors: string[] = [];
  const lastIds: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = await request(app)
      .get(`/bots?limit=${limit}${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      .set(H(token));
    expect(r.status).toBe(200);
    const got = r.body.items.map((b: { id: string }) => b.id);
    ids.push(...got);
    sizes.push(got.length);
    cursor = r.body.nextCursor;
    if (cursor) {
      cursors.push(cursor);
      lastIds.push(got[got.length - 1]);
    }
    pages++;
  } while (cursor && pages < 400);
  expect(cursor, "el recorrido debe terminar").toBeUndefined();
  return { ids, sizes, cursors, lastIds, pages };
}

/** Los ids que el solicitante ve según la regla de la ficha (`canSeeBot`), leyendo TODA la tabla. */
async function expectedVisible(auth: Auth): Promise<string[]> {
  const rows = await h.db("bots").select("*");
  const out: string[] = [];
  for (const b of rows) if (await canSeeBot(h.db, auth, b)) out.push(b.id);
  return out.sort();
}
const authOf = (u: U): Auth => ({
  userId: u.id,
  sessionId: "s",
  roles: u.roles,
  rank: Math.max(...u.roles.map((r) => ROLE_RANK[r as keyof typeof ROLE_RANK] ?? 0)),
});

describe("V1 · TD-068 · listBots con visibilidad en SQL", () => {
  const N = 2300;
  let viewer: U;
  let other: U;
  let teamMate: U;
  let visibleSeeded: string[]; // los sembrados que el solicitante `viewer` debe ver
  let ownIds: string[];
  let foreignPrivateIds: string[];
  let foreignPrivateAt: string[];

  beforeAll(async () => {
    viewer = await newUser("viewer");
    other = await newUser("otro");
    teamMate = await newUser("sinvinculos");
    const [tOk] = await h
      .db("teams")
      .insert({ name: `eq-${randomUUID().slice(0, 6)}`, captain_id: other.id })
      .returning("id");
    const [tNo] = await h
      .db("teams")
      .insert({ name: `ex-${randomUUID().slice(0, 6)}`, captain_id: other.id })
      .returning("id");
    await h.db("team_members").insert([
      { team_id: tOk.id, user_id: other.id, role: "captain" },
      { team_id: tOk.id, user_id: viewer.id, role: "member" },
      { team_id: tNo.id, user_id: other.id, role: "captain" },
    ]);
    const base = Date.now() + 3_600_000; // más nuevos que todo lo del seed: salen primero
    const rows: Record<string, unknown>[] = [];
    visibleSeeded = [];
    ownIds = [];
    foreignPrivateIds = [];
    foreignPrivateAt = [];
    for (let i = 0; i < N; i++) {
      const created_at = new Date(base - i * 1000);
      const id = randomUUID();
      if (i % 400 === 399) {
        rows.push({ id, name: `mio-${i}`, owner_id: viewer.id, visibility: "private", created_at });
        visibleSeeded.push(id);
        ownIds.push(id);
      } else if (i % 100 === 50) {
        rows.push({ id, name: `pub-${i}`, owner_id: other.id, visibility: "public", created_at });
        visibleSeeded.push(id);
      } else if (i % 700 === 600) {
        rows.push({ id, name: `eq-${i}`, owner_id: other.id, visibility: "team", team_id: tOk.id, created_at });
        visibleSeeded.push(id);
      } else {
        const team = i % 500 === 499 ? tNo.id : null; // team ajeno / team sin team_id / private
        const visibility = i % 500 === 499 || i % 900 === 800 ? "team" : "private";
        rows.push({ id, name: `ajeno-${i}`, owner_id: other.id, visibility, team_id: team, created_at });
        foreignPrivateIds.push(id);
        foreignPrivateAt.push(created_at.toISOString());
      }
    }
    for (let i = 0; i < rows.length; i += 500) await h.db("bots").insert(rows.slice(i, i + 500));
  }, 180000);

  it("G2 · con 2300 bots, casi todos privados ajenos: la paginación completa devuelve EXACTAMENTE el conjunto visible, sin duplicados ni saltos", async () => {
    const expected = await expectedVisible(authOf(viewer));
    for (const id of visibleSeeded) expect(expected).toContain(id);
    for (const id of foreignPrivateIds) expect(expected).not.toContain(id);
    for (const limit of [1, 7, 20, 100]) {
      const w = await walk(viewer.token, limit);
      expect(new Set(w.ids).size, `duplicados con limit=${limit}`).toBe(w.ids.length);
      expect([...w.ids].sort(), `conjunto con limit=${limit}`).toEqual(expected);
    }
  }, 240000);

  it("G3 · sin páginas vacías artificiales: la primera página ya sale llena y todas salvo la última también", async () => {
    const first = await request(app).get("/bots?limit=3").set(H(viewer.token));
    expect(first.status).toBe(200);
    expect(first.body.items.length, "con >200 privados ajenos delante, la página 1 sigue llena").toBe(3);
    for (const limit of [3, 10]) {
      const w = await walk(viewer.token, limit);
      expect(
        w.sizes.slice(0, -1).every((n) => n === limit),
        `tamaños ${w.sizes}`,
      ).toBe(true);
      expect(w.sizes.every((n) => n > 0)).toBe(true);
    }
  }, 240000);

  it("G1 · ningún id privado ajeno en los items ni en el cursor (el cursor apunta al último item visible)", async () => {
    const w = await walk(viewer.token, 5);
    for (const id of w.ids) expect(foreignPrivateIds, `item ajeno privado ${id}`).not.toContain(id);
    expect(w.cursors.length).toBeGreaterThan(0);
    for (let i = 0; i < w.cursors.length; i++) {
      const text = Buffer.from(w.cursors[i], "base64url").toString("utf8");
      for (const id of foreignPrivateIds) expect(text.includes(id), `cursor con id privado ajeno ${id}`).toBe(false);
      for (const t of foreignPrivateAt) expect(text.includes(t.slice(0, 23)), "cursor con instante ajeno").toBe(false);
      const c = JSON.parse(text) as { k: string[] };
      expect(c.k, "el cursor apunta al último elemento VISIBLE de la página").toEqual([w.lastIds[i]]);
    }
    // el anónimo (sólo públicos) tampoco recibe nada privado, ni en items ni en cursores
    const anon = await walk(undefined, 50);
    for (const id of anon.ids) expect(foreignPrivateIds).not.toContain(id);
    for (const id of ownIds) expect(anon.ids, "el anónimo no ve bots privados de otro").not.toContain(id);
    for (const t of anon.cursors) {
      const text = Buffer.from(t, "base64url").toString("utf8");
      for (const id of foreignPrivateIds) expect(text.includes(id)).toBe(false);
    }
  }, 240000);

  it("G4 · contrato estable: cursor v2 en claro {v,t,k}, items con su forma y nextCursor ausente al agotar", async () => {
    const r = await request(app).get("/bots?limit=2").set(H(viewer.token));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["items", "nextCursor"]);
    const c = JSON.parse(Buffer.from(r.body.nextCursor, "base64url").toString("utf8"));
    expect(c.v).toBe(2);
    expect(Object.keys(c).sort()).toEqual(["k", "t", "v"]);
    expect(typeof c.t).toBe("string");
    expect(c.k).toEqual([r.body.items[1].id]);
    for (const k of ["id", "name", "ownerId", "visibility"]) expect(r.body.items[0]).toHaveProperty(k);
    // todo lo visible cabe en una página: sin cursor
    const mine = await request(app).get(`/bots?limit=100&ownerId=${viewer.id}`).set(H(viewer.token));
    expect(mine.status).toBe(200);
    expect(mine.body.nextCursor).toBeUndefined();
    expect(mine.body.items.map((b: { id: string }) => b.id).sort()).toEqual([...ownIds].sort());
    // un cursor basura sigue siendo 400, no 500
    const bad = await request(app).get("/bots?cursor=zzz").set(H(viewer.token));
    expect(bad.status).toBe(400);
  }, 120000);

  it("G5 · el listado coincide con `canSeeBot` para anónimo, dueño/miembro, ajeno, organizador, moderador y admin", async () => {
    const organizer = await newUser("org", ["user", "organizer"]);
    const moderator = await newUser("mod", ["user", "moderator"]);
    const admin = await newUser("adm", ["user", "admin"]);
    const cases: { name: string; token?: string; auth: Auth }[] = [
      { name: "anónimo", auth: undefined },
      { name: "dueño/miembro", token: viewer.token, auth: authOf(viewer) },
      { name: "ajeno sin vínculos", token: teamMate.token, auth: authOf(teamMate) },
      { name: "organizador", token: organizer.token, auth: authOf(organizer) },
      { name: "moderador", token: moderator.token, auth: authOf(moderator) },
      { name: "admin", token: admin.token, auth: authOf(admin) },
    ];
    const n: Record<string, number> = {};
    for (const c of cases) {
      const w = await walk(c.token, 100);
      expect([...w.ids].sort(), c.name).toEqual(await expectedVisible(c.auth));
      n[c.name] = w.ids.length;
    }
    // el organizador NO es staff para bots (rango moderador): sólo ve lo público y lo propio
    expect(n["organizador"]).toBe(n["ajeno sin vínculos"]);
    expect(n["moderador"]).toBe(n["admin"]);
    expect(n["moderador"]).toBeGreaterThanOrEqual(N);
    expect(n["moderador"]).toBeGreaterThan(n["organizador"]);
  }, 300000);
});
