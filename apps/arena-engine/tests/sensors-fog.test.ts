/**
 * T2.4 · SENSORES Y NIEBLA DE GUERRA.
 *
 * El test de fuga es el más importante del motor después del determinismo. Una sola
 * fuga —un campo de más, una posición exacta donde debería haber error, un enemigo
 * visible tras un muro— invalida el juego entero: los sensores dejan de tener valor
 * y el sistema modular pierde su razón de ser.
 *
 * Estrategia: no confiamos en revisar el código. Serializamos la observación, la
 * recorremos ENTERA buscando datos que el bot no debería poder saber, y comprobamos
 * además que valida contra el esquema de E1 (que tiene additionalProperties:false y
 * por tanto rechaza cualquier campo no declarado).
 */
import { beforeAll, describe, expect, it } from "vitest";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { MODULES, emptyArena, mvpArena, sandbagLoadout, scoutLoadout, gunnerLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";
import { Rng } from "../src/rng.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";

const SCHEMA_DIR = join(import.meta.dirname, "../../../packages/protocol/schemas");

let validateObservation: any;

beforeAll(async () => {
  await initPhysics();

  // El contrato de E1 es la autoridad. Si el motor emite algo que el esquema no
  // declara, el esquema lo rechaza (additionalProperties:false) y este test falla.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")), f);
  }
  validateObservation = ajv.getSchema("observation.schema.json");
});

/** Recorre un objeto entero y devuelve todos los valores string encontrados. */
function allStrings(obj: any, acc: string[] = []): string[] {
  if (typeof obj === "string") acc.push(obj);
  else if (Array.isArray(obj)) obj.forEach((o) => allStrings(o, acc));
  else if (obj && typeof obj === "object") Object.values(obj).forEach((o) => allStrings(o, acc));
  return acc;
}

function battleWith(specs: Record<string, VehicleSpec>, map = mvpArena()) {
  const participants = Object.entries(specs).map(([id, spec], i) => ({
    id,
    botId: "bot_" + id,
    team: i % 2 === 0 ? "red" : "blue",
    spec,
  }));
  const b = new Battle({
    battleId: "fog",
    seed: "fog-seed",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 3000 }),
    map,
    participants,
  });
  for (const p of participants) b.attachBot(p.id, new IdleBot(p.botId));
  return b;
}

describe("la observación valida contra el contrato de E1", () => {
  it("una observación real del motor pasa el esquema arena/1", () => {
    const b = battleWith({ veh_1: gunnerLoadout(), veh_2: scoutLoadout() });
    for (let i = 0; i < 30; i++) b.step();

    const obs = b.observationFor("veh_1");
    const ok = validateObservation(obs);
    if (!ok) console.error(validateObservation.errors);
    expect(ok, JSON.stringify(validateObservation.errors?.slice(0, 3))).toBe(true);
    b.free();
  });

  it("una observación de zone_control con objetivos (id + posición) valida contra el esquema", () => {
    // Regresión de ERR-ENG-03: objectives() de zone_control lleva `id` y `position` de cada
    // zona (públicos por definición del modo). El esquema de E1 declara `id` como opcional.
    // Antes solo se validaba una observación de team_deathmatch, con objectives VACÍO, así que
    // una fuga de contrato en objectives pasaba desapercibida. Este test cierra ese hueco.
    const map = emptyArena();
    map.zones = [
      { id: "alpha", position: { x: 40, y: 40 }, radiusM: 8, kind: "capture" },
      { id: "bravo", position: { x: 80, y: 25 }, radiusM: 8, kind: "capture" },
    ];
    const b = new Battle({
      battleId: "zc_schema",
      seed: "zc-schema",
      ruleset: loadRuleset("zc_mvp@1"),
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    for (let i = 0; i < 5; i++) b.step();

    const obs = b.observationFor("veh_1");

    // La observación LLEVA objetivos de zona con id y posición distinguibles.
    expect(Array.isArray(obs.objectives)).toBe(true);
    const zone = obs.objectives.find((o: any) => o.kind === "zone" && o.id === "alpha");
    expect(zone).toBeDefined();
    expect(zone.id).toBe("alpha");
    expect(zone.position).toEqual({ x: 40, y: 40 });
    expect(obs.objectives.some((o: any) => o.id === "bravo")).toBe(true);

    // Y valida contra el contrato de E1 (que ahora admite `id` opcional en objectives).
    const ok = validateObservation(obs);
    if (!ok) console.error(validateObservation.errors);
    expect(ok, JSON.stringify(validateObservation.errors?.slice(0, 3))).toBe(true);
    b.free();
  });
});

describe("FUGA DE NIEBLA DE GUERRA (D8)", () => {
  it("la observación de un bot NO menciona a ningún vehículo que no haya detectado", () => {
    // Un saco de arena SIN SENSORES en un extremo, dos enemigos en el otro.
    const b = battleWith({
      veh_1: sandbagLoadout(), // ciego: sin lidar, sin radar
      veh_2: gunnerLoadout(),
      veh_3: scoutLoadout(),
    });
    for (let i = 0; i < 30; i++) b.step();

    const obs = b.observationFor("veh_1");
    const strings = allStrings(obs);

    // No debe aparecer NI EL ID de los enemigos por ninguna parte del objeto.
    expect(strings).not.toContain("veh_2");
    expect(strings).not.toContain("veh_3");
    // Y desde luego no debe existir ninguna lista de entidades.
    expect(obs.entities).toBeUndefined();
    expect(obs.allEntities).toBeUndefined();
    expect(obs.world).toBeUndefined();
    b.free();
  });

  it("FUZZING: en 200 posiciones aleatorias, un bot ciego nunca ve a nadie", () => {
    // El bot ciego se teletransporta por todo el mapa. Da igual dónde esté: sin
    // sensores no percibe NADA. Si una sola de las 200 posiciones filtra algo,
    // hay un canal encubierto en alguna parte.
    const rng = new Rng("fuzz-fog");
    const b = battleWith({
      veh_1: sandbagLoadout(),
      veh_2: gunnerLoadout(),
      veh_3: scoutLoadout(),
    });
    const phys = b.getPhysics();
    b.step();

    for (let i = 0; i < 200; i++) {
      const x = rng.range(2, 118);
      const y = rng.range(2, 78);
      phys.get("veh_1")!.rb.setTranslation({ x, y }, true);
      b.step();

      const obs = b.observationFor("veh_1");
      const strings = allStrings(obs);
      expect(strings, `fuga en posición (${x.toFixed(1)}, ${y.toFixed(1)})`).not.toContain("veh_2");
      expect(strings).not.toContain("veh_3");
      expect(obs.sensors).toBeUndefined(); // sin sensores, ni siquiera existe la clave
    }
    b.free();
  }, 60_000);

  it("un bot SIN lidar no recibe bloque lidar; con lidar, sí", () => {
    const b = battleWith({ veh_1: scoutLoadout(), veh_2: gunnerLoadout() });
    for (let i = 0; i < 10; i++) b.step();

    const scout = b.observationFor("veh_1"); // lleva lidar360
    const gunner = b.observationFor("veh_2"); // NO lleva lidar, solo radar

    expect(scout.sensors.lidar).toBeDefined();
    expect(scout.sensors.lidar[0].rays.length).toBeGreaterThan(0);
    expect(gunner.sensors.lidar).toBeUndefined();
    expect(gunner.sensors.radar).toBeDefined();
    b.free();
  });

  it("con el lidar DESTRUIDO, el bloque lidar desaparece de la observación", () => {
    const b = battleWith({ veh_1: scoutLoadout(), veh_2: gunnerLoadout() });
    b.step();
    expect(b.observationFor("veh_1").sensors.lidar).toBeDefined();

    // Le destruimos el lidar.
    b.getVehicle("veh_1")!.modules.get("sensor_a")!.hp = 0;
    b.step();

    const obs = b.observationFor("veh_1");
    expect(obs.sensors?.lidar).toBeUndefined();
    // Pero el bot SÍ sabe que su lidar está destruido: eso es información propia legítima.
    const mod = obs.self.modules.find((m: any) => m.slot === "sensor_a");
    expect(mod.state).toBe("destroyed");
    b.free();
  });

  it("con el lidar APAGADO por el propio bot, tampoco hay bloque lidar", () => {
    const b = battleWith({ veh_1: scoutLoadout(), veh_2: gunnerLoadout() });
    b.step();
    b.getVehicle("veh_1")!.setModuleEnabled("sensor_a", false, b.tick);
    b.step();

    expect(b.observationFor("veh_1").sensors?.lidar).toBeUndefined();
    b.free();
  });

  it("el radar NO detecta a un enemigo tras un muro (la geometría bloquea)", () => {
    const map = mvpArena();
    const b = new Battle({
      battleId: "los",
      seed: "los",
      ruleset: loadRuleset("tdm_mvp@1"),
      map,
      participants: [
        // Uno a cada lado del muro central (x=60, de y=50 a y=74).
        // veh_1 lleva el radar (gunnerLoadout): el catálogo real de E3 da al explorador
        // solo lidar frontal (docs/balance/v1.md), así que es el artillero quien detecta.
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: scoutLoadout() },
      ],
    });
    b.attachBot("veh_1", new IdleBot("b1"));
    b.attachBot("veh_2", new IdleBot("b2"));
    b.step();

    const phys = b.getPhysics();
    phys.get("veh_1")!.rb.setTranslation({ x: 54, y: 62 }, true); // justo a la izquierda del muro
    phys.get("veh_2")!.rb.setTranslation({ x: 66, y: 62 }, true); // justo a la derecha
    b.step();

    const contactsBlocked = b.observationFor("veh_1").sensors?.radar?.[0]?.contacts ?? [];
    expect(contactsBlocked).toHaveLength(0); // el muro tapa: no hay contacto

    // Ahora los ponemos en línea de visión limpia, a la misma distancia.
    phys.get("veh_1")!.rb.setTranslation({ x: 54, y: 40 }, true);
    phys.get("veh_2")!.rb.setTranslation({ x: 66, y: 40 }, true);
    b.step();

    const contactsClear = b.observationFor("veh_1").sensors?.radar?.[0]?.contacts ?? [];
    expect(contactsClear.length).toBeGreaterThan(0); // ahora sí
    b.free();
  });

  it("el radar da posición CON ERROR, no la posición exacta (D8)", () => {
    // veh_1 lleva el radar (gunnerLoadout): ver comentario en el test anterior.
    const b = battleWith({ veh_1: gunnerLoadout(), veh_2: scoutLoadout() }, emptyArena());
    b.step();
    const phys = b.getPhysics();
    phys.get("veh_1")!.rb.setTranslation({ x: 40, y: 40 }, true);
    phys.get("veh_2")!.rb.setTranslation({ x: 60, y: 40 }, true);
    b.step();

    const contact = b.observationFor("veh_1").sensors.radar[0].contacts[0];
    expect(contact).toBeDefined();
    expect(contact.errorM).toBeGreaterThan(0);

    // La posición reportada NO es exactamente (60,40): tiene ruido.
    const exact = contact.position.x === 60 && contact.position.y === 40;
    expect(exact).toBe(false);
    // Pero está en el entorno correcto: el sensor sirve para algo.
    expect(Math.hypot(contact.position.x - 60, contact.position.y - 40)).toBeLessThan(contact.errorM * 2 + 0.1);
    b.free();
  });

  it("el sensor acústico PERCIBE un disparo cercano y da DIRECCIÓN, nunca posición (cap. 11)", () => {
    // ERR-ENG-01. El sensor acústico debe OÍR de verdad. Comprobamos la ruta que de
    // verdad importa: la observación que RECIBE el bot en su decisión (la que el doble
    // borrado dejaba muda), no solo lo que devuelve observationFor().
    const listener = scoutLoadout();
    listener.modules = [...listener.modules, { ...MODULES.acoustic }]; // alcance 60 m

    const b = battleWith({ veh_1: listener, veh_2: gunnerLoadout() }, emptyArena());
    const phys = b.getPhysics();
    b.step();
    phys.get("veh_1")!.rb.setTranslation({ x: 60, y: 40 }, true); // oyente
    phys.get("veh_2")!.rb.setTranslation({ x: 45, y: 40 }, true); // tirador, 15 m al oeste

    // Todo lo que el bot OYENTE recibe en cada decisión: aquí es donde se cazaba el bug.
    const heard: any[] = [];
    b.attachBot("veh_1", {
      botId: "bot_veh_1",
      decide: (obs: any) => {
        for (const s of obs.sensors?.acoustic?.[0]?.sources ?? []) heard.push(s);
        return { forTick: obs.tick, move: { throttle: 0, steer: 0 } };
      },
    });
    // El artillero dispara hacia el oeste, LEJOS del oyente: solo el fogonazo (a 15 m)
    // entra en alcance; el proyectil se aleja y no hiere a nadie.
    b.attachBot("veh_2", {
      botId: "bot_veh_2",
      decide: (obs: any) => ({
        forTick: obs.tick,
        move: { throttle: 0, steer: 0 },
        turret: { targetPoint: { x: 0, y: 40 } },
        fire: ["turret_main"],
      }),
    });

    for (let i = 0; i < 30; i++) {
      b.step();
      phys.get("veh_1")!.rb.setTranslation({ x: 60, y: 40 }, true);
      phys.get("veh_2")!.rb.setTranslation({ x: 45, y: 40 }, true);
    }

    // EXIGENCIA: el acústico tiene que haber percibido al menos un disparo. (Antes esto
    // estaba tras `if (sources.length > 0)` y pasaba EN VACÍO: el sensor estaba muerto.)
    const shots = heard.filter((s) => s.kind === "gunshot");
    expect(shots.length, "el sensor acústico nunca percibió el disparo (ERR-ENG-01)").toBeGreaterThan(0);
    for (const s of shots) {
      expect(s).toHaveProperty("bearing");
      expect(s).not.toHaveProperty("position"); // jamás
      expect(s).not.toHaveProperty("distanceM");
      expect(s).not.toHaveProperty("entityId");
      // Dirección aproximada: el disparo viene del oeste (bearing ≈ ±π), nunca posición.
      expect(Math.abs(Math.abs(s.bearing) - Math.PI)).toBeLessThan(0.5);
    }
    b.free();
  });

  it("el bot SIEMPRE conoce su propio hardware, aunque esté roto (información legítima)", () => {
    const b = battleWith({ veh_1: gunnerLoadout(), veh_2: scoutLoadout() });
    b.step();
    const v = b.getVehicle("veh_1")!;
    v.modules.get("drive")!.hp = 0;
    b.step();

    const obs = b.observationFor("veh_1");
    const drive = obs.self.modules.find((m: any) => m.slot === "drive");
    expect(drive.state).toBe("destroyed");
    // Saber que te has quedado inmóvil es esencial para reaccionar. No es una fuga.
    b.free();
  });
});

describe("radio (D8)", () => {
  it("un mensaje que excede el tamaño máximo se descarta con evento", () => {
    const b = battleWith({ veh_1: scoutLoadout(), veh_2: scoutLoadout() });
    const big = Buffer.alloc(64, 65).toString("base64"); // 64 bytes > 32

    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({ forTick: obs.tick, radio: [{ slot: "radio_a", data: big }] }),
    });
    for (let i = 0; i < 12; i++) b.step();

    // El receptor no recibe nada.
    const obs2 = b.observationFor("veh_2");
    expect(obs2.radio ?? []).toHaveLength(0);
    b.free();
  });

  it("un mensaje válido llega al compañero de equipo, con un ciclo de retardo", () => {
    const b = new Battle({
      battleId: "radio",
      seed: "r",
      ruleset: loadRuleset("tdm_mvp@1"),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "b2", team: "red", spec: scoutLoadout() },
      ],
    });
    const msg = Buffer.from("enemy-w").toString("base64"); // 7 bytes, dentro del límite

    let sent = false;
    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => {
        if (!sent && obs.tick > 0) {
          sent = true;
          return { forTick: obs.tick, radio: [{ slot: "radio_a", data: msg }] };
        }
        return { forTick: obs.tick };
      },
    });
    b.attachBot("veh_2", new IdleBot("b2"));

    let received: any = null;
    for (let i = 0; i < 30 && !received; i++) {
      b.step();
      const obs = b.observationFor("veh_2");
      if (obs.radio?.length) received = obs.radio[0];
    }

    expect(received).not.toBeNull();
    expect(received.data).toBe(msg);
    expect(received.from).toBe("veh_1");
    b.free();
  });

  it("un bot sin radio operativa no puede emitir", () => {
    const b = battleWith({ veh_1: scoutLoadout(), veh_2: scoutLoadout() });
    b.step();
    b.getVehicle("veh_1")!.modules.get("radio_a")!.hp = 0; // radio destruida

    const msg = Buffer.from("hola").toString("base64");
    b.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({ forTick: obs.tick, radio: [{ slot: "radio_a", data: msg }] }),
    });
    for (let i = 0; i < 15; i++) b.step();

    expect(b.observationFor("veh_2").radio ?? []).toHaveLength(0);
    b.free();
  });
});
