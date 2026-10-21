#!/usr/bin/env node
/**
 * TD-062 · construye el ARTEFACTO INSTALADO del s9-docker-proxy: un único fichero ESM
 * autocontenido (docker-proxy-main.ts y su grafo de imports) que ejecuta el node del
 * sistema desde una ruta de root (/usr/local/lib/s9-docker-proxy/docker-proxy.mjs).
 *
 * Por qué: el proxy corre con el grupo `docker` (= root en el host). Mientras ejecutaba
 * `npx tsx apps/bot-manager/src/docker-proxy-main.ts` desde /opt/s9-ai-arena, quien
 * pudiera escribir ese árbol (s9arena, el usuario de despliegue) cambiaba lo que el
 * proxy ejecuta: el intérprete (node_modules/.bin/tsx, el loader de tsx, esbuild), el
 * código y la allowlist. El bundle no tiene dependencias en tiempo de ejecución: sólo
 * importa módulos `node:*`. Este script lo COMPRUEBA con el metafile de esbuild y falla
 * si una entrada viene de fuera de apps/bot-manager/src o una importación no es `node:`.
 *
 * Se ejecuta SIN privilegios (usuario de despliegue o CI). El instalador
 * (install-docker-proxy.sh install, root) NO ejecuta esbuild: copia el fichero resultante
 * con propietario/modo fijados y comprueba su sha256.
 *
 * Uso:  node infrastructure/scripts/build-docker-proxy-bundle.mjs [--out <fichero.mjs>] [--commit <sha>]
 *       (npm run build:docker-proxy) · defecto: dist/s9-docker-proxy/docker-proxy.mjs
 * Salida: <out> y <out>.sha256 («<hex>  docker-proxy.mjs»); resumen JSON por stdout.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(REPO, "apps", "bot-manager", "src", "docker-proxy-main.ts");
const SRC_DIR = join(REPO, "apps", "bot-manager", "src");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const out = resolve(arg("--out") ?? join(REPO, "dist", "s9-docker-proxy", "docker-proxy.mjs"));
let commit = arg("--commit") ?? process.env.S9_BUILD_COMMIT ?? "";
if (!commit) {
  try {
    commit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    commit = "unknown";
  }
}
if (!/^([0-9a-f]{7,40}|unknown)$/.test(commit)) {
  console.error(`build-docker-proxy-bundle: --commit no válido: ${commit}`);
  process.exit(2);
}

mkdirSync(dirname(out), { recursive: true });
const result = await build({
  entryPoints: [ENTRY],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Sólo los módulos del propio node quedan fuera del bundle.
  packages: "bundle",
  external: ["node:*"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  define: {
    // docker-proxy-main.ts: en el bundle la allowlist DEBE venir explícita del entorno
    // (DOCKER_PROXY_IMAGE_ALLOWLIST); nunca se deduce de la ubicación del fichero.
    __S9_DOCKER_PROXY_BUNDLE__: "true",
    __S9_DOCKER_PROXY_BUILD_COMMIT__: JSON.stringify(commit),
  },
  banner: {
    js: `// s9-docker-proxy · bundle autocontenido (TD-062) · commit ${commit} · NO EDITAR: lo genera infrastructure/scripts/build-docker-proxy-bundle.mjs`,
  },
});

// ── comprobaciones del metafile (fallan CERRADO) ────────────────────────────
const problems = [];
const inputs = Object.keys(result.metafile.inputs).map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p)));
for (const p of inputs) {
  const rel = relative(SRC_DIR, p);
  if (rel.startsWith("..") || isAbsolute(rel) || p.includes(`${"/"}node_modules${"/"}`))
    problems.push(`entrada fuera de apps/bot-manager/src: ${relative(REPO, p)}`);
}
const outputs = Object.entries(result.metafile.outputs);
if (outputs.length !== 1) problems.push(`se esperaba UN fichero de salida, hay ${outputs.length}`);
const imports = outputs.flatMap(([, o]) => o.imports ?? []);
for (const imp of imports) {
  if (!imp.external || !imp.path.startsWith("node:"))
    problems.push(`importación en tiempo de ejecución no permitida: ${imp.path} (${imp.kind})`);
}
if (problems.length) {
  for (const p of problems) console.error(`build-docker-proxy-bundle: ERROR: ${p}`);
  process.exit(1);
}

const bytes = readFileSync(out);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${out}.sha256`, `${sha256}  ${basename(out)}\n`);
console.log(
  JSON.stringify({
    out,
    sha256,
    bytes: bytes.length,
    commit,
    inputs: inputs.map((p) => relative(REPO, p)).sort(),
    runtimeImports: [...new Set(imports.map((i) => i.path))].sort(),
  }),
);
