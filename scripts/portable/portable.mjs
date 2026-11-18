#!/usr/bin/env node
/**
 * Export/import portable de bots y equipos de S9 AI Arena. Ver docs/operations/portable-export.md.
 *
 *   node scripts/portable/portable.mjs export --out <dir> [--engine-version <x.y.z>] [--versions all|heads]
 *        [--source-sha <sha>] [--api-url <url>] (--credentials-file F | --token-file F | --token-stdin)
 *        (por defecto --versions all; el motor de origen se LEE de la auditoría de su última batalla y,
 *         si se da --engine-version, se valida contra ella; sin batallas es obligatorio)
 *   node scripts/portable/portable.mjs import --from <dir> [--dry-run] [--submit] [--restore-visibility]
 *        [--target-engine <x.y.z>] [--report <fichero>] [--api-url <url>] (credenciales como arriba)
 *   node scripts/portable/portable.mjs verify <dir> [--max-file-mb N] [--max-total-mb N]
 *        (sin red: manifest, checksums, referencias y topes de tamaño)
 *
 * Las credenciales NUNCA van por argv: fichero 0600 (JSON {email,password[,totp]} o token) o stdin;
 * cualquier opción como --password/--token/--totp se rechaza con el error `credentials_argv`.
 * Salida: 0 = todo bien · 1 = fallo (verificación, compatibilidad, API o elementos con error).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiClient, loadAuth } from "./lib/api.mjs";
import { DEFAULT_VERSIONS_POLICY, PortableError, assertEngineCompatible, verifyExport } from "./lib/format.mjs";
import { detectEngineVersion, resolveEngineVersion, runExport } from "./lib/export.mjs";
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

const LIMIT_OPTS = {
  "max-file-mb": { type: "string" },
  "max-total-mb": { type: "string" },
};

/** Topes de tamaño de verifyExport desde las opciones (MiB). */
function limitsFrom(v) {
  const mb = (name, key) => {
    if (v[name] === undefined) return {};
    const n = Number(v[name]);
    if (!Number.isFinite(n) || n <= 0) throw new PortableError("usage", `--${name} debe ser un número positivo (MiB).`);
    return { [key]: Math.floor(n * 1024 * 1024) };
  };
  return { ...mb("max-file-mb", "maxFileBytes"), ...mb("max-total-mb", "maxTotalBytes") };
}

const CREDENTIAL_LIKE = /pass|token|secret|totp|email|key|credential|auth|user|bearer/i;

/** parseArgs estricto; una opción desconocida con pinta de credencial se rechaza explícitamente. */
function parse(args, options, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals });
  } catch (e) {
    const flag = /(--[A-Za-z0-9-]+)/.exec(String(e?.message))?.[1];
    if (e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && flag) {
      if (CREDENTIAL_LIKE.test(flag))
        throw new PortableError(
          "credentials_argv",
          `${flag}: las credenciales NUNCA van por argumentos (quedarían en el historial y en la lista de procesos). Usa --credentials-file <0600>, --token-file <0600> o --token-stdin.`,
        );
      throw new PortableError("usage", `Opción desconocida: ${flag}`);
    }
    throw new PortableError("usage", String(e?.message ?? e));
  }
}

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

export async function main(
  argv,
  io = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") },
) {
  const [cmd, ...rest] = argv;
  const log = (m) => io.err(`· ${m}`);
  if (cmd === "verify") {
    const { values: v, positionals } = parse(rest, LIMIT_OPTS, true);
    const dir = positionals[0];
    if (!dir) throw new PortableError("usage", "uso: verify <directorio>");
    const { manifest, bots, teams } = verifyExport(dir, limitsFrom(v));
    io.out(
      `OK · formatVersion ${manifest.formatVersion} · engine ${manifest.engineVersion} · ${bots.length} bots · ${teams.length} equipos · ${manifest.counts.versions} versiones`,
    );
    return 0;
  }
  if (cmd === "export") {
    const { values: v } = parse(rest, {
      ...COMMON,
      ...LIMIT_OPTS,
      out: { type: "string" },
      versions: { type: "string" },
      "engine-version": { type: "string" },
      "accept-engine": { type: "string" },
      "accept-engine-reason": { type: "string" },
      "source-sha": { type: "string" },
    });
    if (!v.out) throw new PortableError("usage", "Falta --out <directorio>.");
    const limits = limitsFrom(v);
    const client = makeClient(v, log);
    // Motor de ORIGEN: se lee de la auditoría de la última batalla terminada y se valida contra
    // --engine-version si se da. Nunca se toma del checkout de esta herramienta (puede ser otro).
    const detected = await detectEngineVersion(client);
    const { engineVersion, engineVersionSource, engineOverride } = resolveEngineVersion(v["engine-version"], detected, {
      version: v["accept-engine"],
      reason: v["accept-engine-reason"],
    });
    if (engineOverride)
      log(
        `AVISO: motor de origen FORZADO a ${engineOverride.accepted} (la API reporta ${engineOverride.detected}); motivo: ${engineOverride.reason}`,
      );
    if (engineVersionSource === "audit") log(`motor de origen ${engineVersion} (auditoría de la batalla más reciente)`);
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
      versionsPolicy: v.versions ?? DEFAULT_VERSIONS_POLICY,
      sourceSha,
      engineVersion,
      engineVersionSource,
      engineOverride,
      limits,
      log,
    });
    io.out(
      `EXPORT OK · ${manifest.counts.bots} bots · ${manifest.counts.versions} versiones · ${manifest.counts.loadouts} loadouts · ${manifest.counts.teams} equipos · ${v.out}`,
    );
    io.out(
      `motor de origen ${manifest.engineVersion} (${manifest.engineVersionSource}${manifest.engineOverride ? `; forzado, API reporta ${manifest.engineOverride.detected}; motivo: ${manifest.engineOverride.reason}` : ""}) · política de versiones ${manifest.versionsPolicy}`,
    );
    for (const w of manifest.warnings) io.err(`aviso: ${w}`);
    if (manifest.counts.omittedVersions)
      io.err(
        `aviso: ${manifest.counts.omittedVersions} versión(es) no exportadas por la política «${manifest.versionsPolicy}» (lista en manifest.json).`,
      );
    return 0;
  }
  if (cmd === "import") {
    const { values: v } = parse(rest, {
      ...COMMON,
      ...LIMIT_OPTS,
      from: { type: "string" },
      "dry-run": { type: "boolean" },
      submit: { type: "boolean" },
      "restore-visibility": { type: "boolean" },
      "target-engine": { type: "string" },
      report: { type: "string" },
    });
    const limits = limitsFrom(v);
    if (!v.from) throw new PortableError("usage", "Falta --from <directorio>.");
    const targetEngine = v["target-engine"] ?? checkoutEngine();
    if (!targetEngine)
      throw new PortableError(
        "usage",
        "Falta --target-engine <x.y.z> (no se encontró engine-deps.json en el checkout).",
      );
    const src = resolve(v.from);
    // Verificación previa SIN red y sin credenciales: un export corrupto falla aquí.
    const pre = verifyExport(src, limits);
    assertEngineCompatible(pre.manifest.engineVersion, targetEngine);
    const hasCreds = Boolean(
      v["credentials-file"] ??
      process.env.S9_CREDENTIALS_FILE ??
      v["token-file"] ??
      process.env.S9_TOKEN_FILE ??
      v["token-stdin"],
    );
    if (v["dry-run"] && !hasCreds) {
      io.out(
        `DRY-RUN OFFLINE · export válido (formatVersion ${pre.manifest.formatVersion}, engine ${pre.manifest.engineVersion} → destino ${targetEngine}) · se crearían como máximo ${pre.bots.length} bots, ${pre.manifest.counts.versions} versiones, ${pre.manifest.counts.loadouts} loadouts y ${pre.teams.length} equipos. Con credenciales, --dry-run compara además con el estado real del destino.`,
      );
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
      limits,
      log,
    });
    if (v.report) writeFileSync(resolve(v.report), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    for (const b of report.bots)
      io.out(
        `bot   ${b.slug.padEnd(32)} ${b.action.padEnd(8)} → ${b.id ?? "-"}   (versiones: ${b.versions.map((x) => `v${x.version}→${x.newVersion ?? "?"}:${x.action}`).join(", ") || "-"})`,
      );
    for (const t of report.teams)
      io.out(
        `team  ${t.slug.padEnd(32)} ${t.action.padEnd(8)} → ${t.id ?? "-"}   (bots: ${t.bots.map((x) => `${x.bot}:${x.action}`).join(", ") || "-"})`,
      );
    for (const e of report.errors) io.err(`ERROR ${e.scope}: ${e.message}`);
    io.out(
      `${report.dryRun ? "DRY-RUN" : "IMPORT"} ${report.errors.length ? "CON ERRORES" : "OK"} · ${JSON.stringify(report.summary)}`,
    );
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
