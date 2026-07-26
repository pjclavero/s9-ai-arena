/**
 * Equipos y bots de demostración para una instancia real.
 *
 * Crea tres equipos de tres bots cada uno, con código fuente de los bots de
 * ejemplo del repo y loadouts de arquetipo que YA validan contra el catálogo
 * vigente (`example-bots/loadouts.test.ts`).
 *
 * Reglas que respeta a propósito:
 *  - NO crea usuarios: el propietario debe existir ya. Si no existe, falla.
 *  - NO fabrica estados de validación: las versiones quedan en `draft`, que es
 *    el único estado alcanzable sin pasar por el pipeline de bot-manager.
 *    Marcarlas como `validated`/`published` a mano sería saltarse el control de
 *    seguridad que valida el código en sandbox.
 *  - Idempotente y REPARADOR: repetirlo no duplica nada, y completa lo que
 *    hubiera quedado a medias (un bot sin loadout o sin versión).
 *  - Lee TODOS los fuentes antes de escribir en la BD: si falta un fichero,
 *    falla sin dejar equipos ni bots a medias.
 *
 * B5 — reparación de bots con la ÚLTIMA versión en estado inservible:
 * `rejected` (y, por el mismo motivo, `suspended`/`retired`) no tienen NINGUNA
 * transición de vuelta a un estado con el que se pueda seguir trabajando
 * (`TRANSITIONS` en services/bots.ts: nada transiciona DESDE `suspended` ni
 * `retired`; `rejected` solo permite reintentar el MISMO código con `submit`,
 * lo cual no ayuda si lo que falló fue el propio código —como pasó con el
 * Artillero en B3—, o si se prefiere no reintentar a ciegas). Antes, si el
 * bot ya tenía alguna versión, la función no hacía nada, así que un bot
 * `rejected` quedaba inservible para siempre. Ahora, si la ÚLTIMA versión
 * (la de número más alto) está en uno de esos estados terminales, se crea la
 * siguiente versión (`version = max + 1`) en `draft` con el código ACTUAL del
 * repo, sin tocar ni borrar la versión vieja (historial inmutable) y sin
 * saltarse la sandbox (nace en `draft`, como la v1).
 *
 * `draft`, `validating`, `validated`, `published` NO se tocan: son estados
 * "en curso" dentro del pipeline o del ciclo de vida normal de un bot, y
 * crear una versión nueva por debajo sin que nadie lo pida sería sorprendente
 * (además de romper la idempotencia: cada ejecución del seed encontraría una
 * versión "distinta" y seguiría añadiendo versiones). `frozen` tampoco se
 * toca: es un bot publicado y bloqueado a propósito por un torneo en curso
 * (E9), no uno inservible.
 *
 * ¿Y si el código del repo cambió pero la última versión SIGUE en un estado
 * "en curso" (p.ej. `draft` o `published`)? A propósito, NO se crea versión
 * nueva solo por eso. Esta función es un seed/reparador idempotente, no un
 * sincronizador de código: una vez que una versión existe y está viva en el
 * pipeline (o publicada), su ciclo de vida lo controla el pipeline/el dueño
 * del bot, no una re-ejecución de este script. Lo contrario abriría una
 * clase de fallo nueva: cada cambio en example-bots/ o en el Artillero
 * derivado crearía versiones fantasma en cualquier entorno donde se
 * reejecute el seed. Ver el test "no crea versión nueva solo porque el
 * código del repo cambió si la última versión sigue siendo utilizable".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Knex } from "knex";
import { ARCHETYPES } from "../../../../../packages/module-catalog/resolve/archetypes.js";
import { CATALOG_VERSION } from "../../../../../packages/module-catalog/loadCatalog.js";
import { createLoadoutRevision, validateLoadoutServerSide } from "../../services/bots.js";
import type { Db } from "../connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

interface BotSpec {
  /** Sufijo del nombre; el nombre final es `<equipo> <sufijo>`. */
  role: string;
  archetype: keyof typeof ARCHETYPES;
  runtime: "python" | "node";
  sourcePath: string;
  /** Transformación opcional del fuente leído de `sourcePath` (ver Artillero, B3). */
  transform?: (raw: Buffer) => Buffer;
}

/**
 * Deriva el código del Artillero desde bots/s9-smoke-bot/main.py (B3).
 *
 * NO se usa el fichero íntegro tal cual: su wrapper de proceso (`main()`,
 * `import os`, `from __future__ import annotations`) es el lanzador de esa
 * imagen FIJA y separada (bots/s9-smoke-bot/Dockerfile, que arranca
 * `python /bot/main.py` leyendo WS_URL/BATTLE_TOKEN/BOT_ID del entorno) — no es
 * "lógica de bot", y además hace que static_analysis lo rechace igual que a
 * gunner.ts, aunque por motivos distintos, verificados de verdad con
 * `analyze()` (apps/bot-manager/src/static-analysis.ts):
 *   - `import os` está en la lista de builtins peligrosos por decisión
 *     deliberada (config.ts DEFAULT_PYTHON_DANGEROUS, R2.4/ERR-SEC-06) y la
 *     política por defecto BLOQUEA. B3 tiene prohibido tocar esa política para
 *     que un bot pase, así que no se toca: se evita el import en vez de
 *     permitirlo.
 *   - `from __future__ import annotations` NO está en la stdlib reconocida
 *     (PYTHON_STDLIB de static-analysis.ts) y se rechaza como import no
 *     permitido. ESTO ES UN HALLAZGO NUEVO de B3, no inventado ni hipotético:
 *     afecta también a explorer.py y defender.py (los otros dos bots de esta
 *     misma plantilla, sin tocar), que usan la misma línea. Es un falso
 *     positivo real (ese import no ejecuta nada, es una directiva del
 *     compilador) pero tocar la lista de imports permitidos es tocar política
 *     de seguridad — fuera del alcance de B3. Queda documentado aquí y en el
 *     informe de entrega para que se corrija en un bloque futuro; NO se corrige
 *     en este cambio.
 *
 * Lo que SÍ se conserva, íntegro: la clase `SmokeBot` — el cerebro real del
 * bot (perseguir-apuntar-disparar/patrullar), la misma que usa la batalla E2E
 * de humo (R6.2). Solo se le antepone el import que necesita.
 */
export function deriveArtilleroSource(mainPy: Buffer): Buffer {
  const raw = mainPy.toString("utf8");
  const start = raw.indexOf("class SmokeBot");
  const end = raw.indexOf("\n\n\ndef main");
  if (start === -1 || end === -1) {
    throw new Error(
      "bots/s9-smoke-bot/main.py cambió de forma y ya no tiene los marcadores esperados " +
        "('class SmokeBot' ... '\\n\\n\\ndef main'): revisa deriveArtilleroSource en demo-teams.ts",
    );
  }
  const classBody = raw.slice(start, end).trimEnd();
  return Buffer.from(`from arena_sdk import ArenaBot, angle_diff, angle_to\n\n\n${classBody}\n`, "utf8");
}

/**
 * Un bot por rol. Explorador y Defensor usan el arquetipo que su propio código
 * documenta (scout/heavy). El Artillero es la excepción, y a propósito (B3):
 *
 * El repo NO tiene ningún bot de ejemplo en JavaScript puro — gunner.ts y
 * miner.ts (example-bots/javascript/) son TypeScript, igual que bots/bot-red y
 * bots/bot-blue. static_analysis corre ANTES de build (sin transpilación
 * posible) y acorn no parsea TypeScript, así que un bot sembrado con gunner.ts
 * queda rechazado fail-closed para SIEMPRE en la etapa 2/10 — el propio
 * pipeline nunca lo valida. Se sustituye por bots/s9-smoke-bot/main.py (vía
 * `deriveArtilleroSource`, ver arriba), el bot mínimo oficial (R6.2) que YA usa
 * la batalla E2E real de humo: es Python de verdad, no un stub, y sí pasa el
 * análisis estático (verificado con `analyze()`, no solo asumido).
 * Aviso honesto: ese código NO está escrito ni optimizado para el arquetipo
 * "gunner" (cañón pesado a distancia) — es una estrategia mínima
 * perseguir-apuntar-disparar/patrullar, agnóstica de loadout. Se mantiene el
 * arquetipo "gunner" para el rol solo porque el loadout (chasis+módulos) es
 * independiente del código del bot; no es una afirmación de que el código esté
 * ajustado a ese arquetipo.
 */
const ROSTER: BotSpec[] = [
  { role: "Explorador", archetype: "scout", runtime: "python", sourcePath: "example-bots/python/explorer.py" },
  { role: "Defensor", archetype: "heavy", runtime: "python", sourcePath: "example-bots/python/defender.py" },
  {
    role: "Artillero",
    archetype: "gunner",
    runtime: "python",
    sourcePath: "bots/s9-smoke-bot/main.py",
    transform: deriveArtilleroSource,
  },
];

/**
 * Estados de `bot_versions` "en curso": si la ÚLTIMA versión de un bot está en
 * uno de estos, no se toca (ver comentario B5 arriba). Cualquier otro estado
 * alcanzable en la práctica (`rejected`, `suspended`, `retired`) se considera
 * inservible y dispara la creación de la siguiente versión.
 */
const WORKABLE_STATES = new Set(["draft", "validating", "validated", "published", "frozen"]);

export interface DemoTeamsResult {
  teams: { name: string; created: boolean }[];
  bots: { name: string; team: string; created: boolean }[];
}

/**
 * @param ownerEmail propietario de los equipos y bots. Debe existir.
 * @param teamNames  equipos a crear; cada uno recibe la plantilla completa.
 */
export async function seedDemoTeams(
  db: Db,
  ownerEmail: string,
  teamNames: string[] = ["Equipo Rojo", "Equipo Azul"],
): Promise<DemoTeamsResult> {
  const owner = await db("users").where({ email: ownerEmail }).first();
  if (!owner) {
    throw new Error(
      `No existe ningún usuario con email ${ownerEmail}. Este comando NO crea usuarios: ` +
        `regístralo primero desde la aplicación.`,
    );
  }

  // Preflight: cargar todo el código ANTES de tocar la BD. Si la imagen no
  // trae example-bots/, esto falla aquí y no deja equipos ni bots a medias.
  // Clave por role (no por sourcePath): el Artillero aplica `transform` sobre
  // su fuente (B3, deriveArtilleroSource) y otro spec podría compartir la
  // misma ruta sin transformar.
  const sources = new Map<string, Buffer>();
  for (const spec of ROSTER) {
    const raw = readFileSync(join(REPO_ROOT, spec.sourcePath));
    sources.set(spec.role, spec.transform ? spec.transform(raw) : raw);
  }

  const result: DemoTeamsResult = { teams: [], bots: [] };

  for (const teamName of teamNames) {
    const team = await upsertTeam(db, teamName, owner.id, result);

    for (const spec of ROSTER) {
      const botName = `${teamName} · ${spec.role}`;
      await upsertBot(db, {
        botName,
        teamId: team.id,
        ownerId: owner.id,
        teamName,
        spec,
        source: sources.get(spec.role)!,
        result,
      });
    }
  }

  return result;
}

async function upsertTeam(db: Db, name: string, captainId: string, result: DemoTeamsResult) {
  const existing = await db("teams").where({ name }).first();
  if (existing) {
    result.teams.push({ name, created: false });
    return existing;
  }
  const [team] = await db("teams").insert({ name, captain_id: captainId }).returning("*");
  await db("team_members")
    .insert({ team_id: team.id, user_id: captainId, role: "captain" })
    .onConflict(["team_id", "user_id"])
    .ignore();
  result.teams.push({ name, created: true });
  return team;
}

async function upsertBot(
  db: Db,
  args: {
    botName: string;
    teamId: string;
    ownerId: string;
    teamName: string;
    spec: BotSpec;
    source: Buffer;
    result: DemoTeamsResult;
  },
): Promise<void> {
  const { botName, teamId, ownerId, teamName, spec, source, result } = args;

  const existing = await db("bots").where({ owner_id: ownerId, name: botName }).first();
  // Un bot ya completo no se toca... salvo que su última versión esté en un
  // estado inservible (B5, ver comentario de cabecera): entonces se le añade
  // la siguiente versión en vez de dejarlo bloqueado para siempre. Uno a
  // medias (sin loadout o sin versión, p.ej. porque una ejecución anterior se
  // interrumpió) se completa aquí.
  if (existing) {
    const versions = await db("bot_versions").where({ bot_id: existing.id }).orderBy("version", "desc");
    if (versions.length === 0) {
      await ensureLoadoutAndVersion(db, existing.id, spec, source, 1);
      result.bots.push({ name: botName, team: teamName, created: true });
      return;
    }
    const latest = versions[0];
    if (WORKABLE_STATES.has(latest.state)) {
      result.bots.push({ name: botName, team: teamName, created: false });
      return;
    }
    await ensureLoadoutAndVersion(db, existing.id, spec, source, latest.version + 1);
    result.bots.push({ name: botName, team: teamName, created: true });
    return;
  }

  const [bot] = await db("bots")
    .insert({ name: botName, owner_id: ownerId, team_id: teamId, visibility: "team" })
    .returning("*");

  await ensureLoadoutAndVersion(db, bot.id, spec, source, 1);
  result.bots.push({ name: botName, team: teamName, created: true });
}

async function ensureLoadoutAndVersion(
  db: Db,
  botId: string,
  spec: BotSpec,
  source: Buffer,
  version: number,
): Promise<void> {
  // El loadout se valida con el MISMO validador que usa la API: si el catálogo
  // cambiara y el arquetipo dejara de ser legal, esto falla en vez de guardar
  // un loadout inválido.
  const archetype = ARCHETYPES[spec.archetype];
  const loadoutInput = {
    name: `${spec.role} (${spec.archetype})`,
    catalogVersion: CATALOG_VERSION,
    chassis: archetype.chassis,
    modules: archetype.modules,
  };
  const validation = await validateLoadoutServerSide(db, loadoutInput);
  if (validation.violations.length > 0) {
    throw new Error(
      `El arquetipo "${spec.archetype}" no valida contra el catálogo ${CATALOG_VERSION}: ` +
        JSON.stringify(validation.violations),
    );
  }
  // Reutiliza la revisión existente si el bot ya tenía loadout (caso reparación).
  const previa = await db("bot_loadouts").where({ bot_id: botId }).orderBy("revision", "desc").first();
  const loadout = previa ?? (await createLoadoutRevision(db, botId, loadoutInput, validation.summary!));

  await db("bot_versions").insert({
    bot_id: botId,
    version,
    state: "draft",
    runtime: spec.runtime,
    loadout_revision: loadout.revision,
    source,
    source_filename: spec.sourcePath.split("/").pop(),
    code_public: false,
  });
}

export function formatDemoTeamsResult(r: DemoTeamsResult): string {
  const nuevos = r.bots.filter((b) => b.created).length;
  const equipos = r.teams.filter((t) => t.created).length;
  const lines = [`Equipos nuevos: ${equipos}/${r.teams.length}. Bots nuevos: ${nuevos}/${r.bots.length}.`];
  for (const t of r.teams) {
    lines.push(`  ${t.name}${t.created ? "" : " (ya existía)"}`);
    for (const b of r.bots.filter((x) => x.team === t.name)) {
      lines.push(`    - ${b.name}${b.created ? "" : " (ya existía)"}`);
    }
  }
  lines.push("Las versiones quedan en 'draft': envíalas a validación desde la aplicación.");
  return lines.join("\n");
}
