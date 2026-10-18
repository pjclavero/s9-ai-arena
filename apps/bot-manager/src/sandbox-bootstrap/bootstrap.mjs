// S9 AI Arena · arranque del código de usuario dentro del runtime Node (DEV-A, TD-001).
//
// Lo ejecuta el contenedor del sandbox como `node --input-type=module -e <este fichero>`
// (la imagen de runtime tiene ENTRYPOINT ["node"]). NO es código del usuario.
// Mismo contrato de entorno que bootstrap.py: ARTIFACT_URL, ARTIFACT_TOKEN,
// ARTIFACT_SHA256, WS_URL, BATTLE_TOKEN, BOT_ID.
//
// El bot de usuario es un módulo ES que exporta una clase que extiende ArenaBot de
// "@arena/sdk": `export default class …`, `export class Bot …` o una única clase exportada.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/tmp/bot";
const env = process.env;

async function report(kind, detail) {
  try {
    await fetch(env.ARTIFACT_URL + "/report", {
      method: "POST",
      headers: { "x-s9-artifact-token": env.ARTIFACT_TOKEN ?? "", "content-type": "application/json" },
      body: JSON.stringify({ kind, detail: String(detail).slice(-4000) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* sin canal de informe: el código de salida basta */
  }
}

async function fail(kind, detail, code) {
  await report(kind, detail);
  process.stderr.write(`s9-bootstrap: ${kind}: ${detail}\n`);
  process.exit(code);
}

function parseArtifact(buf) {
  const magic = Buffer.from("arena-artifact/v1\n");
  if (!buf.subarray(0, magic.length).equals(magic)) throw new Error("cabecera arena-artifact/v1 ausente");
  let pos = magic.length;
  const files = [];
  const chunk = () => {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error("entrada truncada");
    const n = Number(buf.subarray(pos, nl).toString("ascii"));
    if (!Number.isInteger(n) || n < 0) throw new Error("longitud inválida");
    const start = nl + 1;
    const end = start + n;
    if (end + 1 > buf.length || buf[end] !== 0x0a) throw new Error("entrada truncada");
    pos = end + 1;
    return buf.subarray(start, end);
  };
  while (pos < buf.length) {
    const path = chunk().toString("utf8");
    const body = chunk();
    files.push({ path, body });
  }
  return files;
}

function safePath(rel) {
  // eslint-disable-next-line no-control-regex
  if (!rel || rel.startsWith("/") || rel.includes("\\") || /[\u0000-\u001f]/.test(rel)) {
    throw new Error(`ruta no permitida: ${JSON.stringify(rel)}`);
  }
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw new Error(`ruta no permitida: ${JSON.stringify(rel)}`);
  }
  return join(ROOT, rel);
}

if (!env.ARTIFACT_URL || !env.ARTIFACT_SHA256) await fail("config", "faltan ARTIFACT_URL/ARTIFACT_SHA256", 2);

let data;
try {
  const res = await fetch(env.ARTIFACT_URL, {
    headers: { "x-s9-artifact-token": env.ARTIFACT_TOKEN ?? "" },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  data = Buffer.from(await res.arrayBuffer());
} catch (e) {
  await fail("fetch", `no se pudo descargar el artefacto: ${e.message}`, 3);
}
const actual = createHash("sha256").update(data).digest("hex");
if (actual !== env.ARTIFACT_SHA256) await fail("integrity", `sha256 ${actual} != esperado ${env.ARTIFACT_SHA256}`, 4);

let files;
try {
  files = parseArtifact(data);
  for (const f of files) {
    const dest = safePath(f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.body);
  }
} catch (e) {
  await fail("materialize", `artefacto inválido: ${e.message}`, 5);
}

const names = new Set(files.map((f) => f.path));
let entry;
if (names.has("package.json")) {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    entry = typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : undefined;
  } catch (e) {
    await fail("manifest", `package.json ilegible: ${e.message}`, 6);
  }
}
if (!entry || !names.has(entry)) entry = ["src/bot.js", "bot.js", "main.js", "src/bot.mjs"].find((c) => names.has(c));
if (!entry) await fail("entry", "no hay fichero de entrada (package.json main, src/bot.js, bot.js o main.js)", 6);

let mod;
let ArenaBot;
try {
  ({ ArenaBot } = await import("@arena/sdk"));
  process.chdir(ROOT);
  mod = await import(pathToFileURL(safePath(entry)).href);
} catch (e) {
  await fail("import", e?.stack ?? String(e), 7);
}

const isBotClass = (x) => typeof x === "function" && x.prototype instanceof ArenaBot;
let chosen = isBotClass(mod.default) ? mod.default : isBotClass(mod.Bot) ? mod.Bot : undefined;
if (!chosen) {
  const candidates = Object.values(mod).filter(isBotClass);
  if (candidates.length !== 1) {
    await fail(
      "entry",
      `el módulo de entrada debe exportar UNA clase que extienda ArenaBot (default, Bot o única); encontradas: ${candidates.length}`,
      8,
    );
  }
  chosen = candidates[0];
}
try {
  const bot = new chosen(env.BOT_ID ?? "bot_sandbox");
  await bot.run(env.WS_URL, env.BATTLE_TOKEN);
} catch (e) {
  await fail("runtime", e?.stack ?? String(e), 9);
}
