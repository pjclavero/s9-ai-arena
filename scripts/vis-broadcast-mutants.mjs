/**
 * VISIBILIDAD (2026-11) · Diferencial de CALIBRACIÓN de la suite de visibilidad y
 * retransmisión (encargo §34).
 *
 * Muta el CÓDIGO DE PRODUCCIÓN (no las pruebas) y exige que la suite se ponga ROJA.
 * Una suite que sobrevive a estas mutaciones no comprueba lo que dice comprobar.
 * Restaura cada fichero tras cada mutante. Ejecútalo EN SERIE, con el árbol
 * commiteado y sin otro proceso escribiendo el árbol.
 *
 * Uso: node scripts/vis-broadcast-mutants.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const API = ["apps/api/src/vis-broadcast.test.ts"];
const WEB = ["apps/web/tests/vis-visibility-ui.test.tsx"];

const MUTANTS = [
  {
    name: "/broadcast pasa por getVisibleBot() (la batalla exige poder ver la ficha de cada bot)",
    file: "apps/api/src/routes/battles.ts",
    from: '    const battle = await withMapName(db, await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis));\n    res.setHeader("Cache-Control", NO_STORE);',
    to: '    const battle = await withMapName(db, await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis));\n    const { getVisibleBot } = await import("../services/bots.js");\n    for (const p of await db("participants").where({ battle_id: battle.id })) await getVisibleBot(db, req.auth, p.bot_id);\n    res.setHeader("Cache-Control", NO_STORE);',
    tests: API,
  },
  {
    name: "se quita la sanitización: la CPU del bot sale a cualquier lector",
    file: "apps/api/src/routes/battles.ts",
    from: "        cpuMs: !mine || p.cpu_ms === null",
    to: "        cpuMs: p.cpu_ms === null",
    tests: API,
  },
  {
    name: "se quita la sanitización: el diagnóstico sale a cualquier lector",
    file: "apps/api/src/routes/battles.ts",
    from: "      if (owner) {\n        diagnostics[botId] = buildDiagnostics(",
    to: "      if (true) {\n        diagnostics[botId] = buildDiagnostics(",
    tests: API,
  },
  {
    name: "se devuelve el participante/bot completo (con su dueño)",
    file: "apps/api/src/routes/battles.ts",
    from: "      return {\n        botId: p.bot_id,\n        botName: p.bot_name ?? undefined,",
    to: "      return {\n        ...p,\n        botId: p.bot_id,\n        botName: p.bot_name ?? undefined,",
    tests: API,
  },
  {
    name: "inscribir pasa el bot a public automáticamente",
    file: "apps/api/src/routes/tournaments.ts",
    from: "    // Congela la COMBINACIÓN exacta código+loadout (cap. 17.2).",
    to: '    await db("bots").where({ id: botId }).update({ visibility: "public" });\n    // Congela la COMBINACIÓN exacta código+loadout (cap. 17.2).',
    tests: API,
  },
  {
    name: "emitir pasa los bots de la batalla a public automáticamente",
    file: "apps/api/src/services/streaming.ts",
    from: '    const pub = await wherePubliclyShowable(db, db("battles").where("battles.id", t.id)).first();',
    to: '    await db("bots").whereIn("id", db("participants").where({ battle_id: t.id }).select("bot_id")).update({ visibility: "public" });\n    const pub = await wherePubliclyShowable(db, db("battles").where("battles.id", t.id)).first();',
    tests: API,
  },
  {
    name: "cerrar el torneo pone code_public=true a las versiones inscritas",
    file: "apps/api/src/routes/tournaments.ts",
    from: '    if (!t) throw notFound();\n    if (t.state !== "open") {\n      throw conflict("illegal_transition"',
    to: '    if (!t) throw notFound();\n    await db.raw("UPDATE bot_versions v SET code_public = true FROM entries e WHERE e.bot_id = v.bot_id AND e.version = v.version AND e.tournament_id = ?", [t.id]);\n    if (t.state !== "open") {\n      throw conflict("illegal_transition"',
    tests: API,
  },
  {
    name: "updateBot permitido a quien no es dueño",
    file: "apps/api/src/routes/bots.ts",
    from: "    assertOwner(req.auth, bot); // metadatos: SOLO el dueño (contrato)",
    to: "    /* mutante: sin assertOwner */",
    tests: API,
  },
  {
    name: "cambiar la visibilidad del código permitido a quien no es dueño",
    file: "apps/api/src/routes/bots.ts",
    from: '  defineOperation(router, "setBotVersionCodeVisibility", async (req, res) => {\n    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));\n    assertOwner(req.auth, bot);',
    to: '  defineOperation(router, "setBotVersionCodeVisibility", async (req, res) => {\n    const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));',
    tests: API,
  },
  {
    name: "el torneo con broadcast deja de autorizar (vuelve «todos los bots públicos»)",
    file: "apps/api/src/replay-access.ts",
    from: '        db("tournaments").whereRaw("tournaments.id = battles.tournament_id").where("tournaments.broadcast", true),',
    to: '        db("tournaments").whereRaw("false"),',
    tests: API,
  },
  {
    name: "cualquier batalla pasa a ser mostrable en público (se quita el NOT EXISTS)",
    file: "apps/api/src/replay-access.ts",
    from: '          .whereNot("bots.visibility", "public"),\n      )\n      .orWhereExists(',
    to: '          .whereRaw("false"),\n      )\n      .orWhereExists(',
    tests: API,
  },
  {
    name: "el cuadro deja de ocultar bots privados en torneos SIN broadcast",
    file: "apps/api/src/routes/tournaments.ts",
    from: "      t.broadcast === true\n        ? new Set<string>()",
    to: "      true\n        ? new Set<string>()",
    tests: API,
  },
  {
    name: "el precheck de streaming deja de bloquear destinos no autorizados",
    file: "apps/api/src/routes/streaming.ts",
    from: "    if (!info.broadcastable) {\n      throw conflict(",
    to: "    if (false) {\n      throw conflict(",
    tests: API,
  },
  {
    name: "la web enseña los controles de visibilidad a quien no es dueño",
    file: "apps/web/src/pages/BotDetailPage.tsx",
    from: "  const canEditVisibility = props.meId !== undefined && props.meId === bot.ownerId;",
    to: "  const canEditVisibility = true;",
    tests: WEB,
  },
  {
    name: "la web de torneos vuelve a pedir que el bot sea público",
    file: "apps/web/src/pages/TournamentDetailPage.tsx",
    from: '  const quien = visibility === "team" ? "Este bot es de equipo." : "Este bot es privado.";',
    to: '  const quien = "Debes hacerlo público.";',
    tests: WEB,
  },
];

let survivors = 0;
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`ROTO      · ${m.name} (el patrón ya no existe: actualiza el mutante)`);
    survivors += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let red = false;
  let why = "";
  try {
    execFileSync("npx", ["vitest", "run", ...m.tests], { stdio: "pipe" });
  } catch (e) {
    red = true;
    // Qué test se puso rojo: un rojo por la razón equivocada se lee igual que uno legítimo.
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    why = [
      ...new Set(
        out
          .split("\n")
          .filter((l) => /FAIL .*>/.test(l))
          .map((l) => l.replace(/^.*FAIL\s+/, "").trim()),
      ),
    ]
      .slice(0, 3)
      .join(" | ");
  } finally {
    writeFileSync(m.file, original);
  }
  console.log(`${red ? "ROJA     " : "SOBREVIVE"} · ${m.name}${why ? `\n            ↳ ${why}` : ""}`);
  if (!red) survivors += 1;
}

console.log(survivors === 0 ? "\nTodas las mutaciones se detectaron." : `\n${survivors} mutación(es) sin detectar.`);
process.exit(survivors === 0 ? 0 : 1);
