/**
 * Equipos y bots de demostración para una instancia real.
 *
 * Crea tres equipos de tres bots cada uno, con código fuente de los bots de
 * ejemplo del repo y loadouts de arquetipo que YA validan contra el catálogo
 * vigente (`example-bots/loadouts.test.ts`).
 *
 * Reglas que respeta a propósito:
 *  - NO crea usuarios: el propietario debe existir ya. Si no existe, falla.
 *  - NO fabrica estados de validación: las versiones quedan en `draft`, que es
 *    el único estado alcanzable sin pasar por el pipeline de bot-manager.
 *    Marcarlas como `validated`/`published` a mano sería saltarse el control de
 *    seguridad que valida el código en sandbox.
 *  - Idempotente: repetirlo no duplica equipos, bots ni revisiones.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Knex } from "knex";
import { ARCHETYPES } from "../../../../../packages/module-catalog/resolve/archetypes.js";
import { CATALOG_VERSION } from "../../../../../packages/module-catalog/loadCatalog.js";
import { createLoadoutRevision, validateLoadoutServerSide } from "../../services/bots.js";
import type { Db } from "../connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

interface BotSpec {
  /** Sufijo del nombre; el nombre final es `<equipo> <sufijo>`. */
  role: string;
  archetype: keyof typeof ARCHETYPES;
  runtime: "python" | "node";
  sourcePath: string;
}

/** Un bot por rol, con el arquetipo que su propio código documenta. */
const ROSTER: BotSpec[] = [
  { role: "Explorador", archetype: "scout", runtime: "python", sourcePath: "example-bots/python/explorer.py" },
  { role: "Defensor", archetype: "heavy", runtime: "python", sourcePath: "example-bots/python/defender.py" },
  { role: "Artillero", archetype: "gunner", runtime: "node", sourcePath: "example-bots/javascript/gunner.ts" },
];

export interface DemoTeamsResult {
  teams: { name: string; created: boolean }[];
  bots: { name: string; team: string; created: boolean }[];
}

/**
 * @param ownerEmail propietario de los equipos y bots. Debe existir.
 * @param teamNames  equipos a crear; cada uno recibe la plantilla completa.
 */
export async function seedDemoTeams(
  db: Db,
  ownerEmail: string,
  teamNames: string[] = ["Equipo Rojo", "Equipo Azul"],
): Promise<DemoTeamsResult> {
  const owner = await db("users").where({ email: ownerEmail }).first();
  if (!owner) {
    throw new Error(
      `No existe ningún usuario con email ${ownerEmail}. Este comando NO crea usuarios: ` +
        `regístralo primero desde la aplicación.`,
    );
  }

  const result: DemoTeamsResult = { teams: [], bots: [] };

  for (const teamName of teamNames) {
    const team = await upsertTeam(db, teamName, owner.id, result);

    for (const spec of ROSTER) {
      const botName = `${teamName} · ${spec.role}`;
      await upsertBot(db, { botName, teamId: team.id, ownerId: owner.id, teamName, spec, result });
    }
  }

  return result;
}

async function upsertTeam(db: Db, name: string, captainId: string, result: DemoTeamsResult) {
  const existing = await db("teams").where({ name }).first();
  if (existing) {
    result.teams.push({ name, created: false });
    return existing;
  }
  const [team] = await db("teams").insert({ name, captain_id: captainId }).returning("*");
  await db("team_members")
    .insert({ team_id: team.id, user_id: captainId, role: "captain" })
    .onConflict(["team_id", "user_id"])
    .ignore();
  result.teams.push({ name, created: true });
  return team;
}

async function upsertBot(
  db: Db,
  args: {
    botName: string;
    teamId: string;
    ownerId: string;
    teamName: string;
    spec: BotSpec;
    result: DemoTeamsResult;
  },
): Promise<void> {
  const { botName, teamId, ownerId, teamName, spec, result } = args;

  const existing = await db("bots").where({ owner_id: ownerId, name: botName }).first();
  if (existing) {
    result.bots.push({ name: botName, team: teamName, created: false });
    return;
  }

  const [bot] = await db("bots")
    .insert({ name: botName, owner_id: ownerId, team_id: teamId, visibility: "team" })
    .returning("*");

  // El loadout se valida con el MISMO validador que usa la API: si el catálogo
  // cambiara y el arquetipo dejara de ser legal, esto falla en vez de guardar
  // un loadout inválido.
  const archetype = ARCHETYPES[spec.archetype];
  const loadoutInput = {
    name: `${spec.role} (${spec.archetype})`,
    catalogVersion: CATALOG_VERSION,
    chassis: archetype.chassis,
    modules: archetype.modules,
  };
  const validation = await validateLoadoutServerSide(db, loadoutInput);
  if (validation.violations.length > 0) {
    throw new Error(
      `El arquetipo "${spec.archetype}" no valida contra el catálogo ${CATALOG_VERSION}: ` +
        JSON.stringify(validation.violations),
    );
  }
  const loadout = await createLoadoutRevision(db, bot.id, loadoutInput, validation.summary!);

  const source = readFileSync(join(REPO_ROOT, spec.sourcePath));
  await db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "draft",
    runtime: spec.runtime,
    loadout_revision: loadout.revision,
    source,
    source_filename: spec.sourcePath.split("/").pop(),
    code_public: false,
  });

  result.bots.push({ name: botName, team: teamName, created: true });
}

export function formatDemoTeamsResult(r: DemoTeamsResult): string {
  const nuevos = r.bots.filter((b) => b.created).length;
  const equipos = r.teams.filter((t) => t.created).length;
  const lines = [`Equipos nuevos: ${equipos}/${r.teams.length}. Bots nuevos: ${nuevos}/${r.bots.length}.`];
  for (const t of r.teams) {
    lines.push(`  ${t.name}${t.created ? "" : " (ya existía)"}`);
    for (const b of r.bots.filter((x) => x.team === t.name)) {
      lines.push(`    - ${b.name}${b.created ? "" : " (ya existía)"}`);
    }
  }
  lines.push("Las versiones quedan en 'draft': envíalas a validación desde la aplicación.");
  return lines.join("\n");
}
