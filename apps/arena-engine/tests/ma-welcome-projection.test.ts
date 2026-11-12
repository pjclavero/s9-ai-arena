/**
 * OLA 2 · MA · PRIVATE_EQUIPMENT en el WELCOME REAL del ProtocolServer (contrato §12).
 *
 * El WELCOME es la proyección `bot_team`/`self` del vehículo del propio bot: lleva SUS
 * módulos, pero no el `ModuleSpec` entero del motor. Cada `specs` sólo contiene
 * propiedades del catálogo con efecto real (ACTIVE) o de validación; nunca FUTURE ni
 * claves que el catálogo no declara. Ningún compañero recibe el loadout de otro.
 * Mutante de calibración: volver a `{ slot, moduleId, category, ...specs }` ⇒ rojo.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { ProtocolServer } from "../src/protocol-server.js";
import { emptyArena, gunnerLoadout, minerLoadout } from "../src/fixtures.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { effectOf } from "../../../packages/module-catalog/effect-status.js";

beforeAll(async () => {
  await initPhysics();
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

describe("PRIVATE_EQUIPMENT · WELCOME proyectado", () => {
  it("specs = sólo campos de catálogo ACTIVE/validación de módulos propios; teammates sólo ids", async () => {
    const battle = await Battle.create({
      battleId: "ma-welcome",
      seed: "ma-welcome",
      ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 30 }),
      map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_a", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "bot_b", team: "red", spec: minerLoadout() },
        { id: "veh_3", botId: "bot_c", team: "blue", spec: gunnerLoadout() },
        { id: "veh_4", botId: "bot_d", team: "blue", spec: minerLoadout() },
      ],
    });
    stops.push(() => battle.free());
    const server = new ProtocolServer({
      battle,
      catalogVersion: "mvp@1",
      expected: [{ botId: "bot_a", vehicleId: "veh_1", battleToken: "t".repeat(16) }],
      tickIntervalMs: 3,
      decisionDeadlineMs: 50,
    });
    stops.push(() => server.stop());
    const welcome = (server as any).buildWelcome({ botId: "bot_a", vehicleId: "veh_1", battleToken: "t".repeat(16) });

    const own = battle.getVehicle("veh_1")!.spec;
    // Lleva SUS módulos (mismo slot/moduleId/category)…
    expect(welcome.vehicle.modules.map((m: any) => [m.slot, m.moduleId, m.category])).toEqual(
      own.modules.map((m) => [m.slot, m.moduleId, m.category]),
    );
    let futureSeen = 0;
    for (const m of welcome.vehicle.modules) {
      const full = own.modules.find((x) => x.slot === m.slot)! as unknown as Record<string, unknown>;
      // …pero NO el ModuleSpec entero: control positivo de que el motor sí tiene más.
      for (const k of Object.keys(full)) {
        if (["slot", "moduleId", "category"].includes(k) || full[k] === undefined) continue;
        const prop = k === "perActionEU" ? "power.perActionEU" : k === "passiveEUs" ? "power.passiveEUs" : k;
        const eff = effectOf(m.category, prop);
        const allowed = !!eff && (eff.status === "ACTIVE" || (eff.status === "PARTIAL" && eff.validation));
        if (!allowed) futureSeen++;
        expect(Object.prototype.hasOwnProperty.call(m.specs, k), `${m.slot}.${k}`).toBe(allowed);
      }
    }
    expect(futureSeen, "control: el ModuleSpec del motor lleva campos no publicables").toBeGreaterThan(0);
    // Los aliados: sólo ids (nunca su loadout).
    expect(welcome.teammates).toEqual(["v_2"]); // id público, no veh_N
    expect(JSON.stringify(welcome)).not.toContain("mine_bay");
  });
});
