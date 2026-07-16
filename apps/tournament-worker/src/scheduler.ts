/**
 * E9 · T9.2 — Materialización del calendario (flujo completo del 19.1).
 *
 * closeEntries (E7, routes/tournaments.ts) ya congeló inscripciones (versión de
 * bot + loadout juntos, cap. 17.2) y reveló el lote de semillas (commit-reveal,
 * T9.4). Este módulo consume el job `generate_schedule`:
 *
 *   1. valida mapa(s), reglas, catálogo y semillas reveladas (contra el hash
 *      publicado antes del cierre),
 *   2. genera los emparejamientos con los generadores PUROS de formats.ts,
 *   3. persiste matches (incluida la estructura dependiente de resultados) y
 *      crea las batallas de los emparejamientos ya resueltos, con:
 *      - semilla POR BATALLA derivada determinísticamente del lote revelado
 *        (verificable públicamente: sha256(lote | slot | juego)),
 *      - intercambio de lados en cada juego de la serie (T9.4),
 *      - la final marcada para modo visible (19.1 + E8.M),
 *   4. encola run_battle (idempotente por batalla) y pasa el torneo a running.
 *
 * El presupuesto (budgetCredits) es del torneo/ruleset (ADR-000/D7) y quedó
 * congelado con la inscripción: aquí solo se propaga, nunca se recalcula.
 */
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import {
  generateInitialSchedule,
  generateTeams,
  type Entrant,
  type Pairing,
  type TeamEntry,
  type TournamentFormat,
} from "./formats.js";
import { enqueueJob, type JobRow } from "./queue.js";
import type { HandlerContext } from "./worker.js";

// ------------------------------------------------------- commit-reveal (T9.4)

/** Compromiso del lote de semillas: se publica ANTES del cierre de inscripciones. */
export function commitSeedBatch(seeds: string[]): string {
  return createHash("sha256").update(seeds.join("|")).digest("hex");
}

/** Verificación pública: el hash publicado coincide con las semillas reveladas. */
export function verifySeedReveal(commitment: string, seeds: string[]): boolean {
  return commitSeedBatch(seeds) === commitment;
}

/**
 * Semilla de UNA batalla, derivada determinísticamente del lote revelado:
 * cualquiera puede recomputarla a partir de los datos públicos de auditoría.
 */
export function deriveBattleSeed(seeds: string[], slot: string, gameIndex: number): string {
  return createHash("sha256").update(`${seeds.join("|")}:${slot}:${gameIndex}`).digest("hex");
}

// ----------------------------------------------------------------- helpers BD

interface TournamentRow {
  id: string;
  format: TournamentFormat;
  mode: string;
  ruleset_id: string;
  budget_credits: number | null;
  catalog_version: string | null;
  map_pool: string[] | string;
  rounds_per_pairing: number | null;
  seed_commitment: string | null;
  seeds_revealed: string[] | string | null;
  state: string;
  season_id: string;
  elo_k: number;
}

export interface EntryInfo {
  botId: string;
  version: number;
  loadoutRevision: number;
  ownerId: string;
  teamId: string | null;
  name: string;
}

function asArray<T>(v: T[] | string | null | undefined): T[] {
  if (v == null) return [];
  return typeof v === "string" ? (JSON.parse(v) as T[]) : v;
}

async function loadEntries(db: Knex, tournamentId: string): Promise<EntryInfo[]> {
  const rows = await db("entries")
    .join("bots", "bots.id", "entries.bot_id")
    .where({ tournament_id: tournamentId })
    .orderBy("entries.created_at", "asc")
    .select("entries.*", "bots.owner_id", "bots.team_id", "bots.name");
  return rows.map((r: Record<string, unknown>) => ({
    botId: r.bot_id as string,
    version: r.version as number,
    loadoutRevision: r.loadout_revision as number,
    ownerId: r.owner_id as string,
    teamId: (r.team_id as string) ?? null,
    name: r.name as string,
  }));
}

/** Pool de mapas del torneo, validado: todos publicados. */
async function resolveMapPool(db: Knex, t: TournamentRow): Promise<{ mapId: string; version: number }[]> {
  const ids = asArray<string>(t.map_pool);
  const pool = ids.length > 0 ? ids : ["mvp-arena-01"];
  const resolved: { mapId: string; version: number }[] = [];
  for (const mapId of pool) {
    const mv = await db("map_versions").where({ map_id: mapId, state: "published" }).orderBy("version", "desc").first();
    if (!mv) throw new Error(`generate_schedule: el mapa '${mapId}' del pool no está publicado (validación 19.1)`);
    resolved.push({ mapId, version: mv.version as number });
  }
  return resolved;
}

/** Mapa determinista para un slot (rotación estable dentro del pool). */
function mapForSlot(pool: { mapId: string; version: number }[], slot: string): { mapId: string; version: number } {
  const h = createHash("sha256").update(slot).digest();
  return pool[h[0] % pool.length];
}

// ------------------------------------------------- materialización de batallas

export interface MaterializeContext {
  db: Knex;
  tournament: TournamentRow;
  entriesByBot: Map<string, EntryInfo>;
  teamsById: Map<string, TeamEntry>;
  seeds: string[];
  mapPool: { mapId: string; version: number }[];
}

/**
 * Crea las batallas de un match resuelto (ambos lados conocidos): una serie de
 * rounds_per_pairing juegos con INTERCAMBIO DE LADOS en cada juego (T9.4:
 * juego impar → local=A; juego par → local=B) y semilla commit-reveal.
 */
export async function materializeBattles(mctx: MaterializeContext, matchId: string, pairing: Pairing): Promise<string[]> {
  const { db, tournament: t } = mctx;
  const games = t.rounds_per_pairing ?? 1;
  const isTeams = t.format === "teams";
  const battleIds: string[] = [];

  const sideBots = (sideId: string): EntryInfo[] => {
    if (isTeams) {
      const team = mctx.teamsById.get(sideId);
      if (!team) throw new Error(`torneo por equipos: equipo desconocido ${sideId}`);
      return team.roster.map((botId) => mctx.entriesByBot.get(botId)!);
    }
    const e = mctx.entriesByBot.get(sideId);
    if (!e) throw new Error(`emparejamiento con bot no inscrito: ${sideId}`);
    return [e];
  };

  const home = sideBots(pairing.home!);
  const away = sideBots(pairing.away!);

  for (let g = 1; g <= games; g++) {
    const seed = deriveBattleSeed(mctx.seeds, pairing.slot, g);
    const map = mapForSlot(mctx.mapPool, `${pairing.slot}#${g}`);
    const [battle] = await db("battles")
      .insert({
        tournament_id: t.id,
        match_id: matchId,
        status: "scheduled",
        official: true, // batalla de torneo: SÍ afecta al rating (T9.3)
        mode: t.mode,
        ruleset_id: t.ruleset_id,
        map_id: map.mapId,
        map_version: map.version,
        seed,
        seed_commitment: t.seed_commitment,
        seed_reveal_proof: JSON.stringify({ batch: mctx.seeds, slot: pairing.slot, gameIndex: g }),
        game_index: g,
        spectator_mode: pairing.final ? "visible" : "delayed", // 19.1 + E8.M
      })
      .returning("id");
    // Intercambio de lados: en juegos impares el local es el equipo A del
    // motor; en pares, el B. Así cada emparejamiento juega el mismo número de
    // veces por lado (con rounds_per_pairing par; test de T9.4).
    const homeTeam = g % 2 === 1 ? "A" : "B";
    const awayTeam = g % 2 === 1 ? "B" : "A";
    await db("participants").insert([
      ...home.map((e) => ({ battle_id: battle.id, bot_id: e.botId, version: e.version, team: homeTeam })),
      ...away.map((e) => ({ battle_id: battle.id, bot_id: e.botId, version: e.version, team: awayTeam })),
    ]);
    await enqueueJob(db, "run_battle", { battleId: battle.id }, { dedupeKey: `run_battle:${battle.id}` });
    battleIds.push(battle.id as string);
  }
  return battleIds;
}

/** Reconstruye el contexto de materialización desde la BD (lo usa process_result). */
export async function buildMaterializeContext(db: Knex, tournamentId: string): Promise<MaterializeContext> {
  const tournament = (await db("tournaments").where({ id: tournamentId }).first()) as TournamentRow;
  if (!tournament) throw new Error(`torneo inexistente: ${tournamentId}`);
  const entries = await loadEntries(db, tournamentId);
  const entriesByBot = new Map(entries.map((e) => [e.botId, e]));
  const teamsById = new Map<string, TeamEntry>();
  for (const e of entries) {
    if (!e.teamId) continue;
    const team = teamsById.get(e.teamId) ?? { teamId: e.teamId, roster: [] };
    team.roster.push(e.botId);
    teamsById.set(e.teamId, team);
  }
  return {
    db,
    tournament,
    entriesByBot,
    teamsById,
    seeds: asArray<string>(tournament.seeds_revealed),
    mapPool: await resolveMapPool(db, tournament),
  };
}

// ------------------------------------------------------------ generate_schedule

/**
 * Handler del job `generate_schedule` (encolado por closeEntries de E7).
 * Idempotente: si el torneo ya está en running (calendario creado), no-op.
 */
export async function handleGenerateSchedule(job: JobRow, ctx: HandlerContext): Promise<void> {
  const db = ctx.db;
  const tournamentId = String(job.payload.tournamentId ?? "");
  const t = (await db("tournaments").where({ id: tournamentId }).first()) as TournamentRow | undefined;
  if (!t) throw new Error(`generate_schedule: torneo ${tournamentId} inexistente`);
  if (t.state === "running" || t.state === "finished") return; // idempotencia
  if (t.state !== "closed") throw new Error(`generate_schedule: el torneo está en estado '${t.state}', no 'closed'`);

  // --- Validaciones del 19.1: reglas, catálogo, mapas y semillas -------------
  if (!(await db("rulesets").where({ id: t.ruleset_id }).first())) {
    throw new Error(`generate_schedule: ruleset '${t.ruleset_id}' inexistente`);
  }
  // Catálogo CONGELADO del torneo (T9.4): si no se fijó al crear, se fija AHORA
  // a la versión vigente; los cambios de catálogo posteriores no afectan.
  let catalogVersion = t.catalog_version;
  if (!catalogVersion) {
    const latest = await db("catalog_versions").orderBy("imported_at", "desc").first();
    if (!latest) throw new Error("generate_schedule: no hay catálogo importado");
    catalogVersion = latest.catalog_version as string;
    await db("tournaments").where({ id: t.id }).update({ catalog_version: catalogVersion });
    t.catalog_version = catalogVersion;
  }
  const seeds = asArray<string>(t.seeds_revealed);
  if (seeds.length === 0) throw new Error("generate_schedule: torneo sin semillas reveladas (cierre incompleto)");
  if (t.seed_commitment && !verifySeedReveal(t.seed_commitment, seeds)) {
    throw new Error("generate_schedule: las semillas reveladas NO casan con el compromiso publicado (T9.4)");
  }

  const mctx = await buildMaterializeContext(db, tournamentId);
  mctx.tournament.catalog_version = catalogVersion;
  const entries = [...mctx.entriesByBot.values()];

  // --- Emparejamientos con los generadores puros -----------------------------
  let pairings: Pairing[];
  if (t.format === "teams") {
    if (mctx.teamsById.size < 2) throw new Error("torneo por equipos: hacen falta al menos 2 equipos con plantilla");
    pairings = generateTeams([...mctx.teamsById.values()]);
  } else {
    if (entries.length < 2) throw new Error("generate_schedule: hacen falta al menos 2 inscritos");
    const entrants: Entrant[] = entries.map((e, i) => ({ id: e.botId, seed: i + 1, ownerId: e.ownerId }));
    pairings = generateInitialSchedule(t.format, entrants);
  }

  // --- Persistencia: matches (toda la estructura) + batallas resueltas -------
  const matchIdBySlot = new Map<string, string>();
  for (const p of pairings) {
    const [m] = await db("matches")
      .insert({
        tournament_id: t.id,
        round: p.round,
        state: "scheduled",
        slot: p.slot,
        final: p.final ?? false,
        pairing: JSON.stringify(p),
      })
      .returning("id");
    matchIdBySlot.set(p.slot, m.id as string);
  }

  for (const p of pairings) {
    const matchId = matchIdBySlot.get(p.slot)!;
    if (p.bye) {
      // Descanso: el match se resuelve sin batalla (el que descansa "gana").
      await db("matches")
        .where({ id: matchId })
        .update({
          state: "finished",
          winner_bot_id: t.format === "teams" ? null : p.home,
          winner_team_id: t.format === "teams" ? p.home : null,
        });
      continue;
    }
    if (p.home && p.away) await materializeBattles(mctx, matchId, p);
  }

  await db("tournaments").where({ id: t.id }).update({ state: "running" });

  // Los byes ya resueltos pueden desbloquear matches dependientes (brackets).
  const { resolveDependents } = await import("./results.js");
  for (const p of pairings) {
    if (p.bye) await resolveDependents(mctx, p.slot);
  }
}

// ------------------------------------------------------------ tournament_dry_run

/**
 * E9.M · modo simulacro: valida el torneo de punta a punta SIN escribir nada
 * (ni batallas, ni ratings): genera el calendario en memoria con los inscritos
 * (o con 8 bots de ejemplo si no hay) y simula resultados con las semillas
 * commit-reveal. El informe queda en el payload del propio job.
 */
export async function handleTournamentDryRun(job: JobRow, ctx: HandlerContext): Promise<void> {
  const db = ctx.db;
  const tournamentId = String(job.payload.tournamentId ?? "");
  const t = (await db("tournaments").where({ id: tournamentId }).first()) as TournamentRow | undefined;
  if (!t) throw new Error(`tournament_dry_run: torneo ${tournamentId} inexistente`);

  const entries = await loadEntries(db, tournamentId);
  const entrants: Entrant[] =
    entries.length >= 2
      ? entries.map((e, i) => ({ id: e.botId, seed: i + 1, ownerId: e.ownerId }))
      : Array.from({ length: 8 }, (_, i) => ({ id: `example-bot-${i + 1}`, seed: i + 1 }));

  const seeds = asArray<string>(t.seeds_revealed);
  const simSeeds = seeds.length > 0 ? seeds : ["dry-run-seed"];
  const format: TournamentFormat = t.format === "teams" ? "round_robin" : t.format;
  const pairings = generateInitialSchedule(format, entrants);

  // Simulación determinista: gana el lado que dicte la semilla derivada.
  const resolved = new Map<string, { winner: string; loser: string }>();
  const pending = [...pairings];
  let simulated = 0;
  let guard = pairings.length * 4;
  while (pending.length > 0 && guard-- > 0) {
    const p = pending.shift()!;
    let home = p.home ?? (p.homeSource ? resolved.get(p.homeSource.slot)?.[p.homeSource.take] ?? null : null);
    let away = p.away ?? (p.awaySource ? resolved.get(p.awaySource.slot)?.[p.awaySource.take] ?? null : null);
    if (p.bye && home) {
      resolved.set(p.slot, { winner: home, loser: home });
      continue;
    }
    if (!home || !away) {
      pending.push(p);
      continue;
    }
    const h = deriveBattleSeed(simSeeds, p.slot, 1);
    const homeWins = parseInt(h.slice(0, 2), 16) % 2 === 0;
    resolved.set(p.slot, { winner: homeWins ? home : away, loser: homeWins ? away : home });
    simulated++;
  }

  const finalPairing = pairings.find((p) => p.final);
  const report = {
    ok: pending.length === 0,
    format: t.format,
    entrants: entrants.length,
    matches: pairings.length,
    simulatedBattles: simulated,
    champion: finalPairing ? resolved.get(finalPairing.slot)?.winner ?? null : null,
    usedExampleBots: entries.length < 2,
    at: new Date().toISOString(),
  };
  await db("jobs")
    .where({ id: job.id })
    .update({ payload: JSON.stringify({ ...job.payload, report }) });
}
