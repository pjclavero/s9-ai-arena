/**
 * Mapas de apoyo para los tests del servicio y del generador. `sampleValidMap` es un
 * mapa CTF simétrico bien diseñado (dos corredores en el muro central) que debe pasar
 * el validador de T4.2; `brokenNoRouteMap` tiene un muro central MACIZO de lado a lado
 * sin corredores, así que ningún chasis tiene ruta al otro lado (debe fallar T4.2).
 */
import { withChecksum } from "../src/canonical.js";
import type { InternalMap, MapWithoutChecksum } from "../src/types.js";

const MATERIALS: InternalMap["materials"] = [
  { id: "floor", name: "Suelo", blocksMovement: false, blocksVision: false },
  { id: "concrete", name: "Hormigón", blocksMovement: true, blocksVision: true },
  { id: "crate", name: "Caja", blocksMovement: true, blocksVision: true, hp: 120 },
];

const META: InternalMap["meta"] = {
  name: "Fixture CTF",
  author: "E4",
  license: "CC-BY-4.0",
  supportedModes: ["capture_the_flag", "team_deathmatch"],
  supportedChassisSizes: ["light", "medium", "heavy"],
  maxDestructibles: 64,
  destructiblesMayBlockOnlyRoute: false,
};

function ground(widthM: number, heightM: number): InternalMap["layers"]["ground"] {
  const cols = Math.round(widthM / 2);
  const rows = Math.round(heightM / 2);
  return { tileSizeM: 2, cols, rows, data: new Array(cols * rows).fill(0) };
}

function symmetricObjectives(widthM: number, heightM: number) {
  const midY = heightM / 2;
  return {
    spawns: [
      { objectId: "sp_red_1", team: "red", position: { x: 10, y: midY - 6 }, heading: 0 },
      { objectId: "sp_red_2", team: "red", position: { x: 10, y: midY + 6 }, heading: 0 },
      { objectId: "sp_blue_1", team: "blue", position: { x: widthM - 10, y: midY - 6 }, heading: Math.PI },
      { objectId: "sp_blue_2", team: "blue", position: { x: widthM - 10, y: midY + 6 }, heading: Math.PI },
    ],
    bases: [
      {
        objectId: "base_red",
        team: "red",
        shape: "rect" as const,
        position: { x: 8, y: midY },
        widthM: 8,
        heightM: 12,
      },
      {
        objectId: "base_blue",
        team: "blue",
        shape: "rect" as const,
        position: { x: widthM - 8, y: midY },
        widthM: 8,
        heightM: 12,
      },
    ],
    flags: [
      { objectId: "flag_red", team: "red", position: { x: 8, y: midY } },
      { objectId: "flag_blue", team: "blue", position: { x: widthM - 8, y: midY } },
    ],
  };
}

export function sampleValidMap(overrides: Partial<MapWithoutChecksum> = {}): InternalMap {
  const widthM = 120,
    heightM = 80,
    cx = 60;
  const armLen = 24;
  const obj = symmetricObjectives(widthM, heightM);
  return withChecksum({
    schemaVersion: 1,
    mapId: "fixture-valid",
    version: 1,
    widthM,
    heightM,
    navCellSizeM: 0.5,
    materials: MATERIALS,
    layers: {
      ground: ground(widthM, heightM),
      // Muro central en dos brazos, dejando corredor central (y 28..52) holgado.
      walls: [
        { shape: "rect", position: { x: cx, y: heightM - armLen / 2 }, widthM: 4, heightM: armLen, rotation: 0 },
        { shape: "rect", position: { x: cx, y: armLen / 2 }, widthM: 4, heightM: armLen, rotation: 0 },
      ],
      destructibles: [
        { objectId: "crate_l", material: "crate", shape: "rect", position: { x: 40, y: 40 }, widthM: 2, heightM: 2 },
        { objectId: "crate_r", material: "crate", shape: "rect", position: { x: 80, y: 40 }, widthM: 2, heightM: 2 },
      ],
      ...obj,
    },
    meta: META,
    ...overrides,
  } as MapWithoutChecksum);
}

export function brokenNoRouteMap(): InternalMap {
  const widthM = 120,
    heightM = 80,
    cx = 60;
  const obj = symmetricObjectives(widthM, heightM);
  return withChecksum({
    schemaVersion: 1,
    mapId: "fixture-noroute",
    version: 1,
    widthM,
    heightM,
    navCellSizeM: 0.5,
    materials: MATERIALS,
    layers: {
      ground: ground(widthM, heightM),
      // Muro central MACIZO de arriba a abajo: parte el mapa en dos, sin ruta.
      walls: [{ shape: "rect", position: { x: cx, y: heightM / 2 }, widthM: 4, heightM: heightM + 2, rotation: 0 }],
      ...obj,
    },
    meta: META,
  } as MapWithoutChecksum);
}
