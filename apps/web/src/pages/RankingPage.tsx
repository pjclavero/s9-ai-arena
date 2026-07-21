/**
 * N6 (entrega A) · Página pública #/ranking: pinta GET /standings?mode=<modo>
 * (contrato getStandings, security: [], x-min-role: visitor — sin cuenta).
 * Sigue el patrón de recurso de R3.7 (ERR-VIS-10) usado por BracketPage y
 * LivePage: un fallo de carga se ANUNCIA (role="alert") con reintento, nunca
 * como lista vacía; una clasificación vacía dice por qué. SIN botones de
 * acción/mutación: página de SOLO LECTURA.
 */
import { useState } from "react";
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";

export interface Standing {
  rank: number;
  botId: string;
  botName: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

const MODES = [
  { value: "deathmatch", label: "Deathmatch" },
  { value: "team_deathmatch", label: "Deathmatch por equipos" },
  { value: "capture_the_flag", label: "Captura la bandera" },
  { value: "zone_control", label: "Control de zona" },
] as const;

export function RankingPage() {
  const [mode, setMode] = useState<string>("deathmatch");
  const [res, reload] = useResource<Standing[]>(
    () => api<Standing[]>("GET", `/standings?mode=${encodeURIComponent(mode)}`),
    [mode],
  );

  return (
    <section>
      <h2>Clasificación</h2>
      <p>
        <label>
          Modo:{" "}
          <select data-testid="ranking-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </p>
      <ResourceView resource={res} label="la clasificación" onRetry={reload}>
        {(standings) =>
          standings.length === 0 ? (
            <p data-testid="ranking-empty">Todavía no hay clasificación para este modo.</p>
          ) : (
            <table data-testid="ranking-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Bot</th>
                  <th>Rating</th>
                  <th>V-D-E</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s) => (
                  <tr key={s.botId} data-testid="ranking-row">
                    <td>{s.rank}</td>
                    <td>{s.botName}</td>
                    <td>{s.rating}</td>
                    <td>
                      {s.wins}-{s.losses}-{s.draws}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </section>
  );
}
