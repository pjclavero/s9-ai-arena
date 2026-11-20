/**
 * ELIG · H5 · La herramienta de inventario (scripts/ops/eligibility-inventory.mjs)
 * contra la API REAL sobre BD efímera: tabla BOT·VERSION·OWNER·LOADOUT REVISION·
 * CURRENT VALIDATION·ELIGIBLE·REASON, modo --summary sin filas, token sólo desde
 * fichero 0600 (nunca argv) y sin escribir en la BD.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { createLoadoutRevision } from "./services/bots.js";
import { fetchInventory, formatTsv, readToken, COLUMNS } from "../../../scripts/ops/eligibility-inventory.mjs";

let h: TestDbHandle;
let server: Server;
let baseUrl: string;
let adminTok: string;
let userTok: string;
let dir: string;

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  const app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  adminTok = await tokenFor(h.db, DEV_USERS.admin);
  userTok = await tokenFor(h.db, DEV_USERS.user);
  const owner = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id;
  const [bot] = await h.db("bots").insert({ name: "A-DEF", owner_id: owner }).returning("*");
  const mods = (ammo: string) => [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
  ];
  const S = { massKg: 0, costCredits: 0, energyBalanceEUs: 0 };
  await createLoadoutRevision(h.db, bot.id, { chassis: "chassis.heavy@1", modules: mods("ammo.standard@1") }, S);
  await createLoadoutRevision(h.db, bot.id, { chassis: "chassis.heavy@1", modules: mods("ammo.ap@1") }, S);
  for (const [version, rev] of [
    [1, 1],
    [2, 1],
    [3, 2],
  ]) {
    await h
      .db("bot_versions")
      .insert({ bot_id: bot.id, version, state: "published", runtime: "python", loadout_revision: rev });
  }
  dir = mkdtempSync(join(tmpdir(), "elig-cli-"));
}, 120_000);

afterAll(async () => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  await h.stop();
});

describe("eligibility-inventory.mjs", () => {
  it("tabla completa con las columnas del encargo y A-DEF v1/v2 no elegibles, v3 sí; sin escrituras", async () => {
    const before = Number((await h.db("audit_log").count({ n: "*" }))[0].n);
    const inv = await fetchInventory({ baseUrl, token: adminTok });
    expect(Number((await h.db("audit_log").count({ n: "*" }))[0].n)).toBe(before);
    const tsv = formatTsv(inv).split("\n");
    expect(tsv).toContain(COLUMNS.join("\t"));
    expect(COLUMNS).toEqual([
      "BOT",
      "VERSION",
      "OWNER",
      "LOADOUT_REVISION",
      "CURRENT_VALIDATION",
      "ELIGIBLE",
      "REASON",
    ]);
    const rows = tsv.filter((l: string) => l.startsWith("A-DEF\t")).map((l: string) => l.split("\t"));
    expect(rows.map((r: string[]) => [r[1], r[3], r[4], r[5]])).toEqual([
      ["1", "1", "INVALID_AMMO", "no"],
      ["2", "1", "INVALID_AMMO", "no"],
      ["3", "2", "VALID", "yes"],
    ]);
    expect(rows[1][6]).toContain("weapon.cannon@1 no admite ammo.standard@1");
    expect(tsv.join("\n")).toMatch(/TOTAL_PUBLISHED_VERSIONS=\d+ CURRENTLY_VALID=\d+ CURRENTLY_INVALID=\d+/);
  });

  it("--summary: sólo agregados, ninguna fila con nombres ni propietarios", async () => {
    const inv = await fetchInventory({ baseUrl, token: adminTok, summary: true });
    const out = formatTsv(inv);
    expect(out).not.toContain("A-DEF");
    expect(out).toMatch(/INVALID_BY_REASON=\{"INVALID_AMMO":2\}/);
    expect(out).toMatch(/USERS_AFFECTED=1/);
  });

  it("un token sin rol admin → error 403, sin datos", async () => {
    await expect(fetchInventory({ baseUrl, token: userTok })).rejects.toThrow(/403/);
  });

  it("el token se lee de fichero 0600; con permisos abiertos se niega", () => {
    const f = join(dir, "tok");
    writeFileSync(f, "secreto\n");
    chmodSync(f, 0o644);
    expect(() => readToken({ file: f })).toThrow(/0600/);
    chmodSync(f, 0o600);
    expect(readToken({ file: f })).toBe("secreto");
    expect(() => readToken({})).toThrow(/Falta el token/);
  });
});
