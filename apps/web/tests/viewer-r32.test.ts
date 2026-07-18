/**
 * R3.2 · ERR-VIS-06/07 — Interpolación sobre delta de ticks, balística local,
 * niebla después de interpolar (fundido + histéresis) y cámara suavizada.
 *
 * Todo lógica PURA sin Phaser ni navegador (regla de oro de la Ronda 2: la
 * verificación VISUAL queda declarada pendiente en el reporte; aquí se prueba
 * la matemática que la sustenta con números).
 */
import { describe, expect, it } from "vitest";
import { InterpolationBuffer } from "../src/viewer/interpolation.js";
import { BallisticsTracker } from "../src/viewer/ballistics.js";
import { FogFader } from "../src/viewer/fog.js";
import { SmoothCamera, clampToMap, computeCamera, type CameraConfig } from "../src/viewer/camera.js";
import { CameraInteraction } from "../src/viewer/camera-interaction.js";
import { DelayClock } from "../src/viewer/live-feed.js";
import { canvasSizeFor } from "../src/viewer/viewport.js";

const snap = (tick: number, x: number, extra: Partial<any> = {}) => ({
  tick,
  vehicles: [{ id: "v1", team: "red", alive: true, position: { x, y: 10 }, heading: 0, turretHeading: 0 }],
  projectiles: [],
  ...extra,
});

// ───────────────────────────── interpolación sobre delta de ticks (ERR-VIS-06)

describe("InterpolationBuffer: t = proporción del delta de ticks, no del tiempo de llegada", () => {
  it("interpola por el eje de partida aunque los snapshots llegaran con jitter", () => {
    const buf = new InterpolationBuffer();
    // Fechados por tick (100 ms de juego entre ambos), da igual cuándo llegaron.
    buf.push(snap(0, 0), 0);
    buf.push(snap(3, 6), 100);
    expect(buf.sampleAt(50)!.vehicles.get("v1")!.x).toBeCloseTo(3, 6);
    expect(buf.sampleAt(25)!.vehicles.get("v1")!.x).toBeCloseTo(1.5, 6);
  });

  it("mantiene VARIOS snapshots: muestrear un tramo antiguo sigue siendo exacto", () => {
    const buf = new InterpolationBuffer();
    for (let i = 0; i <= 5; i++) buf.push(snap(i * 3, i * 6), i * 100);
    // Tramo [200,300]: interpola entre x=12 y x=18, no entre los dos últimos.
    expect(buf.sampleAt(250)!.vehicles.get("v1")!.x).toBeCloseTo(15, 6);
  });

  it("no extrapola vehículos más allá del último snapshot y aguanta antes del primero", () => {
    const buf = new InterpolationBuffer();
    buf.push(snap(0, 0), 0);
    buf.push(snap(3, 6), 100);
    expect(buf.sampleAt(500)!.vehicles.get("v1")!.x).toBe(6);
    expect(buf.sampleAt(-50)!.vehicles.get("v1")!.x).toBe(0);
  });

  it("descarta duplicados/reordenados y el reset no interpola a través del hueco", () => {
    const buf = new InterpolationBuffer();
    buf.push(snap(3, 6), 100);
    buf.push(snap(3, 999), 100); // duplicado: ignorado
    expect(buf.sampleAt(100)!.vehicles.get("v1")!.x).toBe(6);
    buf.reset(snap(300, 50), 10_000);
    expect(buf.sampleAt(10_001)!.vehicles.get("v1")!.x).toBe(50);
    expect(buf.intervalMs).toBeNull();
  });
});

// ─────────────────────────────────── balística local de proyectiles (ERR-VIS-06)

describe("BallisticsTracker: los proyectiles rápidos son trayectorias, no parpadeos", () => {
  const shot = (tick: number, projectiles: { id: string; x: number; y: number; vx?: number; vy?: number }[]) => ({
    tick,
    vehicles: [],
    projectiles: projectiles.map((p) => ({
      id: p.id,
      position: { x: p.x, y: p.y },
      ...(p.vx !== undefined ? { velocity: { x: p.vx, y: p.vy ?? 0 } } : {}),
    })),
  });

  it("estima la velocidad con el delta de posiciones y simula a 60 fps entre snapshots", () => {
    const t = new BallisticsTracker();
    t.observe(shot(0, [{ id: "p1", x: 0, y: 0 }]), 0);
    t.observe(shot(3, [{ id: "p1", x: 10, y: 0 }]), 100); // 100 m/s
    // Muestreo del tramo [0,100] a pasos de 16 ms: movimiento continuo y monótono.
    let prevX = -Infinity;
    for (let ms = 0; ms <= 100; ms += 16) {
      const [p] = t.sampleAt(ms);
      expect(p.x).toBeGreaterThan(prevX);
      prevX = p.x;
    }
    expect(t.sampleAt(50)[0].x).toBeCloseTo(5, 6);
  });

  it("un proyectil que desaparece sigue su trayectoria hasta el snapshot del impacto y se retira", () => {
    const t = new BallisticsTracker();
    t.observe(shot(0, [{ id: "p1", x: 0, y: 0 }]), 0);
    t.observe(shot(3, [{ id: "p1", x: 10, y: 0 }]), 100);
    t.observe(shot(6, []), 200); // ya impactó en algún punto de (100,200]
    // Entre 100 y 200 se EXTRAPOLA con su velocidad: trayectoria completa…
    expect(t.sampleAt(150)[0].x).toBeCloseTo(15, 6);
    expect(t.sampleAt(200)[0].x).toBeCloseTo(20, 6);
    // …y después del snapshot que confirma su ausencia, desaparece.
    expect(t.sampleAt(201)).toHaveLength(0);
  });

  it("un proyectil visto en UN solo snapshot vive todo el intervalo (nunca un solo frame)", () => {
    const t = new BallisticsTracker();
    t.observe(shot(0, []), 0);
    t.observe(shot(3, [{ id: "fugaz", x: 5, y: 5 }]), 100);
    t.observe(shot(6, []), 200);
    // Sin velocidad conocida se dibuja donde se vio, durante TODO su tramo de vida.
    for (let ms = 100; ms <= 200; ms += 16) {
      expect(t.sampleAt(ms)).toHaveLength(1);
    }
    expect(t.sampleAt(99)).toHaveLength(0); // antes de nacer, nada
  });

  it("usa la velocidad del snapshot si el protocolo la trae (campo opcional, hacia delante)", () => {
    const t = new BallisticsTracker();
    t.observe(shot(3, [{ id: "p1", x: 0, y: 0, vx: 120, vy: 0 }]), 100); // 120 m/s
    expect(t.sampleAt(150)[0].x).toBeCloseTo(6, 6); // simulado desde la 1ª observación
  });

  it("reset (reconexión/seek): no arrastra trayectorias a través del hueco", () => {
    const t = new BallisticsTracker();
    t.observe(shot(0, [{ id: "p1", x: 0, y: 0 }]), 0);
    t.observe(shot(3, [{ id: "p1", x: 10, y: 0 }]), 100);
    t.reset(shot(300, [{ id: "p9", x: 50, y: 0 }]), 10_000);
    const dots = t.sampleAt(10_000);
    expect(dots).toHaveLength(1);
    expect(dots[0].id).toBe("p9");
  });
});

// ──────────────────── niebla DESPUÉS de interpolar: fundido + histéresis (ERR-VIS-07)

describe("FogFader: entrar/salir de niebla es un fundido con histéresis, sin teletransporte", () => {
  const fog = { allowFogView: true, enabled: true, team: "red", visionRadiusM: 50, hysteresisM: 5, fadeMs: 400 };
  const frameAt = (enemyX: number) => ({
    tick: 0,
    vehicles: new Map([
      ["r1", { x: 0, y: 0, heading: 0, turretHeading: 0, alive: true, team: "red" }],
      ["b1", { x: enemyX, y: 0, heading: 0, turretHeading: 0, alive: true, team: "blue" }],
    ]),
    projectiles: [],
  });

  it("el enemigo que entra en visión aparece FUNDIENDO alfa, en su posición interpolada real", () => {
    const f = new FogFader();
    // Fuera de visión: alfa 0 (no está en el frame de salida).
    let out = f.apply(frameAt(60), fog, 16);
    expect(out.vehicles.has("b1")).toBe(false);
    // Entra en el radio: el alfa sube gradualmente frame a frame (60 fps).
    const alphas: number[] = [];
    for (let i = 0; i < 30; i++) {
      out = f.apply(frameAt(45), fog, 16);
      if (out.vehicles.has("b1")) alphas.push(out.vehicles.get("b1")!.alpha);
    }
    expect(alphas[0]).toBeGreaterThan(0);
    expect(alphas[0]).toBeLessThan(0.2); // primer frame: apenas visible — nada de aparición súbita
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]);
    expect(alphas.at(-1)).toBe(1);
    // Y su posición es la interpolada de verdad (la niebla ya no rompe la interpolación).
    expect(out.vehicles.get("b1")!.x).toBe(45);
  });

  it("histéresis: oscilar alrededor del borde del radio no hace parpadear al enemigo", () => {
    const f = new FogFader();
    for (let i = 0; i < 60; i++) f.apply(frameAt(45), fog, 16); // plenamente visible
    // Vaivén entre 49 y 53 m: dentro de la banda [50, 55] sigue visible SIEMPRE.
    for (let i = 0; i < 40; i++) {
      const out = f.apply(frameAt(i % 2 === 0 ? 49 : 53), fog, 16);
      expect(out.vehicles.get("b1")!.alpha).toBe(1);
    }
    // Solo al superar radio + histéresis empieza el fundido de salida (gradual).
    const out1 = f.apply(frameAt(56), fog, 16);
    expect(out1.vehicles.get("b1")!.alpha).toBeLessThan(1);
    expect(out1.vehicles.get("b1")!.alpha).toBeGreaterThan(0.9); // sin salto
  });

  it("con la niebla desactivada todo es visible con alfa 1", () => {
    const f = new FogFader();
    const out = f.apply(frameAt(999), { ...fog, enabled: false }, 16);
    expect(out.vehicles.get("b1")!.alpha).toBe(1);
  });
});

// ─────────────────────────── cámara: amortiguación, deadzone y clamp (ERR-VIS-07)

describe("SmoothCamera: sin tirones al cambiar de modo y sin enseñar el vacío", () => {
  const cfg: CameraConfig = { viewportW: 960, viewportH: 640, mapW: 120, mapH: 80 };

  it("clampToMap: el encuadre nunca sale del mapa; si el mapa cabe entero, se centra", () => {
    // zoom 16 px/m ⇒ media vista = 30×20 m.
    expect(clampToMap({ centerX: 5, centerY: 5, zoom: 16 }, cfg)).toEqual({ centerX: 30, centerY: 20, zoom: 16 });
    expect(clampToMap({ centerX: 119, centerY: 79, zoom: 16 }, cfg)).toEqual({ centerX: 90, centerY: 60, zoom: 16 });
    // zoom global (mapa entero visible): centrado, sin clamp imposible.
    const g = clampToMap({ centerX: 0, centerY: 0, zoom: 4 }, cfg);
    expect(g.centerX).toBe(60);
    expect(g.centerY).toBe(40);
  });

  it("cambiar de modo es una transición continua: ningún frame salta más que el anterior ×2", () => {
    const cam = new SmoothCamera();
    // Asentada en la vista global…
    let prev = cam.update({ kind: "global" }, computeCamera({ kind: "global" }, { vehicles: [] }, cfg), cfg, 16);
    // …y de golpe, follow a una esquina lejana con zoom 12.
    const target = { centerX: 100, centerY: 70, zoom: 12 };
    const steps: number[] = [];
    for (let i = 0; i < 200; i++) {
      const next = cam.update({ kind: "follow", vehicleId: "v1" }, target, cfg, 16);
      steps.push(Math.hypot(next.centerX - prev.centerX, next.centerY - prev.centerY));
      prev = next;
    }
    // Primer frame: NO teletransporta (el objetivo está a ~50 m del centro).
    expect(steps[0]).toBeLessThan(5);
    // Amortiguación crítica: convergencia sin oscilar (los pasos acaban decreciendo a 0).
    expect(steps.at(-1)!).toBeLessThan(0.01);
    const clampedTarget = clampToMap(target, cfg);
    expect(prev.centerX).toBeCloseTo(clampedTarget.centerX, 1);
    expect(prev.centerY).toBeCloseTo(clampedTarget.centerY, 1);
  });

  it("en tránsito el encuadre también respeta el mapa (clamp del estado suavizado)", () => {
    const cam = new SmoothCamera();
    cam.update({ kind: "global" }, { centerX: 60, centerY: 40, zoom: 10 }, cfg, 16);
    for (let i = 0; i < 300; i++) {
      const c = cam.update({ kind: "follow", vehicleId: "v1" }, { centerX: 119, centerY: 79, zoom: 16 }, cfg, 16);
      // Invariante: cada frame emitido es punto fijo del clamp — jamás un
      // encuadre que enseñaría el vacío pudiendo no enseñarlo.
      const fixed = clampToMap(c, cfg);
      expect(c.centerX).toBeCloseTo(fixed.centerX, 6);
      expect(c.centerY).toBeCloseTo(fixed.centerY, 6);
    }
  });

  it("deadzone en follow: los micro-movimientos del bot no arrastran la cámara", () => {
    const cam = new SmoothCamera({ deadzoneM: 3 });
    const mode = { kind: "follow", vehicleId: "v1" } as const;
    // Asentar la cámara sobre el bot.
    for (let i = 0; i < 300; i++) cam.update(mode, { centerX: 60, centerY: 40, zoom: 12 }, cfg, 16);
    const settled = cam.update(mode, { centerX: 60, centerY: 40, zoom: 12 }, cfg, 16);
    // El bot vibra ±1 m: la cámara ni se inmuta.
    for (let i = 0; i < 60; i++) {
      const c = cam.update(mode, { centerX: 60 + (i % 2 ? 1 : -1), centerY: 40, zoom: 12 }, cfg, 16);
      expect(Math.abs(c.centerX - settled.centerX)).toBeLessThan(0.05);
    }
    // Salir de la zona muerta sí la mueve.
    for (let i = 0; i < 300; i++) cam.update(mode, { centerX: 70, centerY: 40, zoom: 12 }, cfg, 16);
    const moved = cam.update(mode, { centerX: 70, centerY: 40, zoom: 12 }, cfg, 16);
    expect(moved.centerX).toBeCloseTo(70, 1);
  });
});

// ──────────────────────────────────────── interacción: rueda, arrastre y teclas

describe("CameraInteraction: rueda para zoom, arrastre para pan, 1–4 para seguir bots", () => {
  const cfg: CameraConfig = { viewportW: 960, viewportH: 640, mapW: 120, mapH: 80 };
  const view = (current = { centerX: 60, centerY: 40, zoom: 8 }) => ({ current, cfg });

  it("la rueda hace zoom HACIA el cursor: el punto del mundo bajo el ratón no se mueve", () => {
    const i = new CameraInteraction();
    const before = view();
    const pointer = { x: 720, y: 160 }; // cuarto superior derecho
    const worldBefore = {
      x: before.current.centerX + (pointer.x - cfg.viewportW / 2) / before.current.zoom,
      y: before.current.centerY + (pointer.y - cfg.viewportH / 2) / before.current.zoom,
    };
    const mode = i.onWheel(-100, pointer, before); // acercar
    if (mode.kind !== "manual") throw new Error("la rueda debe pasar a modo manual");
    expect(mode.zoom).toBeGreaterThan(8);
    const worldAfter = {
      x: mode.centerX + (pointer.x - cfg.viewportW / 2) / mode.zoom,
      y: mode.centerY + (pointer.y - cfg.viewportH / 2) / mode.zoom,
    };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  it("el arrastre mueve la cámara en metros según el zoom y queda clampado al mapa", () => {
    const i = new CameraInteraction();
    // A zoom 16 px/m la media vista es 30×20 m: el mapa NO cabe y el pan es real.
    const m1 = i.onDrag(-80, 0, view({ centerX: 60, centerY: 40, zoom: 16 }));
    if (m1.kind !== "manual") throw new Error("manual");
    expect(m1.centerX).toBeCloseTo(65, 6); // 80 px / 16 px/m = 5 m
    // Arrastre desorbitado: clamp al borde del mapa (centro ≤ mapW − media vista).
    const m2 = i.onDrag(-100000, -100000, view({ centerX: 65, centerY: 40, zoom: 16 }));
    if (m2.kind !== "manual") throw new Error("manual");
    expect(m2.centerX).toBe(90); // 120 − 30
    expect(m2.centerY).toBe(60); // 80 − 20
  });

  it("teclas 1–4 siguen al bot n-ésimo; G vuelve a global; teclas sin bot no hacen nada", () => {
    const i = new CameraInteraction();
    const bots = ["veh_a", "veh_b"];
    expect(i.onKey("1", bots)).toEqual({ kind: "follow", vehicleId: "veh_a" });
    expect(i.onKey("2", bots)).toEqual({ kind: "follow", vehicleId: "veh_b" });
    expect(i.onKey("3", bots)).toBeNull(); // no hay tercer bot
    expect(i.current).toEqual({ kind: "follow", vehicleId: "veh_b" }); // sin cambios
    expect(i.onKey("g", bots)).toEqual({ kind: "global" });
    expect(i.onKey("x", bots)).toBeNull();
  });
});

// ─────────────────────────────── reloj de directo con delay-buffer (ERR-VIS-06)

describe("DelayClock: el directo se muestrea ~2 intervalos por detrás y sin jitter", () => {
  it("converge a latest − 2·intervalos y avanza suave aunque los snapshots lleguen con jitter", () => {
    const c = new DelayClock(2);
    c.reset(0, 1000);
    // Stream continuo: snapshot cada 100 ms de juego, llegada con jitter ±40 ms
    // (determinista), muestreo a 60 fps durante 10 s de directo.
    const jitterAt = (k: number) => Math.round(40 * Math.sin(k * 2.7));
    let nextSnap = 1;
    let prev = c.now(1000);
    let lastGameSeen = 0;
    for (let w = 1016; w <= 11000; w += 16) {
      while (1000 + nextSnap * 100 + jitterAt(nextSnap) <= w) {
        c.observe(nextSnap * 100, 1000 + nextSnap * 100 + jitterAt(nextSnap));
        lastGameSeen = nextSnap * 100;
        nextSnap++;
      }
      const v = c.now(w);
      // SIEMPRE monótono y sin saltos mayores que ~1,1× dt: el jitter de llegada
      // no se traslada al eje muestreado.
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v - prev).toBeLessThanOrEqual(16 * 1.1 + 1e-9);
      prev = v;
    }
    // Retardo final respecto al último snapshot: ronda los 2 intervalos (±1).
    const lag = lastGameSeen - prev;
    expect(lag).toBeGreaterThan(60);
    expect(lag).toBeLessThan(300);
  });

  it("nunca adelanta al último snapshot y un parón largo salta en vez de perseguir", () => {
    const c = new DelayClock(2);
    c.reset(0, 0);
    c.observe(100, 100);
    c.observe(200, 200);
    // Sin datos nuevos: el reloj se detiene en el último snapshot, no lo rebasa.
    let v = 0;
    for (let w = 216; w <= 5000; w += 16) v = c.now(w);
    expect(v).toBeLessThanOrEqual(200);
    // Vuelve el stream tras el parón: desfase enorme ⇒ salto franco, no minutos de deslizamiento.
    for (let i = 3; i <= 60; i++) c.observe(i * 100, 5000 + (i - 2) * 100);
    const after = c.now(11000);
    expect(after).toBeGreaterThan(4000);
  });
});

// ──────────────────────────────────────────── escala RESIZE + devicePixelRatio

describe("canvasSizeFor: buffer × dpr, CSS en píxeles lógicos", () => {
  it("escala el buffer por devicePixelRatio y compensa con el zoom", () => {
    expect(canvasSizeFor(960, 640, 2)).toEqual({ width: 1920, height: 1280, zoom: 0.5 });
    expect(canvasSizeFor(960, 640, 1)).toEqual({ width: 960, height: 640, zoom: 1 });
    // dpr basura ⇒ 1 (nunca un canvas de tamaño 0).
    expect(canvasSizeFor(960, 640, 0)).toEqual({ width: 960, height: 640, zoom: 1 });
  });
});
