/**
 * R8.7 · Registro de auditoría (SOLO LECTURA, admin). Consume `GET /admin/audit-log`
 * (de solo inserción en la BD: ni edición ni borrado). No expone secretos.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

interface AuditEntry {
  id: string;
  actorId?: string;
  action: string;
  target: string;
  correlationId?: string;
  at: string;
}

export function AuditPage(_props: { me: Me }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      setEntries(await api<AuditEntry[]>("GET", "/admin/audit-log?limit=100"));
    } catch (e) {
      setEntries(null);
      setError(`No se pudo cargar la auditoría: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="card">
      <h2>Auditoría</h2>
      <p>Registro de solo inserción de acciones administrativas y del ciclo de vida de recursos.</p>
      {error ? (
        <div role="alert">
          <p className="error">{error}</p>
          <button type="button" onClick={() => void refresh()}>
            Reintentar
          </button>
        </div>
      ) : entries === null ? (
        <p role="status" aria-live="polite">
          Cargando…
        </p>
      ) : entries.length === 0 ? (
        <p>No hay eventos de auditoría todavía.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Acción</th>
              <th>Objetivo</th>
              <th>Actor</th>
              <th>Correlación</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td>{e.action}</td>
                <td>{e.target}</td>
                <td>{e.actorId ?? "—"}</td>
                <td>{e.correlationId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
