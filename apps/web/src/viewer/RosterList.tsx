/**
 * 4v4 · Nómina del visor y del replay AGRUPADA POR BANDO: cada vehículo por el
 * NOMBRE de su bot (los 4 de un bando se distinguen por nombre, no por color). Sólo
 * usa la nómina pública que ya trae la cabecera (`init.meta.roster` / índice del replay).
 */
import { rosterTeams, sideText, vehicleLabel, type ViewerRoster } from "./art-direction.js";

export function RosterList({ roster, testId }: { roster: ViewerRoster; testId: string }) {
  if (roster.size === 0) return null;
  const ids = [...roster.keys()];
  const groups: { team: string | null; ids: string[] }[] = rosterTeams(roster).map((t) => ({
    team: t,
    ids: ids.filter((id) => roster.get(id)?.team === t),
  }));
  const loose = ids.filter((id) => !roster.get(id)?.team);
  if (loose.length > 0) groups.push({ team: null, ids: loose });
  return (
    <ul data-testid={testId}>
      {groups.map((g) => (
        <li key={g.team ?? "_"} data-testid="roster-side" data-team={g.team ?? ""}>
          {g.team ? `Bando ${sideText(g.team)}` : "Sin bando"} ({g.ids.length}):{" "}
          {g.ids.map((id, i) => (
            <span key={id} data-testid="roster-vehicle" data-vehicle-id={id}>
              {i > 0 ? ", " : ""}
              {vehicleLabel(roster, id)}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
