/**
 * IMPORT portable, SOLO por la API del destino con el token del usuario nuevo: la propiedad, el
 * validador de loadouts y los límites los aplica la propia aplicación.
 *
 * Orden: (0) verificar el export en disco y la compatibilidad de formato/motor, SIN red;
 * (1) leer el estado del destino; (2) bots → loadouts → versiones (siempre en `draft`);
 * (3) equipos. Nada se publica: `--submit` sólo ENCOLA la validación (build) de las versiones que
 * estaban publicadas/congeladas/validadas, para que el paso de publicación sea un acto del operador.
 *
 * Idempotente: un bot se reconoce por (dueño, nombre); un loadout por su contenido; una versión por
 * (sha256 del código, runtime, loadout). Repetir el import no crea nada nuevo y reanuda uno cortado.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PortableError, assertEngineCompatible, loadoutKey, verifyExport } from "./format.mjs";

const REBUILD_STATES = new Set(["published", "frozen", "validated"]);

const errMsg = (e) => (e instanceof PortableError ? e.message : String(e?.message ?? e));

export async function runImport({
  client,
  src,
  targetEngine,
  dryRun = false,
  submit = false,
  restoreVisibility = false,
  log = () => {},
}) {
  // (0) Todo lo que no necesita red, ANTES de tocar nada.
  const { manifest, bots, teams } = verifyExport(src);
  assertEngineCompatible(manifest.engineVersion, targetEngine);

  const report = {
    formatVersion: manifest.formatVersion,
    sourceSha: manifest.sourceSha,
    engineVersion: manifest.engineVersion,
    targetEngine,
    dryRun,
    submit,
    restoreVisibility,
    bots: [],
    teams: [],
    errors: [],
    summary: {},
  };
  const fail = (scope, message) => report.errors.push({ scope, message });

  // (1) estado del destino
  const me = await client.json("GET", "/users/me");
  if (!me?.id) throw new PortableError("no_me", "GET /users/me no devolvió el usuario.");
  const existingBots = new Map(
    (await client.listAll("/bots", { ownerId: me.id })).filter((b) => b.ownerId === me.id).map((b) => [b.name, b]),
  );
  const idBySlug = new Map();

  // (2) bots
  for (const bot of bots) {
    const entry = { slug: bot.slug, name: bot.name, id: null, action: null, loadouts: [], versions: [], errors: [] };
    report.bots.push(entry);
    const botFail = (m) => {
      entry.errors.push(m);
      fail(`bot:${bot.slug}`, m);
    };
    try {
      let target = existingBots.get(bot.name);
      if (target) entry.action = "reused";
      else {
        entry.action = "created";
        if (!dryRun) {
          log(`crear bot ${bot.slug}`);
          target = await client.json("POST", "/bots", { json: { name: bot.name, visibility: "private" } });
        }
      }
      entry.id = target?.id ?? null;
      if (target) idBySlug.set(bot.slug, target.id);

      // loadouts
      const revMap = new Map(); // revisión exportada -> revisión del destino
      const keyToRev = new Map();
      const existingRevKeys = new Map(); // revisión destino -> clave
      if (target && entry.action === "reused") {
        for (const l of await client.json("GET", `/bots/${target.id}/loadouts`)) {
          const k = loadoutKey(l);
          existingRevKeys.set(l.revision, k);
          if (!keyToRev.has(k)) keyToRev.set(k, l.revision);
        }
      }
      for (const l of [...bot.loadouts].sort((a, b) => a.revision - b.revision)) {
        const k = loadoutKey(l);
        const have = keyToRev.get(k);
        if (have !== undefined) {
          revMap.set(l.revision, have);
          entry.loadouts.push({ revision: l.revision, newRevision: have, action: "reused" });
          continue;
        }
        if (dryRun) {
          entry.loadouts.push({ revision: l.revision, newRevision: null, action: "would_create" });
          continue;
        }
        try {
          const created = await client.json("POST", `/bots/${target.id}/loadouts`, {
            json: {
              ...(l.name ? { name: l.name } : {}),
              catalogVersion: l.catalogVersion,
              chassis: l.chassis,
              modules: l.modules,
            },
          });
          revMap.set(l.revision, created.revision);
          keyToRev.set(k, created.revision);
          existingRevKeys.set(created.revision, k);
          entry.loadouts.push({ revision: l.revision, newRevision: created.revision, action: "created" });
        } catch (e) {
          entry.loadouts.push({ revision: l.revision, newRevision: null, action: "failed" });
          botFail(`loadout r${l.revision}: ${errMsg(e)}`);
        }
      }

      // versiones
      const existingVersions = new Map(); // clave -> versión destino
      if (target && entry.action === "reused") {
        for (const v of await client.json("GET", `/bots/${target.id}/versions`)) {
          const d = await client.json("GET", `/bots/${target.id}/versions/${v.version}`);
          if (d.sourceSha256) {
            const lk = existingRevKeys.get(v.loadoutRevision) ?? "";
            existingVersions.set(`${d.sourceSha256}|${v.runtime}|${lk}`, { version: v.version, state: v.state });
          }
        }
      }
      const verMap = new Map();
      for (const v of [...bot.versions].sort((a, b) => a.version - b.version)) {
        const lk = loadoutKey(bot.loadouts.find((l) => l.revision === v.loadoutRevision));
        const found = existingVersions.get(`${v.source.sha256}|${v.runtime}|${lk}`);
        const row = { version: v.version, newVersion: null, action: null, state: v.state, sha256: v.source.sha256 };
        entry.versions.push(row);
        if (found) {
          row.action = "reused";
          row.newVersion = found.version;
          verMap.set(v.version, found.version);
          if (submit && REBUILD_STATES.has(v.state) && found.state === "draft" && !dryRun)
            await queueBuild(client, target.id, found.version, row, botFail);
          continue;
        }
        const newRev = revMap.get(v.loadoutRevision);
        if (dryRun) {
          row.action = "would_create";
          continue;
        }
        if (newRev === undefined) {
          row.action = "skipped";
          botFail(`versión ${v.version}: su loadout (r${v.loadoutRevision}) no se pudo crear.`);
          continue;
        }
        try {
          const bytes = readFileSync(join(src, ...v.source.file.split("/")));
          const form = new FormData();
          form.append("runtime", v.runtime);
          form.append("loadoutRevision", String(newRev));
          if (v.parentVersion != null && verMap.has(v.parentVersion))
            form.append("parentVersion", String(verMap.get(v.parentVersion)));
          form.append("source", new Blob([bytes]), v.source.filename || "source.bin");
          log(`subir ${bot.slug} v${v.version}`);
          const created = await client.json("POST", `/bots/${target.id}/versions`, { form });
          const d = await client.json("GET", `/bots/${target.id}/versions/${created.version}`);
          if (d.sourceSha256 !== v.source.sha256) {
            throw new PortableError(
              "hash_after_import",
              `el código en el destino no coincide con el exportado (v${v.version}).`,
            );
          }
          row.action = "created";
          row.newVersion = created.version;
          existingVersions.set(`${v.source.sha256}|${v.runtime}|${lk}`, {
            version: created.version,
            state: created.state,
          });
          verMap.set(v.version, created.version);
          if (submit && REBUILD_STATES.has(v.state)) await queueBuild(client, target.id, created.version, row, botFail);
        } catch (e) {
          row.action = "failed";
          botFail(`versión ${v.version}: ${errMsg(e)}`);
        }
      }

      // visibilidad y retirado (sólo si el bot existe de verdad en el destino)
      if (target && !dryRun) {
        const patch = {};
        if (restoreVisibility && bot.visibility !== (target.visibility ?? "private")) patch.visibility = bot.visibility;
        if (bot.retired && !target.retiredAt) patch.retired = true;
        if (Object.keys(patch).length) await client.json("PATCH", `/bots/${target.id}`, { json: patch });
        if (restoreVisibility) {
          for (const v of bot.versions) {
            const nv = verMap.get(v.version);
            if (v.codePublic && nv)
              await client.json("PUT", `/bots/${target.id}/versions/${nv}/code-visibility`, {
                json: { codePublic: true },
              });
          }
        }
      }
    } catch (e) {
      entry.action ??= "failed";
      botFail(errMsg(e));
    }
  }

  // (3) equipos
  const existingTeams = new Map((await client.listAll("/teams")).map((t) => [t.name, t]));
  for (const team of teams) {
    const entry = { slug: team.slug, name: team.name, id: null, action: null, bots: [], errors: [] };
    report.teams.push(entry);
    const teamFail = (m) => {
      entry.errors.push(m);
      fail(`team:${team.slug}`, m);
    };
    try {
      let t = existingTeams.get(team.name);
      if (t && t.isCaptain !== true) {
        teamFail(
          "ya existe un equipo con ese nombre y no eres su capitán (los nombres de equipo son únicos en la instalación).",
        );
        entry.action = "blocked";
        continue;
      }
      if (t) entry.action = "reused";
      else {
        entry.action = "created";
        if (!dryRun) {
          log(`crear equipo ${team.slug}`);
          t = await client.json("POST", "/teams", { json: { name: team.name } });
        }
      }
      entry.id = t?.id ?? null;
      const present = new Set((t?.bots ?? []).map((b) => b.id));
      for (const slug of team.bots) {
        const id = idBySlug.get(slug);
        const row = { bot: slug, botId: id ?? null, action: null };
        entry.bots.push(row);
        if (id && present.has(id)) {
          row.action = "reused";
          continue;
        }
        if (dryRun) {
          row.action = "would_add";
          continue;
        }
        if (!id) {
          row.action = "skipped";
          teamFail(`el bot «${slug}» no está en el destino (¿falló su import?): equipo incompleto.`);
          continue;
        }
        try {
          await client.json("POST", `/teams/${t.id}/bots`, { json: { botId: id } });
          row.action = "added";
        } catch (e) {
          row.action = "failed";
          teamFail(`bot «${slug}»: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      entry.action ??= "failed";
      teamFail(errMsg(e));
    }
  }

  const count = (arr, a) => arr.filter((x) => x.action === a).length;
  report.summary = {
    bots: { created: count(report.bots, "created"), reused: count(report.bots, "reused") },
    versions: {
      created: report.bots.flatMap((b) => b.versions).filter((v) => v.action === "created").length,
      reused: report.bots.flatMap((b) => b.versions).filter((v) => v.action === "reused").length,
    },
    teams: { created: count(report.teams, "created"), reused: count(report.teams, "reused") },
    errors: report.errors.length,
    writes: client.writes ?? 0,
  };
  return report;
}

async function queueBuild(client, botId, version, row, botFail) {
  try {
    const b = await client.json("POST", `/bots/${botId}/versions/${version}/actions/submit`, { json: {} });
    row.buildId = b.id;
    row.queued = true;
  } catch (e) {
    botFail(`encolar la validación de la v${version}: ${errMsg(e)}`);
  }
}
