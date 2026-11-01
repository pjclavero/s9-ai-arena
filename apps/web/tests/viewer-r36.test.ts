/**
 * R3.6 · MEJ-gráficos — HUD completo + minimapa.
 *
 * Regla de oro de la Ronda 2: la verificación VISUAL en canvas NO es ejecutable
 * aquí (sin navegador). Se prueba la LÓGICA pura que el Definition of Done exige
 * testeable:
 *  - el VIEWMODEL del HUD derivado del snapshot conocido (marcador, vida,
 *    objetivos, kill feed, fin de partida) — funciones puras contra un snapshot
 *    real guionizado;
 *  - el MINIMAPA (UX-VIEW: ya no es una segunda cámara dentro del canvas sino
 *    un panel FUERA del escenario): su geometría pura y que ningún bot quede
 *    invisible;
 *  - el registro del FIN DE PARTIDA en el overlay, que alimenta tanto el HUD como
 *    el rótulo que PhaserViewer dibuja sobre el canvas.
 *
 * La parte "se pinta en el canvas / segunda cámara compone en pantalla" queda
 * declarada NO EJECUTADA (sin infra de navegador).
 */
import { describe, expect, it } from "vitest";
import { OverlayState } from "../src/viewer/overlay.js";
import { buildHudModel } from "../src/viewer/hud-model.js";
import {
  computeMinimapLayout,
  minimapBoxHeight,
  minimapDots,
  minimapToWorld,
  minimapViewRect,
  minimapWidthFor,
  rectsOverlap,
  worldToMinimap,
  MIN_DOT_RADIUS_PX,
} from "../src/viewer/minimap.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Snapshot CTF conocido: 2 equipos, casco/módulos variados, banderas y una zona.
function ctfOverlay(): OverlayState {
  const overlay = new OverlayState();
  overlay.applySnapshot({
    tick: 90, // 3 s a 30 Hz
    score: { red: 2, blue: 1 },
    vehicles: [
      {
        id: "veh_red_1",
        team: "red",
        alive: true,
        hullHp: 60,
        hullHpMax: 100,
        carryingFlag: "blue",
        modules: [
          { slot: "turret_main", state: "operational" },
          { slot: "drive", state: "destroyed" },
        ],
      },
      {
        id: "veh_blue_1",
        team: "blue",
        alive: false,
        hullHp: 0,
        hullHpMax: 200,
        modules: [
          { slot: "turret_main", state: "destroyed" },
          { slot: "armor_front", state: "offline" },
        ],
      },
    ],
    objectives: [
      { kind: "flag", team: "red", state: "at_base", position: { x: 5, y: 5 } },
      { kind: "flag", team: "blue", state: "carried" },
      { kind: "zone", id: "z1", team: "red", state: "held", position: { x: 10, y: 10 } },
    ],
  });
  return overlay;
}

// ─────────────────────────── HUD viewmodel (snapshot conocido) ────────────────

describe("buildHudModel: refleja marcador, vida y estado de objetivos en vivo", () => {
  it("marcador ORDENADO por puntos, con el líder marcado", () => {
    const model = buildHudModel(ctfOverlay());
    expect(model.score.map((s) => s.team)).toEqual(["red", "blue"]);
    expect(model.score[0]).toMatchObject({ team: "red", points: 2, leading: true });
    expect(model.score[1]).toMatchObject({ team: "blue", points: 1, leading: false });
  });

  it("reloj derivado del tick (eje de partida) y fase en juego", () => {
    const model = buildHudModel(ctfOverlay());
    expect(model.clock.tick).toBe(90);
    expect(model.clock.timeMs).toBe(3000);
    expect(model.clock.label).toBe("0:03");
    expect(model.clock.phase).toBe("en_juego");
  });

  it("objetivo inferido de los objetivos públicos: CTF", () => {
    expect(buildHudModel(ctfOverlay()).objective).toEqual({ mode: "ctf", text: "Captura la bandera" });
  });

  it("panel por equipo con VIDA y MÓDULOS derivados del snapshot público", () => {
    const model = buildHudModel(ctfOverlay());
    const red = model.teams.find((t) => t.team === "red")!;
    const blue = model.teams.find((t) => t.team === "blue")!;
    expect(red.points).toBe(2);
    expect(red.aliveCount).toBe(1);
    const r1 = red.bots[0];
    expect(r1.id).toBe("veh_red_1");
    expect(r1.hpPercent).toBe(60); // 60/100
    expect(r1.carryingFlag).toBe("blue");
    expect(r1.mobilityCrippled).toBe(true); // drive destruido
    expect(r1.turretLocked).toBe(false);
    expect(r1.modulesTotal).toBe(2);
    expect(r1.modulesDown).toBe(1);
    const b1 = blue.bots[0];
    expect(b1.alive).toBe(false);
    expect(b1.hpPercent).toBe(0);
    expect(b1.turretLocked).toBe(true); // turret destruido
    expect(b1.armorBroken).toBe(true); // armor offline
    expect(b1.modulesDown).toBe(2);
  });

  it("estado de BANDERAS y control de ZONAS presentes en el modelo", () => {
    const overlay = ctfOverlay();
    overlay.applyEvent({ kind: "flag_taken", team: "blue", sourceId: "veh_red_1", tick: 80 });
    const model = buildHudModel(overlay);
    const blueFlag = model.flags.find((f) => f.team === "blue")!;
    expect(blueFlag.state).toBe("carried");
    expect(blueFlag.carrierId).toBe("veh_red_1");
    expect(model.zones).toEqual([{ id: "z1", team: "red", state: "held" }]);
  });

  it("KILL FEED derivado de los eventos vehicle_destroyed", () => {
    const overlay = ctfOverlay();
    overlay.applyEvent({ kind: "vehicle_destroyed", targetId: "veh_blue_1", tick: 88 });
    overlay.applyEvent({ kind: "score_changed", score: { red: 3, blue: 1 }, tick: 89 });
    const model = buildHudModel(overlay);
    expect(model.killFeed.length).toBe(1);
    expect(model.killFeed[0]).toMatchObject({ tick: 88 });
    expect(model.killFeed[0].text).toContain("veh_blue_1");
  });

  it("usa la NÓMINA para nombres de bot cuando está disponible", () => {
    const roster = new Map([["veh_red_1", { name: "Relámpago", team: "red" }]]);
    const model = buildHudModel(ctfOverlay(), { roster });
    const red = model.teams.find((t) => t.team === "red")!;
    expect(red.bots[0].name).toBe("Relámpago");
  });

  it("es DETERMINISTA: el mismo overlay produce el mismo modelo (directo = replay)", () => {
    expect(buildHudModel(ctfOverlay())).toEqual(buildHudModel(ctfOverlay()));
  });
});

// ─────────────────────────── fin de partida (canvas + HUD) ────────────────────

describe("fin de partida: el overlay lo registra y el HUD lo anuncia", () => {
  it("applyResult fija ganador, marcador final y fase FINAL", () => {
    const overlay = ctfOverlay();
    overlay.applyResult({ winner: "red", score: { red: 3, blue: 1 }, reason: "score" });
    expect(overlay.result).toMatchObject({ winner: "red", reason: "score" });
    expect(overlay.score).toEqual({ red: 3, blue: 1 });
    const model = buildHudModel(overlay);
    expect(model.clock.phase).toBe("final");
    expect(model.matchEnd).toMatchObject({ winner: "red", headline: "Gana red" });
    expect(model.matchEnd!.score).toEqual({ red: 3, blue: 1 });
    // Deja constancia también en el feed (ticker HTML).
    expect(overlay.feed.some((f) => f.kind === "match_ended")).toBe(true);
  });

  it("el empate se anuncia como tal", () => {
    const overlay = ctfOverlay();
    overlay.applyResult({ winner: null, score: { red: 2, blue: 2 } });
    expect(buildHudModel(overlay).matchEnd!.headline).toBe("Empate");
  });

  it("es idempotente: el primer resultado manda (reconexión no lo pisa)", () => {
    const overlay = ctfOverlay();
    overlay.applyResult({ winner: "red", score: { red: 3, blue: 1 } });
    overlay.applyResult({ winner: "blue", score: { red: 0, blue: 9 } });
    expect(overlay.result!.winner).toBe("red");
  });

  it("también acepta el fin como EVENTO del stream (match_ended)", () => {
    const overlay = ctfOverlay();
    overlay.applyEvent({ kind: "match_ended", winner: "blue", score: { red: 1, blue: 3 }, tick: 120 });
    expect(overlay.result).toMatchObject({ winner: "blue", endedTick: 120 });
  });

  it("sin resultado, no hay indicador de fin en el HUD", () => {
    expect(buildHudModel(ctfOverlay()).matchEnd).toBeNull();
  });
});

// ─────────────────── minimapa FUERA del escenario (UX-VIEW sustituye a R3.6) ───────────
//
// R3.6 fijaba aquí un minimapa como SEGUNDA cámara de Phaser dentro del canvas
// (160 px, x=12, y=640−160−12, «exactamente una cámara»). UX-VIEW lo saca del área
// del mapa a un panel propio (MinimapPanel): tapaba el mapa y un bot podía quedar
// invisible debajo. Estos casos son su EQUIVALENTE: la geometría pura que dibuja
// el panel (encaje del mapa, puntos, rectángulo de vista, pulsar para centrar) y la
// garantía de que el escenario ya no lleva ninguna cámara de minimapa.

describe("minimapa: encaje del mapa entero en su caja (sin deformar)", () => {
  it("el mapa 120×80 cabe con margen, centrado y con la MISMA escala en los dos ejes", () => {
    const l = computeMinimapLayout({ widthM: 120, heightM: 80 }, 240, 168, 6);
    expect(l.mapW / 120).toBeCloseTo(l.mapH / 80, 9); // uniforme: no deforma
    expect(l.mapW).toBeLessThanOrEqual(240 - 12 + 1e-9);
    expect(l.mapH).toBeLessThanOrEqual(168 - 12 + 1e-9);
    expect(l.offsetX).toBeCloseTo((240 - l.mapW) / 2, 9);
    expect(l.offsetY).toBeCloseTo((168 - l.mapH) / 2, 9);
  });

  it("el alto de la caja sigue la proporción del mapa (acotado)", () => {
    expect(minimapBoxHeight({ widthM: 120, heightM: 80 }, 240)).toBe(Math.round((240 - 12) * (80 / 120) + 12));
    expect(minimapBoxHeight({ widthM: 10, heightM: 1000 }, 200)).toBe(300); // tope 1.5× el ancho
  });

  it("pulsar el minimapa da el punto del mundo, recortado a los límites", () => {
    const world = { widthM: 120, heightM: 80 };
    const l = computeMinimapLayout(world, 240, 168, 6);
    const p = worldToMinimap(l, 30, 20);
    const back = minimapToWorld(l, world, p.x, p.y);
    expect(back.x).toBeCloseTo(30, 6);
    expect(back.y).toBeCloseTo(20, 6);
    expect(minimapToWorld(l, world, -50, 9999)).toEqual({ x: 0, y: 80 });
  });
});

describe("minimapa: ningún bot invisible", () => {
  const world = { widthM: 120, heightM: 80 };
  const l = computeMinimapLayout(world, 160, 112, 6);

  it("8 vehículos ⇒ 8 puntos con radio mínimo, todos DENTRO del mapa dibujado", () => {
    const vs = Array.from({ length: 8 }, (_, i) => ({
      id: `v${i}`,
      x: i === 0 ? 0 : i === 1 ? 120 : 15 * i,
      y: i === 0 ? 0 : i === 1 ? 80 : 10 * i,
      alive: i !== 3,
      team: i < 4 ? "red" : "blue",
    }));
    const dots = minimapDots(vs, l, null);
    expect(dots).toHaveLength(8);
    for (const d of dots) {
      expect(d.r).toBeGreaterThanOrEqual(MIN_DOT_RADIUS_PX);
      expect(d.x - d.r).toBeGreaterThanOrEqual(l.offsetX - 1e-9);
      expect(d.x + d.r).toBeLessThanOrEqual(l.offsetX + l.mapW + 1e-9);
      expect(d.y - d.r).toBeGreaterThanOrEqual(l.offsetY - 1e-9);
      expect(d.y + d.r).toBeLessThanOrEqual(l.offsetY + l.mapH + 1e-9);
    }
    // El destruido sigue dibujado (hueco con aspa), no desaparece.
    expect(dots.find((d) => d.id === "v3")!.alive).toBe(false);
  });

  it("el seleccionado es más grande y se pinta el ÚLTIMO (encima de los demás)", () => {
    const dots = minimapDots(
      [
        { id: "a", x: 10, y: 10, alive: true },
        { id: "b", x: 10, y: 10, alive: true },
      ],
      l,
      "a",
    );
    expect(dots.at(-1)!.id).toBe("a");
    expect(dots.at(-1)!.r).toBeGreaterThan(dots[0].r);
  });

  it("el minimapa del panel y el escenario no se solapan (rectsOverlap)", () => {
    const stage = { x: 0, y: 100, width: 1500, height: 800 };
    expect(rectsOverlap(stage, { x: 1512, y: 100, width: 300, height: 210 })).toBe(false);
    expect(rectsOverlap(stage, { x: 12, y: 628, width: 160, height: 160 })).toBe(true); // el de R3.6
  });
});

describe("minimapa: rectángulo de la cámara principal", () => {
  const world = { widthM: 120, heightM: 80 };
  const l = computeMinimapLayout(world, 240, 168, 6);

  it("vista completa ⇒ el rectángulo cubre el mapa dibujado entero", () => {
    const r = minimapViewRect(l, { centerX: 60, centerY: 40, zoom: 4, viewportW: 960, viewportH: 640 })!;
    expect(r.x).toBeCloseTo(l.offsetX, 6);
    expect(r.y).toBeCloseTo(l.offsetY, 6);
    expect(r.w).toBeCloseTo(l.mapW, 6);
    expect(r.h).toBeCloseTo(l.mapH, 6);
  });

  it("con zoom el rectángulo encoge en proporción y se centra en la cámara", () => {
    // zoom 16 px/m en 960×640 ⇒ 60×40 m visibles alrededor de (30, 20).
    const r = minimapViewRect(l, { centerX: 30, centerY: 20, zoom: 16, viewportW: 960, viewportH: 640 })!;
    expect(r.w).toBeCloseTo(60 * l.scale, 6);
    expect(r.h).toBeCloseTo(40 * l.scale, 6);
    expect(r.x).toBeCloseTo(l.offsetX, 6);
    expect(r.y).toBeCloseTo(l.offsetY, 6);
  });

  it("tamaños S/M/L acotados al hueco disponible", () => {
    expect(minimapWidthFor("s", 999)).toBe(160);
    expect(minimapWidthFor("m", 999)).toBe(240);
    expect(minimapWidthFor("l", 999)).toBe(320);
    expect(minimapWidthFor("l", 200)).toBe(200);
  });
});

describe("el escenario ya NO lleva una cámara de minimapa dentro del canvas", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/viewer/PhaserViewer.ts", import.meta.url)), "utf8");
  it("PhaserViewer no añade cámaras (cameras.add) ni importa el controlador antiguo", () => {
    expect(src).not.toMatch(/cameras\.add\(/);
    expect(src).not.toMatch(/MinimapController/);
    // Y expone el estado que dibuja el panel externo.
    expect(src).toMatch(/minimapState\(\): MinimapState/);
  });
});
