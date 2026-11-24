/**
 * V1 REPLAYS PR-4b · Los imports de cada ENTRYPOINT caben en los COPY de su Dockerfile.
 *
 * Defecto real (revisión de #345, P2-1): la CLI del motor (`apps/arena-engine/src/cli.ts`, CMD por
 * defecto de la imagen arena-engine) pasó a importar `../../replay-service/src/...`, pero el
 * Dockerfile no copia `apps/replay-service`: en el repo funcionaba y en la imagen moría con
 * ERR_MODULE_NOT_FOUND. `image-package-imports.test.ts` sólo mira `packages/`; esto mira el cierre
 * TRANSITIVO de imports relativos (estáticos, `export … from` e `import("…")`) desde cada entrypoint
 * de cada imagen Node y exige que todos los ficheros caigan dentro de lo que el Dockerfile copia.
 *
 * Entrypoints: el `ENV SERVICE_ENTRY` del Dockerfile (CMD por defecto) y el `SERVICE_ENTRY` por
 * defecto (`${VAR:-ruta}`) de cada servicio del Compose que construye con ese Dockerfile.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = join(REPO, "infrastructure", "docker-compose.yml");

/** Instrucciones del Dockerfile (con continuaciones unidas, sin comentarios). */
function instrucciones(dockerfile: string): string[] {
  const out: string[] = [];
  let acc: string | null = null;
  for (const cruda of readFileSync(join(REPO, dockerfile), "utf8").split("\n")) {
    const l = cruda.trimEnd();
    if (acc === null && (l.trim() === "" || l.trim().startsWith("#"))) continue;
    const sigue = l.endsWith("\\");
    acc = (acc === null ? "" : acc + " ") + (sigue ? l.slice(0, -1) : l);
    if (sigue) continue;
    out.push(acc.trim());
    acc = null;
  }
  return out;
}

/** Orígenes (relativos al contexto = raíz del repo) que copian los COPY sin `--from`. */
export function copiados(dockerfile: string): string[] {
  const out: string[] = [];
  for (const ins of instrucciones(dockerfile)) {
    if (!/^COPY\s/i.test(ins) || /--from=/.test(ins)) continue;
    const partes = ins
      .split(/\s+/)
      .slice(1)
      .filter((p) => !p.startsWith("--"));
    for (const src of partes.slice(0, -1)) out.push(normalize(src).replace(/\/$/, ""));
  }
  return out;
}

function entryDelDockerfile(dockerfile: string): string[] {
  const out: string[] = [];
  for (const ins of instrucciones(dockerfile)) {
    const m = /^ENV\s+SERVICE_ENTRY[=\s]+(\S+)/i.exec(ins);
    if (m) out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

function entriesDelCompose(dockerfile: string): string[] {
  const doc = parse(readFileSync(COMPOSE, "utf8"), { merge: true });
  const out: string[] = [];
  for (const def of Object.values<any>(doc.services ?? {})) {
    if (def.build?.dockerfile !== dockerfile) continue;
    const env = def.environment ?? {};
    const raw = Array.isArray(env)
      ? env.find((e: string) => e.startsWith("SERVICE_ENTRY="))?.slice("SERVICE_ENTRY=".length)
      : env.SERVICE_ENTRY;
    if (typeof raw !== "string") continue;
    const m = /^\$\{[A-Z0-9_]+:-([^}]+)\}$/.exec(raw);
    out.push(m ? m[1] : raw);
  }
  return out;
}

const IMPORT_REL = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** Sin comentarios ni `import type`/`export type` (se borran al transpilar: no cargan nada). */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    .replace(/\b(?:import|export)\s+type\s+[^;]*?from\s*["'][^"']+["']/g, "");
}

function resolver(desde: string, spec: string): string | null {
  const base = join(dirname(desde), spec);
  const cands = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base + ".ts",
    join(base, "index.ts"),
  ];
  for (const c of cands)
    if (existsSync(c) && !c.endsWith("/")) {
      try {
        if (readFileSync(c)) return c;
      } catch {
        /* directorio */
      }
    }
  return null;
}

/** Cierre transitivo de ficheros del repo que carga `entry` (rutas relativas al repo). */
export function cierre(entry: string): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const pila = [join(REPO, entry)];
  while (pila.length) {
    const f = pila.pop()!;
    const rel = relative(REPO, f);
    if (files.has(rel)) continue;
    files.add(rel);
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(f)) continue;
    for (const m of sinComentarios(readFileSync(f, "utf8")).matchAll(IMPORT_REL)) {
      const r = resolver(f, m[1]);
      if (r) pila.push(r);
      else unresolved.push(`${rel} → ${m[1]}`);
    }
  }
  return { files, unresolved };
}

const cabe = (file: string, srcs: string[]) => srcs.some((s) => s === "." || file === s || file.startsWith(s + "/"));

const IMAGENES = [
  "infrastructure/docker/arena-engine/Dockerfile",
  "infrastructure/docker/node-service/Dockerfile",
  "infrastructure/docker/bot-manager/Dockerfile",
  "infrastructure/docker/streamer/Dockerfile",
].filter((d) => existsSync(join(REPO, d)));

describe("V1 REPLAYS PR-4b · los imports de cada entrypoint están DENTRO de su imagen", () => {
  it("hay imágenes y entrypoints que analizar (si esto falla, el test se ha quedado ciego)", () => {
    expect(IMAGENES).toContain("infrastructure/docker/arena-engine/Dockerfile");
    const entries = IMAGENES.flatMap((d) => [...entryDelDockerfile(d), ...entriesDelCompose(d)]);
    expect(entries).toContain("apps/arena-engine/src/cli.ts");
    expect(entries).toContain("apps/arena-engine/src/service.ts");
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it("la CLI del motor carga el formato S9R/1 de apps/replay-service (el caso que originó este test)", () => {
    const { files } = cierre("apps/arena-engine/src/cli.ts");
    expect([...files].some((f) => f.startsWith("apps/replay-service/src/s9r/"))).toBe(true);
  });

  for (const dockerfile of IMAGENES) {
    const entries = [...new Set([...entryDelDockerfile(dockerfile), ...entriesDelCompose(dockerfile)])];
    for (const entry of entries) {
      it(`${dockerfile} · ${entry}: todo su cierre de imports está copiado`, () => {
        expect(existsSync(join(REPO, entry)), `el entrypoint ${entry} no existe`).toBe(true);
        const srcs = copiados(dockerfile);
        const { files, unresolved } = cierre(entry);
        expect(unresolved, "imports relativos que no resuelven").toEqual([]);
        const fuera = [...files].filter((f) => !cabe(f, srcs));
        expect(fuera, `fuera de los COPY de ${dockerfile} (${srcs.join(", ")})`).toEqual([]);
      });
    }
  }
});
