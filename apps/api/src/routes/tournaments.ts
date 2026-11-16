/**
 * T7.5 · Torneos: creación (organizador), inscripción que congela código+loadout
 * juntos (cap. 17.2) y cierre de inscripciones (congela versiones y revela semillas).
 * La generación del calendario y la ejecución son de E9 — pendiente de reconciliación.
 */
import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/connection.js";
import { defineOperation, defineExtension } from "../registry.js";
import { battleToJson, loadParticipants } from "./battles.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { applyCursor, cursorTsSql, decodeCursor, encodeCursor, parseLimit, runCursorQuery } from "../serialize.js";
import { applyTransition } from "../services/bots.js";
import {
  assertTournamentEligible,
  assertVersionsEligible,
  canonicalUuid,
  eligibilityKey,
  entryEligibilityGate,
  excludeTournamentEntry,
  isCompetitionState,
  replaceIneligibleEntry,
} from "../services/version-eligibility.js";
import { ROLE_RANK } from "../openapi.js";
import { pathParam } from "../params.js";
// H6 (issue #10) · La tabla por equipos es la de E9; se importa, no se duplica.
import { leagueTable } from "../../../tournament-worker/src/results.js";
import { hiddenBotIds, whereBattleReadable, type BattleVisibility } from "../battle-access.js";
import { buildTournamentRules, rulesOf, rulesToJson } from "../services/battle-rules.js";
import { ApiError } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #287 · Tamaño de equipo de un torneo `teams` con reglas NvN (copia inmutable ADR-022), o
 * `null` si el torneo no es por equipos o es `classic` (sin `params`: no fija tamaño).
 */
export function teamSizeOf(t: Record<string, unknown>): number | null {
  if (t.format !== "teams") return null;
  const n = rulesOf(t)?.params?.teamSize;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * ADR-022 · Con reglas NvN, cada equipo inscrito debe tener exactamente N bots al cerrar
 * inscripciones (las batallas del torneo enfrentan rosters completos).
 *
 * #287 · REVALIDACIÓN AL CIERRE. El equipo de una inscripción es el EFECTIVO:
 * `entries.team_id` (con el que se inscribió el equipo completo) o, en inscripciones
 * anteriores a la 022 (NULL), `bots.team_id` como siempre — el mismo que usa el scheduler.
 * Antes del tamaño se comprueba la PERTENENCIA: un bot inscrito con su equipo que ya no está
 * en él (o que se retiró), o una inscripción sin ningún equipo, bloquean el cierre con 409
 * `team_roster_changed`. Sólo ids de inscripción y de equipo: el organizador no ve los bots
 * privados ajenos.
 */
async function assertRostersFitRules(db: Db, t: Record<string, unknown>): Promise<void> {
  const snapshot = rulesOf(t);
  if (!snapshot?.params || t.format !== "teams") return;
  const n = snapshot.params.teamSize;
  const rows = (await db("entries")
    .join("bots", "bots.id", "entries.bot_id")
    .where({ "entries.tournament_id": t.id as string })
    .select("entries.id", "entries.team_id as entered_team_id", "bots.team_id as bot_team_id", "bots.retired_at")) as {
    id: string;
    entered_team_id: string | null;
    bot_team_id: string | null;
    retired_at: unknown;
  }[];
  const changed = rows.filter((e) =>
    e.entered_team_id ? e.bot_team_id !== e.entered_team_id || !!e.retired_at : !e.bot_team_id,
  );
  if (changed.length > 0) {
    throw new ApiError(
      409,
      "team_roster_changed",
      `${changed.length} inscripción(es) ya no pertenecen al equipo con el que se inscribieron (el bot salió del equipo, cambió de equipo o se retiró). El equipo debe retirarse o reinscribirse completo antes de cerrar.`,
      { changedEntries: changed.map((e) => ({ entryId: e.id, teamId: e.entered_team_id ?? null })) },
    );
  }
  const rosters = new Map<string, number>();
  for (const e of rows) {
    const team = e.entered_team_id ?? e.bot_team_id;
    if (team) rosters.set(team, (rosters.get(team) ?? 0) + 1);
  }
  const bad = [...rosters].filter(([, k]) => k !== n);
  if (bad.length > 0) {
    throw new ApiError(
      409,
      "rules_team_size",
      `${snapshot.name} ${n} contra ${n}: equipos con otro número de bots inscritos: ${bad.map(([id, k]) => `${id} (${k})`).join(", ")}`,
      { teamSize: n },
    );
  }
}

const FORMATS = ["league", "round_robin", "single_elimination", "double_elimination", "swiss", "teams"];
const MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];

export function tournamentToJson(t: Record<string, unknown>) {
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    mode: t.mode,
    rulesetId: t.ruleset_id,
    budgetCredits: t.budget_credits ?? undefined,
    catalogVersion: t.catalog_version ?? undefined,
    mapPool: t.map_pool ?? [],
    roundsPerPairing: t.rounds_per_pairing ?? undefined,
    entriesCloseAt: t.entries_close_at ? (t.entries_close_at as Date).toISOString() : undefined,
    seedCommitment: t.seed_commitment ?? undefined,
    seedsRevealed: t.seeds_revealed ?? undefined,
    state: t.state,
    // VISIBILIDAD · el torneo autoriza su retransmisión pública (fijado al crearlo).
    broadcast: t.broadcast === true,
    // ADR-022 · copia inmutable de las reglas (ausente en torneos anteriores).
    rules: rulesToJson(rulesOf(t)),
  };
}

/**
 * R12 (slice 1) · Mapper explícito de una fila de `matches` (proyección pública del cuadro).
 *
 * UX-F (DEF-R3) · `hidden` = bots que el solicitante NO puede identificar
 * (battle-access.ts). Un bot privado ajeno sale como `null` en el emparejamiento
 * y en el ganador, con `winnerPrivate: true` para que el cuadro diga «bot
 * privado» sin revelar quién es. Sin `hidden` (llamadas internas), todo tal cual.
 * En torneos de equipos `home`/`away` son equipos, no bots: no se tocan.
 */
export function tournamentMatchToJson(
  m: Record<string, unknown>,
  hidden?: Set<string>,
  isTeams = false,
  names?: Map<string, string>,
) {
  const hide = (id: unknown) => hidden !== undefined && typeof id === "string" && hidden.has(id);
  let pairing = (m.pairing ?? {}) as Record<string, unknown>;
  if (typeof pairing === "string") pairing = JSON.parse(pairing);
  if (!isTeams && (hide(pairing.home) || hide(pairing.away))) {
    pairing = {
      ...pairing,
      ...(hide(pairing.home) ? { home: null, homePrivate: true } : {}),
      ...(hide(pairing.away) ? { away: null, awayPrivate: true } : {}),
    };
  }
  const winnerHidden = hide(m.winner_bot_id);
  // VISIBILIDAD-3 (P3-6) · «bracket con nombre» (§13): nombre ACTUAL del bot (no hay
  // instantánea, §25), sólo si el solicitante puede identificarlo; oculto ⇒ nada.
  const winnerName = !winnerHidden && typeof m.winner_bot_id === "string" ? names?.get(m.winner_bot_id) : undefined;
  return {
    id: m.id,
    round: m.round,
    slot: m.slot ?? null,
    pairing,
    state: m.state,
    winnerBotId: winnerHidden ? null : (m.winner_bot_id ?? null),
    ...(winnerHidden ? { winnerPrivate: true } : {}),
    ...(winnerName !== undefined ? { winnerBotName: winnerName } : {}),
    winnerTeamId: m.winner_team_id ?? null,
    final: m.final,
  };
}

/** Ids de bot que nombra una fila de `matches` (emparejamiento y ganador). */
function botIdsOfMatch(m: Record<string, unknown>): unknown[] {
  let pairing = (m.pairing ?? {}) as Record<string, unknown>;
  if (typeof pairing === "string") pairing = JSON.parse(pairing);
  return [pairing.home, pairing.away, m.winner_bot_id];
}

const NO_STORE = "private, no-store";

export function tournamentRoutes(
  db: Db,
  // MG · visibilidad fija (tests) o getter de los ajustes de runtime: se lee por petición.
  visibility: BattleVisibility | (() => BattleVisibility) = { publicReplays: false, publicSpectate: false },
): Router {
  const router = Router();
  const vis = (): BattleVisibility => (typeof visibility === "function" ? visibility() : visibility);

  defineOperation(router, "listTournaments", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    let q = db("tournaments")
      .select("tournaments.*", db.raw(cursorTsSql("tournaments.created_at")))
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(limit + 1);
    q = applyCursor(q, cursor, "tournaments.created_at", ["tournaments.id"]);
    const rows = await runCursorQuery(q, cursor);
    const page = rows.slice(0, limit);
    res.json({
      items: page.map(tournamentToJson),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1], [page[page.length - 1].id]) : undefined,
    });
  });

  defineOperation(router, "createTournament", async (req, res) => {
    const {
      name,
      format,
      mode,
      rulesetId,
      budgetCredits,
      catalogVersion,
      mapPool,
      roundsPerPairing,
      entriesCloseAt,
      seedCommitment,
      rules,
      broadcast,
    } = req.body ?? {};
    if (typeof name !== "string" || !name || name.length > 64) throw badRequest("name obligatorio (máx. 64)");
    if (!FORMATS.includes(format)) throw badRequest(`format debe ser uno de ${FORMATS.join(", ")}`);
    if (!MODES.includes(mode)) throw badRequest(`mode debe ser uno de ${MODES.join(", ")}`);
    if (!(await db("rulesets").where({ id: rulesetId }).first())) throw badRequest("rulesetId desconocido");
    // ADR-000/D7: presupuesto por competición dentro de [200, 5000]; si se omite, manda el ruleset.
    if (
      budgetCredits !== undefined &&
      !(Number.isInteger(budgetCredits) && budgetCredits >= 200 && budgetCredits <= 5000)
    ) {
      throw badRequest("budgetCredits debe ser un entero en [200, 5000]");
    }
    // VISIBILIDAD · autorización de retransmisión: del TORNEO, nunca del bot. Se fija aquí y
    // no cambia (no hay edición de torneos): quien inscribe un bot lo sabe de antemano.
    if (broadcast !== undefined && typeof broadcast !== "boolean") throw badRequest("broadcast debe ser true o false");
    // ADR-022 · COPIA INMUTABLE de las reglas del torneo (preset, personalizado o clásico).
    // El scheduler la copia en cada batalla: nada posterior la reinterpreta.
    const snapshot = await buildTournamentRules(db, {
      mode,
      rulesetId,
      format,
      rules,
      budgetCredits: budgetCredits ?? null,
      catalogVersion: catalogVersion ?? null,
    });
    const [t] = await db("tournaments")
      .insert({
        name,
        format,
        mode,
        rules: snapshot ? JSON.stringify(snapshot) : null,
        ruleset_id: rulesetId,
        budget_credits: budgetCredits ?? null,
        catalog_version: catalogVersion ?? null,
        map_pool: JSON.stringify(mapPool ?? []),
        rounds_per_pairing: roundsPerPairing ?? null,
        entries_close_at: entriesCloseAt ?? null,
        seed_commitment: seedCommitment ?? null,
        state: "open",
        broadcast: broadcast === true,
        created_by: req.auth!.userId,
      })
      .returning("*");
    await audit(db, {
      actorId: req.auth!.userId,
      action: "tournament.created",
      target: `tournament:${t.id}`,
      detail: { broadcast: t.broadcast === true },
      correlationId: req.correlationId,
    });
    res.status(201).json(tournamentToJson(t));
  });

  /**
   * R3.7 (ERR-VIS-02) · Extensiones de lectura para el panel: el contrato de E1
   * no tenía ni el detalle de un torneo ni sus batallas, así que la UI no podía
   * "seguir" un torneo (cola, en curso, cuadro) sin teclear UUIDs a mano.
   */
  defineExtension(
    router,
    { operationId: "getTournament", method: "get", path: "/tournaments/{tournamentId}", minRole: "visitor" },
    async (req, res) => {
      const t = await db("tournaments")
        .where({ id: req.params.tournamentId })
        .first()
        .catch(() => null);
      if (!t) throw notFound();
      const entries = await db("entries").where({ tournament_id: t.id }).count("* as n").first();
      res.json({ ...tournamentToJson(t), entryCount: Number(entries?.n ?? 0) });
    },
  );

  defineExtension(
    router,
    {
      operationId: "listTournamentBattles",
      method: "get",
      path: "/tournaments/{tournamentId}/battles",
      minRole: "visitor",
    },
    async (req, res) => {
      const t = await db("tournaments")
        .where({ id: req.params.tournamentId })
        .first()
        .catch(() => null);
      if (!t) throw notFound();
      // UX-F (DEF-R3) · la MISMA política que GET /battles (battle-access.ts): antes
      // un anónimo veía aquí botId, versión, resultado y nombre de bots privados.
      const battles = await whereBattleReadable(
        db,
        db("battles").where("battles.tournament_id", t.id).select("battles.*"),
        req.auth,
        vis(),
      ).orderBy("battles.created_at", "asc");
      const matches = await db("matches").where({ tournament_id: t.id });
      const roundByMatch = new Map(matches.map((m: Record<string, unknown>) => [m.id as string, Number(m.round)]));
      const items = await Promise.all(
        battles.map(async (b: Record<string, unknown>) => ({
          // UX-D · con nombre de bot (la UI no enseña UUIDs). Sin `viewer`: el
          // listado del torneo nunca lleva CPU ni diagnóstico.
          ...battleToJson(b, await loadParticipants(db, b.id as string)),
          round: b.match_id ? (roundByMatch.get(b.match_id as string) ?? 1) : 1,
        })),
      );
      // Depende de quién pregunta: nunca en una caché compartida.
      res.setHeader("Cache-Control", NO_STORE);
      res.json({ items });
    },
  );

  defineOperation(router, "enterTournament", async (req, res) => {
    const t = await db("tournaments")
      .where({ id: req.params.tournamentId })
      .first()
      .catch(() => null);
    if (!t) throw notFound();
    if (t.state !== "open") throw conflict("entries_closed", "Las inscripciones no están abiertas");
    const { botId, version } = req.body ?? {};
    const bot = await db("bots")
      .where({ id: botId })
      .first()
      .catch(() => null);
    if (!bot) throw badRequest("botId desconocido");
    if (bot.owner_id !== req.auth!.userId) throw forbidden("Solo el dueño inscribe su bot");
    const v = await db("bot_versions").where({ bot_id: botId, version }).first();
    // FROZEN-REUSE (B2-B4) · `published` o `frozen` (congelada por un torneo anterior:
    // inmutable, NO «usada una vez») y elegible con el validador actual. La versión se
    // inscribe TAL CUAL: ni se clona, ni se republica, ni se descongela.
    await assertTournamentEligible(db, v);
    // ELIG · H8: publicada ≠ elegible; y una inscripción pendiente con una versión que
    // ya no lo es se puede cambiar por otra válida (nunca se sustituye sola).
    const replaced = await replaceIneligibleEntry(db, req.auth!.userId, t, v, req.correlationId);
    if (replaced) {
      res.status(200).json(replaced);
      return;
    }
    if (await db("entries").where({ tournament_id: t.id, bot_id: botId }).first()) {
      throw conflict("already_entered", "El bot ya está inscrito en este torneo");
    }
    // #287 · En un torneo por equipos con tamaño (NvN) la unidad de inscripción es el EQUIPO
    // completo (enterTournamentTeam, atómica): un bot suelto montaría equipos a medias. La
    // sustitución de una versión pendiente no elegible (arriba) sí sigue valiendo aquí.
    if (teamSizeOf(t) !== null) {
      throw conflict(
        "team_enrollment_required",
        "En este torneo por equipos se inscribe el equipo completo (Inscribir equipo), no bot a bot",
      );
    }
    // Congela la COMBINACIÓN exacta código+loadout (cap. 17.2).
    const [entry] = await db("entries")
      .insert({
        tournament_id: t.id,
        bot_id: botId,
        version,
        loadout_revision: v.loadout_revision,
        frozen: false,
      })
      .returning("*");
    res.status(201).json({
      id: entry.id,
      tournamentId: t.id,
      botId,
      version,
      loadoutRevision: entry.loadout_revision,
      frozen: entry.frozen,
    });
  });

  /**
   * #287 · Inscripción de un EQUIPO COMPLETO en un torneo `teams` con reglas NvN.
   * `{ teamId, members: [{ botId, version }] }`. TODO en UNA transacción, con el torneo
   * bloqueado (`FOR UPDATE`: serializa con otras inscripciones y con el cierre) y los bots
   * del roster bloqueados (un `removeTeamBot` concurrente espera): o entran los N bots o no
   * entra ninguno. Comprobaciones, en este orden:
   *  - torneo abierto, formato `teams` y tamaño definido por sus reglas;
   *  - quien pide es miembro del equipo;
   *  - exactamente N bots distintos;
   *  - cada bot pertenece DE VERDAD al equipo (`bots.team_id`), es del solicitante (la misma
   *    regla que la inscripción individual: «sólo el dueño inscribe su bot») y no está retirado;
   *  - cada versión está en estado de competición (`isCompetitionState`: published|frozen) y su
   *    loadout es elegible (`assertVersionsEligible`): la regla ÚNICA de #283, sin duplicar;
   *  - ni el equipo ni ninguno de sus bots están ya inscritos.
   * Cada entrada congela su combinación exacta código+loadout (cap. 17.2) y guarda el equipo
   * (`entries.team_id`, migración 022) para revalidar la pertenencia al cerrar. No cambia la
   * visibilidad del bot, la de su código ni su dueño.
   */
  defineOperation(router, "enterTournamentTeam", async (req, res) => {
    const userId = req.auth!.userId;
    const tournamentId = pathParam(req, "tournamentId");
    if (!UUID_RE.test(tournamentId)) throw notFound();
    const { teamId, members } = req.body ?? {};
    if (typeof teamId !== "string" || !UUID_RE.test(teamId)) throw badRequest("teamId obligatorio");
    if (
      !Array.isArray(members) ||
      members.length === 0 ||
      members.length > 16 ||
      members.some(
        (m: unknown) =>
          !m ||
          typeof (m as { botId?: unknown }).botId !== "string" ||
          !UUID_RE.test((m as { botId: string }).botId) ||
          !Number.isInteger((m as { version?: unknown }).version),
      )
    ) {
      throw badRequest("members debe ser una lista de { botId, version }");
    }
    const roster = (members as { botId: string; version: number }[]).map((m) => ({
      botId: canonicalUuid(m.botId),
      version: m.version,
    }));
    const ids = roster.map((m) => m.botId);
    if (new Set(ids).size !== ids.length) throw badRequest("members repite un bot");

    const out = await db.transaction(async (trx) => {
      const t = await trx("tournaments").where({ id: tournamentId }).forUpdate().first();
      if (!t) throw notFound();
      if (t.state !== "open") throw conflict("entries_closed", "Las inscripciones no están abiertas");
      if (t.format !== "teams") {
        throw conflict("not_a_team_tournament", "La inscripción por equipos sólo existe en torneos de formato 'teams'");
      }
      const n = teamSizeOf(t);
      if (n === null) {
        throw conflict(
          "team_size_undefined",
          "Las reglas de este torneo no fijan un tamaño de equipo: la inscripción por equipo no está disponible",
        );
      }
      const team = await trx("teams").where({ id: teamId }).first();
      if (!team) throw notFound("Equipo no encontrado");
      const member = await trx("team_members").where({ team_id: teamId, user_id: userId }).first();
      if (!member) throw forbidden("Sólo un miembro del equipo puede inscribirlo");
      if (roster.length !== n) {
        throw new ApiError(
          409,
          "rules_team_size",
          `${n} contra ${n}: el equipo debe inscribir exactamente ${n} bots (se enviaron ${roster.length})`,
          { teamSize: n, got: roster.length },
        );
      }
      const bots = (await trx("bots").whereIn("id", ids).forUpdate()) as Record<string, unknown>[];
      const byId = new Map(bots.map((b) => [String(b.id), b]));
      // Un bot inexistente o de otro equipo se responde igual: no se revela si existe.
      const notMember = ids.filter((id) => byId.get(id)?.team_id !== teamId);
      if (notMember.length > 0) {
        throw new ApiError(409, "team_bot_not_member", "Algún bot no pertenece a este equipo", { botIds: notMember });
      }
      const notOwned = ids.filter((id) => byId.get(id)!.owner_id !== userId);
      if (notOwned.length > 0) {
        throw new ApiError(
          403,
          "team_bot_not_owned",
          "Sólo el dueño inscribe su bot: algún bot del equipo es de otro miembro",
          { botIds: notOwned },
        );
      }
      const retired = ids.filter((id) => !!byId.get(id)!.retired_at);
      if (retired.length > 0) {
        throw new ApiError(409, "bot_retired", "Un bot retirado no se inscribe: reactívalo o elige otro", {
          botIds: retired,
        });
      }
      const vrows = (await trx("bot_versions").where((q) => {
        for (const m of roster) q.orWhere({ bot_id: m.botId, version: m.version });
      })) as Record<string, unknown>[];
      const vByKey = new Map(vrows.map((v) => [eligibilityKey(String(v.bot_id), Number(v.version)), v]));
      const notPublished = roster
        .map((m) => ({ ...m, v: vByKey.get(eligibilityKey(m.botId, m.version)) }))
        .filter((x) => !x.v || !isCompetitionState(x.v.state));
      if (notPublished.length > 0) {
        throw new ApiError(
          409,
          "bot_not_published",
          "Sólo se inscriben versiones publicadas o congeladas (frozen); algún miembro no tiene esa versión",
          {
            notPublished: notPublished.map((x) => ({
              botId: x.botId,
              version: x.version,
              ...(x.v ? { currentState: String(x.v.state) } : {}),
            })),
          },
        );
      }
      await assertVersionsEligible(trx, roster);
      if (await trx("entries").where({ tournament_id: t.id, team_id: teamId }).first()) {
        throw conflict("team_already_entered", "El equipo ya está inscrito en este torneo");
      }
      const already = (await trx("entries").where({ tournament_id: t.id }).whereIn("bot_id", ids)) as {
        bot_id: string;
      }[];
      if (already.length > 0) {
        throw new ApiError(409, "already_entered", "Algún bot del equipo ya está inscrito en este torneo", {
          botIds: already.map((e) => e.bot_id),
        });
      }
      // Una sola sentencia: o entran las N filas o ninguna (y la transacción envuelve el resto).
      const rows = (await trx("entries")
        .insert(
          roster.map((m) => ({
            tournament_id: t.id,
            bot_id: m.botId,
            version: m.version,
            loadout_revision: vByKey.get(eligibilityKey(m.botId, m.version))!.loadout_revision,
            team_id: teamId,
            frozen: false,
          })),
        )
        .returning("*")) as Record<string, unknown>[];
      await audit(trx, {
        actorId: userId,
        action: "tournament.team_entered",
        target: `tournament:${t.id}`,
        detail: { teamId, members: roster },
        correlationId: req.correlationId,
      });
      return { t, team, rows };
    });
    const order = new Map(ids.map((id, i) => [id, i]));
    res.status(201).json({
      tournamentId: out.t.id,
      teamId,
      teamName: out.team.name,
      entries: out.rows
        .sort((a, b) => order.get(String(a.bot_id))! - order.get(String(b.bot_id))!)
        .map((e) => ({
          id: e.id,
          tournamentId: out.t.id,
          botId: e.bot_id,
          version: e.version,
          loadoutRevision: e.loadout_revision,
          teamId: e.team_id,
          frozen: e.frozen,
        })),
    });
  });

  // ELIG · H8: excluir una inscripción pendiente (organizador: sólo no elegibles; dueño: la suya). Auditado.
  defineOperation(router, "excludeTournamentEntry", async (req, res) => {
    res.json(
      await excludeTournamentEntry(
        db,
        { userId: req.auth!.userId, isOrganizer: req.auth!.rank >= ROLE_RANK.organizer },
        pathParam(req, "tournamentId"),
        pathParam(req, "entryId"),
        req.body?.reason,
        req.correlationId,
      ),
    );
  });

  defineOperation(router, "closeEntries", async (req, res) => {
    const pre = await db("tournaments")
      .where({ id: req.params.tournamentId })
      .first()
      .catch(() => null);
    if (!pre) throw notFound();
    // #287 · El cierre entero va en UNA transacción con el torneo bloqueado (`FOR UPDATE`):
    // una inscripción concurrente (individual o de equipo) espera o ve el torneo cerrado, y
    // un 409 tardío (p. ej. seeds_required) ya no deja entradas o versiones congeladas con el
    // torneo abierto. Lo que se valida es exactamente lo que se congela.
    const updated = await db.transaction(async (trx) => {
      const t = await trx("tournaments").where({ id: pre.id }).forUpdate().first();
      if (t.state !== "open") {
        throw conflict("illegal_transition", `El torneo está en estado ${t.state}`, {
          currentState: t.state,
          allowedTransitions: t.state === "draft" ? ["open"] : [],
        });
      }

      const entries = (await trx("entries").where({ tournament_id: t.id })) as Record<string, unknown>[];
      // #287 · ESTADO de cada versión inscrita con la regla única (published|frozen): una
      // versión suspendida o retirada después de inscribirse ya no compite.
      const versions = new Map<string, Record<string, unknown>>();
      for (const e of entries) {
        versions.set(e.id as string, await trx("bot_versions").where({ bot_id: e.bot_id, version: e.version }).first());
      }
      const notCompeting = entries.filter((e) => !isCompetitionState(versions.get(e.id as string)?.state));
      if (notCompeting.length > 0) {
        throw new ApiError(
          409,
          "entries_not_eligible",
          `${notCompeting.length} inscripción(es) usan una versión que ya no está publicada ni congelada (suspendida o retirada). Sus dueños deben inscribir otra versión válida, o el organizador puede excluirlas, antes de cerrar.`,
          { notEligibleEntries: notCompeting.map((e) => ({ entryId: e.id })) },
        );
      }
      await entryEligibilityGate(trx, entries); // ELIG · H8: no se cierra con versiones no elegibles
      await assertRostersFitRules(trx, t); // ADR-022 · NvN del preset del torneo (+ #287 pertenencia)
      await trx("entries").where({ tournament_id: t.id }).update({ frozen: true });
      // Congela las versiones inscritas (published → frozen, cap. 17.1), auditado.
      // FROZEN-REUSE (B3) · IDEMPOTENTE: una versión que ya llegó `frozen` (de un torneo
      // anterior) no se toca — ni transición, ni auditoría, ni «descongelar y volver a
      // congelar». Nada en la plataforma descongela una versión al terminar un torneo.
      for (const e of entries) {
        const v = versions.get(e.id as string)!;
        if (v.state === "published") {
          await applyTransition(trx, req.auth, v, "freeze", {}, req.correlationId);
        }
      }
      // Commit-reveal de semillas (E9/T9.4): si el organizador publicó el hash
      // del lote ANTES del cierre (seedCommitment al crear el torneo), ahora
      // debe revelar las semillas que casan con él; ambos quedan en la BD y son
      // verificables públicamente (endpoint de auditoría). Sin compromiso
      // previo, el servidor genera lote y compromiso juntos (auto-commit).
      const revealed: string[] | null = Array.isArray(req.body?.seeds) ? req.body.seeds.map(String) : null;
      let seeds: string[];
      let commitment: string;
      if (t.seed_commitment) {
        if (!revealed || revealed.length === 0) {
          throw conflict("seeds_required", "El torneo publicó un compromiso: el cierre debe revelar las semillas");
        }
        commitment = t.seed_commitment;
        const proof = createHash("sha256").update(revealed.join("|")).digest("hex");
        if (proof !== commitment) {
          throw conflict("seed_reveal_mismatch", "Las semillas reveladas no casan con el compromiso publicado");
        }
        seeds = revealed;
      } else {
        seeds = Array.from({ length: 8 }, () => randomBytes(16).toString("hex"));
        commitment = createHash("sha256").update(seeds.join("|")).digest("hex");
      }
      const [row] = await trx("tournaments")
        .where({ id: t.id })
        .update({ state: "closed", seeds_revealed: JSON.stringify(seeds), seed_commitment: commitment })
        .returning("*");
      await trx("jobs").insert({
        kind: "generate_schedule",
        payload: JSON.stringify({ tournamentId: t.id, seedProof: commitment }),
        dedupe_key: `generate_schedule:${t.id}`,
      });
      await audit(trx, {
        actorId: req.auth!.userId,
        action: "tournament.entries_closed",
        target: `tournament:${t.id}`,
        detail: { entries: entries.length },
        correlationId: req.correlationId,
      });
      return row;
    });
    res.json(tournamentToJson(updated));
  });

  defineOperation(router, "dryRunTournament", async (req, res) => {
    const t = await db("tournaments")
      .where({ id: req.params.tournamentId })
      .first()
      .catch(() => null);
    if (!t) throw notFound();
    // Simulacro con bots de ejemplo (E9.M): lo consume el tournament-worker de E9.
    await db("jobs").insert({ kind: "tournament_dry_run", payload: JSON.stringify({ tournamentId: t.id }) });
    res.status(202).json({ status: "queued" });
  });

  /**
   * R12 (slice 1, solo lectura) · Cuadro del torneo: matches ordenados por
   * ronda/slot con su emparejamiento y ganador si ya lo tienen. Proyección
   * EXPLÍCITA de columnas (nada de SELECT *): sin seeds ni seed_commitment,
   * eso vive en `tournaments`, no en `matches`, y esta ruta no lo toca.
   */
  defineOperation(router, "listTournamentMatches", async (req, res) => {
    const t = await db("tournaments")
      .where({ id: req.params.tournamentId })
      .first()
      .catch(() => null);
    if (!t) throw notFound();
    const rows = await db("matches")
      .where({ tournament_id: t.id })
      .orderBy([
        { column: "round", order: "asc" },
        { column: "slot", order: "asc" },
      ])
      .select("id", "round", "slot", "pairing", "state", "winner_bot_id", "winner_team_id", "final");
    const isTeams = t.format === "teams";
    // VISIBILIDAD · en un torneo retransmisible los inscritos se identifican EN SU CUADRO
    // (BROADCAST_VISIBILITY): id y ganador de competición, nunca la ficha ni el código. En
    // los demás, un bot privado ajeno sigue saliendo como «Bot privado» (UX-F).
    // El contexto del torneo entra en `hiddenBotIds`: la regla vive en replay-access.ts.
    const hidden = await hiddenBotIds(
      db,
      req.auth,
      isTeams ? rows.map((m: Record<string, unknown>) => m.winner_bot_id) : rows.flatMap(botIdsOfMatch),
      { tournamentId: t.id },
    );
    // VISIBILIDAD-3 (P3-6) · nombres sólo de los ganadores que el solicitante puede
    // identificar (la misma `hidden`): la proyección de competición, nunca la ficha.
    const visibleWinners = [
      ...new Set(
        rows
          .map((m: Record<string, unknown>) => m.winner_bot_id)
          .filter((id: unknown): id is string => typeof id === "string" && !hidden.has(id)),
      ),
    ];
    const names = new Map<string, string>(
      visibleWinners.length === 0
        ? []
        : (await db("bots").whereIn("id", visibleWinners).select("id", "name")).map(
            (b: { id: string; name: string }) => [b.id, b.name] as [string, string],
          ),
    );
    res.setHeader("Cache-Control", NO_STORE);
    res.json({
      matches: rows.map((m: Record<string, unknown>) => tournamentMatchToJson(m, hidden, isTeams, names)),
    });
  });

  /**
   * H6 (issue #10) · Clasificación por EQUIPOS de un torneo `teams`: la tabla
   * de liga REAL de E9 (leagueTable con isTeams, desempates documentados en
   * formats.ts), que E7 dejó "pendiente de reconciliación si la API pública
   * quiere tabla por equipos". No se reimplementa: se importa.
   */
  defineOperation(router, "getTeamStandings", async (req, res) => {
    const t = await db("tournaments")
      .where({ id: req.params.tournamentId })
      .first()
      .catch(() => null);
    if (!t) throw notFound();
    if (t.format !== "teams") {
      throw conflict("not_a_team_tournament", "La clasificación por equipos solo existe en torneos de formato 'teams'");
    }
    const table = await leagueTable(db, t.id as string, /*isTeams*/ true);
    const teamIds = table.map((r) => r.id).filter((id) => id !== null && id !== undefined);
    const teams = teamIds.length > 0 ? await db("teams").whereIn("id", teamIds) : [];
    const nameById = new Map(teams.map((row: Record<string, unknown>) => [row.id as string, row.name as string]));
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(
      table.map((row, i) => ({
        rank: i + 1,
        teamId: row.id,
        teamName: nameById.get(row.id),
        points: row.points,
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        scoreDiff: row.scoreDiff,
        seed: row.seed,
      })),
    );
  });

  return router;
}
