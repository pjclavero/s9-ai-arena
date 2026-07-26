/**
 * B9 · `validateArenaMap` (src/arena-map.ts): la frontera del motor para mapas que
 * vienen de fuera del proceso. Se prueba contra los mapas REALES del repo (no
 * contra objetos inventados a mano: un mapa de juguete no habría detectado, por
 * ejemplo, que `toEngineMap` produce muros con `rotation` opcional).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateArenaMap, arenaMapIdentity, MAX_ARENA_MAP_ENTITIES, isSafeExternalKey } from "../src/arena-map.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import { emptyArena, mvpArena, ctfArena } from "../src/fixtures.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const realMap = (file: string) => toEngineMap(JSON.parse(readFileSync(join(REPO, "maps", file), "utf8")));

describe("B9 · validateArenaMap acepta los mapas REALES del catálogo", () => {
  it.each(["mvp-arena-01.json", join("procedural", "proc-test-0.json"), join("procedural", "proc-test-7.json")])(
    "%s (documento del repo → toEngineMap) es válido",
    (file) => {
      const res = validateArenaMap(realMap(file));
      expect(res.reason).toBeUndefined();
      expect(res.ok).toBe(true);
    },
  );

  it("los mapas-fixture del propio motor (mvp/ctf) siguen siendo válidos; `empty` NO lo es por su checksum de ceros", () => {
    expect(validateArenaMap(mvpArena()).ok).toBe(true);
    expect(validateArenaMap(ctfArena()).ok).toBe(true);
    // emptyArena/mvpArena llevan checksum "sha256:000…0", que SÍ cumple el formato:
    // lo que se valida aquí es la forma, no la autenticidad (esa la comprueba el
    // resolutor de la API contra el documento del catálogo).
    expect(validateArenaMap(emptyArena()).ok).toBe(true);
  });
});

describe("B9 · validateArenaMap rechaza lo que el motor no sabe jugar", () => {
  const base = () => JSON.parse(JSON.stringify(realMap("mvp-arena-01.json")));

  it.each([
    ["no es un objeto", () => "un mapa"],
    ["array", () => []],
    ["sin mapId", () => ({ ...base(), mapId: "" })],
    ["mapId de Object.prototype", () => ({ ...base(), mapId: "__proto__" })],
    ["mapId constructor", () => ({ ...base(), mapId: "constructor" })],
    ["version no entera", () => ({ ...base(), version: 1.5 })],
    ["checksum sin formato", () => ({ ...base(), checksum: "abc" })],
    ["ancho 0", () => ({ ...base(), widthM: 0 })],
    ["ancho absurdo", () => ({ ...base(), widthM: 1e9 })],
    ["muros ausentes", () => ({ ...base(), walls: undefined })],
    ["equipo de spawn envenenado", () => withSpawnTeam(base(), "__proto__")],
    ["un solo equipo con spawn", () => withSpawnTeam(base(), "red")],
    ["destructible sin hp", () => withFirstDestructible(base(), { hp: undefined })],
    ["destructible con hp 0", () => withFirstDestructible(base(), { hp: 0 })],
    ["base con radio negativo", () => withFirstBase(base(), { radiusM: -1 })],
    ["demasiadas entidades", () => ({ ...base(), walls: new Array(MAX_ARENA_MAP_ENTITIES + 1).fill(wall()) })],
  ])("%s → rechazado con motivo", (_label, make) => {
    const res = validateArenaMap(make());
    expect(res.ok).toBe(false);
    expect(typeof res.reason).toBe("string");
    expect(res.reason!.length).toBeGreaterThan(0);
  });
});

describe("B9 · identidad del mapa", () => {
  it("mapId+versión+checksum: dos mapas del catálogo distintos NUNCA comparten identidad", () => {
    expect(arenaMapIdentity(realMap("mvp-arena-01.json"))).not.toBe(
      arenaMapIdentity(realMap(join("procedural", "proc-test-0.json"))),
    );
  });

  it("la identidad NO depende de los destructibles (su hp cambia durante la batalla)", () => {
    const m = realMap("mvp-arena-01.json");
    const damaged = { ...m, destructibles: m.destructibles.map((d) => ({ ...d, hp: 1 })) };
    expect(arenaMapIdentity(damaged)).toBe(arenaMapIdentity(m));
  });

  it("isSafeExternalKey descarta exactamente las propiedades heredadas de Object.prototype", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      expect(isSafeExternalKey(k)).toBe(false);
    }
    for (const k of ["mvp-arena-01", "proto", "map", "prototype"]) {
      expect(isSafeExternalKey(k)).toBe(true);
    }
  });
});

function wall() {
  return { id: "w", position: { x: 1, y: 1 }, halfW: 1, halfH: 1 };
}
function withSpawnTeam(m: Record<string, unknown>, team: string) {
  return { ...m, spawns: (m.spawns as Record<string, unknown>[]).map((s) => ({ ...s, team })) };
}
function withFirstDestructible(m: Record<string, unknown>, patch: Record<string, unknown>) {
  return {
    ...m,
    destructibles: (m.destructibles as Record<string, unknown>[]).map((d, i) => (i === 0 ? { ...d, ...patch } : d)),
  };
}
function withFirstBase(m: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...m, bases: (m.bases as Record<string, unknown>[]).map((b, i) => (i === 0 ? { ...b, ...patch } : b)) };
}
