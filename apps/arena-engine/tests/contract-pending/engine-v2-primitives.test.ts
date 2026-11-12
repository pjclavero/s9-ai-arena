/**
 * OLA 2 · ME · CONTRATO PENDIENTE · Equipo MC (primitivas Effect / Interference /
 * Deployable / Guidance / Action de `contracts/engine-v2.ts`).
 *
 * Los tipos y los NOMBRES de campo son los del BASE_SHA f07ff6f (`ActionDef`,
 * `DeployableDef`, `ProjectileDef`, `GuidanceDef`, `EffectDef`, `InterferenceProfile`).
 * En el BASE no existe ningún validador de estos bloques (el esquema de módulo los
 * rechaza por `unevaluatedProperties: false`), así que cada contrato falla por una
 * ASERCIÓN: «MC no expone un validador de bloques v2» (control positivo) y, una vez
 * expuesto, «un bloque válido se acepta / uno inválido se rechaza señalando el campo».
 *
 * ADAPTADOR: el único punto que MC puede tener que tocar es `loadValidator()` (ruta y
 * nombre de la función que valida una `ActionDef` y devuelve la lista de incidencias
 * `{ path, message }`; vacía = válida). El resto son DATOS tipados con el BASE.
 *
 * Dependencia de equipo: MC (packages/module-catalog). Ningún contenido real nuevo:
 * sólo literales de test.
 */
import { describe, expect } from "vitest";
import type { ActionDef, EffectDef } from "../../../../packages/module-catalog/contracts/engine-v2.js";
import { contractIt } from "../baseline/helpers.js";

type Issue = { path: string; message: string };
type Validator = (def: unknown) => Issue[];

const VALIDATOR_MODULE = "../../../../packages/module-catalog/v2/validate.js";

async function loadValidator(): Promise<Validator | null> {
  try {
    const mod: any = await import(/* @vite-ignore */ VALIDATOR_MODULE);
    return typeof mod.validateActionDef === "function" ? (mod.validateActionDef as Validator) : null;
  } catch (e: any) {
    // Sólo «módulo inexistente» cuenta como «MC aún no lo ha implementado»; un error de
    // sintaxis/carga de un módulo que SÍ existe es un fallo de código y se propaga.
    if (
      /Cannot find module|Failed to load url|Failed to resolve import|ERR_MODULE_NOT_FOUND/i.test(String(e?.message))
    ) {
      return null;
    }
    throw e;
  }
}

async function validator(): Promise<Validator> {
  const v = await loadValidator();
  expect(v, "MC debe exponer un validador de ActionDef (v2/validate.ts#validateActionDef)").not.toBeNull();
  return v!;
}

const enemyVehicles = { relations: ["enemy"], kinds: ["vehicle"] } as const;

const damageEffect: EffectDef = {
  primitive: "damage",
  strength: 50,
  damageType: "kinetic",
  targets: enemyVehicles,
  stacking: "none",
};

const fireAction: ActionDef = {
  kind: "fire",
  cooldownTicks: 90,
  cost: { energyEU: 10, ammo: 1 },
  projectile: {
    speedMs: 60,
    lifetimeTicks: 120,
    spreadRad: 0,
    guidance: { mode: "none" },
    onImpact: [damageEffect],
  },
};

const mineAction: ActionDef = {
  kind: "deploy",
  cooldownTicks: 60,
  cost: { energyEU: 4, charges: 1 },
  deployable: {
    lifetimeTicks: 5400,
    armDelayTicks: 30,
    maxActivePerOwner: 3,
    trigger: { kind: "proximity", radiusM: 2.5, targets: enemyVehicles },
    consumeOnTrigger: true,
    effects: [
      {
        primitive: "explosion",
        strength: 90,
        radiusM: 6,
        falloff: "linear",
        damageType: "explosive",
        targets: { relations: ["any"], kinds: ["vehicle"] },
        stacking: "none",
      },
    ],
    visibility: { allies: "revealed", enemies: "hidden", spectator: "hidden", signature: { proximity: 1 } },
    placement: { mode: "at_self" },
    ownership: { friendlyTrigger: "inherit" },
  },
};

const guidedAction: ActionDef = {
  ...fireAction,
  projectile: {
    ...fireAction.projectile!,
    guidance: {
      mode: "target",
      turnRateRads: 1.5,
      acquisitionRangeM: 80,
      lockRequirements: { channel: "radar", requiresLineOfSight: true, minLockTicks: 6 },
      trackingErrorRad: 0.02,
      onLockLost: "ballistic",
    },
  },
};

const jammerAction: ActionDef = {
  ...mineAction,
  deployable: {
    ...mineAction.deployable!,
    trigger: { kind: "timer", afterTicks: 1 },
    consumeOnTrigger: false,
    effects: [
      {
        primitive: "interference",
        strength: 1,
        radiusM: 20,
        durationTicks: 300,
        falloff: "step",
        targets: enemyVehicles,
        stacking: "replace",
        profile: {
          channels: { radio: { strength: 1, mode: "block" }, radar: { strength: 0.6, mode: "noise", noise: 3 } },
        },
      },
    ],
  },
};

const clone = <T>(x: T): T => structuredClone(x) as T;

/** Un bloque válido se acepta (control positivo: sin él, un «rechazado» no prueba nada). */
async function accepts(def: unknown, label: string): Promise<void> {
  const issues = (await validator())(def);
  expect(issues, `${label}: el bloque válido se rechazó`).toEqual([]);
}

/** Un bloque válido mutado se rechaza y el error señala el campo roto. */
async function rejects(valid: unknown, mutate: (d: any) => void, field: string): Promise<void> {
  await accepts(valid, "control positivo");
  const bad: any = clone(valid);
  mutate(bad);
  const issues = (await validator())(bad);
  expect(issues.length, `el bloque inválido (${field}) se aceptó`).toBeGreaterThan(0);
  expect(
    issues.some((i) => `${i.path} ${i.message}`.includes(field)),
    `ninguna incidencia señala «${field}»: ${JSON.stringify(issues)}`,
  ).toBe(true);
}

describe("MC · Action (fire / deploy)", () => {
  contractIt("MC", "una acción fire con projectile y una deploy con deployable son válidas", async () => {
    await accepts(fireAction, "fire");
    await accepts(mineAction, "deploy");
  });

  contractIt("MC", "una acción con projectile Y deployable a la vez se rechaza (exactamente un producto)", async () => {
    await rejects(fireAction, (d) => (d.deployable = clone(mineAction.deployable)), "deployable");
  });

  contractIt("MC", "una acción de un kind desconocido se rechaza señalando `kind`", async () => {
    await rejects(fireAction, (d) => (d.kind = "teleport"), "kind");
  });
});

describe("MC · Effect", () => {
  contractIt("MC", "un efecto de área sin falloff se rechaza (radiusM > 0 exige falloff)", async () => {
    await rejects(mineAction, (d) => delete d.deployable.effects[0].falloff, "falloff");
  });

  contractIt("MC", "una primitiva de efecto desconocida se rechaza señalando `primitive`", async () => {
    await rejects(fireAction, (d) => (d.projectile.onImpact[0].primitive = "teleport"), "primitive");
  });

  contractIt("MC", "un damageType fuera del registro se rechaza señalando `damageType`", async () => {
    await rejects(fireAction, (d) => (d.projectile.onImpact[0].damageType = "magic"), "damageType");
  });
});

describe("MC · Interference", () => {
  contractIt("MC", "un perfil de interferencia por canales (radio block + radar noise) es válido", async () => {
    await accepts(jammerAction, "jammer");
  });

  contractIt("MC", "el canal `optical` (sin consumidor) se rechaza: no hay campos falsos", async () => {
    await rejects(
      jammerAction,
      (d) => (d.deployable.effects[0].profile.channels = { optical: { strength: 1, mode: "block" } }),
      "optical",
    );
  });

  contractIt("MC", "una fuerza de canal fuera de [0, 1] se rechaza señalando `strength`", async () => {
    await rejects(jammerAction, (d) => (d.deployable.effects[0].profile.channels.radio.strength = 1.5), "strength");
  });
});

describe("MC · Deployable", () => {
  contractIt("MC", "un trigger timer sin afterTicks se rechaza señalando `afterTicks`", async () => {
    await rejects(jammerAction, (d) => delete d.deployable.trigger.afterTicks, "afterTicks");
  });

  contractIt("MC", "sin maxActivePerOwner el deployable se rechaza (sustituye a MAX_MINES_PER_VEHICLE)", async () => {
    await rejects(mineAction, (d) => delete d.deployable.maxActivePerOwner, "maxActivePerOwner");
  });

  contractIt("MC", "un trigger de kind desconocido se rechaza señalando `kind`", async () => {
    await rejects(mineAction, (d) => (d.deployable.trigger.kind = "psychic"), "kind");
  });
});

describe("MC · Guidance", () => {
  contractIt("MC", "guiado a blanco con lockRequirements y onLockLost es válido", async () => {
    await accepts(guidedAction, "guided");
  });

  contractIt("MC", "guiado a blanco sin lockRequirements se rechaza señalando `lockRequirements`", async () => {
    await rejects(guidedAction, (d) => delete d.projectile.guidance.lockRequirements, "lockRequirements");
  });

  contractIt("MC", "un modo de guiado desconocido se rechaza señalando `mode`", async () => {
    await rejects(guidedAction, (d) => (d.projectile.guidance.mode = "psychic"), "mode");
  });
});
