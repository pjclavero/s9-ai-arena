/**
 * R3.7 (ERR-VIS-02) · Batallas e historial: listado global con filtro por
 * estado y filtro por bot (enlace bot → batallas → replay/directo). El estado
 * de carga/error es por recurso: un fallo NUNCA se pinta como lista vacía.
 *
 * FC-D (D7, TD-022) · Cada batalla muestra RESULTADO (ganador/empate), marcador,
 * duración y fallo real; `failureKind = none` ya no se pinta como error.
 *
 * UX-D (D1) · Participantes con NOMBRE de bot y versión exacta (antes UUID
 * recortado), mapa por nombre, modo en palabras y enlace al detalle
 * (#/battles/<id>). La API sólo lista las batallas que puedes ver (G-08).
 */
import { useState } from "react";
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { EmptyState } from "../ui/primitives.js";
import {
  MODE_TEXT,
  botVersionLabel,
  summarizeBattle,
  winnerText,
  sidesTitle,
  type BattleLike,
  type ParticipantLike,
} from "../battle-result.js";
import { BattleLink } from "./TournamentDetailPage.js";

interface Battle extends BattleLike {
  tournamentId?: string;
  mode: string;
  mapId: string;
  mapName?: string;
  participants: ParticipantLike[];
}

const STATUSES = ["", "scheduled", "running", "finished", "failed"];
const STATUS_TEXT: Record<string, string> = {
  scheduled: "en cola",
  running: "en curso",
  finished: "terminada",
  failed: "fallida",
};

export function BattlesPage(props: { botFilter?: string }) {
  const [status, setStatus] = useState("");
  const [list, reload] = useResource(
    () => api<{ items: Battle[] }>("GET", `/battles${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    [status],
  );

  return (
    <div className="card">
      <h2>Batallas</h2>
      <p>
        <a href="#/battles/new">+ Nueva batalla de práctica</a>
      </p>
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
                {s === "" ? "todas" : (STATUS_TEXT[s] ?? s)}
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
          if (items.length === 0)
            return (
              <EmptyState
                data-testid="battles-empty"
                message={
                  props.botFilter || status ? "No hay batallas que casen con el filtro." : "Aún no hay batallas."
                }
                action={<a href="#/battles/new">Crear una batalla de práctica</a>}
              />
            );
          return (
            <table className="stack-table">
              <thead>
                <tr>
                  <th>Participantes</th>
                  <th>Modo</th>
                  <th>Mapa</th>
                  <th>Estado</th>
                  <th>Resultado</th>
                  <th>Duración</th>
                  <th>Torneo</th>
                  <th>Ver</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => {
                  const v = summarizeBattle(b);
                  return (
                    <tr key={b.id} data-testid="battle-row" data-battle-id={b.id} data-status={b.status}>
                      <td>
                        <a href={`#/battles/${encodeURIComponent(b.id)}`} data-testid="battle-detail-link">
                          {sidesTitle(b.participants, botVersionLabel, { withSide: true }) ||
                            "batalla sin participantes"}
                        </a>
                      </td>
                      <td>{MODE_TEXT[b.mode] ?? b.mode}</td>
                      <td>{b.mapName ?? b.mapId}</td>
                      <td>
                        {STATUS_TEXT[b.status] ?? b.status}
                        {v.failure ? <span className="error"> ({v.failure})</span> : null}
                      </td>
                      <td data-testid="battle-outcome">
                        {winnerText(b) ?? "—"}
                        {v.score ? <small> · {v.score}</small> : null}
                        {v.endReason ? <small> · {v.endReason}</small> : null}
                        {v.agentsNote ? <small className="warn"> · {v.agentsNote}</small> : null}
                        {v.disqualified.length > 0 ? (
                          <small className="warn"> · descalificados: {v.disqualified.length}</small>
                        ) : null}
                      </td>
                      <td>{v.duration ?? "—"}</td>
                      <td>{b.tournamentId ? <a href={`#/tournaments/${b.tournamentId}`}>torneo</a> : "—"}</td>
                      <td>
                        {b.status === "finished" && !v.hasReplay ? (
                          <span>sin replay</span>
                        ) : (
                          <BattleLink battle={{ ...b, round: 1 }} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        }}
      </ResourceView>
    </div>
  );
}
