/**
 * R3.3 · ERR-VIS-09/11 — Rendimiento del front y medición.
 *
 * Lógica PURA testeable sin Phaser ni navegador (regla de oro de la Ronda 2: la
 * verificación VISUAL/60fps queda declarada pendiente para la prueba Playwright
 * de CI; aquí se prueba lo medible con números):
 *  - el tick del replay se publica a ~4 Hz, no a 60 fps (throttling);
 *  - el pool de proyectiles tiene techo;
 *  - el camino caliente (interpolación + snapshot de cámara) REUTILIZA sus
 *    objetos: cero asignaciones por frame (probado por identidad de referencia);
 *  - la medición (FPS + draw calls) cuenta lo que dice contar.
 */
import { describe, expect, it, vi } from "vitest";
import { UiThrottle, ReplayTickPublisher, UI_PUBLISH_INTERVAL_MS } from "../src/viewer/ui-throttle.js";
import { visibleProjectileCount, MAX_PROJECTILE_SPRITES } from "../src/viewer/render-pools.js";
import { CameraSnapshotScratch } from "../src/viewer/camera-snapshot.js";
import { InterpolationBuffer } from "../src/viewer/interpolation.js";
import { FpsMeter, DrawCallCounter, instrumentWebGL, type GLLike } from "../src/viewer/render-stats.js";

// ─────────────────────────────── throttling del tick (ERR-VIS-11)

describe("UiThrottle: publica como mucho una vez por intervalo", () => {
  it("emite en la primera llamada y luego respeta el intervalo", () => {
    const th = new UiThrottle(250);
    expect(th.shouldEmit(0)).toBe(true); // primera siempre
    expect(th.shouldEmit(100)).toBe(false); // dentro del intervalo
    expect(th.shouldEmit(249)).toBe(false);
    expect(th.shouldEmit(250)).toBe(true); // justo al cerrar el intervalo
    expect(th.shouldEmit(300)).toBe(false);
    expect(th.shouldEmit(500)).toBe(true);
  });

  it("reset fuerza la próxima emisión", () => {
    const th = new UiThrottle(250);
    th.shouldEmit(0);
    expect(th.shouldEmit(10)).toBe(false);
    th.reset();
    expect(th.shouldEmit(10)).toBe(true);
  });
});

describe("ReplayTickPublisher: 60 fps entran, ~4 Hz salen", () => {
  it("de 60 frames en 1 s a ~4 Hz sólo publica un puñado de veces", () => {
    const emitted: number[] = [];
    const pub = new ReplayTickPublisher((t) => emitted.push(t), 250);
    // 60 frames a lo largo de 1000 ms (16,66 ms/frame): lo que hacía React a 60 fps.
    for (let i = 0; i < 60; i++) pub.onFrame(i * (1000 / 60), i);
    // A 4 Hz en 1 s: primera + ~4 => 5 publicaciones como mucho, no 60.
    expect(emitted.length).toBeLessThanOrEqual(5);
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    expect(emitted[0]).toBe(0); // arranca publicando
  });

  it("finished publica SIEMPRE el estado final aunque caiga a medio intervalo", () => {
    const emitted: number[] = [];
    const pub = new ReplayTickPublisher((t) => emitted.push(t), 250);
    pub.onFrame(0, 0); // publica
    pub.onFrame(10, 1); // throttled
    pub.onFrame(20, 999, true); // finished: publica pese al throttle
    expect(emitted).toEqual([0, 999]);
  });

  it("force publica al instante (aterrizaje tras seek)", () => {
    const emitted: number[] = [];
    const pub = new ReplayTickPublisher((t) => emitted.push(t), 250);
    pub.onFrame(0, 0);
    pub.force(10, 42); // seek: la UI salta ya
    expect(emitted).toEqual([0, 42]);
  });

  it("el intervalo por defecto es ~4 Hz", () => {
    expect(UI_PUBLISH_INTERVAL_MS).toBe(250);
  });
});

// ─────────────────────────────── techo del pool de proyectiles (ERR-VIS-09)

describe("visibleProjectileCount: el pool no crece sin límite", () => {
  it("respeta el techo por defecto", () => {
    expect(visibleProjectileCount(10)).toBe(10);
    expect(visibleProjectileCount(MAX_PROJECTILE_SPRITES)).toBe(MAX_PROJECTILE_SPRITES);
    expect(visibleProjectileCount(MAX_PROJECTILE_SPRITES + 1000)).toBe(MAX_PROJECTILE_SPRITES);
  });

  it("un snapshot hostil con millones de proyectiles queda capado", () => {
    expect(visibleProjectileCount(5_000_000, 256)).toBe(256);
  });

  it("nunca es negativo ni fraccional", () => {
    expect(visibleProjectileCount(-5)).toBe(0);
    expect(visibleProjectileCount(3.9)).toBe(3);
    expect(visibleProjectileCount(Number.NaN)).toBe(0);
  });
});

// ─────────────── camino caliente sin allocs: snapshot de cámara (ERR-VIS-09)

describe("CameraSnapshotScratch: reutiliza sus objetos (cero allocs por frame)", () => {
  const pose = (x: number, y: number, alive = true, team?: string) => ({ x, y, alive, team });

  it("rellena valores correctos resolviendo el equipo cuando falta", () => {
    const sc = new CameraSnapshotScratch();
    const vehicles = new Map([
      ["v1", pose(1, 2, true, "red")],
      ["v2", pose(3, 4, false)], // sin team: lo resuelve teamOf
    ]);
    const out = sc.fill(vehicles, (id) => (id === "v2" ? "blue" : undefined));
    expect(out.vehicles).toHaveLength(2);
    expect(out.vehicles[0]).toMatchObject({ id: "v1", team: "red", alive: true, position: { x: 1, y: 2 } });
    expect(out.vehicles[1]).toMatchObject({ id: "v2", team: "blue", alive: false, position: { x: 3, y: 4 } });
  });

  it("devuelve el MISMO array y los MISMOS objetos entre frames (identidad estable)", () => {
    const sc = new CameraSnapshotScratch();
    const vehicles = new Map([["v1", pose(0, 0)]]);
    const a = sc.fill(vehicles, () => "red");
    const arr = a.vehicles;
    const v1 = a.vehicles[0];
    const pos1 = a.vehicles[0].position;
    vehicles.get("v1")!.x = 99;
    const b = sc.fill(vehicles, () => "red");
    expect(b.vehicles).toBe(arr); // no se asignó un array nuevo
    expect(b.vehicles[0]).toBe(v1); // ni un objeto de vehículo nuevo
    expect(b.vehicles[0].position).toBe(pos1); // ni un objeto de posición nuevo
    expect(b.vehicles[0].position.x).toBe(99); // pero los valores se actualizaron
  });

  it("al menguar la lista recorta la longitud sin dejar restos", () => {
    const sc = new CameraSnapshotScratch();
    sc.fill(
      new Map([
        ["v1", pose(0, 0)],
        ["v2", pose(1, 1)],
      ]),
      () => "red",
    );
    const out = sc.fill(new Map([["v1", pose(0, 0)]]), () => "red");
    expect(out.vehicles).toHaveLength(1);
    expect(out.vehicles[0].id).toBe("v1");
  });
});

// ─────────── camino caliente sin allocs: frame interpolado (ERR-VIS-09)

describe("InterpolationBuffer: sampleAt reutiliza el frame (FrameScratch)", () => {
  const snap = (tick: number, x: number) => ({
    tick,
    vehicles: [{ id: "v1", team: "red", alive: true, position: { x, y: 0 }, heading: 0, turretHeading: 0 }],
    projectiles: [{ id: "p1", position: { x, y: 0 } }],
  });

  it("dos muestreos consecutivos devuelven el MISMO objeto de frame y el MISMO Map", () => {
    const buf = new InterpolationBuffer();
    buf.push(snap(0, 0), 0);
    buf.push(snap(3, 6), 100);
    const a = buf.sampleAt(25)!;
    const map = a.vehicles;
    const projArr = a.projectiles;
    const b = buf.sampleAt(75)!;
    expect(b).toBe(a); // frame reutilizado
    expect(b.vehicles).toBe(map); // Map de vehículos reutilizado
    expect(b.projectiles).toBe(projArr); // array de proyectiles reutilizado
    // Y sigue interpolando correcto pese a reutilizar (x=1.5 en t=25, x=4.5 en t=75).
    expect(b.vehicles.get("v1")!.x).toBeCloseTo(4.5, 6);
  });

  it("reutiliza también el objeto de pose por id entre frames", () => {
    const buf = new InterpolationBuffer();
    buf.push(snap(0, 0), 0);
    buf.push(snap(3, 6), 100);
    const p1 = buf.sampleAt(25)!.vehicles.get("v1");
    const p2 = buf.sampleAt(75)!.vehicles.get("v1");
    expect(p2).toBe(p1);
  });
});

// ─────────────────────────────── medición: FPS y draw calls (ERR-VIS-11)

describe("FpsMeter: fps medios y peor hueco de la ventana", () => {
  it("null hasta tener 2 frames; luego fps medios de la ventana", () => {
    const m = new FpsMeter(2000);
    expect(m.fps).toBeNull();
    m.frame(0);
    expect(m.fps).toBeNull();
    // 60 fps exactos: un frame cada 16,66 ms.
    for (let i = 1; i <= 10; i++) m.frame(i * (1000 / 60));
    expect(m.fps).toBeCloseTo(60, 0);
  });

  it("worstFrameMs delata el peor stall de la ventana", () => {
    const m = new FpsMeter(10_000);
    m.frame(0);
    m.frame(16);
    m.frame(16 + 120); // un stall de 120 ms
    m.frame(16 + 120 + 16);
    expect(m.worstFrameMs).toBe(120);
  });

  it("purga por el frente: los frames fuera de la ventana no cuentan", () => {
    const m = new FpsMeter(100);
    m.frame(0);
    m.frame(1000); // muy fuera de la ventana de 100 ms
    m.frame(1016);
    m.frame(1032);
    // La ventana quedó en [1000..1032], ~3 frames en 32 ms.
    expect(m.fps!).toBeGreaterThan(50);
  });
});

describe("DrawCallCounter + instrumentWebGL: cuenta las llamadas reales", () => {
  it("cuenta drawElements/drawArrays por frame y cierra el frame", () => {
    const counter = new DrawCallCounter();
    expect(counter.lastFrame).toBeNull(); // fail-closed hasta cerrar el primer frame
    let realElements = 0;
    let realArrays = 0;
    const gl: GLLike = {
      drawElements: () => realElements++,
      drawArrays: () => realArrays++,
    };
    const restore = instrumentWebGL(gl, counter);
    counter.beginFrame();
    gl.drawElements();
    gl.drawElements();
    gl.drawArrays();
    counter.endFrame();
    expect(counter.lastFrame).toBe(3);
    // El envoltorio no rompe la llamada real subyacente.
    expect(realElements).toBe(2);
    expect(realArrays).toBe(1);
    // El siguiente frame parte de cero.
    counter.beginFrame();
    gl.drawArrays();
    counter.endFrame();
    expect(counter.lastFrame).toBe(1);
    restore();
  });

  it("restore devuelve el contexto original (deja de contar)", () => {
    const counter = new DrawCallCounter();
    const spy = vi.fn();
    const gl: GLLike = { drawElements: spy, drawArrays: () => {} };
    const restore = instrumentWebGL(gl, counter);
    restore();
    counter.beginFrame();
    gl.drawElements();
    counter.endFrame();
    expect(counter.lastFrame).toBe(0); // ya no cuenta
    expect(gl.drawElements).toBe(spy); // referencia original restaurada
  });
});
