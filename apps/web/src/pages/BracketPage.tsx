/**
 * R12 (slice 1, solo lectura) · Cuadro de torneo: #/tournaments/:id/bracket.
 * Pinta GET /tournaments/:id/matches (contrato 0.5.0) agrupado por ronda,
 * con el estado y el ganador de cada match si ya lo tiene. Sigue el patrón
 * de recurso de R3.7 (ERR-VIS-10): un fallo de carga se ANUNCIA con
 * reintento, y un torneo sin cuadro generado dice por qué (nunca una lista
 * vacía engañosa). SIN botones de acción: página de solo lectura.
 */
import { api } from "../api.js";
import { useResource, ResourceView } from "../resource.js";

export interface TournamentMatch {
  id: string;
  round: number;
  slot: string | null;
  pairing: Record<string, unknown>;
  state: string;
  winnerBotId: string | null;
  winnerTeamId: string | null;
  final: boolean;
}

interface TournamentMatches {
  matches: TournamentMatch[];
}

export function BracketPage(props: { id: string }) {
  const [res, reload] = useResource<TournamentMatches>(
    () => api<TournamentMatches>("GET", `/tournaments/${encodeURIComponent(props.id)}/matches`),
    [props.id],
  );

  return (
    <div data-testid="bracket-page">
      <p>
        <a href={`#/tournaments/${encodeURIComponent(props.id)}`}>← Detalle del torneo</a>
      </p>
      <h2>Cuadro del torneo</h2>
      <ResourceView resource={res} label="el cuadro del torneo" onRetry={reload}>
        {(data) =>
          data.matches.length === 0 ? (
            <p data-testid="bracket-empty">El cuadro aún no se ha generado.</p>
          ) : (
            <BracketRounds matches={data.matches} />
          )
        }
      </ResourceView>
    </div>
  );
}

function BracketRounds({ matches }: { matches: TournamentMatch[] }) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return (
    <div className="bracket" data-testid="bracket-rounds">
      {rounds.map((round) => (
        <section key={round} className="round" aria-label={`Ronda ${round}`}>
          <h3>Ronda {round}</h3>
          <ul>
            {matches
              .filter((m) => m.round === round)
              .map((m) => (
                <li key={m.id} data-testid="bracket-match" data-final={m.final ? "true" : "false"}>
                  <strong>{m.slot ?? m.id.slice(0, 8)}</strong>
                  {m.final && <span data-testid="bracket-final-mark"> · FINAL</span>}
                  <br />
                  <small>{m.state}</small>
                  {(m.winnerBotId || m.winnerTeamId) && (
                    <>
                      <br />
                      <small data-testid="bracket-winner">Ganador: {m.winnerBotId ?? m.winnerTeamId}</small>
                    </>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
