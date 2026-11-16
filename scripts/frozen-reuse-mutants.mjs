/**
 * FROZEN-REUSE (B9) · Diferencial de CALIBRACIÓN de la suite de reutilización de versiones
 * `frozen` (apps/api/src/frozen-reuse.test.ts + apps/web/tests/frozen-reuse-entry.test.tsx).
 *
 * Muta el CÓDIGO DE PRODUCCIÓN (nunca los tests) y exige ROJO-OK: la suite cae Y cae el
 * test que se espera (`kill`), no otro por casualidad — un rojo por la razón equivocada se
 * lee igual que uno legítimo. Antes exige el árbol limpio y la LÍNEA BASE en verde; restaura
 * cada fichero desde su copia en memoria (no con `git checkout`) y comprueba al final que el
 * árbol sigue limpio. En SERIE, sin otro proceso escribiendo el árbol.
 *
 * Uso (en el laboratorio, nunca en el orquestador):
 *   node scripts/frozen-reuse-mutants.mjs            # todos
 *   node scripts/frozen-reuse-mutants.mjs M4 M5      # sólo esos
 * Sale con 0 sólo si la base está verde y TODOS los mutantes dan ROJO-OK.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = "apps/api/src/frozen-reuse.test.ts";
const WEB = "apps/web/tests/frozen-reuse-entry.test.tsx";
const T = "apps/api/src/routes/tournaments.ts";
const VE = "apps/api/src/services/version-eligibility.ts";
const MIG = "apps/api/src/db/migrations.ts";
const WTE = "apps/web/src/tournament-entry.ts";
const ENTRY_CHECK = "    await assertTournamentEligible(db, v);\n";

/** `edits[].anchor`: el patrón se busca DESPUÉS de esa marca (y debe ser único ahí). */
const MUTANTS = [
  {
    id: "M1",
    name: "se rechazan todas las frozen (inscripción)",
    edits: [
      {
        file: T,
        from: ENTRY_CHECK,
        to: `    if (v?.state === "frozen") throw conflict("bot_not_published", "mutante");\n${ENTRY_CHECK}`,
      },
    ],
    tests: [API],
    kill: "FROZEN_VERSION_REUSABLE",
  },
  {
    id: "M1b",
    name: "se rechazan todas las frozen (regla de estado compartida)",
    edits: [{ file: VE, from: 'new Set(["published", "frozen"])', to: 'new Set(["published"])' }],
    tests: [API],
    kill: "FROZEN_VERSION_REUSABLE",
  },
  {
    id: "M1w",
    name: "la web no ofrece las frozen",
    edits: [{ file: WTE, from: '= ["published", "frozen"];', to: '= ["published"];' }],
    tests: [WEB],
    kill: "bot cuya única versión es frozen",
  },
  {
    id: "M2",
    name: "frozen se republica automáticamente al inscribirla",
    edits: [
      {
        file: T,
        from: ENTRY_CHECK,
        to: `${ENTRY_CHECK}    if (v.state === "frozen") await db("bot_versions").where({ id: v.id }).update({ state: "published" });\n`,
      },
    ],
    tests: [API],
    kill: "FROZEN_VERSION_REUSABLE",
  },
  {
    id: "M2b",
    name: "frozen se descongela y se vuelve a congelar al cerrar B",
    edits: [
      {
        file: T,
        // #287 · closeEntries va ahora en una transacción (`trx`, un nivel más de sangría).
        from: '        if (v.state === "published") {\n          await applyTransition(trx, req.auth, v, "freeze", {}, req.correlationId);',
        to: '        const cur = v.state === "frozen" ? (await trx("bot_versions").where({ id: v.id }).update({ state: "published" }).returning("*"))[0] : v;\n        if (cur.state === "published") {\n          await applyTransition(trx, req.auth, cur, "freeze", {}, req.correlationId);',
      },
    ],
    tests: [API],
    kill: "cerrar B con la versión YA frozen",
  },
  {
    id: "M3",
    name: "frozen se clona en silencio (versión nueva hija de la congelada)",
    edits: [
      {
        file: T,
        from: ENTRY_CHECK,
        to: `${ENTRY_CHECK}    if (v.state === "frozen") {\n      const mx = await db("bot_versions").where({ bot_id: botId }).max("version as m").first();\n      await db("bot_versions").insert({ bot_id: botId, version: Number(mx.m) + 1, parent_version: v.version, state: "published", runtime: v.runtime, loadout_revision: v.loadout_revision, source: v.source, source_filename: v.source_filename, code_public: v.code_public, published_at: db.fn.now() });\n    }\n`,
      },
    ],
    tests: [API],
    kill: "NO_IMPLICIT_CLONE",
  },
  {
    id: "M4",
    name: "el código de una frozen es editable (trigger)",
    edits: [
      {
        file: MIG,
        anchor: "const BOT_VERSION_GUARD_HEAD",
        from: "NEW.source IS DISTINCT FROM OLD.source OR NEW.source_filename IS DISTINCT FROM OLD.source_filename",
        to: "(OLD.state <> 'frozen' AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.source_filename IS DISTINCT FROM OLD.source_filename))",
      },
    ],
    tests: [API],
    kill: "editar su CÓDIGO",
  },
  {
    id: "M5",
    name: "el loadout de una frozen es editable (trigger)",
    edits: [
      {
        file: MIG,
        anchor: "const BOT_VERSION_GUARD_HEAD",
        from: "OR NEW.loadout_revision IS DISTINCT FROM OLD.loadout_revision) THEN",
        to: "OR (OLD.state <> 'frozen' AND NEW.loadout_revision IS DISTINCT FROM OLD.loadout_revision)) THEN",
      },
    ],
    tests: [API],
    kill: "editar su LOADOUT",
  },
  {
    id: "M6a",
    name: "frozen se salta la elegibilidad del loadout (en las DOS comprobaciones)",
    edits: [
      {
        file: VE,
        from: "  await assertVersionsEligible(db, [{ botId: String(version.bot_id), version: Number(version.version) }]);\n}",
        to: '  if (version.state === "frozen") return;\n  await assertVersionsEligible(db, [{ botId: String(version.bot_id), version: Number(version.version) }]);\n}',
      },
      {
        file: VE,
        from: "  await assertVersionsEligible(db, [{ botId, version: n }]);",
        to: '  if (version.state !== "frozen") await assertVersionsEligible(db, [{ botId, version: n }]);',
      },
    ],
    tests: [API],
    kill: "frozen INVÁLIDA",
  },
  {
    id: "M6b",
    name: "una versión suspendida (revocada) cuenta como estado de competición",
    edits: [
      { file: VE, from: 'new Set(["published", "frozen"])', to: 'new Set(["published", "frozen", "suspended"])' },
    ],
    tests: [API],
    kill: "versión suspended",
  },
  {
    id: "M6c",
    name: "se salta la comprobación de propiedad",
    edits: [
      {
        file: T,
        from: '    if (bot.owner_id !== req.auth!.userId) throw forbidden("Solo el dueño inscribe su bot");',
        to: '    if (bot.owner_id !== req.auth!.userId && false) throw forbidden("Solo el dueño inscribe su bot");',
      },
    ],
    tests: [API],
    kill: "propiedad",
  },
  {
    id: "M6w",
    name: "la web ofrece frozen NO elegibles",
    edits: [
      {
        file: WTE,
        from: "  return TOURNAMENT_ENTRY_STATES.includes(v.state) && isBattleEligible(v);",
        to: "  return TOURNAMENT_ENTRY_STATES.includes(v.state);",
      },
    ],
    tests: [WEB],
    kill: "frozen NO elegible",
  },
  {
    id: "M7a",
    name: "inscribir una frozen hace público el bot",
    edits: [
      {
        file: T,
        from: ENTRY_CHECK,
        to: `${ENTRY_CHECK}    if (v.state === "frozen") await db("bots").where({ id: botId }).update({ visibility: "public" });\n`,
      },
    ],
    tests: [API],
    kill: "PRIVACY_PRESERVED",
  },
  {
    id: "M7b",
    name: "inscribir una frozen hace público su código",
    edits: [
      {
        file: T,
        from: ENTRY_CHECK,
        to: `${ENTRY_CHECK}    if (v.state === "frozen") await db("bot_versions").where({ id: v.id }).update({ code_public: true });\n`,
      },
    ],
    tests: [API],
    kill: "PRIVACY_PRESERVED",
  },
  {
    id: "M8",
    name: "la inscripción B referencia otra combinación (último loadout del bot, no el de la versión)",
    edits: [
      {
        file: T,
        from: "        loadout_revision: v.loadout_revision,\n        frozen: false,",
        to: '        loadout_revision: (await db("bot_loadouts").where({ bot_id: botId }).max("revision as m").first()).m,\n        frozen: false,',
      },
    ],
    tests: [API],
    kill: "SAME_VERSION_ID_REUSED",
  },
  {
    id: "M9",
    name: "cerrar B intenta volver a congelar una versión ya frozen (no idempotente)",
    edits: [
      {
        file: T,
        from: '        if (v.state === "published") {',
        to: '        if (v.state === "published" || v.state === "frozen") {',
      },
    ],
    tests: [API],
    kill: "cerrar B con la versión YA frozen",
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
  // Nombres de los tests que fallan (formato de vitest: «FAIL  fichero > describe > it»).
  const failed = [
    ...new Set(
      out
        // Sin colores ANSI; y NO voraz: hay nombres de test que contienen «⇒ FAIL (…)».
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
    const src = originals.get(e.file) ?? readFileSync(e.file, "utf8");
    if (!originals.has(e.file)) originals.set(e.file, src);
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
