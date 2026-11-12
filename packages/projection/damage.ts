/**
 * OLA 2 · MB · Proyectores PUROS de daño y torreta (contratos `ProjectDamageForViewer` y
 * `ProjectTurret` de ./contracts.ts). Los llama `projectFrame` (Equipo MA); MB sólo
 * aporta la función y las filas de política de daño/torreta.
 *
 * Entrada: vistas de SÓLO LECTURA (`InternalDamageView`, `PublicTurretTrack`), nunca
 * `Vehicle` (F7). Salida: lo que una audiencia puede ver, cuantizado con las funciones
 * del contrato de daño (packages/game-rules/damage-contract.ts):
 *  - casco: `hullLevel` N = 20 (D-B5); nunca hp absoluto ni hpMax;
 *  - blindaje: sólo la rotura por sector (D-B4) si la política lo publica para esa
 *    audiencia; ni hp, ni reducción, ni material;
 *  - torreta: ángulo normalizado y cuantizado (la tasa y el arco son públicos por la
 *    montura, D-B2).
 * Sin RNG, sin E/S, sin estado.
 */
import { armorBroken, hullLevel, quantizeTurretHeading } from "../game-rules/damage-contract.js";
import type {
  AudienceClass,
  DisclosurePolicy,
  FieldVisibility,
  InternalDamageView,
  ProjectDamageForViewer,
  ProjectTurret,
  PublicDamageState,
  PublicTurretState,
} from "./contracts.js";

type SectorName = "front" | "left" | "right" | "rear";
const SECTOR_ORDER: readonly SectorName[] = ["front", "left", "right", "rear"];

/** Campos canónicos de daño y torreta que gobierna la política. */
export const DAMAGE_FIELDS = {
  hullLevel: "vehicle.hullLevel",
  armorBroken: "vehicle.armorBroken",
  turretHeading: "vehicle.turretHeading",
} as const;

const PUBLIC_AUDIENCES: readonly AudienceClass[] = ["public_live", "broadcast", "public_replay"];

/**
 * Filas de política de MB (daño y torreta). Lista blanca: lo que no está aquí no sale.
 * MA las fusiona en la `DisclosurePolicy` versionada. Igual en R1 y R2 (es estado
 * dinámico, no equipamiento).
 */
const SANITIZED_FOR: readonly AudienceClass[] = [...PUBLIC_AUDIENCES, "owner", "team", "staff", "bot_team"];
const sanitizedRow = (): Readonly<Partial<Record<AudienceClass, FieldVisibility>>> => {
  const row: Partial<Record<AudienceClass, FieldVisibility>> = {};
  for (const a of SANITIZED_FOR) row[a] = "SANITIZED";
  return Object.freeze(row);
};

export const DAMAGE_POLICY_ROWS: DisclosurePolicy["fields"] = Object.freeze({
  [DAMAGE_FIELDS.hullLevel]: sanitizedRow(),
  [DAMAGE_FIELDS.armorBroken]: sanitizedRow(),
  [DAMAGE_FIELDS.turretHeading]: sanitizedRow(),
  // Exactos: sólo la etapa interna. Nunca en una proyección (fila vacía = PRIVATE).
  "vehicle.hullHp": Object.freeze({}),
  "vehicle.armor.hp": Object.freeze({}),
  "vehicle.armor.reduction": Object.freeze({}),
});

function visibility(policy: DisclosurePolicy, field: string, audience: AudienceClass): FieldVisibility {
  const row = Object.prototype.hasOwnProperty.call(policy.fields, field) ? policy.fields[field] : undefined;
  const v = row && Object.prototype.hasOwnProperty.call(row, audience) ? row[audience] : undefined;
  return v ?? "PRIVATE";
}

const shown = (v: FieldVisibility) => v === "PUBLIC" || v === "SANITIZED";

export const projectDamageForViewer: ProjectDamageForViewer = (view: InternalDamageView, ctx): PublicDamageState => {
  const out: { alive: boolean; hullLevel: number; armorBroken?: Partial<Record<SectorName, boolean>> } = {
    alive: view.alive,
    // Sin permiso para el nivel, sólo se distingue vivo (1) de muerto (0).
    hullLevel: shown(visibility(ctx.policy, DAMAGE_FIELDS.hullLevel, ctx.audienceClass))
      ? hullLevel(view.hullHp, view.hullHpMax)
      : view.alive
        ? 1
        : 0,
  };
  if (shown(visibility(ctx.policy, DAMAGE_FIELDS.armorBroken, ctx.audienceClass))) {
    const broken: Partial<Record<SectorName, boolean>> = {};
    for (const s of SECTOR_ORDER) {
      const a = view.armor[s];
      if (a) broken[s] = armorBroken(a.hp, a.hpMax);
    }
    out.armorBroken = broken;
  }
  return out;
};

export const projectTurret: ProjectTurret = (track, _ctx): PublicTurretState => ({
  heading: quantizeTurretHeading(track.heading),
});
