/* Genera examples/valid/*.json y examples/invalid/*.json.
   Cada archivo inválido lleva un campo "_why" que explica qué regla viola.
   Se ejecuta una vez; los ejemplos quedan versionados en el repo. */
const fs = require("fs");
const path = require("path");

const V = path.join(__dirname, "..", "examples", "valid");
const I = path.join(__dirname, "..", "examples", "invalid");
fs.mkdirSync(V, { recursive: true });
fs.mkdirSync(I, { recursive: true });

const env = (type, payload, extra = {}) => ({
  proto: "arena/1",
  type,
  seq: 1,
  ...extra,
  payload,
});

const valid = {
  // ---------------- HELLO
  "hello-minimal": env("HELLO", {
    botId: "bot_scout01",
    botVersion: "1.4.2",
    sdk: { name: "arena-sdk-python", version: "0.3.0" },
    battleToken: "btl_9f2c4a7e1b8d3506",
  }),
  "hello-with-encodings": env("HELLO", {
    botId: "bot_gunner",
    botVersion: "2.0.0",
    sdk: { name: "arena-sdk-js", version: "0.3.0" },
    battleToken: "btl_aaaabbbbccccdddd",
    encodings: ["json"],
  }),
  "hello-custom-sdk": env("HELLO", {
    botId: "bot_x9",
    botVersion: "0.0.1-dev",
    sdk: { name: "custom", version: "handrolled" },
    battleToken: "btl_0123456789abcdef",
  }),

  // ---------------- WELCOME
  "welcome-ctf": env("WELCOME", {
    battleId: "btl_2026_07_13_0001",
    selfId: "veh_3",
    team: "red",
    timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
    rules: {
      mode: "capture_the_flag",
      rulesetId: "ctf_mvp@1",
      timeLimitTicks: 9000,
      scoreToWin: 3,
      friendlyFire: false,
      respawn: { enabled: true, delayTicks: 150 },
      sharedTeamVision: false,
      radio: { maxMessageBytes: 32, maxMessagesPerSecond: 2, deliveryDelayDecisions: 1 },
    },
    vehicle: {
      chassis: { moduleId: "chassis.medium@1", hullHp: 300, radiusM: 1.6 },
      modules: [
        {
          slot: "drive",
          moduleId: "movement.tracks@1",
          category: "movement",
          specs: { maxSpeedMs: 9, turnRateRads: 1.2 },
        },
        { slot: "power", moduleId: "power.battery@1", category: "power", specs: { capacityEU: 400 } },
        { slot: "sensor_a", moduleId: "sensor.lidar360@1", category: "sensor", specs: { rangeM: 40, rays: 64 } },
        {
          slot: "turret_main",
          moduleId: "weapon.cannon@1",
          category: "weapon",
          specs: { damage: 45, cooldownTicks: 30 },
        },
        {
          slot: "armor_front",
          moduleId: "armor.steel@1",
          category: "armor",
          specs: { sector: "front", reduction: 0.35 },
        },
      ],
      massKg: 2400,
      energy: { capacityEU: 400, generationEUs: 18 },
    },
    map: {
      mapId: "mvp-arena-01",
      mapVersion: 1,
      checksum: "sha256:3b1c9f0a7d2e4658a19b0c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      widthM: 120,
      heightM: 80,
      spawns: [
        { team: "red", position: { x: 10, y: 40 } },
        { team: "blue", position: { x: 110, y: 40 } },
      ],
      bases: [
        { team: "red", position: { x: 8, y: 40 } },
        { team: "blue", position: { x: 112, y: 40 } },
      ],
    },
    teammates: ["veh_4"],
    versions: {
      engine: "0.4.0",
      physics: "rapier2d-compat@0.14.0+sha256:ab12",
      rules: "ctf_mvp@1",
      catalog: "mvp@1",
      protocol: "arena/1",
    },
  }),
  "welcome-deathmatch-minimal": env("WELCOME", {
    battleId: "btl_practice",
    selfId: "veh_1",
    team: "solo",
    timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
    rules: { mode: "deathmatch", rulesetId: "dm_practice@1" },
    vehicle: {
      chassis: { moduleId: "chassis.light@1", hullHp: 180, radiusM: 1.2 },
      modules: [],
      massKg: 900,
      energy: { capacityEU: 200, generationEUs: 10 },
    },
    map: {
      mapId: "practice-empty",
      mapVersion: 1,
      checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      widthM: 60,
      heightM: 40,
    },
    versions: { engine: "0.4.0", rules: "dm_practice@1", catalog: "mvp@1", protocol: "arena/1" },
  }),
  "welcome-custom-budget": env("WELCOME", {
    battleId: "btl_skirmish_low_budget",
    selfId: "veh_1",
    team: "red",
    timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
    rules: {
      mode: "deathmatch",
      rulesetId: "skirmish_low@1",
      budgetCredits: 600,
      timeLimitTicks: 4500,
    },
    vehicle: {
      chassis: { moduleId: "chassis.light@1", hullHp: 180, radiusM: 1.2 },
      modules: [{ slot: "drive", moduleId: "movement.wheels@1", category: "movement" }],
      massKg: 900,
      energy: { capacityEU: 200, generationEUs: 10 },
    },
    map: {
      mapId: "mvp-arena-01",
      mapVersion: 1,
      checksum: "sha256:3b1c9f0a7d2e4658a19b0c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
      widthM: 120,
      heightM: 80,
    },
    versions: { engine: "0.4.0", rules: "skirmish_low@1", catalog: "mvp@1", protocol: "arena/1" },
  }),
  "welcome-blind-mode": env("WELCOME", {
    battleId: "btl_blind",
    selfId: "veh_2",
    team: "blue",
    timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
    rules: { mode: "zone_control", rulesetId: "zc_blind@1", sharedTeamVision: true },
    vehicle: {
      chassis: { moduleId: "chassis.heavy@1", hullHp: 500, radiusM: 2.1 },
      modules: [{ slot: "drive", moduleId: "movement.wheels@1", category: "movement" }],
      massKg: 4200,
      energy: { capacityEU: 600, generationEUs: 25 },
    },
    map: {
      mapId: "gen-7f3a",
      mapVersion: 1,
      checksum: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      widthM: 100,
      heightM: 100,
    },
    versions: { engine: "0.4.0", rules: "zc_blind@1", catalog: "mvp@1", protocol: "arena/1" },
  }),

  // ---------------- OBSERVATION
  "observation-full": env(
    "OBSERVATION",
    {
      tick: 300,
      self: {
        position: { x: 24.5, y: 40.1 },
        heading: 0.35,
        velocity: { x: 6.2, y: 1.1 },
        angularVelocity: 0.1,
        turretHeading: 0.9,
        hullHp: 245,
        hullHpMax: 300,
        energy: { storedEU: 312.5, capacityEU: 400, netFlowEUs: -4.2 },
        armor: { front: 0.72, left: 1, right: 1, rear: 1 },
        modules: [
          { slot: "drive", state: "operational", healthFraction: 1 },
          { slot: "sensor_a", state: "damaged", healthFraction: 0.5 },
          { slot: "turret_main", state: "operational", healthFraction: 1, cooldownTicks: 12, ammo: 34 },
        ],
        carryingFlag: null,
      },
      sensors: {
        lidar: [
          {
            slot: "sensor_a",
            originHeading: 0.35,
            fovRad: 6.28,
            rays: [
              { angle: 0, distanceM: 18.3, hit: "wall" },
              { angle: 0.4, distanceM: 12.1, hit: "vehicle" },
              { angle: 0.8, distanceM: 40, hit: "unknown" },
            ],
          },
        ],
      },
      radio: [{ from: "veh_4", data: "ZW5lbXkgd2VzdA==", sentTick: 297 }],
      score: { red: 1, blue: 0 },
      objectives: [
        { kind: "flag", team: "red", state: "at_base", position: { x: 8, y: 40 } },
        { kind: "flag", team: "blue", state: "carried" },
      ],
    },
    { tick: 300 },
  ),
  "observation-blind-bot": env(
    "OBSERVATION",
    {
      tick: 12,
      self: {
        position: { x: 10, y: 40 },
        heading: 0,
        velocity: { x: 0, y: 0 },
        hullHp: 180,
        hullHpMax: 180,
        energy: { storedEU: 200, capacityEU: 200 },
        modules: [{ slot: "drive", state: "operational" }],
      },
    },
    { tick: 12 },
  ),
  "observation-sensor-destroyed": env(
    "OBSERVATION",
    {
      tick: 900,
      self: {
        position: { x: 60, y: 20 },
        heading: -1.2,
        velocity: { x: 0, y: 0 },
        turretHeading: -1.2,
        hullHp: 40,
        hullHpMax: 300,
        energy: { storedEU: 10, capacityEU: 400, netFlowEUs: 2 },
        armor: { front: 0, left: 0.1, right: 0.8, rear: 1 },
        modules: [
          { slot: "drive", state: "destroyed", healthFraction: 0 },
          { slot: "sensor_a", state: "destroyed", healthFraction: 0 },
          { slot: "turret_main", state: "critical", healthFraction: 0.2, ammo: 3 },
        ],
        respawningInTicks: 0,
      },
      score: { red: 1, blue: 2 },
    },
    { tick: 900 },
  ),

  // ---------------- COMMAND
  "command-full": env(
    "COMMAND",
    {
      forTick: 303,
      move: { throttle: 1, steer: -0.4 },
      turret: { targetPoint: { x: 80, y: 35 } },
      fire: ["turret_main"],
      radio: [{ slot: "radio_a", data: "ZW5lbXkgd2VzdA==" }],
    },
    { tick: 303 },
  ),
  "command-empty-is-valid": env("COMMAND", { forTick: 306 }, { tick: 306 }),
  "command-mine-and-modules": env(
    "COMMAND",
    {
      forTick: 309,
      move: { throttle: 0, steer: 0 },
      deployMine: { slot: "mine_bay", armDelayTicks: 60 },
      modules: [{ slot: "sensor_a", enabled: false }],
    },
    { tick: 309 },
  ),

  // ---------------- EVENT
  "event-hit-taken": env(
    "EVENT",
    { tick: 310, kind: "hit_taken", sector: "front", damage: 45, sourceId: "veh_7" },
    { tick: 310 },
  ),
  "event-rejected-action": env(
    "EVENT",
    { tick: 311, kind: "rejected_action", slot: "turret_main", reason: "cooldown" },
    { tick: 311 },
  ),
  "event-flag-captured": env(
    "EVENT",
    { tick: 1500, kind: "flag_captured", team: "red", score: { red: 2, blue: 0 } },
    { tick: 1500 },
  ),

  // ---------------- SHUTDOWN
  "shutdown-finished-win": env("SHUTDOWN", {
    reason: "battle_finished",
    result: { outcome: "win", score: { red: 3, blue: 1 }, ticks: 7420 },
    gracePeriodMs: 500,
  }),
  "shutdown-timeout-dq": env("SHUTDOWN", {
    reason: "timeout_disqualified",
    detail: "20 decisiones consecutivas sin comando valido",
  }),
  "shutdown-bad-version": env("SHUTDOWN", {
    reason: "protocol_version_unsupported",
    detail: "El motor soporta arena/1",
  }),
};

const invalid = {
  // Envelope
  "env-unknown-proto": {
    _why: "proto desconocido: se rechaza sin inspeccionar payload (D5)",
    doc: {
      proto: "arena/2",
      type: "HELLO",
      seq: 1,
      payload: {
        botId: "bot_a",
        botVersion: "1",
        sdk: { name: "custom", version: "1" },
        battleToken: "btl_0123456789abcdef",
      },
    },
  },
  "env-unknown-type": {
    _why: "type no pertenece a los seis mensajes del contrato",
    doc: { proto: "arena/1", type: "PING", seq: 1, payload: {} },
  },
  "env-observation-without-tick": {
    _why: "los mensajes de ciclo de batalla exigen tick en el envelope",
    doc: {
      proto: "arena/1",
      type: "OBSERVATION",
      seq: 2,
      payload: {
        tick: 5,
        self: {
          position: { x: 0, y: 0 },
          heading: 0,
          velocity: { x: 0, y: 0 },
          hullHp: 1,
          energy: { storedEU: 0, capacityEU: 1 },
          modules: [],
        },
      },
    },
  },

  // HELLO
  "hello-missing-token": {
    _why: "sin battleToken: un contenedor no puede conectarse a una batalla ajena (E5.M)",
    doc: {
      proto: "arena/1",
      type: "HELLO",
      seq: 1,
      payload: { botId: "bot_a", botVersion: "1.0.0", sdk: { name: "custom", version: "1" } },
    },
  },
  "hello-bad-botid": {
    _why: "botId no cumple el patron bot_*",
    doc: {
      proto: "arena/1",
      type: "HELLO",
      seq: 1,
      payload: {
        botId: "scout",
        botVersion: "1.0.0",
        sdk: { name: "custom", version: "1" },
        battleToken: "btl_0123456789abcdef",
      },
    },
  },
  "hello-extra-field": {
    _why: "additionalProperties: false — un campo no declarado se rechaza",
    doc: {
      proto: "arena/1",
      type: "HELLO",
      seq: 1,
      payload: {
        botId: "bot_a",
        botVersion: "1.0.0",
        sdk: { name: "custom", version: "1" },
        battleToken: "btl_0123456789abcdef",
        cheatMode: true,
      },
    },
  },

  // WELCOME
  "welcome-missing-versions": {
    _why: "sin versions: toda batalla debe registrar sus artefactos exactos (cap. 8)",
    doc: {
      proto: "arena/1",
      type: "WELCOME",
      seq: 2,
      payload: {
        battleId: "b",
        selfId: "veh_1",
        team: "red",
        timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
        rules: { mode: "deathmatch", rulesetId: "r" },
        vehicle: {
          chassis: { moduleId: "chassis.light@1", hullHp: 1, radiusM: 1 },
          modules: [],
          massKg: 1,
          energy: { capacityEU: 1, generationEUs: 1 },
        },
        map: {
          mapId: "m",
          mapVersion: 1,
          checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          widthM: 1,
          heightM: 1,
        },
      },
    },
  },
  "welcome-bad-checksum": {
    _why: "checksum del mapa sin el formato sha256:<64 hex>",
    doc: {
      proto: "arena/1",
      type: "WELCOME",
      seq: 2,
      payload: {
        battleId: "b",
        selfId: "veh_1",
        team: "red",
        timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
        rules: { mode: "deathmatch", rulesetId: "r" },
        vehicle: {
          chassis: { moduleId: "chassis.light@1", hullHp: 1, radiusM: 1 },
          modules: [],
          massKg: 1,
          energy: { capacityEU: 1, generationEUs: 1 },
        },
        map: { mapId: "m", mapVersion: 1, checksum: "abc", widthM: 1, heightM: 1 },
        versions: { engine: "1", rules: "1", catalog: "1", protocol: "arena/1" },
      },
    },
  },
  "welcome-budget-out-of-range": {
    _why: "budgetCredits=50 por debajo de BUDGET_CREDITS_MIN: un ruleset no puede fijar un presupuesto absurdamente bajo",
    doc: {
      proto: "arena/1",
      type: "WELCOME",
      seq: 2,
      payload: {
        battleId: "b",
        selfId: "veh_1",
        team: "red",
        timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
        rules: { mode: "deathmatch", rulesetId: "r", budgetCredits: 50 },
        vehicle: {
          chassis: { moduleId: "chassis.light@1", hullHp: 1, radiusM: 1 },
          modules: [],
          massKg: 1,
          energy: { capacityEU: 1, generationEUs: 1 },
        },
        map: {
          mapId: "m",
          mapVersion: 1,
          checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          widthM: 1,
          heightM: 1,
        },
        versions: { engine: "1", rules: "1", catalog: "1", protocol: "arena/1" },
      },
    },
  },
  "welcome-unknown-mode": {
    _why: "modo de juego fuera del enum del MVP",
    doc: {
      proto: "arena/1",
      type: "WELCOME",
      seq: 2,
      payload: {
        battleId: "b",
        selfId: "veh_1",
        team: "red",
        timing: { tickHz: 30, decisionEveryNTicks: 3, decisionDeadlineMs: 80, maxConsecutiveTimeouts: 20 },
        rules: { mode: "battle_royale", rulesetId: "r" },
        vehicle: {
          chassis: { moduleId: "chassis.light@1", hullHp: 1, radiusM: 1 },
          modules: [],
          massKg: 1,
          energy: { capacityEU: 1, generationEUs: 1 },
        },
        map: {
          mapId: "m",
          mapVersion: 1,
          checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          widthM: 1,
          heightM: 1,
        },
        versions: { engine: "1", rules: "1", catalog: "1", protocol: "arena/1" },
      },
    },
  },

  // OBSERVATION
  "observation-missing-self": {
    _why: "toda observacion incluye el estado propio",
    doc: { proto: "arena/1", type: "OBSERVATION", tick: 1, seq: 3, payload: { tick: 1, sensors: {} } },
  },
  "observation-negative-hp": {
    _why: "hullHp no puede ser negativo",
    doc: {
      proto: "arena/1",
      type: "OBSERVATION",
      tick: 1,
      seq: 3,
      payload: {
        tick: 1,
        self: {
          position: { x: 0, y: 0 },
          heading: 0,
          velocity: { x: 0, y: 0 },
          hullHp: -5,
          energy: { storedEU: 0, capacityEU: 1 },
          modules: [],
        },
      },
    },
  },
  "observation-leaks-hidden-entity": {
    _why: "campo no declarado (allEntities): la niebla de guerra prohibe canales alternativos (D8)",
    doc: {
      proto: "arena/1",
      type: "OBSERVATION",
      tick: 1,
      seq: 3,
      payload: {
        tick: 1,
        self: {
          position: { x: 0, y: 0 },
          heading: 0,
          velocity: { x: 0, y: 0 },
          hullHp: 10,
          energy: { storedEU: 0, capacityEU: 1 },
          modules: [],
        },
        allEntities: [{ id: "veh_9", x: 100, y: 10 }],
      },
    },
  },

  // COMMAND
  "command-missing-fortick": {
    _why: "sin forTick el motor no puede descartar comandos tardios",
    doc: { proto: "arena/1", type: "COMMAND", tick: 10, seq: 4, payload: { move: { throttle: 1 } } },
  },
  "command-throttle-out-of-range": {
    _why: "throttle fuera de [-1,1]: la intencion es normalizada (D3)",
    doc: {
      proto: "arena/1",
      type: "COMMAND",
      tick: 10,
      seq: 4,
      payload: { forTick: 12, move: { throttle: 5, steer: 0 } },
    },
  },
  "command-turret-both-targets": {
    _why: "targetHeading y targetPoint son excluyentes",
    doc: {
      proto: "arena/1",
      type: "COMMAND",
      tick: 10,
      seq: 4,
      payload: { forTick: 12, turret: { targetHeading: 0.5, targetPoint: { x: 1, y: 1 } } },
    },
  },

  // EVENT
  "event-unknown-kind": {
    _why: "kind fuera del enum",
    doc: { proto: "arena/1", type: "EVENT", tick: 20, seq: 5, payload: { tick: 20, kind: "teleported" } },
  },
  "event-missing-kind": {
    _why: "kind es obligatorio",
    doc: { proto: "arena/1", type: "EVENT", tick: 20, seq: 5, payload: { tick: 20, damage: 10 } },
  },
  "event-negative-damage": {
    _why: "el dano no puede ser negativo",
    doc: { proto: "arena/1", type: "EVENT", tick: 20, seq: 5, payload: { tick: 20, kind: "hit_taken", damage: -3 } },
  },

  // SHUTDOWN
  "shutdown-unknown-reason": {
    _why: "reason fuera del enum de causas de cierre",
    doc: { proto: "arena/1", type: "SHUTDOWN", seq: 6, payload: { reason: "because" } },
  },
  "shutdown-missing-reason": {
    _why: "reason es obligatorio: el bot debe saber por que se cierra",
    doc: { proto: "arena/1", type: "SHUTDOWN", seq: 6, payload: { detail: "adios" } },
  },
  "shutdown-bad-outcome": {
    _why: "outcome fuera del enum",
    doc: {
      proto: "arena/1",
      type: "SHUTDOWN",
      seq: 6,
      payload: { reason: "battle_finished", result: { outcome: "almost" } },
    },
  },
};

for (const [name, doc] of Object.entries(valid)) {
  fs.writeFileSync(path.join(V, name + ".json"), JSON.stringify(doc, null, 2) + "\n");
}
for (const [name, { _why, doc }] of Object.entries(invalid)) {
  fs.writeFileSync(path.join(I, name + ".json"), JSON.stringify({ _why, ...doc }, null, 2) + "\n");
}

console.log(`Escritos ${Object.keys(valid).length} ejemplos validos y ${Object.keys(invalid).length} invalidos.`);
