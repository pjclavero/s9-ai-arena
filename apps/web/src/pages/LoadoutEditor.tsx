/**
 * T7.4 · Editor de loadout: presupuesto, masa y energía EN VIVO usando el
 * validador REAL de E3 compilado para navegador (import directo del paquete).
 * El cliente solo bloquea el guardado como ayuda; la autoridad es el servidor,
 * que re-ejecuta el mismo validador en POST /bots/{id}/loadouts (422).
 *
 * R3.7 (ERR-VIS-04):
 *  - carga la revisión vigente del bot vía `initial` (el llamante remonta con
 *    key={bot.id} para que el estado no se arrastre entre bots);
 *  - la munición se ELIGE explícitamente (antes se auto-asignaba la primera con
 *    un non-null assertion que reventaba con catálogos incompletos);
 *  - sin non-null assertions: un catálogo incompleto degrada a un aviso
 *    accesible (role="alert"), nunca a pantalla en blanco;
 *  - comparar contra la revisión cargada y "guardar como nueva revisión"
 *    (duplicar) con el diff a la vista.
 */
import { useMemo, useState } from "react";
import { validateLoadout, type Violation } from "../../../../packages/module-catalog/validator/index.js";
import {
  findModule,
  type LoadoutInput,
  type ModuleDefinition,
} from "../../../../packages/module-catalog/types.js";

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

export function computeLive(
  draft: LoadoutDraft,
  catalog: ModuleDefinition[],
  budgetCredits: number,
): LiveSummary {
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

/** Diff legible entre la revisión cargada y el borrador actual (comparar). */
export function diffDrafts(base: LoadoutDraft, draft: LoadoutDraft): string[] {
  const changes: string[] = [];
  if (base.chassis !== draft.chassis) changes.push(`chasis: ${base.chassis} → ${draft.chassis}`);
  const baseBySlot = new Map(base.modules.map((m) => [m.slot, m]));
  const draftBySlot = new Map(draft.modules.map((m) => [m.slot, m]));
  for (const [slot, m] of draftBySlot) {
    const prev = baseBySlot.get(slot);
    if (!prev) changes.push(`${slot}: (vacío) → ${m.moduleId}`);
    else if (prev.moduleId !== m.moduleId) changes.push(`${slot}: ${prev.moduleId} → ${m.moduleId}`);
    else if ((prev.ammo ?? "") !== (m.ammo ?? "")) changes.push(`${slot} munición: ${prev.ammo ?? "—"} → ${m.ammo ?? "—"}`);
  }
  for (const [slot, prev] of baseBySlot) {
    if (!draftBySlot.has(slot)) changes.push(`${slot}: ${prev.moduleId} → (vacío)`);
  }
  return changes;
}

function slotsFromDraft(d: LoadoutDraft | undefined): { modules: Record<string, string>; ammo: Record<string, string> } {
  const modules: Record<string, string> = {};
  const ammo: Record<string, string> = {};
  for (const m of d?.modules ?? []) {
    modules[m.slot] = m.moduleId;
    if (m.ammo) ammo[m.slot] = m.ammo;
  }
  return { modules, ammo };
}

export function LoadoutEditor(props: {
  catalog: ModuleDefinition[];
  catalogVersion: string;
  budgetCredits: number;
  /** Revisión vigente del bot: el editor arranca desde ella (ERR-VIS-04). */
  initial?: LoadoutDraft;
  /** Nº de la revisión cargada, solo informativo. */
  loadedRevision?: number;
  onSave: (draft: LoadoutDraft) => Promise<Violation[] | null>;
}) {
  const chassisOptions = props.catalog.filter((m) => m.category === "chassis");
  const initialSlots = useMemo(() => slotsFromDraft(props.initial), [props.initial]);
  const [chassis, setChassis] = useState<string>(
    props.initial?.chassis ?? (chassisOptions[0] ? versioned(chassisOptions[0]) : ""),
  );
  const [slots, setSlots] = useState<Record<string, string>>(initialSlots.modules);
  const [ammoBySlot, setAmmoBySlot] = useState<Record<string, string>>(initialSlots.ammo);
  const [serverViolations, setServerViolations] = useState<Violation[]>([]);
  const [saved, setSaved] = useState(false);

  const chassisDef = findModule(props.catalog, chassis);

  const draft: LoadoutDraft = useMemo(
    () => ({
      catalogVersion: props.catalogVersion,
      chassis,
      modules: Object.entries(slots)
        .filter(([, moduleId]) => moduleId)
        .map(([slot, moduleId]) => {
          const def = findModule(props.catalog, moduleId);
          if (def?.category === "weapon" && def.acceptsAmmo?.length) {
            // Munición elegida EXPLÍCITAMENTE por el usuario; si aún no eligió,
            // la primera compatible presente en el catálogo (sin asserts).
            const fallback = props.catalog.find((m) => m.category === "ammo" && def.acceptsAmmo?.includes(m.id));
            const ammo = ammoBySlot[slot] ?? (fallback ? versioned(fallback) : undefined);
            return { slot, moduleId, ammo };
          }
          return { slot, moduleId };
        }),
    }),
    [chassis, slots, ammoBySlot, props.catalog, props.catalogVersion],
  );

  const live = useMemo(
    () => computeLive(draft, props.catalog, props.budgetCredits),
    [draft, props.catalog, props.budgetCredits],
  );
  const blocked = live.violations.length > 0;
  const diff = props.initial ? diffDrafts(props.initial, draft) : [];

  // ERR-VIS-04: catálogo incompleto ⇒ aviso accesible, nunca pantalla en blanco.
  if (chassisOptions.length === 0) {
    return (
      <div className="card" role="alert" data-testid="editor-catalog-error">
        <h2>Editor de loadout</h2>
        <p className="error">El catálogo de módulos no está disponible o no contiene ningún chasis. Recarga o avisa al administrador.</p>
      </div>
    );
  }
  if (!chassisDef) {
    return (
      <div className="card" role="alert" data-testid="editor-catalog-error">
        <h2>Editor de loadout</h2>
        <p className="error">
          El chasis guardado ({chassis || "—"}) ya no existe en el catálogo {props.catalogVersion}.
        </p>
        <button type="button" onClick={() => { setChassis(versioned(chassisOptions[0])); setSlots({}); setAmmoBySlot({}); }}>
          Empezar con {chassisOptions[0].name}
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Editor de loadout</h2>
      {props.loadedRevision !== undefined && (
        <p data-testid="loaded-revision">
          Editando sobre la revisión <strong>{props.loadedRevision}</strong> (guardar crea una revisión nueva).
        </p>
      )}
      <label>
        Chasis{" "}
        <select
          aria-label="chasis"
          value={chassis}
          onChange={(e) => {
            setChassis(e.target.value);
            setSlots({});
            setAmmoBySlot({});
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
            const selectedDef = findModule(props.catalog, slots[slot.id] ?? "");
            const ammoOptions =
              selectedDef?.category === "weapon" && selectedDef.acceptsAmmo?.length
                ? props.catalog.filter((m) => m.category === "ammo" && selectedDef.acceptsAmmo?.includes(m.id))
                : [];
            return (
              <tr key={slot.id}>
                <td>
                  {slot.id} <small>({slot.accepts.join("/")}, ≤{slot.maxSize})</small>
                </td>
                <td>
                  <select
                    aria-label={`slot-${slot.id}`}
                    value={slots[slot.id] ?? ""}
                    onChange={(e) => {
                      setSlots((s) => ({ ...s, [slot.id]: e.target.value }));
                      setAmmoBySlot((a) => {
                        const next = { ...a };
                        delete next[slot.id]; // el arma cambió: la munición elegida ya no aplica
                        return next;
                      });
                    }}
                  >
                    <option value="">— vacío —</option>
                    {candidates.map((m) => (
                      <option key={versioned(m)} value={versioned(m)}>
                        {m.name} ({m.costCredits} cr, {m.massKg} kg)
                      </option>
                    ))}
                  </select>
                  {ammoOptions.length > 0 && (
                    <>
                      {" "}
                      <label>
                        Munición{" "}
                        <select
                          aria-label={`ammo-${slot.id}`}
                          value={ammoBySlot[slot.id] ?? versioned(ammoOptions[0])}
                          onChange={(e) => setAmmoBySlot((a) => ({ ...a, [slot.id]: e.target.value }))}
                        >
                          {ammoOptions.map((m) => (
                            <option key={versioned(m)} value={versioned(m)}>
                              {m.name} ({m.costCredits} cr)
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  {selectedDef?.category === "weapon" && selectedDef.acceptsAmmo?.length && ammoOptions.length === 0 ? (
                    <span className="error" role="alert">
                      {" "}sin munición compatible en el catálogo
                    </span>
                  ) : null}
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

      {diff.length > 0 && (
        <div data-testid="draft-diff">
          <h3>Cambios respecto a la revisión {props.loadedRevision ?? "cargada"}</h3>
          <ul>
            {diff.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="reset-draft"
            onClick={() => {
              if (!props.initial) return;
              setChassis(props.initial.chassis);
              const s = slotsFromDraft(props.initial);
              setSlots(s.modules);
              setAmmoBySlot(s.ammo);
            }}
          >
            Descartar cambios (volver a la revisión {props.loadedRevision ?? "cargada"})
          </button>
        </div>
      )}

      {live.violations.length > 0 && (
        <ul data-testid="violations" role="alert">
          {live.violations.map((v, i) => (
            <li key={i} className="error">
              [{v.code}] {v.message}
            </li>
          ))}
        </ul>
      )}
      {serverViolations.length > 0 && (
        <ul data-testid="server-violations" role="alert">
          {serverViolations.map((v, i) => (
            <li key={i} className="error">
              servidor: [{v.code}] {v.message}
            </li>
          ))}
        </ul>
      )}
      {saved && (
        <p className="ok" data-testid="saved" role="status">
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
        {props.initial ? "Guardar como nueva revisión" : "Guardar revisión"}
      </button>
    </div>
  );
}
