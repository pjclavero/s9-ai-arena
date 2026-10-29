/**
 * P1 · «En batalla el escenario se ve negro y sin nada, aunque el mapa tiene obstáculos».
 *
 * En Phaser 4 (4.2.1) las operaciones de una RenderTexture/DynamicTexture (clear,
 * fill, draw…) se ACUMULAN en `commandBuffer` y sólo se ejecutan con `render()`
 * (node_modules/phaser/src/textures/DynamicTexture.js, RenderTexture.js#render:
 * «You must do this in order to see anything drawn to it»). `drawStatic()` horneaba
 * suelo, muros y destructibles sin llamar nunca a `render()` y además destruía el
 * Graphics antes de que el búfer se ejecutara: textura vacía → fondo negro.
 *
 * Doble de la RenderTexture que registra el ORDEN de las llamadas: el horneado
 * tiene que acabar en `render()` y el Graphics temporal sólo se destruye después.
 * Mismo criterio para la capa de decals (limpieza al cambiar de mundo y cada decal).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("phaser", () => {
  class Scene {
    constructor(_key?: string) {}
  }
  const Events = { READY: "ready", DESTROY: "destroy", CREATE: "create", SHUTDOWN: "shutdown" };
  const P = {
    Scene,
    GameObjects: {},
    Core: { Events },
    Scenes: { Events, RUNNING: 5 },
    Scale: { NONE: 0 },
    AUTO: 0,
  };
  return { default: P, ...P };
});

import { ViewerScene } from "../src/viewer/PhaserViewer.js";

function rtDouble(name: string, log: string[]) {
  const rt: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ["clear", "fill", "draw", "render", "setSize"]) {
    rt[op] = () => {
      log.push(`${name}.${op}`);
      return rt;
    };
  }
  rt.setOrigin = () => rt;
  rt.setDepth = () => rt;
  return rt;
}

function graphicsDouble(log: string[]) {
  const g = { fillStyle: () => g, fillRect: () => g, fillCircle: () => g, destroy: () => log.push("g.destroy") };
  return g;
}

function sceneWith(log: string[]) {
  const scene = new ViewerScene() as any;
  scene.sys = { isActive: () => true };
  scene.add = { renderTexture: () => rtDouble("static", log) };
  scene.make = { graphics: () => graphicsDouble(log) };
  scene.scale = { width: 960, height: 640 };
  scene.minimap = null;
  return scene;
}

const WORLD = {
  widthM: 60,
  heightM: 40,
  walls: [{ position: { x: 10, y: 10 }, halfW: 2, halfH: 5 }],
  destructibles: [{ position: { x: 30, y: 20 }, halfW: 1, halfH: 1 }],
};

describe("P1 · las RenderTexture del visor se ejecutan (render) y no quedan negras", () => {
  it("drawStatic: fill + draw de muros y DESPUÉS render(), antes de destruir el Graphics", () => {
    const log: string[] = [];
    const scene = sceneWith(log);
    scene.setWorld(WORLD);
    const iFill = log.indexOf("static.fill");
    const iDraw = log.lastIndexOf("static.draw");
    const iRender = log.lastIndexOf("static.render");
    const iDestroy = log.indexOf("g.destroy");
    expect(iFill).toBeGreaterThanOrEqual(0); // el suelo se pinta
    expect(iDraw).toBeGreaterThan(iFill); // y encima los obstáculos
    expect(iRender, `orden: ${log.join(" → ")}`).toBeGreaterThan(iDraw);
    expect(iDestroy, `orden: ${log.join(" → ")}`).toBeGreaterThan(iRender);
  });

  it("re-hornear al cambiar de mundo también ejecuta el búfer (y limpia los decals con render)", () => {
    const log: string[] = [];
    const scene = sceneWith(log);
    scene.decalLayer = rtDouble("decal", log);
    scene.setWorld(WORLD);
    log.length = 0;
    scene.setWorld({ ...WORLD, widthM: 80 });
    expect(log.lastIndexOf("static.render")).toBeGreaterThan(log.lastIndexOf("static.draw"));
    expect(log.lastIndexOf("decal.render")).toBeGreaterThan(log.lastIndexOf("decal.clear"));
  });

  it("bakeDecals: cada decal se ejecuta con render() antes de destruir su Graphics", () => {
    const log: string[] = [];
    const scene = sceneWith(log);
    scene.decalLayer = rtDouble("decal", log);
    scene.effects = { drainDecals: () => [{ x: 1, y: 1, radiusM: 1, alpha: 0.5 }] };
    scene.bakeDecals();
    const iDraw = log.lastIndexOf("decal.draw");
    const iRender = log.lastIndexOf("decal.render");
    expect(iDraw).toBeGreaterThanOrEqual(0);
    expect(iRender).toBeGreaterThan(iDraw);
    expect(log.indexOf("g.destroy")).toBeGreaterThan(iRender);
  });
});
