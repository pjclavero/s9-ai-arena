/**
 * UX-EDITOR · Panel de propiedades del objeto seleccionado, sincronizado con el
 * lienzo (los mismos datos: mover en el lienzo cambia aquí y viceversa).
 *
 * Nombres para usuario normal (Posición X/Y, Anchura, Altura, Radio, Equipo, Daño
 * por segundo); sin ids internos ni nombres del motor. No hay campo de rotación: el
 * visor de batallas no la dibuja (ver objects.ts), así que no se ofrece.
 */
import { useEffect, useState } from "react";
import type { EditorMap, ObjRef } from "./model.js";
import { engineBaseRadius, getObj, isPointKind, isRotated, kindName, objLabel, type AnyObj } from "./objects.js";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Campo numérico que deja teclear valores intermedios («1.», «-») sin perderlos. */
export function NumField(props: {
  label: string;
  value: number | undefined;
  onChange(v: number): void;
  min?: number;
  step?: number;
  unit?: string;
  testId?: string;
}) {
  const shown = typeof props.value === "number" && Number.isFinite(props.value) ? String(r3(props.value)) : "";
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  return (
    <label className="s9-me-field">
      <span>
        {props.label}
        {props.unit ? ` (${props.unit})` : ""}
      </span>
      <input
        type="number"
        inputMode="decimal"
        aria-label={props.label}
        data-testid={props.testId}
        step={props.step ?? 0.5}
        min={props.min}
        value={focused ? text : shown}
        onFocus={() => {
          setFocused(true);
          setText(shown);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() === "" || !Number.isFinite(n)) return;
          if (props.min !== undefined && n < props.min) return;
          props.onChange(n);
        }}
      />
    </label>
  );
}

const TEAMS: [string, string][] = [
  ["red", "Rojo"],
  ["blue", "Azul"],
];

interface Props {
  map: EditorMap;
  selected: ObjRef | null;
  onPatch(ref: ObjRef, patch: Partial<AnyObj>, field: string): void;
  onDuplicate(): void;
  onDelete(): void;
}

export function PropertiesPanel({ map, selected, onPatch, onDuplicate, onDelete }: Props) {
  const o = getObj(map, selected);
  if (!selected || !o) {
    return (
      <div className="s9-me-panel" data-testid="editor-props-empty">
        <h2>Propiedades</h2>
        <p className="s9-me-muted">
          Selecciona un objeto en el mapa (o en la lista) para ver y ajustar su posición y su tamaño.
        </p>
      </div>
    );
  }
  const ref = selected;
  const set = (field: string, patch: Partial<AnyObj>) => onPatch(ref, patch, field);
  const pos = o.position ?? { x: 0, y: 0 };
  const teamValue = typeof o.team === "string" ? o.team : "";
  const teamOpts =
    TEAMS.some(([v]) => v === teamValue) || !teamValue ? TEAMS : [...TEAMS, [teamValue, `Equipo ${teamValue}`]];
  const headingDeg = typeof o.heading === "number" ? Math.round((o.heading * 180) / Math.PI) : 0;

  return (
    <fieldset className="s9-me-panel" data-testid="editor-props">
      <legend>{objLabel(map, ref)}</legend>
      <p className="s9-me-muted" data-testid="editor-props-kind">
        Tipo: {kindName(ref.kind, o)}
      </p>
      {o.position && (
        <div className="s9-me-row">
          <NumField label="Posición X" unit="m" value={pos.x} onChange={(x) => set("x", { position: { ...pos, x } })} />
          <NumField label="Posición Y" unit="m" value={pos.y} onChange={(y) => set("y", { position: { ...pos, y } })} />
        </div>
      )}
      {!isPointKind(ref.kind) && o.shape === "rect" && (
        <div className="s9-me-row">
          <NumField label="Anchura" unit="m" min={0.1} value={o.widthM} onChange={(v) => set("w", { widthM: v })} />
          <NumField label="Altura" unit="m" min={0.1} value={o.heightM} onChange={(v) => set("h", { heightM: v })} />
        </div>
      )}
      {!isPointKind(ref.kind) && o.shape === "circle" && (
        <NumField label="Radio" unit="m" min={0.1} value={o.radiusM} onChange={(v) => set("r", { radiusM: v })} />
      )}
      {o.shape === "polygon" && (
        <p className="s9-me-muted">Forma poligonal: se puede mover, pero su contorno no se edita aquí.</p>
      )}
      {isRotated(o) && (
        <p className="s9-me-note" data-testid="editor-rotation-note">
          Este objeto viene girado {Math.round(((o.rotation ?? 0) * 180) / Math.PI)}°. Se conserva tal cual, pero el
          editor no cambia el giro: el visor de batallas lo dibuja sin girar.
        </p>
      )}
      {(ref.kind === "spawn" || ref.kind === "base" || ref.kind === "flag") && (
        <label className="s9-me-field">
          <span>Equipo</span>
          <select aria-label="Equipo" value={teamValue} onChange={(e) => set("team", { team: e.target.value })}>
            {teamOpts.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      )}
      {ref.kind === "spawn" && (
        <NumField
          label="Mira hacia"
          unit="grados, 0 = derecha"
          step={15}
          value={headingDeg}
          onChange={(d) => set("heading", { heading: r3((d * Math.PI) / 180) })}
        />
      )}
      {ref.kind === "zone" && (
        <label className="s9-me-field">
          <span>Tipo de zona</span>
          <select
            aria-label="Tipo de zona"
            value={o.zoneType ?? "damage"}
            onChange={(e) =>
              set("zoneType", {
                zoneType: e.target.value,
                ...(e.target.value === "damage" && o.damagePerSecond === undefined ? { damagePerSecond: 8 } : {}),
              })
            }
          >
            <option value="damage">Zona de daño</option>
            <option value="capture">Zona de captura</option>
            {o.zoneType === "no_entry" && <option value="no_entry">Zona prohibida</option>}
            {o.zoneType === "cover" && <option value="cover">Zona de cobertura</option>}
          </select>
        </label>
      )}
      {ref.kind === "zone" && o.zoneType === "damage" && (
        <NumField
          label="Daño por segundo"
          min={0}
          step={1}
          value={o.damagePerSecond ?? 0}
          onChange={(v) => set("dps", { damagePerSecond: v })}
        />
      )}
      {ref.kind === "base" && (
        <p className="s9-me-note" data-testid="editor-base-note">
          En batalla la base cuenta como el <strong>círculo relleno</strong> de {engineBaseRadius(o).toFixed(1)} m de
          radio: el mayor que cabe en el rectángulo discontinuo.
        </p>
      )}
      <div className="s9-me-row">
        <button type="button" onClick={onDuplicate}>
          Duplicar objeto
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Eliminar objeto
        </button>
      </div>
    </fieldset>
  );
}
