/**
 * V1 · B4 · Diferencial de CALIBRACIÓN de la fuente única de coste y del presupuesto de torneo
 * (b4-budget-cost.test.ts, loadout-cost.test.ts, b4-cost-editor.test.tsx). Muta el CÓDIGO DE
 * PRODUCCIÓN y exige ROJO-OK: cae la suite Y cae el test esperado (`kill`, etiqueta B4_…).
 * Mismo arnés que scripts/team-enrollment-mutants.mjs. En SERIE, en el laboratorio, con el
 * árbol commiteado. NO ejecutar en ia02.
 *   node scripts/budget-ammo-mutants.mjs [--dry] [M1 ...]
 */
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = "apps/api/src/b4-budget-cost.test.ts";
const COSTT = "packages/module-catalog/validator/loadout-cost.test.ts";
const WEB = "apps/web/tests/b4-cost-editor.test.tsx";
const V = "packages/module-catalog/validator/index.ts";
const VE = "apps/api/src/services/version-eligibility.ts";
const T = "apps/api/src/routes/tournaments.ts";
const ED = "apps/web/src/pages/LoadoutEditor.tsx";
const BS = "apps/api/src/services/bots.ts";
const BR = "apps/api/src/services/battle-rules.ts";

const MUTANTS = [
  { id: "M1", name: "la fuente única no suma la munición embebida",
    edits: [{ file: V, from: "if (ammoDef && ammoDef.category === \"ammo\") total += ammoDef.costCredits;", to: "" }],
    tests: [COSTT], kill: "B4_COST_AMMO" },
  { id: "M2", name: "cuenta dos veces la munición ya montada como módulo",
    edits: [{ file: V, from: "typeof m.ammo !== \"string\" || explicitIds.has(m.ammo)) continue;", to: "typeof m.ammo !== \"string\") continue;" }],
    tests: [COSTT], kill: "B4_COST_NO_DOUBLE" },
  { id: "M3", name: "el validador vuelve a una suma propia sin munición",
    edits: [{ file: V, from: "const totalCost = loadoutCostCredits(loadout, catalog);", to: "const totalCost = chassisDef.costCredits + accepted.reduce((s, a) => s + a.moduleDef.costCredits, 0);" }],
    tests: [COSTT], kill: "B4_COST_VALIDATOR" },
  { id: "M4", name: "el editor vuelve a sumar sólo chasis + módulos",
    edits: [{ file: ED, from: "const costCredits = loadoutCostCredits(draft, catalog);", to: "const costCredits = defs.reduce((s, d) => s + d.costCredits, 0);" }],
    tests: [WEB], kill: "B4_EDITOR_COST" },
  { id: "M5", name: "el summary guardado vuelve a la suma sin munición",
    edits: [{ file: BS, from: "const costCredits = loadoutCostCredits(e3Input, catalog);", to: "const costCredits = defs.reduce((s, d) => s + d.costCredits, 0);" }],
    tests: [API], kill: "B4_SUMMARY" },
  { id: "M6", name: "las reglas de batalla vuelven a costar sin munición",
    edits: [{ file: BR, from: "const costCredits = loadoutCostCredits(loadout, catalog);", to: "const costCredits = [loadout.chassis, ...loadout.modules.map((m) => m.moduleId)].reduce((s, id) => s + (findModule(catalog, id)?.costCredits ?? 0), 0);" }],
    tests: [API], kill: "B4_RULES_BOT_CAP" },
  { id: "M7", name: "la inscripción individual ignora el presupuesto del torneo",
    edits: [{ file: VE, from: "  await assertWithinTournamentBudget(db, [ref], budgetCredits, viewer);", to: "" }],
    tests: [API], kill: "B4_ENROLL_REJECT" },
  { id: "M8", name: "el borde: presupuesto igual al coste también rechaza (> pasa a >=)",
    edits: [{ file: VE, from: "> budgetCredits);\n  if (over.length === 0) return;", to: ">= budgetCredits);\n  if (over.length === 0) return;" }],
    tests: [API], kill: "B4_ENROLL_BOUNDARY" },
  { id: "M9", name: "un torneo sin presupuesto propio rechaza (null se trata como 0)",
    edits: [{ file: VE, from: "if (typeof budgetCredits !== \"number\" || !Number.isFinite(budgetCredits) || refs.length === 0) return;", to: "if (refs.length === 0) return; budgetCredits = budgetCredits ?? 0;" }],
    tests: [API], kill: "B4_ENROLL_NO_BUDGET" },
  { id: "M10", name: "la inscripción de equipo completo ignora el presupuesto",
    edits: [{ file: T, from: "      await assertWithinTournamentBudget(trx, roster,", to: "      if (false) await assertWithinTournamentBudget(trx, roster," }],
    tests: [API], kill: "B4_TEAM_ENTER" },
  { id: "M11", name: "la autorización de equipo ignora el presupuesto",
    edits: [{ file: T, from: "await assertTournamentEligible(tx, v, { userId, staff: false }, t.budget_credits as number | null | undefined);", to: "await assertTournamentEligible(tx, v, { userId, staff: false });" }],
    tests: [API], kill: "B4_TEAM_CONSENT" },
  { id: "M12", name: "el rechazo degrada la versión publicada (efecto lateral)",
    edits: [{ file: VE, from: "  const f = items[0] as", to: "  await db(\"bot_versions\").whereIn(\"bot_id\", over.map((r) => r.botId)).update({ state: \"validated\" });\n  const f = items[0] as" }],
    tests: [API], kill: "B4_PUBLISHED_UNTOUCHED" },
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
