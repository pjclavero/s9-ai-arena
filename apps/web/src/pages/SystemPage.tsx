/**
 * R8.6 · Panel de sistema/operaciones (SOLO LECTURA, admin). Muestra el estado
 * agregado de `GET /system/status`: salud de BD, entorno, conteos por estado y
 * los invariantes de seguridad del runtime. NO permite reiniciar servicios ni
 * ejecutar batallas: si el runner real no está habilitado, se avisa claramente.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

interface RuntimePolicyInvariants {
  privileged: boolean;
  dockerSocketMounted: boolean;
  seccompEnforced: boolean;
  digestRequired: boolean;
  signatureRequired: boolean;
  networkMode: string;
}
interface SystemStatus {
  env: string;
  commit: string;
  databaseOk: boolean;
  realRunnerEnabled: boolean;
  smokeDigestConfigured: boolean;
  battlesByStatus: Record<string, number>;
  buildsByStatus: Record<string, number>;
  botVersionsByState: Record<string, number>;
  readyBots: number;
  publishedMaps: number;
  runtimePolicy: RuntimePolicyInvariants;
}

function Counts({ label, data }: { label: string; data: Record<string, number> }) {
  const entries = Object.entries(data);
  return (
    <div>
      <strong>{label}</strong>
      {entries.length === 0 ? (
        <p>—</p>
      ) : (
        <ul>
          {entries.map(([k, v]) => (
            <li key={k}>
              {k}: {v}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SystemPage(_props: { me: Me }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    setError("");
    try {
      setStatus(await api<SystemStatus>("GET", "/system/status"));
    } catch (e) {
      setStatus(null);
      setError(`No se pudo cargar el estado del sistema: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

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
  if (!status) {
    return (
      <div className="card">
        <p role="status" aria-live="polite">
          Cargando estado del sistema…
        </p>
      </div>
    );
  }

  const rp = status.runtimePolicy;
  return (
    <div>
      <div className="card">
        <h2>Estado del sistema</h2>
        {!status.realRunnerEnabled && (
          <p className="warn" role="status" data-testid="execution-unavailable">
            Battle execution unavailable in this environment (runner real no habilitado).
          </p>
        )}
        <table>
          <tbody>
            <tr>
              <td>Entorno</td>
              <td>{status.env}</td>
            </tr>
            <tr>
              <td>Commit</td>
              <td>{status.commit}</td>
            </tr>
            <tr>
              <td>Base de datos</td>
              <td className={status.databaseOk ? "ok" : "error"}>{status.databaseOk ? "OK" : "no accesible"}</td>
            </tr>
            <tr>
              <td>Runner real</td>
              <td className={status.realRunnerEnabled ? "ok" : "warn"}>
                {status.realRunnerEnabled ? "habilitado" : "deshabilitado"}
              </td>
            </tr>
            <tr>
              <td>Digest de smoke bot configurado</td>
              <td>{status.smokeDigestConfigured ? "sí" : "no"}</td>
            </tr>
            <tr>
              <td>Bots listos (jugables)</td>
              <td>{status.readyBots}</td>
            </tr>
            <tr>
              <td>Mapas publicados</td>
              <td>{status.publishedMaps}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Conteos por estado</h3>
        <Counts label="Batallas" data={status.battlesByStatus} />
        <Counts label="Builds" data={status.buildsByStatus} />
        <Counts label="Versiones de bot" data={status.botVersionsByState} />
      </div>

      <div className="card">
        <h3>Política de runtime (solo lectura)</h3>
        <p>Invariantes de seguridad que la plataforma exige siempre. No configurables desde este panel.</p>
        <table>
          <tbody>
            <tr>
              <td>privileged</td>
              <td className={rp.privileged ? "error" : "ok"}>{String(rp.privileged)}</td>
            </tr>
            <tr>
              <td>docker socket montado</td>
              <td className={rp.dockerSocketMounted ? "error" : "ok"}>{String(rp.dockerSocketMounted)}</td>
            </tr>
            <tr>
              <td>seccomp</td>
              <td className={rp.seccompEnforced ? "ok" : "error"}>{rp.seccompEnforced ? "enforced" : "off"}</td>
            </tr>
            <tr>
              <td>digest requerido</td>
              <td className={rp.digestRequired ? "ok" : "error"}>{String(rp.digestRequired)}</td>
            </tr>
            <tr>
              <td>firma requerida</td>
              <td className={rp.signatureRequired ? "ok" : "error"}>{String(rp.signatureRequired)}</td>
            </tr>
            <tr>
              <td>red</td>
              <td>{rp.networkMode}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
