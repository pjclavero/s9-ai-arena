/**
 * R8.7 · Registro de auditoría (SOLO LECTURA, admin). Consume `GET /admin/audit-log`
 * (de solo inserción en la BD: ni edición ni borrado). No expone secretos.
 *
 * R16: EmptyState / LoadingState / ErrorState / Panel adoptan las primitivas de
 * ui/primitives.tsx — comportamiento idéntico al anterior (mismos textos, mismos roles
 * ARIA); solo se centraliza la implementación.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";
import { Panel, LoadingState, ErrorState, EmptyState } from "../ui/primitives.js";

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
  const [errorMsg, setErrorMsg] = useState("");

  async function refresh() {
    setErrorMsg("");
    try {
      setEntries(await api<AuditEntry[]>("GET", "/admin/audit-log?limit=100"));
    } catch (e) {
      setEntries(null);
      setErrorMsg((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Panel>
      <h2>Auditoría</h2>
      <p>Registro de solo inserción de acciones administrativas y del ciclo de vida de recursos.</p>
      {errorMsg ? (
        <ErrorState label="la auditoría" message={errorMsg} onRetry={() => void refresh()} />
      ) : entries === null ? (
        <LoadingState label="auditoría" />
      ) : entries.length === 0 ? (
        <EmptyState message="No hay eventos de auditoría todavía." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              <th scope="col">Acción</th>
              <th scope="col">Objetivo</th>
              <th scope="col">Actor</th>
              <th scope="col">Correlación</th>
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
    </Panel>
  );
}
