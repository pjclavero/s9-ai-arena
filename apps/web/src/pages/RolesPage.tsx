/**
 * R8.9 · Roles y permisos (SOLO LECTURA, admin). Consume `GET /system/rbac`, cuya
 * matriz endpoint→rol mínimo se deriva del contrato OpenAPI (x-min-role): la UI no
 * autoriza, solo muestra. No permite editar roles ni asignaciones.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Me } from "../api.js";

interface RbacRole {
  name: string;
  rank: number;
}
interface RbacEndpoint {
  operationId: string;
  method: string;
  path: string;
  minRole: string;
}
interface RbacMatrix {
  roles: RbacRole[];
  endpoints: RbacEndpoint[];
}

export function RolesPage(_props: { me: Me }) {
  const [matrix, setMatrix] = useState<RbacMatrix | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  async function refresh() {
    setError("");
    try {
      setMatrix(await api<RbacMatrix>("GET", "/system/rbac"));
    } catch (e) {
      setMatrix(null);
      setError(`No se pudo cargar la matriz de permisos: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  const endpoints = useMemo(() => {
    if (!matrix) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return matrix.endpoints;
    return matrix.endpoints.filter(
      (e) =>
        e.path.toLowerCase().includes(q) || e.minRole.toLowerCase().includes(q) || e.method.toLowerCase().includes(q),
    );
  }, [matrix, filter]);

  if (error) {
    return (
      <div className="card" role="alert">
        <p className="error">{error}</p>
        <button type="button" onClick={() => void refresh()}>
          Reintentar
        </button>
      </div>
    );
  }
  if (!matrix) {
    return (
      <div className="card">
        <p role="status" aria-live="polite">
          Cargando…
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>Roles y permisos</h2>
        <p>Jerarquía acumulativa: un rol hereda los permisos de los inferiores. Solo lectura.</p>
        <table>
          <thead>
            <tr>
              <th>Rango</th>
              <th>Rol</th>
            </tr>
          </thead>
          <tbody>
            {matrix.roles.map((r) => (
              <tr key={r.name}>
                <td>{r.rank}</td>
                <td>{r.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Matriz endpoint → rol mínimo</h3>
        <input
          aria-label="filtrar-endpoints"
          placeholder="filtrar por ruta, método o rol"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Ruta</th>
              <th>Rol mínimo</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.operationId}>
                <td>{e.method}</td>
                <td>{e.path}</td>
                <td>{e.minRole}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
