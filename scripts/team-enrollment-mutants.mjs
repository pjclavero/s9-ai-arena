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
    edits: [
      {
        file: T,
        from: "  const changed = rows.filter((e) =>\n",
        to: "  const changed = rows.filter((e) => false &&\n",
      },
    ],
    tests: [API],
    kill: "T287_CLOSE_SWAP",
  },
  {
    id: "M4b",
    name: "no revalida el estado de las versiones al cerrar",
    edits: [
      {
        file: T,
        from: "const notCompeting = entries.filter((e) => !isCompetitionState(versions.get(e.id as string)?.state));",
        to: "const notCompeting = entries.filter(() => false);",
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
        from: "    const updated = await db.transaction(async (trx) => {",
        to: "    const updated = await (async (trx: typeof db) => {",
      },
      { file: T, from: "      return row;\n    });\n", to: "      return row;\n    })(db);\n" },
    ],
    tests: [API],
    kill: "T287_CLOSE_ATOMIC",
  },
  {
    id: "M5",
    name: "acepta una versión con loadout no elegible",
    edits: [{ file: T, from: "      await assertVersionsEligible(trx, roster);\n", to: "" }],
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
    id: "M7",
    name: "no comprueba el dueño de cada bot",
    edits: [
      {
        file: T,
        from: "const notOwned = ids.filter((id) => byId.get(id)!.owner_id !== userId);",
        to: "const notOwned = ids.filter(() => false);",
      },
    ],
    tests: [API],
    kill: "T287_OWNER",
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

const only = new Set(process.argv.slice(2));
const selected = MUTANTS.filter((m) => only.size === 0 || only.has(m.id));

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
