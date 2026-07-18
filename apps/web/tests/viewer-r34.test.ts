/**
 * R3.4 · ERR-VIS-05 — Dirección artística y sprites modulares.
 *
 * Regla de oro de la Ronda 2: la verificación VISUAL no es ejecutable en este
 * entorno (sin navegador). Aquí se prueba la LÓGICA que decide el arte, que es
 * pura y numérica:
 *  - selección de SPRITE por chasis (explorador/artillero/pesado);
 *  - color por EQUIPO resuelto desde la capa de reglas, distinto por equipo y
 *    SIN literales en el render (DoD: "no hay colores hardcodeados");
 *  - NOMBRE del bot sobre el vehículo en vez del UUID;
 *  - el atlas sigue siendo UN solo asset batcheable (una textura, sin solapes).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  chassisKind,
  bodyFrameForChassis,
  barrelLengthForChassis,
  vehicleLabel,
  shortId,
  rosterFromMeta,
  resolveTeamColors,
  NEUTRAL_TEAM_COLOR,
  S9_ENV,
} from "../src/viewer/art-direction.js";
import { buildAtlasLayout, BODY_FRAMES } from "../src/viewer/atlas-geometry.js";

// ───────────────────────── sprite por chasis (loadout → arquetipo)

describe("chassisKind: arquetipo derivado del chasis del loadout", () => {
  it("light → explorador, heavy → pesado, medium/otros → artillero", () => {
    expect(chassisKind("chassis.light@1")).toBe("scout");
    expect(chassisKind("chassis.heavy@1")).toBe("heavy");
    expect(chassisKind("chassis.medium@1")).toBe("gunner");
    expect(chassisKind("chassis.exotico@3")).toBe("gunner");
  });

  it("tolera ausencia de dato (cae a artillero) y versiones", () => {
    expect(chassisKind(undefined)).toBe("gunner");
    expect(chassisKind(null)).toBe("gunner");
    expect(chassisKind("chassis.light")).toBe("scout"); // sin @version
  });
});

describe("bodyFrameForChassis: un frame de casco DISTINTO por arquetipo", () => {
  it("cada arquetipo pinta su silueta", () => {
    expect(bodyFrameForChassis("chassis.light@1")).toBe("body-scout");
    expect(bodyFrameForChassis("chassis.medium@1")).toBe("body-gunner");
    expect(bodyFrameForChassis("chassis.heavy@1")).toBe("body-heavy");
  });

  it("los tres frames existen en el atlas y son distintos", () => {
    const names = buildAtlasLayout().frames.map((f) => f.name);
    for (const bf of BODY_FRAMES) expect(names).toContain(bf);
    expect(new Set(BODY_FRAMES).size).toBe(3);
  });

  it("el largo del cañón crece con el peso del chasis (diferenciación modular)", () => {
    const scout = barrelLengthForChassis("chassis.light@1");
    const gunner = barrelLengthForChassis("chassis.medium@1");
    const heavy = barrelLengthForChassis("chassis.heavy@1");
    expect(scout).toBeLessThan(gunner);
    expect(gunner).toBeLessThan(heavy);
  });
});

// ───────────────────────── color por equipo desde el ruleset

describe("resolveTeamColors: color por equipo desde la capa de reglas", () => {
  it("red y blue reciben color propio y DISTINTO", () => {
    const c = resolveTeamColors(["red", "blue"]);
    expect(c.get("red")).toBeTypeOf("number");
    expect(c.get("blue")).toBeTypeOf("number");
    expect(c.get("red")).not.toBe(c.get("blue"));
  });

  it("un equipo distinto de red/blue tiene su propio color, distinto de ambos", () => {
    const c = resolveTeamColors(["red", "blue", "green", "gamma"]);
    const colors = [c.get("red"), c.get("blue"), c.get("green"), c.get("gamma")];
    // Los cuatro equipos, cuatro colores distintos (nada colapsa a red/blue).
    expect(new Set(colors).size).toBe(4);
  });

  it("es DETERMINISTA e independiente del orden de entrada", () => {
    const a = resolveTeamColors(["blue", "red", "t3"]);
    const b = resolveTeamColors(["t3", "red", "blue"]);
    expect(b.get("red")).toBe(a.get("red"));
    expect(b.get("blue")).toBe(a.get("blue"));
    expect(b.get("t3")).toBe(a.get("t3"));
  });

  it("nunca deja un equipo sin color", () => {
    const c = resolveTeamColors(["equipo-raro"]);
    expect(typeof c.get("equipo-raro")).toBe("number");
    expect(NEUTRAL_TEAM_COLOR).toBeTypeOf("number");
  });
});

/**
 * DoD explícito: "test de que NO hay colores hardcodeados". El render (PhaserViewer)
 * no puede resolver el color de un equipo con literales; debe delegar en
 * resolveTeamColors. Se comprueba sobre el propio fuente del render.
 */
describe("PhaserViewer: el color de equipo NO está hardcodeado en el render", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/viewer/PhaserViewer.ts", import.meta.url)), "utf8");

  it("no queda el mapa TEAM_COLORS ni sus hexadecimales antiguos", () => {
    expect(src).not.toMatch(/TEAM_COLORS/);
    expect(src).not.toMatch(/0xe05555/i); // rojo hardcodeado anterior
    expect(src).not.toMatch(/0x5588e0/i); // azul hardcodeado anterior
  });

  it("resuelve el tinte desde la capa de reglas (resolveTeamColors)", () => {
    expect(src).toMatch(/resolveTeamColors/);
    expect(src).toMatch(/bodyFrameForChassis/); // sprite por chasis
    expect(src).toMatch(/vehicleLabel/); // nombre, no UUID
  });
});

// ───────────────────────── nombre del bot, no el UUID

describe("vehicleLabel: el NOMBRE del bot, jamás el UUID crudo", () => {
  const uuid = "5f2a1c9e-7b3d-4e10-9a6c-2f1b8d0c4e77";

  it("con nómina pinta el nombre del bot", () => {
    const roster = rosterFromMeta([{ id: uuid, name: "Segador", team: "red", chassis: "chassis.heavy@1" }]);
    expect(vehicleLabel(roster, uuid)).toBe("Segador");
  });

  it("sin nombre NUNCA muestra el UUID completo (id abreviado)", () => {
    const label = vehicleLabel(new Map(), uuid);
    expect(label).not.toBe(uuid);
    expect(label.length).toBeLessThan(uuid.length);
    expect(uuid.startsWith(label)).toBe(true);
  });

  it("sin nómina en absoluto tampoco revienta", () => {
    expect(vehicleLabel(null, "veh_1")).toBe("veh_1");
    expect(shortId(uuid)).toBe("5f2a1c9e");
  });
});

describe("rosterFromMeta: parsea la nómina de la cabecera y descarta basura", () => {
  it("convierte el array de meta en un Map por id", () => {
    const roster = rosterFromMeta([
      { id: "veh_1", name: "Alfa", team: "red", chassis: "chassis.light@1", botId: "b1" },
      { id: "veh_2", name: "Beta", team: "blue", chassis: "chassis.heavy@1" },
    ]);
    expect(roster.size).toBe(2);
    expect(roster.get("veh_1")).toMatchObject({ name: "Alfa", team: "red", chassis: "chassis.light@1" });
    expect(bodyFrameForChassis(roster.get("veh_2")!.chassis)).toBe("body-heavy");
  });

  it("entradas sin id o no-objeto se ignoran; entrada no-array → Map vacío", () => {
    expect(rosterFromMeta([{ name: "sin-id" }, null, 42]).size).toBe(0);
    expect(rosterFromMeta(undefined).size).toBe(0);
    expect(rosterFromMeta("nope").size).toBe(0);
  });
});

// ───────────────────────── el atlas sigue siendo UN asset batcheable

describe("Atlas R3.4: un solo asset, frames del apartado artístico sin solapes", () => {
  const layout = buildAtlasLayout();

  it("incluye chasis por tipo, torreta, arma, proyectil, bandera, módulo y partículas", () => {
    const names = layout.frames.map((f) => f.name);
    for (const n of [
      "body-scout",
      "body-gunner",
      "body-heavy",
      "turret",
      "barrel",
      "projectile",
      "flag",
      "module",
      "smoke",
      "spark",
    ]) {
      expect(names, `falta el frame ${n}`).toContain(n);
    }
  });

  it("todos los frames caben en el lienzo (un solo atlas)", () => {
    for (const f of layout.frames) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(layout.width);
      expect(f.y + f.h).toBeLessThanOrEqual(layout.height);
    }
    // El bloque de fuente también cabe (RetroFont comparte la textura → batcheable).
    const rows = Math.ceil(layout.font.chars.length / layout.font.charsPerRow);
    expect(layout.font.offsetY + rows * layout.font.cellH).toBeLessThanOrEqual(layout.height);
  });

  it("ningún par de frames se solapa (anti-sangrado del batch)", () => {
    const f = layout.frames;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i];
        const b = f[j];
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `${a.name} solapa con ${b.name}`).toBe(true);
      }
    }
  });

  it("la paleta de entorno S9 define la dirección artística única", () => {
    expect(S9_ENV.background).toBeTypeOf("string");
    expect(S9_ENV.ground).toBeTypeOf("number");
    expect(S9_ENV.tracer).toBeTypeOf("number");
  });
});
