/**
 * UX-VIEW · Bloque B en la ESCENA (Phaser simulado): el nombre ya no va dentro
 * del contenedor que rota con el casco, no escala con el zoom, y la barra fina
 * de vida se dibuja ENCIMA del vehículo con su proporción real.
 *
 * Antes: `buildVehicle` metía el BitmapText en el contenedor (setRotation del
 * casco lo giraba y el zoom de la cámara lo escalaba) y no había vida en el canvas.
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

type Call = [string, ...unknown[]];

function make(kind: string, log: Call[], extra: Record<string, unknown> = {}) {
  const o: Record<string, unknown> = { kind, ...extra };
  const p = new Proxy(o, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        log.push([`${kind}.${prop}`, ...args]);
        if (prop === "setText") t.text = args[0];
        if (prop === "setScale") t.scale = args[0];
        if (prop === "setVisible") t.visible = args[0];
        if (prop === "setPosition") t.pos = args;
        return p;
      };
    },
  });
  return p as any;
}

function sceneWith(camZoom: number) {
  const log: Call[] = [];
  const labels: any[] = [];
  const containers: any[] = [];
  const scene = new ViewerScene() as any;
  scene.sys = { isActive: () => false };
  scene.scale = { width: 960, height: 640, zoom: 1 };
  scene.cameras = { main: { zoom: camZoom, worldView: { x: 0, y: 0, width: 960 / camZoom, height: 640 / camZoom } } };
  scene.add = {
    sprite: () => make("sprite", log),
    container: (_x: number, _y: number, children: unknown[]) => {
      const c = make("container", log, { children });
      containers.push(c);
      return c;
    },
    bitmapText: (_x: number, _y: number, _k: string, text: string) => {
      const l = make("label", log, { text });
      labels.push(l);
      return l;
    },
  };
  scene.markersGfx = make("markers", log);
  scene.tagsGfx = make("tags", log);
  scene.setRoster(new Map([["v1", { name: "A-ATK-1", team: "red" }]]));
  scene.overlay.applySnapshot({
    tick: 1,
    vehicles: [{ id: "v1", team: "red", alive: true, hullHp: 30, hullHpMax: 120, modules: [] }],
  });
  return { scene, log, labels, containers };
}

const frame = (alive = true) => ({
  vehicles: new Map([["v1", { x: 20, y: 20, heading: 1.2, turretHeading: 0, alive, alpha: 1 }]]),
});

describe("escena: nombre y vida en tamaño de pantalla, sin rotar", () => {
  it("el contenedor que rota con el casco ya NO lleva el nombre", () => {
    const { scene, containers } = sceneWith(1);
    scene.buildVehicle("v1");
    const outer = containers.at(-1);
    expect(outer.children.map((c: any) => c.kind)).not.toContain("label");
  });

  it("la escala del nombre compensa el zoom: mismo tamaño en pantalla a zoom 2 y 4, y nunca gira", () => {
    const a = sceneWith(2);
    a.scene.renderTags(frame(), 0);
    const b = sceneWith(4);
    b.scene.renderTags(frame(), 0);
    const la = a.labels[0];
    const lb = b.labels[0];
    expect(la.visible).toBe(true);
    expect(la.scale * 2).toBeCloseTo(lb.scale * 4, 9); // px en pantalla = escala × zoom
    expect([...a.log, ...b.log].some(([m]) => m === "label.setRotation")).toBe(false);
  });

  it("barra fina de vida con su proporción (30/120 = 25 %) y ENCIMA del vehículo", () => {
    const { scene, log } = sceneWith(2);
    scene.renderTags(frame(), 0);
    const rects = log.filter(([m]) => m === "tags.fillRect");
    expect(rects).toHaveLength(2); // fondo + relleno
    const [, , by, bw] = rects[0] as [string, number, number, number, number];
    const [, , fy, fw, fh] = rects[1] as [string, number, number, number, number];
    expect(fw / (bw - 2 * (1 / 2))).toBeCloseTo(0.25, 6);
    expect(fy + fh).toBeLessThan(20 * 8); // por encima del centro del vehículo (y=20 m · 8 px/m)
    expect(by).toBeLessThan(20 * 8);
  });

  it("destruido: aspa (dos líneas) y «KO», sin barra", () => {
    const { scene, log, labels } = sceneWith(2);
    scene.renderTags(frame(false), 0);
    expect(log.filter(([m]) => m === "tags.fillRect")).toHaveLength(0);
    expect(log.filter(([m]) => m === "markers.lineBetween").length).toBeGreaterThanOrEqual(2);
    expect(labels[0].text).toBe("A-ATK-1 KO");
  });

  it("reaparición: tras pasar de KO a vivo lleva anillo discontinuo y «REAPARECE»", () => {
    const { scene, log, labels } = sceneWith(2);
    scene.renderTags(frame(false), 0);
    log.length = 0;
    scene.renderTags(frame(true), 100);
    expect(log.filter(([m]) => m === "markers.arc").length).toBeGreaterThan(4);
    expect(labels[0].text).toBe("A-ATK-1 REAPARECE");
  });

  it("seleccionado: anillo extra + esquinas, y el porcentaje junto al nombre", () => {
    const { scene, log, labels } = sceneWith(2);
    scene.selectVehicle("v1");
    scene.renderTags(frame(), 0);
    expect(log.filter(([m]) => m === "markers.strokeCircle").length).toBeGreaterThanOrEqual(2);
    expect(log.filter(([m]) => m === "markers.lineBetween").length).toBe(8);
    expect(labels[0].text).toBe("A-ATK-1 25%");
  });
});

describe("escena: los botones de zoom parten del encuadre OBJETIVO, no del frame de tránsito", () => {
  it("pulsar «+» a mitad de una transición acerca desde el objetivo (×1.25)", () => {
    const { scene } = sceneWith(1);
    scene.world = { widthM: 120, heightM: 80 };
    scene.lastCamera = { centerX: 60, centerY: 40, zoom: 8 }; // aún en tránsito
    scene.lastGoal = { centerX: 30, centerY: 20, zoom: 16 }; // a donde va «Seguir …»
    scene.zoomIn();
    const m = scene.interaction.current;
    expect(m.kind).toBe("manual");
    expect(m.zoom).toBeCloseTo(20, 9);
  });
});
