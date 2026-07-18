/**
 * T7.4 · Editor de loadout: presupuesto, masa y energía EN VIVO usando el
 * validador REAL de E3 compilado para navegador (import directo del paquete).
 * El cliente solo bloquea el guardado como ayuda; la autoridad es el servidor,
 * que re-ejecuta el mismo validador en POST /bots/{id}/loadouts (422).
 */
import { useMemo, useState } from "react";
import { validateLoadout, type Violation } from "../../../../packages/module-catalog/validator/index.js";
import { findModule, type LoadoutInput, type ModuleDefinition } from "../../../../packages/module-catalog/types.js";

export interface LoadoutDraft {
  catalogVersion: string;
  chassis: string;
  modules: { slot: string; moduleId: string; ammo?: string }[];
}

export interface LiveSummary {
  costCredits: number;
  massKg: number;
  energyBalanceEUs: number;
  violations: Violation[];
}

export function computeLive(draft: LoadoutDraft, catalog: ModuleDefinition[], budgetCredits: number): LiveSummary {
  const input: LoadoutInput = { loadoutId: "editor", revision: 1, ...draft };
  const violations = validateLoadout(input, catalog, budgetCredits);
  const chassisDef = findModule(catalog, draft.chassis);
  const defs = [chassisDef, ...draft.modules.map((m) => findModule(catalog, m.moduleId))].filter(
    (d): d is ModuleDefinition => !!d,
  );
  const costCredits = defs.reduce((s, d) => s + d.costCredits, 0);
  const massKg = defs.reduce((s, d) => s + d.massKg, 0);
  const generation = defs.filter((d) => d.category === "power").reduce((s, d) => s + (d.generationEUs ?? 0), 0);
  const passive = defs.reduce((s, d) => s + (d.power?.passiveEUs ?? 0), 0);
  return { costCredits, massKg, energyBalanceEUs: generation - passive, violations };
}

const versioned = (m: ModuleDefinition) => `${m.id}@${m.version}`;

export function LoadoutEditor(props: {
  catalog: ModuleDefinition[];
  catalogVersion: string;
  budgetCredits: number;
  onSave: (draft: LoadoutDraft) => Promise<Violation[] | null>;
}) {
  const chassisOptions = props.catalog.filter((m) => m.category === "chassis");
  const [chassis, setChassis] = useState<string>(versioned(chassisOptions[0]));
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [serverViolations, setServerViolations] = useState<Violation[]>([]);
  const [saved, setSaved] = useState(false);

  const chassisDef = findModule(props.catalog, chassis)!;
  const draft: LoadoutDraft = useMemo(
    () => ({
      catalogVersion: props.catalogVersion,
      chassis,
      modules: Object.entries(slots)
        .filter(([, moduleId]) => moduleId)
        .map(([slot, moduleId]) => {
          const def = findModule(props.catalog, moduleId);
          const ammo =
            def?.category === "weapon" && def.acceptsAmmo?.length
              ? versioned(props.catalog.find((m) => m.category === "ammo" && m.id === def.acceptsAmmo![0])!)
              : undefined;
          return { slot, moduleId, ammo };
        }),
    }),
    [chassis, slots, props.catalog, props.catalogVersion],
  );

  const live = useMemo(
    () => computeLive(draft, props.catalog, props.budgetCredits),
    [draft, props.catalog, props.budgetCredits],
  );
  const blocked = live.violations.length > 0;

  return (
    <div className="card">
      <h2>Editor de loadout</h2>
      <label>
        Chasis{" "}
        <select
          aria-label="chasis"
          value={chassis}
          onChange={(e) => {
            setChassis(e.target.value);
            setSlots({});
          }}
        >
          {chassisOptions.map((c) => (
            <option key={versioned(c)} value={versioned(c)}>
              {c.name} ({c.costCredits} cr)
            </option>
          ))}
        </select>
      </label>

      <table>
        <tbody>
          {(chassisDef.slots ?? []).map((slot) => {
            const candidates = props.catalog.filter(
              (m) =>
                slot.accepts.includes(m.category) &&
                (!slot.sector || m.sector === slot.sector || m.category !== "armor"),
            );
            return (
              <tr key={slot.id}>
                <td>
                  {slot.id}{" "}
                  <small>
                    ({slot.accepts.join("/")}, ≤{slot.maxSize})
                  </small>
                </td>
                <td>
                  <select
                    aria-label={`slot-${slot.id}`}
                    value={slots[slot.id] ?? ""}
                    onChange={(e) => setSlots((s) => ({ ...s, [slot.id]: e.target.value }))}
                  >
                    <option value="">— vacío —</option>
                    {candidates.map((m) => (
                      <option key={versioned(m)} value={versioned(m)}>
                        {m.name} ({m.costCredits} cr, {m.massKg} kg)
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p>
        <span className={live.costCredits > props.budgetCredits ? "error" : "ok"} data-testid="live-cost">
          Coste: {live.costCredits}/{props.budgetCredits} cr
        </span>{" "}
        · <span data-testid="live-mass">Masa: {live.massKg} kg</span> ·{" "}
        <span className={live.energyBalanceEUs < 0 ? "error" : "ok"} data-testid="live-energy">
          Energía: {live.energyBalanceEUs >= 0 ? "+" : ""}
          {live.energyBalanceEUs} EU/s
        </span>
      </p>

      {live.violations.length > 0 && (
        <ul data-testid="violations">
          {live.violations.map((v, i) => (
            <li key={i} className="error">
              [{v.code}] {v.message}
            </li>
          ))}
        </ul>
      )}
      {serverViolations.length > 0 && (
        <ul data-testid="server-violations">
          {serverViolations.map((v, i) => (
            <li key={i} className="error">
              servidor: [{v.code}] {v.message}
            </li>
          ))}
        </ul>
      )}
      {saved && (
        <p className="ok" data-testid="saved">
          Revisión de loadout guardada.
        </p>
      )}

      <button
        disabled={blocked}
        data-testid="save-loadout"
        onClick={async () => {
          setSaved(false);
          // Validación final SIEMPRE en servidor (DoD T7.4): esto solo envía.
          const errors = await props.onSave(draft);
          if (errors && errors.length > 0) setServerViolations(errors);
          else {
            setServerViolations([]);
            setSaved(true);
          }
        }}
      >
        Guardar revisión
      </button>
    </div>
  );
}
