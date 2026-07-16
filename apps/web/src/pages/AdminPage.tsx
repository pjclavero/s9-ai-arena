/**
 * T7.4 · Panel de administración. La interfaz SOLO OCULTA: la autorización real
 * la hace la API con la matriz x-min-role del contrato (T7.2). Este componente
 * ni se monta para roles menores (test de visibilidad) y, aunque se montara,
 * la API respondería 403.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

export function isAdmin(me: Me | null): boolean {
  return !!me && me.roles.includes("admin");
}

interface Finding {
  id: string;
  kind: string;
  severity: string;
  detail: string;
  detectedAt: string;
}
interface AuditEntry {
  id: string;
  actorId?: string;
  action: string;
  target: string;
  at: string;
}
interface CatalogVersion {
  catalogVersion: string;
  moduleCount: number;
  frozen: boolean;
}

export function AdminPage(props: { me: Me }) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [catalogs, setCatalogs] = useState<CatalogVersion[]>([]);
  const [roleEdit, setRoleEdit] = useState({ userId: "", roles: "" });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isAdmin(props.me)) return;
    api<Finding[]>("GET", "/admin/security-findings").then(setFindings).catch((e) => setError(e.message));
    api<AuditEntry[]>("GET", "/admin/audit-log").then(setAuditLog).catch((e) => setError(e.message));
    api<CatalogVersion[]>("GET", "/catalog/versions").then(setCatalogs).catch(() => {});
  }, [props.me]);

  if (!isAdmin(props.me)) {
    return <p className="error" data-testid="admin-denied">Acceso denegado.</p>;
  }

  return (
    <div data-testid="admin-panel">
      <div className="card">
        <h2>Roles de usuario</h2>
        <input aria-label="rol-userid" placeholder="userId" value={roleEdit.userId} onChange={(e) => setRoleEdit((s) => ({ ...s, userId: e.target.value }))} />{" "}
        <input aria-label="rol-roles" placeholder="roles separados por coma" value={roleEdit.roles} onChange={(e) => setRoleEdit((s) => ({ ...s, roles: e.target.value }))} />{" "}
        <button
          onClick={async () => {
            try {
              await api("PUT", `/users/${roleEdit.userId}/roles`, { roles: roleEdit.roles.split(",").map((r) => r.trim()) });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Asignar roles
        </button>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>Catálogo importado</h2>
        <ul>
          {catalogs.map((c) => (
            <li key={c.catalogVersion}>
              {c.catalogVersion}: {c.moduleCount} módulos {c.frozen ? "(congelado)" : ""}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Hallazgos de seguridad</h2>
        <table>
          <tbody>
            {findings.map((f) => (
              <tr key={f.id}>
                <td>{f.detectedAt}</td>
                <td>{f.kind}</td>
                <td className={f.severity === "critical" || f.severity === "high" ? "error" : "warn"}>{f.severity}</td>
                <td>{f.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Auditoría (solo inserción)</h2>
        <table>
          <tbody>
            {auditLog.map((a) => (
              <tr key={a.id}>
                <td>{a.at}</td>
                <td>{a.action}</td>
                <td>{a.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
