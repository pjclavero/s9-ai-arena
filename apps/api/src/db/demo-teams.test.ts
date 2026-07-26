/**
 * Equipos de demostración: crean plantillas jugables sin crear usuarios y sin
 * saltarse la validación en sandbox (las versiones quedan en `draft`).
 *
 * Corre contra PostgreSQL REAL embebido (ADR-E7-002), mismas migraciones que prod.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDbHandle } from "../testing/test-db.js";
import { seedContent } from "./seeds/dev.js";
import { seedDemoTeams } from "./seeds/demo-teams.js";

let h: TestDbHandle;
const OWNER = "duenyo@arena.local";

beforeAll(async () => {
  h = await startTestDb({ migrate: true });
  await seedContent(h.db);
  await h.db("users").insert({ email: OWNER, password_hash: "x", display_name: "Dueño" });
}, 120000);

afterAll(async () => {
  await h.stop();
});

async function count(table: string): Promise<number> {
  const row = await h.db(table).count<{ count: string }[]>({ count: "*" });
  return Number(row[0].count);
}

describe("seedDemoTeams", () => {
  it("falla si el propietario no existe, en vez de crearlo", async () => {
    await expect(seedDemoTeams(h.db, "no-existe@arena.local")).rejects.toThrow(/No existe ningún usuario/);
    expect(await count("users")).toBe(1);
  });

  it("crea los equipos pedidos con tres bots cada uno", async () => {
    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo", "Equipo Azul"]);

    expect(await count("teams")).toBe(2);
    expect(await count("bots")).toBe(6);

    for (const name of ["Equipo Rojo", "Equipo Azul"]) {
      const team = await h.db("teams").where({ name }).first();
      const bots = await h.db("bots").where({ team_id: team.id });
      expect(bots.length).toBe(3);
    }
  });

  it("cada bot tiene loadout válido y una versión con código real", async () => {
    const bots = await h.db("bots");
    for (const bot of bots) {
      const loadouts = await h.db("bot_loadouts").where({ bot_id: bot.id });
      expect(loadouts.length).toBe(1);
      expect(loadouts[0].chassis).toMatch(/^chassis\./);

      const versions = await h.db("bot_versions").where({ bot_id: bot.id });
      expect(versions.length).toBe(1);
      // Código real del repo, no un marcador de posición.
      expect(versions[0].source.length).toBeGreaterThan(500);
      expect(["python", "node"]).toContain(versions[0].runtime);
    }
  });

  it("NO marca las versiones como validadas ni publicadas (la sandbox no se salta)", async () => {
    const estados = await h.db("bot_versions").distinct("state").pluck("state");
    expect(estados).toEqual(["draft"]);
  });

  it("no crea usuarios", async () => {
    expect(await count("users")).toBe(1);
  });

  it("es idempotente: repetirlo no duplica equipos ni bots", async () => {
    const before = { teams: await count("teams"), bots: await count("bots"), loadouts: await count("bot_loadouts") };

    const r = await seedDemoTeams(h.db, OWNER, ["Equipo Rojo", "Equipo Azul"]);

    expect(await count("teams")).toBe(before.teams);
    expect(await count("bots")).toBe(before.bots);
    expect(await count("bot_loadouts")).toBe(before.loadouts);
    expect(r.bots.every((b) => !b.created)).toBe(true);
  });

  it("un equipo adicional se añade sin tocar los existentes", async () => {
    await seedDemoTeams(h.db, OWNER, ["Elimelech"]);

    expect(await count("teams")).toBe(3);
    expect(await count("bots")).toBe(9);
    const team = await h.db("teams").where({ name: "Elimelech" }).first();
    expect((await h.db("bots").where({ team_id: team.id })).length).toBe(3);
  });
});
