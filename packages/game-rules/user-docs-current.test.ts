/**
 * DOC-A · NO_USER_DOC_INTERNAL_IDS y RULESET_DOCS_CURRENT.
 *
 * La guía del jugador (docs/user/**) no enseña material de desarrollo, y lo que dice de
 * reglas, modos, formatos y ranking coincide con el código:
 *  - NO_USER_DOC_INTERNAL_IDS: ni TD-xxx, ADR, PR, workers, migraciones, hosts o IPs, ni
 *    identificadores internos de módulo fuera de la guía de programación; y los enlaces
 *    sólo salen de docs/user hacia operaciones (para administradores) y el índice de desarrollo.
 *  - RULESET_DOCS_CURRENT: la tabla de rulesets clásicos, las vidas por `maxRespawns`, los
 *    nombres de modos y formatos, y el Elo (1000, K) salen de los registros reales.
 * (rules.md y rules.json los vigila rules-doc.test.ts; son generados.)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULESETS } from "./index.js";
import { TICK_HZ } from "./constants.js";
import { OVERTIME_TECHNICAL_LIMIT_MINUTES } from "./battle-rules.js";
import { MODE_NAME, TOURNAMENT_FORMAT_NAME, TOURNAMENT_STATE_NAME } from "../../apps/web/src/battle-result.js";
import { DEFAULT_K, INITIAL_RATING } from "../../apps/tournament-worker/src/ratings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USER = join(root, "docs", "user");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function mdFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? mdFiles(p) : p.endsWith(".md") ? [p] : [];
  });
}

/** rules.md lo GENERA el registro de reglas (su propio test lo vigila); no se edita a mano. */
const GENERATED_ELSEWHERE = new Set([join(USER, "rules.md")]);
const FILES = mdFiles(USER);
const TEXT = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

describe("NO_USER_DOC_INTERNAL_IDS · docs/user no enseña material de desarrollo", () => {
  const FORBIDDEN: [RegExp, string][] = [
    [/\bTD-\d+/, "deuda técnica (TD-nnn)"],
    [/\bADR-[\w-]*\d/, "decisión de arquitectura (ADR-)"],
    [/\bPR\s*#?\d+|pull request/i, "pull request"],
    [/\bworkers?\b/i, "worker"],
    [/migraci[oó]n|migraciones/i, "migraciones"],
    [/\bpostgres(ql)?\b|\bredis\b|\bdocker\b|\bkubernetes\b/i, "infraestructura (Postgres, Redis, Docker…)"],
    [/\bGitHub Actions\b|\bCI\b|\bcheck-runs?\b/, "integración continua"],
    [/\bVM\d{2,3}\b|\bia02\b|\byggdrasil\b|duckdns|\bhomelab\b/i, "nombres internos de la infraestructura"],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/, "dirección IP"],
    [/\bRC\d(\.\d)?\b|\bMAIN_SHA\b|\b[0-9a-f]{40}\b/, "versión de despliegue o SHA"],
    [/known-issues|technical-debt|current-status|pending-features/, "enlace al estado del proyecto"],
    [/\bsandbox\b/i, "sandbox (término interno)"],
  ];

  for (const [file, text] of TEXT) {
    const name = relative(root, file);
    if (GENERATED_ELSEWHERE.has(file)) continue;
    // Las siglas de contrato `RADIO_MAX…` no son ids de módulo: sólo `categoría.nombre@versión`.
    const bots = name.startsWith("docs/user/bots/");
    it(`${name}: sin referencias internas`, () => {
      for (const [re, what] of FORBIDDEN) {
        const m = re.exec(text);
        expect(m, `${name} menciona ${what}: «${m?.[0]}»`).toBeNull();
      }
      if (!bots) {
        const id = /\b[a-z]+\.[a-z0-9_]+@\d+\b/.exec(text);
        expect(id, `${name} enseña un identificador interno de módulo: «${id?.[0]}»`).toBeNull();
      }
    });
  }

  it("rules.md (generado) sólo menciona la decisión de arquitectura en su cabecera", () => {
    const text = TEXT.get(join(USER, "rules.md"))!;
    const hits = text.split("\n").filter((l) => /ADR-/.test(l));
    expect(
      hits.length,
      "rules.md se genera desde battle-rules; la mención a ADR queda anotada para la integración",
    ).toBeLessThanOrEqual(1);
  });

  it("los enlaces relativos resuelven y sólo salen de docs/user hacia operaciones o el índice de desarrollo", () => {
    for (const [file, text] of TEXT) {
      const name = relative(root, file);
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const [path, anchor] = target.split("#");
        const abs = resolve(dirname(file), path);
        expect(existsSync(abs), `${name}: enlace roto a ${target}`).toBe(true);
        const rel = relative(root, abs);
        if (!rel.startsWith("docs/user/")) {
          const ok = rel.startsWith("docs/operations/") || rel === "docs/development/index.md";
          expect(ok, `${name}: enlace fuera de la guía del jugador: ${target}`).toBe(true);
        }
        if (anchor && abs.endsWith(".md")) {
          const heads = [...readFileSync(abs, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((h) =>
            h[1]
              .toLowerCase()
              .replace(/[`*«»"'.,:()¿?¡!/]/g, "")
              .trim()
              .replace(/\s+/g, "-"),
          );
          expect(heads, `${name}: el ancla #${anchor} no existe en ${rel}`).toContain(anchor);
        }
      }
    }
  });

  it("el índice enlaza todas las páginas de la guía", () => {
    const index = TEXT.get(join(USER, "index.md"))!;
    for (const f of FILES) {
      const rel = relative(USER, f);
      if (rel === "index.md" || (rel.startsWith("bots/") && rel !== "bots/index.md" && rel !== "bots/ejemplos.md"))
        continue;
      expect(index, `index.md no enlaza ${rel}`).toContain(`(${rel})`);
    }
  });
});

describe("RULESET_DOCS_CURRENT · lo que docs/user dice de reglas y modos sale del código", () => {
  const modes = TEXT.get(join(USER, "game-modes.md"))!;
  const rankings = TEXT.get(join(USER, "rankings.md"))!;
  const tournaments = TEXT.get(join(USER, "tournaments.md"))!;

  /** Nombre que ve el jugador de cada ruleset de plataforma (sembrado en dev.ts, fuente de verdad). */
  function platformRulesets(): { name: string; mode: string; engine: string }[] {
    const src = read("apps/api/src/db/seeds/dev.ts");
    const block = src.slice(src.indexOf("PLATFORM_RULESETS"));
    const end = block.indexOf("];");
    return [
      ...block.slice(0, end).matchAll(/name:\s*"([^"]+)",\s*mode:\s*"(\w+)",\s*engineRulesetId:\s*"([^"]+)"/g),
    ].map((m) => ({ name: m[1], mode: m[2], engine: m[3] }));
  }

  it("la tabla de rulesets clásicos coincide con el código", () => {
    const list = platformRulesets();
    expect(list.length).toBe(4);
    const minutes = (ticks: number) => `${ticks / TICK_HZ / 60} min`;
    for (const r of list) {
      const rs = RULESETS[r.engine];
      expect(rs, r.engine).toBeTruthy();
      const respawn = rs.respawn.enabled ? `${rs.respawn.delayTicks / TICK_HZ} s` : "no";
      const points = `${rs.scoreToWin} puntos`;
      const row = `| ${MODE_NAME[r.mode]} | ${r.name} | ${minutes(rs.timeLimitTicks)} | Gana quien llegue a | `;
      void row;
      const expected = `| ${r.name} | ${minutes(rs.timeLimitTicks)} | ${points} | ${respawn} | ${rs.friendlyFire ? "sí" : "no"} |`;
      expect(modes, `falta/obsoleta la fila de ${r.name}: ${expected}`).toContain(expected);
    }
  });

  it("la tabla de vidas por maxRespawns es la de rules.json", () => {
    const table = JSON.parse(read("docs/user/rules.json")).respawn.table as { maxRespawns: number; lives: number }[];
    for (const { maxRespawns, lives } of table) expect(modes).toContain(`| ${maxRespawns} | ${lives} |`);
  });

  it("los cuatro modos de la plataforma se explican con su nombre en la web", () => {
    for (const name of Object.values(MODE_NAME)) expect(modes, name).toContain(`### ${name}`);
    expect(Object.keys(MODE_NAME)).toEqual(["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"]);
  });

  it("CTF: la prórroga y la salvaguarda técnica se describen como en las reglas", () => {
    const rules = JSON.parse(read("docs/user/rules.json"));
    expect(rules.ctf.overtimeCompetitiveLimit).toBeNull();
    expect(modes).toContain("no tiene límite de tiempo competitivo");
    expect(modes).toContain(`${OVERTIME_TECHNICAL_LIMIT_MINUTES} minutos de prórroga`);
    expect(modes).toContain("detiene por límite técnico");
    expect(modes).toContain("no hay empate, victoria ni derrota");
  });

  it("los formatos y estados de torneo se nombran como en la web", () => {
    for (const name of Object.values(TOURNAMENT_FORMAT_NAME))
      expect(tournaments.toLowerCase(), name).toContain(name.toLowerCase());
    for (const name of Object.values(TOURNAMENT_STATE_NAME))
      expect(tournaments.toLowerCase(), name).toContain(name.toLowerCase());
  });

  it("ranking: el Elo empieza en 1000 y el factor K por defecto es el del código", () => {
    expect(INITIAL_RATING).toBe(1000);
    expect(rankings).toContain(`**empiezan con ${INITIAL_RATING}**`);
    expect(rankings).toContain(`por defecto, ${DEFAULT_K}`);
    for (const name of Object.values(MODE_NAME)) expect(rankings, name).toContain(name);
  });
});
