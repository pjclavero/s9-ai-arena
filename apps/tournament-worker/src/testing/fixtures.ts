/**
 * E9 · utilidades de test: crea usuarios/bots/versiones publicadas DIRECTAMENTE
 * en la BD embebida de E7 (test-db.ts), sin pasar por HTTP, para que los tests
 * de cola/formatos/ratings no paguen el coste del pipeline completo. Los tests
 * E2E (tournament-e2e.test.ts) sí usan la API real de E7.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

export const EXAMPLE_LOADOUT = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
);

export interface TestBot {
  botId: string;
  ownerId: string;
  version: number;
  loadoutRevision: number;
  name: string;
}

/** Crea un bot publicado (dueño propio, loadout rev 1, versión 1 published). */
export async function createPublishedBot(db: Knex, name: string, opts: { ownerId?: string } = {}): Promise<TestBot> {
  let ownerId = opts.ownerId;
  if (!ownerId) {
    const [u] = await db("users")
      .insert({ email: `${name.toLowerCase()}@test.local`, password_hash: "x", display_name: name })
      .returning("id");
    ownerId = u.id as string;
  }
  const [bot] = await db("bots").insert({ name, owner_id: ownerId, visibility: "public" }).returning("id");
  await db("bot_loadouts").insert({
    bot_id: bot.id,
    revision: 1,
    name: `${name}-loadout`,
    catalog_version: EXAMPLE_LOADOUT.catalogVersion,
    chassis: EXAMPLE_LOADOUT.chassis,
    modules: JSON.stringify(EXAMPLE_LOADOUT.modules),
  });
  await db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "published",
    runtime: "node",
    loadout_revision: 1,
    artifact_hash: `hash-${name}`,
  });
  return { botId: bot.id as string, ownerId, version: 1, loadoutRevision: 1, name };
}

export async function createBots(db: Knex, n: number, prefix = "bot"): Promise<TestBot[]> {
  const bots: TestBot[] = [];
  for (let i = 0; i < n; i++) bots.push(await createPublishedBot(db, `${prefix}-${i + 1}`));
  return bots;
}

/** Inserta una batalla programada 1v1 (equipos A/B) con su trabajo run_battle. */
export async function insertScheduledBattle(
  db: Knex,
  a: TestBot,
  b: TestBot,
  opts: { official?: boolean; tournamentId?: string; matchId?: string; seed?: string; rulesetId?: string } = {},
): Promise<string> {
  const [battle] = await db("battles")
    .insert({
      tournament_id: opts.tournamentId ?? null,
      match_id: opts.matchId ?? null,
      status: "scheduled",
      official: opts.official ?? false,
      mode: "deathmatch",
      ruleset_id: opts.rulesetId ?? "mvp-default",
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: opts.seed ?? `seed-${Math.random().toString(36).slice(2)}`,
    })
    .returning("id");
  await db("participants").insert([
    { battle_id: battle.id, bot_id: a.botId, version: a.version, team: "A" },
    { battle_id: battle.id, bot_id: b.botId, version: b.version, team: "B" },
  ]);
  return battle.id as string;
}
