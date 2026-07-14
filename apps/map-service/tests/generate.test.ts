/**
 * T4.4 · Generador procedural: determinismo por semilla, tasa de éxito, simetría CTF,
 * y que ningún mapa se publique sin pasar el validador de T4.2.
 */
import { describe, expect, it } from "vitest";
import { generateMap } from "../src/generate/index.js";
import { validateMap, isPublishable } from "../src/validate/index.js";
import { computeChecksum } from "../src/canonical.js";
import { MapService } from "../src/service.js";
import { Rng } from "../../arena-engine/src/rng.js";

const PARAMS = { widthM: 120, heightM: 80, mode: "capture_the_flag" as const, wallDensity: 0.5 };

describe("T4.4 · determinismo por semilla", () => {
  it("misma semilla+params ⇒ mismo checksum en 100 ejecuciones", () => {
    const first = generateMap(PARAMS, "seed-det").map.checksum;
    for (let i = 0; i < 100; i++) {
      expect(generateMap(PARAMS, "seed-det").map.checksum).toBe(first);
    }
  });

  it("semillas distintas ⇒ mapas distintos (casi siempre)", () => {
    const a = generateMap(PARAMS, "seed-a").map.checksum;
    const b = generateMap(PARAMS, "seed-b").map.checksum;
    expect(a).not.toBe(b);
  });

  it("el checksum declarado del mapa generado se verifica sobre su contenido", () => {
    const { map } = generateMap(PARAMS, "seed-verify");
    expect(map.checksum).toBe(computeChecksum(map));
  });
});

describe("T4.4 · validez", () => {
  it("todo mapa devuelto como válido pasa realmente el validador de T4.2", () => {
    const { map } = generateMap(PARAMS, "seed-valid");
    expect(isPublishable(validateMap(map))).toBe(true);
  });

  it("de 100 semillas (reproducibles con Rng maestro), >=90 producen un mapa válido en <=2 intentos", () => {
    const master = new Rng("balance-master-seed");
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const seed = `s${master.nextUint32()}`;
      const res = generateMap(PARAMS, seed);
      if (res.attempts <= 2 && isPublishable(validateMap(res.map))) ok++;
    }
    console.log(`Generador: ${ok}/100 mapas válidos en <=2 intentos`);
    expect(ok).toBeGreaterThanOrEqual(90);
  });

  it("ningún mapa generado se publica sin pasar el validador (el servicio lo impide)", () => {
    const svc = new MapService();
    const { map } = generateMap(PARAMS, "seed-service");
    const rec = svc.importMap(map);
    const pub = svc.publishMap(rec.mapId, rec.version);
    expect(pub.status).toBe("published");
  });
});

describe("T4.4 · simetría especular CTF", () => {
  it("la diferencia de distancia base->base entre lados es exactamente 0", () => {
    const { map } = generateMap(PARAMS, "seed-sym");
    const bases = map.layers.bases!;
    const red = bases.find((b) => b.team === "red")!.position!;
    const blue = bases.find((b) => b.team === "blue")!.position!;
    const cx = map.widthM / 2;
    // Por construcción especular: red.x + blue.x == widthM y misma y.
    expect(red.x + blue.x).toBe(map.widthM);
    expect(red.y).toBe(blue.y);
    // Distancia de cada base al eje central: idéntica (diferencia exactamente 0).
    expect(Math.abs(cx - red.x)).toBe(Math.abs(blue.x - cx));
  });
});
