/**
 * EQ2 · ADR-022 · Documentación CANÓNICA de reglas y desempates, GENERADA desde el
 * registro (`battle-rules.ts`), para que las reglas no existan sólo en código.
 *
 * Produce:
 *  - `docs/user/rules.md`  · para personas (y para el Centro de Ayuda);
 *  - `docs/user/rules.json` · los mismos datos, estructurados, para consumirlos sin
 *    parsear Markdown (Centro de Ayuda, selector de modo, `ⓘ`).
 * `scripts/generate-rules-doc.ts` los escribe; `rules-doc.test.ts` falla si el fichero
 * del repo no coincide con lo que genera el registro (nunca se desincronizan).
 */
import {
  CTF_OVERTIME_MAX_SECONDS,
  CUSTOM_FORBIDDEN_FIELDS,
  MAX_BATTLE_PARTICIPANTS,
  RULES_LIMITS,
  RULES_PRESETS,
  TIEBREAK_RULES,
  TOURNAMENT_SPECTATOR_DELAY_SECONDS,
  currentPresets,
  presetKey,
  respawnLabel,
  summarizeParams,
  tiebreakFamilyOf,
  type RulesPreset,
} from "./battle-rules.js";

/** Versión del documento JSON (sube si cambia su forma). */
export const RULES_DOC_SCHEMA = 1;

const MAP_REQUIREMENTS: { mode: string; name: string; requirement: string }[] = [
  { mode: "deathmatch", name: "Deathmatch", requirement: "al menos 2 spawns" },
  { mode: "team_deathmatch", name: "Deathmatch por equipos", requirement: "spawns de al menos 2 bandos" },
  {
    mode: "capture_the_flag",
    name: "Capturar la bandera",
    requirement: "base Y bandera de al menos 2 equipos; cada bando de la batalla debe tener las suyas (rojo/azul)",
  },
  { mode: "zone_control", name: "Control de zona", requirement: "al menos una zona de captura" },
];

function presetJson(p: RulesPreset) {
  const params = { ...p.params, teamSize: p.teamSizes[0] };
  const family = tiebreakFamilyOf(params);
  return {
    key: presetKey(p),
    id: p.id,
    version: p.version,
    name: p.name,
    format: p.format,
    game: p.game,
    teamSizes: [...p.teamSizes],
    tagline: p.tagline,
    description: p.description,
    respawn: respawnLabel(params),
    tiebreakFamily: family,
    summary: summarizeParams(params).filter((l) => !/^\d+ contra \d+/.test(l)),
    params: structuredClone(p.params),
  };
}

export function rulesDocJson() {
  return {
    schema: RULES_DOC_SCHEMA,
    $comment:
      "GENERADO desde packages/game-rules/battle-rules.ts (npx tsx scripts/generate-rules-doc.ts). No editar a mano.",
    engineVersion: "0.4.0",
    respawn: {
      definition:
        "maxRespawns es el número de veces que un bot puede REAPARECER después de morir. Vidas totales = maxRespawns + 1.",
      table: [0, 1, 2].map((n) => ({ maxRespawns: n, lives: n + 1 })),
      modes: {
        none: "sin reaparición: 1 vida",
        limited: `limitada: maxRespawns entre ${RULES_LIMITS.maxRespawns.min} y ${RULES_LIMITS.maxRespawns.max}`,
        unlimited: "ilimitada",
      },
    },
    tiebreaks: Object.values(TIEBREAK_RULES).map((t) => ({ ...t, criteria: [...t.criteria], steps: [...t.steps] })),
    ctf: {
      basePreset: "ctf@1",
      overtimeMaxSeconds: CTF_OVERTIME_MAX_SECONDS,
      rules: [
        "cada equipo tiene bandera y base",
        "tocar la bandera rival a distancia válida (2 m) la recoge",
        "el portador puede seguir combatiendo",
        "si el portador muere o lo descalifican, la bandera cae donde estaba",
        "un enemigo puede recoger una bandera caída; un compañero del equipo propietario puede devolverla tocándola",
        "una bandera caída que nadie toca vuelve sola a su base tras el retorno automático configurado",
        "llevar la bandera rival a la base propia puntúa una captura",
        "por defecto, la bandera propia debe estar en su base para puntuar",
        "al capturar, la bandera rival vuelve a su base",
        `si hay empate al acabar el tiempo: prórroga con el mismo estado (no se reinician bots, banderas ni posiciones); la siguiente captura gana; si en ${CTF_OVERTIME_MAX_SECONDS / 60} minutos nadie captura, empate (límite de seguridad)`,
      ],
    },
    presets: currentPresets().map(presetJson),
    presetHistory: RULES_PRESETS.map((p) => presetKey(p)),
    custom: {
      limits: structuredClone(RULES_LIMITS),
      maxParticipants: MAX_BATTLE_PARTICIPANTS,
      allowed: [
        "participantes: 1v1, 2v2, 3v3 o 4v4 (2 bandos de exactamente N bots)",
        "reaparición: ninguna, limitada (maxRespawns) o ilimitada",
        "espera de reaparición (segundos)",
        "tiempo máximo (minutos)",
        "objetivo: bajas para ganar o capturas para ganar (CTF)",
        "condición de victoria: eliminación, límite de bajas o más puntos al acabar el tiempo",
        "créditos máximos por bot y presupuesto total por equipo (reparto libre entre bots)",
        "masa máxima por bot y por equipo",
        "fuego amigo (sólo por equipos)",
        "CTF: capturas para ganar, retorno automático de la bandera y si se exige la bandera propia en base",
      ],
      forbidden: [...CUSTOM_FORBIDDEN_FIELDS],
      forbiddenText:
        "No se pueden alterar: multiplicadores de daño, gravedad, velocidad, vida (HP), sensores, munición infinita ni parámetros físicos internos.",
      teamBudgetExample: { teamCredits: 3500, bots: { "ATK-1": 1000, "ATK-2": 1000, SCOUT: 600, DEF: 900 } },
    },
    maps: MAP_REQUIREMENTS,
    spectator: {
      tournamentDelaySeconds: TOURNAMENT_SPECTATOR_DELAY_SECONDS,
      text: `En torneos, el directo para espectadores va con ${TOURNAMENT_SPECTATOR_DELAY_SECONDS} s de retardo (anti-coaching), salvo las batallas marcadas como visibles (la final). Las batallas creadas con «Nueva batalla» van sin retardo. El retardo no cambia la simulación.`,
    },
    snapshots:
      "Las reglas se copian de forma INMUTABLE en cada batalla y en cada torneo al crearlos. Cambiar después un preset (o crear su versión siguiente) no altera batallas ni torneos existentes.",
  };
}

const li = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n");

export function rulesDocMarkdown(): string {
  const d = rulesDocJson();
  const out: string[] = [];
  out.push("# Reglas de batalla, modos y desempates");
  out.push("");
  out.push(
    "> GENERADO desde el registro de reglas (`packages/game-rules/battle-rules.ts`) con `npx tsx scripts/generate-rules-doc.ts`. No editar a mano: `packages/game-rules/rules-doc.test.ts` falla si este fichero no coincide con el código. Versión del motor: **0.4.0** (ADR-022). Datos estructurados: [`rules.json`](rules.json).",
  );
  out.push("");
  out.push("## Reapariciones (`maxRespawns`)");
  out.push("");
  out.push(d.respawn.definition);
  out.push("");
  out.push("| `maxRespawns` | Vidas totales |");
  out.push("|---|---|");
  for (const r of d.respawn.table)
    out.push(`| ${r.maxRespawns} | ${r.lives}${r.maxRespawns > 0 ? ` (vida inicial + ${r.maxRespawns})` : ""} |`);
  out.push("");
  out.push(li([d.respawn.modes.none, d.respawn.modes.limited, d.respawn.modes.unlimited]));
  out.push("");
  out.push("## Desempates");
  out.push("");
  out.push(
    "Deterministas: sólo dependen del estado de la batalla en el último tick. Se aplican en orden; el primer criterio que distingue decide.",
  );
  out.push("");
  out.push("| Familia | Orden |");
  out.push("|---|---|");
  for (const t of d.tiebreaks) out.push(`| ${t.label} | ${t.steps.map((s, i) => `${i + 1}. ${s}`).join(" · ")} |`);
  out.push("");
  out.push(
    "La familia la decide el tipo de reaparición: sin reaparición ⇒ Eliminación; limitada ⇒ Respawn limitado; ilimitada ⇒ Team Deathmatch; y Capturar la bandera tiene su propia regla. Los presets y el personalizado usan la misma tabla. «Bajas» = vehículos ENEMIGOS destruidos (el fuego amigo y las muertes por zona de daño no cuentan).",
  );
  out.push("");
  out.push("## Capturar la bandera (base `ctf@1`)");
  out.push("");
  out.push(li(d.ctf.rules));
  out.push("");
  out.push("## Presets oficiales");
  out.push("");
  out.push(
    "Versionados e inmutables: si cambia una regla se crea `id@(versión+1)`; la versión anterior no se edita. Las batallas y torneos guardan la versión con la que se crearon.",
  );
  out.push("");
  for (const p of d.presets) {
    out.push(`### ${p.name} · \`${p.key}\``);
    out.push("");
    out.push(`${p.tagline}`);
    out.push("");
    out.push(`- Formato: ${p.format === "1v1" ? "1 contra 1" : p.teamSizes.map((n) => `${n}v${n}`).join(" / ")}`);
    out.push(li(p.summary));
    out.push("");
    out.push(p.description);
    out.push("");
  }
  out.push("## Personalizado");
  out.push("");
  out.push("Sólo parámetros competitivos:");
  out.push("");
  out.push(li(d.custom.allowed));
  out.push("");
  out.push(d.custom.forbiddenText);
  out.push("");
  out.push("| Parámetro | Mínimo | Máximo |");
  out.push("|---|---|---|");
  for (const [k, v] of Object.entries(d.custom.limits)) out.push(`| \`${k}\` | ${v.min} | ${v.max} |`);
  out.push("");
  out.push(
    `Presupuesto de equipo: el total se reparte como se quiera entre los bots. Ejemplo con ${d.custom.teamBudgetExample.teamCredits} cr: ${Object.entries(
      d.custom.teamBudgetExample.bots,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ", ",
      )}. El tope por bot es opcional y no puede superar al del equipo. Coste = chasis + módulos; masa = la física del motor.`,
  );
  out.push("");
  out.push("## Mapas compatibles por modo");
  out.push("");
  out.push("| Modo | El mapa necesita |");
  out.push("|---|---|");
  for (const m of d.maps) out.push(`| ${m.name} | ${m.requirement} |`);
  out.push("");
  out.push(
    "Además, el autor del mapa debe declarar el modo. «Nueva batalla» sólo ofrece mapas compatibles y explica por qué los demás no aparecen.",
  );
  out.push("");
  out.push("## Directo de torneos (retardo anti-coaching)");
  out.push("");
  out.push(d.spectator.text);
  out.push("");
  out.push("## Copia inmutable");
  out.push("");
  out.push(d.snapshots);
  out.push("");
  return out.join("\n");
}
