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

  it("repara un bot que quedó a medias (con loadout pero sin versión)", async () => {
    // Reproduce el fallo real: una ejecución anterior creó el bot y su loadout
    // pero murió antes de guardar la versión (el código fuente no estaba en la
    // imagen). Volver a ejecutar debe completarlo, no dejarlo roto ni duplicarlo.
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Explorador" }).first();
    await h.db("bot_versions").where({ bot_id: bot.id }).del();
    expect(await h.db("bot_versions").where({ bot_id: bot.id })).toHaveLength(0);

    const bots = await count("bots");
    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    expect(await count("bots")).toBe(bots);
    const versions = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(versions).toHaveLength(1);
    expect(versions[0].state).toBe("draft");
    // No duplica la revisión de loadout: reutiliza la que ya existía.
    expect(await h.db("bot_loadouts").where({ bot_id: bot.id })).toHaveLength(1);
  });

  it("un equipo adicional se añade sin tocar los existentes", async () => {
    await seedDemoTeams(h.db, OWNER, ["Elimelech"]);

    expect(await count("teams")).toBe(3);
    expect(await count("bots")).toBe(9);
    const team = await h.db("teams").where({ name: "Elimelech" }).first();
    expect((await h.db("bots").where({ team_id: team.id })).length).toBe(3);
  });
});

describe("seedDemoTeams · B5 (versión inservible: rejected/suspended/retired)", () => {
  it("bot con última versión 'rejected' → crea la v2 en draft, y la v1 queda intacta", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Explorador" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    await h.db("bot_versions").where({ id: v1.id }).update({ state: "rejected" });

    const loadoutsAntes = await count("bot_loadouts");
    const r = await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    const versions = await h.db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "asc");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[0].state).toBe("rejected"); // la vieja NO se toca ni se borra
    expect(versions[0].id).toBe(v1.id);
    expect(versions[1].version).toBe(2);
    expect(versions[1].state).toBe("draft");
    expect(versions[1].source.length).toBeGreaterThan(500);

    // No duplica la revisión de loadout: la reutiliza.
    expect(await count("bot_loadouts")).toBe(loadoutsAntes);
    const bots = r.bots.filter((b) => b.name === "Equipo Rojo · Explorador");
    expect(bots).toEqual([{ name: "Equipo Rojo · Explorador", team: "Equipo Rojo", created: true }]);
  });

  it("bot con última versión 'draft' → NO se toca (estado utilizable)", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Defensor" }).first();
    const antes = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(antes).toHaveLength(1);
    expect(antes[0].state).toBe("draft");

    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    const despues = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(despues).toHaveLength(1);
    expect(despues[0].id).toBe(antes[0].id);
  });

  it("bot con última versión 'published' → NO se toca", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Artillero" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    await h.db("bot_versions").where({ id: v1.id }).update({ state: "published" });

    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    const versions = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(versions).toHaveLength(1);
    expect(versions[0].state).toBe("published");
  });

  it("bot con última versión 'suspended' → se trata igual que 'rejected': crea v2 en draft", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Explorador" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    await h.db("bot_versions").where({ id: v1.id }).update({ state: "suspended" });

    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    const versions = await h.db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "asc");
    expect(versions).toHaveLength(2);
    expect(versions[0].state).toBe("suspended");
    expect(versions[1].state).toBe("draft");
  });

  it("bot con última versión 'retired' → se trata igual que 'rejected': crea v2 en draft", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Defensor" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    await h.db("bot_versions").where({ id: v1.id }).update({ state: "retired" });

    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);

    const versions = await h.db("bot_versions").where({ bot_id: bot.id }).orderBy("version", "asc");
    expect(versions).toHaveLength(2);
    expect(versions[0].state).toBe("retired");
    expect(versions[1].state).toBe("draft");
  });

  it("idempotente tras reparar: repetirlo con la v2 ya en draft no crea una v3", async () => {
    const bot = await h.db("bots").where({ name: "Equipo Rojo · Artillero" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    await h.db("bot_versions").where({ id: v1.id }).update({ state: "rejected" });

    await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);
    expect(await h.db("bot_versions").where({ bot_id: bot.id })).toHaveLength(2);

    const r = await seedDemoTeams(h.db, OWNER, ["Equipo Rojo"]);
    expect(await h.db("bot_versions").where({ bot_id: bot.id })).toHaveLength(2);
    const entry = r.bots.find((b) => b.name === "Equipo Rojo · Artillero");
    expect(entry?.created).toBe(false);
  });

  it("no crea versión nueva solo porque el código del repo cambió si la última versión sigue siendo utilizable", async () => {
    // Simula deriva: la versión draft existente tiene un código distinto al
    // que produciría el repo hoy. La decisión (documentada en demo-teams.ts)
    // es NO crear una versión nueva por esto: solo el ESTADO dispara la
    // reparación, nunca una comparación de contenido de código.
    const bot = await h.db("bots").where({ name: "Equipo Azul · Explorador" }).first();
    const [v1] = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(v1.state).toBe("draft");
    const codigoViejo = Buffer.from("# código antiguo, ya no coincide con el repo\n");
    await h.db("bot_versions").where({ id: v1.id }).update({ source: codigoViejo });

    await seedDemoTeams(h.db, OWNER, ["Equipo Azul"]);

    const versions = await h.db("bot_versions").where({ bot_id: bot.id });
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(v1.id);
    expect(Buffer.from(versions[0].source).equals(codigoViejo)).toBe(true);
  });
});
