/**
 * UX-EDITOR · «Funciona en el repo, falla en la imagen»: el editor importa el
 * validador PURO de apps/map-service; la imagen web (infrastructure/docker/web/
 * Dockerfile) sólo copiaba apps/web, packages y sdks, y `vite build` reventaba en CI.
 *
 * Guarda: se recorren TRANSITIVAMENTE los imports relativos de apps/web/src y todo
 * fichero alcanzable fuera de apps/web debe caer bajo un COPY de la etapa de build.
 * Se parsean los COPY del Dockerfile (no se busca texto suelto).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  const cands = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Ficheros alcanzables desde apps/web/src siguiendo imports relativos de valor (`import type` se borra al compilar). */
function reachable(): Set<string> {
  const seen = new Set<string>();
  const stack = walk(join(REPO, "apps/web/src"));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^"'`;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      if (m[1]) continue; // `import type`: se borra al compilar, no entra en el bundle
      const r = resolveImport(f, m[2]);
      if (r && !r.endsWith(".json")) stack.push(r);
    }
  }
  return seen;
}

function buildStageCopies(dockerfile: string): string[] {
  const stage = dockerfile.split(/\n(?=FROM\s)/).find((c) => /^FROM\s/.test(c)) ?? "";
  return stage
    .split("\n")
    .filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap((l) => l.trim().split(/\s+/).slice(1, -1))
    .map((s) => s.replace(/^\.\//, "").replace(/\/$/, ""));
}

describe("imagen web: todo lo que importa el panel entra en el contexto de build", () => {
  it("cada fichero alcanzable fuera de apps/web está copiado en la etapa de build", () => {
    const copies = buildStageCopies(readFileSync(join(REPO, "infrastructure/docker/web/Dockerfile"), "utf8"));
    const outside = [...reachable()].map((f) => relative(REPO, f)).filter((r) => !r.startsWith("apps/web/"));
    expect(outside.some((r) => r.startsWith("apps/map-service/src/validate/"))).toBe(true); // el editor lo usa
    const missing = outside.filter((r) => !copies.some((c) => r === c || r.startsWith(`${c}/`)));
    expect(missing).toEqual([]);
  });
});
