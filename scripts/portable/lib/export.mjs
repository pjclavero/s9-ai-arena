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

export async function runExport({
  client,
  dest,
  versionsPolicy = "heads",
  sourceSha = "unknown",
  engineVersion,
  engineVersionSource = "flag",
  now = () => new Date(),
  log = () => {},
  knownSecrets = [],
}) {
  if (!engineVersion) throw new PortableError("no_engine", "engineVersion es obligatorio (--engine-version o checkout con engine-deps.json).");
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
    for (const v of selected) {
      if (!loadouts.some((l) => l.revision === v.loadoutRevision)) {
        throw new PortableError("missing_loadout", `${slug}: la versión ${v.version} usa una revisión de loadout (${v.loadoutRevision}) que la API no devuelve.`);
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
        ...(v.parentVersion != null && !selectedNums.has(v.parentVersion) ? { parentVersionOmitted: v.parentVersion } : {}),
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
  const notCaptain = allTeams.filter((t) => t.isMember === true && t.isCaptain !== true).length;
  const teamSlugs = assignSlugs(captainTeams.map((t) => t.name));
  const warnings = [];
  captainTeams.forEach((t, i) => {
    const slug = teamSlugs[i];
    const members = Array.isArray(t.members) ? t.members : [];
    const tBots = Array.isArray(t.bots) ? t.bots : [];
    const ownBots = [];
    const external = [];
    for (const b of tBots) {
      const s = slugById.get(b.id);
      if (s) ownBots.push(s);
      else external.push({ name: b.name });
    }
    if (external.length) warnings.push(`El equipo «${t.name}» incluye ${external.length} bot(s) de otros usuarios: no se exportan.`);
    if (members.length > 1) {
      warnings.push(`El equipo «${t.name}» tiene ${members.length - 1} miembro(s) además del capitán: las cuentas no se migran; hay que volver a invitarlas.`);
    }
    put(
      `teams/${slug}.json`,
      canonicalJson({
        slug,
        name: t.name,
        operatorRole: "captain",
        bots: ownBots.sort(),
        externalBots: external.sort((a, b) => (a.name < b.name ? -1 : 1)),
        otherMembers: { count: Math.max(0, members.length - 1), roles: members.filter((m) => m.userId !== me.id).map((m) => m.role).sort() },
      }),
    );
  });
  if (notCaptain > 0) warnings.push(`${notCaptain} equipo(s) donde el usuario es miembro pero no capitán: no se exportan (no son suyos).`);

  // ---------------------------------------------------------------- manifest + checksums
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    formatVersion: FORMAT_VERSION,
    tool: TOOL_NAME,
    sourceSha,
    engineVersion,
    engineVersionSource,
    createdAt: now().toISOString(),
    versionsPolicy,
    catalogVersions: [...catalogs].sort(),
    counts: { bots: mine.length, teams: captainTeams.length, versions: nVersions, loadouts: nLoadouts, omittedVersions: omittedAll.length },
    omittedVersions: omittedAll,
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
  if (hits.length) throw new PortableError("secret_in_export", `El export contiene datos sensibles; se aborta:\n  ${hits.join("\n  ")}`);
  rmSync(join(dest, INCOMPLETE_MARKER)); // verifyExport rechaza el marcador; se quita para verificar y se repone si falla
  try {
    const v = verifyExport(dest);
    if (v.bots.length !== mine.length) throw new PortableError("count_mismatch", "Se exportaron menos bots de los que lista la API.");
  } catch (e) {
    writeFileSync(join(dest, INCOMPLETE_MARKER), "verificación final fallida\n");
    throw e;
  }
  return { manifest, dest };
}
