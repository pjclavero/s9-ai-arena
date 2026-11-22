/**
 * ADM-1 · Administración → «Ajustes del sistema». Lista las claves REGISTRADAS por el servidor
 * (`GET /admin/settings`), permite editarlas (`PATCH /admin/settings`, validado y auditado en la
 * API) y AVISA de las que requieren reinicio del servicio consumidor. La UI no inventa claves ni
 * calcula límites: pinta lo que devuelve la API; la autorización la hace la API (sólo admin).
 */
import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../../api.js";
import { Button, EmptyState, ErrorState, FormError, LoadingState, Panel, StatusBadge } from "../../ui/primitives.js";

export type SettingValue = number | boolean | string;

export interface SystemSetting {
  key: string;
  type: "integer" | "number" | "boolean" | "enum";
  min: number | null;
  max: number | null;
  options: string[] | null;
  default: SettingValue;
  consumer: string;
  apply: "hot" | "restart";
  requiresRestart: boolean;
  description: string;
  envCeiling: number | null;
  value: SettingValue;
  source: "database" | "environment" | "default";
  version: number;
  updatedAt: string | null;
}

interface PatchResult {
  settings: SystemSetting[];
  changed: { key: string; requiresRestart: boolean }[];
  pendingRestart: string[];
}

const SOURCE_TEXT: Record<SystemSetting["source"], string> = {
  database: "guardado",
  environment: "entorno",
  default: "por defecto",
};

/** Texto del rango/techo que ve el admin (lo que la API validará). */
export function rangeText(s: SystemSetting): string {
  if (s.type === "boolean") return "sí / no";
  if (s.type === "enum") return (s.options ?? []).join(" | ");
  const ceil = s.envCeiling !== null ? ` · techo del entorno: ${s.envCeiling}` : "";
  return `${s.min}–${s.max}${ceil}`;
}

/** Convierte lo tecleado al tipo de la clave (la API vuelve a validar). */
export function parseDraft(s: SystemSetting, raw: string | boolean): SettingValue | undefined {
  if (s.type === "boolean") return typeof raw === "boolean" ? raw : raw === "true";
  if (s.type === "enum") return String(raw);
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function SettingRow(props: { s: SystemSetting; busy: boolean; onSave: (s: SystemSetting, v: SettingValue) => void }) {
  const { s } = props;
  const [draft, setDraft] = useState<string | boolean>(typeof s.value === "boolean" ? s.value : String(s.value));
  useEffect(() => setDraft(typeof s.value === "boolean" ? s.value : String(s.value)), [s.value, s.version]);
  const parsed = parseDraft(s, draft);
  const dirty = parsed !== undefined && parsed !== s.value;
  const id = `setting-${s.key}`;
  return (
    <tr data-testid={`setting-row-${s.key}`}>
      <td>
        <label htmlFor={id}>
          <code>{s.key}</code>
        </label>
        <br />
        <small>{s.description}</small>
      </td>
      <td>
        {s.type === "boolean" ? (
          <input
            id={id}
            type="checkbox"
            data-testid={`setting-input-${s.key}`}
            checked={draft === true}
            onChange={(e) => setDraft(e.target.checked)}
          />
        ) : s.type === "enum" ? (
          <select id={id} data-testid={`setting-input-${s.key}`} value={String(draft)} onChange={(e) => setDraft(e.target.value)}>
            {(s.options ?? []).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            type="number"
            data-testid={`setting-input-${s.key}`}
            min={s.min ?? undefined}
            max={s.envCeiling ?? s.max ?? undefined}
            step={s.type === "integer" ? 1 : "any"}
            value={String(draft)}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        <br />
        <small>{rangeText(s)}</small>
      </td>
      <td>
        <span data-testid={`setting-apply-${s.key}`} data-apply={s.apply}>
          {s.requiresRestart ? (
            <StatusBadge variant="warn">Requiere reiniciar «{s.consumer}»</StatusBadge>
          ) : (
            <StatusBadge variant="ok">En caliente (≈5 s)</StatusBadge>
          )}
        </span>
        <br />
        <small>
          Lee: {s.consumer} · Origen: {SOURCE_TEXT[s.source]}
        </small>
      </td>
      <td>
        <Button
          data-testid={`setting-save-${s.key}`}
          disabled={!dirty || props.busy}
          onClick={() => parsed !== undefined && props.onSave(s, parsed)}
        >
          Guardar
        </Button>
      </td>
    </tr>
  );
}

export function SettingsPage(_props: { me: Me }) {
  const [settings, setSettings] = useState<SystemSetting[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRestart, setPendingRestart] = useState<string[]>([]);

  const load = useCallback(() => {
    setLoadError(null);
    api<{ settings: SystemSetting[] }>("GET", "/admin/settings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setLoadError(e));
  }, []);
  useEffect(load, [load]);

  async function save(s: SystemSetting, value: SettingValue) {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await api<PatchResult>("PATCH", "/admin/settings", {
        changes: [{ key: s.key, value, expectedVersion: s.version }],
      });
      setSettings(r.settings);
      // El aviso de reinicio se ACUMULA hasta que el admin recarga la página: no se pierde con otro cambio.
      setPendingRestart((prev) => [...new Set([...prev, ...r.pendingRestart])]);
    } catch (e) {
      setSaveError(e);
      load(); // un conflicto de versión (otro admin) se resuelve viendo lo vigente
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !settings) return <ErrorState label="los ajustes del sistema" error={loadError} onRetry={load} />;
  if (!settings) return <LoadingState label="los ajustes del sistema" />;

  return (
    <Panel data-testid="system-settings-page">
      <h2>Ajustes del sistema</h2>
      <p>
        <small>
          Las claves «en caliente» las aplica cada servicio en unos 5 segundos sin reiniciar. Las que requieren reinicio
          sólo surten efecto cuando se reinicia el servicio indicado. El entorno del despliegue es siempre el techo.
        </small>
      </p>
      {pendingRestart.length > 0 && (
        <p role="alert" className="warn" data-testid="settings-pending-restart">
          Guardado, pero falta reiniciar el servicio consumidor para que surta efecto: {pendingRestart.join(", ")}.
        </p>
      )}
      <FormError error={saveError} data-testid="settings-error" />
      {settings.length === 0 ? (
        <EmptyState message="No hay ajustes registrados todavía." data-testid="settings-empty" />
      ) : (
        <table data-testid="settings-table">
          <thead>
            <tr>
              <th>Ajuste</th>
              <th>Valor</th>
              <th>Aplicación</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <SettingRow key={s.key} s={s} busy={busy} onSave={(row, v) => void save(row, v)} />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
