#!/usr/bin/env node
/**
 * ELIG · H5/H15 · Inventario de elegibilidad de versiones publicadas, SOLO LECTURA.
 *
 * Consume GET /admin/bot-version-eligibility (rol admin; la API lo ejecuta en una
 * transacción READ ONLY y deja constancia del acceso en su log estructurado). No toca
 * la base de datos directamente ni salta permisos: es un cliente HTTP más.
 *
 * Uso:
 *   S9_API_URL=https://host/api/v1 S9_ADMIN_TOKEN_FILE=/ruta/token-0600 \
 *     node scripts/ops/eligibility-inventory.mjs [--summary] [--format tsv|json]
 *   (o el token por stdin:  … --token-stdin < /ruta/token)
 *
 * El token NUNCA va en argv ni se imprime. `--summary` sólo pide y escribe agregados
 * (apto para informes públicos); la tabla completa lleva nombres de bot e ids de
 * propietario: es para el operador, no para el repositorio.
 */
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COLUMNS = ["BOT", "VERSION", "OWNER", "LOADOUT_REVISION", "CURRENT_VALIDATION", "ELIGIBLE", "REASON"];

export function readToken({ file, stdin }) {
  if (file) {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) throw new Error(`${file}: el token debe tener permisos 0600 (grupo/otros sin acceso)`);
    return readFileSync(file, "utf8").trim();
  }
  if (stdin) return readFileSync(0, "utf8").trim();
  throw new Error("Falta el token: S9_ADMIN_TOKEN_FILE=<fichero 0600> o --token-stdin");
}

export async function fetchInventory({ baseUrl, token, summary = false, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/$/, "")}/admin/bot-version-eligibility${summary ? "?summaryOnly=true" : ""}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ");

export function formatTsv(inv) {
  const s = inv.summary;
  const out = [
    `# generatedAt=${inv.generatedAt} rulesVersion=${inv.rulesVersion} readOnly=${inv.readOnly} scope=${clean(inv.scope)}`,
    `# TOTAL_PUBLISHED_VERSIONS=${s.totalPublishedVersions} CURRENTLY_VALID=${s.currentlyValid} CURRENTLY_INVALID=${s.currentlyInvalid} USERS_AFFECTED=${s.usersAffected} BOTS_AFFECTED=${s.botsAffected}`,
    `# INVALID_BY_REASON=${JSON.stringify(s.invalidByReason)} WARNINGS_BY_CODE=${JSON.stringify(s.warningsByCode)}`,
  ];
  if (Array.isArray(inv.items)) {
    out.push(COLUMNS.join("\t"));
    for (const i of inv.items) {
      out.push(
        [
          clean(i.botName),
          i.version,
          i.ownerId,
          i.loadoutRevision,
          i.currentValidation,
          i.eligible ? "yes" : "no",
          clean(i.eligible ? "" : (i.violations ?? []).map((v) => v.message).join(" ") || i.reason),
        ].join("\t"),
      );
    }
  }
  return out.join("\n") + "\n";
}

async function main(argv) {
  const summary = argv.includes("--summary");
  const fi = argv.indexOf("--format");
  const format = fi >= 0 ? argv[fi + 1] : "tsv";
  const baseUrl = process.env.S9_API_URL;
  if (!baseUrl) throw new Error("Falta S9_API_URL (p. ej. https://host/api/v1)");
  const token = readToken({ file: process.env.S9_ADMIN_TOKEN_FILE, stdin: argv.includes("--token-stdin") });
  const inv = await fetchInventory({ baseUrl, token, summary });
  process.stdout.write(format === "json" ? JSON.stringify(inv, null, 2) + "\n" : formatTsv(inv));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`eligibility-inventory: ${e.message}`);
    process.exit(1);
  });
}
