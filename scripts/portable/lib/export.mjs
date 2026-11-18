/**
 * EXPORT portable (sólo lectura contra la API). Escribe directamente en `dest`.
 *
 * Alcance: los BOTS del usuario autenticado (todos, también los retirados) y los EQUIPOS de los
 * que es capitán. No exporta batallas, torneos, rankings, estadísticas, usuarios, sesiones ni
 * credenciales de streaming. Termina verificando lo escrito; si algo no cuadra, falla y deja el
 * marcador `.export-incomplete` para que el import lo rechace.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filenameFromDisposition } from "./api.mjs";
import {
  CHECKSUMS,
  DEFAULT_VERSIONS_POLICY,
  FORMAT_VERSION,
  INCOMPLETE_MARKER,
  MANIFEST,
  PortableError,
  TOOL_NAME,
  assignSlugs,
  canonicalJson,
  scanExportDir,
  selectVersions,
  sha256Hex,
  verifyExport,
} from "./format.mjs";

const byCreated = (a, b) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Lee el motor REAL de la instalación de ORIGEN desde su propia API: la auditoría de la batalla
 * terminada más reciente (`GET /battles/{id}/audit` → `versions.engine`) dice con qué motor se
 * jugó. Devuelve `{ version, battleId }` o `null` si no hay ninguna batalla legible (instalación sin
 * batallas o sin acceso a ellas): entonces `--engine-version` es obligatorio. Sólo lectura.
 */
export async function detectEngineVersion(client, { attempts = 5 } = {}) {
  const page = await client.json("GET", "/battles?status=finished&limit=50").catch(() => null);
  const items = [...(page?.items ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  for (const b of items.slice(0, attempts)) {
    const audit = await client.json("GET", `/battles/${b.id}/audit`).catch(() => null);
    const v = audit?.versions?.engine;
    if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) return { version: v, battleId: b.id };
  }
  return null;
}

/**
 * Decide el motor de origen a partir de `--engine-version` (opcional) y de lo detectado en la API.
 * Con ambos, deben coincidir (se VALIDA); sin flag se usa lo detectado; sin ninguno, error.
 * Devuelve `{ engineVersion, engineVersionSource }`.
 */
export function resolveEngineVersion(flag, detected, accept = {}) {
  if (flag && detected && flag !== detected.version) {
    const { version: acceptVersion, reason } = accept ?? {};
    if (acceptVersion !== undefined) {
      // Salida explícita y auditada: hay que repetir el valor EXACTO de --engine-version y dar motivo.
      if (acceptVersion !== flag)
        throw new PortableError(
          "engine_accept_mismatch",
          `--accept-engine ${acceptVersion} no coincide con --engine-version ${flag}: hay que repetir el valor exacto.`,
        );
      if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 300)
        throw new PortableError(
          "engine_accept_reason",
          "--accept-engine exige --accept-engine-reason <motivo> (10 a 300 caracteres): queda en el manifest.",
        );
      return {
        engineVersion: flag,
        engineVersionSource: "flag-forced",
        engineOverride: {
          accepted: flag,
          detected: detected.version,
          detectedBattleId: detected.battleId ?? null,
          reason: reason.trim(),
        },
      };
    }
    throw new PortableError(
      "engine_mismatch",
      `--engine-version ${flag} no coincide con el motor que la API de origen declara en la auditoría de su última batalla (${detected.version}). Revisa cuál es el motor desplegado antes de exportar; si es correcto de verdad, repite con --accept-engine ${flag} --accept-engine-reason <motivo>.`,
    );
  }
  if (flag) return { engineVersion: flag, engineVersionSource: detected ? "flag+audit" : "flag" };
  if (detected) return { engineVersion: detected.version, engineVersionSource: "audit" };
  throw new PortableError(
    "usage",
    "Falta --engine-version <x.y.z>: la API de origen no tiene ninguna batalla terminada legible de la que leerlo. Es el motor de la instalación de ORIGEN y no se adivina (el checkout de esta herramienta puede ser de otra versión): léelo del despliegue (engine-deps.json del commit desplegado).",
  );
}

export async function runExport({
  client,
  dest,
  versionsPolicy = DEFAULT_VERSIONS_POLICY,
  sourceSha = "unknown",
  engineVersion,
  engineVersionSource = "flag",
  engineOverride = undefined,
  now = () => new Date(),
  log = () => {},
  knownSecrets = [],
  limits = {},
}) {
  if (!engineVersion)
    throw new PortableError(
      "no_engine",
      "engineVersion es obligatorio (--engine-version o checkout con engine-deps.json).",
    );
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new PortableError("dest_not_empty", `${dest} no está vacío: el export no sobrescribe nada.`);
  }
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, INCOMPLETE_MARKER), "export en curso o fallido\n");

  const files = []; // { path, sha256, bytes }
  const put = (rel, content) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const full = join(dest, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, buf);
    files.push({ path: rel, sha256: sha256Hex(buf), bytes: buf.length });
  };

  const me = await client.json("GET", "/users/me");
  if (!me?.id) throw new PortableError("no_me", "GET /users/me no devolvió el usuario.");
  const known = [me.id, me.email, ...knownSecrets, client.token];

  // ---------------------------------------------------------------- bots
  const mine = (await client.listAll("/bots", { ownerId: me.id })).filter((b) => b.ownerId === me.id).sort(byCreated);
  const slugs = assignSlugs(mine.map((b) => b.name));
  const slugById = new Map(mine.map((b, i) => [b.id, slugs[i]]));
  const catalogs = new Set();
  const omittedAll = [];
  const omittedLoadouts = []; // revisiones de loadout que NO viajan (ni usadas por versiones exportadas ni la última)
  let nVersions = 0;
  let nLoadouts = 0;

  for (const bot of mine) {
    const slug = slugById.get(bot.id);
    log(`bot ${slug}`);
    const versions = await client.json("GET", `/bots/${bot.id}/versions`);
    const loadouts = await client.json("GET", `/bots/${bot.id}/loadouts`);
    const { selected, omitted } = selectVersions(versions, versionsPolicy);
    for (const o of omitted) omittedAll.push({ bot: slug, ...o });

    const selectedNums = new Set(selected.map((v) => v.version));
    const neededRevs = new Set(selected.map((v) => v.loadoutRevision));
    const latestRev = Math.max(0, ...loadouts.map((l) => l.revision));
    if (latestRev > 0) neededRevs.add(latestRev);
    const keptLoadouts = loadouts.filter((l) => neededRevs.has(l.revision));
    for (const l of loadouts.filter((x) => !neededRevs.has(x.revision)).sort((a, b) => a.revision - b.revision))
      omittedLoadouts.push({ bot: slug, revision: l.revision, ...(l.name ? { name: l.name } : {}) });
    for (const v of selected) {
      if (!loadouts.some((l) => l.revision === v.loadoutRevision)) {
        throw new PortableError(
          "missing_loadout",
          `${slug}: la versión ${v.version} usa una revisión de loadout (${v.loadoutRevision}) que la API no devuelve.`,
        );
      }
    }

    const outVersions = [];
    for (const v of selected) {
      const src = await client.request("GET", `/bots/${bot.id}/versions/${v.version}/source`);
      const detail = await client.json("GET", `/bots/${bot.id}/versions/${v.version}`);
      if (detail.canReadSource === false) {
        throw new PortableError("source_unreadable", `${slug} v${v.version}: la API no permite leer el código.`);
      }
      const bytes = src.bytes ?? Buffer.alloc(0);
      const sha = sha256Hex(bytes);
      if (!detail.sourceSha256 || detail.sourceSha256 !== sha) {
        throw new PortableError(
          "source_hash_mismatch",
          `${slug} v${v.version}: el código descargado (${sha.slice(0, 12)}…) no coincide con el hash que declara la API.`,
        );
      }
      const file = `bots/${slug}/versions/v${v.version}/source.bin`;
      put(file, bytes);
      outVersions.push({
        version: v.version,
        state: v.state,
        runtime: v.runtime,
        loadoutRevision: v.loadoutRevision,
        parentVersion: v.parentVersion != null && selectedNums.has(v.parentVersion) ? v.parentVersion : null,
        ...(v.parentVersion != null && !selectedNums.has(v.parentVersion)
          ? { parentVersionOmitted: v.parentVersion }
          : {}),
        codePublic: v.codePublic === true,
        source: {
          file,
          filename: filenameFromDisposition(src.headers.get("content-disposition")) ?? "source.bin",
          sha256: sha,
          bytes: bytes.length,
        },
      });
      nVersions++;
    }
    for (const l of keptLoadouts) catalogs.add(l.catalogVersion);
    nLoadouts += keptLoadouts.length;
    put(
      `bots/${slug}/bot.json`,
      canonicalJson({
        slug,
        name: bot.name,
        visibility: bot.visibility,
        retired: !!bot.retiredAt,
        loadouts: keptLoadouts.map((l) => ({
          revision: l.revision,
          ...(l.name ? { name: l.name } : {}),
          catalogVersion: l.catalogVersion,
          chassis: l.chassis,
          modules: l.modules,
          ...(l.summary ? { summary: l.summary } : {}),
        })),
        versions: outVersions,
        omittedVersions: omitted,
      }),
    );
  }

  // ---------------------------------------------------------------- equipos
  const allTeams = await client.listAll("/teams");
  const captainTeams = allTeams.filter((t) => t.isCaptain === true);
  const notCaptainTeams = allTeams.filter((t) => t.isMember === true && t.isCaptain !== true);
  const notCaptain = notCaptainTeams.length;
  // Qué bots PROPIOS del operador estaban en equipos ajenos (por slug; ni nombre del equipo ni
  // datos de otros usuarios): esa pertenencia se pierde y hay que rehacerla con el capitán.
  const lostMembership = new Map(); // slug -> nº de equipos ajenos
  for (const t of notCaptainTeams)
    for (const b of Array.isArray(t.bots) ? t.bots : []) {
      const s = slugById.get(b.id);
      if (s) lostMembership.set(s, (lostMembership.get(s) ?? 0) + 1);
    }
  const botsInForeignTeams = [...lostMembership.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bot, teams]) => ({ bot, teams }));
  const teamSlugs = assignSlugs(captainTeams.map((t) => t.name));
  const warnings = [];
  if (engineOverride)
    warnings.push(
      `Motor de origen FORZADO: se declara ${engineOverride.accepted} aunque la API de origen reporta ${engineOverride.detected} (motivo en manifest.engineOverride).`,
    );
  captainTeams.forEach((t, i) => {
    const slug = teamSlugs[i];
    const members = Array.isArray(t.members) ? t.members : [];
    const tBots = Array.isArray(t.bots) ? t.bots : [];
    const ownBots = [];
    let externalCount = 0;
    for (const b of tBots) {
      const s = slugById.get(b.id);
      if (s) ownBots.push(s);
      else externalCount += 1;
    }
    if (externalCount)
      warnings.push(`El equipo «${t.name}» incluye ${externalCount} bot(s) de otros usuarios: no se exportan.`);
    if (members.length > 1) {
      warnings.push(
        `El equipo «${t.name}» tiene ${members.length - 1} miembro(s) además del capitán: las cuentas no se migran; hay que volver a invitarlas.`,
      );
    }
    put(
      `teams/${slug}.json`,
      canonicalJson({
        slug,
        name: t.name,
        operatorRole: "captain",
        bots: ownBots.sort(),
        // sólo un recuento: ni nombre ni id de bots de otros usuarios
        externalBotsCount: externalCount,
        otherMembers: {
          count: Math.max(0, members.length - 1),
          roles: members
            .filter((m) => m.userId !== me.id)
            .map((m) => m.role)
            .sort(),
        },
      }),
    );
  });
  if (notCaptain > 0)
    warnings.push(
      `${notCaptain} equipo(s) donde el usuario es miembro pero no capitán: no se exportan (no son suyos)` +
        (botsInForeignTeams.length
          ? `; ${botsInForeignTeams.length} bot(s) propios pertenecían a ellos (manifest.botsInForeignTeams).`
          : "."),
    );
  if (omittedLoadouts.length)
    warnings.push(
      `${omittedLoadouts.length} revisión(es) de loadout no usadas por ninguna versión exportada ni la última no se exportan (manifest.omittedLoadouts).`,
    );

  // ---------------------------------------------------------------- manifest + checksums
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    formatVersion: FORMAT_VERSION,
    tool: TOOL_NAME,
    sourceSha,
    engineVersion,
    engineVersionSource,
    ...(engineOverride ? { engineOverride } : {}),
    createdAt: now().toISOString(),
    versionsPolicy,
    catalogVersions: [...catalogs].sort(),
    counts: {
      bots: mine.length,
      teams: captainTeams.length,
      versions: nVersions,
      loadouts: nLoadouts,
      omittedVersions: omittedAll.length,
      omittedLoadouts: omittedLoadouts.length,
    },
    omittedVersions: omittedAll,
    omittedLoadouts,
    botsInForeignTeams,
    warnings,
    files,
  };
  const manifestText = canonicalJson(manifest);
  writeFileSync(join(dest, MANIFEST), manifestText);
  const lines = [...files.map((f) => `${f.sha256}  ${f.path}`), `${sha256Hex(Buffer.from(manifestText))}  ${MANIFEST}`];
  lines.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  writeFileSync(join(dest, CHECKSUMS), lines.join("\n") + "\n");

  // ---------------------------------------------------------------- verificación final
  const hits = scanExportDir(dest, files, known);
  hits.push(...scanExportDir(dest, [{ path: MANIFEST }], known)); // el manifest también se escanea
  if (hits.length)
    throw new PortableError(
      "secret_in_export",
      `El export contiene datos sensibles; se aborta:\n  ${hits.join("\n  ")}`,
    );
  rmSync(join(dest, INCOMPLETE_MARKER)); // verifyExport rechaza el marcador; se quita para verificar y se repone si falla
  try {
    const v = verifyExport(dest, limits);
    if (v.bots.length !== mine.length)
      throw new PortableError("count_mismatch", "Se exportaron menos bots de los que lista la API.");
  } catch (e) {
    writeFileSync(join(dest, INCOMPLETE_MARKER), "verificación final fallida\n");
    throw e;
  }
  return { manifest, dest };
}
