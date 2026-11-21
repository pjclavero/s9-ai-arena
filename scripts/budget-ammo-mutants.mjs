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
const WR = "apps/tournament-worker/src/battle-runner.ts";
const TAMPER = "apps/api/src/b4-budget-tamper.test.ts";
const EXEC = "apps/tournament-worker/src/b4-budget-exec.test.ts";

const MUTANTS = [
  { id: "M1", name: "la fuente única no suma la munición embebida",
    edits: [{ file: V, from: "if (ammoDef && ammoDef.category === \"ammo\") total += Number(ammoDef.costCredits) || 0;", to: "" }],
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
    edits: [{ file: V, from: "if (totalCost > budgetCredits) {", to: "if (totalCost >= budgetCredits) {" }],
    tests: [API], kill: "B4_ENROLL_BOUNDARY" },
  { id: "M9", name: "un torneo sin presupuesto propio rechaza (null se trata como 0)",
    edits: [{ file: VE, from: "if (typeof budgetCredits !== \"number\" || !Number.isFinite(budgetCredits) || refs.length === 0) return out;", to: "if (refs.length === 0) return out; budgetCredits = budgetCredits ?? 0;" }],
    tests: [API], kill: "B4_ENROLL_NO_BUDGET" },
  { id: "M10", name: "la inscripción de equipo completo ignora el presupuesto",
    edits: [{ file: T, from: "      await assertWithinTournamentBudget(trx, roster,", to: "      if (false) await assertWithinTournamentBudget(trx, roster," }],
    tests: [API], kill: "B4_TEAM_ENTER" },
  { id: "M11", name: "la autorización de equipo ignora el presupuesto",
    edits: [{ file: T, from: "await assertTournamentEligible(tx, v, { userId, staff: false }, t.budget_credits as number | null | undefined);", to: "await assertTournamentEligible(tx, v, { userId, staff: false });" }],
    tests: [API], kill: "B4_TEAM_CONSENT" },
  // M12 (efecto lateral sobre la versión al rechazar) se RETIRÓ: todas las rutas llaman dentro de una
  // transacción y el 409 la revierte, así que el mutante era equivalente (sobrevivía sin ser un hueco de test).
  // ---- D-OP-18 (b) cierre / materialización
  { id: "M13", name: "el cierre ignora el presupuesto (no emite over_budget)",
    edits: [{ file: VE, from: '    if (budget.get(eligibilityKey(ref.botId, ref.version))?.over) issues.push("over_budget");\n', to: "" }],
    tests: [TAMPER], kill: "B4_TAMPER_LOWER_BUDGET" },
  { id: "M14", name: "el cierre emite over_budget pero no lo trata como inscripción no elegible",
    edits: [{ file: VE, from: ' || i === "over_budget"),', to: ")," }],
    tests: [TAMPER], kill: "B4_TAMPER_LOWER_BUDGET" },
  { id: "M15", name: "el cierre cuenta una revisión fija inexistente en vez de la inscrita",
    edits: [{ file: VE, from: "      loadoutRevision: Number(e.loadout_revision),\n    })),\n    tournament.budget_credits", to: "      loadoutRevision: 999,\n    })),\n    tournament.budget_credits" }],
    tests: [TAMPER], kill: "B4_TAMPER_LOWER_BUDGET" },
  { id: "M16", name: "la revisión fijada se ignora en el cálculo único",
    edits: [{ file: VE, from: "    if (row) await verdict(canonicalUuid(r.botId), r.version, Number(r.loadoutRevision), row);\n", to: "" }],
    tests: [TAMPER], kill: "B4_TAMPER_REVISION_REPOINT" },
  { id: "M17", name: "cambiar de versión a una más cara entra: inscripción sin comprobación",
    edits: [{ file: VE, from: "  await assertWithinTournamentBudget(db, [ref], budgetCredits, viewer);", to: "" }],
    tests: [TAMPER], kill: "B4_TAMPER_VERSION" },
  { id: "M18", name: "over_budget no cuenta como motivo de no competir (el cierre pasa y el organizador no puede excluir)",
    edits: [{ file: VE, from: '    if (budget.get(eligibilityKey(ref.botId, ref.version))?.over) issues.push("over_budget");\n', to: '    if (budget.get(eligibilityKey(ref.botId, ref.version))?.over) { /* sin efecto */ }\n' }],
    tests: [TAMPER], kill: "B4_CLOSE_UNBLOCK" },
  // ---- D-OP-18 (c) ejecución
  { id: "M19", name: "el worker no descalifica al que supera el presupuesto",
    edits: [{ file: WR, from: "        if (verdicts.get(eligibilityKey(p.bot_id, p.version))?.over) adminDq.push(p.bot_id);\n", to: "" }],
    tests: [EXEC], kill: "B4_EXEC_GUARD" },
  { id: "M20", name: "el worker cuenta la revisión actual de la versión, no la fijada en la inscripción",
    edits: [{ file: WR, from: "          loadoutRevision: revOf.get(`${p.bot_id}@${p.version}`),", to: "          loadoutRevision: undefined," }],
    tests: [EXEC], kill: "B4_EXEC_PINNED" },
  { id: "M21", name: "el worker descalifica también sin presupuesto propio (null tratado como 0)",
    edits: [
      { file: WR, from: 'if (typeof budget === "number") {', to: "if (true) {" },
      { file: WR, from: "        budget,\n      );\n      for (const p of live)", to: "        budget ?? 0,\n      );\n      for (const p of live)" },
    ],
    tests: [EXEC], kill: "B4_EXEC_CONTROL" },
  // ---- D-OP-19 tope por pieza y casos límite
  { id: "M22", name: "el tope por pieza no bloquea (sólo el total)",
    edits: [{ file: V, from: '  "module_cost_cap_exceeded",\n]);', to: "]);" }],
    tests: [TAMPER], kill: "B4_CAP_EXACT" },
  { id: "M23", name: "el total no bloquea (sólo el tope por pieza)",
    edits: [{ file: V, from: '  "budget_exceeded",\n  "module_cost_cap_exceeded",', to: '  "module_cost_cap_exceeded",' }],
    tests: [API], kill: "B4_ENROLL_REJECT" },
  { id: "M24", name: "un coste nulo envenena la suma (NaN)",
    edits: [{ file: V, from: "total += Number(def.costCredits) || 0;", to: "total += def.costCredits;" }],
    tests: [TAMPER], kill: "B4_CAP_NULL_COST" },
  { id: "M25", name: "el mensaje de rechazo pierde el motivo del tope por pieza",
    edits: [{ file: VE, from: "  if (cap) parts.push(`${cap.message}`);\n", to: "" }],
    tests: [TAMPER], kill: "B4_CAP_MESSAGE" },
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}
function treeDirty() {
  return sh("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
}
function runVitest(files) {
  const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.config.ts", "--maxWorkers=1", ...files], {
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
