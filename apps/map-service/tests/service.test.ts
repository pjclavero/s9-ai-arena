/**
 * T4.3 · Servicio de mapas: import/publish/get/list, inmutabilidad, idempotencia por
 * checksum, y prueba de integración REAL contra el motor de E2.
 */
import { describe, expect, it } from "vitest";
import { MapService, MapServiceError } from "../src/service.js";
import { toEngineMap } from "../src/to-engine-map.js";
import { sampleValidMap, brokenNoRouteMap } from "./fixtures-maps.js";
import { Battle } from "../../arena-engine/src/sim/battle.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { IdleBot, ForwardBot } from "../../arena-engine/src/stubs.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";

describe("T4.3 · import/validación", () => {
  it("un mapa válido se importa como draft", () => {
    const svc = new MapService();
    const rec = svc.importMap(sampleValidMap());
    expect(rec.status).toBe("draft");
  });

  it("un mapa con errores NUNCA se importa (lanza invalid_map)", () => {
    const svc = new MapService();
    expect(() => svc.importMap(brokenNoRouteMap())).toThrow(MapServiceError);
    try {
      svc.importMap(brokenNoRouteMap());
    } catch (e) {
      expect((e as MapServiceError).code).toBe("invalid_map");
    }
  });
});

describe("T4.3 · publicación e inmutabilidad", () => {
  it("un mapa inválido nunca alcanza 'published' aunque se fuerce publishMap directamente", () => {
    const svc = new MapService();
    // Se importa un mapa bueno y luego se corrompe su copia interna para forzar el caso.
    const rec = svc.importMap(sampleValidMap());
    (rec.map.layers as any).spawns = []; // rompe el modo/nav: sin spawns
    expect(() => svc.publishMap(rec.mapId, rec.version)).toThrow(MapServiceError);
    expect(svc.getMap(rec.mapId, rec.version).status).toBe("draft");
  });

  it("publicar/reimportar el MISMO contenido devuelve la misma versión (idempotencia por checksum)", () => {
    const svc = new MapService();
    const a = svc.importMap(sampleValidMap());
    const pub1 = svc.publishMap(a.mapId, a.version);
    // Reimportar el contenido EXACTAMENTE igual (mismo checksum): idempotente, no crea
    // versión nueva ni falla por inmutabilidad — devuelve la publicada.
    const b = svc.importMap(sampleValidMap());
    const pub2 = svc.publishMap(b.mapId, b.version);
    expect(pub2.version).toBe(pub1.version);
    expect(pub2.checksum).toBe(pub1.checksum);
  });

  it("modificar (contenido DISTINTO) una versión ya publicada se rechaza (immutable_version) y queda auditado", () => {
    const svc = new MapService();
    const a = svc.importMap(sampleValidMap());
    svc.publishMap(a.mapId, a.version);
    // Reimportar la MISMA versión con contenido DISTINTO (otro autor → otro checksum)
    // debe fallar por inmutabilidad.
    const mutated = sampleValidMap({ meta: { ...sampleValidMap().meta, author: "otro-autor" } });
    expect(() => svc.importMap(mutated)).toThrow(MapServiceError);
    const audit = svc.getAuditLog();
    expect(audit.some((e) => e.action === "reject_publish_immutable")).toBe(true);
  });

  it("publicar genera una miniatura (SVG data URI)", () => {
    const svc = new MapService();
    const a = svc.importMap(sampleValidMap());
    const pub = svc.publishMap(a.mapId, a.version);
    expect(pub.thumbnail).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("listMaps devuelve todas las versiones con su estado", () => {
    const svc = new MapService();
    const a = svc.importMap(sampleValidMap());
    svc.publishMap(a.mapId, a.version);
    const list = svc.listMaps();
    expect(list.some((m) => m.status === "published")).toBe(true);
  });
});

describe("T4.3 · integración real con el motor de E2", () => {
  it("un mapa publicado, convertido con toEngineMap, corre en una Battle real sin lanzar", async () => {
    await initPhysics();
    const svc = new MapService();
    const a = svc.importMap(sampleValidMap());
    const pub = svc.publishMap(a.mapId, a.version);

    const catalog = loadCatalog();
    const battle = await Battle.create({
      battleId: "svc-integration",
      seed: "svc",
      ruleset: loadRuleset("ctf_mvp@1", { timeLimitTicks: 120 }),
      map: toEngineMap(pub.map),
      participants: [
        { id: "veh_1", botId: "bot_a", team: "red", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
        { id: "veh_2", botId: "bot_b", team: "blue", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      ],
    });
    battle.attachBot("veh_1", new ForwardBot("bot_a"));
    battle.attachBot("veh_2", new IdleBot("bot_b"));
    expect(() => {
      for (let i = 0; i < 120; i++) battle.step();
    }).not.toThrow();
    battle.free();
  });
});
