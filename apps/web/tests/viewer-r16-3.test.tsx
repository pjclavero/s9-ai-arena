// @vitest-environment jsdom
/**
 * R16.3 · Slice — panel táctico por equipo en el HUD del visor.
 *
 * R16 slice 1 (torretas/fogonazo/explosión) ya probó que el arte procedural se
 * verifica con funciones puras en Node (viewer-r16.test.ts). El catálogo
 * docs/R16_VISUAL_UPGRADE.md marca R16.3 = panel de estadísticas/feedback
 * táctico. Este slice es mínimo y SOLO del visor: deriva de `OverlayState`
 * (vía los `HudBot` ya calculados en hud-model.ts) un resumen por equipo —
 * vivos/total, HP% agregado y módulos caídos — sin inventar campos de red.
 *
 * NO se cubre aquí (fuera de alcance de R16.3, requeriría extender el
 * snapshot público): daño infligido, precisión. Ver nota en hud-model.ts.
 *
 * Se prueban dos capas:
 *  - buildHudModel (Node, puro): los números del resumen táctico son
 *    correctos contra un OverlayState conocido, incluyendo los casos límite
 *    (equipo entero muerto, equipo de un solo bot).
 *  - HudOverlay (jsdom): el resumen se pinta con los valores del modelo.
 */
import { describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { OverlayState } from "../src/viewer/overlay.js";
import { buildHudModel } from "../src/viewer/hud-model.js";
import { HudOverlay } from "../src/viewer/HudOverlay.js";

afterEach(() => cleanup());

// Snapshot con 3 equipos: uno con un vivo y uno KO (hp mixto), uno enteramente
// muerto, y uno de un solo bot vivo con módulos caídos.
function tacticalOverlay(): OverlayState {
  const overlay = new OverlayState();
  overlay.applySnapshot({
    tick: 30,
    score: { red: 1, blue: 0, green: 0 },
    vehicles: [
      {
        id: "veh_red_1",
        team: "red",
        alive: true,
        hullHp: 80,
        hullHpMax: 100, // hpRatio 0.8
        modules: [{ slot: "turret_main", state: "operational" }],
      },
      {
        id: "veh_red_2",
        team: "red",
        alive: true,
        hullHp: 40,
        hullHpMax: 100, // hpRatio 0.4
        modules: [
          { slot: "turret_main", state: "operational" },
          { slot: "drive", state: "destroyed" },
        ],
      },
      {
        id: "veh_red_3",
        team: "red",
        alive: false,
        hullHp: 0,
        hullHpMax: 100, // muerto: no cuenta para la media de HP
        modules: [{ slot: "armor_front", state: "destroyed" }],
      },
      {
        id: "veh_blue_1",
        team: "blue",
        alive: false,
        hullHp: 0,
        hullHpMax: 120,
        modules: [{ slot: "turret_main", state: "destroyed" }],
      },
      {
        id: "veh_green_1",
        team: "green",
        alive: true,
        hullHp: 50,
        hullHpMax: 100, // hpRatio 0.5, único bot del equipo
        modules: [
          { slot: "turret_main", state: "offline" },
          { slot: "drive", state: "operational" },
        ],
      },
    ],
  });
  return overlay;
}

describe("hud-model R16.3: resumen táctico por equipo (derivado, sin campos de red nuevos)", () => {
  it("equipo con vivos y KO: HP% es la media SOLO de los vivos, módulos caídos suma todo el equipo", () => {
    const model = buildHudModel(tacticalOverlay());
    const red = model.teams.find((t) => t.team === "red")!;
    // vivos: 0.8 y 0.4 -> media 0.6 -> 60%. El muerto (hpRatio 0) NO entra en la media.
    expect(red.tactical).toEqual({ botsAlive: 2, botsTotal: 3, hpPercent: 60, modulesOffline: 2 });
  });

  it("equipo entero muerto: vivos 0, HP% 0 (sin división por cero)", () => {
    const model = buildHudModel(tacticalOverlay());
    const blue = model.teams.find((t) => t.team === "blue")!;
    expect(blue.tactical).toEqual({ botsAlive: 0, botsTotal: 1, hpPercent: 0, modulesOffline: 1 });
  });

  it("equipo de un solo bot vivo: HP% es su propio hpRatio, módulos caídos de ese bot", () => {
    const model = buildHudModel(tacticalOverlay());
    const green = model.teams.find((t) => t.team === "green")!;
    expect(green.tactical).toEqual({ botsAlive: 1, botsTotal: 1, hpPercent: 50, modulesOffline: 1 });
  });

  it("es DETERMINISTA: el mismo overlay produce el mismo resumen táctico", () => {
    const a = buildHudModel(tacticalOverlay()).teams.map((t) => t.tactical);
    const b = buildHudModel(tacticalOverlay()).teams.map((t) => t.tactical);
    expect(a).toEqual(b);
  });
});

describe("HudOverlay R16.3 (jsdom): el resumen táctico se pinta con los valores del modelo", () => {
  it("pinta vivos/total y HP% para cada equipo, y el recuento de módulos caídos cuando > 0", () => {
    const model = buildHudModel(tacticalOverlay());
    render(<HudOverlay model={model} />);

    const redTeam = screen.getAllByTestId("hud-team").find((el) => el.getAttribute("data-team") === "red")!;
    const redRow = redTeam.querySelector('[data-testid="hud-team-tactical"]')!;
    expect(redRow.querySelector('[data-testid="hud-team-tactical-alive"]')!.textContent).toBe("vivos 2/3");
    expect(redRow.querySelector('[data-testid="hud-team-tactical-hp"]')!.textContent).toBe("HP 60%");
    expect(redRow.querySelector('[data-testid="hud-team-tactical-modules"]')!.textContent).toBe("2 módulos caídos");
  });

  it("equipo sin módulos caídos NO pinta la celda de módulos (nada que anunciar)", () => {
    const overlay = new OverlayState();
    overlay.applySnapshot({
      tick: 1,
      score: { solo: 0 },
      vehicles: [
        {
          id: "veh_solo_1",
          team: "solo",
          alive: true,
          hullHp: 100,
          hullHpMax: 100,
          modules: [{ slot: "turret_main", state: "operational" }],
        },
      ],
    });
    const model = buildHudModel(overlay);
    render(<HudOverlay model={model} />);
    const row = screen.getByTestId("hud-team-tactical");
    expect(row.querySelector('[data-testid="hud-team-tactical-hp"]')!.textContent).toBe("HP 100%");
    expect(row.querySelector('[data-testid="hud-team-tactical-modules"]')).toBeNull();
  });
});
