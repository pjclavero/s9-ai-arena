/**
 * #287 · Diferencial de CALIBRACIÓN de la inscripción de equipos completos
 * (apps/api/src/team-enrollment.test.ts + apps/web/tests/team-enrollment-entry.test.tsx).
 *
 * Muta el CÓDIGO DE PRODUCCIÓN (nunca los tests) y exige ROJO-OK: la suite cae Y cae el test
 * que se espera (`kill`, una etiqueta T287_… o W287_… del nombre del test), no otro por
 * casualidad. Antes exige el árbol limpio y la LÍNEA BASE en verde; restaura cada fichero
 * desde su copia en memoria (no con `git checkout`) y comprueba al final que el árbol sigue
 * limpio. En SERIE, sin otro proceso escribiendo el árbol. Mismo arnés que
 * scripts/frozen-reuse-mutants.mjs.
 *
 * Uso (en el laboratorio, nunca en el orquestador):
 *   node scripts/team-enrollment-mutants.mjs            # todos
 *   node scripts/team-enrollment-mutants.mjs M1 M3a     # sólo esos
 *   node scripts/team-enrollment-mutants.mjs --dry      # sólo comprueba los patrones
 * Sale con 0 sólo si la base está verde y TODOS los mutantes dan ROJO-OK.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = "apps/api/src/team-enrollment.test.ts";
const WEB = "apps/web/tests/team-enrollment-entry.test.tsx";
const T = "apps/api/src/routes/tournaments.ts";
const WTE = "apps/web/src/tournament-entry.ts";
const SCH = "apps/tournament-worker/src/scheduler.ts";
const RES = "apps/tournament-worker/src/results.ts";
const VE = "apps/api/src/services/version-eligibility.ts";

const NO_TRX_OPEN = {
  file: T,
  from: "    const out = await db.transaction(async (trx) => {",
  to: "    const out = await (async (trx: typeof db) => {",
};
const NO_TRX_CLOSE = {
  file: T,
  from: "      return { t, team, rows };\n    });\n",
  to: "      return { t, team, rows };\n    })(db);\n",
};
const INSERT_BATCH =
  '      const rows = (await trx("entries")\n' +
  "        .insert(\n" +
  "          roster.map((m) => ({\n" +
  "            tournament_id: t.id,\n" +
  "            bot_id: m.botId,\n" +
  "            version: m.version,\n" +
  "            loadout_revision: vByKey.get(eligibilityKey(m.botId, m.version))!.loadout_revision,\n" +
  "            team_id: teamId,\n" +
  "            frozen: false,\n" +
  "          })),\n" +
  "        )\n" +
  '        .returning("*")) as Record<string, unknown>[];\n';
const AUDIT_TEAM = '      await audit(trx, {\n        actorId: userId,\n        action: "tournament.team_entered",';

/** `edits[].anchor`: el patrón se busca DESPUÉS de esa marca (y debe ser único ahí). */
const MUTANTS = [
  {
    id: "M1",
    name: "inscribe aunque falte (o sobre) un bot",
    edits: [{ file: T, from: "      if (roster.length !== n) {", to: "      if (false && roster.length !== n) {" }],
    tests: [API],
    kill: "T287_SIZE",
  },
  {
    id: "M1w",
    name: "la web habilita el botón aunque falte un bot",
    edits: [
      {
        file: WTE,
        from: "  if (included.length !== input.teamSize) {",
        to: "  if (false && included.length !== input.teamSize) {",
      },
    ],
    tests: [WEB],
    kill: "W287_MISSING_BOT",
  },
  {
    id: "M2",
    name: "no comprueba la pertenencia al equipo",
    edits: [
      {
        file: T,
        from: "const notMember = ids.filter((id) => byId.get(id)?.team_id !== teamId);",
        to: "const notMember = ids.filter((id) => !byId.get(id));",
      },
    ],
    tests: [API],
    kill: "T287_MEMBERSHIP",
  },
  {
    id: "M3a",
    name: "inscripción no atómica (sin transacción)",
    edits: [NO_TRX_OPEN, NO_TRX_CLOSE],
    tests: [API],
    kill: "T287_ATOMIC_AFTER_INSERT",
  },
  {
    id: "M3b",
    name: "inscripción no atómica (sin transacción y fila a fila)",
    edits: [
      NO_TRX_OPEN,
      NO_TRX_CLOSE,
      {
        file: T,
        from: INSERT_BATCH,
        to:
          "      const rows: Record<string, unknown>[] = [];\n" +
          "      for (const m of roster) {\n" +
          '        const [row] = await trx("entries")\n' +
          "          .insert({\n" +
          "            tournament_id: t.id,\n" +
          "            bot_id: m.botId,\n" +
          "            version: m.version,\n" +
          "            loadout_revision: vByKey.get(eligibilityKey(m.botId, m.version))!.loadout_revision,\n" +
          "            team_id: teamId,\n" +
          "            frozen: false,\n" +
          "          })\n" +
          '          .returning("*");\n' +
          "        rows.push(row);\n" +
          "      }\n",
      },
    ],
    tests: [API],
    kill: "T287_ATOMIC_MIDWAY",
  },
  {
    id: "M4",
    name: "no revalida la pertenencia al cerrar",
    edits: [{ file: VE, from: '        if (!bot || bot.team_id !== e.team_id) issues.push("not_in_team");\n', to: "" }],
    tests: [API],
    kill: "T287_CLOSE_SWAP",
  },
  {
    id: "M4b",
    name: "no revalida el estado de las versiones al cerrar (ni al excluir)",
    edits: [
      {
        file: VE,
        from: '    if (!isCompetitionState(stateOf.get(eligibilityKey(ref.botId, ref.version)))) issues.push("version_not_competing");\n',
        to: "",
      },
    ],
    tests: [API],
    kill: "T287_CLOSE_INELIGIBLE",
  },
  {
    id: "M4c",
    name: "cierre no atómico (sin transacción)",
    edits: [
      {
        file: T,
        from: "    const updated = await db.transaction(async (db) => {",
        to: "    const updated = await (async (db: Db) => {",
      },
      {
        file: T,
        from: "      return updated;\n    });\n    res.json(tournamentToJson(updated));",
        to: "      return updated;\n    })(db);\n    res.json(tournamentToJson(updated));",
      },
    ],
    tests: [API],
    kill: "T287_CLOSE_ATOMIC",
  },
  {
    id: "RM4",
    name: "no comprueba que el solicitante sea miembro del equipo (revisor)",
    edits: [
      {
        file: T,
        from: '      if (!member) throw forbidden("Sólo un miembro del equipo puede inscribirlo");',
        to: '      if (false && !member) throw forbidden("x");',
      },
    ],
    tests: [API],
    kill: "T287_NOT_TEAM_MEMBER",
  },
  {
    id: "RM6",
    name: "el cierre no revalida el bot retirado (revisor)",
    edits: [{ file: VE, from: '        if (bot?.retired_at) issues.push("bot_retired");\n', to: "" }],
    tests: [API],
    kill: "T287_CLOSE_RETIRED",
  },
  {
    id: "RM7",
    name: "el cierre ignora inscripciones sin equipo efectivo (revisor)",
    edits: [{ file: VE, from: '        issues.push("no_team");\n', to: "" }],
    tests: [API],
    kill: "T287_TEAMLESS_LEGACY",
  },
  {
    id: "H1",
    name: "alta individual sin bloquear el torneo (carrera con el cierre)",
    edits: [
      {
        file: T,
        from: "        .where({ id: req.params.tournamentId })\n        .forUpdate()\n",
        to: "        .where({ id: req.params.tournamentId })\n",
      },
    ],
    tests: [API],
    kill: "T287_RACE_IND",
  },
  {
    id: "H2a",
    name: "el organizador sólo excluye por loadout (no por el predicado único)",
    edits: [{ file: VE, from: "  if (!byOwner && issues.length === 0) {", to: "  if (!byOwner && e.eligible) {" }],
    tests: [API],
    kill: "T287_UNBLOCK_RETIRED_IND",
  },
  {
    id: "H2b",
    name: "el dueño sólo sustituye por loadout (no por el predicado único)",
    edits: [{ file: VE, from: "  if (issues.length === 0) return null;", to: "  if (prev.eligible) return null;" }],
    tests: [API],
    kill: "T287_UNBLOCK_REPLACE_IND",
  },
  {
    id: "H2c",
    name: "un equipo a medias no deja de competir (el resto no se puede excluir)",
    edits: [
      {
        file: VE,
        from: '      if (effective && teamCount.get(effective) !== n) issues.push("team_incomplete");\n',
        to: "",
      },
    ],
    tests: [API],
    kill: "T287_UNBLOCK_SUSPENDED_TEAM",
  },
  {
    id: "H3",
    // Ronda 3 · desde R2-3 hay DOS barreras contra el doble freeze: el bloqueo FOR NO KEY
    // UPDATE de las versiones (serializa dos cierres que las comparten) y el UPDATE
    // condicional. Quitar sólo una es equivalente (la otra basta); el mutante quita ambas.
    name: "freeze incondicional y sin bloqueo de versiones (doble auditoría con cierres concurrentes)",
    edits: [
      { file: T, from: '          .orderBy("id")\n          .forNoKeyUpdate();', to: '          .orderBy("id");' },
      { file: T, from: '          .where({ id: v.id, state: "published" })', to: "          .where({ id: v.id })" },
    ],
    tests: [API],
    kill: "T287_FREEZE_ONCE",
  },
  {
    id: "M5",
    name: "acepta una versión con loadout no elegible",
    edits: [{ file: T, from: "      await assertVersionsEligible(trx, roster, { userId, staff: false });\n", to: "" }],
    tests: [API],
    kill: "T287_INELIGIBLE",
  },
  {
    id: "M5b",
    name: "acepta una versión fuera de published|frozen",
    edits: [
      {
        file: T,
        from: ".filter((x) => !x.v || !isCompetitionState(x.v.state));",
        to: ".filter((x) => !x.v);",
      },
    ],
    tests: [API],
    kill: "T287_NOT_PUBLISHED",
  },
  {
    id: "M5w",
    name: "la web deja inscribir un equipo con un miembro no elegible",
    edits: [{ file: WTE, from: "  } else if (included.some((r) => r.problem)) {", to: "  } else if (false) {" }],
    tests: [WEB],
    kill: "W287_INELIGIBLE_MEMBER",
  },
  {
    id: "M6a",
    name: "inscribir el equipo hace públicos sus bots",
    edits: [
      {
        file: T,
        from: AUDIT_TEAM,
        to: `      await trx("bots").whereIn("id", ids).update({ visibility: "public" });\n${AUDIT_TEAM}`,
      },
    ],
    tests: [API],
    kill: "T287_PRIVACY",
  },
  {
    id: "M6b",
    name: "inscribir el equipo hace público su código",
    edits: [
      {
        file: T,
        from: AUDIT_TEAM,
        to: `      await trx("bot_versions").whereIn("bot_id", ids).update({ code_public: true });\n${AUDIT_TEAM}`,
      },
    ],
    tests: [API],
    kill: "T287_PRIVACY",
  },
  {
    id: "R21",
    name: "la exclusión no bloquea el torneo (carrera con el cierre, R2-1)",
    edits: [
      {
        file: VE,
        from: 'const locked_t = await trx("tournaments").where({ id: t.id }).forUpdate().first();',
        to: 'const locked_t = await trx("tournaments").where({ id: t.id }).first();',
      },
    ],
    tests: [API],
    kill: "T287_EXCLUDE_RACE",
  },
  {
    id: "R23a",
    name: "el cierre no bloquea los bots inscritos (removeTeamBot concurrente, R2-3)",
    edits: [{ file: T, from: '          .orderBy("id")\n          .forShare();', to: '          .orderBy("id");' }],
    tests: [API],
    kill: "T287_CLOSE_REMOVE_RACE",
  },
  {
    id: "R23b",
    name: "el cierre no bloquea las versiones inscritas (suspend concurrente, R2-3)",
    edits: [
      { file: T, from: '          .orderBy("id")\n          .forNoKeyUpdate();', to: '          .orderBy("id");' },
    ],
    tests: [API],
    kill: "T287_CLOSE_SUSPEND_RACE",
  },
  {
    id: "CM5",
    name: "cualquiera retira una autorización ajena (revisor)",
    edits: [{ file: T, from: "if (!c || c.owner_id !== userId) throw notFound", to: "if (!c) throw notFound" }],
    tests: [API],
    kill: "T287_THIRD_PARTY",
  },
  {
    id: "CM7",
    name: "el alta acepta la autorización dada para OTRO equipo (revisor)",
    edits: [
      {
        file: T,
        from: "!c || c.team_id !== teamId || Number(c.version) !== m.version",
        to: "!c || Number(c.version) !== m.version",
      },
    ],
    tests: [API],
    kill: "T287_CONSENT_OTHER_TEAM",
  },
  {
    id: "R31",
    name: "transición de estado sin condición (frozen→retired con un retire concurrente al cierre, R3-1)",
    edits: [
      {
        file: "apps/api/src/services/bots.ts",
        from: "    .where({ id: version.id, state: version.state })\n    .update({ state: to, ...patch })",
        to: "    .where({ id: version.id })\n    .update({ state: to, ...patch })",
      },
    ],
    tests: [API],
    kill: "T287_CLOSE_RETIRE_RACE",
  },
  {
    id: "R32",
    name: "removeTeamMember sin bloquear sus bots en orden de id (deadlock con el cierre, R3-2)",
    edits: [
      {
        file: "apps/api/src/routes/teams.ts",
        from: '      await trx("bots").where({ team_id: team.id, owner_id: target }).orderBy("id").forUpdate();\n',
        to: "",
      },
    ],
    tests: [API],
    kill: "T287_DEADLOCK_RTM",
  },
  {
    id: "M7",
    name: "inscribe bots de otro dueño sin su autorización",
    edits: [{ file: T, from: "      if (unauthorized.length > 0) {", to: "      if (false) {" }],
    tests: [API],
    kill: "T287_MO_NO_CONSENT",
  },
  {
    id: "M7b",
    name: "la autorización no ata la versión",
    edits: [{ file: T, from: " || Number(c.version) !== m.version || ", to: " || " }],
    tests: [API],
    kill: "T287_MO_WRONG_VERSION",
  },
  {
    id: "M7c",
    name: "el cierre no revalida la autorización",
    edits: [{ file: VE, from: '          issues.push("consent_missing");\n', to: "" }],
    tests: [API],
    kill: "T287_MO_CLOSE_CONSENT_GONE",
  },
  {
    id: "M7d",
    name: "retirar la autorización no saca al equipo",
    edits: [{ file: T, from: "      if (entry?.team_id) {", to: "      if (false) {" }],
    tests: [API],
    kill: "T287_MO_REVOKED",
  },
  {
    id: "M7e",
    name: "cualquiera autoriza un bot ajeno",
    edits: [
      {
        file: T,
        from: '      if (!bot || bot.owner_id !== userId) throw notFound("Bot no encontrado entre los tuyos");',
        to: '      if (!bot) throw notFound("Bot no encontrado entre los tuyos");',
      },
    ],
    tests: [API],
    kill: "T287_MO_FOREIGN_CONSENT",
  },
  {
    id: "M7w",
    name: "la web deja entrar un bot ajeno sin autorización",
    edits: [
      {
        file: WTE,
        from: '      if (v === undefined) return { ...row, problem: "Falta la autorización de su dueño para este torneo" };',
        to: "      if (v === undefined) return { ...row, version: 1 };",
      },
    ],
    tests: [WEB],
    kill: "W287_NO_CONSENT",
  },
  {
    id: "H7",
    name: "teamId sin normalizar",
    edits: [
      {
        file: T,
        from: "MAYÚSCULAS como uuid).\n    const teamId = canonicalUuid(rawTeamId);",
        to: "MAYÚSCULAS como uuid).\n    const teamId = rawTeamId;",
      },
    ],
    tests: [API],
    kill: "T287_UPPER_UUID",
  },
  {
    id: "M8",
    name: "no detecta el equipo ya inscrito",
    edits: [
      {
        file: T,
        from: '      if (await trx("entries").where({ tournament_id: t.id, team_id: teamId }).first()) {',
        to: "      if (false) {",
      },
    ],
    tests: [API],
    kill: "T287_DUPLICATE",
  },
  {
    id: "M9",
    name: "un torneo teams NvN admite bots sueltos",
    edits: [{ file: T, from: "    if (teamSizeOf(t) !== null) {", to: "    if (false) {" }],
    tests: [API],
    kill: "T287_INDIVIDUAL_BLOCKED",
  },
  {
    id: "M10",
    name: "el calendario ignora el equipo inscrito (usa el equipo actual del bot)",
    edits: [
      {
        file: SCH,
        from: "COALESCE(entries.team_id, bots.team_id) AS effective_team_id",
        to: "bots.team_id AS effective_team_id",
      },
    ],
    tests: [API],
    kill: "T287_SCHEDULE_TEAM",
  },
  {
    id: "M10b",
    name: "la clasificación ignora el equipo inscrito",
    edits: [
      {
        file: RES,
        from: "COALESCE(entries.team_id, bots.team_id) AS team_id",
        to: "bots.team_id AS team_id",
      },
    ],
    tests: [API],
    kill: "T287_SCHEDULE_TEAM",
  },
  // EQUIVALENTES documentados (no se mutan): staff:true o sin viewer en enterTournament,
  // replaceIneligibleEntry y putTeamEntryConsent. En esas tres rutas sólo llega el DUEÑO del bot
  // (la ruta lo exige antes), que ya ve el motivo real: el viewer no cambia ninguna salida
  // observable. En enterTournamentTeam no es así (quien inscribe puede no ser dueño): L1/L1b.
  // El WHERE state='published' del freeze de closeEntries es una doble barrera con el cerrojo
  // FOR NO KEY UPDATE de las versiones (M3b quita ambas).
  // ---- Ronda corta de corrección de #290 (P2-1..P2-3 y huecos del revisor R4/R4d/R5c/R6/R6b/R6c)
  {
    id: "L1",
    name: "enterTournamentTeam pasa viewer staff:true (el detalle del loadout ajeno se filtra)",
    edits: [
      {
        file: T,
        from: "await assertVersionsEligible(trx, roster, { userId, staff: false });",
        to: "await assertVersionsEligible(trx, roster, { userId, staff: true });",
      },
    ],
    tests: [API],
    kill: "T290_TEAM_VIEWER",
  },
  {
    id: "L1b",
    name: "enterTournamentTeam sin viewer (el dueño ya no ve el motivo de su propio bot)",
    edits: [
      {
        file: T,
        from: "await assertVersionsEligible(trx, roster, { userId, staff: false });",
        to: "await assertVersionsEligible(trx, roster);",
      },
    ],
    tests: [API],
    kill: "T290_TEAM_VIEWER_OWN",
  },
  {
    id: "L2",
    name: "excluir una inscripción de un torneo cancelado se permite",
    edits: [
      {
        file: VE,
        from: 'if (!locked_t || locked_t.state !== "open") {',
        to: 'if (!locked_t || (locked_t.state !== "open" && locked_t.state !== "cancelled")) {',
      },
      {
        file: VE,
        from: '  if (t.state !== "open" || entry.frozen) {',
        to: '  if ((t.state !== "open" && t.state !== "cancelled") || entry.frozen) {',
      },
    ],
    tests: [API],
    kill: "T289X_CANCEL_CONSENTS",
  },
  {
    id: "L3",
    name: "closeEntries: bots bloqueados por created_at desc (orden físico inverso al de id)",
    edits: [
      {
        file: T,
        from: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])\n          .orderBy("id")',
        to: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])\n          .orderBy("created_at", "desc")',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_CLOSE_BOTS",
  },
  {
    id: "L3b",
    name: "closeEntries: bots bloqueados en orden físico (sin ORDER BY)",
    edits: [
      {
        file: T,
        from: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])\n          .orderBy("id")',
        to: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_CLOSE_BOTS",
  },
  {
    id: "L3c",
    name: "closeEntries: bots bloqueados por id DESCENDENTE",
    edits: [
      {
        file: T,
        from: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])\n          .orderBy("id")',
        to: '          .whereIn("id", [...new Set(entries.map((e) => String(e.bot_id)))])\n          .orderBy("id", "desc")',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_CLOSE_BOTS",
  },
  {
    id: "L4",
    name: "closeEntries: versiones bloqueadas en orden físico (sin ORDER BY)",
    edits: [
      { file: T, from: '          .orderBy("id")\n          .forNoKeyUpdate();', to: "          .forNoKeyUpdate();" },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_CLOSE_VERSIONS",
  },
  {
    id: "L4b",
    name: "closeEntries: versiones bloqueadas por id DESCENDENTE",
    edits: [
      {
        file: T,
        from: '          .orderBy("id")\n          .forNoKeyUpdate();',
        to: '          .orderBy("id", "desc")\n          .forNoKeyUpdate();',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_CLOSE_VERSIONS",
  },
  {
    id: "L5",
    name: "enterTournamentTeam: bots bloqueados en orden físico (sin ORDER BY)",
    edits: [
      {
        file: T,
        from: 'await trx("bots").whereIn("id", ids).orderBy("id").forUpdate()',
        to: 'await trx("bots").whereIn("id", ids).forUpdate()',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_ENTER_TEAM",
  },
  {
    id: "L5b",
    name: "enterTournamentTeam: bots bloqueados por id DESCENDENTE",
    edits: [
      {
        file: T,
        from: 'await trx("bots").whereIn("id", ids).orderBy("id").forUpdate()',
        to: 'await trx("bots").whereIn("id", ids).orderBy("id", "desc").forUpdate()',
      },
    ],
    tests: [API],
    kill: "T287_LOCK_ORDER_ENTER_TEAM",
  },
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}
function treeDirty() {
  return sh("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
}
function runVitest(files) {
  const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.config.ts", ...files], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const failed = [
    ...new Set(
      out
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")
        .filter((l) => /^\s*FAIL\s.*>/.test(l))
        .map((l) => l.replace(/^\s*FAIL\s+/, "").trim()),
    ),
  ];
  return { rc: r.status, failed, out };
}
function locate(src, e) {
  const base = e.anchor ? src.indexOf(e.anchor) : 0;
  if (base < 0) return { ok: false, why: `ancla ausente: ${e.anchor}` };
  const rest = src.slice(base);
  const first = rest.indexOf(e.from);
  if (first < 0) return { ok: false, why: "patrón ausente" };
  if (rest.indexOf(e.from, first + 1) >= 0) return { ok: false, why: "patrón NO único" };
  return { ok: true, at: base + first };
}

const dry = process.argv.includes("--dry");
const only = new Set(process.argv.slice(2).filter((a) => a !== "--dry"));
const selected = MUTANTS.filter((m) => only.size === 0 || only.has(m.id));

// `--dry`: sólo comprueba que cada patrón existe y es único (sin vitest, sin tocar el árbol).
if (dry) {
  let bad = 0;
  for (const m of selected) {
    const cur = new Map();
    for (const e of m.edits) {
      const src = cur.get(e.file) ?? readFileSync(e.file, "utf8");
      const loc = locate(src, e);
      if (!loc.ok) {
        bad++;
        console.log(`ROTO · ${m.id} · ${e.file}: ${loc.why}`);
        break;
      }
      cur.set(e.file, src.slice(0, loc.at) + e.to + src.slice(loc.at + e.from.length));
    }
  }
  console.log(`DRY · ${selected.length - bad}/${selected.length} patrones OK`);
  process.exit(bad === 0 ? 0 : 1);
}

if (treeDirty()) {
  console.error(`ÁRBOL SUCIO: commitea antes de calibrar (los mutantes restauran desde memoria).\n${treeDirty()}`);
  process.exit(2);
}
const suites = [...new Set(selected.flatMap((m) => m.tests))];
const base = runVitest(suites);
console.log(`BASE      · vitest rc=${base.rc} · ${suites.join(" ")}`);
if (base.rc !== 0) {
  console.error(base.out.slice(-4000));
  console.error("LÍNEA BASE ROJA: un mutante sobre una base roja no mide nada.");
  process.exit(3);
}

const rows = [];
for (const m of selected) {
  const originals = new Map();
  let broken = "";
  for (const e of m.edits) {
    if (!originals.has(e.file)) originals.set(e.file, readFileSync(e.file, "utf8"));
  }
  const current = new Map(originals);
  for (const e of m.edits) {
    const src = current.get(e.file);
    const loc = locate(src, e);
    if (!loc.ok) {
      broken = `${e.file}: ${loc.why}`;
      break;
    }
    current.set(e.file, src.slice(0, loc.at) + e.to + src.slice(loc.at + e.from.length));
  }
  if (broken) {
    rows.push({ id: m.id, verdict: "ROTO", rc: "-", detail: broken });
    console.log(`ROTO      · ${m.id} ${m.name} · ${broken}`);
    continue;
  }
  let r;
  try {
    for (const [f, s] of current) writeFileSync(f, s);
    r = runVitest(m.tests);
  } finally {
    for (const [f, s] of originals) writeFileSync(f, s);
  }
  const killedBy = r.failed.filter((n) => n.includes(m.kill));
  const verdict = r.rc !== 0 && killedBy.length > 0 ? "ROJO-OK" : r.rc !== 0 ? "ROJO-OTRO" : "SOBREVIVE";
  rows.push({ id: m.id, verdict, rc: r.rc, detail: (killedBy.length ? killedBy : r.failed).slice(0, 3).join(" | ") });
  console.log(`${verdict.padEnd(9)} · ${m.id} ${m.name} · vitest rc=${r.rc} · ${rows.at(-1).detail}`);
}

const dirty = treeDirty();
if (dirty) console.error(`EL ÁRBOL QUEDÓ SUCIO tras los mutantes:\n${dirty}`);
const bad = rows.filter((x) => x.verdict !== "ROJO-OK");
console.log(`\nRESUMEN · ${rows.length - bad.length}/${rows.length} ROJO-OK · árbol ${dirty ? "SUCIO" : "limpio"}`);
process.exit(bad.length === 0 && !dirty ? 0 : 1);
