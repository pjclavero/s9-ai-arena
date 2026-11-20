/**
 * DOC-A · SDK_DOCS_CURRENT · la guía de programación de bots (docs/user/bots/*.md) no
 * inventa nada: cada campo, orden, evento y motivo que nombra existe en el contrato real
 * (packages/protocol/schemas) o en el SDK, y cada campo del contrato que un bot necesita
 * está explicado. Las cifras de tiempo y límites que cita se comparan con las constantes
 * del juego. Si el contrato cambia y la guía no, esto se pone rojo.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DECISION_DEADLINE_MS,
  DECISION_EVERY_N_TICKS,
  DECISION_HZ,
  DISCONNECT_GRACE_TICKS,
  DMG_MIN_FRACTION,
  MAX_CONSECUTIVE_TIMEOUTS,
  MODULE_REACTIVATION_TICKS,
  MODULE_STATE_PERFORMANCE,
  RADIO_MAX_MESSAGES_PER_SECOND,
  RADIO_MAX_MESSAGE_BYTES,
  TICK_HZ,
} from "../game-rules/constants.js";
import { ARCHETYPES } from "../module-catalog/resolve/archetypes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const schema = (n: string) => JSON.parse(read(`packages/protocol/schemas/${n}.schema.json`));
const doc = (n: string) => read(`docs/user/bots/${n}.md`);

const ciclo = doc("ciclo");
const comandos = doc("comandos");
const observaciones = doc("observaciones");
const sensores = doc("sensores");
const eventos = doc("eventos");
const radio = doc("radio");
const armas = doc("armas-y-municion");
const probar = doc("probar");
const index = doc("index");

const mentions = (text: string, token: string) => text.includes("`" + token + "`");

describe("SDK_DOCS_CURRENT · el contrato arena/1 está documentado, sin inventar", () => {
  it("cada campo de COMMAND existe y está explicado en comandos.md", () => {
    for (const k of Object.keys(schema("command").properties)) {
      if (k === "forTick") continue; // lo pone el SDK; ciclo.md lo explica
      expect(mentions(comandos, k), `comandos.md no explica el campo \`${k}\``).toBe(true);
    }
    expect(mentions(ciclo, "forTick")).toBe(true);
  });

  it("cada subcampo de las órdenes que nombra la guía existe en el esquema", () => {
    const c = schema("command").properties;
    for (const k of Object.keys(c.move.properties)) expect(mentions(comandos, k), k).toBe(true);
    for (const k of Object.keys(c.turret.properties)) expect(mentions(comandos, k), k).toBe(true);
    for (const k of Object.keys(c.deployMine.properties)) expect(mentions(comandos, k), k).toBe(true);
    for (const k of Object.keys(c.radio.items.properties)) expect(comandos + radio).toContain(k);
    expect(c.fire.maxItems).toBe(8);
    expect(comandos).toContain("hasta 8");
    expect(comandos).toContain(`hasta ${c.modules.maxItems}`);
    expect(comandos).toContain(`hasta ${c.radio.maxItems}`);
    expect(comandos).toContain(`hasta ${c.debug.maxProperties}`);
    expect(c.deployMine.properties.armDelayTicks.maximum).toBe(300);
    expect(comandos).toContain("0 a 300");
  });

  it("cada campo de la observación y de self está explicado en observaciones.md", () => {
    const o = schema("observation").properties;
    for (const k of Object.keys(o))
      expect(mentions(observaciones, k), `observaciones.md no explica \`${k}\``).toBe(true);
    for (const k of Object.keys(o.self.properties)) {
      expect(mentions(observaciones, k), `observaciones.md no explica self.\`${k}\``).toBe(true);
    }
    for (const k of Object.keys(o.self.properties.modules.items.properties)) {
      expect(mentions(observaciones, k), `módulo.\`${k}\``).toBe(true);
    }
    for (const s of schema("common").$defs.moduleState.enum) expect(mentions(observaciones, s), s).toBe(true);
  });

  it("cada tipo de sensor y de campo de sensor está explicado en sensores.md", () => {
    const s = schema("observation").properties.sensors.properties;
    for (const [kind, def] of Object.entries<any>(s)) {
      expect(mentions(sensores, `sensors.${kind}`), kind).toBe(true);
      const props = Object.keys(def.items.properties);
      for (const p of props) expect(sensores, `${kind}.${p}`).toContain(p);
    }
    const contact = s.radar.items.properties.contacts.items.properties;
    for (const p of Object.keys(contact)) expect(sensores, `contacto.${p}`).toContain(p);
    for (const kind of s.acoustic.items.properties.sources.items.properties.kind.enum) expect(sensores).toContain(kind);
  });

  it("cada tipo de evento y cada motivo del esquema está en eventos.md", () => {
    const e = schema("event").properties;
    for (const k of e.kind.enum) expect(mentions(eventos, k), `evento \`${k}\``).toBe(true);
    for (const f of Object.keys(e)) {
      if (f === "tick" || f === "kind") continue;
      expect(mentions(eventos, f), `campo de evento \`${f}\``).toBe(true);
    }
    const reasons = (e.reason.description as string)
      .split(":")[1]
      .split(".")[0]
      .split(",")
      .map((r) => r.trim());
    // El esquema lista estos motivos; los que la guía debe explicar con su significado:
    for (const r of reasons) expect(eventos + armas + radio, `motivo ${r}`).toContain(r);
  });

  it("cada campo de WELCOME y de timing está en ciclo.md", () => {
    const w = schema("welcome").properties;
    for (const k of Object.keys(w)) {
      if (k === "encoding") continue;
      expect(mentions(ciclo, k) || ciclo.includes(`\`${k}\``), `ciclo.md no explica \`${k}\``).toBe(true);
    }
    for (const k of Object.keys(w.timing.properties)) expect(mentions(ciclo, k), k).toBe(true);
    for (const k of w.rules.properties.mode.enum) expect(ciclo, k).toContain(k);
  });

  it("cada motivo de SHUTDOWN está en ciclo.md", () => {
    for (const r of schema("common").$defs.shutdownReason.enum) expect(ciclo, r).toContain(r);
    for (const r of schema("shutdown").properties.result.properties.outcome.enum) expect(ciclo, r).toContain(r);
  });

  it("cada tipo de objeto detectado por el lidar (que la guía enumera) es del contrato", () => {
    const kinds: string[] = schema("common").$defs.entityKind.enum;
    for (const k of ["wall", "vehicle", "destructible", "unknown"]) expect(kinds).toContain(k);
  });

  it("los estados de objetivo que cita objetivos.md existen en el contrato", () => {
    const states: string[] = schema("observation").properties.objectives.items.properties.state.enum;
    const obj = doc("objetivos");
    for (const s of ["at_base", "carried", "dropped", "returning", "captured", "held", "neutral"]) {
      expect(states).toContain(s);
      expect(obj).toContain(s);
    }
  });
});

describe("SDK_DOCS_CURRENT · las cifras citadas son las del juego", () => {
  it("ciclo: 30 ticks por segundo, decisión cada 3 (10 por segundo), plazo, descalificación", () => {
    expect(ciclo).toContain(`**${TICK_HZ} por segundo**`);
    expect(ciclo).toContain(`cada **${DECISION_EVERY_N_TICKS} ticks**`);
    expect(ciclo).toContain(`**${DECISION_HZ} veces por segundo**`);
    expect(ciclo).toContain(`${DECISION_DEADLINE_MS} ms como mínimo`);
    expect(ciclo).toContain(`${MAX_CONSECUTIVE_TIMEOUTS} por defecto`);
    expect(DISCONNECT_GRACE_TICKS / TICK_HZ).toBe(2);
    expect(ciclo).toContain("más de 2 segundos");
    expect(index).toContain(`**${DECISION_HZ} veces por segundo**`);
  });

  it("radio: tamaño y ritmo máximos", () => {
    expect(radio).toContain(`**${RADIO_MAX_MESSAGE_BYTES} bytes**`);
    expect(radio).toContain(`**${RADIO_MAX_MESSAGES_PER_SECOND} mensajes por segundo**`);
    expect(comandos + radio).toContain("44 caracteres");
  });

  it("módulos apagados y dañados", () => {
    expect(comandos).toContain(`tarda ${MODULE_REACTIVATION_TICKS} ticks`);
    expect(observaciones).toContain(`\`damaged\` al ${MODULE_STATE_PERFORMANCE.damaged * 100} %`);
    expect(observaciones).toContain(`\`critical\` al ${MODULE_STATE_PERFORMANCE.critical * 100} %`);
    expect(armas).toContain(`${DMG_MIN_FRACTION * 100} % del daño original`);
  });

  it("probar: los arquetipos del simulador son los del catálogo", () => {
    for (const k of Object.keys(ARCHETYPES)) expect(probar, k).toContain(`\`${k}\``);
  });
});

describe("SDK_DOCS_CURRENT · lo que la guía afirma de los SDK existe en el código", () => {
  const botPy = read("sdks/python/arena_sdk/bot.py");
  const initPy = read("sdks/python/arena_sdk/__init__.py");
  const indexTs = read("sdks/javascript/src/index.ts");
  const typesTs = read("sdks/javascript/src/types.ts");
  const python = doc("python");
  const javascript = doc("javascript");

  it("los hooks de Python y de JavaScript existen con el nombre documentado", () => {
    for (const h of ["on_welcome", "on_observation", "on_event", "on_shutdown"]) {
      expect(botPy).toContain(`def ${h}(`);
      expect(python).toContain(h);
    }
    for (const h of ["onWelcome", "onObservation", "onEvent", "onShutdown"]) {
      expect(indexTs).toContain(`${h}(`);
      expect(javascript).toContain(h);
    }
  });

  it("las ayudas de geometría documentadas están exportadas", () => {
    for (const f of ["distance", "angle_to", "angle_diff"]) {
      expect(initPy).toContain(`"${f}"`);
      expect(python).toContain(f);
    }
    for (const f of ["distance", "angleTo", "angleDiff"]) {
      expect(typesTs).toContain(`export function ${f}(`);
      expect(javascript).toContain(f);
    }
    expect(initPy).toContain('"LocalSimulator"');
    expect(python).toContain("LocalSimulator");
    expect(python).toContain("arena-sim");
    expect(read("sdks/python/pyproject.toml")).toContain("arena-sim");
    expect(read("sdks/javascript/package.json")).toContain('"arena-sim"');
  });

  it("Java y .NET siguen siendo sólo una carpeta de reserva (la guía no promete un SDK)", () => {
    for (const lang of ["java", "dotnet"]) {
      const files = readdirSync(join(root, "sdks", lang));
      expect(files, `sdks/${lang} ya tiene contenido: actualiza la guía`).toEqual(["README.md"]);
      expect(read(`sdks/${lang}/README.md`)).toContain("Placeholder");
    }
    expect(index).toContain("no hay SDK Java");
    expect(index).toContain("no hay SDK .NET");
  });

  it("el SDK calcula forTick y no reconecta, como dice la guía", () => {
    expect(botPy).toContain('for_tick = observation["tick"] + self._decision_every_n_ticks');
    expect(indexTs).toContain("observation.tick + this.decisionEveryNTicks");
    expect(ciclo).toContain("no se reconecta");
  });
});
