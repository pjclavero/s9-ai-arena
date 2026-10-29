/**
 * Un loadout con munición incompatible no pasa de `structure` (defensa en profundidad:
 * la API ya lo rechaza en submit). Antes llegaba hasta la batalla real y el cañón
 * rechazaba cada disparo con `no_ammo`.
 */
import { describe, it, expect } from "vitest";
import { BuildPipeline, type PipelineDeps } from "../src/pipeline.js";
import { InMemoryBuildStore } from "../src/store.js";
import { generateServiceKeypair } from "../src/signing.js";
import { withConfig } from "../src/config.js";
import { NullAuditSink } from "../src/audit-sink.js";
import type { LoadoutInput } from "../../../packages/module-catalog/types.js";
import { submission, pyGoodFiles, goodCandidate, referenceAgent } from "./fixtures.js";

const defender = (ammo: string): LoadoutInput => ({
  loadoutId: "def",
  revision: 2,
  catalogVersion: "mvp@1",
  chassis: "chassis.heavy@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "sensor_a", moduleId: "sensor.radar@1" },
    { slot: "turret_main", moduleId: "weapon.cannon@1" },
    { slot: "ammo_main", moduleId: ammo },
    { slot: "radio_a", moduleId: "radio.short@1" },
    { slot: "armor_front", moduleId: "armor.steel_front@1" },
  ],
});

function pipeline(onAgent: () => void) {
  const deps: PipelineDeps = {
    store: new InMemoryBuildStore(),
    config: withConfig(),
    signer: generateServiceKeypair(),
    audit: NullAuditSink,
    agentResolver: () => {
      onAgent();
      return goodCandidate;
    },
    referenceAgent,
  };
  return new BuildPipeline(deps);
}

describe("pipeline · munición incompatible", () => {
  it("cañón + ammo.standard@1 como módulo aparte → falla en structure y no se ejecuta nada más", async () => {
    let agents = 0;
    const build = await pipeline(() => agents++).run(
      submission(pyGoodFiles(), { archetype: "heavy", loadout: defender("ammo.standard@1") }),
    );
    expect(build.status).toBe("failed");
    const structure = build.stages.find((s) => s.name === "structure")!;
    expect(structure.status).toBe("failed");
    expect(structure.message).toBe(
      "loadout inválido: El módulo weapon.cannon@1 no admite ammo.standard@1. Municiones compatibles: ammo.ap, ammo.he.",
    );
    for (const name of ["build", "protocol_test", "smoke_battle", "sign", "publish"]) {
      expect(build.stages.find((s) => s.name === name)!.status, name).not.toBe("passed");
    }
    expect(agents).toBe(0); // ni protocol_test ni smoke_battle llegaron a arrancar el bot
    expect(build.artifactHash ?? null).toBeNull();
    expect(build.signature ?? null).toBeNull();
  });

  it("cañón + ammo.ap@1 (defensor v3 de producción) → recorre todas las etapas", async () => {
    const build = await pipeline(() => {}).run(
      submission(pyGoodFiles(), { archetype: "heavy", loadout: defender("ammo.ap@1") }),
    );
    expect(build.stages.map((s) => `${s.name}:${s.status}`)).toEqual(build.stages.map((s) => `${s.name}:passed`));
    expect(build.status).toBe("passed");
  });
});
