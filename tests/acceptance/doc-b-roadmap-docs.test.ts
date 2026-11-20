/**
 * DOC-B · checks documentales del roadmap y de la documentación técnica (auditoría 2026-11-02).
 * Tests simples y sin BD ni red: leen sólo ficheros de `docs/`.
 *
 *  - ROADMAP_CURRENT          current-status.md solo tiene el estado actual y sus campos obligatorios.
 *  - NO_PENDING_DONE_FEATURES lo clasificado DONE en la auditoría no figura como pendiente.
 *  - STALE_SHA_REFERENCES     ni SHA ni RC antiguos presentados como estado actual.
 *  - NO_INTERNAL_TOPOLOGY     ninguna IP privada ni nombre interno del homelab en los documentos vigentes.
 *  - HISTORY_NOTICE           el índice de la historia lleva el aviso literal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = join(ROOT, "docs");
const read = (rel: string) => readFileSync(join(DOCS, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

/** Documentos vigentes: todo `docs/` salvo la historia, las auditorías y los mapas de migración (hablan del pasado). */
function vigentDocs(): string[] {
  return walk(DOCS).filter((p) => {
    const r = relative(DOCS, p).replaceAll("\\", "/");
    return (
      !r.startsWith("history/") &&
      !r.startsWith("audits/") &&
      !r.startsWith("testing/") &&
      !r.startsWith("adr/ADR-") &&
      r !== "DOC-MIGRATION-MAP.md" &&
      r !== "recuperacion.md"
    );
  });
}

/** Quita las secciones «## Verificación» (fechan su propia evidencia) y los bloques de código. */
function withoutVerification(text: string): string {
  const noCode = text.replace(/```[\s\S]*?```/g, "");
  const i = noCode.search(/^## Verificación/m);
  return i === -1 ? noCode : noCode.slice(0, i);
}

describe("ROADMAP_CURRENT", () => {
  const status = read("roadmap/current-status.md");

  it("declara MAIN_SHA (40 hex), fecha de revisión, código, despliegue y P0/P1/P2", () => {
    expect(status).toMatch(/^MAIN_SHA:\s+[0-9a-f]{40}\b/m);
    expect(status).toMatch(/^REVISADO:\s+\d{4}-\d{2}-\d{2}\b/m);
    expect(status).toMatch(/^CÓDIGO:\s+\S/m);
    expect(status).toMatch(/^DESPLEGADO:\s+\S/m);
    expect(status).toMatch(/^P0 \/ P1 \/ P2:\s+\S/m);
  });

  it("current-status.md no acumula estados históricos (RC1–RC4, ramas de integración, EN CURSO)", () => {
    expect(status).not.toMatch(/\bRC[1-4]\b/);
    expect(status).not.toMatch(/integration\/[a-z0-9-]+/);
    expect(status).not.toMatch(/^EN CURSO:/m);
  });

  it("todo TD-xxx citado en el roadmap existe en technical-debt.md", () => {
    const debt = read("roadmap/technical-debt.md");
    const defined = new Set([...debt.matchAll(/^## (TD-\d+) —/gm)].map((m) => m[1]));
    for (const f of ["current-status.md", "pending-features.md", "known-issues.md"]) {
      const used = new Set([...read(`roadmap/${f}`).matchAll(/\bTD-\d{3}\b/g)].map((m) => m[0]));
      for (const id of used) expect(defined.has(id), `${f} cita ${id}, que no existe en technical-debt.md`).toBe(true);
    }
  });

  it("los enlaces relativos de los cinco documentos del roadmap apuntan a ficheros que existen", () => {
    for (const f of ["index", "current-status", "pending-features", "known-issues", "technical-debt"]) {
      const text = read(`roadmap/${f}.md`);
      for (const m of text.matchAll(/\]\(([^)\s#]+?)(#[^)\s]*)?\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        expect(existsSync(resolve(DOCS, "roadmap", target)), `${f}.md enlaza ${target}`).toBe(true);
      }
    }
  });

  it("cada TD del índice tiene su sección y viceversa", () => {
    const debt = read("roadmap/technical-debt.md");
    const indexIds = new Set([...debt.matchAll(/^\| \[(TD-\d+)\]\(#td-\d+\)/gm)].map((m) => m[1]));
    const sectionIds = new Set([...debt.matchAll(/^## (TD-\d+) —/gm)].map((m) => m[1]));
    expect([...sectionIds].filter((x) => !indexIds.has(x))).toEqual([]);
    expect([...indexIds].filter((x) => !sectionIds.has(x))).toEqual([]);
  });
});

describe("NO_PENDING_DONE_FEATURES", () => {
  const audit = read("audits/2026-11/PENDING-AUDIT.md");
  const pending = read("roadmap/pending-features.md");

  /** Filas de la tabla de la auditoría: [#, elemento, antes, clasificación, evidencia]. */
  const rows = [...audit.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \| \*\*(DONE|PARTIAL|PENDING|DESCARTED)\*\*/gm)].map(
    (m) => ({
      n: m[1]!,
      elemento: m[2]!,
      clase: m[4]!,
    }),
  );

  /** Texto de las secciones que listan trabajo abierto (Parciales y Pendientes). */
  const open = (() => {
    const a = pending.indexOf("## Parciales");
    const b = pending.indexOf("## Descartadas por decisión");
    return pending.slice(a, b);
  })();

  const stem = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[`*]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ");

  it("la auditoría clasifica los 28 elementos", () => {
    expect(rows.length).toBe(28);
  });

  it("ningún elemento DONE aparece como fila de Parciales o Pendientes", () => {
    const firstCells = open
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| ---") && !l.startsWith("|---"))
      .map((l) => stem(l.split("|")[1] ?? ""));
    for (const r of rows.filter((x) => x.clase === "DONE")) {
      expect(firstCells, `«${r.elemento}» está DONE y figura como pendiente`).not.toContain(stem(r.elemento));
    }
  });

  it("todo elemento PARTIAL o PENDING de la auditoría sigue listado en pending-features.md", () => {
    const all = open.toLowerCase();
    // Fragmento mínimo reconocible de cada fila.
    const needles: Record<string, string> = {
      "1": "prepare-battle",
      "2": "matchmaking",
      "3": "/run",
      "8": "espectador público",
      "9": "replays públicos",
      "10": "auto-run",
      "11": "observabilidad",
      "12": "streaming",
      "13": "2fa",
      "14": "sesiones",
      "15": "recuperación",
      "16": "formatos de torneo",
      "17": "administración web",
      "18": "fases visuales",
      "19": ".net",
      "20": "java",
      "22": "map-service",
    };
    for (const r of rows.filter((x) => x.clase === "PARTIAL" || x.clase === "PENDING")) {
      const needle = needles[r.n];
      expect(needle, `falta la palabra clave de la fila ${r.n}`).toBeTruthy();
      expect(all, `«${r.elemento}» (${r.clase}) no figura en pending-features.md`).toContain(needle);
    }
  });

  it("los DESCARTED siguen en su sección de descartadas", () => {
    const a = pending.indexOf("## Descartadas por decisión");
    const section = pending.slice(a, pending.indexOf("## Completadas")).toLowerCase();
    for (const k of ["webrtc", "sharding", "calor y recarga", "rapier"]) expect(section).toContain(k);
  });

  it("el registro de completadas existe y cita un PR por cada DONE", () => {
    const done = read("history/status/completadas-2026-11.md");
    expect(done).toMatch(/DOCUMENTACIÓN HISTÓRICA/);
    expect((done.match(/PR #\d+/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

describe("STALE_SHA_REFERENCES", () => {
  const OLD_SHA = /\b(27f70bb|0b8c12b|6612868|59322e2|7cf88dd|4cc7651|f32ab2c|e902b0a)\b/;

  it("los documentos del roadmap no usan un SHA antiguo (fuera de technical-debt.md, que conserva su evidencia fechada)", () => {
    for (const f of ["index", "current-status", "pending-features", "known-issues"]) {
      const text = withoutVerification(read(`roadmap/${f}.md`));
      expect(text, `roadmap/${f}.md`).not.toMatch(OLD_SHA);
    }
  });

  it("technical-debt.md declara el MAIN_SHA auditado y no un «BASE COMMIT» antiguo", () => {
    const debt = read("roadmap/technical-debt.md");
    expect(debt).toMatch(/MAIN_SHA auditado:\*\* `[0-9a-f]{40}`/);
    expect(debt).not.toMatch(/BASE COMMIT/);
  });

  it("ningún documento vigente presenta un RC anterior a RC5 como estado actual", () => {
    // Un «RC1..RC4» sólo puede aparecer como referencia explícita al histórico o a una deuda/PR concreto.
    const bad: string[] = [];
    for (const p of vigentDocs()) {
      const r = relative(DOCS, p).replaceAll("\\", "/");
      if (!r.startsWith("roadmap/")) continue;
      for (const line of withoutVerification(readFileSync(p, "utf8")).split("\n")) {
        if (/estado actual|producción (está|corre) en|DESPLEGADO:/i.test(line) && /\bRC[1-4]\b/.test(line))
          bad.push(`${r}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("NO_INTERNAL_TOPOLOGY", () => {
  // 10.89.250.0/24 es una constante de diseño del compose (red `bot-control`), no la red de nadie.
  const DESIGN_CONSTANTS = /\b10\.89\.250\.(?:\d{1,3})(?:\/\d{1,2})?\b/g;
  const PRIVATE_IP =
    /\b(?:10\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/;
  const INTERNAL_NAMES =
    /\b(?:ia-server|ia02|yggdrasil|hvergelmir|mimisbrunnr|seccionnueve|vm1[01]\d|vm-pruebas)\b|\.duckdns\.org/i;

  it("ningún documento vigente contiene IPs privadas, de la VPN ni nombres internos del homelab", () => {
    const hits: string[] = [];
    for (const p of vigentDocs()) {
      const text = readFileSync(p, "utf8").replace(DESIGN_CONSTANTS, "");
      const r = relative(DOCS, p).replaceAll("\\", "/");
      text.split("\n").forEach((line, i) => {
        // `172.17.0.0/16`, `172.16.0.0/12` y `192.168.0.0/16` aparecen como pools por defecto de Docker, no como topología.
        const l = line
          .replace(/\b(?:172\.17|172\.16|192\.168)\.0\.0\/\d{1,2}\b/g, "")
          .replace(/`172\.17–31\/16`|`192\.168\/16`/g, "");
        if (PRIVATE_IP.test(l) || INTERNAL_NAMES.test(l)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("HISTORY_NOTICE", () => {
  it("el índice de la historia lleva el aviso literal", () => {
    const index = read("history/index.md");
    expect(index).toContain("DOCUMENTACIÓN HISTÓRICA");
    expect(index).toContain("Estos documentos describen diseños, estados o procedimientos anteriores.");
    expect(index).toContain("No deben utilizarse como guía de funcionamiento actual.");
  });
});
