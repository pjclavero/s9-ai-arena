/**
 * R16 · Slice 1 — Sprites y efectos básicos (torretas por chasis, fogonazo con
 * frame propio, secuencia de explosión).
 *
 * Regla de oro de la Ronda 2: nada de esto se puede pintar en jsdom (no hay
 * Phaser). Aquí sólo se prueba la LÓGICA pura que decide el arte:
 *  - geometría del atlas: los frames nuevos existen, caben en el lienzo y no
 *    se solapan con el resto (mismo contrato que R3.4/viewer-r34.test.ts);
 *  - selección de torreta por arquetipo (turretFrameForChassis), con el mismo
 *    criterio de fallback que bodyFrameForChassis;
 *  - selección de frame de explosión por edad (explosionFrameForAge): tramos
 *    correctos y frame ESTABLE al final del efecto.
 */
import { describe, expect, it } from "vitest";
import { chassisKind, turretFrameForChassis, explosionFrameForAge } from "../src/viewer/art-direction.js";
import { buildAtlasLayout, TURRET_FRAMES, EXPLOSION_FRAMES, MUZZLE_FLASH_FRAME } from "../src/viewer/atlas-geometry.js";
import { EffectSystem, effectProgress } from "../src/viewer/effects.js";

// ───────────────────────── atlas: frames nuevos, sin solapes, dentro del lienzo

describe("Atlas R16.1: torreta por arquetipo, fogonazo y explosión", () => {
  const layout = buildAtlasLayout();
  const names = layout.frames.map((f) => f.name);

  it("incluye las tres torretas, el fogonazo y la secuencia de explosión", () => {
    for (const n of [...TURRET_FRAMES, MUZZLE_FLASH_FRAME, ...EXPLOSION_FRAMES]) {
      expect(names, `falta el frame ${n}`).toContain(n);
    }
  });

  it("ya NO existe el frame único legado 'turret' (sustituido por los tres por arquetipo)", () => {
    expect(names).not.toContain("turret");
  });

  it("las tres torretas son frames distintos", () => {
    expect(new Set(TURRET_FRAMES).size).toBe(3);
  });

  it("los frames nuevos caben en el lienzo del atlas", () => {
    const nuevos = new Set<string>([...TURRET_FRAMES, MUZZLE_FLASH_FRAME, ...EXPLOSION_FRAMES]);
    for (const f of layout.frames) {
      if (!nuevos.has(f.name)) continue;
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(layout.width);
      expect(f.y + f.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("ningún par de frames del atlas se solapa (contrato de batcheo, R3.3)", () => {
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

  it("las tres fases de explosión comparten dimensiones de frame (sin salto de escala)", () => {
    const dims = EXPLOSION_FRAMES.map((n) => layout.frames.find((f) => f.name === n)!);
    expect(dims.every((f) => f.w === dims[0].w && f.h === dims[0].h)).toBe(true);
  });
});

// ───────────────────────── torreta por chasis

describe("turretFrameForChassis: una torreta DISTINTA por arquetipo", () => {
  it("cada arquetipo tiene su propia torreta", () => {
    expect(turretFrameForChassis("chassis.light@1")).toBe("turret-scout");
    expect(turretFrameForChassis("chassis.medium@1")).toBe("turret-gunner");
    expect(turretFrameForChassis("chassis.heavy@1")).toBe("turret-heavy");
  });

  it("cae al mismo arquetipo por defecto que bodyFrameForChassis (gunner) ante id ausente/desconocido", () => {
    expect(chassisKind(undefined)).toBe("gunner");
    expect(turretFrameForChassis(undefined)).toBe("turret-gunner");
    expect(turretFrameForChassis(null)).toBe("turret-gunner");
    expect(turretFrameForChassis("chassis.exotico@3")).toBe("turret-gunner");
  });

  it("todas las torretas devueltas existen en el atlas", () => {
    const names = buildAtlasLayout().frames.map((f) => f.name);
    for (const id of ["chassis.light@1", "chassis.medium@1", "chassis.heavy@1"]) {
      expect(names).toContain(turretFrameForChassis(id));
    }
  });
});

// ───────────────────────── explosión por edad

describe("explosionFrameForAge: secuencia por tramos de edad, estable al final", () => {
  it("recorre explosion-0 → explosion-1 → explosion-2 según la edad en ms", () => {
    expect(explosionFrameForAge(0)).toBe("explosion-0");
    expect(explosionFrameForAge(50)).toBe("explosion-0");
    expect(explosionFrameForAge(109)).toBe("explosion-0");
    expect(explosionFrameForAge(110)).toBe("explosion-1");
    expect(explosionFrameForAge(180)).toBe("explosion-1");
    expect(explosionFrameForAge(219)).toBe("explosion-1");
    expect(explosionFrameForAge(220)).toBe("explosion-2");
  });

  it("queda ESTABLE en explosion-2 para cualquier edad posterior (fin del efecto)", () => {
    expect(explosionFrameForAge(500)).toBe("explosion-2");
    expect(explosionFrameForAge(10_000)).toBe("explosion-2");
  });

  it("tolera edad negativa (reloj/orden de eventos irregular) sin lanzar", () => {
    expect(() => explosionFrameForAge(-5)).not.toThrow();
    expect(explosionFrameForAge(-5)).toBe("explosion-0");
  });
});

// ───────────────────────── ciclo de vida: fogonazo y explosión en EffectSystem

describe("EffectSystem R16.1: el fogonazo y la explosión nacen del evento y expiran", () => {
  it("un proyectil nuevo dispara un fogonazo con frame propio ('muzzle-flash'), y expira", () => {
    const fx = new EffectSystem();
    fx.ingestProjectiles([{ id: "p1", x: 10, y: 20 }], 0);
    const live = fx.active(0);
    expect(live).toHaveLength(1);
    expect(live[0].kind).toBe("muzzle_flash");
    expect(live[0].frame).toBe("muzzle-flash");
    expect(effectProgress(live[0], 0)).toBe(0);
    expect(fx.active(live[0].bornMs + live[0].lifeMs + 1)).toHaveLength(0);
  });

  it("vehicle_destroyed produce un núcleo de explosión con frame lógico 'explosion' (fase resuelta en el render)", () => {
    const fx = new EffectSystem();
    fx.ingestEvent({ kind: "vehicle_destroyed", position: { x: 5, y: 5 } }, 1000);
    const live = fx.active(1000);
    const core = live.find((e) => e.kind === "explosion" && e.frame === "explosion");
    expect(core).toBeDefined();
    // La explosión entera (núcleo + corona + humo) expira con el tiempo.
    const maxDeath = Math.max(...live.map((e) => e.bornMs + e.lifeMs));
    expect(fx.active(maxDeath + 1)).toHaveLength(0);
  });
});
