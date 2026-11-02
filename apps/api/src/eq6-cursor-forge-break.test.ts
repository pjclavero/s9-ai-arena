/**
 * EQ6 · revisión independiente de #221 · cursores FORJADOS.
 *
 * Un cursor v2 que pasa la validación de forma (`v: 2`, `t` con 6 decimales, `k` del
 * tamaño esperado) pero lleva valores que PostgreSQL no puede convertir al tipo de la
 * columna (uuid, integer, timestamptz) no puede acabar en 500: tiene que ser 400 como
 * cualquier otro cursor inválido, en TODOS los listados con cursor. (Se admite 200 cuando
 * el valor es válido para la columna, p. ej. `map_id` es texto; lo prohibido es el 500.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { FakeBotManager } from "./services/bot-manager.js";

let h: TestDbHandle;
let app: Express;
let tok = "";
let ownerId = "";

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db) });
  tok = await tokenFor(h.db, DEV_USERS.admin);
  ownerId = (await h.db("users").where({ email: DEV_USERS.admin }).first()).id;
}, 120000);

afterAll(async () => {
  await h.stop();
});

const c = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const T = "2026-01-01T00:00:00.123456Z";
const UUID = "00000000-0000-0000-0000-000000000000";

const LISTS: { path: string; arity: number }[] = [
  { path: `/bots?ownerId=__OWNER__`, arity: 1 },
  { path: "/teams", arity: 1 },
  { path: "/tournaments", arity: 1 },
  { path: "/maps", arity: 2 },
  { path: "/battles", arity: 1 },
  { path: "/replays", arity: 1 },
  { path: "/public/replays", arity: 1 },
];

function forged(arity: number): [string, string][] {
  const goodKeys = arity === 2 ? [UUID, 1] : [UUID];
  const pad = (k0: unknown) => (arity === 2 ? [k0, 1] : [k0]);
  return [
    ["control válido", c({ v: 2, t: T, k: goodKeys })],
    ["k no-uuid", c({ v: 2, t: T, k: pad("no-es-un-uuid") })],
    ["k entero en columna uuid", c({ v: 2, t: T, k: pad(42) })],
    ["k con comilla", c({ v: 2, t: T, k: pad("x' OR '1'='1") })],
    ["t 31 de febrero", c({ v: 2, t: "2026-02-31T00:00:00.000000Z", k: goodKeys })],
    ["t año 0000", c({ v: 2, t: "0000-01-01T00:00:00.000000Z", k: goodKeys })],
    ["t hora 24", c({ v: 2, t: "2026-01-01T24:00:00.000000Z", k: goodKeys })],
    ["k entero gigante", c({ v: 2, t: T, k: pad(Number.MAX_SAFE_INTEGER) })],
    ...(arity === 2
      ? ([
          ["versión en texto", c({ v: 2, t: T, k: [UUID, "uno"] })],
          ["versión fuera de int4", c({ v: 2, t: T, k: [UUID, 2 ** 40] })],
        ] as [string, string][])
      : []),
    ["k de más", c({ v: 2, t: T, k: [...goodKeys, UUID] })],
    ["basura", "%%%no-base64%%%"],
    ["v1", Buffer.from(`2026-01-01T00:00:00.123Z|${UUID}`).toString("base64url")],
  ];
}

describe("EQ6 · #221 · cursores forjados nunca dan 500", () => {
  for (const l of LISTS) {
    it(`${l.path}`, async () => {
      const bad: string[] = [];
      for (const [name, cur] of forged(l.arity)) {
        const path = l.path.replace("__OWNER__", ownerId);
        const sep = path.includes("?") ? "&" : "?";
        const r = await request(app)
          .get(`${path}${sep}cursor=${encodeURIComponent(cur)}`)
          .set("Authorization", `Bearer ${tok}`);
        if (name === "control válido") {
          if (r.status !== 200) bad.push(`${name}: ${r.status}`);
        } else if (r.status >= 500) bad.push(`${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      }
      expect(bad, `${l.path}`).toEqual([]);
    });
  }
});
