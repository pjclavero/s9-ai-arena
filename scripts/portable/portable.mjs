#!/usr/bin/env node
/**
 * Export/import portable de bots y equipos de S9 AI Arena. Ver docs/operations/portable-export.md.
 *
 *   node scripts/portable/portable.mjs export --out <dir> --engine-version <x.y.z> [--versions heads|all]
 *        [--source-sha <sha>] [--api-url <url>] (--credentials-file F | --token-file F | --token-stdin)
 *   node scripts/portable/portable.mjs import --from <dir> [--dry-run] [--submit] [--restore-visibility]
 *        [--target-engine <x.y.z>] [--report <fichero>] [--api-url <url>] (credenciales como arriba)
 *   node scripts/portable/portable.mjs verify <dir>      (sin red: manifest, checksums, referencias)
 *
 * Las credenciales NUNCA van por argv: fichero 0600 (JSON {email,password[,totp]} o token) o stdin.
 * Salida: 0 = todo bien · 1 = fallo (verificación, compatibilidad, API o elementos con error).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, loadAuth } from "./lib/api.mjs";
import { PortableError, assertEngineCompatible, verifyExport } from "./lib/format.mjs";
import { runExport } from "./lib/export.mjs";
import { runImport } from "./lib/import.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_DEPS = resolve(here, "../../apps/arena-engine/src/engine-deps.json");

const checkoutEngine = () => {
  try {
    return JSON.parse(readFileSync(ENGINE_DEPS, "utf8")).engine.version;
  } catch {
    return undefined;
  }
};

const COMMON = {
  "api-url": { type: "string" },
  "credentials-file": { type: "string" },
  "token-file": { type: "string" },
  "token-stdin": { type: "boolean" },
  "rate-limit-wait-max": { type: "string" },
};

function makeClient(v, log) {
  const baseUrl = v["api-url"] ?? process.env.S9_API_URL;
  if (!baseUrl) throw new PortableError("no_url", "Falta la URL de la API: --api-url o S9_API_URL (…/api/v1).");
  const auth = loadAuth({
    credentialsFile: v["credentials-file"] ?? process.env.S9_CREDENTIALS_FILE,
    tokenFile: v["token-file"] ?? process.env.S9_TOKEN_FILE,
    tokenStdin: v["token-stdin"],
  });
  return new ApiClient({
    baseUrl,
    auth,
    log,
    ...(v["rate-limit-wait-max"] ? { rateLimitMaxWaitMs: Number(v["rate-limit-wait-max"]) * 1000 } : {}),
  });
}

export async function main(argv, io = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") }) {
  const [cmd, ...rest] = argv;
  const log = (m) => io.err(`· ${m}`);
  if (cmd === "verify") {
    const dir = rest[0];
    if (!dir) throw new PortableError("usage", "uso: verify <directorio>");
    const { manifest, bots, teams } = verifyExport(dir);
    io.out(`OK · formatVersion ${manifest.formatVersion} · engine ${manifest.engineVersion} · ${bots.length} bots · ${teams.length} equipos · ${manifest.counts.versions} versiones`);
    return 0;
  }
  if (cmd === "export") {
    const { values: v } = parseArgs({
      args: rest,
      options: {
        ...COMMON,
        out: { type: "string" },
        versions: { type: "string" },
        "engine-version": { type: "string" },
        "source-sha": { type: "string" },
      },
    });
    if (!v.out) throw new PortableError("usage", "Falta --out <directorio>.");
    if (!v["engine-version"]) {
      throw new PortableError(
        "usage",
        "Falta --engine-version <x.y.z>: es el motor de la instalación de ORIGEN y no se adivina (el checkout de esta herramienta puede ser de otra versión).",
      );
    }
    const client = makeClient(v, log);
    let sourceSha = v["source-sha"];
    if (!sourceSha) {
      try {
        sourceSha = (await client.json("GET", "/system/status")).commit ?? "unknown";
      } catch {
        sourceSha = "unknown";
      }
    }
    const { manifest } = await runExport({
      client,
      dest: resolve(v.out),
      versionsPolicy: v.versions ?? "heads",
      sourceSha,
      engineVersion: v["engine-version"],
      engineVersionSource: "flag",
      log,
    });
    io.out(`EXPORT OK · ${manifest.counts.bots} bots · ${manifest.counts.versions} versiones · ${manifest.counts.loadouts} loadouts · ${manifest.counts.teams} equipos · ${v.out}`);
    for (const w of manifest.warnings) io.err(`aviso: ${w}`);
    if (manifest.counts.omittedVersions) io.err(`aviso: ${manifest.counts.omittedVersions} versión(es) no exportadas por la política «${manifest.versionsPolicy}» (lista en manifest.json).`);
    return 0;
  }
  if (cmd === "import") {
    const { values: v } = parseArgs({
      args: rest,
      options: {
        ...COMMON,
        from: { type: "string" },
        "dry-run": { type: "boolean" },
        submit: { type: "boolean" },
        "restore-visibility": { type: "boolean" },
        "target-engine": { type: "string" },
        report: { type: "string" },
      },
    });
    if (!v.from) throw new PortableError("usage", "Falta --from <directorio>.");
    const targetEngine = v["target-engine"] ?? checkoutEngine();
    if (!targetEngine) throw new PortableError("usage", "Falta --target-engine <x.y.z> (no se encontró engine-deps.json en el checkout).");
    const src = resolve(v.from);
    // Verificación previa SIN red y sin credenciales: un export corrupto falla aquí.
    const pre = verifyExport(src);
    assertEngineCompatible(pre.manifest.engineVersion, targetEngine);
    const hasCreds = Boolean(v["credentials-file"] ?? process.env.S9_CREDENTIALS_FILE ?? v["token-file"] ?? process.env.S9_TOKEN_FILE ?? v["token-stdin"]);
    if (v["dry-run"] && !hasCreds) {
      io.out(`DRY-RUN OFFLINE · export válido (formatVersion ${pre.manifest.formatVersion}, engine ${pre.manifest.engineVersion} → destino ${targetEngine}) · se crearían como máximo ${pre.bots.length} bots, ${pre.manifest.counts.versions} versiones, ${pre.manifest.counts.loadouts} loadouts y ${pre.teams.length} equipos. Con credenciales, --dry-run compara además con el estado real del destino.`);
      return 0;
    }
    const client = makeClient(v, log);
    const report = await runImport({
      client,
      src,
      targetEngine,
      dryRun: v["dry-run"] === true,
      submit: v.submit === true,
      restoreVisibility: v["restore-visibility"] === true,
      log,
    });
    if (v.report) writeFileSync(resolve(v.report), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    for (const b of report.bots) io.out(`bot   ${b.slug.padEnd(32)} ${b.action.padEnd(8)} → ${b.id ?? "-"}   (versiones: ${b.versions.map((x) => `v${x.version}→${x.newVersion ?? "?"}:${x.action}`).join(", ") || "-"})`);
    for (const t of report.teams) io.out(`team  ${t.slug.padEnd(32)} ${t.action.padEnd(8)} → ${t.id ?? "-"}   (bots: ${t.bots.map((x) => `${x.bot}:${x.action}`).join(", ") || "-"})`);
    for (const e of report.errors) io.err(`ERROR ${e.scope}: ${e.message}`);
    io.out(`${report.dryRun ? "DRY-RUN" : "IMPORT"} ${report.errors.length ? "CON ERRORES" : "OK"} · ${JSON.stringify(report.summary)}`);
    return report.errors.length ? 1 : 0;
  }
  throw new PortableError("usage", "uso: portable.mjs export|import|verify (ver la cabecera del fichero)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`FALLO${e.code ? ` [${e.code}]` : ""}: ${e.message}\n`);
      process.exit(1);
    },
  );
}
