/**
 * DOC-C · batería documental de integración (auditoría 2026-11-02).
 * Tests simples y sin BD ni red: leen sólo ficheros del repositorio.
 *
 * Batería completa = estos checks + los de DOC-A y DOC-B:
 *   DOC-C  tests/acceptance/doc-c-integracion-docs.test.ts        NO_BROKEN_DOC_LINKS (global), NO_STALE_STATE_CLAIMS,
 *                                                                 STALE_SHA_REFERENCES (cuerpo y frases de apertura), PORTADA
 *   DOC-B  tests/acceptance/doc-b-roadmap-docs.test.ts            ROADMAP_CURRENT, NO_PENDING_DONE_FEATURES,
 *                                                                 STALE_SHA_REFERENCES (roadmap), NO_INTERNAL_TOPOLOGY, HISTORY_NOTICE
 *   DOC-A  packages/game-rules/user-docs-current.test.ts          NO_USER_DOC_INTERNAL_IDS, RULESET_DOCS_CURRENT
 *          packages/game-rules/rules-doc.test.ts                  rules.md y rules.json al día
 *          packages/module-catalog/equipment-doc.test.ts          EQUIPMENT_DOCS_CURRENT
 *          packages/protocol/sdk-docs-current.test.ts             SDK_DOCS_CURRENT
 *          sdks/ * /tests/ * docs-examples *                      BOT_EXAMPLES (con cerrojo pesado)
 *
 * Cada check se calibra: una función pura recibe el texto y un caso sintético malo DEBE ponerlo en rojo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(ROOT, "docs");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(DOCS, p).replaceAll("\\", "/");
const ALL = walk(DOCS);

/** Documentos que describen el presente: todo salvo historia, auditorías, informes de pruebas, ADR y mapas de migración. */
const isVigent = (r: string) =>
  !r.startsWith("history/") &&
  !r.startsWith("audits/") &&
  !r.startsWith("testing/") &&
  !r.startsWith("adr/ADR-") &&
  r !== "DOC-MIGRATION-MAP.md" &&
  r !== "recuperacion.md" &&
  r !== "aceptacion/ultimo-informe.md";

/* ───────────────────────── NO_BROKEN_DOC_LINKS ───────────────────────── */

const stripFences = (t: string) => t.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
const stripCode = (t: string) => stripFences(t).replace(/`[^`\n]*`/g, "``");

/** Slug de ancla al estilo GitHub. */
function slug(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(text: string): Set<string> {
  const set = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of stripFences(text).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const s = slug(m[1]);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    set.add(n === 0 ? s : `${s}-${n}`);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
  return set;
}

/** Enlaces relativos rotos de un conjunto de documentos {ruta absoluta → texto}. Pura: calibrable. */
function brokenLinks(files: Map<string, string>, checkAnchors: (abs: string) => boolean): string[] {
  const bad: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const textOf = (abs: string) =>
    files.get(abs) ?? (existsSync(abs) && abs.endsWith(".md") ? readFileSync(abs, "utf8") : undefined);
  for (const [abs, raw] of files) {
    const text = stripCode(raw);
    for (const m of text.matchAll(/\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue; // http:, mailto:, etc.
      const [path, anchor] = target.split("#");
      const dest = path === "" ? abs : resolve(dirname(abs), decodeURI(path));
      if (!existsSync(dest) && !files.has(dest)) {
        bad.push(`${abs}: ${target} (no existe)`);
        continue;
      }
      if (anchor && checkAnchors(abs) && dest.endsWith(".md")) {
        const t = textOf(dest);
        if (t === undefined) continue;
        if (!anchorCache.has(dest)) anchorCache.set(dest, anchorsOf(t));
        if (!anchorCache.get(dest)!.has(decodeURI(anchor).toLowerCase()))
          bad.push(`${abs}: ${target} (ancla inexistente)`);
      }
    }
  }
  return bad;
}

describe("NO_BROKEN_DOC_LINKS · calibración (el check debe poder ponerse en rojo)", () => {
  const a = join(DOCS, "__sintetico__", "a.md");
  const b = join(DOCS, "__sintetico__", "b.md");
  const fake = (text: string) =>
    new Map([
      [a, text],
      [b, "# Título uno\n\n## Otra sección\n"],
    ]);

  it("un enlace a un fichero inexistente se detecta", () => {
    expect(brokenLinks(fake("[x](no-existe.md)"), () => true)).toHaveLength(1);
  });
  it("un enlace a un ancla inexistente se detecta", () => {
    expect(brokenLinks(fake("[x](b.md#no-hay-esto)"), () => true)).toHaveLength(1);
  });
  it("enlaces buenos (fichero, ancla con tilde, externo, dentro de código) no dan falsos positivos", () => {
    const ok =
      "[x](b.md) [y](b.md#otra-sección) [z](https://example.com/zz) [w](#) `[q](no.md)`\n```\n[q](no2.md)\n```";
    expect(brokenLinks(fake(ok), () => true)).toEqual([]);
  });
});

describe("NO_BROKEN_DOC_LINKS · todo docs/", () => {
  const files = new Map(ALL.map((p) => [p, readFileSync(p, "utf8")] as const));

  it("ningún enlace relativo de docs/ (ni sus anclas, fuera de la historia) está roto", () => {
    const bad = brokenLinks(files, (abs) => !rel(abs).startsWith("history/")).map((s) => s.replace(DOCS + "/", ""));
    expect(bad).toEqual([]);
  });

  it("todo documento es alcanzable desde docs/README.md", () => {
    const seen = new Set<string>();
    const queue = [join(DOCS, "README.md")];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const text = stripCode(files.get(cur) ?? "");
      for (const m of text.matchAll(/\]\(([^)\s#]+?)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)/g)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1])) continue;
        const dest = resolve(dirname(cur), decodeURI(m[1]));
        if (files.has(dest)) queue.push(dest);
      }
    }
    const orphans = ALL.filter((p) => !seen.has(p)).map(rel);
    expect(orphans).toEqual([]);
  });
});

/* ───────────────────────── NO_STALE_STATE_CLAIMS ───────────────────────── */

/**
 * Frases de estado de octubre que el cierre funcional (TD-001/002/003/009/010/028/029) dejó falsas.
 * Una línea que las contiene sólo es válida si ella misma dice que están cerradas o que son históricas.
 */
const STALE_STATE = [
  /flujo se corta en la publicaci[oó]n/i,
  /ning[uú]n build (?:se )?aprobad/i,
  /\bvisor (?:está )?roto\b/i,
  /\breproductor y visor rotos\b/i,
  /\beditor no guarda\b/i,
  /\branking (?:está )?vac[ií]o\b/i,
  /\bsin uso efectivo\b/i,
  /\bsimula en proceso\b/i,
  /\bcae al stub\b/i,
  /\bel worker (?:es|usa|ejecuta) (?:un )?stub\b/i,
  /\bversiones? se rechaza(?:n)?\b/i,
  /\bno ejecuta c[oó]digo real\b/i,
  /\bno se puede (?:publicar|validar) (?:un|el|la) (?:bot|versi[oó]n)\b/i,
  /\bcrear una batalla desde la web (?:da|devuelve) error\b/i,
];
const CLOSED_MARKER = /cerrad|ya no|hist[oó]ric|octubre|\bantes\b|corregid|resuelt|obsolet/i;

function staleStateClaims(file: string, text: string): string[] {
  const out: string[] = [];
  stripCode(text)
    .split("\n")
    .forEach((line, i) => {
      if (STALE_STATE.some((re) => re.test(line)) && !CLOSED_MARKER.test(line))
        out.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  return out;
}

describe("NO_STALE_STATE_CLAIMS", () => {
  it("calibración: una frase de octubre sin marca de cerrada se detecta; con la marca, no", () => {
    expect(staleStateClaims("x.md", "Hoy el visor roto impide ver replays.")).toHaveLength(1);
    expect(staleStateClaims("x.md", "Ahora el editor no guarda los mapas.")).toHaveLength(1);
    expect(staleStateClaims("x.md", "Visor roto en navegador (estado de octubre; cerrado, TD-009)")).toEqual([]);
    expect(staleStateClaims("x.md", "```\nel visor roto\n```")).toEqual([]);
  });

  it("ningún documento vigente cuenta como actual un estado de octubre ya cerrado", () => {
    const bad: string[] = [];
    for (const p of ALL) {
      const r = rel(p);
      // technical-debt.md conserva el «Problema:» original de cada TD cerrada: es su registro, no una afirmación de estado.
      if (!isVigent(r) || r === "roadmap/technical-debt.md") continue;
      bad.push(...staleStateClaims(r, readFileSync(p, "utf8")));
    }
    expect(bad).toEqual([]);
  });
});

/* ───────────────────── STALE_SHA_REFERENCES (frases de apertura) ───────────────────── */

const OLD_SHA = /\b(?:27f70bb|0b8c12b|6612868|59322e2|7cf88dd|4cc7651|f32ab2c|e902b0a)\b/;
const DATED = /octubre|2026-10|hist[oó]ric|e3bf2fa|2026-11|noviembre|\bPR #\d+/i;

/** Quita la sección «## Verificación» (fecha su propia evidencia). */
function withoutVerification(text: string): string {
  const t = stripFences(text);
  const i = t.search(/^## Verificación/m);
  return i === -1 ? t : t.slice(0, i);
}

/** Una línea «presenta» un SHA como base de verificación si está entre las de apertura o si usa un verbo de verificación. */
const VERIFY_VERB =
  /verificad|revisad|auditad|auditar|auditor[ií]a|se escribieron|fuente:|inventario|contrastad|contra `/i;

function undatedOldSha(file: string, text: string): string[] {
  const out: string[] = [];
  withoutVerification(text)
    .split("\n")
    .forEach((line, i) => {
      if (OLD_SHA.test(line) && !DATED.test(line) && (i < 15 || VERIFY_VERB.test(line)))
        out.push(`${file}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  return out;
}

describe("STALE_SHA_REFERENCES · frases de apertura y cuerpo de los documentos vigentes", () => {
  it("calibración: un SHA antiguo sin fecha se detecta; fechado, no", () => {
    expect(undatedOldSha("x.md", "Verificado contra `27f70bb`.")).toHaveLength(1);
    expect(undatedOldSha("x.md", "Verificado en `27f70bb` (octubre de 2026).")).toEqual([]);
    expect(undatedOldSha("x.md", "# T\n## Verificación\n| a | `27f70bb` |")).toEqual([]);
  });

  it("todo SHA antiguo fuera de «## Verificación» va acompañado de su fecha o de la re-auditoría", () => {
    const bad: string[] = [];
    for (const p of ALL) {
      const r = rel(p);
      if (!isVigent(r) || r === "roadmap/technical-debt.md") continue;
      bad.push(...undatedOldSha(r, readFileSync(p, "utf8")));
    }
    expect(bad).toEqual([]);
  });

  it("las siete frases de apertura que citaban 27f70bb dicen «octubre»", () => {
    const openings = [
      "technical/index.md",
      "overview/index.md",
      "overview/technologies.md",
      "overview/glossary.md",
      "overview/architecture.md",
      "operations/index.md",
      "operations/configuration.md",
    ];
    for (const f of openings) {
      const head = readFileSync(join(DOCS, f), "utf8").split("\n").slice(0, 40).join("\n");
      expect(head, f).toMatch(/27f70bb/);
      expect(head, f).toMatch(/octubre/i);
    }
  });
});

/* ───────────────────────── PORTADA ───────────────────────── */

describe("PORTADA · docs/README.md", () => {
  const readme = readFileSync(join(DOCS, "README.md"), "utf8");

  it("tiene las cuatro entradas", () => {
    for (const label of ["Quiero jugar", "Quiero administrar", "Quiero desarrollar", "Estado del proyecto"]) {
      expect(readme, label).toContain(label);
    }
  });

  it("MAIN_SHA de la portada coincide con el de current-status.md", () => {
    const status = readFileSync(join(DOCS, "roadmap/current-status.md"), "utf8");
    const a = readme.match(/^MAIN_SHA:\s+([0-9a-f]{40})\b/m)?.[1];
    const b = status.match(/^MAIN_SHA:\s+([0-9a-f]{40})\b/m)?.[1];
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it("declara la regla de las tablas de Verificación y el techo de la verificación", () => {
    expect(readme).toContain(
      "Las tablas de **Verificación** sin nota de re-auditoría 2026-11 indican la verificación original de octubre",
    );
    expect(readme).toContain("documentación técnica parcialmente re-verificada");
  });

  it("no cuenta estado de funciones (eso es de current-status.md)", () => {
    expect(readme).not.toMatch(/FUNCIONA|PENDIENTE|\bRC\d\b/);
  });

  it("el antes huérfano DOCS-AUDIT.md está enlazado desde audits/README.md", () => {
    expect(readFileSync(join(DOCS, "audits/README.md"), "utf8")).toContain("2026-11/DOCS-AUDIT.md");
  });
});

/* ───────────────────────── Batería coherente ───────────────────────── */

describe("BATERÍA · existen los ficheros de test de A, B y C", () => {
  it.each([
    "tests/acceptance/doc-b-roadmap-docs.test.ts",
    "tests/acceptance/doc-c-integracion-docs.test.ts",
    "packages/game-rules/user-docs-current.test.ts",
    "packages/game-rules/rules-doc.test.ts",
    "packages/module-catalog/equipment-doc.test.ts",
    "packages/protocol/sdk-docs-current.test.ts",
    "sdks/javascript/tests/docs-examples.test.ts",
    "sdks/javascript/tests/docs-examples-guia.test.ts",
    "sdks/python/tests/test_docs_examples.py",
  ])("%s", (f) => {
    expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
});
