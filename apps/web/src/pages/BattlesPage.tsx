/**
 * R3.7 (ERR-VIS-02) · Batallas e historial: listado global con filtro por
 * estado y filtro por bot (enlace bot → batallas → replay/directo). El estado
 * de carga/error es por recurso: un fallo NUNCA se pinta como lista vacía.
 */
import { useState } from "react";
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { BattleLink, type TournamentBattle } from "./TournamentDetailPage.js";

interface Battle extends Omit<TournamentBattle, "round"> {
  tournamentId?: string;
  mapId: string;
  failureKind?: string | null;
}

const STATUSES = ["", "scheduled", "running", "finished", "failed"];

export function BattlesPage(props: { botFilter?: string }) {
  const [status, setStatus] = useState("");
  const [list, reload] = useResource(
    () => api<{ items: Battle[] }>("GET", `/battles${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    [status],
  );

  return (
    <div className="card">
      <h2>Batallas</h2>
      {props.botFilter && (
        <p data-testid="bot-filter">
          Mostrando solo batallas del bot <code>{props.botFilter}</code> <a href="#/battles">(quitar filtro)</a>
        </p>
      )}
      <p>
        <label>
          Estado{" "}
          <select aria-label="filtro de estado" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "todas" : s}
              </option>
            ))}
          </select>
        </label>
      </p>
      <ResourceView resource={list} label="las batallas" onRetry={reload}>
        {(page) => {
          // El filtro por bot es de cliente: listBattles no filtra por
          // participante (extensión candidata; anotado en el reporte R3.7).
          const items = props.botFilter
            ? page.items.filter((b) => b.participants.some((p) => p.botId === props.botFilter))
            : page.items;
          if (items.length === 0) return <p>No hay batallas que casen con el filtro.</p>;
          return (
            <table>
              <thead>
                <tr>
                  <th>Participantes</th>
                  <th>Modo</th>
                  <th>Mapa</th>
                  <th>Estado</th>
                  <th>Torneo</th>
                  <th>Ver</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.participants.map((p) => `${p.botId.slice(0, 8)} v${p.version}`).join(" vs ") ||
                        b.id.slice(0, 8)}
                    </td>
                    <td>{b.mode}</td>
                    <td>{b.mapId}</td>
                    <td>
                      {b.status}
                      {b.failureKind ? <span className="error"> ({b.failureKind})</span> : null}
                    </td>
                    <td>{b.tournamentId ? <a href={`#/tournaments/${b.tournamentId}`}>torneo</a> : "—"}</td>
                    <td>
                      <BattleLink battle={{ ...b, round: 1 }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </ResourceView>
    </div>
  );
}
