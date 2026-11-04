/**
 * DOC-A · EQUIPMENT_DOCS_CURRENT · la guía de equipamiento para jugadores
 * (docs/user/equipment-catalog.md) la GENERA el catálogo real; si alguien cambia una pieza
 * y no regenera (`npx tsx scripts/generate-equipment-doc.ts`), esto se pone rojo. Las
 * cifras que la guía escrita a mano (docs/user/equipment.md y getting-started.md) cita
 * sobre equipamiento se comparan con el catálogo, nunca se copian a ciegas.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { equipmentDocMarkdown, playerName } from "./equipment-doc.js";
import { loadCatalog } from "./loadCatalog.js";
import { ARCHETYPES } from "./resolve/archetypes.js";
import { effectOf, PROPERTY_EFFECTS } from "./effect-status.js";
import { BUDGET_CREDITS_MVP, MAX_MODULE_COST_FRACTION } from "../game-rules/constants.js";
import type { LoadoutInput } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const catalog = loadCatalog();
const byRef = new Map(catalog.map((m) => [`${m.id}@${m.version}`, m]));

function loadoutCost(l: LoadoutInput): number {
  let total = byRef.get(l.chassis)!.costCredits;
  for (const m of l.modules) {
    total += byRef.get(m.moduleId)!.costCredits;
    if (m.ammo) total += byRef.get(m.ammo)!.costCredits;
  }
  return total;
}

describe("EQUIPMENT_DOCS_CURRENT · docs/user/equipment-catalog.md (generado)", () => {
  it("está al día con el catálogo (npx tsx scripts/generate-equipment-doc.ts)", () => {
    expect(read("docs/user/equipment-catalog.md")).toBe(equipmentDocMarkdown());
  });

  it("incluye TODAS las piezas del catálogo, con su nombre humano, su coste y su masa", () => {
    const md = read("docs/user/equipment-catalog.md");
    for (const m of catalog) {
      const line = md
        .split("\n")
        .find((l) => l.startsWith("| ") && l.includes(playerName(m).replace(/ \(versión \d+\)$/, "")));
      expect(line, `${m.id}@${m.version} (${m.name}) no está en el catálogo documentado`).toBeTruthy();
    }
    for (const m of catalog) {
      const rows = md
        .split("\n")
        .filter((l) => l.startsWith("| ") && l.includes(playerName(m).replace(/ \(versión \d+\)$/, "")));
      const cost = String(m.costCredits).replace(".", ",");
      const mass = String(m.massKg).replace(".", ",");
      expect(
        rows.some(
          (r) =>
            r
              .split("|")
              .map((c) => c.trim())
              .includes(cost) &&
            r
              .split("|")
              .map((c) => c.trim())
              .includes(mass),
        ),
        `${m.name}: coste ${cost} y masa ${mass} no aparecen en su fila`,
      ).toBe(true);
    }
  });

  it("la guía no enseña identificadores de módulo (nombres humanos, no `weapon.cannon@1`)", () => {
    expect(read("docs/user/equipment-catalog.md")).not.toMatch(/\b[a-z]+\.[a-z0-9_]+@\d+\b/);
  });

  it("todo dato sin efecto del catálogo aparece en «Datos que no cambian la batalla»", () => {
    const md = read("docs/user/equipment-catalog.md");
    const section = md.slice(md.indexOf("## Datos que no cambian la batalla"));
    const futures = Object.entries(PROPERTY_EFFECTS).flatMap(([cat, props]) =>
      Object.entries(props)
        .filter(([, e]) => e.status === "FUTURE")
        .map(([p]) => `${cat}.${p}`),
    );
    expect(futures.length).toBeGreaterThan(0);
    // armas, radio y movimiento tienen su línea; las utilidades una sola, común.
    for (const f of futures.filter((x) => !x.startsWith("utility."))) {
      const [cat, prop] = f.split(".");
      expect(effectOf(cat as never, prop)?.status).toBe("FUTURE");
      expect(section).toMatch(/Movimiento|Armas|Radio/);
    }
    expect(section).toContain("Utilidades");
  });
});

describe("EQUIPMENT_DOCS_CURRENT · lo que cita la guía escrita a mano", () => {
  const equipment = read("docs/user/equipment.md");
  const started = read("docs/user/getting-started.md");

  it("los cuatro equipamientos de referencia cuestan lo que dice la tabla", () => {
    const rows: [string, keyof typeof ARCHETYPES][] = [
      ["scout", "scout"],
      ["gunner", "gunner"],
      ["miner", "miner"],
      ["heavy", "heavy"],
    ];
    for (const [key, arch] of rows) {
      const cost = loadoutCost(ARCHETYPES[arch]);
      const row = equipment.split("\n").find((l) => l.includes(`(\`${key}\`)`));
      expect(row, `fila de ${key}`).toBeTruthy();
      expect(row!.trim().endsWith(`| ${cost} |`), `${key}: ${row} no cuesta ${cost}`).toBe(true);
    }
  });

  it("el presupuesto y el tope por pieza citados son los del juego", () => {
    expect(equipment).toContain(`${BUDGET_CREDITS_MVP} créditos`);
    expect(equipment).toContain(`${Math.round(MAX_MODULE_COST_FRACTION * 100)} %`);
    expect(equipment).toContain(`Coste: X/${BUDGET_CREDITS_MVP} cr`);
  });

  it("el equipo de «Primeros pasos» es el artillero: mismas piezas (por nombre) y mismo coste", () => {
    const g = ARCHETYPES.gunner;
    const names = [byRef.get(g.chassis)!.name, ...g.modules.map((m) => byRef.get(m.moduleId)!.name)];
    for (const n of names) expect(started, n).toContain(n);
    const ammo = g.modules.find((m) => m.ammo)!;
    expect(started).toContain("munición perforante");
    expect(byRef.get(ammo.ammo!)!.name).toBe("Munición perforante");
    expect(started).toContain(`**${loadoutCost(g)} créditos de ${BUDGET_CREDITS_MVP}**`);
  });
});
