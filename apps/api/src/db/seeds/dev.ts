/**
 * T7.1 · Seeds de desarrollo: un usuario por rol, ruleset por defecto,
 * catálogo E3 importado desde los JSON del repo y mapa MVP publicado.
 *
 * Idempotente: se puede ejecutar varias veces sobre la misma BD.
 *
 * `seedContent` (contenido base: ruleset + catálogo + mapa) está separado de
 * los usuarios de desarrollo a propósito: es lo único apto para un entorno
 * real, donde crear cuentas con contraseña conocida sería un agujero. El
 * comando `cli.ts bootstrap` ejecuta SOLO `seedContent`.
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
import { withChecksum } from "../../../../map-service/src/canonical.js";
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

/**
 * FC-C (TD-003) · Un ruleset de BD por modo de plataforma. Los ids son de la
 * PLATAFORMA (tabla `rulesets`), deliberadamente distintos de los del motor: el
 * enlace con el motor es explícito en `config.engineRulesetId`, que es lo que
 * `resolveBattleRuleset` (services/battle-ruleset-resolver.ts) honra; y `config.mode`
 * es lo que `checkBattleContent` (routes/catalog.ts) compara con el modo de la batalla.
 * La web NO conoce estos ids: los lee de GET /rulesets.
 */
export const PLATFORM_RULESETS: ReadonlyArray<{ id: string; name: string; mode: string; engineRulesetId: string }> = [
  { id: "deathmatch-mvp", name: "Deathmatch (práctica)", mode: "deathmatch", engineRulesetId: "dm_practice@1" },
  {
    id: "team-deathmatch-mvp",
    name: "Team deathmatch (MVP)",
    mode: "team_deathmatch",
    engineRulesetId: "tdm_mvp@1",
  },
  {
    id: "capture-the-flag-mvp",
    name: "Captura la bandera (MVP)",
    mode: "capture_the_flag",
    engineRulesetId: "ctf_mvp@1",
  },
  { id: "zone-control-mvp", name: "Control de zona (MVP)", mode: "zone_control", engineRulesetId: "zc_mvp@1" },
];

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

  await seedContent(db);
}

/**
 * Contenido base necesario para que la aplicación sea usable: ruleset por
 * defecto, catálogo de módulos y mapa MVP publicado. NO crea usuarios ni
 * roles de desarrollo, así que es seguro ejecutarlo en un entorno real.
 *
 * Idempotente: todas las escrituras son onConflict-ignore o import idempotente.
 * Instalaciones previas: la fila de mvp-arena-01 v1 ya sembrada con
 * supported_modes=["deathmatch"] se CORRIGE (solo esa columna, derivada del propio
 * contenido; el contenido y el checksum no se tocan).
 */
export async function seedContent(db: Knex): Promise<void> {
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

  // --- FC-C · un ruleset por modo de plataforma (idempotente, nunca sobrescribe
  //     un ruleset que un operador haya ajustado: onConflict-ignore) ------------
  for (const r of PLATFORM_RULESETS) {
    await db("rulesets")
      .insert({
        id: r.id,
        name: r.name,
        budget_credits: BUDGET_CREDITS_MVP,
        forbidden_categories: "[]",
        config: JSON.stringify({ mode: r.mode, engineRulesetId: r.engineRulesetId }),
      })
      .onConflict("id")
      .ignore();
  }

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
      // FC-C · los modos son los que DECLARA el documento (meta.supportedModes, lo que
      // valida checkMode de E4). Antes se leía `mapDoc.supportedModes` (raíz, siempre
      // undefined) y se persistía ["deathmatch"]: la columna decía un modo que el
      // propio mapa no declara y escondía los dos que sí (CTF y TDM).
      supported_modes: JSON.stringify(mapDoc.meta?.supportedModes ?? []),
      content: JSON.stringify(mapDoc),
      published_at: db.fn.now(),
    })
    .onConflict(["map_id", "version"])
    .ignore();
  await db("map_versions")
    .where({ map_id: mapDoc.mapId, version: mapDoc.version })
    .update({ supported_modes: JSON.stringify(mapDoc.meta?.supportedModes ?? []) });

  // --- FC-C · mvp-arena-02: MISMA geometría que mvp-arena-01, declarando los modos
  //     que esa arena soporta DE VERDAD según checkMode de E4 (4 spawns de 2 equipos +
  //     bases y banderas de 2 equipos ⇒ deathmatch, team_deathmatch y capture_the_flag;
  //     sin zona de captura ⇒ NO zone_control). Es un mapa aparte (no una v2 de
  //     mvp-arena-01): la v1 es inmutable y otros carriles usan "mvp-arena-01 v2" como
  //     versión inexistente en sus pruebas de fail-closed.
  const arena02 = mvpArena02(mapDoc);
  await db("maps").insert({ id: arena02.mapId, name: arena02.meta.name }).onConflict("id").ignore();
  await db("map_versions")
    .insert({
      map_id: arena02.mapId,
      version: arena02.version,
      state: "published",
      checksum: arena02.checksum,
      width_m: arena02.widthM,
      height_m: arena02.heightM,
      supported_modes: JSON.stringify(arena02.meta.supportedModes),
      content: JSON.stringify(arena02),
      published_at: db.fn.now(),
    })
    .onConflict(["map_id", "version"])
    .ignore();
}

export const MVP_ARENA_02_ID = "mvp-arena-02";
/** Modos que la geometría de mvp-arena-01 soporta realmente (ver comentario en seedContent). */
export const MVP_ARENA_02_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag"] as const;

/** mvp-arena-02 derivado de mvp-arena-01: otro id/nombre y los modos reales; checksum canónico. */
export function mvpArena02(base: Record<string, any>) {
  const { checksum: _drop, ...rest } = base;
  return withChecksum({
    ...rest,
    mapId: MVP_ARENA_02_ID,
    version: 1,
    meta: { ...base.meta, name: "Arena MVP 02", supportedModes: [...MVP_ARENA_02_MODES] },
  } as never) as unknown as {
    mapId: string;
    version: number;
    checksum: string;
    widthM: number;
    heightM: number;
    meta: { name: string; supportedModes: string[] };
  };
}
