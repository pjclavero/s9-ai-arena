/**
 * R3.7 (ERR-VIS-02) · Torneos en el panel: listado, creación (la API autoriza,
 * la UI solo envía) y enlace al detalle para seguirlos sin teclear UUIDs.
 * Formularios con onSubmit (Enter funciona) y errores anunciados (role="alert").
 */
import { useState, type FormEvent } from "react";
import { api, type Me } from "../api.js";
import { useResource, ResourceView } from "../resource.js";

export interface Tournament {
  id: string;
  name: string;
  format: string;
  mode: string;
  state: string;
  entryCount?: number;
}

const FORMATS = ["league", "round_robin", "single_elimination", "double_elimination", "swiss", "teams"];
const MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"];

export function TournamentsPage(_props: { me: Me }) {
  const [list, reload] = useResource(() => api<{ items: Tournament[] }>("GET", "/tournaments"), []);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("single_elimination");
  const [mode, setMode] = useState("deathmatch");
  const [rulesetId, setRulesetId] = useState("mvp-default");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault(); // envío también con Enter (ERR-VIS-10 a11y)
    setError("");
    setCreating(true);
    try {
      const t = await api<Tournament>("POST", "/tournaments", { name, format, mode, rulesetId });
      setName("");
      reload();
      window.location.hash = `#/tournaments/${t.id}`;
    } catch (err) {
      setError((err as Error).message || "no se pudo crear el torneo");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Torneos</h2>
        <ResourceView resource={list} label="los torneos" onRetry={reload}>
          {(page) =>
            page.items.length === 0 ? (
              <p>No hay torneos todavía.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Formato</th>
                    <th>Modo</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <a href={`#/tournaments/${t.id}`}>{t.name}</a>
                      </td>
                      <td>{t.format}</td>
                      <td>{t.mode}</td>
                      <td>{t.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </ResourceView>
      </div>

      <div className="card">
        <h3>Crear torneo</h3>
        {/* La UI no oculta el formulario por rol: la autorización real es de la API (cap. 16). */}
        <form onSubmit={onCreate}>
          <p>
            <label>
              Nombre{" "}
              <input aria-label="nombre del torneo" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Formato{" "}
              <select aria-label="formato" value={format} onChange={(e) => setFormat(e.target.value)}>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Modo{" "}
              <select aria-label="modo" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>{" "}
            <label>
              Ruleset <input aria-label="ruleset" value={rulesetId} onChange={(e) => setRulesetId(e.target.value)} />
            </label>
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={creating} data-testid="create-tournament">
            {creating ? "Creando…" : "Crear torneo"}
          </button>
        </form>
      </div>
    </div>
  );
}
