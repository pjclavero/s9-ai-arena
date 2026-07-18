/**
 * T7.3 · Dominio de bots: visibilidad de objeto, máquina de estados 17.1 y
 * revisiones de loadout validadas SIEMPRE en servidor con el validador de E3.
 */
import type { Db } from "../db/connection.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { ROLE_RANK } from "../openapi.js";
import { audit } from "../audit.js";
// Validador y resolutor REALES de E3 (T3.2/T3.3): importados, no reescritos.
import { validateLoadout, type Violation } from "../../../../packages/module-catalog/validator/index.js";
import { resolveVehicle } from "../../../../packages/module-catalog/resolve/index.js";
import {
  findModule,
  splitVersioned,
  type LoadoutInput as E3LoadoutInput,
  type ModuleDefinition,
} from "../../../../packages/module-catalog/types.js";
import { getCatalog } from "./catalog.js";
import { CATALOG_VERSION } from "../../../../packages/module-catalog/loadCatalog.js";
import { DEFAULT_RULESET_ID } from "../db/seeds/dev.js";

export type Auth = { userId: string; sessionId: string; roles: string[]; rank: number } | undefined;

export const isStaff = (auth: Auth): boolean => !!auth && auth.rank >= ROLE_RANK.moderator;

// ------------------------------------------------------------- visibilidad

export async function canSeeBot(db: Db, auth: Auth, bot: Record<string, unknown>): Promise<boolean> {
  if (bot.visibility === "public") return true;
  if (!auth) return false;
  if (auth.userId === bot.owner_id || isStaff(auth)) return true;
  if (bot.visibility === "team" && bot.team_id) {
    const member = await db("team_members").where({ team_id: bot.team_id, user_id: auth.userId }).first();
    return !!member;
  }
  return false;
}

/** 404 si no existe O no es visible (no revelar existencia de bots privados). */
export async function getVisibleBot(db: Db, auth: Auth, botId: string): Promise<Record<string, unknown>> {
  const bot = await db("bots")
    .where({ id: botId })
    .first()
    .catch(() => null);
  if (!bot || !(await canSeeBot(db, auth, bot))) throw notFound();
  return bot;
}

export function assertOwner(auth: Auth, bot: Record<string, unknown>, allowStaff = false): void {
  if (!auth) throw forbidden();
  if (auth.userId === bot.owner_id) return;
  if (allowStaff && isStaff(auth)) return;
  throw forbidden("Solo el dueño del bot puede hacer esto");
}

// -------------------------------------------------------- máquina de estados

export type BotState =
  "draft" | "validating" | "rejected" | "validated" | "published" | "frozen" | "suspended" | "retired";

/** Transiciones legales del capítulo 17.1. La acción es la clave de la API. */
export const TRANSITIONS: Record<string, { from: BotState[]; to: BotState }> = {
  submit: { from: ["draft", "rejected"], to: "validating" },
  validate: { from: ["validating"], to: "validated" }, // interna (bot-manager)
  reject: { from: ["validating"], to: "rejected" }, // interna (bot-manager)
  publish: { from: ["validated"], to: "published" },
  freeze: { from: ["published"], to: "frozen" }, // interna (cierre de inscripciones, E9)
  retire: { from: ["published"], to: "retired" },
  suspend: { from: ["draft", "validating", "rejected", "validated", "published", "frozen"], to: "suspended" },
};

export function allowedTransitionsFrom(state: BotState): string[] {
  return Object.entries(TRANSITIONS)
    .filter(([, t]) => t.from.includes(state))
    .map(([name]) => name);
}

export function assertTransition(action: string, current: BotState): BotState {
  const t = TRANSITIONS[action];
  if (!t || !t.from.includes(current)) {
    throw conflict("illegal_transition", `Transición ilegal: ${action} desde ${current}`, {
      currentState: current,
      allowedTransitions: allowedTransitionsFrom(current),
    });
  }
  return t.to;
}

export async function applyTransition(
  db: Db,
  auth: Auth,
  version: Record<string, unknown>,
  action: string,
  patch: Record<string, unknown> = {},
  correlationId?: string,
): Promise<Record<string, unknown>> {
  const to = assertTransition(action, version.state as BotState);
  const [updated] = await db("bot_versions")
    .where({ id: version.id })
    .update({ state: to, ...patch })
    .returning("*");
  // Toda transición legal queda auditada (DoD T7.3).
  await audit(db, {
    actorId: auth?.userId ?? null,
    action: `bot.version.${action}`,
    target: `bot:${version.bot_id}@${version.version}`,
    detail: { from: version.state, to },
    correlationId,
  });
  return updated;
}

// ----------------------------------------------------------------- loadouts

export interface LoadoutValidationResult {
  violations: Violation[];
  summary?: { massKg: number; costCredits: number; energyBalanceEUs: number };
  catalog: ModuleDefinition[];
}

/**
 * Ejecuta el validador de E3 en servidor (cap. 17.2 / openapi createLoadoutRevision).
 * budgetCredits sale del ruleset (ADR-000/D7: siempre configurable por ruleset).
 */
export async function validateLoadoutServerSide(
  db: Db,
  input: { catalogVersion?: string; chassis: string; modules: { slot: string; moduleId: string; ammo?: string }[] },
  rulesetId: string = DEFAULT_RULESET_ID,
): Promise<LoadoutValidationResult> {
  const catalogVersion = input.catalogVersion ?? CATALOG_VERSION;
  const catalog = await getCatalog(db, catalogVersion);
  if (catalog.length === 0) {
    return {
      violations: [{ code: "incompatible_chassis", message: `Catálogo desconocido: ${catalogVersion}` }],
      catalog,
    };
  }
  const ruleset = await db("rulesets").where({ id: rulesetId }).first();
  if (!ruleset) throw notFound(`Ruleset desconocido: ${rulesetId}`);

  const e3Input: E3LoadoutInput = {
    loadoutId: "candidate",
    revision: 1,
    catalogVersion,
    chassis: input.chassis,
    modules: input.modules,
  };
  const violations = validateLoadout(
    e3Input,
    catalog,
    ruleset.budget_credits,
    Array.isArray(ruleset.forbidden_categories)
      ? ruleset.forbidden_categories
      : JSON.parse(ruleset.forbidden_categories ?? "[]"),
  );
  if (violations.length > 0) return { violations, catalog };

  const spec = resolveVehicle(e3Input, catalog);
  const defs = [findModule(catalog, input.chassis)!, ...input.modules.map((m) => findModule(catalog, m.moduleId)!)];
  const costCredits = defs.reduce((s, d) => s + d.costCredits, 0);
  const generation = defs.filter((d) => d.category === "power").reduce((s, d) => s + (d.generationEUs ?? 0), 0);
  const passive = defs.reduce((s, d) => s + (d.power?.passiveEUs ?? 0), 0);
  return {
    violations: [],
    summary: { massKg: spec.massKg, costCredits, energyBalanceEUs: generation - passive },
    catalog,
  };
}

/** Crea una revisión nueva (nunca modifica las anteriores, cap. 17.2). */
export async function createLoadoutRevision(
  db: Db,
  botId: string,
  input: {
    name?: string;
    catalogVersion?: string;
    chassis: string;
    modules: { slot: string; moduleId: string; ammo?: string }[];
  },
  summary: { massKg: number; costCredits: number; energyBalanceEUs: number },
): Promise<Record<string, unknown>> {
  const catalogVersion = input.catalogVersion ?? CATALOG_VERSION;
  return db.transaction(async (trx) => {
    const max = await trx("bot_loadouts").where({ bot_id: botId }).max("revision as m").first();
    const revision = Number(max?.m ?? 0) + 1;
    const [loadout] = await trx("bot_loadouts")
      .insert({
        bot_id: botId,
        revision,
        name: input.name ?? null,
        catalog_version: catalogVersion,
        chassis: input.chassis,
        modules: JSON.stringify(input.modules),
        summary: JSON.stringify(summary),
      })
      .returning("*");

    // Referencias normalizadas para la restricción de integridad de T7.1.
    const refs = [{ slot: "__chassis__", id: input.chassis }];
    for (const m of input.modules) {
      refs.push({ slot: m.slot, id: m.moduleId });
      if (m.ammo) refs.push({ slot: `${m.slot}#ammo`, id: m.ammo });
    }
    await trx("loadout_modules").insert(
      refs.map((r) => {
        const { base, version } = splitVersioned(r.id);
        return {
          loadout_id: loadout.id,
          slot: r.slot,
          catalog_version: catalogVersion,
          module_id: base,
          module_version: version,
        };
      }),
    );
    return loadout;
  });
}
