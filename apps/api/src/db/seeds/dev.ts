/**
 * T7.1 · Seeds de desarrollo: un usuario por rol, ruleset por defecto,
 * catálogo E3 importado desde los JSON del repo y mapa MVP publicado.
 *
 * Idempotente: se puede ejecutar varias veces sobre la misma BD.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import argon2 from "argon2";
import type { Knex } from "knex";
import { loadCatalog, CATALOG_VERSION } from "../../../../../packages/module-catalog/loadCatalog.js";
import { BUDGET_CREDITS_MVP } from "../../../../../packages/game-rules/index.js";
import { importCatalogVersion } from "../../services/catalog.js";
import { ROLES, type RoleName } from "../migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

export const DEV_PASSWORD = "dev-password-s9-arena!";
export const DEV_USERS: Record<RoleName, string> = {
  visitor: "visitor@dev.arena.local",
  user: "user@dev.arena.local",
  developer: "developer@dev.arena.local",
  team_captain: "captain@dev.arena.local",
  organizer: "organizer@dev.arena.local",
  moderator: "moderator@dev.arena.local",
  admin: "admin@dev.arena.local",
};

export const DEFAULT_RULESET_ID = "mvp-default";

export async function seedDev(db: Knex): Promise<void> {
  // --- roles (jerarquía acumulativa del cap. 16 / openapi) -------------------
  for (let i = 0; i < ROLES.length; i++) {
    await db("roles").insert({ name: ROLES[i], rank: i }).onConflict("name").ignore();
  }

  // --- un usuario por rol ----------------------------------------------------
  const hash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  for (const role of ROLES) {
    const email = DEV_USERS[role];
    const existing = await db("users").where({ email }).first();
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const [row] = await db("users")
        .insert({ email, password_hash: hash, display_name: `dev-${role}` })
        .returning("id");
      userId = row.id;
    }
    // El rol "visitor" es el anónimo: el usuario semilla visitor no recibe
    // roles extra (autenticado sin privilegios equivale a "user"? No: se le da
    // el rol mínimo explícito para poder probar la matriz rol×endpoint).
    await db("user_roles").insert({ user_id: userId, role }).onConflict(["user_id", "role"]).ignore();
  }

  // --- ruleset por defecto (ADR-000/D7: budget configurable por ruleset) -----
  await db("rulesets")
    .insert({
      id: DEFAULT_RULESET_ID,
      name: "Ruleset MVP por defecto",
      budget_credits: BUDGET_CREDITS_MVP,
      forbidden_categories: "[]",
    })
    .onConflict("id")
    .ignore();

  // --- catálogo E3 desde los JSON versionados del repo (idempotente) ---------
  await importCatalogVersion(db, CATALOG_VERSION, loadCatalog());

  // --- mapa MVP ---------------------------------------------------------------
  const mapDoc = JSON.parse(readFileSync(join(REPO_ROOT, "maps", "mvp-arena-01.json"), "utf8"));
  const checksum = createHash("sha256").update(JSON.stringify(mapDoc)).digest("hex");
  await db("maps").insert({ id: mapDoc.mapId, name: mapDoc.mapId }).onConflict("id").ignore();
  await db("map_versions")
    .insert({
      map_id: mapDoc.mapId,
      version: mapDoc.version,
      state: "published",
      checksum,
      width_m: mapDoc.widthM,
      height_m: mapDoc.heightM,
      supported_modes: JSON.stringify(mapDoc.supportedModes ?? ["deathmatch"]),
      content: JSON.stringify(mapDoc),
      published_at: db.fn.now(),
    })
    .onConflict(["map_id", "version"])
    .ignore();
}
