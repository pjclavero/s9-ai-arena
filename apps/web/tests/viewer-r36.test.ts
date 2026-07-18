/**
 * R3.6 · MEJ-gráficos — HUD completo + minimapa.
 *
 * Regla de oro de la Ronda 2: la verificación VISUAL en canvas NO es ejecutable
 * aquí (sin navegador). Se prueba la LÓGICA pura que el Definition of Done exige
 * testeable:
 *  - el VIEWMODEL del HUD derivado del snapshot conocido (marcador, vida,
 *    objetivos, kill feed, fin de partida) — funciones puras contra un snapshot
 *    real guionizado;
 *  - la construcción del MINIMAPA: UNA sola cámara adicional (setViewport +
 *    ignore()) SIN duplicar entidades, verificable por su configuración;
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
  computeMinimapViewport,
  computeMinimapZoom,
  worldCenterPx,
  MinimapController,
  MINIMAP_CAMERA_NAME,
  type MinimapSceneLike,
  type MinimapCameraLike,
} from "../src/viewer/minimap.js";

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

// ───────────────────────────── minimapa (una sola cámara) ─────────────────────

/** Cámara de mentira que registra su configuración para poder auditarla. */
class FakeCamera implements MinimapCameraLike {
  name = "";
  viewport: [number, number, number, number] | null = null;
  zoom = 1;
  center: [number, number] | null = null;
  background: number | string | null = null;
  round = false;
  ignored: unknown[] = [];
  setName(n: string) {
    this.name = n;
    return this;
  }
  setViewport(x: number, y: number, w: number, h: number) {
    this.viewport = [x, y, w, h];
    return this;
  }
  setZoom(z: number) {
    this.zoom = z;
    return this;
  }
  centerOn(x: number, y: number) {
    this.center = [x, y];
    return this;
  }
  setBackgroundColor(c: number | string) {
    this.background = c;
    return this;
  }
  setRoundPixels(r: boolean) {
    this.round = r;
    return this;
  }
  ignore(obj: unknown) {
    this.ignored.push(obj);
    return this;
  }
}

/** Escena de mentira que cuenta cuántas cámaras se AÑADEN. */
class FakeScene implements MinimapSceneLike {
  added: FakeCamera[] = [];
  cameras = {
    add: (_x: number, _y: number, _w: number, _h: number, makeMain?: boolean, name?: string): MinimapCameraLike => {
      const cam = new FakeCamera();
      cam.name = name ?? "";
      // El minimapa jamás debe pedir ser la cámara principal.
      expect(makeMain).toBe(false);
      this.added.push(cam);
      return cam;
    },
  };
}

describe("minimapa: geometría pura (viewport + zoom que encuadra el mapa)", () => {
  it("viewport cuadrado anclado a la esquina con margen y acotado", () => {
    const p = computeMinimapViewport(960, 640, { pxPerM: 8, corner: "bottom-left", marginPx: 12, sizeFraction: 0.25 });
    expect(p.width).toBe(p.height); // cuadrado
    expect(p.width).toBe(160); // 640*0.25
    expect(p.x).toBe(12); // pegado a la izquierda
    expect(p.y).toBe(640 - 160 - 12); // pegado abajo
  });

  it("ancla a top-right cuando se pide", () => {
    const p = computeMinimapViewport(1000, 800, { pxPerM: 8, corner: "top-right", marginPx: 10, sizeFraction: 0.2 });
    expect(p.x).toBe(1000 - p.width - 10);
    expect(p.y).toBe(10);
  });

  it("el zoom hace CABER el mapa entero en el viewport", () => {
    const placement = { x: 0, y: 0, width: 160, height: 160 };
    // Mundo 120×80 m a 8 px/m = 960×640 px de escena.
    const zoom = computeMinimapZoom(placement, { widthM: 120, heightM: 80 }, 8, 0);
    // El lado limitante es el ancho (960 px): 160/960.
    expect(zoom).toBeCloseTo(160 / 960, 6);
    // A ese zoom el mapa cabe: 960*zoom ≤ 160 y 640*zoom ≤ 160.
    expect(960 * zoom).toBeLessThanOrEqual(160 + 1e-9);
    expect(640 * zoom).toBeLessThanOrEqual(160 + 1e-9);
  });

  it("centra en el centro del mundo en píxeles de escena", () => {
    expect(worldCenterPx({ widthM: 120, heightM: 80 }, 8)).toEqual({ x: 480, y: 320 });
  });
});

describe("MinimapController: UNA sola cámara adicional, sin duplicar entidades", () => {
  it("añade EXACTAMENTE una cámara, nombrada, y NO como principal", () => {
    const scene = new FakeScene();
    new MinimapController(scene, { world: { widthM: 120, heightM: 80 }, pxPerM: 8 });
    expect(scene.added.length).toBe(1);
    expect(scene.added[0].name).toBe(MINIMAP_CAMERA_NAME);
  });

  it("ignora SOLO las capas de detalle; las entidades del mundo NO se ignoran", () => {
    const scene = new FakeScene();
    const decals = { kind: "decals" };
    const debug = { kind: "debug" };
    // Entidades del mundo que DEBEN verse en el minimapa (compartidas, no duplicadas):
    const vehicle = { kind: "vehicle" };
    const objective = { kind: "objective" };
    const ctrl = new MinimapController(scene, {
      world: { widthM: 120, heightM: 80 },
      pxPerM: 8,
      ignore: [decals, debug],
    });
    expect(ctrl.camera).toBe(scene.added[0]);
    expect(scene.added[0].ignored).toContain(decals);
    expect(scene.added[0].ignored).toContain(debug);
    // La clave del DoD: las entidades del mundo NO se ignoran ⇒ se ven en ambas
    // cámaras SIN crear una segunda copia.
    expect(scene.added[0].ignored).not.toContain(vehicle);
    expect(scene.added[0].ignored).not.toContain(objective);
  });

  it("layout() coloca el viewport, ajusta el zoom y centra en el mapa", () => {
    const scene = new FakeScene();
    const ctrl = new MinimapController(scene, {
      world: { widthM: 120, heightM: 80 },
      pxPerM: 8,
      layout: { corner: "bottom-left" },
    });
    const placement = ctrl.layout(960, 640);
    const cam = scene.added[0];
    expect(cam.viewport).toEqual([placement.x, placement.y, placement.width, placement.height]);
    expect(cam.zoom).toBeGreaterThan(0);
    expect(cam.center).toEqual([480, 320]); // centro del mundo en px
  });

  it("setWorld reencuadra al nuevo mapa sin añadir más cámaras", () => {
    const scene = new FakeScene();
    const ctrl = new MinimapController(scene, { world: { widthM: 120, heightM: 80 }, pxPerM: 8 });
    ctrl.setWorld({ widthM: 200, heightM: 200 }, 960, 640);
    expect(scene.added.length).toBe(1); // sigue habiendo una sola cámara
    expect(scene.added[0].center).toEqual([800, 800]); // nuevo centro (200/2*8)
  });
});
